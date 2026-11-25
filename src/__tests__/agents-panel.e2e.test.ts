// `/agents`: the conversation's whole tree — live subagents and tasks in tree order, then the
// ones that ended — in the conversation's place (ask-children-spec.md (agent tree)). Its
// cursor, the stop question and the keys are the panel's own. The real app on the scripted
// model; a child is held with `{ hold: true as const }` until the test lets it go.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askClock } from '../assistant/child-ask-guard.ts';
import { ScriptedModel, bootApp, firstUser, settle, type Turn } from './helpers/scripted';

import { nativeFetch } from './helpers/test-setup.ts';
const realFetch = nativeFetch;
const realNow = askClock.now;
const clock = { t: 10_000 };
afterEach(() => { globalThis.fetch = realFetch; askClock.now = realNow; });

const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
const rowsOf = (ui: UI) => frameOf(ui).split('\n');
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
const rowAt = (ui: UI, text: string) => rowsOf(ui).findIndex((r) => r.includes(text));
const BLOCK = 'Confirm write: run_command';
const boards = (make: any) => [make('boards', { name: 'boards', keycaps: () => ['c card'], components: { view: (api: any) => function View() { return api.ui.h(api.ui.Text, null, 'BOARD-SURFACE'); } } })];

// A booted chat with one scripted child per mark. `hold`: the child waits before it acts;
// `writes`: it then asks for a write, else it just answers.
async function boot(marks: { mark: string; writes?: boolean; script?: Turn[] }[], opts: { main?: Turn[] } = {}) {
  clock.t = 10_000;
  askClock.now = () => clock.t;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-agents-')));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-agents-s-'));
  const model = new ScriptedModel();
  const children = marks.map(({ mark, writes, script }) => {
    const child = model.when((req) => firstUser(req).includes(mark));
    if (script) child.script(...script);
    else child.script([{ hold: true as const }, ...(writes ? [{ tool: 'run_command', args: { command: `touch ${path.join(root, `${mark}.txt`)}` } }] : [])] as Turn, [{ text: `${mark} settled` }]);
    return child;
  });
  if (opts.main) model.script(...opts.main);
  const ui = await bootApp(model, 140, 34, boards as never, { sessions: { dir: sessions }, shell: { roots: [root] }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false } }, { toastMs: 10_000 });
  await ui.press('F');
  return { children, ui, model, root, sessions };
}

const journalOf = (sessions: string) => {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith('.log.jsonl')) out.push(fs.readFileSync(f, 'utf8')); } };
  walk(sessions);
  return out.join('\n');
};
async function twoHeld() {
  const b = await boot([{ mark: 'AAA' }, { mark: 'BBB' }]);
  await ask(b.ui, '/subagent AAA go');
  await ask(b.ui, '/subagent BBB go');
  await settleUntil(() => b.children[0]!.held && b.children[1]!.held);
  return b;
}

// ── /agents (ask-children-spec.md (agent tree))
const panelOpen = (ui: UI) => frameOf(ui).includes('Flow Assist · Agents');

test('/agents with nothing to show says so, and Esc closes it', async () => {
  const { ui } = await boot([{ mark: 'AAA' }]);
  await ask(ui, '/agents');
  await settleUntil(() => panelOpen(ui));
  expect(frameOf(ui)).toContain('no subagents here');
  await ui.press('escape');
  expect(panelOpen(ui)).toBe(false);
  ui.app.unmount();
});

test('/agents lists live nodes in tree order with their time (a subagent that answered among them, idle) and then the ended ones; x on an ended row is refused', async () => {
  const { children: [outer, inner, other], ui } = await boot([
    { mark: 'OUTER', script: [[{ hold: true as const }, { tool: 'subagent', args: { task: 'INNER work', label: 'inner' } }], [{ hold: true as const }, { text: 'outer settled' }]] },
    { mark: 'INNER' },
    { mark: 'OTHER' },
  ]);
  await ask(ui, '/subagent OUTER go');
  await settleUntil(() => outer!.held);
  outer!.release();
  await settleUntil(() => inner!.held);
  await ask(ui, '/subagent OTHER go');
  await settleUntil(() => other!.held);
  await ask(ui, '/agents');
  await settleUntil(() => panelOpen(ui) && frameOf(ui).includes('inner (task)'));
  const rows = rowsOf(ui);
  const at = (t: string) => rows.findIndex((r) => r.includes(t));
  expect(at('outer-go')).toBeLessThan(at('inner (task)'));
  expect(at('inner (task)')).toBeLessThan(at('other-go'));
  expect(rows[at('inner (task)')]!.indexOf('inner')).toBe(rows[at('outer-go')]!.indexOf('outer-go') + 2);
  expect(rows[at('other-go')]).toMatch(/(<1s|\d+s)/);
  // A subagent that answered stays among the live ones, idle; stopped, it moves below them.
  other!.release();
  await settleUntil(() => rowsOf(ui).some((r) => /other-go.*idle/.test(r)));
  await ui.press('down'); await ui.press('down'); await ui.press('down');
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop other-go? y yes · n no');
  await ui.press('y');
  await settleUntil(() => rowsOf(ui).some((r) => /other-go.*stopped/.test(r)));
  const after = rowsOf(ui);
  expect(after.findIndex((r) => /other-go.*stopped/.test(r))).toBeGreaterThan(after.findIndex((r) => r.includes('inner (task)')));
  await ui.press('down'); await ui.press('down'); await ui.press('down');
  await ui.press('x');
  await settleUntil(() => frameOf(ui).includes('nothing to stop'));
  expect(frameOf(ui)).toContain('nothing to stop');
  expect(frameOf(ui)).not.toContain('y yes · n no');
  inner!.release();
  await ui.press('escape');
  outer!.release();
  ui.app.unmount();
});

test('in /agents x asks in place of the row and y stops the node as the person; n and Esc keep it', async () => {
  const { children: [a, b], ui, sessions } = await boot([{ mark: 'AAA' }, { mark: 'BBB' }]);
  await ask(ui, '/subagent AAA go');
  await ask(ui, '/subagent BBB go');
  await settleUntil(() => a!.held && b!.held);
  await ask(ui, '/agents');
  await settleUntil(() => panelOpen(ui) && frameOf(ui).includes('bbb-go'));
  await ui.press('down');
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop bbb-go? y yes · n no');
  expect(frameOf(ui)).not.toContain('⚙ bbb-go');
  await ui.press('n');
  expect(frameOf(ui)).not.toContain('y yes · n no');
  expect(frameOf(ui)).toContain('⚙ bbb-go');
  // A y with no question stops nothing.
  await ui.press('y');
  await settle(4);
  expect(frameOf(ui)).toContain('⚙ bbb-go');
  await ui.press('x');
  await ui.press('y');
  await settleUntil(() => rowsOf(ui).some((r) => /bbb-go.*stopped/.test(r)));
  expect(rowsOf(ui).some((r) => /bbb-go.*stopped/.test(r))).toBe(true);
  expect(frameOf(ui)).toContain('⚙ aaa-go');
  expect(journalOf(sessions)).toContain('"stoppedBy":"person"');
  a!.release();
  ui.app.unmount();
});

test('the /agents cursor stays on its node when an earlier node ends', async () => {
  const { children: [a, b, c], ui } = await boot([{ mark: 'AAA' }, { mark: 'BBB' }, { mark: 'CCC' }]);
  await ask(ui, '/subagent AAA go');
  await ask(ui, '/subagent BBB go');
  await ask(ui, '/subagent CCC go');
  await settleUntil(() => a!.held && b!.held && c!.held);
  await ask(ui, '/agents');
  await settleUntil(() => panelOpen(ui) && frameOf(ui).includes('ccc-go'));
  await ui.press('down'); await ui.press('down');
  a!.release();
  await settleUntil(() => rowsOf(ui).some((r) => /aaa-go.*done/.test(r)));
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop ccc-go? y yes · n no');
  await ui.press('n');
  b!.release(); c!.release();
  ui.app.unmount();
});

test('with a child waiting for a y/n and /agents open, y answers nothing and the block is not drawn', async () => {
  const { children: [stay, w], ui, root } = await boot([{ mark: 'STAY' }, { mark: 'ASKW', writes: true }]);
  await ask(ui, '/subagent STAY go');
  await ask(ui, '/subagent ASKW go');
  await settleUntil(() => stay!.held && w!.held);
  await ask(ui, '/agents');
  await settleUntil(() => panelOpen(ui));
  w!.release();
  await settleUntil(() => frameOf(ui).includes('waiting for a y/n'));
  expect(frameOf(ui)).not.toContain(BLOCK);
  clock.t += 700;
  await ui.press('y');
  await settle(4);
  expect(fs.existsSync(path.join(root, 'ASKW.txt'))).toBe(false);
  expect(frameOf(ui)).not.toContain(BLOCK);
  // Closed, the block comes back, armed afresh.
  await ui.press('escape');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  expect(frameOf(ui)).toContain(BLOCK);
  clock.t += 100;
  await ui.press('backspace');
  clock.t += 700;
  await ui.press('y');
  await settleUntil(() => fs.existsSync(path.join(root, 'ASKW.txt')));
  expect(fs.existsSync(path.join(root, 'ASKW.txt'))).toBe(true);
  stay!.release();
  ui.app.unmount();
});

test('in /agents the question about a node that goes idle stays: y ends it, and the hint and x come back', async () => {
  const { children: [a, b], ui } = await boot([{ mark: 'AAA' }, { mark: 'BBB' }]);
  await ask(ui, '/subagent AAA go');
  await ask(ui, '/subagent BBB go');
  await settleUntil(() => a!.held && b!.held);
  await ask(ui, '/agents');
  await settleUntil(() => panelOpen(ui) && frameOf(ui).includes('bbb-go'));
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop aaa-go? y yes · n no');
  a!.release();
  await settleUntil(() => rowsOf(ui).some((r) => /aaa-go.*idle/.test(r)) || frameOf(ui).includes('stop aaa-go? y yes'));
  await settle(6);
  expect(frameOf(ui)).toContain('stop aaa-go? y yes · n no');
  await ui.press('y');
  await settleUntil(() => rowsOf(ui).some((r) => /aaa-go.*stopped/.test(r)));
  expect(frameOf(ui)).not.toContain('y yes · n no');
  expect(frameOf(ui)).toContain('x stop');
  await ui.press('up');
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop bbb-go? y yes · n no');
  await ui.press('n');
  b!.release();
  ui.app.unmount();
});

test('in /agents the question about a task that has ended is dropped: the hint and x come back', async () => {
  const { children: [t, b], ui } = await boot([{ mark: 'TSKA' }, { mark: 'BBB' }], { main: [[{ tool: 'subagent', args: { task: 'TSKA go', label: 'tska-go' } }], [{ text: 'started' }]] });
  await ask(ui, 'run it');
  await ask(ui, '/subagent BBB go');
  await settleUntil(() => t!.held && b!.held);
  await ask(ui, '/agents');
  await settleUntil(() => panelOpen(ui) && frameOf(ui).includes('bbb-go'));
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop tska-go');
  t!.release();
  await settleUntil(() => rowsOf(ui).some((r) => /tska-go.*done/.test(r)));
  expect(frameOf(ui)).not.toContain('y yes · n no');
  expect(frameOf(ui)).toContain('x stop');
  b!.release();
  ui.app.unmount();
});

test('a y in /agents with no question stops nothing, and Ctrl+Y with a question up stops nothing', async () => {
  const { children: [a, b], ui } = await twoHeld();
  await ask(ui, '/agents');
  await settleUntil(() => panelOpen(ui) && frameOf(ui).includes('bbb-go'));
  await ui.press('y');
  await settle(4);
  expect(frameOf(ui)).not.toMatch(/(aaa|bbb)-go stopped/);
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop aaa-go? y yes · n no');
  ui.backend.press({ name: 'y', ctrl: true });
  await settle(4);
  expect(frameOf(ui)).not.toMatch(/(aaa|bbb)-go stopped/);
  expect(frameOf(ui)).toContain('stop aaa-go? y yes · n no');
  await ui.press('n');
  a!.release(); b!.release();
  ui.app.unmount();
});

test('in /agents x, ↓, y stops nothing: the question is for the row it was asked on', async () => {
  const { children: [a, b], ui } = await twoHeld();
  await ask(ui, '/agents');
  await settleUntil(() => panelOpen(ui) && frameOf(ui).includes('bbb-go'));
  await ui.press('x');
  await ui.press('down');
  await ui.press('y');
  await settle(4);
  expect(frameOf(ui)).not.toMatch(/(aaa|bbb)-go.*stopped/);
  expect(frameOf(ui)).toContain('⚙ aaa-go');
  expect(frameOf(ui)).toContain('⚙ bbb-go');
  a!.release(); b!.release();
  ui.app.unmount();
});

test('a click in /agents after ↑/↓ puts the cursor on the clicked row', async () => {
  const { children: [a, b], ui } = await twoHeld();
  await ask(ui, '/agents');
  await settleUntil(() => panelOpen(ui) && frameOf(ui).includes('bbb-go'));
  await ui.press('down');
  const y = rowAt(ui, 'aaa-go');
  ui.backend.mouse('down', 12, y);
  ui.backend.mouse('up', 12, y);
  await settle(6);
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop aaa-go? y yes · n no');
  await ui.press('n');
  a!.release(); b!.release();
  ui.app.unmount();
});

test('a list at its end stays at its end when a row appears and when it leaves', async () => {
  const lines = Array.from({ length: 14 }, (_, i) => `- answer line ${String(i + 1).padStart(2, '0')}`).join('\n');
  const { children: [a], ui } = await boot([{ mark: 'AAA' }], { main: [[{ text: lines }]] });
  await ask(ui, 'print them');
  await settleUntil(() => frameOf(ui).includes('answer line 14'));
  const last = () => rowAt(ui, 'answer line 14');
  expect(last()).toBeGreaterThan(0);
  // The row the subagent's start appends leaves the list at its end.
  await ask(ui, '/subagent AAA go');
  await settleUntil(() => a!.held && frameOf(ui).includes('aaa-go started'));
  expect(frameOf(ui)).toContain('answer line 14');
  // So does the row its end appends, under the last of the answer.
  a!.release();
  await settleUntil(() => frameOf(ui).includes('◆ aaa-go finished:'));
  expect(frameOf(ui)).toContain('answer line 14');
  expect(rowAt(ui, '◆ aaa-go finished:')).toBeGreaterThan(last());
  ui.app.unmount();
});
