// `/theme` picks the look: the three modes in a panel over the chat, the palette
// applied at once as the cursor moves, Esc putting back the mode the panel opened
// with, Enter keeping and saving the one applied. With an argument the command skips
// the menu. The look is read from a cell of the window's frame, as theme-mode.e2e does
// with the field's hint: a cell with no colour of its own shows the palette's ground.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { hostStateDir, resetSessionConfig, saveConfigUnset } from '../config/load';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  // The run's own settings file (a temp dir under `bun test`) is shared by every test.
  saveConfigUnset('ui.theme');
  resetSessionConfig();
});

type Ui = Awaited<ReturnType<typeof bootApp>>;
const frame = (ui: Ui) => ui.backend.lastFrame;

// The ground of the window on screen: the chat's frame, or the panel's over it.
const look = (ui: Ui): string | undefined => {
  const rows = frame(ui).split('\n');
  const y = rows.findIndex((r) => r.includes('Flow Assist'));
  expect(y).toBeGreaterThanOrEqual(0);
  return (ui.backend.lastBuffer!.get(rows[y]!.indexOf('Flow Assist'), y).style as { bg?: string }).bg;
};

const savedFile = () => path.join(hostStateDir(), 'config.local.json');
const savedTheme = (): string | undefined => {
  if (!fs.existsSync(savedFile())) return undefined;
  const saved = JSON.parse(fs.readFileSync(savedFile(), 'utf8')) as { ui?: { theme?: string } };
  return saved.ui?.theme;
};

const LIGHT = '#f4f4f6';
const DARK = 'black';
const NONE = [undefined, 'default'];

async function theme(ui: Ui, arg = '') {
  await ui.type(`/theme${arg ? ` ${arg}` : ''}`);
  await ui.press('return');
  await settle();
}

test('the theme menu previews and decides', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 30, undefined, {}, { scheme: 'unknown' });
  await ui.press('F');
  await settle();
  expect(NONE).toContain(look(ui));

  await theme(ui);
  expect(frame(ui)).toContain('Theme');
  expect(frame(ui)).toContain('system');
  expect(frame(ui)).toContain('light');
  expect(frame(ui)).toContain('dark');
  // The saved mode's row says it is the current one.
  const current = frame(ui).split('\n').find((r) => r.includes('system'))!;
  expect(current).toContain('follows the terminal');
  expect(current).toContain('current');

  // Moving the cursor previews at once; back on the mode that follows the terminal,
  // the look follows it again.
  await ui.press('down');
  await settle();
  expect(look(ui)).toBe(LIGHT);
  await ui.press('up');
  await settle();
  expect(NONE).toContain(look(ui));

  // Esc decides nothing: the look is the one the panel opened with, and nothing is
  // written.
  await ui.press('escape');
  await settle();
  expect(frame(ui)).not.toContain('Flow Assist · Theme');
  expect(NONE).toContain(look(ui));
  expect(savedTheme()).toBeUndefined();

  // Enter keeps what the cursor previewed and saves it.
  await theme(ui);
  await ui.press('down');
  await settle();
  expect(look(ui)).toBe(LIGHT);
  await ui.press('return');
  await settle();
  expect(frame(ui)).not.toContain('Flow Assist · Theme');
  expect(look(ui)).toBe(LIGHT);
  expect(frame(ui)).toContain('theme: light');
  expect(savedTheme()).toBe('light');
  ui.app.unmount();
});

test('the theme command applies its argument', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 30, undefined, {}, { scheme: 'unknown' });
  await ui.press('F');
  await settle();

  await theme(ui, 'dark');
  expect(look(ui)).toBe(DARK);
  expect(frame(ui)).toContain('theme: dark');
  expect(savedTheme()).toBe('dark');

  // A word that is not a mode changes nothing and names the three that are.
  await theme(ui, 'blue');
  expect(frame(ui)).toContain('theme: blue is not a mode');
  expect(frame(ui)).toContain('system, light, dark');
  expect(look(ui)).toBe(DARK);
  expect(savedTheme()).toBe('dark');
  ui.app.unmount();
});
