// A click opens the block under it, and the key opens everything.
//
// A single global key would make everything foldable answer to it: to read the output
// of ONE command a person would have to unfold the whole conversation and fold it
// back. The mouse was already
// reported — the wheel scrolls, a drag selects and copies — and the buttons were
// dropped before every handler, so a click was available and unused.
//
// These tests drive the REAL chat on a test backend: `backend.mouse('down'|'up', x, y)`
// is what a terminal reports, and the frame is what a person would see.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Ui = Awaited<ReturnType<typeof bootApp>>;
const settleUntil = async (ok: () => boolean, n = 200) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };

// The row a piece of text is drawn on, and a cell inside the conversation on it.
function rowOf(ui: Ui, needle: string): number {
  const at = ui.backend.lastFrame.split('\n').findIndex((r) => r.includes(needle));
  if (at < 0) throw new Error(`"${needle}" is not on screen:\n${ui.backend.lastFrame}`);
  return at;
}
const click = async (ui: Ui, y: number, x = 12) => {
  ui.backend.mouse('down', x, y);
  ui.backend.mouse('up', x, y);
  await settle(6);
};
// A press, a drag across the row and a release — what a selection looks like.
const dragAcross = async (ui: Ui, y: number, from = 12, to = 40) => {
  ui.backend.mouse('down', from, y);
  ui.backend.mouse('drag', to, y);
  ui.backend.mouse('up', to, y);
  await settle(6);
};

// Two turns, each with tool calls behind a `▸ N tools` summary.
async function twoTurns(cols = 100, rows = 34) {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'datetime', args: {} }],
    [{ text: 'It is Tuesday.' }],
    [{ tool: 'datetime', args: {} }],
    [{ text: 'Still Tuesday.' }],
  );
  const ui = await bootApp(model, cols, rows);
  await ui.press('F');
  await ui.type('what day is it?');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('It is Tuesday.'));
  await ui.type('and now?');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Still Tuesday.'));
  await settle(6);
  return { ui, model };
}

test('a click on a turn\'s tool line opens THAT turn\'s calls and leaves the other folded', async () => {
  const { ui } = await twoTurns();
  const frame = ui.backend.lastFrame.split('\n');
  const summaries = frame.map((r, i) => (r.includes('1 tool: datetime') ? i : -1)).filter((i) => i >= 0);
  expect(summaries).toHaveLength(2);
  await click(ui, summaries[0]!);
  const opened = ui.backend.lastFrame;
  // The calls of the first turn are out; the second turn is still one line.
  expect(opened).toMatch(/▸ datetime.*→ ok/);
  expect(opened.split('\n').filter((r) => /▾ 1 tool/.test(r))).toHaveLength(1);
  expect(opened.split('\n').filter((r) => /▸ 1 tool/.test(r))).toHaveLength(1);
  ui.app.unmount();
});

test('a click inside an open block closes it; a drag over it copies and folds nothing', async () => {
  const { ui } = await twoTurns();
  await click(ui, rowOf(ui, '1 tool: datetime'));
  const call = rowOf(ui, '▸ datetime');
  // A drag is a selection, never a fold — the block is still open afterwards.
  await dragAcross(ui, call);
  expect(ui.backend.lastFrame).toMatch(/▸ datetime.*→ ok/);
  expect(ui.backend.clipboard.join('')).toContain('→ ok');
  // A click on a row of the open block closes it.
  await click(ui, rowOf(ui, '▸ datetime'));
  expect(ui.backend.lastFrame).not.toMatch(/▸ datetime.*→ ok/);
  ui.app.unmount();
});

test('a click on a plain answer row changes nothing', async () => {
  const { ui } = await twoTurns();
  const before = ui.backend.lastFrame;
  await click(ui, rowOf(ui, 'It is Tuesday.'));
  await click(ui, rowOf(ui, 'what day is it?'));
  expect(ui.backend.lastFrame).toBe(before);
  ui.app.unmount();
});

test('the key opens everything — the block clicked shut included — and closes everything again', async () => {
  const { ui } = await twoTurns();
  // One block open by a click; the key then opens BOTH.
  await click(ui, rowOf(ui, '1 tool: datetime'));
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(6);
  expect(ui.backend.lastFrame.split('\n').filter((r) => /▾ 1 tool/.test(r))).toHaveLength(2);
  // Click one shut again: the key still opens everything, it does not close.
  await click(ui, rowOf(ui, '▾ 1 tool'));
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(6);
  expect(ui.backend.lastFrame.split('\n').filter((r) => /▾ 1 tool/.test(r))).toHaveLength(2);
  // Nothing folded now — so the key closes all of it.
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(6);
  expect(ui.backend.lastFrame.split('\n').filter((r) => /▸ 1 tool/.test(r))).toHaveLength(2);
  ui.app.unmount();
});

test('^r still does what ^o does — the key it answered to before is an alias', async () => {
  const { ui } = await twoTurns();
  ui.backend.press({ name: 'r', ctrl: true });
  await settle(6);
  expect(ui.backend.lastFrame.split('\n').filter((r) => /▾ 1 tool/.test(r))).toHaveLength(2);
  ui.app.unmount();
});

test('with everything open a new turn arrives open, and /clear goes back to folded', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'datetime', args: {} }],
    [{ text: 'It is Tuesday.' }],
    [{ tool: 'datetime', args: {} }],
    [{ text: 'Still Tuesday.' }],
  );
  const ui = await bootApp(model, 100, 34);
  await ui.press('F');
  await ui.type('what day is it?');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('It is Tuesday.'));
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(6);
  expect(ui.backend.lastFrame).toMatch(/▾ 1 tool/);
  // The next turn's trail follows the global state: it arrives open.
  await ui.type('and now?');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Still Tuesday.'));
  await settle(6);
  expect(ui.backend.lastFrame.split('\n').filter((r) => /▾ 1 tool/.test(r))).toHaveLength(2);
  // /clear starts again: everything folded, and no exception left over.
  await ui.type('/clear');
  await ui.press('return');
  await settle(8);
  expect(ui.backend.lastFrame).not.toContain('1 tool');
  ui.app.unmount();
});

// ─── Where the eye is left ────────────────────────────────────────────────────
// A block opened into a bottom-anchored conversation lands on its FIRST line, never
// its last: landing on the last line would show a report opened to be read from its
// end instead.

// The conversation's own top row: the frame's title, then its padding.
const contentTop = (ui: Ui) => rowOf(ui, 'ƒ Flow Assist') + 2;
// The block's own first row is the conversation's top row, where the pinned question
// is painted over it whenever the block is taller than the window — so what a reader
// sees first is the row under the pin.
const underPin = (ui: Ui) => contentTop(ui) + 1;

// A command whose output is far taller than the window, with plenty of conversation
// under it — so the list can be scrolled to the block and the block is not the last
// thing on it. PgUp is the scroll box's own key; it takes the view to the top.
// `runOutputLines` — how many lines an OPENED block shows: most tests here want the
// default 3 (a block a few rows tall, capped well under the window), but the test
// that proves a click scrolls a genuinely tall block wants one far bigger than the
// window (see below).
const TAIL = Array.from({ length: 20 }, (_, i) => `Remark number ${i + 1}.`).join('\n\n');
async function longOutput(runOutputLines = 3) {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'run_command', args: { command: 'seq 1 60' } }],
    [{ text: 'Sixty lines.' }],
    [{ text: TAIL }],
  );
  const ui = await bootApp(model, 100, 24, undefined, { plugins: { assistant: { runOutputLines } }, shell: { timeoutMs: 20000 } });
  await ui.press('F');
  await ui.type('count to sixty');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
  await ui.press('y');
  await settleUntil(() => ui.backend.lastFrame.includes('Sixty lines.'));
  await ui.type('and remark on it');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Remark number 20.'));
  await settle(8);
  for (let i = 0; i < 6; i++) await ui.press('pageup');
  return { ui, model };
}

test('a finished command, folded, is one line saying how it ended', async () => {
  // longOutput() already ends scrolled to the very top, where the folded line stands.
  const { ui } = await longOutput();
  expect(ui.backend.lastFrame).toMatch(/\$ seq 1 60 · ✓ \d+\.\d s/);
  expect(ui.backend.lastFrame).not.toContain('│ 60');
  ui.app.unmount();
});

test('opening a block taller than the window starts at its FIRST row, not its last', async () => {
  // runOutputLines: 40 — a click opens a block of 42 rows (command, cut marker, 40
  // lines, tail), genuinely taller than the 24-row window; runOutputLines: 3's 6-row
  // block (used everywhere else in this file) never is, which is why THIS test needs
  // its own, bigger cap to exercise the scroll at all.
  const { ui } = await longOutput(40);
  // Nudge the fold line away from the top before clicking — longOutput() itself ends
  // scrolled there, and a pass that never leaves the top proves nothing about the
  // click's own scroll-to-first-row behaviour (a prior version of this test did
  // exactly that, and passed whether or not the click scrolled anything).
  // (Only when it IS at the top: a wheel step is several rows, and a fold line already
  // a row or two down would be scrolled out of the window altogether.)
  if (rowOf(ui, 'seq 1 60 ·') === contentTop(ui)) {
    ui.backend.wheel('down', 20, 8);
    await settle(4);
  }
  const foldRow = rowOf(ui, 'seq 1 60 ·');
  expect(foldRow).not.toBe(contentTop(ui));
  await click(ui, foldRow);
  // Reading starts at the beginning of the block, and the wheel takes it from there.
  // Landing on the block's LAST line instead would show the end of the very thing the
  // person opened it to read. The block is far taller than the window, so it pushes the
  // pinned last question back out of view — the block's own first row (the command
  // line) sits behind the pin, and the cut marker is the first row a reader actually
  // sees.
  expect(rowOf(ui, 'lines cut')).toBe(underPin(ui));
  expect(ui.backend.lastFrame).not.toContain('│ 60');
  ui.app.unmount();
});

test('closing a block leaves its first row where it was on screen', async () => {
  const { ui } = await longOutput();
  await click(ui, rowOf(ui, 'seq 1 60 ·'));
  const first = rowOf(ui, 'seq 1 60');
  // A click inside the open output folds it back — and the block starts on the same
  // row as before, so the conversation does not leap under the person reading it.
  await click(ui, first + 3);
  expect(ui.backend.lastFrame).toContain('seq 1 60 ·');
  expect(rowOf(ui, 'seq 1 60 ·')).toBe(first);
  ui.app.unmount();
});

test('a click opens a command capped to its last lines; ^o opens it in full', async () => {
  const { ui } = await longOutput();
  await click(ui, rowOf(ui, 'seq 1 60 ·'));
  // A click shows the capped tail — the same 6 rows every open-by-click test sees.
  expect(ui.backend.lastFrame).toContain('… 57 lines cut · ^o for all');
  expect(ui.backend.lastFrame).toContain('│ 58');
  expect(ui.backend.lastFrame).toContain('│ 60');
  expect(ui.backend.lastFrame).not.toContain('│ 1');
  // The GLOBAL key opens every view in full — every line it kept, not the capped tail
  // a click shows — which is what makes the cut marker's own "^o for all" true.
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(6);
  expect(ui.backend.lastFrame).not.toContain('lines cut');
  for (let i = 0; i < 6; i++) await ui.press('pageup');
  expect(ui.backend.lastFrame).toContain('│ 1');
  for (let i = 0; i < 6; i++) await ui.press('pagedown');
  expect(ui.backend.lastFrame).toContain('│ 60');
  ui.app.unmount();
});

test('a message sent after a block was opened still sticks to the bottom', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'datetime', args: {} }],
    [{ text: 'It is Tuesday.' }],
    [{ text: 'A brand new answer.' }],
  );
  const ui = await bootApp(model, 100, 22);
  await ui.press('F');
  await ui.type('what day is it?');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('It is Tuesday.'));
  await settle(6);
  await click(ui, rowOf(ui, '1 tool: datetime'));
  await ui.type('anything else?');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('A brand new answer.'));
  await settle(6);
  expect(ui.backend.lastFrame).toContain('A brand new answer.');
  ui.app.unmount();
});
