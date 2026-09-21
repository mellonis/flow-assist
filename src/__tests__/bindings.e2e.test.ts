// A key acts where it is shown, and is shown where it acts.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const footer = (ui: { backend: { lastFrame: string } }) => ui.backend.lastFrame.split('\n').filter((r) => r.trim()).at(-1) ?? '';

// A guest that keeps data in the cache and is active while `state.open`.
const cachingGuest = (state: { open: boolean }) => (make: any) => [make('boards', {
  name: 'boards',
  keys: { boardPicker: 'c' },
  keycaps: () => (state.open ? ['c board'] : []),
  components: {
    furniture: (ft: any) => function Furniture() {
      ft.useInputHandler({ mode: 'consume', priority: () => 10, handler: (key: { name: string }) => { if (key.name === 'c') { state.open = !state.open; ft.notify(); return true; } return false; } });
      return null;
    },
    view: (ft: any) => function View() { return ft.h(ft.Text, null, 'BOARD'); },
  },
})];

test('x flushes the cache only while the footer offers it', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 24, cachingGuest({ open: false }));
  // The start screen: no plugin with a cache is on screen, the hint is absent…
  expect(footer(ui)).not.toContain('flush cache');
  await ui.press('x');
  await settle();
  // …and so the key does nothing. It used to answer "cache cleared" from here.
  expect(ui.backend.lastFrame).not.toMatch(/cache cleared/i);

  await ui.press('c'); // the guest becomes active
  expect(footer(ui)).toContain('x flush cache');
  await ui.press('x');
  await settle();
  expect(ui.backend.lastFrame).toMatch(/Cache cleared/);
  ui.app.unmount();
});

test(':clear works from anywhere — the command is not contextual', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 24);
  await ui.press(':');
  await ui.type('clear');
  await ui.press('return');
  expect(ui.backend.lastFrame).toMatch(/Cache cleared/);
  ui.app.unmount();
});

test('b is a plugin\'s key: the host does not answer it with a message about nothing', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 24);
  const before = ui.backend.lastFrame;
  await ui.press('b');
  await settle();
  expect(ui.backend.lastFrame).toBe(before);
  ui.app.unmount();
});

test('every key the footer names does something, and nothing else is bound on the start screen', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 24);
  // Named in the footer: `:`, `F`, `L`. Each changes the screen (q is not pressed).
  for (const [key, shows] of [[':', ': '], ['F', 'ƒ Flow Assist'], ['L', '╭─ Log']] as const) {
    expect(footer(ui)).toContain(`${key} `);
    await ui.press(key);
    expect(ui.backend.lastFrame).toContain(shows);
    await ui.press('escape', 'escape');
  }
  // The rest of the keyboard is silent here: no letter does something unannounced.
  const resting = ui.backend.lastFrame;
  // Lower case is free for what is INSIDE a screen; capitals open screens.
  for (const key of 'bcdefghijklmnoprstuvwxyz'.split('')) {
    await ui.press(key);
    expect(ui.backend.lastFrame).toBe(resting);
  }
  ui.app.unmount();
});

test('x flushes the cache AND what is on screen is loaded again', async () => {
  // A flush that leaves the open board as it was reads as a key that does nothing.
  // The host counts flushes (`services.cacheEpoch`); a plugin watches the number.
  const guests = (make: any) => [make('boards', {
    name: 'boards',
    keycaps: () => ['c board'],
    components: {
      view: (ft: any) => function View() {
        const [loads, setLoads] = ft.useState(0);
        const epoch = (ft.services as { cacheEpoch: number }).cacheEpoch;
        ft.useEffect(() => { setLoads((n: number) => n + 1); }, [epoch]);
        return ft.h(ft.Text, null, `board loaded ${loads}×`);
      },
    },
  })];
  const ui = await bootApp(new ScriptedModel(), 100, 24, guests);
  await settle();
  expect(ui.backend.lastFrame).toContain('board loaded 1×');
  await ui.press('x');
  await settle();
  expect(ui.backend.lastFrame).toMatch(/Cache cleared/);
  expect(ui.backend.lastFrame).toContain('board loaded 2×');
  ui.app.unmount();
});
