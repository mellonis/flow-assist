// A session the chat leaves while it works stays loaded here and is taken back as the
// same conversation: its unfolded blocks and its notes mode come back with it. One put
// away, one read from its file and a cleared one open as any saved session does —
// folded, on the config's notes mode (AGENTS.md (a host makes its conversations through
// one registry)).
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allFolded } from '../assistant/folds.ts';
import { recalledFolds, rememberView } from '../assistant/view-memory.ts';
import { ScriptedModel, bootApp, firstUser, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-view-memory-'));
type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
const rowOf = (ui: UI, text: string) => frameOf(ui).split('\n').findIndex((r) => r.includes(text));
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
async function click(ui: UI, y: number, x = 12) {
  ui.backend.mouse('down', x, y);
  ui.backend.mouse('up', x, y);
  await settle(6);
}
// Opens the picker, walks the cursor to the row holding `text`, and takes it with ⏎.
async function pick(ui: UI, text: string) {
  ui.backend.press({ name: 's', ctrl: true });
  await settle(3);
  const rows = frameOf(ui).split('\n').filter((r) => / msgs? │/.test(r));
  const at = rows.findIndex((r) => r.includes(text));
  if (at < 0) throw new Error(`pick: no row with ${text}`);
  for (let i = 0; i < at; i++) { await ui.press('down'); await settle(1); }
  await ui.press('return');
  await settle(4);
}
const OPEN = /▾ 1 tool/;
const FOLDED = /▸ 1 tool/;

// A: a turn with a tool call behind a summary line, its block opened by a click and the
// notes mode moved to `open`, then a second turn held; A is left by `/new` and B, a
// plain session, is on screen. `how` goes back to A.
async function leftWhileHeld(dir: string) {
  const model = new ScriptedModel();
  const aSub = model.when((req) => firstUser(req).includes('session A question'));
  aSub.script(
    [{ tool: 'datetime', args: {} }],
    [{ text: 'A first.' }],
    [{ hold: true }, { text: 'A final answer.' }],
  );
  model.script([{ text: 'B answer.' }]);
  const ui = await bootApp(model, 100, 34, undefined, { sessions: { dir } }, { toastMs: 10_000 });
  await ui.press('F');
  await ask(ui, 'session A question');
  await settleUntil(() => frameOf(ui).includes('A first.'));
  await settle(6);
  await click(ui, rowOf(ui, '1 tool: datetime'));
  expect(frameOf(ui)).toMatch(OPEN);
  await ask(ui, '/notes open');
  await settle(4);
  expect(frameOf(ui)).toContain('notes: open');
  await ask(ui, 'session A again');
  await settleUntil(() => aSub.held);
  await ask(ui, '/new');
  await settle(4);
  await ask(ui, 'session B question');
  await settleUntil(() => frameOf(ui).includes('B answer.'));
  await settle(4);
  // Nothing of A's view is on B's screen.
  expect(frameOf(ui)).not.toMatch(OPEN);
  await ask(ui, '/notes');
  await settle(4);
  expect(frameOf(ui)).toContain('notes: step');
  return { ui, aSub, model };
}

for (const how of ['the picker', '/resume'] as const) {
  test(`a session taken back through ${how} while it is open here keeps its unfolded block and its notes mode`, async () => {
    const { ui, aSub } = await leftWhileHeld(dirOf());
    if (how === 'the picker') await pick(ui, 'session A question');
    else { await ask(ui, '/resume 2'); await settle(6); }
    expect(frameOf(ui)).toContain('Resumed «session A question»');
    expect(frameOf(ui)).toContain('A first.');
    expect(frameOf(ui)).toMatch(OPEN);
    expect(frameOf(ui)).not.toMatch(FOLDED);
    await ask(ui, '/notes');
    await settle(4);
    expect(frameOf(ui)).toContain('notes: open');
    aSub.release();
    await settleUntil(() => frameOf(ui).includes('A final answer.'));
    ui.app.unmount();
  });
}

test('a session put away while it was left opens folded, on the config\'s notes mode', async () => {
  const { ui, aSub } = await leftWhileHeld(dirOf());
  // Its turn ends while it is away: nothing of its own is left, so it is put away.
  aSub.release();
  await settleUntil(() => !frameOf(ui).includes('A final answer.') && aSub.held === false);
  await settle(20);
  await pick(ui, 'session A question');
  expect(frameOf(ui)).toContain('A final answer.');
  expect(frameOf(ui)).toMatch(FOLDED);
  expect(frameOf(ui)).not.toMatch(OPEN);
  await ask(ui, '/notes');
  await settle(4);
  expect(frameOf(ui)).toContain('notes: step');
  ui.app.unmount();
});

test('/clear folds everything and never brings back what the session had open', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'datetime', args: {} }], [{ text: 'It is Tuesday.' }],
    [{ tool: 'datetime', args: {} }], [{ text: 'Still Tuesday.' }],
  );
  const ui = await bootApp(model, 100, 34);
  await ui.press('F');
  await ask(ui, 'what day is it?');
  await settleUntil(() => frameOf(ui).includes('It is Tuesday.'));
  await settle(6);
  await click(ui, rowOf(ui, '1 tool: datetime'));
  expect(frameOf(ui)).toMatch(OPEN);
  await ask(ui, '/clear');
  await settle(8);
  expect(frameOf(ui)).not.toContain('1 tool');
  await ask(ui, 'and now?');
  await settleUntil(() => frameOf(ui).includes('Still Tuesday.'));
  await settle(6);
  expect(frameOf(ui)).toMatch(FOLDED);
  expect(frameOf(ui)).not.toMatch(OPEN);
  ui.app.unmount();
});

test('an entry shares no exception set with the live folds: a click made after it was written does not reach it', () => {
  const live = { open: false, except: new Set(['1:calls']) };
  const entry = rememberView(live, 'open');
  live.except.add('3:calls');
  expect([...entry.folds.except]).toEqual(['1:calls']);
  // And the folds it hands back are the chat's to change.
  const back = recalledFolds(entry);
  (back.except as Set<string>).add('5:calls');
  expect([...entry.folds.except]).toEqual(['1:calls']);
  expect(allFolded().except.size).toBe(0);
});
