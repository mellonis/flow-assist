// `ui.theme` pins the appearance: `light` and `dark` keep their palette whatever the
// terminal says, `system` (the default) follows the terminal's own scheme again. What a
// person sees is the chat window's ground and ink — a cell with no colour of its own, so
// it shows what the window gives it (the cell-style idiom of color-scheme.e2e.test.ts).
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { resetSessionConfig } from '../config/load';

import { nativeFetch } from './helpers/test-setup.ts';
const realFetch = nativeFetch;
afterEach(() => { globalThis.fetch = realFetch; resetSessionConfig(); });

const hintCell = (ui: Awaited<ReturnType<typeof bootApp>>) => {
  const rows = ui.backend.lastFrame.split('\n');
  const y = rows.findIndex((r) => r.includes('Ask anything.'));
  expect(y).toBeGreaterThanOrEqual(0);
  return ui.backend.lastBuffer!.get(rows[y]!.indexOf('Ask anything.'), y).style as { fg?: string; bg?: string };
};

async function command(ui: Awaited<ReturnType<typeof bootApp>>, line: string) {
  await ui.press(':');
  await ui.type(line);
  await ui.press('return');
  await settle();
}

const LIGHT = { bg: '#f4f4f6', fg: 'black' };
const DARK = { bg: 'black', fg: 'white' };
const NONE = [undefined, 'default'];

test('a pinned scheme survives a terminal flip', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 30, undefined, {}, { scheme: 'unknown' });
  await ui.press('F');
  await settle();
  // The terminal has not said: no ground of the app's own.
  expect(NONE).toContain(hintCell(ui).bg);

  ui.services.setThemeMode('light');
  await settle();
  expect(hintCell(ui)).toMatchObject(LIGHT);

  // The terminal goes dark (macOS at sunset): the pinned palette stays.
  ui.backend.setColorScheme('dark', '#000000');
  await settle();
  expect(hintCell(ui)).toMatchObject(LIGHT);

  // `system` gives the terminal the say again — its present scheme, then its next.
  ui.services.setThemeMode('system');
  await settle();
  expect(hintCell(ui)).toMatchObject(DARK);
  ui.backend.setColorScheme('light', '#ffffff');
  await settle();
  expect(hintCell(ui)).toMatchObject(LIGHT);
  ui.app.unmount();
});

test('ui.theme set while the app runs repaints at once, and unsetting it follows the terminal again', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 30);
  // The chat is closed, so the `:` line is the host's — as `config set` is typed.
  await command(ui, 'config set --session ui.theme light');
  await ui.press('F');
  await settle();
  expect(hintCell(ui)).toMatchObject(LIGHT);

  // The terminal goes both ways: the pinned palette holds.
  ui.backend.setColorScheme('light', '#ffffff');
  await settle();
  ui.backend.setColorScheme('dark', '#000000');
  await settle();
  expect(hintCell(ui)).toMatchObject(LIGHT);

  await ui.press('escape', 'escape');
  await settle();
  await command(ui, 'config unset --session ui.theme');
  await ui.press('F');
  await settle();
  expect(hintCell(ui)).toMatchObject(DARK);
  ui.app.unmount();
});

test('/theme is gone — the look is a config key', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 30, undefined, {}, { scheme: 'unknown' });
  await ui.press('F');
  await settle();
  await ui.type('/theme dark');
  await ui.press('return');
  await settle();
  // The chat says the command is not there, and the list it names does not offer it.
  expect(ui.backend.lastFrame).toContain('unknown command /theme');
  expect(ui.backend.lastFrame).not.toContain('/theme,');
  // Nothing was applied by the refused line: the terminal still has the say.
  expect(NONE).toContain(hintCell(ui).bg);
  ui.app.unmount();
});
