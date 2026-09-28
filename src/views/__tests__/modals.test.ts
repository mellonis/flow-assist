import { expect, test } from 'bun:test';
import { createElement as h } from 'react';
import { render, stringWidth } from '@flowtty/react';
import { TestBackend } from '@flowtty/core/testing';
import { MODAL_COLOR_DEFAULTS } from '../../playback/theme.js';
import { chatRows, condenseRuns, helpEntries, toolSummary, inputVisualRows, mdLines, renderChatModal, renderHelp, renderLogModal, renderReminder, typedLines, type RowOpts } from '../modals.js';
import { bumpViewRevision } from '../../assistant/views.js';
import { cutLeft, headClusters } from '../../cells.js';
import { pickerStart } from '../../assistant/session-picker.js';
import type { SessionRow } from '../../assistant/sessions.js';

// The trail condenses a run of one tool ending one way into a count — except a call
// that returned images, whose marks are what the person looks for.
test('condenseRuns counts same-name same-outcome calls, and never folds a call that returned images', () => {
  const ok = (name: string, images?: { name: string }[]) => ({ name, outcome: 'ok', ...(images ? { images } : {}) });
  expect(condenseRuns([ok('read_file'), ok('read_file'), ok('read_file')]).map((c) => c.n)).toEqual([3]);
  expect(condenseRuns([ok('get_shots'), ok('get_shots', [{ name: 'a.png' }]), ok('get_shots')]).map((c) => [c.run.name, c.n, c.run.images?.length ?? 0])).toEqual([['get_shots', 1, 0], ['get_shots', 1, 1], ['get_shots', 1, 0]]);
});

// The built-in modal renderers, driven directly so the chat/help/log surfaces are
// actually drawn. Each renderer is pure — it takes props and returns an element —
// so render(h(view, props), TestBackend) and `lastFrame` assertions are enough.
// `render` is async (it mounts the element into the backend), so every test awaits
// it and calls `unmount()` to tear the element down.

const baseChat = {
  width: 80,
  height: 24,
  theme: { modals: { chat: { userBg: undefined }, log: { bg: undefined }, help: { bg: undefined } } },
  messages: [] as { role: string; content?: string | null }[],
  input: '',
  streaming: false,
};

test('chat marks who is speaking with a gutter marker, not a role label', async () => {
  const backend = new TestBackend(80, 24);
  const handle = await render(
    h(renderChatModal, {
      ...baseChat,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
    }),
    backend,
  );
  // The person's message carries the input field's own prompt, the answer the
  // assistant's ƒ — both in the same two-cell gutter, so the text lines up.
  expect(backend.lastFrame).toContain('› hello');
  expect(backend.lastFrame).toContain('ƒ hi there');
  expect(backend.lastFrame).not.toMatch(/\bYou\b|\bAssistant\b/);
  handle.unmount();
});

test('chat marks a background result with its own marker and ground, never as the person', async () => {
  const backend = new TestBackend(80, 24);
  const handle = await render(
    h(renderChatModal, {
      ...baseChat,
      // The text a `background` task posts carries no "[background]" prefix: the ◆
      // marker and its own ground are what set it apart from the person's messages.
      // The colours a real app resolves from the theme (baseChat carries none).
      theme: { modals: { chat: MODAL_COLOR_DEFAULTS.chat } },
      messages: [{ role: 'bg', content: 'hello world finished:\nhello world' }],
    }),
    backend,
  );
  const rows = backend.lastFrame.split('\n');
  const y = rows.findIndex((r) => r.includes('◆ hello world finished:'));
  expect(y).toBeGreaterThanOrEqual(0);
  expect(backend.lastFrame).not.toContain('› hello world');
  expect(backend.lastFrame).not.toContain('[background]');
  // Its ground differs from the person's, so the two are told apart at a glance.
  const cell = backend.lastBuffer!.get(rows[y]!.indexOf('◆'), y).style;
  expect(cell.fg).toBe('magenta');
  expect(cell.bg).toBe('#2a2438');
  expect(cell.bg).not.toBe('#2b2b40');
  handle.unmount();
});

// The gutter marker on a command block's first row: dim/pulsing while it runs, then
// coloured for how it ended — never a code to decode, the way the tail beside it reads.
test("a command block's gutter marker is dim while it runs, ok on exit 0, the error colour otherwise", async () => {
  const theme = { modals: { chat: MODAL_COLOR_DEFAULTS.chat }, error: 'red' };
  const shellMsg = (data: Record<string, unknown>, phase: string) => ({
    role: 'shell', content: '',
    views: [{ kind: 'console', data: { command: 'echo hi', cwd: '~', text: '', ...data }, phase, startedAt: 0 }],
  });
  const markerStyle = async (msg: unknown, now?: number) => {
    const backend = new TestBackend(80, 24);
    const handle = await render(h(renderChatModal, { ...baseChat, theme, messages: [msg], ...(now === undefined ? {} : { now }) }), backend);
    const row = backend.lastFrame.split('\n').find((r) => r.includes('echo hi'))!;
    const style = backend.lastBuffer!.get(row.indexOf('echo hi') - 2, backend.lastFrame.split('\n').indexOf(row)).style;
    handle.unmount();
    return style;
  };
  const markerFg = async (msg: unknown, now?: number) => (await markerStyle(msg, now)).fg;
  // Live: the shell colour (same as the `!`/`‼` prompt it was typed with), pinned —
  // never the ok or the error colour, an outcome the run has not reached yet.
  const liveAt0 = await markerStyle(shellMsg({}, 'live'), 0);
  expect(liveAt0.fg).toBe('magentaBright');
  // The pulse alternates dim on and off over the same clock the elapsed-seconds tail
  // reads, off a `now` sample half a period apart — no timer of its own.
  const liveAt600 = await markerStyle(shellMsg({}, 'live'), 600);
  expect(liveAt600.fg).toBe('magentaBright');
  expect(liveAt0.dim).not.toBe(liveAt600.dim);
  // Exit 0: ok (green).
  expect(await markerFg(shellMsg({ exitCode: 0, ms: 10, status: 'exit 0' }, 'done'))).toBe('green');
  // A non-zero exit, and a run the tool call itself failed on: the error colour.
  expect(await markerFg(shellMsg({ exitCode: 1, ms: 10, status: 'exit 1' }, 'done'))).toBe('red');
  expect(await markerFg(shellMsg({}, 'failed'))).toBe('red');
});

// The gutter marker draws the mark of HOW the run happened — `! ` ordinary, `‼ `
// interactive — the same two characters the field's own prompt uses, whether the
// block is folded to one line or opened to its output. `folded`/`opened` are told
// apart by the output: folded holds it back (one line, no `│ ` body), opened shows it.
const shellMsg = (interactive: boolean) => ({
  role: 'shell', content: '',
  views: [{
    kind: 'console',
    data: { command: 'echo hi', cwd: '~', text: 'out', exitCode: 0, ms: 10, status: 'exit 0', ...(interactive ? { interactive: true } : {}) },
    phase: 'done', startedAt: 0,
  }],
});
const consoleFrame = async (interactive: boolean, open: boolean) => {
  const theme = { modals: { chat: MODAL_COLOR_DEFAULTS.chat }, error: 'red' };
  const backend = new TestBackend(80, 24);
  const handle = await render(h(renderChatModal, { ...baseChat, theme, messages: [shellMsg(interactive)], folds: { open, except: new Set<string>() } }), backend);
  const frame = backend.lastFrame;
  handle.unmount();
  return frame;
};

test('the gutter marker draws the ordinary run mark, folded and opened', async () => {
  const folded = await consoleFrame(false, false);
  expect(folded).toContain('! echo hi');
  expect(folded).not.toContain('│ out'); // folded: one line, the output stays back
  const opened = await consoleFrame(false, true);
  expect(opened).toContain('! echo hi');
  expect(opened).toContain('│ out'); // opened: the output is shown
});

test('the gutter marker draws the interactive run mark, folded and opened', async () => {
  const folded = await consoleFrame(true, false);
  expect(folded).toContain('‼ echo hi');
  expect(folded).not.toContain('│ out');
  const opened = await consoleFrame(true, true);
  expect(opened).toContain('‼ echo hi');
  expect(opened).toContain('│ out');
});

// The trail's header (`▾ N tools:`) takes red only for a failure nobody recovered
// from, yellow for one a later call of the same tool recovered, and the normal
// colour otherwise — a write never turns it yellow, it only adds its own ✎.
test('the tool trail header is yellow on a recovered failure, red on one that stands, and normal for writes alone', async () => {
  const theme = { modals: { chat: MODAL_COLOR_DEFAULTS.chat }, error: 'red' };
  const trailRow = async (runs: { name: string; outcome: string }[]) => {
    const backend = new TestBackend(80, 24);
    const handle = await render(h(renderChatModal, { ...baseChat, theme, messages: [{ role: 'assistant', content: 'done', parts: [{ kind: 'tools', runs }] }] }), backend);
    const rows = backend.lastFrame.split('\n');
    const y = rows.findIndex((r) => /tool/.test(r));
    const x = rows[y]!.search(/[▸▾]/);
    const style = backend.lastBuffer!.get(x, y).style;
    handle.unmount();
    return { fg: style.fg, line: rows[y]! };
  };
  // Recovered: tool a failed, then succeeded — yellow, not red.
  expect((await trailRow([{ name: 'a', outcome: 'error' }, { name: 'a', outcome: 'ok' }])).fg).toBe('yellow');
  // Unrecovered: the failing tool never ran again — red.
  expect((await trailRow([{ name: 'a', outcome: 'error' }, { name: 'b', outcome: 'ok' }])).fg).toBe('red');
  // A write with nothing failed: the normal colour, with ✎ beside it, never yellow.
  const wrote = await trailRow([{ name: 'w', outcome: 'applied' }]);
  expect(wrote.fg).toBe('green');
  expect(wrote.line).toContain('✎');
});

test('a window paints its own ink on its own ground, not the terminal foreground', async () => {
  // On a light terminal theme the default foreground is black: text with no colour of
  // its own drew black on the black window. The window's `text` reaches it now.
  const theme = { modals: { bg: 'black', text: 'white', chat: { ...MODAL_COLOR_DEFAULTS.chat, bg: 'black', text: 'white' }, help: { bg: 'black', text: 'white' } } };
  const inkOf = (backend: TestBackend, text: string) => {
    const rows = backend.lastFrame.split('\n');
    const y = rows.findIndex((r) => r.includes(text));
    expect(y).toBeGreaterThanOrEqual(0);
    return backend.lastBuffer!.get(rows[y]!.indexOf(text), y).style.fg;
  };
  const chat = new TestBackend(100, 24);
  const chatHandle = await render(h(renderChatModal, { ...baseChat, width: 100, theme }), chat);
  expect(inkOf(chat, 'Ask anything.')).toBe('white');
  chatHandle.unmount();
  const help = new TestBackend(100, 30);
  const helpHandle = await render(h(renderHelp, { width: 100, height: 30, theme, helpOpen: true, keys: { quit: ['q'] } }), help);
  // The help's hint line carries no colour of its own.
  expect(inkOf(help, 'Esc close')).toBe('white');
  helpHandle.unmount();
});

test('chat draws a slash-command completion inside the field, not on a row of its own', async () => {
  const backend = new TestBackend(80, 24);
  const handle = await render(
    h(renderChatModal, {
      ...baseChat,
      messages: [],
      input: '/c',
      cursor: 2,
      completion: { ghost: 'ompact', others: ['clear'] },
    }),
    backend,
  );
  // What was typed and what is offered read as one word, on the field's own row;
  // the other candidate is named beside it with the key that reaches it.
  const rows = backend.lastFrame.split('\n').filter((r) => r.includes('/compact'));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain('› /compact');
  expect(rows[0]).toContain('⇥ clear');
  handle.unmount();
});

test('chat offers no completion while the caret is inside the word', async () => {
  const backend = new TestBackend(80, 24);
  const handle = await render(
    h(renderChatModal, { ...baseChat, messages: [], input: '/c', cursor: 1, completion: { ghost: 'ompact', others: ['clear'] } }),
    backend,
  );
  expect(backend.lastFrame).not.toContain('/compact');
  // No row of candidates either — the hint line's own `⇧⇥ auto` is not one.
  expect(backend.lastFrame).not.toContain('⇥ clear');
  handle.unmount();
});

test('chat says a labelled candidate beside the field', async () => {
  const backend = new TestBackend(80, 24);
  const handle = await render(
    h(renderChatModal, { ...baseChat, messages: [], input: '/resume ', cursor: 8, completion: { ghost: '1', label: 'hello there', others: ['2 fix the tests'] } }),
    backend,
  );
  const row = backend.lastFrame.split('\n').find((r) => r.includes('/resume 1'))!;
  expect(row).toContain('/resume 1 hello there');
  expect(row).toContain('⇥ 2 fix the tests');
  handle.unmount();
});

test('in shell mode the hint row starts with the shell directory, cut from the left when long', async () => {
  const backend = new TestBackend(80, 24);
  const handle = await render(h(renderChatModal, { ...baseChat, messages: [], bangLevel: 1, shellCwd: '~/snake-project' }), backend);
  expect(backend.lastFrame).toContain('~/snake-project · ⇥ path · ↑↓ history');
  handle.unmount();
  const narrow = new TestBackend(40, 24);
  const long = await render(h(renderChatModal, { ...baseChat, width: 40, messages: [], bangLevel: 2, shellCwd: '~/a-very-long/directory/name/that/does/not/fit' }), narrow);
  const row = narrow.lastFrame.split('\n').find((r) => r.includes('⇥ path'))!;
  // The tail of the directory stays, the head goes.
  expect(row).toMatch(/…[^ ]*not\/fit · ⇥ path/);
  long.unmount();
  // Outside shell mode the row is the usual one.
  const plain = new TestBackend(80, 24);
  const none = await render(h(renderChatModal, { ...baseChat, messages: [], shellCwd: '~/snake-project' }), plain);
  expect(plain.lastFrame).not.toContain('~/snake-project');
  none.unmount();
});

test('chat draws the plan as checkboxes in its own order, no numbers, a window of 5 around the work', async () => {
  const backend = new TestBackend(100, 24);
  const handle = await render(
    h(renderChatModal, {
      ...baseChat,
      width: 100,
      messages: [],
      todo: [
        { id: 't1', text: 'one', status: 'done' }, // above the window
        { id: 't2', text: 'two', status: 'done' },
        { id: 't3', text: 'three', status: 'in_progress' },
        { id: 't4', text: 'four', status: 'pending' },
        { id: 't5', text: 'five', status: 'pending' },
        { id: 't6', text: 'six', status: 'pending' },
        { id: 't7', text: 'seven', status: 'pending' }, // below the window
        { id: 't8', text: 'eight', status: 'pending' },
      ],
    }),
    backend,
  );
  const rows = backend.lastFrame.split('\n');
  const plan = rows.filter((r) => /[☐⊟☑] /.test(r)).map((r) => r.replace(/^[│\s]*/, '').replace(/[│\s]+$/, ''));
  // flowtty's checkbox glyphs, in the plan's order: done ☑, in progress ⊟, pending ☐;
  // the window keeps one item before the one in progress.
  expect(plan).toEqual(['☑ two', '⊟ three', '☐ four', '☐ five', '☐ six']);
  // Neither an id nor a position is drawn.
  expect(backend.lastFrame).not.toMatch(/\bt\d\b/);
  expect(backend.lastFrame).not.toMatch(/[☐⊟☑] \d/);
  // One summary line for what the window leaves out, and how far the plan is.
  expect(backend.lastFrame).toContain('+3 more · 2/8 done');
  // The done marker carries flowtty's checked color.
  const y = rows.findIndex((r) => r.includes('☑ two'));
  expect(backend.lastBuffer!.get(rows[y]!.indexOf('☑'), y).style.fg).toBe('green');
  handle.unmount();
});

test('chat draws a short plan whole, done items in place, with no summary line', async () => {
  const backend = new TestBackend(100, 24);
  const handle = await render(
    h(renderChatModal, {
      ...baseChat,
      width: 100,
      messages: [],
      todo: [
        { id: 't1', text: 'a', status: 'done' },
        { id: 't2', text: 'b', status: 'pending' },
      ],
    }),
    backend,
  );
  expect(backend.lastFrame).toContain('☑ a');
  expect(backend.lastFrame).toContain('☐ b');
  expect(backend.lastFrame).not.toContain('more');
  expect(backend.lastFrame).not.toContain('done');
  handle.unmount();
});

test('chat omits the todo block when the plan is empty', async () => {
  const backend = new TestBackend(80, 24);
  const handle = await render(
    h(renderChatModal, {
      ...baseChat,
      messages: [],
      todo: [],
    }),
    backend,
  );
  expect(backend.lastFrame).not.toContain('☐');
  handle.unmount();
});

test('chat shows the async-command spinner status line while streaming', async () => {
  const backend = new TestBackend(80, 24);
  const handle = await render(
    h(renderChatModal, {
      ...baseChat,
      streaming: true,
      toolLabel: 'compact',
      elapsed: 3200,
      messages: [],
    }),
    backend,
  );
  // The status line is `<spinner> <elapsed> · <toolLabel>` — the tool label ("compact")
  // and the formatted duration (3.2s) both appear.
  expect(backend.lastFrame).toContain('compact');
  expect(backend.lastFrame).toContain('3.2s');
  handle.unmount();
});

test('chat footer shows the live background-task count when bg tasks are running', async () => {
  const backend = new TestBackend(120, 24);
  const handle = await render(
    h(renderChatModal, {
      ...baseChat,
      width: 120,
      messages: [],
      bgCount: 2,
    }),
    backend,
  );
  expect(backend.lastFrame).toContain('2 in background');
  handle.unmount();
});

test('chat footer omits the bg-count indicator when none are running', async () => {
  const backend = new TestBackend(80, 24);
  const handle = await render(
    h(renderChatModal, {
      ...baseChat,
      messages: [],
      bgCount: 0,
    }),
    backend,
  );
  expect(backend.lastFrame).not.toContain('в фоне');
  handle.unmount();
});

test('the log is as tall as what it holds, says when, and makes a failure stand out', async () => {
  const backend = new TestBackend(90, 30);
  const handle = await render(
    h(renderLogModal, {
      width: 90,
      height: 30,
      theme: { error: 'red', modals: { log: { bg: undefined } } },
      logs: ['10:00:01 [chat] hi → 2 chars', '10:00:02 ⚠ glab failed: not installed', '10:00:03 [round 0] finish=stop'],
      logModalRows: 17,
      logScroll: 0,
    }),
    backend,
  );
  const frame = backend.lastFrame;
  const rows = frame.split('\n').filter((r) => r.trim());
  expect(frame).toContain('Log · 3');
  // The chat's frame, not a double one of its own.
  expect(frame).toContain('╭─ Log');
  expect(frame).not.toContain('╔');
  // Three entries do not sit in a frame made for seventeen.
  expect(rows.length).toBeLessThan(12);
  // How to get out is on the modal itself.
  expect(frame).toContain('Esc close');
  const cell = (text: string, offset = 0) => {
    const all = frame.split('\n');
    const y = all.findIndex((r) => r.includes(text));
    return backend.lastBuffer.get(all[y]!.indexOf(text) + offset, y).style as { fg?: string; dim?: boolean };
  };
  expect(cell('⚠ glab failed').fg).toBe('red');
  expect(cell('10:00:02').dim).toBe(true); // the stamp is quiet
  expect(cell('[round 0]').dim).toBe(true); // bookkeeping is quiet
  expect(cell('[chat] hi').dim).toBeFalsy();
  handle.unmount();
});

test('an empty log says what will land in it', async () => {
  const backend = new TestBackend(90, 24);
  const handle = await render(h(renderLogModal, { width: 90, height: 24, theme: {}, logs: [], logModalRows: 10, logScroll: 0 }), backend);
  expect(backend.lastFrame).toContain('Nothing has happened yet');
  handle.unmount();
});

test('a long log says where you are and how to move', async () => {
  const backend = new TestBackend(90, 24);
  const logs = Array.from({ length: 40 }, (_, i) => `10:00:${String(i).padStart(2, '0')} line ${i + 1}`);
  const handle = await render(h(renderLogModal, { width: 90, height: 24, theme: {}, logs, logModalRows: 10, logScroll: 0 }), backend);
  expect(backend.lastFrame).toContain('Log · 31–40 of 40');
  expect(backend.lastFrame).toMatch(/scroll · Home\/End · Esc close/);
  handle.unmount();
});

const COMMANDS = [
  { name: 'quit', aliases: ['q'], usage: 'quit', description: 'Quit' },
  { name: 'core:quit' }, // a plugin's handler for the same word: no description of its own
  { name: 'assistant:ask', aliases: ['chat'], usage: 'ask [text]', description: 'Open the chat; with text, send it' },
  { name: 'config', usage: 'config [get <key>|set <key> <value>|unset <key>|help]', description: 'Show the whole config; get/set/unset a key (writes config.local.json); help — what the keys are' },
];

test('help entries: one per word a person types, never "undefined"', () => {
  const entries = helpEntries(COMMANDS);
  expect(entries.map((e) => e.usage)).toEqual(['ask [text]  (chat)', COMMANDS[3]!.usage, 'quit  (q)']);
  for (const e of entries) expect(e.description).not.toMatch(/undefined/);
});

test('help fits the screen, names the keys, and wraps what it says', async () => {
  const backend = new TestBackend(90, 20);
  const handle = await render(
    h(renderHelp, {
      width: 90,
      height: 20,
      theme: { modals: { bg: undefined } },
      helpOpen: true,
      commands: COMMANDS,
      keys: { commandLine: [':'], quit: ['q'], chat: ['F'], sessions: ['ctrl+s'], log: ['L'], open: ['return'], disabled: [] },
    }),
    backend,
  );
  const frame = backend.lastFrame;
  const rows = frame.split('\n');
  // Inside the screen, top and bottom: the frame's first and last rows are both drawn.
  expect(rows.some((r) => r.includes('╭─ Help'))).toBe(true);
  expect(rows.some((r) => r.includes('╰'))).toBe(true);
  expect(frame).toContain('Esc close');
  // The keys, listed by what they do, drawn as caps.
  expect(frame).toMatch(/F\s+talk to the assistant/);
  expect(frame).toMatch(/L\s+the log/);
  expect(frame).toMatch(/\^s\s+saved sessions/);
  // A key the host does not act on is not listed as if it worked anywhere.
  const anywhere = rows.findIndex((r) => r.includes('Keys — anywhere'));
  const plugins = rows.findIndex((r) => r.includes("on a plugin's own screen"));
  const open = rows.findIndex((r) => /⏎\s+open/.test(r));
  const saved = rows.findIndex((r) => /\^s\s+saved sessions/.test(r));
  expect(saved).toBeGreaterThan(anywhere);
  expect(saved).toBeLessThan(plugins);
  expect(anywhere).toBeGreaterThanOrEqual(0);
  expect(open).toBeGreaterThan(plugins);
  // An unbound action is not offered at all.
  expect(frame).not.toContain('disabled');
  expect(frame).not.toContain('undefined');
  handle.unmount();
});

// A wide cluster (a CJK usage word, a remapped key) takes two grid cells, and
// `backend.lastFrame` omits the second one (its `char` is `''`), so a plain string
// index is not a column — this helper walks the buffer cell by cell to find the
// column `needle` really starts at.
function columnOf(backend: TestBackend, y: number, width: number, needle: string): number {
  let text = '';
  const cols: number[] = [];
  for (let x = 0; x < width; x++) {
    const ch = backend.lastBuffer.get(x, y).char;
    if (ch === '') continue; // the second cell of a wide cluster
    cols.push(x);
    text += ch;
  }
  const i = text.indexOf(needle);
  return i < 0 ? -1 : cols[i]!;
}

test('a key remapped to a wide glyph still lines up the label column in help', async () => {
  const backend = new TestBackend(90, 20);
  const handle = await render(
    h(renderHelp, {
      width: 90,
      height: 20,
      theme: { modals: { bg: undefined } },
      helpOpen: true,
      // `chat` remapped to a wide grapheme; `log` stays a narrow one.
      keys: { chat: ['笔'], log: ['L'] },
    }),
    backend,
  );
  const rows = backend.lastFrame.split('\n');
  const wideY = rows.findIndex((r) => r.includes('talk to the assistant'));
  const asciiY = rows.findIndex((r) => r.includes('the log'));
  expect(wideY).toBeGreaterThanOrEqual(0);
  expect(asciiY).toBeGreaterThanOrEqual(0);
  expect(columnOf(backend, wideY, 90, 'talk to the assistant')).toBe(columnOf(backend, asciiY, 90, 'the log'));
  handle.unmount();
});

test('a command usage with a wide glyph still lines up the description column in help', async () => {
  const commands = [
    { name: 'notes', usage: '记事', description: 'Open notes' },
    { name: 'ask', usage: 'ask', description: 'Open the chat' },
  ];
  const backend = new TestBackend(90, 20);
  const handle = await render(
    h(renderHelp, { width: 90, height: 20, theme: { modals: { bg: undefined } }, helpOpen: true, commands }),
    backend,
  );
  const rows = backend.lastFrame.split('\n');
  const wideY = rows.findIndex((r) => r.includes('Open notes'));
  const asciiY = rows.findIndex((r) => r.includes('Open the chat'));
  expect(wideY).toBeGreaterThanOrEqual(0);
  expect(asciiY).toBeGreaterThanOrEqual(0);
  expect(columnOf(backend, wideY, 90, 'Open notes')).toBe(columnOf(backend, asciiY, 90, 'Open the chat'));
  handle.unmount();
});

test('reminder banner shows the text and the dismiss hint, centered', async () => {
  const backend = new TestBackend(80, 24);
  const handle = await render(
    h(renderReminder, {
      width: 80,
      height: 24,
      theme: { modals: { help: { bg: undefined } } },
      text: 'stand up and stretch',
    }),
    backend,
  );
  expect(backend.lastFrame).toContain('reminder');
  expect(backend.lastFrame).toContain('stand up and stretch');
  expect(backend.lastFrame).toContain('Esc / ⏎ — dismiss'); // keys are named by their caps, everywhere
  // The one frame every window wears — round, like the chat, the log and the help.
  expect(backend.lastFrame).toMatch(/╭─ reminder/);
  expect(backend.lastFrame).not.toMatch(/[╔╗╚╝║═]/);
  handle.unmount();
});

test('a reminder full of wide glyphs is sized by display width, not code points', async () => {
  // 20 CJK characters are 20 code points but 40 display columns. Sized by code
  // points the box floors at 40 total and the text has to wrap onto two rows;
  // sized by display width it is wide enough for the text to sit on one.
  const text = '日'.repeat(20);
  const backend = new TestBackend(100, 24);
  const handle = await render(
    h(renderReminder, { width: 100, height: 24, theme: { modals: { help: { bg: undefined } } }, text }),
    backend,
  );
  const rows = backend.lastFrame.split('\n').filter((r) => r.includes('日'));
  expect(rows.length).toBe(1);
  expect((rows[0]!.match(/日/g) ?? []).length).toBe(20);
  handle.unmount();
});

// A wrapped row's `continues.textWidth` is what flowtty's own `WrapContinuation`
// documents it as — cells of the row's text — so a drag rejoins it exactly. A CJK
// run is half as many code points as it is cells; counting code points would tell a
// drag the row is narrower than it is.
test('a typed line that wraps mid-run reports textWidth in cells, not code points', () => {
  const text = '日'.repeat(10);
  const lines = typedLines(text, 6);
  const wrapped = lines.find((l) => l.continues);
  expect(wrapped).toBeDefined();
  const rowText = wrapped!.spans.map((s) => s.text).join('');
  expect(wrapped!.continues!.textWidth).toBe(stringWidth(rowText));
  expect(wrapped!.continues!.textWidth).not.toBe(Array.from(rowText).length);
});

test('the input keeps a blank line, and the caret can stand on it', () => {
  // Two newlines in a row are how a person separates two thoughts. The row was
  // there all along but rendered as an empty Text — zero height, so it vanished —
  // and the caret skipped it, landing on the first character of the next line.
  const at = (input: string, cur: number) => inputVisualRows(input, cur, 40);
  const caretRow = (rows: { caret: string }[]) => rows.findIndex((r) => r.caret !== '');

  const two = at('first\n\nsecond', 13);
  expect(two).toHaveLength(3);
  expect(two[1]).toEqual({ before: '', caret: '', after: '', start: 6 });

  // Caret ON the blank line (right after the first newline).
  const on = at('first\n\nsecond', 6);
  expect(caretRow(on)).toBe(1);
  expect(on[1]).toEqual({ before: '', caret: ' ', after: '', start: 6 });
  expect(on[2]).toEqual({ before: 'second', caret: '', after: '', start: 7 });

  // Caret at the END of a line that is followed by a newline stays on that line.
  const end = at('first\n\nsecond', 5);
  expect(caretRow(end)).toBe(0);
  expect(end[0]).toEqual({ before: 'first', caret: ' ', after: '', start: 0 });

  // Trailing blank lines: the caret is on the last one.
  const trailing = at('first\n\n', 7);
  expect(trailing).toHaveLength(3);
  expect(caretRow(trailing)).toBe(2);

  // A wrapped paragraph is unchanged: at the wrap point the caret opens the next row.
  const wrapped = inputVisualRows('aaaa bbbb', 5, 5);
  expect(caretRow(wrapped)).toBe(1);
});

test('a markdown table in an answer is laid out by flowtty, not by the host', () => {
  // layoutMarkdown lays out a GFM table itself — a ruled separator, inline markup
  // inside cells — so the host does none of its own table layout; this pins flowtty's.
  const text = (md: string) => mdLines(md, 60).map((l) => l.spans.map((s) => s.text).join(''));
  const lines = text('Result:\n\n| check | state |\n|---|---|\n| lint | ✅ **ok** |\n| tests | ❌ 2 failed |\n\nDone.');
  expect(lines).toContain('check  state');
  expect(lines.some((l) => /^─+\s+─+$/.test(l))).toBe(true);
  expect(lines).toContain('lint   ✅ ok');
  expect(lines).toContain('tests  ❌ 2 failed');
  // Text around the table is still there, in order.
  expect(lines.indexOf('Result:')).toBeLessThan(lines.indexOf('check  state'));
  expect(lines.indexOf('Done.')).toBeGreaterThan(lines.indexOf('tests  ❌ 2 failed'));
  // The bold inside a cell survives as a bold span.
  const row = mdLines('| a | b |\n|---|---|\n| lint | **ok** |', 60).find((l) => l.spans.some((s) => s.text === 'ok'));
  expect(row?.spans.find((s) => s.text === 'ok')?.bold).toBe(true);
});

test('a long line of fenced code wraps to the width — every chat row is one terminal line', () => {
  // The conversation treats a row's index as its line in the scroll box (the pinned
  // question depends on it). Before flowtty 1.0.0-alpha.11 a long code line ran out
  // of its box as ONE over-wide row; now layoutMarkdown hard-wraps it.
  const long = `const value = ${'x'.repeat(120)};`;
  const lines = mdLines(`Look:\n\n\`\`\`ts\n${long}\n\`\`\`\n`, 40);
  const widths = lines.map((l) => Array.from(l.spans.map((s) => s.text).join('')).length);
  expect(Math.max(...widths)).toBeLessThanOrEqual(40);
  // Nothing was dropped on the way (since alpha.14 every code row, a wrapped one too,
  // starts with the fence's `│ ` bar).
  expect(lines.map((l) => l.spans.map((s) => s.text).join('')).join('').replace(/[\s│]/g, '')).toContain('x'.repeat(120));
});

// A done view's rows are cached with its message; a renderer that answers late (a remote
// plugin's `view.render`) bumps the view revision, and only then is it asked again.
test('a finished message\'s view rows miss the cache once the view revision is bumped, and only then', () => {
  let text = '▸ card';
  const renderers = { card: () => [[{ text }]] };
  const msg = { role: 'view', content: '', views: [{ kind: 'card', data: {}, phase: 'done', startedAt: 0 }] };
  const o: RowOpts = { wrap: 60, folds: { open: true, except: new Set() }, viewLines: 20, notes: 'step', detailsKey: '^o', renderers, now: 0, palette: {} };
  const drawn = () => chatRows([msg] as never, o).map((r) => (r.spans ?? []).map((sp) => String(sp.text ?? '')).join('')).join('\n');
  expect(drawn()).toContain('▸ card');
  text = 'the card, rendered';
  expect(drawn()).toContain('▸ card'); // cached: the renderer is not asked again
  bumpViewRevision();
  expect(drawn()).toContain('the card, rendered');
  expect(drawn()).not.toContain('▸ card');
});

test('a message with no views keeps its cached rows across a view-revision bump: the cache does not grow per late answer', () => {
  const plain = { role: 'assistant', content: 'plain words' };
  const withView = { role: 'view', content: '', views: [{ kind: 'card', data: {}, phase: 'done', startedAt: 0 }] };
  const o: RowOpts = { wrap: 60, folds: { open: true, except: new Set() }, viewLines: 20, notes: 'step', detailsKey: '^o', renderers: { card: () => [[{ text: 'card' }]] }, now: 0, palette: {} };
  const first = chatRows([plain, withView] as never, o);
  bumpViewRevision();
  const second = chatRows([plain, withView] as never, o);
  const plainRow = (rows: typeof first) => rows.find((r) => (r.spans ?? []).some((s) => String(s.text).includes('plain words')));
  const viewRow = (rows: typeof first) => rows.find((r) => (r.spans ?? []).some((s) => String(s.text).includes('card')));
  expect(plainRow(second)).toBe(plainRow(first)!); // the same row object: a cache hit
  expect(viewRow(second)).not.toBe(viewRow(first)!); // laid out again: a miss
});

// ─── the session picker ──────────────────────────────────────────────────────────

const PICKER_ROWS: SessionRow[] = [
  { id: '2026-09-25T10-00-00-aaaa', title: 'The current one', updatedAt: '2026-09-25T10:00:00.000Z', turns: 3, bytes: 2048, lock: 'ours', status: 'idle', text: '', dir: '/s', project: null },
  { id: '2026-09-24T10-00-00-bbbb', title: 'Held elsewhere', updatedAt: '2026-09-24T10:00:00.000Z', turns: 1, bytes: 500, lock: 'held', status: 'held', text: 'zebrafish', dir: '/s', project: null },
  { id: '2026-09-23T10-00-00-cccc', title: 'An idle one', updatedAt: '2026-09-23T10:00:00.000Z', turns: 2, bytes: 3 * 1024 * 1024, lock: 'free', status: 'done', text: '', dir: '/s', project: null },
];

test('the session picker draws one row per session — title, whose it is, size, messages — and its keys', async () => {
  const backend = new TestBackend(100, 24);
  const handle = await render(h(renderChatModal, { ...baseChat, width: 100, picker: pickerStart(PICKER_ROWS) }), backend);
  const frame = backend.lastFrame;
  expect(frame).toContain('Sessions · 3');
  expect(frame).toMatch(/› The current one\s+this chat\s+.*2 KB · 3 msgs/);
  expect(frame).toMatch(/Held elsewhere\s+in use elsewhere\s+.*500 B · 1 msg\b/);
  expect(frame).toContain('3.0 MB · 2 msgs');
  expect(frame).toContain('filter ›');
  expect(frame).toContain('↑↓ pick · ⏎ open · Esc close · ⇥ all · ^n new · ^r rename · ^p move · ^x delete');
  handle.unmount();
});

test("each row says its status in a word: this chat's while it works or waits, done for an answer not seen, nothing when idle", async () => {
  for (const own of ['working', 'waiting'] as const) {
    const backend = new TestBackend(100, 24);
    const handle = await render(h(renderChatModal, { ...baseChat, width: 100, picker: pickerStart(PICKER_ROWS), pickerOwn: own }), backend);
    expect(backend.lastFrame).toMatch(new RegExp(`› The current one\\s+this chat · ${own}\\s`));
    expect(backend.lastFrame).toMatch(/An idle one\s+done\s/);
    handle.unmount();
  }
  const backend = new TestBackend(100, 24);
  const quiet = PICKER_ROWS.map((r) => ({ ...r, status: r.lock === 'held' ? 'held' as const : 'idle' as const }));
  const handle = await render(h(renderChatModal, { ...baseChat, width: 100, picker: pickerStart(quiet) }), backend);
  expect(backend.lastFrame).toMatch(/› The current one\s+this chat\s+2026/);
  expect(backend.lastFrame).not.toContain('done');
  handle.unmount();
  // Narrow, the title keeps its half and the word is cut, never the row pushed off.
  const narrow = new TestBackend(42, 24);
  const h2 = await render(h(renderChatModal, { ...baseChat, width: 42, docked: true, fullscreen: true, picker: pickerStart(PICKER_ROWS), pickerOwn: 'working' }), narrow);
  for (const line of narrow.lastFrame!.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(42);
  expect(narrow.lastFrame).toMatch(/› The current/);
  h2.unmount();
});

test('the picker counts what the filter shows, says when nothing matches, and asks y/n before a delete', async () => {
  const backend = new TestBackend(100, 24);
  const filtered = { ...pickerStart(PICKER_ROWS), filter: 'zebra', caret: 5 };
  let handle = await render(h(renderChatModal, { ...baseChat, width: 100, picker: filtered }), backend);
  expect(backend.lastFrame).toContain('Sessions · 1 of 3');
  expect(backend.lastFrame).toContain('Held elsewhere');
  expect(backend.lastFrame).not.toContain('An idle one');
  handle.unmount();
  handle = await render(h(renderChatModal, { ...baseChat, width: 100, picker: { ...filtered, filter: 'nothing-here' } }), backend);
  expect(backend.lastFrame).toContain('Nothing matches «nothing-here»');
  handle.unmount();
  handle = await render(h(renderChatModal, { ...baseChat, width: 100, picker: { ...pickerStart(PICKER_ROWS), cursor: 2, mode: 'delete' as const } }), backend);
  expect(backend.lastFrame).toContain('Delete «An idle one»? y deletes it for good · n keeps it');
  handle.unmount();
});

// A docked panel is as narrow as 42 columns (the default right panel on a 120-column
// terminal): the title still shows on a row older than today, the way out stays on the
// hint row, and a long title never pushes the y/n keys off the delete line.
test('the picker keeps the title, Esc and the y/n keys in a 42-column docked panel', async () => {
  const now = Date.parse('2026-09-25T12:00:00.000Z');
  const backend = new TestBackend(42, 24);
  let handle = await render(h(renderChatModal, { ...baseChat, width: 42, docked: true, fullscreen: true, now, picker: { ...pickerStart(PICKER_ROWS), cursor: 2 } }), backend);
  expect(backend.lastFrame).toMatch(/› An idle one/);
  expect(backend.lastFrame).toMatch(/Held elsewh/);
  expect(backend.lastFrame).toContain('↑↓ pick · ⏎ open · Esc close');
  handle.unmount();
  const long = PICKER_ROWS.map((r, i) => (i === 2 ? { ...r, title: 'A very long session title that would never fit in a narrow docked panel at all' } : r));
  handle = await render(h(renderChatModal, { ...baseChat, width: 42, docked: true, fullscreen: true, now, picker: { ...pickerStart(long), cursor: 2, mode: 'delete' as const } }), backend);
  expect(backend.lastFrame).toMatch(/Delete «A very.*…»\?/);
  expect(backend.lastFrame).toContain('y deletes it for good · n keeps it');
  handle.unmount();
  const wide = new TestBackend(100, 24);
  handle = await render(h(renderChatModal, { ...baseChat, width: 100, now, picker: { ...pickerStart(long), cursor: 2, mode: 'delete' as const } }), wide);
  expect(wide.lastFrame).toMatch(/Delete «A very.*…»\? y deletes it for good · n keeps it/);
  handle.unmount();
});

// ─── Cuts count cells per grapheme cluster ────────────────────────────────────
// A ZWJ sequence is one cluster, two cells — what the grid draws. Summed per code
// point it reads as six, and a cut lands early.
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';
const rowText = (r: { spans?: { text?: unknown }[] }) => (r.spans ?? []).map((sp) => String(sp.text ?? '')).join('');

test('a tool-trail line that fits by clusters is not cut', () => {
  const msg = { role: 'assistant', content: 'Done.', parts: [{ kind: 'tools', runs: [{ name: 'search', outcome: 'ok', args: { q: `${FAMILY}${FAMILY}${FAMILY}` } }] }] };
  const line = `▸ search (${FAMILY}${FAMILY}${FAMILY}) → ok`;
  // The line is cut to the row less one cell, and the row is `wrap` less the gutter.
  const o: RowOpts = { wrap: stringWidth(line) + 3, folds: { open: true, except: new Set() }, viewLines: 20, notes: 'step', detailsKey: '^o', renderers: {}, now: 0, palette: {} };
  const rows = chatRows([msg] as never, o).map(rowText);
  expect(rows).toContain(line);
});

test('a folded run with a failed call keeps its marks and a ZWJ step uncut', () => {
  const msg = {
    role: 'assistant', content: 'Done.',
    parts: [{ kind: 'text', text: `${FAMILY} looked` }, { kind: 'tools', runs: [{ name: 'search', outcome: 'error', detail: 'no' }] }],
  };
  const text = `▸ ${FAMILY} looked`;
  // The row is laid out in `wrap` less the two-cell gutter: exactly the row and its mark.
  const wrap = 2 + stringWidth(text) + stringWidth(' ✗');
  const rows = chatRows([msg] as never, { wrap, folds: { open: false, except: new Set() }, viewLines: 20, notes: 'step', detailsKey: '^o', renderers: {}, now: 0, palette: {} }).map(rowText);
  const row = rows.find((r) => r.startsWith('▸'));
  expect(row).toBe(`${text} ✗`);
});

test("a folded run's ✗ carries the trail's tone: warn when the same tool recovered, error when it did not", () => {
  const o: RowOpts = { wrap: 60, folds: { open: false, except: new Set() }, viewLines: 20, notes: 'step', detailsKey: '^o', renderers: {}, now: 0, palette: {} };
  const markOf = (runs: { name: string; outcome: string }[]) => {
    const msg = { role: 'assistant', content: 'Done.', parts: [{ kind: 'text', text: 'looked' }, { kind: 'tools', runs }] };
    const rows = chatRows([msg] as never, o);
    const row = rows.find((r) => (r.spans ?? []).some((sp) => sp.text === ' ✗'));
    return (row?.spans ?? []).find((sp) => sp.text === ' ✗')?.mark;
  };
  // Tool a failed, then succeeded: recovered — the ✗ is the warn tone, not error.
  expect(markOf([{ name: 'a', outcome: 'error' }, { name: 'a', outcome: 'ok' }])).toBe('warn');
  // Tool a failed and never ran again — the error tone stands.
  expect(markOf([{ name: 'a', outcome: 'error' }, { name: 'b', outcome: 'ok' }])).toBe('error');
});

test('the chat title that fits by clusters is not cut', async () => {
  // 46 cells by clusters, 106 summed per code point; the title has 72.
  const subject = FAMILY.repeat(15);
  const backend = new TestBackend(80, 12);
  const handle = await render(h(renderChatModal, { ...baseChat, height: 12, subject }), backend);
  const top = backend.lastFrame.split('\n').find((l) => l.includes('Flow Assist')) ?? '';
  expect(top).toContain(`ƒ Flow Assist · ${subject}`);
  expect(top).not.toContain('…');
  handle.unmount();
});

test('the folded tools summary counts cells, not code points', () => {
  const runs = [{ name: `${FAMILY}a`, outcome: 'ok' }, { name: `${FAMILY}b`, outcome: 'ok' }];
  const all = `${FAMILY}a, ${FAMILY}b`;
  expect(toolSummary(runs as never, stringWidth(all))).toBe(all);
  const cut = toolSummary(runs as never, stringWidth(all) - 1);
  expect(cut).toBe(`${FAMILY}a, …`);
});

test('a path cut from the left keeps whole clusters and counts their cells', () => {
  const path = `~/${FAMILY}/${FAMILY}/src`;
  // 13 cells by clusters, 29 code points: it fits and is not cut.
  expect(cutLeft(path, stringWidth(path))).toBe(path);
  const cut = cutLeft(`~/${'✅'.repeat(10)}/src`, 10);
  expect(stringWidth(cut)).toBeLessThanOrEqual(10);
  expect(cut.startsWith('…')).toBe(true);
  expect(cut.endsWith('/src')).toBe(true);
});

test('a change title that fits by clusters is not cut from the left', () => {
  const title = `docs/${FAMILY.repeat(12)}.md`; // 32 cells, 68 code points
  const msg = { role: 'assistant', content: 'Done.', parts: [{ kind: 'change', change: { title, diff: '', added: 1, removed: 0, hidden: 0 } }] };
  // Room for the title and its counts, and far less than its 68 code points.
  const wrap = stringWidth(title) + 14;
  const rows = chatRows([msg] as never, { wrap, folds: { open: true, except: new Set() }, viewLines: 20, notes: 'step', detailsKey: '^o', renderers: {}, now: 0, palette: {} }).map(rowText);
  expect(rows.find((r) => r.startsWith('✎'))).toBe(`✎ ${title} · +1 −0`);
});

// ─── Carets by cluster ───────────────────────────────────────────────────────
// The caret stands on a whole cluster, at the column the editor moves it to: a CJK
// character or an emoji before it takes two cells, never one.
type Grid = { width: number; height: number; get(x: number, y: number): { char: string; style: { inverse?: boolean } } };
const caretCell = (backend: TestBackend) => {
  const buf = (backend as unknown as { lastBuffer: Grid }).lastBuffer;
  for (let y = 0; y < buf.height; y++) for (let x = 0; x < buf.width; x++) {
    const c = buf.get(x, y);
    if (c.style.inverse && c.char) return { x, y, char: c.char };
  }
  return null;
};
const fieldColumn = (backend: TestBackend, y: number, text: string) => {
  const line = backend.lastFrame!.split('\n')[y]!;
  return stringWidth(line.slice(0, line.indexOf(text)));
};

test("the chat field's caret stands after a CJK character and an emoji by their cells", async () => {
  const backend = new TestBackend(80, 24);
  // '日' is one UTF-16 unit, '🙂' two: the caret at 3 is right before `a`.
  const handle = await render(h(renderChatModal, { ...baseChat, input: '日🙂ab', cursor: 3 }), backend);
  const at = caretCell(backend)!;
  expect(at.char).toBe('a');
  expect(at.x).toBe(fieldColumn(backend, at.y, '日') + 4);
  handle.unmount();
  // On a cluster of several code points the caret cell is the whole of it.
  const rows = inputVisualRows('日👍🏽x', 1, 40);
  expect(rows[0]).toEqual({ before: '日', caret: '👍🏽', after: 'x', start: 0 });
});

test("the picker's rename field draws its caret on a whole cluster, after a CJK character and an emoji", async () => {
  const backend = new TestBackend(100, 24);
  // The caret at 3 stands on `👍🏽` — an emoji and its skin tone, one cluster.
  const picker = { ...pickerStart(PICKER_ROWS), mode: 'rename' as const, name: '日🙂👍🏽x', nameCaret: 3 };
  const handle = await render(h(renderChatModal, { ...baseChat, width: 100, picker }), backend);
  const at = caretCell(backend)!;
  expect(at.char).toBe('👍🏽');
  expect(at.x).toBe(fieldColumn(backend, at.y, '日') + 4);
  expect(backend.lastFrame).toContain('日🙂👍🏽x');
  handle.unmount();
});

test('a capped string is cut between clusters, never inside one', () => {
  expect(headClusters('ab', 5)).toBe('ab');
  expect(headClusters(`${'a'.repeat(59)}🙂tail`, 60)).toBe(`${'a'.repeat(59)}🙂`);
  expect(headClusters(`${'a'.repeat(59)}${FAMILY}tail`, 60)).toBe(`${'a'.repeat(59)}${FAMILY}`);
});

