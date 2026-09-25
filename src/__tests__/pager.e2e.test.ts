// A block taller than the conversation opens in a pager, not into the conversation.
//
// A build's output or a turn of dozens of calls opened inline pushes the rest of the
// conversation out of reach: the person scrolls through hundreds of rows to get back
// to what was said. A pager shows that block alone, with its own scroll, in the
// conversation's place inside the chat's own frame; closing it leaves the conversation
// exactly where it was.
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
// Where the chat's frame starts: the row and column of its top-left corner.
function corner(frame: string): { row: number; col: number } {
  const lines = frame.split('\n');
  const row = lines.findIndex((l) => l.includes('╭─ ƒ Flow Assist'));
  if (row < 0) throw new Error(`no chat frame on screen:\n${frame}`);
  return { row, col: lines[row]!.indexOf('╭─ ƒ Flow Assist') };
}
// A drag over the pager's first rows, from the output's bar — what it copies.
async function dragFrom101(ui: Ui, rows: number) {
  const from = rowOf(ui, '│ 101');
  const x = ui.backend.lastFrame.split('\n')[from]!.indexOf('│ 101');
  ui.backend.mouse('down', x, from);
  ui.backend.mouse('drag', x + 26, from + rows);
  ui.backend.mouse('up', x + 26, from + rows);
  await settle(6);
  return ui.backend.clipboard.join('');
}

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
  // The fold line says how much there is to read: a view keeps the last 200 lines of
  // what was printed, and says so.
  expect(ui.backend.lastFrame).toMatch(/seq 1 300 · ✓ \d+\.\d s · last 200 of 300 lines/);
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
  const copied = await dragFrom101(ui, 2);
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

// The pager is drawn inside the chat's own frame, in the conversation's place: docked,
// the plugin's screen stays in view beside it — on the right from 120 columns, at the
// bottom below that.
for (const [side, cols, rows] of [['right', 140, 30], ['bottom', 100, 44]] as const) {
  test(`in a ${side} panel the pager opens inside the panel, the plugin's screen beside it, and Esc gives the conversation back`, async () => {
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
    const panel = corner(before);
    const y = rowOf(ui, 'seq 1 300 ·');
    const x = before.split('\n')[y]!.indexOf('seq 1 300');
    await click(ui, y, x + 2);
    expect(pagerUp(ui)).toBe(true);
    // The chat's own frame, where the panel was, titled by the block — and the field
    // not drawn while the pager is up.
    const frame = ui.backend.lastFrame;
    expect(corner(frame)).toEqual(panel);
    expect(frame.split('\n')[panel.row]).toContain('Flow Assist · seq 1 300');
    expect(frame).toContain('│ 101');
    expect(frame).not.toContain('Done counting.');
    expect(before).toContain('new line');
    expect(frame).not.toContain('new line');
    // The plugin's side is still on screen, beside or above the panel.
    expect(frame).toContain('an assistant in your terminal');
    expect(frame).toContain(': commands');
    await ui.press('escape');
    expect(ui.backend.lastFrame).toBe(before);
    // A press on the plugin's side hands it the keys, as it always does — and the pager
    // stays, as the picker does: PgDn, Esc and the wheel over it are not the chat's now,
    // and move neither the pager nor the conversation it stands in for.
    await click(ui, y, x + 2);
    const live = ui.backend.lastFrame;
    const plugin = rowOf(ui, 'an assistant in your terminal');
    await click(ui, plugin, ui.backend.lastFrame.split('\n')[plugin]!.indexOf('an assistant') + 2);
    expect(pagerUp(ui)).toBe(true);
    const idle = ui.backend.lastFrame;
    await ui.press('pagedown');
    await ui.press('escape');
    ui.backend.wheel('down', x + 2, rowOf(ui, '│ 105'));
    await settle(4);
    expect(ui.backend.lastFrame).toBe(idle);
    // A press back inside the panel gives the chat its keys and the pager as it was.
    await click(ui, rowOf(ui, '│ 105'), x + 2);
    expect(ui.backend.lastFrame).toBe(live);
    await ui.press('escape');
    expect(ui.backend.lastFrame).toBe(before);
    // A drag inside the pager copies its text and leaves it up.
    await click(ui, y, x + 2);
    expect(await dragFrom101(ui, 1)).toContain('101\n102');
    expect(pagerUp(ui)).toBe(true);
    ui.app.unmount();
  });
}

test('with the chat taking the whole terminal, the pager fills it — the chat\'s frame does', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'run_command', args: { command: 'seq 1 300' } }], [{ text: 'Done counting.' }]);
  const cols = 100;
  const ui = await bootApp(model, cols, 30, undefined, { shell: { timeoutMs: 20000 } }, { chatMode: 'full' });
  await ui.press('F');
  await ui.type('count');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
  await ui.press('y');
  await settleUntil(() => ui.backend.lastFrame.includes('Done counting.'));
  await settle(8);
  const before = ui.backend.lastFrame;
  await click(ui, rowOf(ui, 'seq 1 300 ·'), before.split('\n')[rowOf(ui, 'seq 1 300 ·')]!.indexOf('seq 1 300') + 2);
  expect(pagerUp(ui)).toBe(true);
  const lines = ui.backend.lastFrame.split('\n');
  expect(lines[0]!.startsWith('╭─ ƒ Flow Assist · seq 1 300')).toBe(true);
  expect(lines[0]!.trimEnd()).toHaveLength(cols);
  await ui.press('escape');
  expect(ui.backend.lastFrame).toBe(before);
  ui.app.unmount();
});

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

test('a y/n arriving while the pager is up closes it and is answered; while it waits a click opens no pager', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'run_command', args: { command: 'seq 1 300' } }],
    [{ text: 'Done counting.' }],
    [{ hold: true }, { tool: 'run_command', args: { command: 'echo hi' } }],
    [{ text: 'Declined, fine.' }],
  );
  const ui = await bootApp(model, 100, 24, undefined, { shell: { timeoutMs: 20000 } });
  await ui.press('F');
  await ui.type('count');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
  await ui.press('y');
  await settleUntil(() => ui.backend.lastFrame.includes('Done counting.'));
  await ui.type('say hi');
  await ui.press('return');
  await settle(8);
  // The turn is held; the block is up the list.
  for (let i = 0; i < 6 && !ui.backend.lastFrame.includes('seq 1 300 ·'); i++) await ui.press('pageup');
  await click(ui, rowOf(ui, 'seq 1 300 ·'));
  expect(pagerUp(ui)).toBe(true);
  // The y/n arrives: the pager goes, and the question is on screen and answerable.
  model.release();
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
  expect(pagerUp(ui)).toBe(false);
  // While it waits, a click on the tall block opens it inline, never a pager over it.
  for (let i = 0; i < 6 && !ui.backend.lastFrame.includes('seq 1 300 ·'); i++) await ui.press('pageup');
  await click(ui, rowOf(ui, 'seq 1 300 ·'));
  expect(pagerUp(ui)).toBe(false);
  expect(ui.backend.lastFrame).toContain('Confirm write: run_command');
  const asked = model.requests.length;
  await ui.press('n');
  await settleUntil(() => ui.backend.lastFrame.includes('Declined, fine.'));
  expect(model.requests.length).toBe(asked + 1);
  ui.app.unmount();
});

test('a long reasoning opens in the pager titled thinking, reads to its end, and Esc gives the conversation back', async () => {
  const model = new ScriptedModel();
  const thought = Array.from({ length: 60 }, (_, i) => `thought ${i + 1}`).join('\n\n');
  model.script([{ thinking: thought, signature: 'sig' }, { text: 'Thought it through.' }]);
  const ui = await bootApp(model, 100, 24);
  await ui.press('F');
  await ui.type('think');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Thought it through.'));
  await settle(8);
  const before = ui.backend.lastFrame;
  const window = corner(before);
  await click(ui, rowOf(ui, '▸ thinking'));
  expect(pagerUp(ui)).toBe(true);
  // In the chat's own window, where the conversation was, titled by the block.
  expect(corner(ui.backend.lastFrame)).toEqual(window);
  expect(ui.backend.lastFrame.split('\n')[window.row]).toContain('Flow Assist · thinking');
  expect(ui.backend.lastFrame).toContain('thought 1');
  expect(ui.backend.lastFrame).not.toContain('thought 60');
  for (let i = 0; i < 20; i++) await ui.press('pagedown');
  expect(ui.backend.lastFrame).toContain('thought 60');
  await ui.press('escape');
  expect(ui.backend.lastFrame).toBe(before);
  ui.app.unmount();
});

// The conversation is held, not drawn, under the pager: what arrives while it is up is
// there when the pager closes, and the list is where it would have been had it been on
// screen — a long answer anchored at its first line if it was following, on the same
// rows if it was scrolled up.
const LATE = Array.from({ length: 8 }, (_, i) => `Late line ${i + 1}.`).join('\n\n');
test('a long answer arriving while the pager is up: Esc shows it anchored at its first line', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'run_command', args: { command: 'seq 1 300' } }],
    [{ text: 'Done counting.' }],
    [{ hold: true }, { text: LATE }],
  );
  const ui = await bootApp(model, 100, 24, undefined, { shell: { timeoutMs: 20000 } });
  await ui.press('F');
  await ui.type('count');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
  await ui.press('y');
  await settleUntil(() => ui.backend.lastFrame.includes('Done counting.'));
  await ui.type('go on');
  await ui.press('return');
  await settle(8);
  // At the end of the list, the block in view, the turn held.
  await click(ui, rowOf(ui, 'seq 1 300 ·'));
  expect(pagerUp(ui)).toBe(true);
  model.release();
  await settle(20);
  expect(pagerUp(ui)).toBe(true);
  expect(ui.backend.lastFrame).not.toContain('Late line');
  await ui.press('escape');
  expect(pagerUp(ui)).toBe(false);
  // The answer's first line is the row under the pinned question; the rest is below.
  const lines = ui.backend.lastFrame.split('\n');
  const pin = lines.findIndex((l) => l.includes('› go on'));
  expect(pin).toBeGreaterThanOrEqual(0);
  expect(lines[pin + 1]).toContain('Late line 1.');
  expect(ui.backend.lastFrame).not.toContain('Late line 8.');
  await ui.press('pagedown');
  expect(ui.backend.lastFrame).toContain('Late line 8.');
  ui.app.unmount();
});

test('an answer arriving while the pager is up over a list scrolled up: Esc gives back the same rows', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'run_command', args: { command: 'seq 1 300' } }],
    [{ text: 'Done counting.' }],
    [{ text: TAIL }],
    [{ hold: true }, { text: LATE }],
  );
  const ui = await bootApp(model, 100, 24, undefined, { shell: { timeoutMs: 20000 } });
  await ui.press('F');
  await ui.type('count');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
  await ui.press('y');
  await settleUntil(() => ui.backend.lastFrame.includes('Done counting.'));
  await ui.type('and remark on it');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Remark number 12.'));
  await ui.type('go on');
  await ui.press('return');
  await settle(8);
  for (let i = 0; i < 8 && !ui.backend.lastFrame.includes('seq 1 300 ·'); i++) await ui.press('pageup');
  const y = rowOf(ui, 'seq 1 300 ·');
  const lines = ui.backend.lastFrame.split('\n');
  const top = corner(ui.backend.lastFrame).row + 2;
  const shown = lines.slice(top, y + 1);
  await click(ui, y);
  expect(pagerUp(ui)).toBe(true);
  model.release();
  await settle(20);
  await ui.press('escape');
  expect(pagerUp(ui)).toBe(false);
  // The same rows, from the list's top down to the block's fold line.
  expect(rowOf(ui, 'seq 1 300 ·')).toBe(y);
  expect(ui.backend.lastFrame.split('\n').slice(top, y + 1)).toEqual(shown);
  expect(ui.backend.lastFrame).not.toContain('Late line 8.');
  // The answer is there, under the rows in view.
  for (let i = 0; i < 20 && !ui.backend.lastFrame.includes('Late line 8.'); i++) await ui.press('pagedown');
  expect(ui.backend.lastFrame).toContain('Late line 8.');
  ui.app.unmount();
});
