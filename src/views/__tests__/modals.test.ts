import { expect, test } from 'bun:test';
import { createElement as h } from 'react';
import { render } from '@flowtty/react';
import { TestBackend } from '@flowtty/core/testing';
import { MODAL_COLOR_DEFAULTS } from '../../playback/theme.js';
import { inputVisualRows, renderChatModal, renderHelp, renderLogModal, renderReminder } from '../modals.js';

// Task #20: the built-in modal renderers were deferred to an "empty-shell"
// integration test; here we drive them directly so the chat/help/log surfaces are
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
  // The person's message carries the input field's own prompt; the answer sits
  // under it in the same gutter, so the text lines up whoever speaks.
  expect(backend.lastFrame).toContain('› hello');
  expect(backend.lastFrame).toMatch(/ {2}hi there/);
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

test('chat draws the slash-command autocomplete candidate row', async () => {
  const backend = new TestBackend(80, 24);
  const handle = await render(
    h(renderChatModal, {
      ...baseChat,
      messages: [],
      completions: { matches: ['compact', 'clear'], sel: 0 },
    }),
    backend,
  );
  expect(backend.lastFrame).toContain('/compact');
  expect(backend.lastFrame).toContain('/clear');
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

test('log modal shows the session log entries', async () => {
  const backend = new TestBackend(80, 24);
  const handle = await render(
    h(renderLogModal, {
      width: 80,
      height: 24,
      theme: { modals: { log: { bg: undefined } } },
      logs: ['a', 'b'],
      logModalRows: 10,
      logScroll: 0,
    }),
    backend,
  );
  expect(backend.lastFrame).toContain('Session log');
  expect(backend.lastFrame).toContain('a');
  handle.unmount();
});

test('help modal shows the command list', async () => {
  const backend = new TestBackend(80, 24);
  const handle = await render(
    h(renderHelp, {
      width: 80,
      height: 24,
      theme: { modals: { help: { bg: undefined } } },
      helpOpen: true,
      helpText: 'a\nb',
    }),
    backend,
  );
  expect(backend.lastFrame).toContain('commands');
  expect(backend.lastFrame).toContain('a');
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
  expect(backend.lastFrame).toContain('Esc / Enter — dismiss');
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
  expect(two[1]).toEqual({ before: '', caret: '', after: '' });

  // Caret ON the blank line (right after the first newline).
  const on = at('first\n\nsecond', 6);
  expect(caretRow(on)).toBe(1);
  expect(on[1]).toEqual({ before: '', caret: ' ', after: '' });
  expect(on[2]).toEqual({ before: 'second', caret: '', after: '' });

  // Caret at the END of a line that is followed by a newline stays on that line.
  const end = at('first\n\nsecond', 5);
  expect(caretRow(end)).toBe(0);
  expect(end[0]).toEqual({ before: 'first', caret: ' ', after: '' });

  // Trailing blank lines: the caret is on the last one.
  const trailing = at('first\n\n', 7);
  expect(trailing).toHaveLength(3);
  expect(caretRow(trailing)).toBe(2);

  // A wrapped paragraph is unchanged: at the wrap point the caret opens the next row.
  const wrapped = inputVisualRows('aaaa bbbb', 5, 5);
  expect(caretRow(wrapped)).toBe(1);
});
