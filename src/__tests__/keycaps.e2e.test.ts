// The keycaps panel, as someone watching the screen sees it.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('the panel draws the cap of a key, not the terminal\'s name for it', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 24);
  // `:keycaps on` — the command line, opened with the host's own binding.
  await ui.press(':');
  await ui.type('keycaps on');
  await ui.press('return');
  await settle();

  await ui.press('return', ' ', 'tab', 'up');
  ui.backend.press({ name: 'r', ctrl: true });
  await settle();
  const frame = ui.backend.lastFrame;
  for (const cap of ['⏎', '␣', '⇥', '↑', '^r']) expect(frame).toContain(cap);
  // The raw names are gone — 'return' read as a word, and ' ' was an empty cap.
  expect(frame).not.toMatch(/│ ?return ?│/);
  expect(frame).not.toMatch(/│ {3}│/);

  // The wheel is not a key and must not flush the panel.
  for (let i = 0; i < 8; i++) ui.backend.wheel('up', 5, 5);
  await settle();
  expect(ui.backend.lastFrame).toContain('⏎');
  expect(ui.backend.lastFrame).not.toContain('wheel');
  ui.app.unmount();
});
