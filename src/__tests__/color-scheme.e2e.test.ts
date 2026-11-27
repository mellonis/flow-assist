// The terminal switches between light and dark while the app runs — macOS does it
// by itself at sunset and sunrise, and the terminal follows. The host's windows (and
// every palette resolved from its theme) follow it too, without a restart.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

import { nativeFetch } from './helpers/test-setup.ts';
import { hostColour } from './helpers/palette';
const realFetch = nativeFetch;
afterEach(() => { globalThis.fetch = realFetch; });

// The ground and the ink of the chat window's hint line — a cell with no colour of
// its own, so it shows what the window gives it.
const hintCell = (ui: Awaited<ReturnType<typeof bootApp>>) => {
  const rows = ui.backend.lastFrame.split('\n');
  const y = rows.findIndex((r) => r.includes('Ask anything.'));
  expect(y).toBeGreaterThanOrEqual(0);
  return ui.backend.lastBuffer!.get(rows[y]!.indexOf('Ask anything.'), y).style as { fg?: string; bg?: string };
};

test('an open chat repaints when the terminal goes from dark to light, and back', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 30);
  ui.backend.setColorScheme('dark', '#000000');
  await settle();
  await ui.press('F');
  await settle();
  expect(hintCell(ui)).toMatchObject({ bg: hostColour('dark', 'log', 'bg'), fg: hostColour('dark', 'log', 'text') });

  // Sunrise: the same window, the light palette — no restart, no key pressed.
  ui.backend.setColorScheme('light', '#ffffff');
  await settle();
  expect(hintCell(ui)).toMatchObject({ bg: hostColour('light', 'log', 'bg'), fg: hostColour('light', 'log', 'text') });

  ui.backend.setColorScheme('dark', '#000000');
  await settle();
  expect(hintCell(ui)).toMatchObject({ bg: hostColour('dark', 'log', 'bg'), fg: hostColour('dark', 'log', 'text') });
  ui.app.unmount();
});

test('until the terminal says, the windows leave the ground and the ink to it', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 30, undefined, {}, { scheme: 'unknown' });
  await ui.press('F');
  await settle();
  const cell = hintCell(ui);
  // `'default'` on a cell's ground is the terminal's own background.
  expect([undefined, 'default']).toContain(cell.bg);
  expect(cell.fg).toBeUndefined();
  ui.app.unmount();
});
