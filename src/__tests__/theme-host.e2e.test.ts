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

// A glyph of the host's own side, with no colour of its own: the hint row's words
// beside `:`, so the cell shows the ink the screen gives it.
const hostCell = (ui: Ui) => {
  const rows = ui.backend.lastFrame.split('\n');
  const y = rows.findIndex((r) => r.includes('commands — try :help'));
  expect(y).toBeGreaterThanOrEqual(0);
  const x = rows[y]!.indexOf('commands — try :help');
  return ui.backend.lastBuffer!.get(x, y).style as { fg?: string; bg?: string };
};

async function command(ui: Ui, line: string) {
  await ui.press(':');
  await ui.type(line);
  await ui.press('return');
  await settle();
}

test('the host’s own screen takes the theme', async () => {
  const ui = await bootApp(new ScriptedModel(), 120, 40, undefined, {}, { scheme: 'unknown' });
  // The terminal has not said: no ground and no ink of the app's own.
  expect(NONE).toContain(hostCell(ui).bg);
  expect(hostCell(ui).fg).toBeUndefined();

  // A pinned mode paints the host's side at once, and the ink with it.
  await command(ui, 'config set --session ui.theme dark');
  expect(hostCell(ui)).toMatchObject({ bg: 'black', fg: 'white' });
  await command(ui, 'config set --session ui.theme light');
  expect(hostCell(ui)).toMatchObject({ bg: '#f4f4f6', fg: 'black' });

  // `system` gives the terminal the say again — here it never said, so nothing is left.
  await command(ui, 'config set --session ui.theme system');
  expect(NONE).toContain(hostCell(ui).bg);
  expect(hostCell(ui).fg).toBeUndefined();
  ui.app.unmount();
});

test('the command prompt takes the palette’s border colour, not a literal', async () => {
  const ui = await bootApp(new ScriptedModel(), 120, 40, undefined, {}, { scheme: 'unknown' });
  await command(ui, 'config set --session ui.theme light');
  await ui.press(':');
  await settle();
  const rows = ui.backend.lastFrame.split('\n');
  // The LAST row that opens with `:` is the `: ` line itself — the start screen draws
  // its own `:` door above it.
  let y = -1;
  rows.forEach((row, index) => { if (row.trimStart().startsWith(':')) y = index; });
  expect(y).toBeGreaterThanOrEqual(0);
  const x = rows[y]!.indexOf(':');
  // The light palette's border is blue; the dark and unknown ones are cyan.
  expect(ui.backend.lastBuffer!.get(x, y).style.fg).toBe('blue');
  await ui.press('escape');
  ui.app.unmount();
});
