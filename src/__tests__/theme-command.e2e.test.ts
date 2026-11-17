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
  // The SAVED mode's row says it is the current one; the cursor opens there.
  const marked = () => frame(ui).split('\n').filter((r) => r.includes('current'));
  expect(marked().length).toBe(1);
  expect(marked()[0]).toContain('system');
  expect(marked()[0]).toContain('follows the terminal');

  // Moving the cursor previews at once; the mark stays on the saved row, not on the
  // previewed one.
  await ui.press('down');
  await settle();
  expect(look(ui)).toBe(LIGHT);
  expect(frame(ui)).toMatch(/› light/);
  expect(marked().length).toBe(1);
  expect(marked()[0]).toContain('system');
  // A click is a cursor move too: the row under the pointer previews.
  const rowY = (t: string) => frame(ui).split('\n').findIndex((r) => r.includes(t));
  ui.backend.mouse('down', 14, rowY('dark'));
  ui.backend.mouse('up', 14, rowY('dark'));
  await settle(6);
  expect(look(ui)).toBe(DARK);
  expect(marked()[0]).toContain('system');

  // Esc decides nothing: the look is the one the panel opened with — a mode that
  // differs from the preview — and nothing is written.
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

test('a panel that goes without a choice puts the preview back', async () => {
  // Docked, the collapse key folds the chat away while a panel is up — the panel goes
  // with it, and no key of its own was pressed.
  const ui = await bootApp(new ScriptedModel(), 120, 40, undefined, {}, { scheme: 'unknown', chatMode: 'panel' });
  await ui.press('F');
  await settle();
  await theme(ui);
  await ui.press('down');
  await settle();
  expect(look(ui)).toBe(LIGHT);

  ui.backend.press({ name: '\\', ctrl: true });
  await settle();
  expect(savedTheme()).toBeUndefined();
  // Opened again, the chat shows the mode the menu opened with, not the preview.
  await ui.press('F');
  await settle();
  expect(frame(ui)).not.toContain('Flow Assist · Theme');
  expect(NONE).toContain(look(ui));
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

  await theme(ui, 'Light');
  expect(look(ui)).toBe(LIGHT);
  expect(frame(ui)).toContain('theme: light');
  expect(savedTheme()).toBe('light');

  // A word that is not a mode changes nothing and names the three that are. (The
  // refused line keeps the field as typed, so it is cleared before the next attempt.)
  await ui.press('escape');
  await settle();
  await theme(ui, 'blue');
  expect(frame(ui)).toContain('theme: blue is not a mode');
  expect(frame(ui)).toContain('system, light, dark');
  expect(look(ui)).toBe(LIGHT);
  expect(savedTheme()).toBe('light');
  ui.app.unmount();
});
