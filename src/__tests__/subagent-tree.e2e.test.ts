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
async function boot(marks: { mark: string; writes?: boolean; script?: any[][] }[], opts: { cols?: number; rows?: number; mode?: 'window' | 'panel'; ui?: Record<string, unknown> } = {}) {
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
  const ui = await bootApp(model, opts.cols ?? 140, opts.rows ?? 34, boards as never, { sessions: { dir: sessions }, shell: { roots: [root] }, ...(opts.ui ? { ui: opts.ui } : {}), ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false } }, { toastMs: 10_000, ...(opts.mode ? { chatMode: opts.mode } : {}) });
  await ui.press('F');
  return { children, ui, model, root };
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
