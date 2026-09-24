// Where the chat is (src/runtime/panel-layout.ts). `panel`, the default, docks it beside
// the plugin's screen, which is laid out in what remains; Ctrl+] moves the keyboard
// between the two, taken by the host before any plugin; the collapse key (Ctrl+\) and
// Esc Esc fold the panel away, its turn's status going to the plugin's bottom row.
// `/mode window` is the window over the screen, `/mode full` the whole terminal, and an
// old `fullscreen: true` reads as full.
import { afterEach, expect, test } from 'bun:test';
import { TestBackend } from '@flowtty/core/testing';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { chatRows, chatWrapWidth, type RowOpts } from '../views/modals';
import { cellWidth } from '../assistant/step';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type UI = Awaited<ReturnType<typeof bootApp>>;
const CTRL_RIGHT_BRACKET = { name: '\x1d' }; // what a terminal sends for Ctrl+]
const COLLAPSE = { name: '\\', ctrl: true };
const press = async (ui: UI, key: { name: string; ctrl?: boolean }) => { ui.backend.press(key); await settle(); };
const rows = (ui: UI) => ui.backend.lastFrame.split('\n');
// The chat's frame: its top row, its left edge and its width.
const chatFrame = (ui: UI) => {
  const r = rows(ui);
  const top = r.findIndex((l) => l.includes('╭─ ƒ Flow Assist'));
  const bottom = r.findLastIndex((l) => /╰─+╯\s*$/.test(l));
  return { top, bottom, left: top >= 0 ? r[top]!.indexOf('╭─ ƒ') : -1, width: top >= 0 ? r[top]!.trimEnd().length - r[top]!.indexOf('╭─ ƒ') : 0 };
};
const command = async (ui: UI, text: string) => {
  await ui.type(text);
  await ui.press('return');
  await settle();
};

// A guest with a screen: it says how big the room it was given is, and its runtime is
// kept for what the test reads through it (the chat's messages, the theme). `take`
// lists the keys it consumes; `all` consumes every key, at the priority given.
function guest(opts: { take?: string[]; all?: boolean; priority?: number } = {}) {
  const seen: string[] = [];
  const size = { width: 0, height: 0 };
  // How many times the surface was drawn.
  const drawn = { count: 0 };
  let ft: any = null;
  const make = (mk: any) => [mk('boards', {
    name: 'boards',
    keycaps: () => ['c card'],
    components: {
      keys: (f: any) => function Keys() {
        ft = f;
        f.useInputHandler({ mode: 'consume', priority: () => opts.priority ?? 50, handler: (key: { name: string }) => {
          if (key.name.startsWith('mouse') || key.name.startsWith('wheel')) return false;
          if (opts.all || opts.take?.includes(key.name)) { seen.push(key.name); return true; }
          return false;
        } });
        return null;
      },
      view: (f: any) => function View() {
        const s = f.useSurfaceSize();
        size.width = s.width; size.height = s.height;
        drawn.count += 1;
        return f.h(f.Text, null, 'BOARD-SURFACE');
      },
    },
  })];
  return { make, seen, size, drawn, ft: () => ft };
}

test('a fresh config docks the chat on the right of a wide terminal, and the board is given the rest', async () => {
  const g = guest();
  const ui = await bootApp(new ScriptedModel(), 160, 40, g.make as never, {}, { chatMode: null });
  expect(g.size).toEqual({ width: 160, height: 34 });
  await ui.press('F');
  const f = chatFrame(ui);
  // The panel: the whole height, 35% of the width, at the right edge.
  expect(f).toEqual({ top: 0, bottom: 39, left: 104, width: 56 });
  // Both are drawn: the board's surface, narrower now, and its title bar and footer.
  expect(g.size).toEqual({ width: 104, height: 34 });
  const r = rows(ui);
  expect(r.findIndex((l) => l.includes('BOARD-SURFACE'))).toBeGreaterThan(0);
  expect(r.find((l) => l.includes('BOARD-SURFACE'))!.indexOf('BOARD-SURFACE')).toBeLessThan(104);
  expect(r[1]).toContain('flow-assist');
  expect(r.find((l) => l.includes(': commands'))!.indexOf(': commands')).toBeLessThan(104);
  ui.app.unmount();
});

test('below 120 columns the panel is at the bottom', async () => {
  const g = guest();
  const ui = await bootApp(new ScriptedModel(), 100, 40, g.make as never, {}, { chatMode: null });
  await ui.press('F');
  expect(chatFrame(ui)).toEqual({ top: 24, bottom: 39, left: 0, width: 100 });
  expect(g.size).toEqual({ width: 100, height: 18 });
  // The board's footer is its own, above the panel.
  expect(rows(ui).findIndex((l) => l.includes(': commands'))).toBeLessThan(24);
  ui.app.unmount();
});

test('Ctrl+] moves the keyboard between the chat and the plugin, and the side that has it is marked', async () => {
  // The plugin takes EVERY key: only a key the host claims first can get past it.
  const g = guest({ all: true });
  const ui = await bootApp(new ScriptedModel(), 160, 40, g.make as never, {}, { chatMode: 'panel' });
  await ui.press('F');
  expect(g.seen).toEqual(['F']); // the plugin had it; the chat stayed collapsed
  expect(chatFrame(ui).top).toBe(-1);
  // Ctrl+] brings the collapsed panel with the keyboard.
  await press(ui, CTRL_RIGHT_BRACKET);
  expect(chatFrame(ui).left).toBe(104);
  await ui.type('a');
  expect(ui.backend.lastFrame).toContain('› a');
  expect(g.seen).toEqual(['F']);
  const accent = g.ft().config.theme.modals.chat.accent;
  const corner = () => ui.backend.lastBuffer!.get(104, 0).style.fg;
  const title = () => ui.backend.lastBuffer!.get(1, 1).style.fg;
  expect(corner()).toBe(accent);
  expect(title()).not.toBe(accent);
  // To the plugin: its key reaches it, the field keeps what it had, the mark moves.
  await press(ui, CTRL_RIGHT_BRACKET);
  await ui.type('b');
  expect(g.seen).toEqual(['F', 'b']);
  expect(ui.backend.lastFrame).toContain('› a');
  expect(ui.backend.lastFrame).not.toContain('› ab');
  expect(corner()).not.toBe(accent);
  expect(title()).toBe(accent);
  // The footer says how to get back.
  expect(rows(ui).find((l) => l.includes(': commands'))).toContain('^] chat');
  // And back.
  await press(ui, CTRL_RIGHT_BRACKET);
  await ui.type('c');
  expect(ui.backend.lastFrame).toContain('› ac');
  expect(g.seen).toEqual(['F', 'b']);
  ui.app.unmount();
});

test('a plugin modal that takes every key cannot keep the chat away either', async () => {
  const g = guest({ all: true, priority: 100 });
  const ui = await bootApp(new ScriptedModel(), 160, 40, g.make as never, {}, { chatMode: 'panel' });
  await press(ui, CTRL_RIGHT_BRACKET);
  expect(chatFrame(ui).left).toBe(104);
  expect(g.ft().store.chat.focus).toBe('chat');
  await press(ui, CTRL_RIGHT_BRACKET);
  expect(g.ft().store.chat.focus).toBe('plugin');
  expect(g.seen).toEqual([]);
  ui.app.unmount();
});

test('the chat goes on streaming while the plugin has the keyboard', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Half' }, { hold: true }, { text: ' and the rest.' }]);
  const g = guest({ take: ['z'] });
  const ui = await bootApp(model, 160, 40, g.make as never, {}, { chatMode: 'panel' });
  await ui.press('F');
  await ui.type('go');
  await ui.press('return');
  await press(ui, CTRL_RIGHT_BRACKET);
  const before = ui.backend.lastFrame;
  expect(before).toContain('Half');
  expect(before).not.toContain('and the rest.');
  await ui.press('z');
  expect(g.seen).toEqual(['z']);
  model.release();
  await settle(20);
  const after = rows(ui);
  const at = after.findIndex((l) => l.includes('Half and the rest.'));
  expect(at).toBeGreaterThan(0);
  expect(after[at]!.indexOf('Half')).toBeGreaterThan(104); // in the panel
  expect(g.ft().store.chat.focus).toBe('plugin');
  ui.app.unmount();
});

test('collapsed on the right, the turn\'s status is on the plugin\'s bottom row; the same key brings the panel back', async () => {
  const model = new ScriptedModel();
  model.script([{ hold: true }, { text: 'Done.' }]);
  const g = guest();
  const ui = await bootApp(model, 160, 40, g.make as never, {}, { chatMode: 'panel' });
  await ui.press('F');
  await ui.type('go');
  await ui.press('return');
  const footer = () => rows(ui).find((l) => l.includes(': commands')) ?? '';
  expect(footer()).not.toContain('…');
  await press(ui, COLLAPSE);
  expect(chatFrame(ui).top).toBe(-1);
  expect(g.size.width).toBe(160);
  // The spinner, the seconds, the word, and the key that brings it back.
  expect(footer()).toMatch(/^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \d+\.\ds · \S+… · \^\] chat · : commands/);
  await press(ui, COLLAPSE);
  expect(chatFrame(ui).left).toBe(104);
  expect(footer()).not.toContain('…');
  // The status line is the chat's own again.
  expect(ui.backend.lastFrame).toMatch(/\d+\.\ds · \S+… · Esc stops/);
  model.release();
  await settle(20);
  ui.app.unmount();
});

test('collapsed at the bottom, the panel is one status row', async () => {
  const model = new ScriptedModel();
  model.script([{ hold: true }, { text: 'Done.' }]);
  const g = guest();
  const ui = await bootApp(model, 100, 40, g.make as never, {}, { chatMode: 'panel' });
  await ui.press('F');
  await ui.type('go');
  await ui.press('return');
  await press(ui, COLLAPSE);
  const r = rows(ui);
  expect(chatFrame(ui).top).toBe(-1);
  expect(r[39]).toMatch(/^ ƒ Flow Assist · [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \d+\.\ds · \S+… · \^\] chat/);
  expect(g.size.height).toBe(33);
  model.release();
  await settle(20);
  // Idle, it says how to bring the chat back.
  expect(rows(ui)[39]).toMatch(/^ ƒ Flow Assist · \^\] chat\s*$/);
  await press(ui, COLLAPSE);
  expect(chatFrame(ui).top).toBe(24);
  expect(ui.backend.lastFrame).toContain('Done.');
  ui.app.unmount();
});

test('Esc Esc collapses the panel and gives the plugin the keyboard', async () => {
  const g = guest({ take: ['z'] });
  const ui = await bootApp(new ScriptedModel(), 160, 40, g.make as never, {}, { chatMode: 'panel' });
  await ui.press('F');
  expect(ui.backend.lastFrame).toContain('Esc Esc collapse');
  await ui.press('escape');
  expect(ui.backend.lastFrame).toContain('Esc again to collapse');
  await ui.press('escape');
  expect(chatFrame(ui).top).toBe(-1);
  await ui.press('z');
  expect(g.seen).toEqual(['z']);
  // F opens it again, with the keyboard.
  await ui.press('F');
  expect(chatFrame(ui).left).toBe(104);
  expect(g.ft().store.chat.focus).toBe('chat');
  ui.app.unmount();
});

// Esc's idle ladder is the field's first: in `!!` it steps back to `!`, then to the
// plain prompt, and only then do two more collapse the panel.
test('in a docked chat Esc steps the bang level down first, and only then does Esc Esc collapse', async () => {
  const g = guest({ take: ['z'] });
  const ui = await bootApp(new ScriptedModel(), 160, 40, g.make as never, {}, { chatMode: 'panel' });
  await ui.press('F');
  await ui.type('!');
  await ui.type('!');
  expect(ui.backend.lastFrame).toContain('!!');
  await ui.press('escape'); // 2 → 1
  expect(ui.backend.lastFrame).not.toContain('!!');
  expect(ui.backend.lastFrame).toContain('! again gets the terminal');
  expect(ui.backend.lastFrame).not.toContain('Esc again to collapse');
  await ui.press('escape'); // 1 → 0
  expect(ui.backend.lastFrame).toContain('Esc Esc collapse');
  expect(ui.backend.lastFrame).not.toContain('Esc again to collapse');
  expect(chatFrame(ui).left).toBe(104);
  await ui.press('escape'); // arms
  expect(ui.backend.lastFrame).toContain('Esc again to collapse');
  await ui.press('escape'); // collapses
  expect(chatFrame(ui).top).toBe(-1);
  await ui.press('z');
  expect(g.seen).toEqual(['z']);
  ui.app.unmount();
});

test('/mode window gives the window, /mode full the whole terminal — and a turn in flight goes on through both', async () => {
  const W = 80;
  const H = 24;
  const model = new ScriptedModel();
  model.script([{ text: 'Started' }, { hold: true }, { text: ' and finished.' }]);
  const ui = await bootApp(model, W, H, undefined, {}, { chatMode: null });
  await ui.press('F');
  // 80 columns: the panel is at the bottom.
  expect(chatFrame(ui)).toEqual({ top: 12, bottom: 23, left: 0, width: W });
  await ui.type('go');
  await ui.press('return');
  await command(ui, '/mode window');
  const windowed = chatFrame(ui);
  expect(windowed.top).toBeGreaterThan(0);
  expect(windowed.left).toBeGreaterThan(0);
  expect(ui.backend.lastFrame).toContain('Started');
  await command(ui, '/mode full');
  expect(chatFrame(ui)).toEqual({ top: 0, bottom: H - 1, left: 0, width: W });
  expect(ui.backend.lastFrame).not.toContain(': commands');
  model.release();
  await settle(20);
  // The turn was never cut: the chat was not mounted anew with the move.
  expect(ui.backend.lastFrame).toContain('Started and finished.');
  await command(ui, '/mode panel');
  expect(chatFrame(ui)).toEqual({ top: 12, bottom: 23, left: 0, width: W });
  await command(ui, '/mode sideways');
  expect(ui.backend.lastFrame).toContain('/mode takes panel, window, full');
  ui.app.unmount();
});

test('an old fullscreen: true reads as the whole terminal — over a guest\'s screen too', async () => {
  const g = guest();
  const ui = await bootApp(new ScriptedModel(), 80, 24, g.make as never, { plugins: { assistant: { fullscreen: true } } });
  expect(ui.backend.lastFrame).toContain('BOARD-SURFACE');
  await ui.press('F');
  expect(chatFrame(ui)).toEqual({ top: 0, bottom: 23, left: 0, width: 80 });
  ui.app.unmount();
});

test('/fullscreen is gone: /mode says where the chat is', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 28);
  await ui.press('F');
  await command(ui, '/fullscreen');
  expect(ui.backend.lastFrame).toContain('unknown command /fullscreen');
  ui.app.unmount();
});

test('a click on a fold in the right panel opens it, whichever side has the keyboard', async () => {
  const g = guest();
  const ui = await bootApp(new ScriptedModel(), 160, 40, g.make as never, {}, { chatMode: 'panel' });
  await ui.press('F');
  await ui.type('!');
  await ui.type('echo panel-click');
  await ui.press('return');
  for (let i = 0; i < 200 && !/echo panel-click · ✓/.test(ui.backend.lastFrame); i++) await settle(1);
  const r = rows(ui);
  const y = r.findIndex((l) => /echo panel-click · ✓/.test(l));
  expect(y).toBeGreaterThan(0);
  expect(ui.backend.lastFrame).not.toContain('│ panel-click');
  // The keyboard to the plugin first: a click in the panel still reaches the chat.
  await press(ui, CTRL_RIGHT_BRACKET);
  expect(g.ft().store.chat.focus).toBe('plugin');
  const x = r[y]!.indexOf('echo panel-click');
  ui.backend.mouse('down', x, y);
  ui.backend.mouse('up', x, y);
  await settle();
  expect(ui.backend.lastFrame).toContain('panel-click');
  expect(rows(ui).filter((l) => l.includes('panel-click')).length).toBeGreaterThan(1);
  // The press put the keyboard where it landed.
  expect(g.ft().store.chat.focus).toBe('chat');
  // A press on the board's side gives it back.
  ui.backend.mouse('down', 10, 10);
  ui.backend.mouse('up', 10, 10);
  await settle();
  expect(g.ft().store.chat.focus).toBe('plugin');
  ui.app.unmount();
});

test('every chat row is one terminal line at the panel\'s width — steps, calls, a diff, a command', async () => {
  // A narrow panel: 32% of 160 columns.
  const model = new ScriptedModel();
  model.script(
    [{ text: 'Next: change the value in a file whose name is long enough to need cutting' }, { tool: 'edit_app', args: { b: 42 } }],
    [{ text: 'Next: check the clock twice' }, { tool: 'datetime', args: {} }, { tool: 'datetime', args: {} }],
    [{ text: `Done — the value is 42 now, and here is a line of code:\n\n\`\`\`ts\nconst value = ${'x'.repeat(90)};\n\`\`\`\n` }],
  );
  const g = guest();
  const editor = (mk: any) => [...(g.make(mk) as unknown[]), mk('clone', {
    tools: [{
      id: 'clone',
      tools: [{ type: 'function', function: { name: 'edit_app', description: 'Edit app.ts.', parameters: { type: 'object', properties: { b: { type: 'number' } } } } }],
      exec: async (_n: string, args: Record<string, unknown>, ctx: any) => {
        ctx?.reportChange?.({ title: 'clone/some/deeply/nested/directory/with/a/long/path/app.ts', before: 'const a = 1;\nconst b = 2;\n', after: `const a = 1;\nconst b = ${Number(args.b)}; // ${'y'.repeat(80)}\n` });
        return 'edited';
      },
    }],
  })];
  const ui = await bootApp(model, 160, 40, editor as never, { plugins: { assistant: { mode: 'panel', panel: { size: 32 } } } });
  await ui.press('F');
  await ui.type('change it');
  await ui.press('return');
  for (let i = 0; i < 200 && !ui.backend.lastFrame.includes('Done'); i++) await settle(1);
  await ui.type('!');
  await ui.type(`echo ${'z'.repeat(70)}`);
  await ui.press('return');
  for (let i = 0; i < 200 && !/· ✓/.test(ui.backend.lastFrame); i++) await settle(1);
  const panelW = Math.round(160 * 0.32);
  expect(chatFrame(ui)).toEqual({ top: 0, bottom: 39, left: 160 - panelW, width: panelW });
  const wrap = chatWrapWidth(panelW, true);
  const ft = g.ft();
  const messages = ft.store.chat.messages;
  // Folded, and then everything open (what ^o shows).
  for (const open of [false, true]) {
    const opts: RowOpts = { wrap, folds: { open, except: new Set() }, viewLines: 20, notes: 'step', detailsKey: '^o', renderers: ft.services.viewRenderers, now: Date.now(), palette: {} };
    const laid = chatRows(messages, opts);
    expect(laid.length).toBeGreaterThan(5);
    for (const row of laid) {
      const text = (row.spans ?? []).map((s) => String(s.text ?? '')).join('');
      expect(cellWidth(text)).toBeLessThanOrEqual(wrap);
    }
  }
  // And on screen: nothing ran over the panel's right edge.
  for (const line of rows(ui).slice(1, 39)) expect(line.trimEnd().endsWith('│')).toBe(true);
  ui.app.unmount();
});

// A terminal that can be resized, as a real one is.
class ResizableBackend extends TestBackend {
  private w: number;
  private h: number;
  private subs = new Set<() => void>();
  constructor(w: number, h: number) { super(w, h); this.w = w; this.h = h; }
  override size() { return { width: this.w, height: this.h }; }
  onResize(fn: () => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  resize(w: number, h: number) { this.w = w; this.h = h; for (const fn of this.subs) fn(); }
}

// Too small for the panel's least and the plugin's (its title bar, its footer and one
// row of its own), a docked chat is drawn as a window — for that size only: the config
// still says panel, and a terminal grown back docks it again.
test.each([16, 12])('a panel on a %i-row terminal is drawn as a window; the plugin keeps its whole screen', async (height) => {
  const g = guest({ take: ['z'] });
  const ui = await bootApp(new ScriptedModel(), 100, height, g.make as never, {}, { chatMode: 'panel' });
  expect(g.size).toEqual({ width: 100, height: height - 6 });
  await ui.press('F');
  const f = chatFrame(ui);
  expect(f.top).toBeGreaterThanOrEqual(0);
  expect(f.left).toBeGreaterThan(0); // a window, not a panel across the whole width
  expect(g.size).toEqual({ width: 100, height: height - 6 });
  expect(ui.backend.lastFrame).toContain('Esc Esc close');
  expect(g.ft().store.chat.focus).toBe('chat');
  // The collapse key closes it, as Ctrl+] does, and the keyboard is the plugin's.
  await press(ui, COLLAPSE);
  expect(chatFrame(ui).top).toBe(-1);
  await ui.press('z');
  expect(g.seen).toEqual(['z']);
  await press(ui, CTRL_RIGHT_BRACKET);
  expect(chatFrame(ui).left).toBeGreaterThan(0);
  ui.app.unmount();
});

test('grown back, the terminal docks the chat again — with what it held', async () => {
  const g = guest();
  const backend = new ResizableBackend(100, 16);
  const ui = await bootApp(new ScriptedModel(), 100, 16, g.make as never, {}, { chatMode: 'panel', backend });
  await ui.press('F');
  await ui.type('draft');
  expect(chatFrame(ui).left).toBeGreaterThan(0);
  backend.resize(100, 40);
  await settle();
  expect(chatFrame(ui)).toEqual({ top: 24, bottom: 39, left: 0, width: 100 });
  expect(g.size).toEqual({ width: 100, height: 18 });
  expect(ui.backend.lastFrame).toContain('› draft');
  backend.resize(100, 16);
  await settle();
  expect(chatFrame(ui).left).toBeGreaterThan(0);
  expect(g.size).toEqual({ width: 100, height: 10 });
  ui.app.unmount();
});

// A write that waits for a y/n. Its guest has no surface of its own.
const notebook = (make: any) => make('notes', {
  tools: [{
    id: 'notes',
    tools: [{ type: 'function', function: { name: 'notes_write', description: 'Write the notebook.', parameters: { type: 'object', properties: { text: { type: 'string' } } } }, write: true }],
    exec: async () => 'notes_write: written',
  }],
});
const toolResult = (model: ScriptedModel, n: number) =>
  String(((model.requests[n]?.messages ?? []) as { role: string; content?: string }[]).find((m) => m.role === 'tool')?.content ?? '');
const ASK = { questions: [{ question: 'Rebase or merge?', header: 'Strategy', options: [{ label: 'rebase', description: 'Linear history' }, { label: 'merge', description: 'Keeps the branch shape' }] }] };

// A question the bottom panel cannot hold: the panel grows to it while the plugin keeps
// more than its least, and is its own size again once it is answered.
test('a bottom panel grows to show a pending question whole, and shrinks back once it is answered', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'ask_user', args: ASK }], [{ text: 'Merging then.' }]);
  const g = guest();
  const ui = await bootApp(model, 100, 40, g.make as never, {}, { chatMode: 'panel' });
  await ui.press('F');
  expect(chatFrame(ui)).toEqual({ top: 24, bottom: 39, left: 0, width: 100 });
  await ui.type('how?');
  await ui.press('return');
  await settle(10);
  // 17 rows: the frame and its padding, a row of conversation, the status row, the
  // nine of the question, and the gaps.
  expect(chatFrame(ui)).toEqual({ top: 23, bottom: 39, left: 0, width: 100 });
  expect(g.size).toEqual({ width: 100, height: 17 });
  const r = rows(ui);
  const hintAt = r.findIndex((l) => l.includes('Esc dismiss'));
  expect(r[hintAt - 5]).toContain('1. rebase');
  expect(r[hintAt + 1]).toMatch(/╰─+╯/);
  await ui.press('down');
  await ui.press('return');
  for (let i = 0; i < 50 && model.requests.length < 2; i++) await settle(1);
  await settle(10);
  expect(chatFrame(ui)).toEqual({ top: 24, bottom: 39, left: 0, width: 100 });
  expect(ui.backend.lastFrame).toContain('Merging then.');
  ui.app.unmount();
});

// Folding the chat away is not an answer: a y/n or a question waits for the person,
// the collapsed chat says so, and bringing it back shows it again.
test('collapsing during a y/n keeps it pending; the footer says it waits; expanded, y confirms', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'notes_write', args: { text: 'x' } }], [{ text: 'Written.' }]);
  const g = guest();
  const ui = await bootApp(model, 160, 40, (make) => [...g.make(make), notebook(make)] as never, {}, { chatMode: 'panel' });
  await ui.press('F');
  await ui.type('write it');
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('Confirm write: notes_write');
  await press(ui, COLLAPSE);
  await settle(10);
  expect(chatFrame(ui).top).toBe(-1);
  expect(model.requests).toHaveLength(1); // not declined behind the person's back
  const r = rows(ui);
  const y = r.findIndex((l) => l.includes(': commands'));
  expect(r[y]).toMatch(/^ \? waiting for you · \^\] chat · : commands/);
  expect(r[y]!.match(/chat/g)).toHaveLength(1);
  // In the warn colour.
  expect(ui.backend.lastBuffer!.get(1, y).style.fg).toBe(g.ft().config.theme.modals.chat.warn);
  await press(ui, COLLAPSE);
  expect(ui.backend.lastFrame).toContain('Confirm write: notes_write');
  await ui.press('y');
  for (let i = 0; i < 50 && model.requests.length < 2; i++) await settle(1);
  await settle(10);
  expect(toolResult(model, 1)).toContain('written');
  expect(ui.backend.lastFrame).toContain('Written.');
  ui.app.unmount();
});

test('collapsed at the bottom during a question, the strip says it waits; expanded, it is answered', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'ask_user', args: ASK }], [{ text: 'Merging then.' }]);
  const g = guest();
  const ui = await bootApp(model, 100, 40, g.make as never, {}, { chatMode: 'panel' });
  await ui.press('F');
  await ui.type('how?');
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('Rebase or merge?');
  await press(ui, COLLAPSE);
  await settle(10);
  expect(rows(ui)[39]).toMatch(/^ ƒ Flow Assist · \? waiting for you · \^\] chat\s*$/);
  expect(model.requests).toHaveLength(1);
  await press(ui, CTRL_RIGHT_BRACKET);
  expect(ui.backend.lastFrame).toContain('Rebase or merge?');
  await ui.press('down');
  await ui.press('return');
  for (let i = 0; i < 50 && model.requests.length < 2; i++) await settle(1);
  expect(toolResult(model, 1)).toContain('Rebase or merge? → merge');
  ui.app.unmount();
});

// In a window (or the whole terminal) Ctrl+] closes the chat the same way: the question
// waits, the footer says so, and F brings it back. Esc still dismisses it, as before.
test.each(['window', 'full'] as const)('Ctrl+] closing the %s during a question keeps it; Esc still dismisses', async (mode) => {
  const model = new ScriptedModel();
  model.script([{ tool: 'ask_user', args: ASK }], [{ text: 'Fine.' }]);
  const g = guest();
  const ui = await bootApp(model, 100, 40, g.make as never, {}, { chatMode: mode });
  await ui.press('F');
  await ui.type('how?');
  await ui.press('return');
  await settle(10);
  await press(ui, CTRL_RIGHT_BRACKET);
  await settle(10);
  expect(chatFrame(ui).top).toBe(-1);
  expect(model.requests).toHaveLength(1);
  expect(rows(ui).find((l) => l.includes(': commands'))).toMatch(/^ \? waiting for you · \^\] chat · : commands/);
  await ui.press('F');
  expect(ui.backend.lastFrame).toContain('Rebase or merge?');
  await ui.press('escape');
  for (let i = 0; i < 50 && model.requests.length < 2; i++) await settle(1);
  expect(toolResult(model, 1)).toMatch(/dismiss/i);
  ui.app.unmount();
});

// The collapsed status ticks by itself: the seconds move on the footer row while the
// plugin's surface is not drawn again for them (the whole App used to redraw every
// 120 ms while a collapsed turn ran).
test('a collapsed turn\'s seconds tick without redrawing the plugin\'s screen', async () => {
  const model = new ScriptedModel();
  model.script([{ hold: true }, { text: 'Done.' }]);
  const g = guest();
  const ui = await bootApp(model, 160, 40, g.make as never, {}, { chatMode: 'panel' });
  await ui.press('F');
  await ui.type('go');
  await ui.press('return');
  await press(ui, COLLAPSE);
  await settle(10);
  const footer = () => rows(ui).find((l) => l.includes(': commands')) ?? '';
  const seconds = () => /(\d+\.\d)s · /.exec(footer())?.[1];
  const before = seconds();
  const drawnBefore = g.drawn.count;
  await new Promise((r) => setTimeout(r, 700));
  await settle(2);
  expect(seconds()).not.toBe(before);
  expect(g.drawn.count - drawnBefore).toBeLessThanOrEqual(1);
  model.release();
  await settle(20);
  expect(footer()).not.toContain('…');
  ui.app.unmount();
});

// The status on the footer row names the key that brings the chat back; the footer's
// own `F chat` beside it said "chat" twice. Idle, the status is gone and it is back.
test('collapsed on the right with a turn running, the footer says "chat" once', async () => {
  const model = new ScriptedModel();
  model.script([{ hold: true }, { text: 'Done.' }]);
  const g = guest();
  const ui = await bootApp(model, 160, 40, g.make as never, {}, { chatMode: 'panel' });
  await ui.press('F');
  await ui.type('go');
  await ui.press('return');
  await press(ui, COLLAPSE);
  const footer = () => rows(ui).find((l) => l.includes(': commands')) ?? '';
  expect(footer()).toContain('^] chat');
  expect(footer().match(/chat/g)).toHaveLength(1);
  model.release();
  await settle(20);
  expect(footer()).not.toContain('^] chat');
  expect(footer()).toContain('F chat');
  ui.app.unmount();
});

// With Ctrl+]'s action unbound the status names no key: the footer keeps its own.
test('with chatFocus unbound, a collapsed turn\'s footer still says F chat', async () => {
  const model = new ScriptedModel();
  model.script([{ hold: true }, { text: 'Done.' }]);
  const g = guest();
  const ui = await bootApp(model, 160, 40, g.make as never, { keys: { chatFocus: [] } }, { chatMode: 'panel' });
  await ui.press('F');
  await ui.type('go');
  await ui.press('return');
  await press(ui, COLLAPSE);
  const footer = rows(ui).find((l) => l.includes(': commands')) ?? '';
  expect(footer).toContain('…');
  expect(footer).not.toContain('^] chat');
  expect(footer).toContain('F chat');
  model.release();
  await settle(20);
  ui.app.unmount();
});

// `/mode` alone answers in the chat, as a note: a toast is drawn under a chat that
// covers the whole terminal, and was never seen there.
test.each(['panel', 'window', 'full'] as const)('/mode alone says where the chat is, in the chat (%s)', async (mode) => {
  const g = guest();
  const ui = await bootApp(new ScriptedModel(), 160, 40, g.make as never, {}, { chatMode: mode });
  await ui.press('F');
  await command(ui, '/mode');
  expect(ui.backend.lastFrame).toContain(`the chat is in ${mode} mode`);
  const notes = (g.ft().store.chat.messages as { role: string; content: string }[]).filter((m) => m.role === 'note');
  expect(notes.map((m) => m.content)).toEqual([`the chat is in ${mode} mode · /mode panel|window|full`]);
  ui.app.unmount();
});

// A letter bound to Ctrl+]'s action would be taken before every field — the chat's,
// the plugin's, the `:` line's — and could not be undone from inside the app. It falls
// back to the default.
test('chatFocus bound to a letter keeps Ctrl+]: the letter still types', async () => {
  const g = guest({ take: ['x'] });
  const ui = await bootApp(new ScriptedModel(), 160, 40, g.make as never, { keys: { chatFocus: 'x' } }, { chatMode: 'panel' });
  await ui.press('x');
  expect(g.seen).toEqual(['x']);
  expect(chatFrame(ui).top).toBe(-1);
  await press(ui, CTRL_RIGHT_BRACKET);
  await ui.type('x');
  expect(ui.backend.lastFrame).toContain('› x');
  expect(g.ft().store.chat.focus).toBe('chat');
  ui.app.unmount();
});

// The `:` line owns the keyboard while it is open: Ctrl+] and the collapse key are
// not taken from it — in a window, the chat would open over the line and what was
// typed would go into a line nobody sees.
test.each(['window', 'panel'] as const)('with the : line open, Ctrl+] and Ctrl+\\ leave it alone (%s)', async (mode) => {
  const g = guest();
  const ui = await bootApp(new ScriptedModel(), 160, 40, g.make as never, {}, { chatMode: mode });
  await ui.press(':');
  for (const key of [CTRL_RIGHT_BRACKET, COLLAPSE]) {
    await press(ui, key);
    expect(chatFrame(ui).top).toBe(-1);
    expect(g.ft().store.chat.open).toBe(false);
  }
  await ui.type('ab');
  expect(rows(ui).some((l) => l.includes(': ab'))).toBe(true);
  // Closed, the line gives them back.
  await ui.press('escape');
  await press(ui, CTRL_RIGHT_BRACKET);
  expect(chatFrame(ui).top).toBeGreaterThanOrEqual(0);
  ui.app.unmount();
});

// A small docked chat with a plan: the field never shrinks, the conversation keeps a
// row, and the plan is what gives way — ONE row, whole again in a panel with room.
test.each([[30, 'line'], [60, 'full']] as const)('a bottom panel on a %i-row terminal with a three-item plan: the field whole, the plan as %s', async (height, shape) => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'todo', args: { action: 'set', todos: [{ text: 'read the code', status: 'done' }, { text: 'write the fix', status: 'in_progress' }, { text: 'run the tests' }] } }],
    [{ text: 'Planned.' }],
  );
  const g = guest();
  const ui = await bootApp(model, 100, height, g.make as never, {}, { chatMode: 'panel' });
  await ui.press('F');
  await ui.type('plan it');
  await ui.press('return');
  for (let i = 0; i < 50 && model.requests.length < 2; i++) await settle(1);
  await settle(10);
  const f = chatFrame(ui);
  expect(f.left).toBe(0); // docked at the bottom
  if (shape === 'line') expect(f.bottom - f.top + 1).toBe(12);
  // Inside the frame's border and padding.
  const inside = rows(ui).slice(f.top + 2, f.bottom - 1);
  // The field and its hint, whole, on the last row of the frame's content.
  expect(inside.at(-1)).toContain('› ');
  expect(inside.at(-1)).toContain('⏎ send ·');
  expect(inside.at(-1)).toContain('new line · Esc Esc collapse');
  // At least one row of conversation — the answer is on screen.
  expect(ui.backend.lastFrame).toContain('Planned.');
  if (shape === 'line') {
    const plan = inside.filter((l) => l.includes('plan'));
    expect(plan).toHaveLength(1);
    expect(plan[0]).toContain('▸ plan 2/3 · write the fix');
    expect(ui.backend.lastFrame).not.toContain('☐');
  } else {
    expect(ui.backend.lastFrame).toContain('▾ plan');
    expect(ui.backend.lastFrame).toContain('◐ 2 · write the fix');
    expect(ui.backend.lastFrame).toContain('☐ 3 · run the tests');
    expect(ui.backend.lastFrame).toContain('· 1 done');
    expect(ui.backend.lastFrame).not.toContain('plan 2/3');
  }
  ui.app.unmount();
});
