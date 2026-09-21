// The start screen, and whose screen it is.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { LOGO } from '../views/home';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// A guest with a screen of its own, shaped like the tracker: a `view` surface that
// draws even when it has nothing to show, furniture that is always mounted, and
// `keycaps` that is [] until the person opens something.
const guest = (state: { open: boolean }) => (make: any) => [make('boards', {
  name: 'boards',
  keys: { boardPicker: 'c' },
  surface: 'board',
  keycaps: () => (state.open ? ['c board'] : []),
  components: {
    furniture: (ft: any) => function Furniture() {
      ft.useInputHandler({
        mode: 'consume',
        priority: () => 10,
        handler: (key: { name: string }) => {
          if (key.name === 'c') { state.open = !state.open; ft.notify(); return true; }
          return false;
        },
      });
      return null;
    },
    view: (ft: any) => function View() {
      return ft.h(ft.Text, null, state.open ? 'BOARD-101 · three cards' : 'No board data');
    },
  },
})];

test('the app opens on the host\'s own screen — a guest plugin does not take it', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 26, guest({ open: false }));
  const frame = ui.backend.lastFrame;
  // The guest's empty surface is not drawn: nobody asked for a board.
  expect(frame).not.toContain('No board data');
  // The host says who it is — the mark, drawn large — and what can be done from here.
  for (const row of LOGO) expect(frame).toContain(row.trimEnd());
  expect(frame).toContain('talk to the assistant');
  expect(frame).toMatch(/A\s+talk to the assistant/);
  // The guest is named, with the key that leads into it.
  expect(frame).toMatch(/boards\s+c boardPicker/);
  ui.app.unmount();
});

test('a guest takes the screen when it becomes active, and gives it back', async () => {
  const state = { open: false };
  const ui = await bootApp(new ScriptedModel(), 100, 26, guest(state));
  await ui.press('c'); // the guest's own furniture handles its key while it is off screen
  await settle();
  expect(ui.backend.lastFrame).toContain('BOARD-101 · three cards');
  expect(ui.backend.lastFrame).not.toContain('talk to the assistant');
  // Over a guest's screen the host keeps a title bar.
  expect(ui.backend.lastFrame).toContain('flow-assist');

  await ui.press('c');
  await settle();
  expect(ui.backend.lastFrame).not.toContain('BOARD-101');
  expect(ui.backend.lastFrame).not.toContain('No board data');
  expect(ui.backend.lastFrame).toContain('talk to the assistant');
  ui.app.unmount();
});

test('the chat opens over the start screen, and the start screen steps back', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 26);
  await ui.press('A');
  expect(ui.backend.lastFrame).toContain('ƒ Flow Assist');
  await ui.press('escape', 'escape');
  expect(ui.backend.lastFrame).toContain('talk to the assistant');
  ui.app.unmount();
});

test('a remapped key is the key the start screen names', async () => {
  // bootApp has no config hook for keys; the rule is held by the unit below instead.
  const { renderHome } = await import('../views/home');
  const { render } = await import('@flowtty/react');
  const { TestBackend, flush } = await import('@flowtty/core/testing');
  const backend = new TestBackend(80, 16);
  const app = render(renderHome({ title: 'flow-assist', plugins: [], builtins: [], keys: { chat: ['return'], commandLine: [], quit: ['q'] } }) as never, backend as never);
  await flush();
  expect(backend.lastFrame).toMatch(/⏎\s+talk to the assistant/);
  // An unbound action is not offered.
  expect(backend.lastFrame).not.toContain('commands — try');
  (app as { unmount?: () => void }).unmount?.();
});

test('a guest that names its entry is shown with that key only', async () => {
  const guests = (make: any) => [make('boards', {
    name: 'boards',
    keys: { open: 'enter', filters: 'f', boardPicker: 'c' },
    entry: ['boardPicker'],
  })];
  const ui = await bootApp(new ScriptedModel(), 100, 26, guests);
  expect(ui.backend.lastFrame).toMatch(/boards\s+c boardPicker/);
  // Keys that only mean something inside the plugin are not advertised from outside.
  expect(ui.backend.lastFrame).not.toContain('filters');
  ui.app.unmount();
});

test('the start screen is centred, as one block with a common left edge', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 26);
  const rows = ui.backend.lastFrame.split('\n');
  const at = (text: string) => { const y = rows.findIndex((r) => r.includes(text)); return { y, x: rows[y]!.indexOf(text) }; };
  const top = at(LOGO[0]!.trim());
  const last = at('quit');
  // Vertically: about as much empty space above the block as below it (the footer
  // takes the bottom rows, so allow a few).
  const above = top.y;
  const below = rows.length - 1 - last.y;
  expect(above).toBeGreaterThan(3);
  expect(Math.abs(above - below)).toBeLessThanOrEqual(4);
  // Horizontally: the block sits in the middle third, not against the left edge.
  const door = at('talk to the assistant');
  expect(door.x).toBeGreaterThan(30);
  expect(door.x).toBeLessThan(60);
  // Inside the block the three doors share one left edge.
  const xs = ['talk to the assistant', 'commands — try', 'quit'].map((t) => at(t).x);
  expect(new Set(xs).size).toBe(1);
  ui.app.unmount();
});
