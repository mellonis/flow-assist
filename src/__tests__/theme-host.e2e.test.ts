// `ui.theme` is the whole screen's appearance, not the chat window's: the host's own
// side — the start screen, the `: ` line, the hint row — takes the palette's base
// ground and ink too. What a person sees is a cell with no colour of its own, so it
// shows what the screen gives it (the cell-style idiom of color-scheme.e2e).
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { resetSessionConfig } from '../config/load';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; resetSessionConfig(); });

type Ui = Awaited<ReturnType<typeof bootApp>>;
const NONE = [undefined, 'default'];
type Cell = { fg?: string; bg?: string };

const cell = (ui: Ui, row: string, at: string): Cell => {
  const rows = ui.backend.lastFrame.split('\n');
  const y = rows.findIndex((r) => r.includes(row));
  expect(y).toBeGreaterThanOrEqual(0);
  const x = rows[y]!.indexOf(at);
  expect(x).toBeGreaterThanOrEqual(0);
  return ui.backend.lastBuffer!.get(x, y).style as Cell;
};

// A toast (`config set` says what it set) takes the footer's row for its moment, so the
// run keeps it short.

// The start screen's own door, and the footer's hint row: both on the host's side, both
// naming no colour of their own.
const homeCell = (ui: Ui) => cell(ui, 'commands — try :help', 'commands — try :help');
const hintCell = (ui: Ui) => cell(ui, ': commands', 'commands');

async function command(ui: Ui, line: string) {
  await ui.press(':');
  await ui.type(line);
  await ui.press('return');
  await settle();
}

test('the host’s own screen takes the theme', async () => {
  const ui = await bootApp(new ScriptedModel(), 120, 40, undefined, {}, { scheme: 'unknown', toastMs: 10 });
  // The terminal has not said: no ground and no ink of the app's own.
  expect(NONE).toContain(hintCell(ui).bg);
  expect(hintCell(ui).fg).toBeUndefined();
  expect(homeCell(ui).fg).toBeUndefined();

  // A pinned mode paints the host's side at once, and the ink with it.
  await command(ui, 'config set --session ui.theme dark');
  expect(hintCell(ui)).toMatchObject({ bg: 'black', fg: 'white' });
  expect(homeCell(ui)).toMatchObject({ bg: 'black', fg: 'white' });
  await command(ui, 'config set --session ui.theme light');
  expect(hintCell(ui)).toMatchObject({ bg: '#f4f4f6', fg: 'black' });
  expect(homeCell(ui)).toMatchObject({ bg: '#f4f4f6', fg: 'black' });

  // `system` gives the terminal the say again — here it never said, so nothing is left.
  await command(ui, 'config set --session ui.theme system');
  expect(NONE).toContain(hintCell(ui).bg);
  expect(hintCell(ui).fg).toBeUndefined();
  ui.app.unmount();
});

test('the command prompt takes the palette’s border colour, not a literal', async () => {
  const ui = await bootApp(new ScriptedModel(), 120, 40, undefined, {}, { scheme: 'unknown', toastMs: 10 });
  await command(ui, 'config set --session ui.theme light');
  await ui.press(':');
  await settle();
  // The `: ` line is the last row on screen; nothing else can be mistaken for it.
  const rows = ui.backend.lastFrame.split('\n');
  let y = -1;
  rows.forEach((row, index) => { if (row.trim() !== '') y = index; });
  expect(y).toBeGreaterThanOrEqual(0);
  expect(rows[y]!.trimStart().startsWith(':')).toBe(true);
  const x = rows[y]!.indexOf(':');
  // The light palette's border is blue; the dark and unknown ones are cyan.
  expect(ui.backend.lastBuffer!.get(x, y).style.fg).toBe('blue');
  await ui.press('escape');
  ui.app.unmount();
});
