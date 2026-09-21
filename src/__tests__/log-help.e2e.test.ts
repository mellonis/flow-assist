// The log and the help, as a person meets them.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const footer = (ui: { backend: { lastFrame: string } }) => ui.backend.lastFrame.split('\n').filter((r) => r.trim()).at(-1) ?? '';

test('the footer says `L` opens the log — and stops saying it while the log is open', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 26);
  // The key opened the log and nothing on screen said so.
  expect(footer(ui)).toContain('L log');
  await ui.press('L');
  expect(ui.backend.lastFrame).toContain('╭─ Log');
  expect(footer(ui)).not.toContain('L log');
  // The key that opened it closes it too.
  await ui.press('L');
  expect(ui.backend.lastFrame).not.toContain('╭─ Log');
  await ui.press('L');
  await ui.press('escape');
  expect(ui.backend.lastFrame).not.toContain('╭─ Log');
  expect(footer(ui)).toContain('L log');
  ui.app.unmount();
});

test('what happened is in the log, with the time it happened', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'hello' }]);
  const ui = await bootApp(model, 100, 26);
  await ui.press(':');
  await ui.type('ask hi');
  await ui.press('return');
  await settle(16);
  await ui.press('escape', 'escape');
  await ui.press('L');
  expect(ui.backend.lastFrame).toMatch(/\d\d:\d\d:\d\d \[chat\]/);
  ui.app.unmount();
});

test(':help shows keys and commands, inside the screen, each command once', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 22);
  await ui.press(':');
  await ui.type('help');
  await ui.press('return');
  await settle();
  const frame = ui.backend.lastFrame;
  const rows = frame.split('\n');
  // It used to be taller than the terminal, with its title cut off the top.
  expect(rows.some((r) => r.includes('╭─ Help'))).toBe(true);
  expect(frame).toContain('Keys — anywhere');
  expect(frame).toMatch(/F\s+talk to the assistant/);
  // The host's commands were listed twice, the second time as "undefined".
  expect(frame).not.toContain('undefined');
  // …and `view` / `back`, which did nothing, are gone from it.
  expect(frame).not.toMatch(/^\s*│\s+(view|back)\b/m);
  // PgDn reaches what is below the frame.
  expect(frame).not.toContain('keycaps [on|off]');
  await ui.press('pagedown');
  await ui.press('pagedown');
  expect(ui.backend.lastFrame).toContain('keycaps [on|off]');
  await ui.press('escape');
  expect(ui.backend.lastFrame).not.toContain('╭─ Help');
  ui.app.unmount();
});
