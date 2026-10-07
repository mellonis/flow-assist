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

// ─── The place in the list ────────────────────────────────────────────────────
// A: a turn with a tool call (its block opened by a click, so the rows above the place
// are laid out with the restored folds) and, in a later turn, thirty remarks, then a second turn held on
// its first step. `scrolled` pages up first. A is left by `/new`; while it is away its
// held step goes on and lands a tool call in it.
const REMARKS = Array.from({ length: 30 }, (_, i) => `Remark number ${i + 1}.`).join('\n\n');
const topRemark = (ui: UI) => Number(/Remark number (\d+)\./.exec(frameOf(ui))?.[1] ?? NaN);
async function leftInPlace(scrolled: boolean) {
  const model = new ScriptedModel();
  const aSub = model.when((req) => firstUser(req).includes('session A question'));
  aSub.script(
    [{ tool: 'datetime', args: {} }],
    [{ text: 'A first.' }],
    [{ text: REMARKS }],
    [{ hold: true }, { tool: 'datetime', args: {} }],
    [{ hold: true }, { text: 'Closing words.' }],
  );
  model.script([{ text: 'B answer.' }]);
  const ui = await bootApp(model, 100, 24, undefined, { sessions: { dir: dirOf() } }, { toastMs: 10_000 });
  await ui.press('F');
  await ask(ui, 'session A question');
  await settleUntil(() => frameOf(ui).includes('A first.'));
  await settle(6);
  await ask(ui, 'session A remarks');
  await settleUntil(() => frameOf(ui).includes('Remark number 30.'));
  await settle(6);
  await ask(ui, 'session A again');
  await settleUntil(() => aSub.held);
  if (scrolled) {
    for (let i = 0; i < 40 && rowOf(ui, '1 tool: datetime') < 0; i++) await ui.press('pageup');
    await click(ui, rowOf(ui, '1 tool: datetime'));
    expect(frameOf(ui)).toMatch(OPEN);
    for (let i = 0; i < 2; i++) await ui.press('pagedown');
    await settle(6);
  }
  const before = topRemark(ui);
  const line = rowOf(ui, `Remark number ${before}.`);
  await ask(ui, '/new');
  await settle(4);
  await ask(ui, 'session B question');
  await settleUntil(() => frameOf(ui).includes('B answer.'));
  await settle(4);
  // Rows reach A while it is away.
  aSub.release();
  await settleUntil(() => aSub.held);
  await settle(10);
  return { ui, aSub, before, line };
}

test('a session left scrolled up comes back at the same line, though rows arrived while it was away', async () => {
  const { ui, aSub, before, line } = await leftInPlace(true);
  expect(before).toBeLessThan(30);
  await pick(ui, 'session A question');
  expect(frameOf(ui)).toContain('Resumed «session A question»');
  // The very row, not only the remark: the opened block above it is a row or two.
  expect(topRemark(ui)).toBe(before);
  expect(rowOf(ui, `Remark number ${before}.`)).toBe(line);
  expect(frameOf(ui)).not.toContain('Remark number 30.');
  aSub.release();
  await settle(6);
  ui.app.unmount();
});

test('a session left at its end comes back at its end, and follows what arrives next', async () => {
  const { ui, aSub } = await leftInPlace(false);
  await pick(ui, 'session A question');
  expect(frameOf(ui)).toContain('Resumed «session A question»');
  expect(frameOf(ui)).toMatch(/1 tool: datetime/);
  aSub.release();
  await settleUntil(() => frameOf(ui).includes('Closing words.'));
  expect(frameOf(ui)).toContain('Closing words.');
  ui.app.unmount();
});

// ─── The caret in the draft ───────────────────────────────────────────────────
// A: its answer starts a background task, which keeps the session loaded; a second turn
// is held on its first step. A draft `abcdef` is left with the caret after `abc`, and A
// is left through the picker (B is a saved session), so the field still holds the draft.
const fieldRow = (ui: UI) => frameOf(ui).split('\n').filter((r) => r.includes('› ')).at(-1) ?? '';
async function leftWithDraft(failTurn: boolean) {
  const model = new ScriptedModel();
  const task = model.when((req) => String(req.messages.find((m) => m.role === 'system')?.content ?? '').includes('Task: slow job'));
  task.script([{ hold: true }, { text: 'job result' }]);
  model.script(
    [{ text: 'B answer.' }],
    [{ tool: 'background', args: { task: 'slow job', label: 'job' } }],
    [{ text: 'Started it.' }],
    [{ hold: true }, { text: 'Second.' }],
  );
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir: dirOf() } }, { toastMs: 10_000 });
  // The second turn's request is refused (a 400, which is not retried) once `release()` lets
  // it go: the turn fails while its session is away.
  let reached = false;
  let gate: (() => void) | null = null;
  const scripted = globalThis.fetch;
  if (failTurn) {
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      if (String(init?.body).includes('session A second')) {
        reached = true;
        await new Promise<void>((r) => { gate = r; });
        return new Response(JSON.stringify({ error: { message: 'refused' } }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return scripted(url as string, init);
    }) as typeof fetch;
  }
  const release = () => { if (failTurn) gate?.(); else model.release(); };
  const held = () => (failTurn ? reached : model.held);
  await ui.press('F');
  await ask(ui, 'session B question');
  await settleUntil(() => frameOf(ui).includes('B answer.'));
  await ask(ui, '/new');
  await settle(4);
  await ask(ui, 'session A question');
  await settleUntil(() => task.held && frameOf(ui).includes('Started it.'));
  await ask(ui, 'session A second');
  await settleUntil(held);
  if (failTurn) { await ask(ui, 'queued text'); await settle(4); }
  await ui.type('abcdef');
  for (let i = 0; i < 3; i++) await ui.press('left');
  await settle(2);
  await pick(ui, 'session B question');
  expect(frameOf(ui)).toContain('B answer.');
  return { ui, release, task };
}

test('a draft left with the caret in the middle comes back with the caret there', async () => {
  const { ui, release, task } = await leftWithDraft(false);
  await pick(ui, 'session A question');
  expect(frameOf(ui)).toContain('Resumed «session A question»');
  expect(fieldRow(ui)).toContain('abcdef');
  await ui.type('X');
  await settle(2);
  expect(fieldRow(ui)).toContain('abcXdef');
  release();
  task.release();
  ui.app.unmount();
});

test('a draft that grew while the session was away comes back with the caret at its end', async () => {
  const { ui, release, task } = await leftWithDraft(true);
  // The turn fails while A is away: its queued message goes ahead of the draft.
  release();
  await settle(30);
  await pick(ui, 'session A question');
  expect(frameOf(ui)).toContain('Resumed «session A question»');
  expect(fieldRow(ui)).toContain('queued text');
  await ui.type('X');
  await settle(2);
  expect(frameOf(ui)).toContain('abcdefX');
  task.release();
  ui.app.unmount();
});
