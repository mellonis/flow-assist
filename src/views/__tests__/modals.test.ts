import { expect, test } from 'bun:test';
import { createElement as h } from 'react';
import { render, stringWidth } from '@flowtty/react';
import { TestBackend } from '@flowtty/core/testing';
import { MODAL_COLOR_DEFAULTS } from '../../playback/theme.js';
import { chatRows, condenseRuns, diffPanelBody, diffPanelFileKeys, helpEntries, toolSummary, inputVisualRows, mdLines, chatRoom, renderChatModal, renderDiffPanel, treeBudget, renderHelp, renderLogModal, renderReminder, typedLines, type RowOpts } from '../modals.js';
import { fileDiffCounts } from '../../assistant/diff.js';
import { diffFileKey, type DiffSection, type FileDiff } from '../../assistant/working-tree.js';
import { askKey, askStart, type AskState } from '../../assistant/ask.js';
import { keyGlyph } from '../../playback/keys.js';
import { bumpViewRevision } from '../../assistant/views.js';
import { cutLeft, headClusters } from '../../cells.js';
import { pickerStart } from '../../assistant/session-picker.js';
import type { SessionRow } from '../../assistant/sessions.js';
import type { ChatMsg } from '../../assistant/conversation-types.js';

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
    const handle = await render(h(renderChatModal, { ...baseChat, theme, messages: [msg as ChatMsg], ...(now === undefined ? {} : { now }) }), backend);
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
  const handle = await render(h(renderChatModal, { ...baseChat, theme, messages: [shellMsg(interactive) as ChatMsg], folds: { open, except: new Set<string>() } }), backend);
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
  // and the formatted duration (3s) both appear.
  expect(backend.lastFrame).toContain('compact');
  expect(backend.lastFrame).toContain('3s');
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
    return backend.lastBuffer!.get(all[y]!.indexOf(text) + offset, y).style as { fg?: string; dim?: boolean };
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
  expect(entries.map((e) => e.usage)).toEqual(['ask [text]  (chat)', COMMANDS[3]!.usage ?? '', 'quit  (q)']);
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
    const ch = backend.lastBuffer!.get(x, y).char;
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

// ─── The lead-in above a pending question (ticket 5) ─────────────────────────
// The narration that led into an `ask_user` call is the context the question is read
// against, so while the question waits its last run draws unfolded and at full ink. A
// display condition only: the fold state is untouched, and the moment the question is
// answered the run folds again with the turn's older runs.
const LEAD_PARTS = [
  { kind: 'text', text: 'Read the log first.' },
  { kind: 'tools', runs: [{ name: 'read_file', outcome: 'ok' }] },
  { kind: 'reasoning', text: 'Weighing the branch.' },
  { kind: 'text', text: 'The branch is unclear.' },
  // A round that wrote nothing before the ask: its calls are a segment of their own.
  { kind: 'text', text: '' },
  { kind: 'tools', runs: [{ name: 'ask_user', outcome: 'ok' }] },
];
const leadMsg = { role: 'assistant', content: '', parts: LEAD_PARTS };
const leadOpts = (askPending?: boolean): RowOpts => ({
  wrap: 60, folds: { open: false, except: new Set() }, viewLines: 20, notes: 'step', detailsKey: '^o',
  renderers: {}, now: 0, palette: {}, ...(askPending ? { askPending } : {}),
});
// The chat drawn with the question in the field's place, at the ink it uses for a row.
const leadFrame = async (extra: Record<string, unknown>) => {
  const backend = new TestBackend(120, 30);
  const handle = await render(h(renderChatModal, {
    ...baseChat, width: 120, height: 30, messages: [leadMsg],
    pendingQuestion: askStart([{ question: 'Which branch?', options: [{ label: 'master' }, { label: 'develop' }] }]),
    ...extra,
  } as never), backend);
  const lines = (backend.lastFrame ?? '').split('\n');
  const grid = (backend as unknown as { lastBuffer: { get(x: number, y: number): { style: { dim?: boolean } } } }).lastBuffer;
  const dimAt = (text: string) => {
    const y = lines.findIndex((l) => l.includes(text));
    return y < 0 ? null : grid.get(lines[y]!.indexOf(text), y).style.dim === true;
  };
  handle.unmount();
  return { lines, dimAt };
};

test('the run before a pending question draws open and lit', async () => {
  // Folded: two chrome rows — one per run — and the thought between them.
  const folded = chatRows([leadMsg] as never, leadOpts());
  const foldedText = folded.map(rowText);
  expect(foldedText).toContain('▸ Read the log first.');
  expect(foldedText).toContain('▸ The branch is unclear.');
  expect(folded.some((r) => r.reasonHeader)).toBe(true);
  expect(folded.some((r) => r.reason)).toBe(false);

  // The question waits: the last run — the one the ask follows — draws each step in
  // full at full ink, and keeps its fold id so a click still folds it. The older run
  // and the thought keep their folded look.
  const lit = chatRows([leadMsg] as never, leadOpts(true));
  const litText = lit.map(rowText);
  expect(litText).toContain('The branch is unclear.');
  const lead = lit.find((r) => rowText(r) === 'The branch is unclear.');
  expect(lead?.quiet).not.toBe(true);
  expect(lead?.step).not.toBe(true);
  expect(lead?.fold).toBe('0:steps:1');
  expect(litText).toContain('▸ Read the log first.');
  expect(lit.some((r) => r.reasonHeader)).toBe(true);
  expect(lit.some((r) => r.reason)).toBe(false);

  // On the screen, one question or a wizard alike: the block in the field's place says
  // nothing about the rows — `pendingQuestion` alone leaves them folded, and only the
  // transcript's own flag lights the run. Lit, the run's rows are at full ink and the
  // folded run beside them is dim.
  const waiting = await leadFrame({});
  expect(waiting.dimAt('▸ The branch is unclear.')).toBe(true);
  const litFrame = await leadFrame({ askPending: true });
  expect(litFrame.dimAt('The branch is unclear.')).toBe(false);
  expect(litFrame.dimAt('▸ Read the log first.')).toBe(true);
  expect(litFrame.dimAt('▸ thought')).toBe(true);
});

test('the lead-in lights under a message drawn after it, and nowhere else', () => {
  // A view or a note lands below the turn's narration (a command's block, /compact's
  // line); the question is still read against the narration above it.
  const note = { role: 'note', content: 'compacted', summary: 'kept 12 messages' };
  const lit = chatRows([leadMsg, note] as never, leadOpts(true)).map(rowText);
  expect(lit).toContain('The branch is unclear.');
  expect(lit).toContain('▸ Read the log first.');
  // Without the flag, the same list folds it again.
  const folded = chatRows([leadMsg, note] as never, leadOpts()).map(rowText);
  expect(folded).toContain('▸ The branch is unclear.');
  // And an older turn is never the one lit: only the newest assistant message is.
  const older = { role: 'assistant', content: 'Done.' };
  const both = chatRows([leadMsg, older] as never, leadOpts(true)).map(rowText);
  expect(both).toContain('▸ The branch is unclear.');
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


// The live subagents under the field (ask-children-spec.md (agent tree)): one budget serves what is
// drawn and what a key may reach.
const room = (over: Record<string, unknown> = {}) => chatRoom({ width: 80, height: 24, input: '', ...over });
const budget = (over: Partial<Parameters<typeof treeBudget>[0]> = {}) => {
  const r = room();
  return treeBudget({ boxH: r.boxH, besides: r.besides, planFull: r.planFull, nodes: 9, max: 4, hidden: r.hidden, ...over });
};
const treeRowsOf = (...keys: string[]) => keys.map((key) => ({ key, text: `⚙ ${key} · working`, tone: 'work' as const }));

test('treeBudget gives min(max, nodes), nothing when hidden, and keeps four list rows with the whole plan', () => {
  expect(budget()).toBe(4);
  expect(budget({ nodes: 2 })).toBe(2);
  expect(budget({ nodes: 0 })).toBe(0);
  expect(budget({ max: 0 })).toBe(0);
  expect(budget({ hidden: true })).toBe(0);
  // 12 rows: border and padding 4, hint 2, field 2, list 4; the block's gap takes one more.
  const tight = { boxH: 12, besides: 4, planFull: 0 };
  expect(budget({ ...tight, boxH: 13 })).toBe(0);
  expect(budget({ ...tight, boxH: 14 })).toBe(1);
  expect(budget({ ...tight, boxH: 16 })).toBe(3);
  // The whole plan block counts before any tree row does.
  expect(budget({ ...tight, boxH: 17, planFull: 3 })).toBe(0);
  expect(budget({ ...tight, boxH: 18, planFull: 3 })).toBe(1);
});

test('chatRoom says hidden for a question, a y/n, /context, the pager, the picker and a panel', () => {
  expect(room().hidden).toBe(false);
  expect(room({ pendingConfirm: { name: 'run_command', args: '{}' } }).hidden).toBe(true);
  expect(room({ pendingQuestion: askStart([{ question: 'q?', header: 'h', options: [{ label: 'a', description: 'd' }, { label: 'b', description: 'e' }] }] as never) }).hidden).toBe(true);
  expect(room({ pager: { rows: [], title: 't' } }).hidden).toBe(true);
  expect(room({ watch: { path: ['a'], rows: [], state: '', ended: false, ask: null } }).hidden).toBe(true);
  expect(room({ panel: {} }).hidden).toBe(true);
});

test('the chat draws the tree as the last block: one line per row, the cursor row inverted, the stop question in its place, the keys in the hint row', async () => {
  const rows = treeRowsOf('a', 'b');
  const draw = async (tree: unknown) => {
    const backend = new TestBackend(80, 24);
    const handle = await render(h(renderChatModal, { ...baseChat, tree } as never), backend);
    const frame = backend.lastFrame ?? '';
    handle.unmount();
    return frame.split('\n');
  };
  const quiet = await draw({ rows, more: 0, cursor: null, ask: null });
  const at = quiet.findIndex((l) => l.includes('⚙ a · working'));
  expect(at).toBeGreaterThan(quiet.findIndex((l) => l.includes('› ')));
  expect(quiet[at + 1]).toContain('⚙ b · working');
  // The block is its rows alone: nothing under the last one.
  expect(quiet.slice(at + 2).join('').replace(/[│╰╯─\s]/g, '')).toBe('');
  expect(quiet.join('\n')).not.toContain('x stop');
  expect(quiet.join('\n')).toContain('history');
  const onB = await draw({ rows, more: 0, cursor: 'b', ask: null });
  expect(onB.join('\n')).toContain('↑↓ move · x stop · Esc back');
  expect(onB.join('\n')).not.toContain('history');
  expect(onB[onB.findIndex((l) => l.includes('⚙ b · working')) + 1] ?? '').not.toContain('x stop');
  const asking = await draw({ rows, more: 0, cursor: 'b', ask: 'stop b? y yes · n no' });
  const q = asking.findIndex((l) => l.includes('stop b? y yes · n no'));
  expect(q).toBe(asking.findIndex((l) => l.includes('⚙ a · working')) + 1);
  expect(asking.join('\n')).not.toContain('⚙ b · working');
});

test('the cursor row is drawn inverse, the others are not, and the block is out of every selection', async () => {
  const backend = new TestBackend(80, 24);
  const rows = treeRowsOf('a', 'b');
  const handle = await render(h(renderChatModal, { ...baseChat, tree: { rows, more: 0, cursor: 'b', ask: null } } as never), backend);
  const lines = backend.lastFrame!.split('\n');
  const y = (t: string) => lines.findIndex((l) => l.includes(t));
  const grid = (backend as unknown as { lastBuffer: Grid }).lastBuffer;
  const inverseOn = (row: number) => { for (let x = 0; x < grid.width; x++) { const c = grid.get(x, row); if (c.style.inverse && c.char.trim()) return true; } return false; };
  expect(inverseOn(y('⚙ b · working'))).toBe(true);
  expect(inverseOn(y('⚙ a · working'))).toBe(false);
  // A selection over the rows takes nothing of them.
  const text = handle.select({ x: 0, y: y('⚙ a · working') }, { x: 79, y: y('⚙ b · working') });
  expect(text).not.toContain('working');
  handle.unmount();
});

test('the tree is not drawn under a y/n, and a row is cut to one line', async () => {
  const backend = new TestBackend(40, 24);
  const long = [{ key: 'a', text: `⚙ ${'w'.repeat(80)}`, tone: 'work' as const }];
  const handle = await render(h(renderChatModal, { ...baseChat, width: 40, tree: { rows: long, more: 0, cursor: null, ask: null } } as never), backend);
  const frame = backend.lastFrame ?? '';
  handle.unmount();
  expect(frame.split('\n').filter((l) => l.includes('wwww'))).toHaveLength(1);
  const b2 = new TestBackend(80, 60);
  const h2 = await render(h(renderChatModal, { ...baseChat, height: 60, pendingConfirm: { name: 'run_command', args: '{}' }, tree: { rows: treeRowsOf('a'), more: 0, cursor: null, ask: null } } as never), b2);
  expect(b2.lastFrame).not.toContain('⚙ a · working');
  h2.unmount();
});

// A watched child (ask-children-spec.md (watching a child)): its rows in the list's place under a
// breadcrumb title, the hint row naming what it does and the keys, and none of the session's
// plan, queue, field, completion or tree.
test('the chat draws a watched child: breadcrumb title, its rows, state and keys in the hint row, no field, tree or plan', async () => {
  const o: RowOpts = { wrap: 60, folds: { open: false, except: new Set() }, viewLines: 20, notes: 'step', detailsKey: '^o', renderers: {}, now: 0, palette: {} };
  const rows = chatRows([{ role: 'user', content: 'child task' }, { role: 'assistant', content: 'child words' }], o);
  const draw = async (watch: Record<string, unknown>) => {
    const backend = new TestBackend(100, 24);
    const handle = await render(h(renderChatModal, {
      ...baseChat, width: 100, messages: [{ role: 'user', content: 'session words' }], queued: ['queued thing'], input: 'draft text',
      todo: [{ id: '1', text: 'session plan item', status: 'pending' }], tree: { rows: treeRowsOf('a'), more: 0, cursor: null, ask: null },
      watch: { path: ['outer', 'inner'], rows, state: '⚙ read_file(a.ts)', ended: false, ask: null, ...watch },
    } as never), backend);
    const frame = backend.lastFrame ?? '';
    handle.unmount();
    return frame;
  };
  const live = await draw({});
  expect(live).toContain('╭─ ƒ Flow Assist · outer › inner');
  expect(live).toContain('child words');
  expect(live).not.toContain('session words');
  for (const hidden of ['draft text', 'queued thing', 'session plan item', '⚙ a · working', 'history']) expect(live).not.toContain(hidden);
  const hint = live.split('\n').find((l) => l.includes('⚙ read_file(a.ts)'))!;
  expect(hint).toMatch(/⚙ read_file\(a\.ts\)\s+x stop · Esc back/);
  const asking = await draw({ ask: 'stop inner? y yes · n no' });
  expect(asking).toMatch(/stop inner\? y yes · n no\s+x stop · Esc back/);
  expect(asking).not.toContain('⚙ read_file(a.ts)');
  const ended = await draw({ state: 'ended: done', ended: true });
  expect(ended).toMatch(/ended: done\s+Esc back/);
  expect(ended).not.toContain('x stop');
});

// ─── /diff: the panel's rows ──────────────────────────────────────────────────
// The renderer takes what `workingTreeDiff` answered and draws it: a header per
// section, a row per file, and the file's whole hunks while it is open. Every row is
// one terminal line. A relative path repeats across two roots, so the fold and the
// cursor are keyed `diffFileKey(root, path)` and each section folds on its own.

// Draw the panel at the width the chat will hand it, and read back the frame.
async function diffFrame(props: {
  sections: DiffSection[];
  collapsed: ReadonlySet<string>;
  cursor: string | null;
  palette?: Record<string, string | undefined>;
  loading?: boolean;
  gitless?: boolean;
  failed?: boolean;
}) {
  const backend = new TestBackend(80, 24);
  const handle = await render(h(renderDiffPanel, {
    ...props,
    gitless: props.gitless ?? false,
    failed: props.failed ?? false,
    wrap: 74,
    bg: 'black',
  }), backend);
  const frame = backend.lastFrame ?? '';
  return { frame, handle, backend };
}

test('the diff panel lists a file with its hunks and folds what is collapsed', async () => {
  const section: DiffSection = {
    root: '/r',
    files: [{ status: 'M', path: 'a.txt', added: 1, removed: 1, hunks: '@@ -1 +1 @@\n-one\n+two' }],
  };
  const key = diffFileKey('/r', 'a.txt');
  const open = await diffFrame({ sections: [section], collapsed: new Set(), cursor: key });
  // The header counts the section, the row says which file and how much it changed.
  expect(open.frame).toContain('diff · 1 file +1 −1 · vs HEAD');
  expect(open.frame).toContain('▾ M a.txt');
  // The hunks are drawn whole, each row a line of its own with the FILE's number in
  // the gutter; the `@@` row is not drawn — the numbers say what it says, per row.
  expect(open.frame).toContain('-one');
  expect(open.frame).toContain('+two');
  expect(open.frame).toMatch(/1 -one/);
  expect(open.frame).toMatch(/1 \+two/);
  expect(open.frame).not.toContain('@@');
  open.handle.unmount();

  // The count says one file, and files above it.
  const two: DiffSection = {
    ...section,
    files: [section.files[0]!, { status: 'A', path: 'b.txt', added: 2, removed: 0, hunks: '@@ -0,0 +1,2 @@\n+p\n+q' }],
  };
  const plural = await diffFrame({ sections: [two], collapsed: new Set(), cursor: null });
  expect(plural.frame).toContain('diff · 2 files +3 −1 · vs HEAD');
  plural.handle.unmount();

  const folded = await diffFrame({ sections: [section], collapsed: new Set([key]), cursor: key });
  expect(folded.frame).toMatch(/▸ M a\.txt/);
  expect(folded.frame).not.toContain('-one');
  expect(folded.frame).not.toContain('+two');
  folded.handle.unmount();
});

test('the diff panel says the tree is clean when there is nothing to show', async () => {
  const none = await diffFrame({ sections: [], collapsed: new Set(), cursor: null });
  expect(none.frame).toContain('no changes in the working tree');
  none.handle.unmount();

  // A section that holds no files is the same nothing: no header, no rows.
  const empty: DiffSection = { root: '/r', files: [] };
  const blank = await diffFrame({ sections: [empty], collapsed: new Set(), cursor: null });
  expect(blank.frame).toContain('no changes in the working tree');
  expect(blank.frame).not.toContain('diff ·');
  blank.handle.unmount();
});

test('the diff panel distinguishes no repository from a clean tree, and says what a walk does', async () => {
  const none = await diffFrame({ sections: [], collapsed: new Set(), cursor: null, gitless: true });
  expect(none.frame).toContain('not a git repository');
  expect(none.frame).not.toContain('no changes in the working tree');
  none.handle.unmount();

  // git that failed is its own answer: not "not a git repository" — a repository was
  // found — and never "no changes in the working tree", which would be a claim.
  const failed = await diffFrame({ sections: [], collapsed: new Set(), cursor: null, failed: true });
  expect(failed.frame).toContain('git could not read the working tree');
  expect(failed.frame).not.toContain('no changes in the working tree');
  expect(failed.frame).not.toContain('not a git repository');
  failed.handle.unmount();

  const loading = await diffFrame({ sections: [], collapsed: new Set(), cursor: null, loading: true });
  expect(loading.frame).toContain('reading the working tree…');
  loading.handle.unmount();
});

// What one top could not read is still said where other sections draw: a walk that
// silently dropped a broken top would show a partial tree as the whole one.
test('a walk that read only part of the tree says so under the sections', async () => {
  const section: DiffSection = {
    root: '/r',
    files: [{ status: 'M', path: 'a.txt', added: 1, removed: 1, hunks: '@@ -1 +1 @@\n-one\n+two' }],
  };
  const drawn = await diffFrame({ sections: [section], collapsed: new Set(), cursor: null, failed: true });
  expect(drawn.frame).toContain('diff · 1 file');
  expect(drawn.frame).toContain('git could not read part of the working tree');
  drawn.handle.unmount();
});

test('a file the panel cannot show says why, in its row and under it when open', async () => {
  const files: FileDiff[] = [
    { status: 'M', path: 'img.png', added: 0, removed: 0, hunks: '', note: 'binary' },
    { status: 'M', path: 'dump.sql', added: 0, removed: 0, hunks: '', note: 'too large' },
  ];
  const section: DiffSection = { root: '/r', files };
  const open = await diffFrame({ sections: [section], collapsed: new Set(), cursor: null });
  expect(open.frame).toMatch(/▾ M img\.png · binary, not shown/);
  expect(open.frame).toMatch(/▾ M dump\.sql · too large, not shown/);
  // Open, the reason is the file's one line in place of hunks.
  expect(open.frame).toContain('binary — not shown');
  expect(open.frame).toContain('too large — not shown');
  open.handle.unmount();

  // Folded, the row is all there is to say.
  const folded = await diffFrame({ sections: [section], collapsed: new Set([diffFileKey('/r', 'img.png')]), cursor: null });
  expect(folded.frame).toMatch(/▸ M img\.png · binary, not shown/);
  expect(folded.frame).not.toContain('binary — not shown');
  folded.handle.unmount();
});

test('two sections keep their own header, totals and fold', async () => {
  const sections: DiffSection[] = [
    {
      root: '/a',
      files: [{ status: 'M', path: 'a.txt', added: 2, removed: 1, hunks: '@@ -1 +1 @@\n-x\n+y\n+z' }],
    },
    {
      root: '/b',
      files: [{ status: 'A', path: 'a.txt', added: 3, removed: 0, hunks: '@@ -0,0 +1,3 @@\n+p\n+q\n+r' }],
    },
  ];
  const folded = await diffFrame({ sections, collapsed: new Set([diffFileKey('/a', 'a.txt')]), cursor: null });
  // Each section sums its own files, under its own header.
  expect(folded.frame).toContain('diff · 1 file +2 −1 · vs HEAD');
  expect(folded.frame).toContain('diff · 1 file +3 −0 · vs HEAD');
  // The same relative path is two rows, and folding one leaves the other open.
  expect(folded.frame).toMatch(/▸ M a\.txt/);
  expect(folded.frame).toMatch(/▾ A a\.txt/);
  expect(folded.frame).not.toContain('-x');
  expect(folded.frame).toContain('+p');
  folded.handle.unmount();
});

test('a file row says what it changed, in the palette the chat hands over', async () => {
  // The counts are `fileDiffCounts`', the same wording the chat's `✎` line uses.
  expect(fileDiffCounts({ added: 12, removed: 3 })).toBe('· +12 −3');
  expect(fileDiffCounts({ added: 0, removed: 0, note: 'binary' })).toBe('· binary, not shown');
  expect(fileDiffCounts({ added: 0, removed: 0, note: 'too large' })).toBe('· too large, not shown');

  const section: DiffSection = {
    root: '/r',
    files: [{ status: 'M', path: 'src/app.ts', added: 12, removed: 3, hunks: '@@ -1,3 +1,12 @@\n-gone\n+here' }],
  };
  const drawn = await diffFrame({
    sections: [section], collapsed: new Set(), cursor: diffFileKey('/r', 'src/app.ts'),
    palette: { accent: 'cyan', ok: 'green', warn: 'yellow' },
  });
  expect(drawn.frame).toContain('· +12 −3');
  const rows = drawn.frame.split('\n');
  const rowOf = (text: string) => {
    const y = rows.findIndex((r) => r.includes(text));
    expect(y).toBeGreaterThanOrEqual(0);
    return y;
  };
  const fgAt = (text: string) => drawn.backend.lastBuffer!.get(rows[rowOf(text)]!.indexOf(text), rowOf(text)).style.fg;
  // The cursor's file is the lit one — its path in the accent — and a hunk row takes
  // the palette's `ok` for what came in, `warn` for what went out.
  expect(fgAt('src/app.ts')).toBe('cyan');
  expect(fgAt('+here')).toBe('green');
  expect(fgAt('-gone')).toBe('yellow');
  // The line number is chrome: a drag over the row copies the code and not the gutter.
  const y = rowOf('-gone');
  const drag = drawn.handle.select({ x: 2, y }, { x: 30, y });
  expect(drag).not.toContain('1');
  expect(drag).toContain('-gone');
  drawn.handle.unmount();
});

test('a hunk longer than the chat\'s 80-line cap is drawn whole', async () => {
  // `unifiedDiff`'s 80 lines are the in-chat `✎` block's cap; the panel is a reader and
  // draws every row the section holds, however tall.
  const added = Array.from({ length: 100 }, (_, i) => `+line ${i + 1}`).join('\n');
  const section: DiffSection = {
    root: '/r',
    files: [{ status: 'M', path: 'big.txt', added: 100, removed: 0, hunks: `@@ -0,0 +1,100 @@\n${added}` }],
  };
  const backend = new TestBackend(80, 130);
  const handle = await render(h(renderDiffPanel, { sections: [section], collapsed: new Set<string>(), cursor: null, wrap: 74, gitless: false, failed: false, bg: 'black' }), backend);
  const frame = backend.lastFrame ?? '';
  // Every added line is a row of its own: the last one is drawn and nothing is counted
  // away, which a cap on the rows would do.
  expect(frame.split('\n').filter((l) => /\+line \d+/.test(l))).toHaveLength(100);
  expect(frame).toContain('+line 100');
  expect(frame).not.toMatch(/… \d+/);
  handle.unmount();
});

test('the cursor file\'s row is drawn inverse, and a reader without colour still sees it', async () => {
  const section: DiffSection = {
    root: '/r',
    files: [
      { status: 'M', path: 'a.txt', added: 1, removed: 1, hunks: '@@ -1 +1 @@\n-one\n+two' },
      { status: 'A', path: 'b.txt', added: 1, removed: 0, hunks: '@@ -0,0 +1 @@\n+new' },
    ],
  };
  const backend = new TestBackend(80, 24);
  const handle = await render(h(renderDiffPanel, { sections: [section], collapsed: new Set<string>(), cursor: diffFileKey('/r', 'b.txt'), wrap: 74, gitless: false, failed: false, bg: 'black' }), backend);
  const lines = (backend.lastFrame ?? '').split('\n');
  const y = (t: string) => {
    const at = lines.findIndex((l) => l.includes(t));
    expect(at).toBeGreaterThanOrEqual(0);
    return at;
  };
  const grid = (backend as unknown as { lastBuffer: Grid }).lastBuffer;
  const inverseAt = (text: string) => grid.get(lines[y(text)]!.indexOf(text), y(text)).style.inverse === true;
  expect(inverseAt('b.txt')).toBe(true);
  expect(inverseAt('a.txt')).toBe(false);
  handle.unmount();
});

test('the file row\'s lead and counts are chrome: a drag takes the path, and the hunks still copy', async () => {
  const section: DiffSection = {
    root: '/r',
    files: [{ status: 'M', path: 'a.txt', added: 1, removed: 1, hunks: '@@ -1 +1 @@\n-one\n+two' }],
  };
  const drawn = await diffFrame({ sections: [section], collapsed: new Set(), cursor: null });
  const lines = drawn.frame.split('\n');
  const at = lines.findIndex((l) => l.includes('▾ M a.txt'));
  expect(at).toBeGreaterThanOrEqual(0);
  const lead = lines[at]!.indexOf('▾ M a.txt');
  // A drag that starts on `▾ M` and runs past the counts brings the path and nothing of
  // the chrome around it — the same rule the chat's own rows keep.
  const row = drawn.handle.select({ x: lead, y: at }, { x: lead + 16, y: at }).trim();
  expect(row).toBe('a.txt');
  // The hunks are the thing a reader copies, and they stay selectable.
  const hunk = lines.findIndex((l) => l.includes('+two'));
  expect(drawn.handle.select({ x: 2, y: hunk }, { x: 20, y: hunk })).toContain('+two');
  drawn.handle.unmount();
});

test('a panel with nothing to show yet says a walk is running, not that the tree is clean', async () => {
  const walking = await diffFrame({ sections: [], collapsed: new Set(), cursor: null, loading: true });
  expect(walking.frame).toContain('reading the working tree…');
  expect(walking.frame).not.toContain('no changes');
  walking.handle.unmount();
});

// ─── /diff: the split ─────────────────────────────────────────────────────────
// Wide enough for two halves, the panel stands beside the conversation and the field
// strip runs below both; narrower, the panel is the column's last block, under the
// field. The panel's rows and its ↑/↓ order come from ONE walk (`diffPanelBody`), which
// is what keeps a drawn row and the cursor's index from disagreeing.
const splitSections: DiffSection[] = [{
  root: '/r',
  files: [{ status: 'M', path: 'a.txt', added: 1, removed: 1, hunks: '@@ -1 +1 @@\n-one\n+two' }],
}];
const splitPanel = { sections: splitSections, collapsed: new Set<string>(), cursor: diffFileKey('/r', 'a.txt'), gitless: false, failed: false };

test('the panel stands beside the conversation in a wide chat', async () => {
  const wide = new TestBackend(160, 40);
  const w = await render(h(renderChatModal, { ...baseChat, width: 160, height: 40, messages: [{ role: 'user', content: 'hello' }], diffPanel: splitPanel, contextBadge: 'ctx 12%' }), wide);
  const lines = (wide.lastFrame ?? '').split('\n');
  const row = (t: string) => {
    const y = lines.findIndex((l) => l.includes(t));
    expect(y).toBeGreaterThanOrEqual(0);
    return { y, x: lines[y]!.indexOf(t) };
  };
  const header = row('diff · 1 file');
  // A column of its own, right of the conversation's text, with the hunks as rows.
  expect(header.x).toBeGreaterThan(60);
  expect(row('› hello').x).toBeLessThan(40);
  expect(lines.filter((l) => l.includes('+two'))).toHaveLength(1);
  // The field keeps its place below both halves: the strip runs full width under them —
  // its hint crosses the split's width — and its rows start under the panel's bottom.
  expect(row('⏎ send').y).toBeGreaterThan(header.y);
  const bottom = lines.findIndex((l, i) => i >= header.y && l.includes('╰'));
  expect(bottom).toBeGreaterThan(header.y);
  expect(row('⏎ send').y).toBeGreaterThan(bottom);
  const hint = row('ctx');
  expect(hint.x).toBeGreaterThan(header.x);
  w.unmount();
});

test('the panel is the column\'s last block under the field in a narrow chat', async () => {
  // Two halves would leave each less than the panel's least: one column, and the panel
  // is its last block — below the field, never beside it.
  const narrow = new TestBackend(80, 24);
  const n = await render(h(renderChatModal, { ...baseChat, diffPanel: splitPanel }), narrow);
  const nlines = (narrow.lastFrame ?? '').split('\n');
  const nheader = nlines.findIndex((l) => l.includes('diff · 1 file'));
  expect(nheader).toBeGreaterThan(nlines.findIndex((l) => l.includes('⏎ send')));
  expect(nlines[nheader]!).not.toContain('›');
  // The panel is the column's last block: its bottom border closes the frame, and nothing
  // of the chat — the field's row, the person's message, its own header — is drawn under it.
  const bottom = nlines.findIndex((l, i) => i >= nheader && l.includes('╰'));
  expect(bottom).toBeGreaterThan(nheader);
  expect(nlines.slice(bottom + 1).every((l) => !/⏎ send|›|diff ·/.test(l))).toBe(true);
  n.unmount();
});

test('a chat with no panel draws the same with or without the prop', async () => {
  const draw = async (extra: Record<string, unknown>) => {
    const backend = new TestBackend(100, 28);
    const handle = await render(h(renderChatModal, {
      ...baseChat, width: 100, height: 28, messages: [{ role: 'user', content: 'hello' }],
      todo: [{ id: 't1', text: 'a step', status: 'pending' }], ...extra,
    }), backend);
    const frame = backend.lastFrame ?? '';
    handle.unmount();
    return frame;
  };
  expect(await draw({ diffPanel: null })).toBe(await draw({}));
});

test('the body is one walk: the files ↑/↓ move among, in the drawn order, and the cursor row', () => {
  const sections: DiffSection[] = [{
    ...splitSections[0]!,
    files: [
      splitSections[0]!.files[0]!,
      { status: 'A', path: 'b.txt', added: 1, removed: 0, hunks: '@@ -0,0 +1 @@\n+new' },
    ],
  }];
  const a = diffFileKey('/r', 'a.txt');
  const b = diffFileKey('/r', 'b.txt');
  expect(diffPanelFileKeys(sections)).toEqual([a, b]);
  // The header is the first row; with the first file folded the second sits under it.
  const body = diffPanelBody({ sections, collapsed: new Set([a]), cursor: b, wrap: 40, gitless: false, failed: false });
  expect(body.cursorRow).toBe(2);
  // Every file is expanded by default: the folded one stops at its row, the other
  // draws its hunks under it.
  expect(body.rows.map((r) => (r as { key: string | null }).key)).toEqual(['s0', 'f0-0', 'f0-1', 'h0-1-0']);
  // A refresh that finds no such file: nothing to scroll to, the rows still drawn.
  const gone = diffPanelBody({ sections, collapsed: new Set([a]), cursor: 'missing', wrap: 40, gitless: false, failed: false });
  expect(gone.cursorRow).toBe(-1);
  expect(gone.rows).toHaveLength(4);
});

// ─── The question wizard (ticket 4) ─────────────────────────────────────────
// A call with more than one question is a wizard: one page per question under a tab
// strip, then a submit page that shows what its Enter will send. The single-question
// box has no strip and no submit page, and draws as it always has.
type AskGrid = { width: number; height: number; get(x: number, y: number): { char: string; style: { inverse?: boolean; dim?: boolean } } };
const twoQuestions = () => askStart([
  { question: 'Which one?', header: 'First', options: [{ label: 'alpha' }, { label: 'beta' }] },
  { question: 'Where?', header: 'Second', options: [{ label: 'x' }, { label: 'y' }] },
]);
const askFrame = async (state: AskState, width = 120) => {
  const backend = new TestBackend(width, 30);
  const handle = await render(h(renderChatModal, { ...baseChat, width, height: 30, pendingQuestion: state } as never), backend);
  const lines = (backend.lastFrame ?? '').split('\n');
  const grid = (backend as unknown as { lastBuffer: AskGrid }).lastBuffer;
  handle.unmount();
  return { lines, grid };
};

test('a one-question box keeps its own hint and grows no strip', async () => {
  const one = askStart([{ question: 'Which one?', header: 'First', options: [{ label: 'alpha' }, { label: 'beta' }] }]);
  const { lines } = await askFrame(one);
  const text = lines.join('\n');
  // The single question answers in its own keys — the digits still pick — and has no
  // pages to walk and no strip to walk them on.
  expect(text).toContain(`${keyGlyph('up')}${keyGlyph('down')} move · ${keyGlyph('return')} or a digit to answer · type your own words · ${keyGlyph('escape')} dismiss`);
  expect(text).not.toContain('←→');
  expect(text).not.toContain('✓');
});

test('the ask box draws the tabs strip and the submit page', async () => {
  // Page one answered with its first option, so the strip says so on page two.
  const answered = askKey(twoQuestions(), { name: '1' });
  const { lines, grid } = await askFrame(answered);
  const stripY = lines.findIndex((l) => l.includes('✓ First') && l.includes('Second'));
  expect(stripY).toBeGreaterThanOrEqual(0);
  const x = (text: string) => lines[stripY]!.indexOf(text);
  const inverseAt = (text: string) => {
    for (let i = 0; i < text.length; i++) if (grid.get(x(text) + i, stripY).style.inverse) return true;
    return false;
  };
  // One strip row: both tabs on it, the page on screen inverse, the answered one not.
  expect(inverseAt('Second')).toBe(true);
  expect(inverseAt('First')).toBe(false);
  expect(lines.join('\n')).toContain(
    `${keyGlyph('left')}${keyGlyph('right')} questions · ${keyGlyph('up')}${keyGlyph('down')} move · ${keyGlyph('return')} answer · type your own words · ${keyGlyph('escape')} dismiss`);

  // The submit page (page three of three): every question's title dim, its answer at
  // full ink — or `(not answered)` dim — and the hint naming the keys that act there.
  const submitting = askKey(answered, { name: 'right' });
  const sub = await askFrame(submitting);
  const row = (text: string) => sub.lines.findIndex((l) => l.includes(text));
  const dimAt = (text: string) => sub.grid.get(sub.lines[row(text)]!.indexOf(text), row(text)).style.dim === true;
  expect(row('First — Which one?')).toBeGreaterThanOrEqual(0);
  expect(dimAt('First — Which one?')).toBe(true);
  expect(dimAt('alpha')).toBe(false);
  expect(dimAt('Second — Where?')).toBe(true);
  expect(dimAt('(not answered)')).toBe(true);
  expect(sub.lines.findIndex((l) => l.includes('✓ First') && l.includes('Submit'))).toBeGreaterThanOrEqual(0);
  const text = sub.lines.join('\n');
  expect(text).toContain(`${keyGlyph('left')}${keyGlyph('right')} questions · ${keyGlyph('return')} submit · ${keyGlyph('escape')} dismiss`);
  // The page is the sum, not a question: no option list and no free-text row.
  expect(text).not.toContain('Other…');

  // A wide label is cut by cells, so the strip stays ONE row between the title and the
  // list: a tab never pushes a row onto a second line.
  const wide = askStart([
    { question: 'One?', header: `${'🙂'.repeat(20)} first`, options: [{ label: 'a' }, { label: 'b' }] },
    { question: 'Two?', header: `${'回答'.repeat(20)} second`, options: [{ label: 'a' }, { label: 'b' }] },
    { question: 'Three?', header: 'third', options: [{ label: 'a' }, { label: 'b' }] },
  ]);
  const narrow = await askFrame(wide, 80);
  const title = narrow.lines.findIndex((l) => l.includes('? 1/3'));
  expect(title).toBeGreaterThanOrEqual(0);
  expect(narrow.lines[title + 2]).toContain('1. a');
});
