// `/fullscreen`: the chat takes the whole terminal — no margins, over the title bar
// and the footer — instead of a centred window; `off` brings the window back, and
// config.plugins.assistant.fullscreen starts it that way.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const W = 80;
const H = 24;
// The window's corners: its top row and bottom row, and how far in from the left.
const frame = (ui: Awaited<ReturnType<typeof bootApp>>) => {
  const rows = ui.backend.lastFrame.split('\n');
  const top = rows.findIndex((r) => r.includes('╭─ ƒ Flow Assist'));
  const bottom = rows.findLastIndex((r) => /╰─+╯/.test(r));
  return { top, bottom, left: top >= 0 ? rows[top]!.indexOf('╭') : -1, width: top >= 0 ? rows[top]!.trimEnd().length - rows[top]!.indexOf('╭') : 0 };
};
const command = async (ui: Awaited<ReturnType<typeof bootApp>>, text: string) => {
  await ui.type(text);
  await ui.press('return');
  await settle();
};

test('/fullscreen takes the whole terminal, and /fullscreen off gives the window back', async () => {
  const ui = await bootApp(new ScriptedModel(), W, H);
  await ui.press('F');
  await settle();
  const windowed = frame(ui);
  expect(windowed.top).toBeGreaterThan(0);
  expect(windowed.left).toBeGreaterThan(0);

  await command(ui, '/fullscreen');
  expect(frame(ui)).toEqual({ top: 0, bottom: H - 1, left: 0, width: W });
  // The window covers the footer too.
  expect(ui.backend.lastFrame).not.toContain(': commands');

  await command(ui, '/fullscreen off');
  expect(frame(ui)).toEqual(windowed);
  ui.app.unmount();
});

test('config.plugins.assistant.fullscreen opens the chat full screen — over a guest\'s screen too', async () => {
  // A guest with a screen of its own: the content area starts under a taller title bar.
  const guest = (make: any) => [make('boards', {
    name: 'boards',
    keycaps: () => ['c board'],
    components: { view: (ft: any) => function View() { return ft.h(ft.Text, null, 'BOARD'); } },
  })];
  const ui = await bootApp(new ScriptedModel(), W, H, guest, { plugins: { assistant: { fullscreen: true } } });
  expect(ui.backend.lastFrame).toContain('BOARD');
  await ui.press('F');
  await settle();
  expect(frame(ui)).toEqual({ top: 0, bottom: H - 1, left: 0, width: W });
  ui.app.unmount();
});
