// The conversation's live subagents and tasks as rows under the field (AGENTS.md (agent
// tree)). The real app on the scripted model; a child is held with `{ hold: true }` until
// the test lets it go.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askClock } from '../assistant/child-ask-guard.ts';
import { ScriptedModel, bootApp, firstUser, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
const realNow = askClock.now;
const clock = { t: 10_000 };
afterEach(() => { globalThis.fetch = realFetch; askClock.now = realNow; });

const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
const rowsOf = (ui: UI) => frameOf(ui).split('\n');
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
const fieldAt = (ui: UI) => rowsOf(ui).findLastIndex((r) => r.includes('› '));
const rowAt = (ui: UI, text: string) => rowsOf(ui).findIndex((r) => r.includes(text));
const BLOCK = 'Confirm write: run_command';
const boards = (make: any) => [make('boards', { name: 'boards', keycaps: () => ['c card'], components: { view: (api: any) => function View() { return api.ui.h(api.ui.Text, null, 'BOARD-SURFACE'); } } })];

// A booted chat with one scripted child per mark. `hold`: the child waits before it acts;
// `writes`: it then asks for a write, else it just answers.
async function boot(marks: { mark: string; writes?: boolean; script?: any[][] }[], opts: { cols?: number; rows?: number; mode?: 'window' | 'panel'; ui?: Record<string, unknown>; main?: any[][]; guest?: boolean } = {}) {
  clock.t = 10_000;
  askClock.now = () => clock.t;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-tree-')));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-tree-s-'));
  const model = new ScriptedModel();
  const children = marks.map(({ mark, writes, script }) => {
    const child = model.when((req) => firstUser(req).includes(mark));
    if (script) child.script(...script as never);
    else child.script([{ hold: true }, ...(writes ? [{ tool: 'run_command', args: { command: `touch ${path.join(root, `${mark}.txt`)}` } }] : [])], [{ text: `${mark} settled` }]);
    return child;
  });
  if (opts.main) model.script(...opts.main as never);
  const ui = await bootApp(model, opts.cols ?? 140, opts.rows ?? 34, boards as never, { sessions: { dir: sessions }, shell: { roots: [root] }, ...(opts.ui ? { ui: opts.ui } : {}), ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false } }, { toastMs: 10_000, ...(opts.mode ? { chatMode: opts.mode } : {}) });
  await ui.press('F');
  return { children, ui, model, root, sessions };
}

test('a held subagent shows its row under the field, with its latest step', async () => {
  const { children: [a], ui } = await boot([{ mark: 'ROWA' }]);
  await ask(ui, '/subagent ROWA do it');
  await settleUntil(() => a!.held);
  await settleUntil(() => frameOf(ui).includes('rowa-do'));
  const at = rowAt(ui, 'rowa-do');
  expect(at).toBeGreaterThan(fieldAt(ui));
  expect(rowsOf(ui)[at]).toMatch(/⚙ rowa-do-it · \S/);
  expect(rowsOf(ui)[at]).not.toContain('x stop');
  a!.release();
  await settleUntil(() => frameOf(ui).includes('◆ rowa-do finished:'));
  await settleUntil(() => !rowsOf(ui).some((r) => r.includes('⚙ rowa-do')));
  expect(rowsOf(ui).some((r) => r.includes('⚙ rowa-do'))).toBe(false);
  ui.app.unmount();
});

test('a subagent that waits for a y/n is marked ⏸ and, with more nodes than rows, kept before the working ones', async () => {
  const { children: [a, b, c], ui } = await boot([{ mark: 'AAA' }, { mark: 'BBB' }, { mark: 'CCC', writes: true }], { ui: { agentRows: 2 } });
  await ask(ui, '/subagent AAA go');
  await ask(ui, '/subagent BBB go');
  await ask(ui, '/subagent CCC go');
  await settleUntil(() => a!.held && b!.held && c!.held);
  await ui.type('draft');
  c!.release();
  await settleUntil(() => frameOf(ui).includes('waits for a y/n — clear the line'));
  await settleUntil(() => frameOf(ui).includes('⏸ ccc-go · waiting for a y/n'));
  const at = rowAt(ui, '⏸ ccc-go ·');
  expect(at).toBeGreaterThan(fieldAt(ui));
  expect(rowsOf(ui)[at + 1]).toContain('+2 more — /agents');
  expect(frameOf(ui)).not.toContain('⚙ aaa-go');
  ui.app.unmount();
});

test('a grandchild is indented under its parent', async () => {
  const { children: [outer, inner], ui } = await boot([
    { mark: 'OUTER', script: [[{ hold: true }, { tool: 'subagent', args: { task: 'INNER work', label: 'inner' } }], [{ hold: true }, { text: 'outer settled' }]] },
    { mark: 'INNER' },
  ]);
  await ask(ui, '/subagent OUTER go');
  await settleUntil(() => outer!.held);
  outer!.release();
  await settleUntil(() => inner!.held);
  await settleUntil(() => frameOf(ui).includes('inner (task)'));
  const rows = rowsOf(ui);
  const parent = rows.find((r) => r.includes('outer-go'))!;
  const child = rows.find((r) => r.includes('inner (task)'))!;
  expect(child.indexOf('inner')).toBe(parent.indexOf('outer-go') + 2);
  inner!.release();
  await settleUntil(() => outer!.held);
  outer!.release();
  ui.app.unmount();
});

test('ui.agentRows 0 draws no rows', async () => {
  const { children: [a], ui } = await boot([{ mark: 'ZERO' }], { ui: { agentRows: 0 } });
  await ask(ui, '/subagent ZERO do it');
  await settleUntil(() => a!.held);
  await settle(8);
  expect(frameOf(ui)).not.toContain('⚙ zero-do');
  expect(frameOf(ui)).not.toContain('more — /agents');
  a!.release();
  ui.app.unmount();
});

test('with a child\'s y/n block drawn the rows are hidden, and they return after the answer', async () => {
  const { children: [a, w], ui } = await boot([{ mark: 'STAY' }, { mark: 'ASKW', writes: true }]);
  await ask(ui, '/subagent STAY go');
  await ask(ui, '/subagent ASKW go');
  await settleUntil(() => a!.held && w!.held);
  await settleUntil(() => frameOf(ui).includes('⚙ stay-go'));
  w!.release();
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  await settle(4);
  expect(frameOf(ui)).not.toContain('⚙ stay-go');
  expect(frameOf(ui)).not.toContain('waiting for a y/n');
  clock.t += 700;
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('◆ askw-go finished:'));
  await settleUntil(() => frameOf(ui).includes('⚙ stay-go'));
  expect(frameOf(ui)).toContain('⚙ stay-go');
  a!.release();
  ui.app.unmount();
});

test('in a 12-row bottom panel no tree row is drawn and the list keeps its rows', async () => {
  const { children: [a], ui } = await boot([{ mark: 'TINYT' }], { cols: 100, rows: 24, mode: 'panel' });
  await ask(ui, '/subagent TINYT do it');
  await settleUntil(() => a!.held);
  await settle(8);
  const r = rowsOf(ui);
  const top = r.findIndex((l) => l.includes('╭─ ƒ Flow Assist'));
  const hintAt = r.findIndex((l) => l.includes('history · wheel'));
  expect(top).toBeGreaterThanOrEqual(0);
  expect(frameOf(ui)).not.toContain('⚙ tinyt-do');
  expect(hintAt - top - 1).toBeGreaterThanOrEqual(4);
  a!.release();
  ui.app.unmount();
});

test('every chat row stays one terminal line at a narrow width', async () => {
  const long = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz';
  const { children: [a], ui } = await boot([{ mark: 'NARROW' }], { cols: 40, rows: 34 });
  await ask(ui, `/subagent NARROW ${long} ${long}`);
  await settleUntil(() => a!.held);
  await settleUntil(() => frameOf(ui).includes('narrow-'));
  const rows = rowsOf(ui);
  const at = rows.findIndex((l) => l.includes('⚙ narrow-'));
  expect(at).toBeGreaterThan(fieldAt(ui));
  expect(rows[at]).toContain('…');
  expect(rows.filter((l) => l.includes('⚙ narrow-'))).toHaveLength(1);
  for (const l of rows) expect(l.length).toBeLessThanOrEqual(40);
  a!.release();
  ui.app.unmount();
});

// ── the cursor in the rows (AGENTS.md (agent tree))
const KEYS = '↑↓ move · x stop · Esc back';
const inRows = (ui: UI) => frameOf(ui).includes(KEYS);
const COLLAPSE = { name: '\\', ctrl: true };
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
  await settleUntil(() => frameOf(b.ui).includes('⚙ bbb-go'));
  return b;
}

test('↓ on an empty field steps into the rows; ↑ on the first row and Esc go back, and the field then takes text', async () => {
  const { children: [a, b], ui } = await twoHeld();
  expect(inRows(ui)).toBe(false);
  await ui.press('down');
  expect(inRows(ui)).toBe(true);
  expect(frameOf(ui)).not.toContain('↑↓ history');
  await ui.press('up');
  expect(inRows(ui)).toBe(false);
  await ui.press('down');
  await ui.press('down');
  expect(inRows(ui)).toBe(true);
  await ui.press('up');
  expect(inRows(ui)).toBe(true);
  await ui.press('up');
  expect(inRows(ui)).toBe(false);
  await ui.press('down');
  await ui.press('escape');
  expect(inRows(ui)).toBe(false);
  // ↓ on the last node stays there.
  await ui.press('down');
  await ui.press('down');
  await ui.press('down');
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop bbb-go? y yes · n no');
  await ui.press('escape');
  await ui.press('escape');
  expect(inRows(ui)).toBe(false);
  await ui.type('hi');
  expect(fieldAt(ui)).toBeGreaterThan(0);
  expect(rowsOf(ui)[fieldAt(ui)]).toContain('› hi');
  a!.release(); b!.release();
  ui.app.unmount();
});

test('the ↓ that ends a history walk, or follows a cleared history entry, does not also enter; a draft and shell mode keep ↓', async () => {
  const { children: [a, b], ui } = await twoHeld();
  // Two entries in the history: ↑ ↑ then ↓ ↓ ends on the empty field, and only the next ↓ enters.
  await ui.press('up'); await ui.press('up');
  expect(rowsOf(ui)[fieldAt(ui)]).toContain('/subagent AAA go');
  await ui.press('down'); await ui.press('down');
  expect(rowsOf(ui)[fieldAt(ui)]).not.toContain('/subagent');
  expect(inRows(ui)).toBe(false);
  await ui.press('down');
  expect(inRows(ui)).toBe(true);
  await ui.press('escape');
  // An entry shown, then cleared by Esc: the history is still where it was, so ↓ is its.
  await ui.press('up');
  await ui.press('escape');
  expect(rowsOf(ui)[fieldAt(ui)]).not.toContain('/subagent');
  await ui.press('down');
  expect(inRows(ui)).toBe(false);
  await ui.press('down');
  await ui.press('down');
  await ui.press('down');
  await ui.press('escape');
  // A draft keeps ↓ for the caret.
  await ui.type('draft');
  await ui.press('down');
  expect(inRows(ui)).toBe(false);
  await ui.type('Z');
  expect(rowsOf(ui)[fieldAt(ui)]).toContain('draftZ');
  await ui.press('escape');
  // Shell mode (bang level 1) keeps ↓ too.
  await ui.press('!');
  await ui.press('down');
  expect(inRows(ui)).toBe(false);
  a!.release(); b!.release();
  ui.app.unmount();
});

test('x then y stops the node as the person and journals it so; x then n does not; a node stops what it started', async () => {
  const { children: [outer, inner, other], ui, sessions } = await boot([
    { mark: 'OUTER', script: [[{ hold: true }, { tool: 'subagent', args: { task: 'INNER work', label: 'inner' } }], [{ hold: true }, { text: 'outer settled' }]] },
    { mark: 'INNER' },
    { mark: 'OTHER' },
  ]);
  await ask(ui, '/subagent OUTER go');
  await settleUntil(() => outer!.held);
  outer!.release();
  await settleUntil(() => inner!.held);
  await ask(ui, '/subagent OTHER go');
  await settleUntil(() => other!.held);
  await settleUntil(() => frameOf(ui).includes('⚙ other-go'));
  await ui.press('down');
  expect(frameOf(ui)).toBeTruthy();
  await ui.press('x');
  // The question stands where the cursor's row was, and names what goes with it.
  expect(frameOf(ui)).toContain('stop outer-go and 1 below it? y yes · n no');
  expect(frameOf(ui)).not.toContain('outer-go · ');
  await ui.press('n');
  expect(frameOf(ui)).not.toContain('y yes · n no');
  expect(frameOf(ui)).toContain('outer-go · ');
  expect(frameOf(ui)).not.toContain('outer-go stopped');
  await ui.press('x');
  await ui.press('escape');
  expect(frameOf(ui)).not.toContain('y yes · n no');
  expect(inRows(ui)).toBe(true);
  await ui.press('x');
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('◆ outer-go stopped:'));
  expect(frameOf(ui)).toContain('◆ outer-go stopped:');
  await settleUntil(() => frameOf(ui).includes('◆ inner (task) stopped:') || frameOf(ui).includes('inner stopped:'));
  expect(frameOf(ui)).not.toContain('other-go stopped');
  expect(journalOf(sessions)).toContain('"stoppedBy":"person"');
  other!.release();
  ui.app.unmount();
});

test('a key typed in the rows reaches neither the field nor the model, and Esc there is not the turn\'s stop or the exit arm', async () => {
  const { children: [a, b], ui, model } = await boot([{ mark: 'AAA' }, { mark: 'BBB' }], { main: [[{ hold: true }, { text: 'main answer' }]] });
  await ask(ui, '/subagent AAA go');
  await ask(ui, '/subagent BBB go');
  await settleUntil(() => a!.held && b!.held);
  await ask(ui, 'main go');
  await settleUntil(() => model.requests.some((r) => firstUser(r).includes('main go')));
  await settleUntil(() => frameOf(ui).includes('⚙ bbb-go'));
  const before = model.requests.length;
  await ui.press('down');
  expect(inRows(ui)).toBe(true);
  for (const k of ['q', 'w', 'return', 'tab', 'pageup']) await ui.press(k);
  await ui.type('hello');
  expect(inRows(ui)).toBe(true);
  expect(model.requests.length).toBe(before);
  await ui.press('escape');
  expect(inRows(ui)).toBe(false);
  // The turn was not stopped by that Esc, and it armed no exit.
  expect(frameOf(ui)).not.toContain('again to');
  expect(frameOf(ui)).not.toContain('stopped (');
  expect(rowsOf(ui)[fieldAt(ui)]).not.toContain('qw');
  expect(rowsOf(ui)[fieldAt(ui)]).not.toContain('hello');
  a!.release(); b!.release();
  model.release();
  await settleUntil(() => frameOf(ui).includes('main answer'));
  expect(frameOf(ui)).toContain('main answer');
  ui.app.unmount();
});

test('the cursor stays on its node when another above ends, moves to the nearest when its own ends, and the field has the keys when none is left', async () => {
  const { children: [a, b], ui } = await twoHeld();
  await ui.press('down');
  await ui.press('down');
  a!.release();
  await settleUntil(() => frameOf(ui).includes('◆ aaa-go finished:'));
  await settleUntil(() => !frameOf(ui).includes('⚙ aaa-go'));
  expect(inRows(ui)).toBe(true);
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop bbb-go? y yes · n no');
  await ui.press('n');
  b!.release();
  await settleUntil(() => frameOf(ui).includes('◆ bbb-go finished:'));
  await settleUntil(() => !inRows(ui));
  expect(frameOf(ui)).toContain('↑↓ history');
  await ui.type('ok');
  expect(rowsOf(ui)[fieldAt(ui)]).toContain('› ok');
  ui.app.unmount();
});

test('the cursor moves to the nearest row when the node under it ends and others are left', async () => {
  const { children: [a, b], ui } = await twoHeld();
  await ui.press('down');
  b!.release();
  await ui.press('down');
  // The cursor was on bbb-go; once it ends the cursor is on aaa-go.
  await settleUntil(() => frameOf(ui).includes('◆ bbb-go finished:'));
  await settleUntil(() => !frameOf(ui).includes('⚙ bbb-go'));
  expect(inRows(ui)).toBe(true);
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop aaa-go? y yes · n no');
  a!.release();
  ui.app.unmount();
});

test('a stop question is dropped when the node it was for has ended', async () => {
  const { children: [a, b], ui } = await twoHeld();
  await ui.press('down');
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop aaa-go? y yes · n no');
  a!.release();
  await settleUntil(() => frameOf(ui).includes('◆ aaa-go finished:'));
  await settleUntil(() => !frameOf(ui).includes('⚙ aaa-go') && !frameOf(ui).includes('stop aaa-go?'));
  expect(frameOf(ui)).not.toContain('y yes · n no');
  expect(inRows(ui)).toBe(true);
  b!.release();
  ui.app.unmount();
});

test('the `+K more` row is never a stop of the cursor', async () => {
  const { children: [a, b, c], ui } = await boot([{ mark: 'AAA' }, { mark: 'BBB' }, { mark: 'CCC' }], { ui: { agentRows: 2 } });
  await ask(ui, '/subagent AAA go');
  await ask(ui, '/subagent BBB go');
  await ask(ui, '/subagent CCC go');
  await settleUntil(() => a!.held && b!.held && c!.held);
  await settleUntil(() => frameOf(ui).includes('+2 more — /agents'));
  await ui.press('down');
  await ui.press('down');
  await ui.press('down');
  expect(inRows(ui)).toBe(true);
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop aaa-go? y yes · n no');
  await ui.press('n');
  await ui.press('up');
  expect(inRows(ui)).toBe(false);
  a!.release(); b!.release(); c!.release();
  ui.app.unmount();
});

test('with the cursor in the rows a child\'s y/n is not answerable: the notice line, y answers nothing, and after Esc the block is armed afresh', async () => {
  const { children: [stay, w], ui, root } = await boot([{ mark: 'STAY' }, { mark: 'ASKW', writes: true }]);
  await ask(ui, '/subagent STAY go');
  await ask(ui, '/subagent ASKW go');
  await settleUntil(() => stay!.held && w!.held);
  await settleUntil(() => frameOf(ui).includes('⚙ askw-go'));
  await ui.press('down');
  w!.release();
  await settleUntil(() => frameOf(ui).includes('⏸ askw-go · waiting for a y/n'));
  expect(frameOf(ui)).toContain('⏸ askw-go waits for a y/n — Esc to answer');
  expect(frameOf(ui)).not.toContain(BLOCK);
  clock.t += 700;
  await ui.press('y');
  await settle(4);
  expect(fs.existsSync(path.join(root, 'ASKW.txt'))).toBe(false);
  expect(inRows(ui)).toBe(true);
  await ui.press('escape');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  // The block has just come on screen: a y inside the pause answers nothing (it is typed).
  clock.t += 100;
  await ui.press('y');
  await settle(4);
  expect(fs.existsSync(path.join(root, 'ASKW.txt'))).toBe(false);
  await ui.press('backspace');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  expect(frameOf(ui)).toContain(BLOCK);
  clock.t += 700;
  await ui.press('y');
  await settleUntil(() => fs.existsSync(path.join(root, 'ASKW.txt')));
  expect(fs.existsSync(path.join(root, 'ASKW.txt'))).toBe(true);
  stay!.release();
  ui.app.unmount();
});

test('x then y with a child\'s request waiting stops the node and approves nothing', async () => {
  const { children: [stay, w], ui, root } = await boot([{ mark: 'STAY' }, { mark: 'ASKW', writes: true }]);
  await ask(ui, '/subagent STAY go');
  await ask(ui, '/subagent ASKW go');
  await settleUntil(() => stay!.held && w!.held);
  await settleUntil(() => frameOf(ui).includes('⚙ askw-go'));
  await ui.press('down');
  w!.release();
  await settleUntil(() => frameOf(ui).includes('⏸ askw-go · waiting for a y/n'));
  // The cursor stayed on the first node it entered; the waiting one is the second row.
  await ui.press('down');
  clock.t += 700;
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop askw-go? y yes · n no');
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('◆ askw-go stopped:'));
  expect(frameOf(ui)).toContain('◆ askw-go stopped:');
  expect(fs.existsSync(path.join(root, 'ASKW.txt'))).toBe(false);
  stay!.release();
  ui.app.unmount();
});

test('an own y/n that arrives while the cursor is in the rows takes the keys as it always did, and the cursor does not come back', async () => {
  const root0 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-tree-own-')));
  const { children: [a, b], ui, model, root } = await boot([{ mark: 'AAA' }, { mark: 'BBB' }], { main: [[{ hold: true }, { tool: 'run_command', args: { command: `touch ${path.join(root0, 'OWN.txt')}` } }], [{ text: 'main done' }]] });
  void root;
  await ask(ui, '/subagent AAA go');
  await ask(ui, '/subagent BBB go');
  await settleUntil(() => a!.held && b!.held);
  await ask(ui, 'main go');
  await settleUntil(() => model.held);
  await settleUntil(() => frameOf(ui).includes('⚙ bbb-go'));
  await ui.press('down');
  expect(inRows(ui)).toBe(true);
  model.release();
  await settleUntil(() => frameOf(ui).includes('Confirm write: run_command') || frameOf(ui).includes('run_command'));
  await settleUntil(() => !inRows(ui));
  expect(inRows(ui)).toBe(false);
  expect(frameOf(ui)).not.toContain('⚙ bbb-go');
  clock.t += 700;
  await ui.press('y');
  await settleUntil(() => fs.existsSync(path.join(root0, 'OWN.txt')));
  expect(fs.existsSync(path.join(root0, 'OWN.txt'))).toBe(true);
  await settleUntil(() => frameOf(ui).includes('main done'));
  // The rows are back, with the cursor in the field.
  await settleUntil(() => frameOf(ui).includes('⚙ bbb-go'));
  expect(inRows(ui)).toBe(false);
  a!.release(); b!.release();
  ui.app.unmount();
});

test('the chat collapsed and opened again has the cursor in the field', async () => {
  const { children: [a], ui } = await boot([{ mark: 'AAA' }], { cols: 160, rows: 40, mode: 'panel' });
  await ask(ui, '/subagent AAA go');
  await settleUntil(() => a!.held);
  await settleUntil(() => frameOf(ui).includes('⚙ aaa-go'));
  await ui.press('down');
  expect(inRows(ui)).toBe(true);
  ui.backend.press(COLLAPSE);
  await settle();
  ui.backend.press(COLLAPSE);
  await settle();
  expect(inRows(ui)).toBe(false);
  expect(frameOf(ui)).toContain('↑↓ history');
  a!.release();
  ui.app.unmount();
});

// ── /agents (AGENTS.md (agent tree))
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

test('/agents lists live nodes in tree order with their time and then the ended ones; x on an ended row is refused', async () => {
  const { children: [outer, inner, other], ui } = await boot([
    { mark: 'OUTER', script: [[{ hold: true }, { tool: 'subagent', args: { task: 'INNER work', label: 'inner' } }], [{ hold: true }, { text: 'outer settled' }]] },
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
  // An ended one moves below the live ones.
  other!.release();
  await settleUntil(() => rowsOf(ui).some((r) => /other-go.*done/.test(r)));
  const after = rowsOf(ui);
  expect(after.findIndex((r) => /other-go.*done/.test(r))).toBeGreaterThan(after.findIndex((r) => r.includes('inner (task)')));
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
