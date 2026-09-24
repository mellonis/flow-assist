// The `:` command line, as a person uses it.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const lastRow = (ui: { backend: { lastFrame: string } }) => ui.backend.lastFrame.split('\n').filter((r) => r.trim()).at(-1) ?? '';

test(':ask <text> opens the chat and sends the text', async () => {
  // A command is its FIRST WORD. Looking up the whole line instead would fail to
  // find any plugin command given an argument, and nothing would happen.
  const model = new ScriptedModel();
  model.script([{ text: 'hello there' }]);
  const ui = await bootApp(model, 100, 24);
  await ui.press(':');
  await ui.type('ask hi');
  await ui.press('return');
  await settle(20);
  expect(model.requests).toHaveLength(1);
  expect(model.requests[0]!.messages.at(-1)).toMatchObject({ role: 'user', content: 'hi' });
  expect(ui.backend.lastFrame).toContain('› hi');
  expect(ui.backend.lastFrame).toContain('hello there');
  ui.app.unmount();
});

test('a plugin command gets its argument, whatever the plugin', async () => {
  const got: string[] = [];
  const guests = (make: any) => [make('boards', {
    name: 'boards',
    commands: [{ name: 'open', run: (_ctx: unknown, arg: string) => { got.push(arg); }, usage: 'open <key>', minArgs: 1, maxArgs: -1, description: 'Open a card' }],
  })];
  const ui = await bootApp(new ScriptedModel(), 100, 24, guests);
  await ui.press(':');
  await ui.type('open ATLAS-12 now');
  await ui.press('return');
  expect(got).toEqual(['ATLAS-12 now']);
  ui.app.unmount();
});

test('an unknown command is answered, not swallowed', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 24);
  await ui.press(':');
  await ui.type('hepl');
  await ui.press('return');
  expect(lastRow(ui)).toContain('Unknown command: hepl');
  ui.app.unmount();
});

test('completion is inline and the screen does not jump while typing', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 24);
  const rowsOf = () => ui.backend.lastFrame.split('\n');
  await ui.press(':');
  // The command line is the bottom row; the start screen has a `:  commands` row too.
  // (An empty line is just `:` — the frame's rows carry no trailing spaces.)
  const lineY = () => rowsOf().findLastIndex((r) => /^\s*:(\s|$)/.test(r));
  const y0 = lineY();
  const logoY0 = rowsOf().findIndex((r) => r.includes('╭──╮'));
  await ui.type('he');
  // The rest of `help` is ON the line; no second row of candidates appeared…
  expect(rowsOf()[lineY()]).toContain(': help');
  // …so neither the line nor anything above it moved.
  expect(lineY()).toBe(y0);
  expect(rowsOf().findIndex((r) => r.includes('╭──╮'))).toBe(logoY0);
  // Tab takes it.
  await ui.press('tab');
  expect(rowsOf()[lineY()]).toContain(': help');
  await ui.press('return');
  await settle();
  expect(ui.backend.lastFrame).toMatch(/help|commands/i);
  ui.app.unmount();
});
