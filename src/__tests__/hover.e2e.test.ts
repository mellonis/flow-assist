// Hover: with `ui.mouse` on and `ui.hover` (on by default), the backend reports the
// pointer moving, and what a click acts on is underlined while the pointer is over it —
// flowtty's own look for its components, so the host's rows and a plugin's pickers read
// the same. The chat's fold lines (the tool trail, a folded run of steps, a command's
// block, the thinking header), the session picker's rows and a command panel's rows.
// Nothing else changes, and a move is never a key: it redraws nothing but the row it
// enters and the row it leaves.
//
// `backend.mouse('move', x, y)` is a move with no button held; `backend.mouse('leave')`
// the pointer leaving the window.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import type { Make } from '../loader/plugin';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Ui = Awaited<ReturnType<typeof bootApp>>;
const settleUntil = async (ok: () => boolean, n = 200) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const rows = (ui: Ui) => ui.backend.lastFrame.split('\n');
// Where a piece of text is drawn: its first cell.
function at(ui: Ui, needle: string): { x: number; y: number } {
  const r = rows(ui);
  const y = r.findIndex((l) => l.includes(needle));
  if (y < 0) throw new Error(`"${needle}" is not on screen:\n${ui.backend.lastFrame}`);
  return { x: r[y]!.indexOf(needle), y };
}
type Style = { dim?: boolean; underline?: boolean; bold?: boolean; fg?: string };
const style = (ui: Ui, p: { x: number; y: number }) => ui.backend.lastBuffer!.get(p.x, p.y).style as Style;
const move = async (ui: Ui, p: { x: number; y: number }) => { ui.backend.mouse('move', p.x, p.y); await settle(); };

// A turn with one tool call behind its `▸ 1 tool: datetime` line, then an answer.
async function oneTurn(extra: Record<string, unknown> = {}, guests?: (make: Make) => never[]) {
  const model = new ScriptedModel();
  model.script([{ tool: 'datetime', args: {} }], [{ text: 'It is Tuesday.' }]);
  const ui = await bootApp(model, 100, 30, guests, extra);
  await ui.press('F');
  await ui.type('what day is it?');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('It is Tuesday.'));
  await settle(6);
  return ui;
}

test('a fold line under the pointer is underlined, and nothing else is; moving off or leaving the window takes it back', async () => {
  const ui = await oneTurn();
  const trail = at(ui, '1 tool: datetime');
  const answer = at(ui, 'It is Tuesday.');
  const question = at(ui, 'what day is it?');
  const trailBefore = style(ui, trail);
  const answerBefore = style(ui, answer);
  expect(trailBefore.underline).toBeFalsy();
  expect(trailBefore.dim).toBe(true);
  await move(ui, { x: trail.x + 3, y: trail.y });
  expect(style(ui, trail).underline).toBe(true);
  // Still the chat's chrome: only the underline is added.
  expect(style(ui, trail).dim).toBe(true);
  // The answer and the question are not clickable: under the pointer they never change.
  await move(ui, answer);
  expect(style(ui, trail).underline).toBeFalsy();
  expect(style(ui, answer)).toEqual(answerBefore);
  const questionBefore = style(ui, question);
  await move(ui, question);
  expect(style(ui, question)).toEqual(questionBefore);
  // Back on the fold line, then out of the window.
  await move(ui, trail);
  expect(style(ui, trail).underline).toBe(true);
  ui.backend.mouse('leave');
  await settle();
  expect(style(ui, trail).underline).toBeFalsy();
  ui.app.unmount();
});

test('ui.hover false, or the mouse off, leaves every row as it is', async () => {
  for (const ui of [{ hover: false }, { mouse: false }]) {
    const app = await oneTurn({ ui });
    const trail = at(app, '1 tool: datetime');
    const before = style(app, trail);
    await move(app, trail);
    expect(style(app, trail)).toEqual(before);
    app.app.unmount();
  }
});

test('a command block\'s line is a fold line too; the pager\'s rows, which fold nothing, are not', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ text: 'Next: count.' }, { tool: 'run_command', args: { command: 'seq 1 300' } }],
    [{ text: 'Done counting.' }],
  );
  const ui = await bootApp(model, 100, 28, undefined, { shell: { timeoutMs: 20000 } });
  await ui.press('F');
  await ui.type('count');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
  await ui.press('y');
  await settleUntil(() => ui.backend.lastFrame.includes('Done counting.'));
  await settle(8);
  const block = at(ui, 'seq 1 300 ·');
  await move(ui, block);
  expect(style(ui, block).underline).toBe(true);
  // A click on it opens it in the pager (it is taller than the conversation): its rows
  // are drawn by the same renderer and are never underlined.
  ui.backend.mouse('down', block.x, block.y);
  ui.backend.mouse('up', block.x, block.y);
  await settle(6);
  expect(ui.backend.lastFrame).toContain('PgUp/PgDn or the wheel scroll');
  const head = at(ui, '! seq 1 300');
  const line = { x: head.x + 2, y: head.y };
  await move(ui, line);
  expect(style(ui, line).underline).toBeFalsy();
  const output = at(ui, '105');
  await move(ui, output);
  expect(style(ui, output).underline).toBeFalsy();
  ui.app.unmount();
});

test('the thinking header and a folded run of steps are fold lines', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ thinking: 'The date first.', signature: 's' }, { text: 'Next: check the clock.' }, { tool: 'datetime', args: {} }],
    [{ text: 'It is Tuesday.' }],
  );
  const ui = await bootApp(model, 100, 30);
  await ui.press('F');
  await ui.type('what day is it?');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('It is Tuesday.'));
  await settle(6);
  for (const needle of ['▸ thinking', 'check the clock']) {
    const p = at(ui, needle);
    expect(style(ui, p).underline).toBeFalsy();
    await move(ui, p);
    expect(style(ui, p).underline).toBe(true);
  }
  ui.app.unmount();
});

test('a move is never a key: it redraws no plugin, disarms no Esc, answers no y/n, and a click with a move inside its cell is still a click', async () => {
  let drawn = 0;
  const guest = (make: Make) => [make('boards', {
    name: 'boards',
    keycaps: () => ['c card'],
    components: { view: (api: any) => function View() { drawn += 1; return api.ui.h(api.ui.Text, null, 'BOARD-SURFACE'); } },
  } as never)] as never[];
  const model = new ScriptedModel();
  model.script([{ tool: 'datetime', args: {} }], [{ text: 'It is Tuesday.' }], [{ tool: 'run_command', args: { command: 'true' } }], [{ text: 'ok' }]);
  const ui = await bootApp(model, 160, 40, guest, {}, { chatMode: 'panel' });
  await ui.press('F');
  await ui.type('what day is it?');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('It is Tuesday.'));
  await settle(6);
  const trail = at(ui, '1 tool: datetime');
  const before = drawn;
  for (let x = 0; x < 150; x += 7) ui.backend.mouse('move', x, (x % 30) + 2);
  await move(ui, trail);
  await settle(4);
  expect(drawn).toBe(before);
  // Esc armed in an empty field stays armed through a move.
  await ui.press('escape');
  expect(ui.backend.lastFrame).toContain('again to collapse');
  await move(ui, { x: trail.x + 1, y: trail.y });
  expect(ui.backend.lastFrame).toContain('again to collapse');
  await settle(4);
  // A press, a move inside the same cell, a release: the block opens.
  ui.backend.mouse('down', trail.x, trail.y);
  ui.backend.mouse('move', trail.x, trail.y);
  ui.backend.mouse('up', trail.x, trail.y);
  await settle(6);
  expect(ui.backend.lastFrame).toMatch(/▾ 1 tool/);
  // A y/n waits through any number of moves.
  await ui.type('run it');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
  for (let x = 0; x < 150; x += 9) ui.backend.mouse('move', x, 20);
  ui.backend.mouse('leave');
  await settle(4);
  expect(ui.backend.lastFrame).toContain('Confirm write: run_command');
  ui.app.unmount();
});

test('the session picker\'s rows: the one under the pointer is underlined, and a click puts the cursor there', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-hover-picker-'));
  const model = new ScriptedModel();
  model.script([{ text: 'alpha answer' }], [{ text: 'beta answer' }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } });
  await ui.press('F');
  for (const q of ['alpha question', 'beta question']) {
    await ui.type(q);
    await ui.press('return');
    await settle(20);
    if (q === 'alpha question') { await ui.type('/new'); await ui.press('return'); await settle(4); }
  }
  await ui.type('/sessions');
  await ui.press('return');
  await settle(4);
  expect(ui.backend.lastFrame).toContain('Sessions · 2');
  const cursorOn = (title: string) => rows(ui).find((l) => l.includes(title))!.includes(`› ${title}`);
  expect(cursorOn('beta question')).toBe(true);
  const alpha = at(ui, 'alpha question');
  expect(style(ui, alpha).underline).toBeFalsy();
  await move(ui, alpha);
  expect(style(ui, alpha).underline).toBe(true);
  expect(style(ui, at(ui, 'beta question')).underline).toBeFalsy();
  ui.backend.mouse('down', alpha.x, alpha.y);
  ui.backend.mouse('up', alpha.x, alpha.y);
  await settle(4);
  // The cursor moved; nothing was opened — ⏎ still does that.
  expect(cursorOn('alpha question')).toBe(true);
  expect(ui.backend.lastFrame).toContain('Sessions · 2');
  ui.app.unmount();
});

test('a command panel\'s rows: the one under the pointer is underlined, and a click puts the cursor there', async () => {
  const guest = (make: Make) => [make('srv', {
    name: 'srv',
    commands: [{
      name: 'srv', description: 'The servers', chat: true,
      run: (ctx: any) => ctx.openPanel({
        title: 'Servers',
        rows: () => [{ id: 'webstorm', text: 'webstorm', detail: 'connected' }, { id: 'safari', text: 'safari', detail: 'failed', tone: 'error' }],
        keys: [],
      }),
    }],
  } as never)] as never[];
  const ui = await bootApp(new ScriptedModel(), 110, 30, guest);
  await ui.press('F');
  await ui.type('/srv');
  await ui.press('return');
  await settle(4);
  expect(ui.backend.lastFrame).toContain('Servers');
  const cursorOn = (text: string) => rows(ui).find((l) => l.includes(text))!.includes(`› ${text}`);
  expect(cursorOn('webstorm')).toBe(true);
  const safari = at(ui, 'safari');
  await move(ui, safari);
  expect(style(ui, safari).underline).toBe(true);
  expect(style(ui, at(ui, 'webstorm')).underline).toBeFalsy();
  ui.backend.mouse('down', safari.x, safari.y);
  ui.backend.mouse('up', safari.x, safari.y);
  await settle(4);
  expect(cursorOn('safari')).toBe(true);
  ui.app.unmount();
});
