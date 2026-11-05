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
  description: 'Boards and cards',
  keys: { boardPicker: 'c' },
  entry: ['boardPicker'],
  surface: 'board',
  keycaps: () => (state.open ? ['c board'] : []),
  components: {
    furniture: (api: any) => function Furniture() {
      api.host.useInputHandler({
        mode: 'consume',
        priority: () => 10,
        handler: (key: { name: string }) => {
          if (key.name === 'c') { state.open = !state.open; api.host.notify(); return true; }
          return false;
        },
      });
      return null;
    },
    view: (api: any) => function View() {
      return api.ui.h(api.ui.Text, null, state.open ? 'BOARD-101 · three cards' : 'No board data');
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
  expect(frame).toMatch(/F\s+talk to the assistant/);
  // The guest is named, with the key that leads into it and what it is.
  expect(frame).toMatch(/boards\s+c\s+Boards and cards/);
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
  await ui.press('F');
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

// A wide cluster (a CJK name, a wide emoji, a remapped key) takes two grid cells, and
// `backend.lastFrame` omits the second one (its `char` is `''`), so a plain string
// index is not a column — this helper walks the buffer cell by cell to find the
// column `needle` really starts at.
function columnOf(backend: { lastBuffer: { get(x: number, y: number): { char: string } } | null }, y: number, width: number, needle: string): number {
  let text = '';
  const cols: number[] = [];
  for (let x = 0; x < width; x++) {
    const ch = backend.lastBuffer!.get(x, y).char;
    if (ch === '') continue; // the second cell of a wide cluster
    cols.push(x);
    text += ch;
  }
  const i = text.indexOf(needle);
  return i < 0 ? -1 : cols[i]!;
}

test('a plugin name with a wide glyph still lines up the description column', async () => {
  const { renderHome } = await import('../views/home');
  const { render } = await import('@flowtty/react');
  const { TestBackend, flush } = await import('@flowtty/core/testing');
  const backend = new TestBackend(100, 16);
  const app = render(renderHome({
    title: 'flow-assist',
    builtins: [],
    keys: { chat: ['return'], commandLine: [], quit: ['q'] },
    plugins: [
      { name: '日本語', description: 'Japanese plugin' },
      { name: 'notes', description: 'Plain notes' },
    ],
  }) as never, backend as never);
  await flush();
  const rows = backend.lastFrame.split('\n');
  const wideY = rows.findIndex((r) => r.includes('Japanese plugin'));
  const asciiY = rows.findIndex((r) => r.includes('Plain notes'));
  expect(wideY).toBeGreaterThanOrEqual(0);
  expect(asciiY).toBeGreaterThanOrEqual(0);
  expect(columnOf(backend, wideY, 100, 'Japanese plugin')).toBe(columnOf(backend, asciiY, 100, 'Plain notes'));
  (app as { unmount?: () => void }).unmount?.();
});

test('an entry key remapped to a wide glyph still lines up the description column', async () => {
  const { renderHome } = await import('../views/home');
  const { render } = await import('@flowtty/react');
  const { TestBackend, flush } = await import('@flowtty/core/testing');
  const backend = new TestBackend(100, 16);
  const app = render(renderHome({
    title: 'flow-assist',
    builtins: [],
    keys: { chat: ['return'], commandLine: [], quit: ['q'], wide: ['笔'], narrow: ['c'] },
    plugins: [
      { name: 'aaaa', description: 'Wide key plugin', entry: ['wide'] },
      { name: 'bbbb', description: 'Narrow key plugin', entry: ['narrow'] },
    ],
  }) as never, backend as never);
  await flush();
  const rows = backend.lastFrame.split('\n');
  const wideY = rows.findIndex((r) => r.includes('Wide key plugin'));
  const asciiY = rows.findIndex((r) => r.includes('Narrow key plugin'));
  expect(wideY).toBeGreaterThanOrEqual(0);
  expect(asciiY).toBeGreaterThanOrEqual(0);
  expect(columnOf(backend, wideY, 100, 'Wide key plugin')).toBe(columnOf(backend, asciiY, 100, 'Narrow key plugin'));
  (app as { unmount?: () => void }).unmount?.();
});

test('a door key remapped to a wide glyph still lines up the door label column', async () => {
  const { renderHome } = await import('../views/home');
  const { render } = await import('@flowtty/react');
  const { TestBackend, flush } = await import('@flowtty/core/testing');
  const backend = new TestBackend(100, 16);
  const app = render(renderHome({
    title: 'flow-assist',
    builtins: [],
    plugins: [],
    // `chat` remapped to a wide grapheme; `commandLine` stays a narrow one — both are
    // "doors" the host itself draws, padded to the same column as `talk to…`/`commands…`.
    keys: { chat: ['笔'], commandLine: [':'], quit: [] },
  }) as never, backend as never);
  await flush();
  const rows = backend.lastFrame.split('\n');
  const wideY = rows.findIndex((r) => r.includes('talk to the assistant'));
  const asciiY = rows.findIndex((r) => r.includes('commands — try'));
  expect(wideY).toBeGreaterThanOrEqual(0);
  expect(asciiY).toBeGreaterThanOrEqual(0);
  expect(columnOf(backend, wideY, 100, 'talk to the assistant')).toBe(columnOf(backend, asciiY, 100, 'commands — try'));
  (app as { unmount?: () => void }).unmount?.();
});

test('guests are listed as name · way in · what it is, in aligned columns', async () => {
  const guests = (make: any) => [make('boards', {
    name: 'boards',
    description: 'Boards and cards',
    keys: { open: 'enter', filters: 'f', boardPicker: 'c' },
    entry: ['boardPicker'],
  }), make('notes', { name: 'notes', description: 'Plain notes', keys: { open: 'enter' } })];
  const ui = await bootApp(new ScriptedModel(), 100, 26, guests);
  const rows = ui.backend.lastFrame.split('\n');
  expect(ui.backend.lastFrame).toMatch(/boards\s+c\s+Boards and cards/);
  // A key is an instruction. A plugin that names no entry gets NONE listed: "⏎ open"
  // beside a plugin with nothing open read as "press Enter", and Enter did nothing.
  const notes = rows.find((r) => r.includes('Plain notes'))!;
  expect(notes).not.toContain('⏎');
  expect(ui.backend.lastFrame).not.toContain('filters');
  // The descriptions start on one vertical line.
  const boards = rows.find((r) => r.includes('Boards and cards'))!;
  expect(boards.indexOf('Boards and cards')).toBe(notes.indexOf('Plain notes'));
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

test('a long description wraps under its own first line, and the block stays centred', async () => {
  const long = 'Boards and cards for a team tracker: swimlanes, filters, sprints, bookmarks and a detail view of every issue';
  const guests = (make: any) => [
    make('boards', { name: 'boards', description: long, keys: { boardPicker: 'c' }, entry: ['boardPicker'] }),
    make('notes', { name: 'notes', description: 'Plain notes' }),
  ];
  const ui = await bootApp(new ScriptedModel(), 100, 28, guests);
  const rows = ui.backend.lastFrame.split('\n');
  const first = rows.findIndex((r) => r.includes('Boards and cards'));
  const x = rows[first]!.indexOf('Boards and cards');
  // Nothing is lost, and nothing runs to the edge of the screen.
  const flat = rows.slice(first, first + 4).map((r) => r.slice(x).trim()).join(' ');
  expect(flat.replace(/\s+/g, ' ')).toContain(long);
  expect(Math.max(...rows.map((r) => r.trimEnd().length))).toBeLessThan(96);
  // The continuation starts in the description's own column…
  expect(rows[first + 1]!.slice(0, x).trim()).toBe('');
  expect(rows[first + 1]!.slice(x, x + 1)).not.toBe(' ');
  // …and the next plugin's description is in the same column.
  const notes = rows.find((r) => r.includes('Plain notes'))!;
  expect(notes.indexOf('Plain notes')).toBe(x);
  ui.app.unmount();
});

// A binary started away from its plugins would otherwise run with none and say
// nothing. With no guest, the start screen and the log say where the host looked.
test('with no plugins, the start screen and the log say where the host looked', async () => {
  const note = 'no plugins in /opt/kit/plugins-enabled';
  const ui = await bootApp(new ScriptedModel(), 100, 26, undefined, {}, { pluginsNote: note });
  expect(ui.backend.lastFrame).toContain(note);
  await ui.press('L');
  expect(ui.backend.lastFrame).toContain(`[plugins] ${note}`);
  ui.app.unmount();
  // A guest on screen is the list; the note is not drawn beside it.
  const withGuest = await bootApp(new ScriptedModel(), 100, 26, guest({ open: false }), {}, { pluginsNote: note });
  expect(withGuest.backend.lastFrame).not.toContain(note);
  withGuest.app.unmount();
});

// Quitting is a command, not a letter: a stray `q` closed the whole app. No lower-case
// letter does anything on the start screen — each is pressed and the screen, the
// footer and the process are as they were.
test('no letter acts on the start screen — q included; :q quits', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 26);
  const before = ui.backend.lastFrame;
  expect(before).not.toMatch(/\bq quit\b/); // the footer no longer offers it
  expect(before).toMatch(/:q\s+quit/); // the start screen says how to leave instead
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    await ui.press(letter);
    expect(ui.exits()).toBe(0);
    expect(ui.backend.lastFrame).toBe(before);
  }
  await ui.press(':');
  await ui.type('q');
  await ui.press('return');
  expect(ui.exits()).toBe(1);
  ui.app.unmount();
});

// The keycaps panel floats at the bottom right, over the row the footer uses. It is
// drawn ABOVE the footer: the footer, a later sibling one level up, would otherwise run its
// text across the panel's frame whatever the panel's own zIndex.
test('the keycaps panel is drawn over the footer, not under it', async () => {
  const state = { open: false };
  const wide = (make: any) => [make('boards', {
    name: 'boards', description: 'Boards and cards', keys: { boardPicker: 'c' }, entry: ['boardPicker'], surface: 'board',
    // Enough hints to run the footer under the panel.
    keycaps: () => (state.open ? ['c board', 'f filters', 'e expand', 'm bookmark', 'b browser', '␣ fold', 'i info', 'r relations', 'x more'] : []),
    components: {
      furniture: (api: any) => function Furniture() {
        api.host.useInputHandler({ mode: 'consume', priority: () => 10, handler: (key: { name: string }) => {
          if (key.name === 'c') { state.open = !state.open; api.host.notify(); return true; }
          return false;
        } });
        return null;
      },
      view: (api: any) => function View() { return api.ui.h(api.ui.Text, null, 'BOARD-101'); },
    },
  })];
  const ui = await bootApp(new ScriptedModel(), 90, 24, wide, { plugins: { keycaps: { enabled: true } } });
  await ui.press('c');
  const rows = ui.backend.lastFrame.split('\n');
  const footer = rows.findIndex((r) => r.includes(': commands'));
  expect(footer).toBeGreaterThan(-1);
  // The panel's bottom frame sits on the footer row, and it is whole there.
  expect(rows[footer]).toMatch(/╰─+╯/);
  expect(rows.slice(0, footer).join('\n')).toMatch(/╭─ key/); // its title (shortened when narrow)
  ui.app.unmount();
});

test('a surface as tall as useSurfaceSize says fits between the title bar and the command line', async () => {
  // A surface sized by the terminal was four rows taller than its room: its bottom
  // frame and the host's command line fell off the screen.
  const tall = (make: any) => [make('boards', {
    name: 'boards',
    keycaps: () => ['c board'],
    components: {
      view: (api: any) => function View() {
        const { height } = api.host.useSurfaceSize();
        return api.ui.h(api.ui.Box, { height, border: 'round', flexDirection: 'column' }, api.ui.h(api.ui.Text, null, 'TOP ROW'));
      },
    },
  })];
  const ui = await bootApp(new ScriptedModel(), 100, 30, tall);
  const rows = ui.backend.lastFrame.split('\n');
  expect(rows.findIndex((r) => r.includes('TOP ROW'))).toBeGreaterThan(-1);
  const bottom = rows.findIndex((r) => /╰─+╯/.test(r));
  const footer = rows.findIndex((r) => r.includes(': commands'));
  expect(bottom).toBeGreaterThan(-1);
  expect(footer).toBeGreaterThan(bottom);
  ui.app.unmount();
});

// An emoji is one code point and two cells: counted by code points, the description
// column would be half as wide as the text, and wrap it.
test('a description with emoji is given the cells it takes', async () => {
  const { renderHome } = await import('../views/home');
  const { render } = await import('@flowtty/react');
  const { TestBackend, flush } = await import('@flowtty/core/testing');
  const backend = new TestBackend(120, 16);
  const description = `${'✅'.repeat(10)} \u{1F1F7}\u{1F1FA}`; // 25 cells, 13 code points
  const app = render(renderHome({
    title: 'flow-assist', builtins: [], keys: { chat: ['return'], commandLine: [], quit: ['q'] },
    plugins: [{ name: 'tags', description }],
  }) as never, backend as never);
  await flush();
  expect(backend.lastFrame.split('\n').some((r) => r.includes(description))).toBe(true);
  (app as { unmount?: () => void }).unmount?.();
});

test('the no-plugins note with emoji is given the cells it takes', async () => {
  const { renderHome } = await import('../views/home');
  const { render } = await import('@flowtty/react');
  const { TestBackend, flush } = await import('@flowtty/core/testing');
  const backend = new TestBackend(120, 16);
  const pluginsNote = `${'✅'.repeat(12)} \u{1F468}‍\u{1F469}‍\u{1F467}`; // 27 cells, 18 code points
  const app = render(renderHome({
    title: 'flow-assist', builtins: [], keys: { chat: ['return'], commandLine: [], quit: ['q'] },
    plugins: [], pluginsNote,
  }) as never, backend as never);
  await flush();
  expect(backend.lastFrame.split('\n').some((r) => r.includes(pluginsNote))).toBe(true);
  (app as { unmount?: () => void }).unmount?.();
});
