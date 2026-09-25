// A block taller than the conversation opens in a pager, not into the conversation.
//
// A build's output or a turn of dozens of calls opened inline pushes the rest of the
// conversation out of reach: the person scrolls through hundreds of rows to get back
// to what was said. A pager is one window with that block alone and its own scroll,
// like the log and the help; closing it leaves the conversation exactly where it was.
//
// These tests drive the REAL chat on a test backend, as folds.e2e.test.ts does.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Ui = Awaited<ReturnType<typeof bootApp>>;
const settleUntil = async (ok: () => boolean, n = 200) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };

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
// The pager's own hint line — what says it is on screen.
const PAGER_HINT = 'the wheel scroll · Esc close';
const pagerUp = (ui: Ui) => ui.backend.lastFrame.includes(PAGER_HINT);

// A command the model ran, then an answer, then more conversation under it — so the
// list can be scrolled up to the block and the block is not the last thing on it.
const TAIL = Array.from({ length: 12 }, (_, i) => `Remark number ${i + 1}.`).join('\n\n');
async function commandThenTalk(command: string, cols = 100, rows = 24) {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'run_command', args: { command } }],
    [{ text: 'Done counting.' }],
    [{ text: TAIL }],
  );
  const ui = await bootApp(model, cols, rows, undefined, { shell: { timeoutMs: 20000 } });
  await ui.press('F');
  await ui.type('count');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
  await ui.press('y');
  await settleUntil(() => ui.backend.lastFrame.includes('Done counting.'));
  await ui.type('and remark on it');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Remark number 12.'));
  await settle(8);
  // Up to the block: PgUp is the conversation's own key.
  for (let i = 0; i < 6 && !ui.backend.lastFrame.includes(`${command} ·`); i++) await ui.press('pageup');
  return { ui, model };
}

test('a command of 300 lines: the fold line says how much, a click opens a pager, Esc comes back to where the conversation was', async () => {
  const { ui } = await commandThenTalk('seq 1 300');
  // The fold line says how much there is to read — what the block kept (a view keeps
  // its last 200 lines at collection).
  expect(ui.backend.lastFrame).toMatch(/seq 1 300 · ✓ \d+\.\d s · 200 lines/);
  const before = ui.backend.lastFrame;
  await click(ui, rowOf(ui, 'seq 1 300 ·'));
  // A pager on screen, the block from its first row — and not two hundred rows pushed
  // into the conversation.
  expect(pagerUp(ui)).toBe(true);
  expect(ui.backend.lastFrame).toContain('│ 101');
  expect(ui.backend.lastFrame).not.toContain('│ 300');
  // Its own scroll: PgDn to the end (the exit line), PgUp back, the wheel over it.
  for (let i = 0; i < 20; i++) await ui.press('pagedown');
  expect(ui.backend.lastFrame).toContain('│ 300');
  expect(ui.backend.lastFrame).toMatch(/✓ \d+\.\d s/);
  expect(ui.backend.lastFrame).not.toContain('│ 101');
  for (let i = 0; i < 20; i++) await ui.press('pageup');
  expect(ui.backend.lastFrame).toContain('│ 101');
  const y = rowOf(ui, '│ 105');
  ui.backend.wheel('down', 20, y);
  await settle(4);
  expect(ui.backend.lastFrame).not.toContain('│ 101');
  expect(ui.backend.lastFrame).toContain('│ 110');
  // Esc: the conversation exactly as it was, the block still folded.
  await ui.press('escape');
  expect(pagerUp(ui)).toBe(false);
  expect(ui.backend.lastFrame).toBe(before);
  // Still folded, so a click opens the pager again.
  await click(ui, rowOf(ui, 'seq 1 300 ·'));
  expect(pagerUp(ui)).toBe(true);
  ui.app.unmount();
});

test('the pager is a reader: typing, ⏎, ^o and a click inside it change nothing, and nothing is sent', async () => {
  const { ui, model } = await commandThenTalk('seq 1 300');
  const before = ui.backend.lastFrame;
  await click(ui, rowOf(ui, 'seq 1 300 ·'));
  const sent = model.requests.length;
  const shown = ui.backend.lastFrame;
  await ui.type('hello');
  await ui.press('return');
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(6);
  await click(ui, rowOf(ui, '│ 103'));
  await settle(10);
  expect(ui.backend.lastFrame).toBe(shown);
  expect(model.requests.length).toBe(sent);
  // Back in the conversation: the field is empty, nothing was opened.
  await ui.press('escape');
  expect(ui.backend.lastFrame).toBe(before);
  ui.app.unmount();
});

test('a drag inside the pager copies its text — the output, not the bar beside it', async () => {
  const { ui } = await commandThenTalk('seq 1 300');
  await click(ui, rowOf(ui, 'seq 1 300 ·'));
  const from = rowOf(ui, '│ 101');
  ui.backend.mouse('down', 4, from);
  ui.backend.mouse('drag', 30, from + 2);
  ui.backend.mouse('up', 30, from + 2);
  await settle(6);
  const copied = ui.backend.clipboard.join('');
  expect(copied).toContain('101\n102\n103');
  expect(copied).not.toContain('│');
  // A drag is a selection: the pager is still up.
  expect(pagerUp(ui)).toBe(true);
  ui.app.unmount();
});

test('a 5-line block still opens inline, where it was clicked', async () => {
  const { ui } = await commandThenTalk('seq 1 5');
  expect(ui.backend.lastFrame).not.toMatch(/seq 1 5 · .* lines/);
  await click(ui, rowOf(ui, 'seq 1 5 ·'));
  expect(pagerUp(ui)).toBe(false);
  expect(ui.backend.lastFrame).toContain('│ 1');
  expect(ui.backend.lastFrame).toContain('│ 5');
  ui.app.unmount();
});

test('^o opens everything inline, the tall block included — the pager is for opening ONE block', async () => {
  const { ui } = await commandThenTalk('seq 1 300');
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(6);
  expect(pagerUp(ui)).toBe(false);
  for (let i = 0; i < 30 && !ui.backend.lastFrame.includes('│ 101'); i++) await ui.press('pageup');
  expect(ui.backend.lastFrame).toContain('│ 101');
  ui.app.unmount();
});

// A docked panel is a plain box, so the pager has to be told where the panel lies:
// on the right from 120 columns, at the bottom below that.
for (const [side, cols, rows] of [['right', 140, 30], ['bottom', 100, 44]] as const) {
  test(`the pager covers the chat in a ${side} panel, and Esc hands the panel back`, async () => {
    const model = new ScriptedModel();
    model.script([{ tool: 'run_command', args: { command: 'seq 1 300' } }], [{ text: 'Done counting.' }]);
    const ui = await bootApp(model, cols, rows, undefined, { shell: { timeoutMs: 20000 } }, { chatMode: 'panel' });
    await ui.press('F');
    await ui.type('count');
    await ui.press('return');
    await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
    await ui.press('y');
    await settleUntil(() => ui.backend.lastFrame.includes('Done counting.'));
    await settle(8);
    const before = ui.backend.lastFrame;
    const lines = before.split('\n');
    const panelTop = lines.findIndex((l) => l.includes('╭─ ƒ'));
    const panelLeft = lines[panelTop]!.indexOf('╭─ ƒ');
    const y = rowOf(ui, 'seq 1 300 ·');
    const x = lines[y]!.indexOf('seq 1 300');
    await click(ui, y, x + 2);
    expect(pagerUp(ui)).toBe(true);
    // Over the panel, not over the plugin's side beside or above it.
    const at = rowOf(ui, '│ 101');
    expect(at).toBeGreaterThan(panelTop);
    expect(ui.backend.lastFrame.split('\n')[at]!.indexOf('│ 101')).toBeGreaterThan(panelLeft);
    await ui.press('escape');
    expect(ui.backend.lastFrame).toBe(before);
    ui.app.unmount();
  });
}

test('a turn of dozens of calls opens in the pager with every call, the trail\'s cap lifted', async () => {
  const model = new ScriptedModel();
  // One round of 36 calls: twelve of one tool, then two alternating — 24 lines
  // condensed, taller than the conversation's rows at this size.
  model.script([
    ...Array.from({ length: 12 }, () => ({ tool: 'datetime', args: {} })),
    ...Array.from({ length: 24 }, (_, i) => ({ tool: i % 2 ? 'config_schema' : 'datetime', args: {} })),
  ], [{ text: 'Done at last.' }]);
  const ui = await bootApp(model, 110, 34);
  await ui.press('F');
  await ui.type('do a lot');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Done at last.'));
  await settle(8);
  await click(ui, rowOf(ui, '36 tools:'));
  expect(pagerUp(ui)).toBe(true);
  expect(ui.backend.lastFrame).toContain('36 tool calls');
  expect(ui.backend.lastFrame).not.toContain('earlier calls');
  for (let i = 0; i < 6; i++) await ui.press('pagedown');
  expect(ui.backend.lastFrame.split('\n').filter((r) => /▸ (datetime|config_schema)/.test(r)).length).toBeGreaterThan(12);
  await ui.press('escape');
  expect(ui.backend.lastFrame).toContain('▸ 36 tools:');
  ui.app.unmount();
});
