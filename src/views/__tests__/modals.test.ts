import { expect, test } from 'bun:test';
import { createElement as h } from 'react';
import { render } from '@flowtty/react';
import { TestBackend } from '@flowtty/core/testing';
import { MODAL_COLOR_DEFAULTS } from '../../playback/theme.js';
import { helpEntries, inputVisualRows, mdLines, renderChatModal, renderHelp, renderLogModal, renderReminder } from '../modals.js';

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
      completions: { matches: ['compact', 'clear'], sel: 0 },
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
    h(renderChatModal, { ...baseChat, messages: [], input: '/c', cursor: 1, completions: { matches: ['compact', 'clear'], sel: 0 } }),
    backend,
  );
  expect(backend.lastFrame).not.toContain('/compact');
  // No row of candidates either — the hint line's own `⇧⇥ auto` is not one.
  expect(backend.lastFrame).not.toContain('⇥ clear');
  handle.unmount();
});

test('chat renders a todo plan capped at 5 active + one summary line', async () => {
  const backend = new TestBackend(100, 24);
  const handle = await render(
    h(renderChatModal, {
      ...baseChat,
      width: 100,
      messages: [],
      todo: [
        { id: 1, text: 'one', status: 'pending' },
        { id: 2, text: 'two', status: 'pending' },
        { id: 3, text: 'three', status: 'in_progress' },
        { id: 4, text: 'four', status: 'pending' },
        { id: 5, text: 'five', status: 'pending' },
        { id: 6, text: 'six', status: 'pending' }, // hides behind +1 pending
        { id: 7, text: 'seven', status: 'done' },
        { id: 8, text: 'eight', status: 'done' },
      ],
    }),
    backend,
  );
  // The in-progress item leads (◐), then pending ☐; hidden active is a summary.
  expect(backend.lastFrame).toContain('◐ 3 · three');
  expect(backend.lastFrame).toContain('☐ 1 · one');
  expect(backend.lastFrame).toContain('☐ 5 · five');
  expect(backend.lastFrame).not.toContain('☐ 6 · six');
  // A single summary line: `+N pending · M done` (one line, thin-bullet separated).
  expect(backend.lastFrame).toContain('+1 pending · 2 done');
  // The done items are counted, not listed individually.
  expect(backend.lastFrame).not.toContain('☑ 7 · seven');
  handle.unmount();
});

test('chat omits the summary line when nothing is hidden or done', async () => {
  const backend = new TestBackend(100, 24);
  const handle = await render(
    h(renderChatModal, {
      ...baseChat,
      width: 100,
      messages: [],
      // Two active items, both fit under the cap, none done — no summary line.
      todo: [
        { id: 1, text: 'a', status: 'pending' },
        { id: 2, text: 'b', status: 'pending' },
      ],
    }),
    backend,
  );
  expect(backend.lastFrame).toContain('☐ 1 · a');
  expect(backend.lastFrame).toContain('☐ 2 · b');
  expect(backend.lastFrame).not.toContain('pending');
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
      keys: { commandLine: [':'], quit: ['q'], chat: ['F'], log: ['L'], open: ['return'], disabled: [] },
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
  // A key the host does not act on is not listed as if it worked anywhere.
  const anywhere = rows.findIndex((r) => r.includes('Keys — anywhere'));
  const plugins = rows.findIndex((r) => r.includes("on a plugin's own screen"));
  const open = rows.findIndex((r) => /⏎\s+open/.test(r));
  expect(anywhere).toBeGreaterThanOrEqual(0);
  expect(open).toBeGreaterThan(plugins);
  // An unbound action is not offered at all.
  expect(frame).not.toContain('disabled');
  expect(frame).not.toContain('undefined');
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
