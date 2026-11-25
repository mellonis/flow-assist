import { expect, test } from 'bun:test';
import { createElement as h } from 'react';
import { render, stringWidth } from '@flowtty/react';
import { TestBackend } from '@flowtty/core/testing';
import { MODAL_COLOR_DEFAULTS } from '../../playback/theme.js';
import { chatRows, condenseRuns, diffFileMove, diffFirstItem, diffHunkMove, diffLastItem, diffPanelBody, diffPanelFileKeys, diffPanelItems, helpEntries, toolSummary, inputVisualRows, mdLines, chatRoom, nextFoldLevel, pagerTitle, pendingChatRows, renderChatModal, renderCommandPanel, renderDiffPanel, renderHelp, renderLogModal, renderReminder, typedLines, type CommandPanelView, type DiffCursor, type RowOpts } from '../modals.js';
import { renderConsole } from '../../assistant/console-view.js';
import { changeView, unifiedDiff, CHANGE_DRAW_MAX_LINES, fileDiffCounts, type ChangeView } from '../../assistant/diff.js';
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

// A kept question and its answer are one block, not two loose lines: both rows sit on
// a quiet ground of their own, the question and the answer in `askInk`. A dismissed
// answer keeps the ground and its ink steps back, so a question nobody answered is
// still one band on the screen.
test('answered question rows carry the ask ground', async () => {
  // Colours the test can tell apart from every other ground and ink the chat ships: the
  // rows take the palette's tokens, whatever a scheme's own values are.
  const chat = { ...MODAL_COLOR_DEFAULTS.chat, askBg: 'blue', askInk: 'yellow' };
  const messages = [
    { role: 'ask', content: 'Which branch?', answer: 'master' },
    { role: 'ask', content: 'Which checks?', answer: 'dismissed', dismissed: true },
  ];
  const backend = new TestBackend(80, 24);
  const handle = await render(
    h(renderChatModal, {
      ...baseChat,
      theme: { modals: { chat } },
      messages,
    }),
    backend,
  );
  const lines = backend.lastFrame.split('\n');
  const find = (needle: string) => {
    const y = lines.findIndex((r) => r.includes(needle));
    expect(y).toBeGreaterThanOrEqual(0);
    const row = lines[y]!;
    return { y, row, x: row.indexOf(needle) };
  };
  const styleAt = (needle: string) => {
    const { y, x } = find(needle);
    return backend.lastBuffer!.get(x, y).style;
  };
  // The question and its answer on one ground, in the palette's own ink.
  const question = styleAt('Which branch?');
  expect(question.bg).toBe(chat.askBg);
  expect(question.fg).toBe(chat.askInk);
  const answer = styleAt('master');
  expect(answer.bg).toBe(chat.askBg);
  expect(answer.fg).toBe(chat.askInk);
  expect(answer.dim).toBeFalsy();
  // The ground runs across the message column, so the pair reads as one band while
  // scanning — not a tint that stops at the end of the words.
  const { y, row, x } = find('Which branch?');
  const border = row.lastIndexOf('│');
  const right = border >= 0 ? border - 2 : row.trimEnd().length - 1;
  expect(right).toBeGreaterThan(x + 'Which branch?'.length);
  expect(backend.lastBuffer!.get(right, y).style.bg).toBe(chat.askBg);
  // The gutters keep their place and their glyphs: `?` over the question, `→` under it,
  // both painted on the same band.
  expect(lines[y]![x - 2]).toBe('?');
  expect(backend.lastBuffer!.get(x - 2, y).style.bg).toBe(chat.askBg);
  const arrow = find('master');
  expect(lines[arrow.y]![arrow.x - 2]).toBe('→');
  expect(backend.lastBuffer!.get(arrow.x - 2, arrow.y).style.bg).toBe(chat.askBg);
  // A dismissed answer keeps the ground and dims its ink.
  const gone = styleAt('dismissed');
  expect(gone.bg).toBe(chat.askBg);
  expect(gone.fg).toBe(chat.askInk);
  expect(gone.dim).toBe(true);
  handle.unmount();
  // The palette is read when the row is drawn: changing a token repaints the rows the
  // conversation already has, with no reload.
  const second = new TestBackend(80, 24);
  const again = await render(
    h(renderChatModal, { ...baseChat, theme: { modals: { chat: { ...chat, askBg: 'red', askInk: 'green' } } }, messages }),
    second,
  );
  const repainted = second.lastFrame.split('\n');
  const y2 = repainted.findIndex((r) => r.includes('Which branch?'));
  const cell = second.lastBuffer!.get(repainted[y2]!.indexOf('Which branch?'), y2).style;
  expect(cell.bg).toBe('red');
  expect(cell.fg).toBe('green');
  again.unmount();
});

// A question or an answer wider than the column wraps: every row of the pair keeps the
// band, out to the column's edge — not only the first row of each.
test('a wrapped question paints the ask ground on every continuation row', async () => {
  const chat = { ...MODAL_COLOR_DEFAULTS.chat, askBg: 'blue', askInk: 'yellow' };
  const backend = new TestBackend(80, 24);
  const handle = await render(
    h(renderChatModal, {
      ...baseChat,
      theme: { modals: { chat } },
      messages: [{ role: 'ask', content: 'q'.repeat(160), answer: 'a'.repeat(160) }],
    }),
    backend,
  );
  const lines = backend.lastFrame.split('\n');
  const rowsOf = (ch: string) => lines.map((row, i) => ({ row, i })).filter(({ row }) => row.includes(ch.repeat(3)));
  const pair = [...rowsOf('q'), ...rowsOf('a')];
  const q = rowsOf('q').length;
  expect(q).toBeGreaterThan(1);
  expect(rowsOf('a').length).toBeGreaterThan(1);
  for (const { row, i } of pair) {
    const border = row.lastIndexOf('│');
    const right = border >= 0 ? border - 2 : row.trimEnd().length - 1;
    expect(backend.lastBuffer!.get(right, i).style.bg).toBe(chat.askBg);
  }
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

// The marks a stretch's line carries take the trail's tone: red only for a failure
// nobody recovered from, yellow for one a later call of the same tool recovered, and
// the normal colour otherwise — a write never turns it yellow, it only adds its own ✎.
test("a group line marks a failure in the trail's tone, and a write that showed no diff with ✎", async () => {
  const theme = { modals: { chat: MODAL_COLOR_DEFAULTS.chat }, error: 'red' };
  const marked = async (runs: { name: string; outcome: string }[]) => {
    const backend = new TestBackend(80, 24);
    const handle = await render(h(renderChatModal, { ...baseChat, theme, messages: [{ role: 'assistant', content: 'done', parts: [{ kind: 'tools', runs }] }] }), backend);
    const rows = backend.lastFrame.split('\n');
    const y = rows.findIndex((r) => /\+ \d+ tool/.test(r));
    expect(y).toBeGreaterThanOrEqual(0);
    const line = rows[y]!;
    const fgOf = (glyph: string) => {
      const at = line.indexOf(glyph);
      return at < 0 ? undefined : backend.lastBuffer!.get(at, y).style.fg;
    };
    const fg = fgOf('✗');
    const wrote = fgOf('✎');
    handle.unmount();
    return { fg, wrote, line };
  };
  // Recovered: tool a failed, then succeeded — yellow, not red.
  const recovered = await marked([{ name: 'a', outcome: 'error' }, { name: 'a', outcome: 'ok' }]);
  expect(recovered.fg).toBe('yellow');
  // Unrecovered: the failing tool never ran again — red.
  expect((await marked([{ name: 'a', outcome: 'error' }, { name: 'b', outcome: 'ok' }])).fg).toBe('red');
  // A write with nothing failed: no ✗ at all, and its own ✎ — in the chat's ok ink,
  // never the plain dim of the counts beside it.
  const wrote = await marked([{ name: 'w', outcome: 'applied' }]);
  expect(wrote.line).not.toContain('✗');
  expect(wrote.line).toContain('✎');
  expect(wrote.wrote).toBe('green');
});

// A record's tone is the trail's, read FORWARD from its own call: a failure a later call
// of the same tool recovered is yellow, not red — the record and the stretch's summary
// above it say the same thing, since a red ✗ under a yellow summary would contradict itself.
test("a record line takes the trail's tone, a recovered failure included", async () => {
  const theme = { modals: { chat: MODAL_COLOR_DEFAULTS.chat }, error: 'red' };
  const msg = {
    role: 'assistant', content: 'done',
    parts: [{ kind: 'tools', runs: [{ name: 'a', outcome: 'error' }, { name: 'a', outcome: 'ok' }] }],
  };
  const group = chatRows([msg] as never, groupOpts()).find((r) => r.group)!;
  const backend = new TestBackend(80, 24);
  const handle = await render(h(renderChatModal, {
    ...baseChat, theme, messages: [msg],
    folds: { open: false, except: new Set([group.group!.id]) },
  }), backend);
  const rows = backend.lastFrame.split('\n');
  const fgOf = (needle: string, glyph: string) => {
    const y = rows.findIndex((r) => r.includes(needle));
    expect(y).toBeGreaterThanOrEqual(0);
    const at = rows[y]!.indexOf(glyph);
    expect(at).toBeGreaterThanOrEqual(0);
    return backend.lastBuffer!.get(at, y).style.fg;
  };
  // The head and the recovered call's record line are both the trail's yellow.
  expect(fgOf('+ 2 tools', '✗')).toBe('yellow');
  expect(fgOf('⌁ a · error', '✗')).toBe('yellow');
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

test('the hint row is the last row inside the box, under the field; the plan and the queue line are above the field', async () => {
  const backend = new TestBackend(100, 24);
  const handle = await render(h(renderChatModal, {
    ...baseChat, width: 100, messages: [],
    todo: [{ id: 't1', text: 'one', status: 'pending' }],
    queued: ['a queued line'],
  }), backend);
  const rows = backend.lastFrame.split('\n');
  const hint = rows.findIndex((r) => r.includes('history · wheel'));
  const field = rows.findIndex((r) => r.includes('send ·'));
  const queue = rows.findIndex((r) => r.includes('a queued line'));
  const plan = rows.findIndex((r) => r.includes('▾ plan'));
  const border = rows.findLastIndex((r) => r.includes('╰'));
  expect(plan).toBeGreaterThan(0);
  expect(queue).toBeGreaterThan(plan);
  expect(field).toBeGreaterThan(queue);
  expect(hint).toBeGreaterThan(field);
  expect(hint).toBe(border - 1); // the hint row goes to the frame's edge
  // The one empty row stands ABOVE the hint, between it and the field — the swap of
  // 2026-11-22: the hint hugs the border, the breathing room is under the field.
  expect(rows.slice(field + 1, hint).map((r) => r.replace(/│/g, '').trim())).toEqual(['']);
  handle.unmount();
});

test("the pager keys hug the border with the frame's one empty row above them", async () => {
  const backend = new TestBackend(100, 24);
  const handle = await render(h(renderChatModal, {
    ...baseChat, width: 100, messages: [], pager: { title: 'docs', rows: [] },
  }), backend);
  const rows = backend.lastFrame.split('\n');
  const keys = rows.findLastIndex((r) => r.includes('Esc close'));
  const border = rows.findLastIndex((r) => r.includes('╰'));
  expect(keys).toBe(border - 1);
  expect(rows[keys - 1].replace(/│/g, '').trim()).toBe('');
  handle.unmount();
});

test('with a y/n box up the empty row stands between the box and the key hint', async () => {
  const backend = new TestBackend(100, 24);
  const handle = await render(h(renderChatModal, {
    ...baseChat, width: 100, messages: [],
    pendingConfirm: { name: 'write_file', args: '{"path":"a.ts"}' },
  }), backend);
  const rows = backend.lastFrame.split('\n');
  const hint = rows.findLastIndex((r) => r.includes('history · wheel'));
  const boxHint = rows.findIndex((r) => r.includes('Press y to confirm'));
  const border = rows.findLastIndex((r) => r.includes('╰'));
  expect(hint).toBe(border - 1);
  expect(boxHint).toBeLessThan(hint - 1); // the box's own hint stays in the box
  expect(rows[hint - 1].replace(/│/g, '').trim()).toBe('');
  handle.unmount();
});

test('with a multi-row draft the one empty row still stands between the field and the hint', async () => {
  const backend = new TestBackend(100, 24);
  const handle = await render(h(renderChatModal, {
    ...baseChat, width: 100, messages: [], input: 'top row\nlong draft line', cursor: 21,
  }), backend);
  const rows = backend.lastFrame.split('\n');
  const hint = rows.findLastIndex((r) => r.includes('history · wheel'));
  const border = rows.findLastIndex((r) => r.includes('╰'));
  expect(hint).toBe(border - 1);
  expect(rows[hint - 1].replace(/│/g, '').trim()).toBe('');
  expect(rows[hint - 2]).toContain('long draft line'); // still exactly one empty row
  handle.unmount();
});

test("a watched child's status hugs the border, its notice above it, one empty row above that", async () => {
  const backend = new TestBackend(100, 24);
  const handle = await render(h(renderChatModal, {
    ...baseChat, width: 100, messages: [], input: '',
    watch: { path: ['outer'], rows: [], state: '⚙ read_file(a.ts)', ended: false, ask: null, notice: '⏸ 1 waiting' },
  } as never), backend);
  const rows = backend.lastFrame.split('\n');
  const status = rows.findLastIndex((r) => r.includes('x stop · Esc back'));
  const notice = rows.findLastIndex((r) => r.includes('⏸ 1 waiting'));
  const border = rows.findLastIndex((r) => r.includes('╰'));
  expect(status).toBe(border - 1);
  expect(notice).toBe(status - 1); // the notice and the status stay together
  expect(rows[notice - 1].replace(/│/g, '').trim()).toBe(''); // the one empty row above them
  handle.unmount();
});

test("a question's rows are counted exactly: at pendingChatRows height the block stands whole", async () => {
  const confirm = { name: 'write_file', args: '{"path":"a.ts"}' };
  const height = pendingChatRows({ width: 80, confirm });
  const backend = new TestBackend(80, height);
  const handle = await render(h(renderChatModal, {
    ...baseChat, width: 80, height, messages: [], docked: true, fullscreen: true,
    pendingConfirm: confirm,
  }), backend);
  expect(backend.lastFrame).toContain('Press y to confirm'); // the box is not clipped
  handle.unmount();
});

// The measures must count every row the render draws: under a watch the bottom row is
// the notice (when a request waits elsewhere) AND the state row — two rows, not one.
test('a watched child with a notice beside its block counts the notice row in the measures', () => {
  const question = askStart([{ question: 'q?', header: 'h', options: [{ label: 'a', description: 'd' }] }] as never);
  const watch = (notice?: string) => ({ path: ['outer'], rows: [], state: '⚙ read_file(a.ts)', ended: false, ask: null, question, ...(notice ? { notice } : {}) });
  expect(room({ watch: watch('⏸ 1 waits') }).besides - room({ watch: watch() }).besides).toBe(1);
});

test("a watched child's block, its notice and its status stand whole at pendingChatRows height", async () => {
  const question = askStart([{ question: 'q?', header: 'h', options: [{ label: 'a', description: 'd' }] }] as never);
  const o: RowOpts = { wrap: 60, folds: { open: false, except: new Set() }, viewLines: 20, notes: 'step', detailsKey: '^o', renderers: {}, now: 0, palette: {} };
  const height = pendingChatRows({ width: 80, question, watchNotice: true });
  const backend = new TestBackend(80, height);
  const handle = await render(h(renderChatModal, {
    ...baseChat, width: 80, height, messages: [], docked: true, fullscreen: true,
    watch: { path: ['outer'], rows: chatRows([{ role: 'assistant', content: 'a child word' }], o), state: '⚙ read_file(a.ts)', ended: false, ask: null, question, notice: '⏸ 1 waiting' },
  } as never), backend);
  const frame = backend.lastFrame;
  expect(frame).toContain('a child word');           // the one conversation row
  expect(frame).toContain('⏸ 1 waiting');            // the notice row
  expect(frame).toContain('x stop · Esc dismiss');   // the status row, not clipped
  handle.unmount();
});

test('during a turn the queue line is above the field and the live status row is the strip\'s last', async () => {
  const backend = new TestBackend(100, 24);
  const handle = await render(h(renderChatModal, {
    ...baseChat, width: 100, messages: [], streaming: true, toolLabel: 'compact', elapsed: 3200,
    todo: [{ id: 't1', text: 'one', status: 'pending' }],
    queued: ['a queued line'],
  }), backend);
  const rows = backend.lastFrame.split('\n');
  // Mid-turn the field's own row offers the queue instead of the send placeholder.
  const field = rows.findIndex((r) => r.includes('an answer is coming'));
  const hint = rows.findIndex((r) => r.includes('3s · compact'));
  const queue = rows.findIndex((r) => r.includes('a queued line'));
  const plan = rows.findIndex((r) => r.includes('▾ plan'));
  const border = rows.findLastIndex((r) => r.includes('╰'));
  expect(plan).toBeGreaterThan(0);
  expect(queue).toBeGreaterThan(plan);
  expect(field).toBeGreaterThan(queue);
  expect(hint).toBeGreaterThan(field);
  expect(hint).toBe(border - 1); // the live status row goes to the frame's edge
  expect(rows.slice(field + 1, hint).map((r) => r.replace(/│/g, '').trim())).toEqual(['']);
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

test('the bg badge names the ↓ door and counts its rows when this chat has work', async () => {
  const backend = new TestBackend(140, 24);
  const handle = await render(
    h(renderChatModal, {
      ...baseChat,
      width: 140,
      messages: [],
      // The registry-wide count is 0 (a chat of resting children), and the door still has
      // two rows: the number is the door's, and the key that opens it is named.
      bgCount: 0,
      bgDoor: 2,
    }),
    backend,
  );
  expect(backend.lastFrame).toContain(`${keyGlyph('down')} 2 in background`);
  expect(backend.lastFrame).not.toContain('waiting');
  handle.unmount();
});

test('a waiting subagent says so in warn beside the count', async () => {
  const backend = new TestBackend(140, 24);
  const handle = await render(
    h(renderChatModal, {
      ...baseChat,
      width: 140,
      messages: [],
      // The palette the real app resolves (MODAL_COLOR_DEFAULTS' `warn`); given whole here.
      theme: { modals: { chat: { warn: 'yellow' } } },
      bgCount: 2,
      bgDoor: 2,
      bgWaiting: 1,
    }),
    backend,
  );
  const frame = backend.lastFrame;
  expect(frame).toContain('2 in background · 1 waiting');
  const rows = frame.split('\n');
  const at = rows.findIndex((r) => r.includes('1 waiting'));
  const style = backend.lastBuffer!.get(rows[at]!.indexOf('1 waiting'), at).style as { fg?: string; dim?: boolean };
  // Something waiting on the person is not greyed with the hint.
  expect(style.fg).toBe('yellow');
  expect(style.dim).toBeFalsy();
  handle.unmount();
});

test('with no work of this chat the badge stays the plain registry count', async () => {
  const backend = new TestBackend(140, 24);
  const handle = await render(
    h(renderChatModal, {
      ...baseChat,
      width: 140,
      messages: [],
      bgCount: 1,
      bgDoor: 0,
    }),
    backend,
  );
  expect(backend.lastFrame).toContain('1 in background');
  // No door to name: the badge is the count alone. (The row's own `↑↓ history` carries the
  // glyph, so the door is read by its badge and not by the bare arrow.)
  expect(backend.lastFrame).not.toContain(`${keyGlyph('down')} 1 in background`);
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

// ─── A command panel's bottom look ───────────────────────────────────────────
// The work panel is a glance strip over the chat's bottom: exactly 12 rows — the frame,
// one tab strip row, an 8-row list window and the hint — with no padding and no gaps.
// Its bottom edge is the area's last row, and its message takes the hint's row.
const stripView = (over: Partial<CommandPanelView> = {}): CommandPanelView => ({
  title: 'Work',
  rows: [
    { id: 'sub:a', text: 'a › writing', detail: 'working', tone: 'ok' },
    { id: 'sub:b', text: 'b › waiting', detail: 'waiting', tone: 'warn' },
    { id: 'group:shells', text: 'Shells', kind: 'group' },
    { id: 'shell:1', text: 'job 1 · sleep 30', detail: 'running' },
  ],
  cursor: 1,
  notice: '',
  empty: 'none',
  keys: [
    { cap: keyGlyph('left'), label: 'tabs' },
    { cap: keyGlyph('right'), label: 'tabs' },
    { cap: keyGlyph('return'), label: 'open' },
    { cap: '^d', label: 'stop/kill' },
  ],
  look: 'bottom',
  tabs: [{ label: 'Subagents (2)', current: true }, { label: 'Shells (1)', current: false }],
  ...over,
});

const stripFrame = async (view: CommandPanelView, width = 100, height = 40) => {
  const backend = new TestBackend(width, height);
  const handle = await render(h(renderCommandPanel, { width, height, theme: undefined, panel: view }), backend);
  const lines = (backend.lastFrame ?? '').split('\n');
  const grid = (backend as unknown as { lastBuffer: AskGrid }).lastBuffer;
  const frame = backend.lastFrame ?? '';
  handle.unmount();
  return { lines, grid, frame };
};

// The palette a real app resolves for the chat: the modal base laid under the chat's
// own colours, so the strip paints a ground and what it covers is hidden.
const stripTheme = () => ({ modals: { chat: { ...MODAL_COLOR_DEFAULTS.chat, bg: 'black', text: 'white' } } });

test('the bottom look is a fixed 12-row strip at the chat box\'s bottom', async () => {
  const { lines, grid } = await stripFrame(stripView());
  // The area is 40 rows and the chat box is 32 (82%), centred on rows 4-35: the strip is
  // the box's last 12 rows, its bottom border on the box's bottom border.
  const top = lines.findIndex((l) => l.includes('╭'));
  const bottom = lines.findIndex((l) => l.includes('╰'));
  expect(top).toBe(24);
  expect(bottom).toBe(35);
  // As wide as the chat's own window, centred in the area.
  expect(lines[top]!.indexOf('╭')).toBe(5);
  expect(stringWidth(lines[top]!.trim())).toBe(90);
  // The strip is the row under the top border; the current tab is inverse, the other
  // tab is not.
  const strip = top + 1;
  expect(lines[strip]).toContain('Subagents (2)');
  expect(lines[strip]).toContain('Shells (1)');
  const inverseAt = (text: string, row: number) => grid.get(lines[row]!.indexOf(text), row).style.inverse === true;
  expect(inverseAt('Subagents (2)', strip)).toBe(true);
  expect(inverseAt('Shells (1)', strip)).toBe(false);
  // Eight rows of list between the strip and the hint, however many rows there are.
  const hint = bottom - 1;
  expect(hint - (top + 2)).toBe(8);
  // The hint just over the bottom border: the way out first, then the tabs and the rows.
  expect(lines[hint]).toContain([`${keyGlyph('escape')} close`, `${keyGlyph('left')}${keyGlyph('right')} tabs`, `${keyGlyph('up')}${keyGlyph('down')} pick`, `${keyGlyph('return')} open`, '^d stop/kill'].join(' · '));
  // The tab keys are the strip's own: they are never said twice.
  expect(lines[hint]).not.toContain(`${keyGlyph('left')} tabs`);

  // A 12-row area: the chat box is 8 rows (82% keeps a margin), centred on rows 2-9, and
  // the strip is the box's whole height, flush with its bottom border.
  const short = await stripFrame(stripView(), 100, 12);
  expect(short.lines[2]).toContain('╭');
  expect(short.lines[9]).toContain('╰');
  expect(short.lines[3]).toContain('Shells (1)');
  expect(short.lines[8]).toContain(`${keyGlyph('escape')} close`);
  expect(short.lines[1]).not.toContain('╭');

  // A notice takes the hint row's place, and the 12 rows stay as they are.
  const told = await stripFrame(stripView({ notice: 'stop «a»? y stops it · n keeps it' }));
  const toldTop = told.lines.findIndex((l) => l.includes('╭'));
  const toldBottom = told.lines.findIndex((l) => l.includes('╰'));
  expect(toldBottom - toldTop + 1).toBe(12);
  expect(told.lines[toldBottom - 1]).toContain('stop «a»? y stops it · n keeps it');
  expect(told.frame).not.toContain(`${keyGlyph('escape')} close`);

  // The window follows the cursor through those 8 rows.
  const many = stripView({ rows: Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, text: `row ${i}` })), cursor: 10 });
  const moved = await stripFrame(many);
  expect(moved.frame).toContain('row 4');
  expect(moved.frame).not.toContain('row 3');

  // Without tabs there is no tab row: the list gains it (nine rows), and the arrows the
  // panel declares are its own again, so they are said.
  const noTabs = await stripFrame(stripView({ cursor: 0, tabs: [] }));
  const noTabsTop = noTabs.lines.findIndex((l) => l.includes('╭'));
  const noTabsBottom = noTabs.lines.findIndex((l) => l.includes('╰'));
  expect(noTabs.lines[noTabsTop + 1]).toContain('a › writing');
  expect(noTabs.frame).not.toContain('Subagents (2)');
  expect(noTabsBottom - 1 - (noTabsTop + 1)).toBe(9);
  expect(noTabs.lines[noTabsBottom - 1]).toContain(`${keyGlyph('left')} tabs · ${keyGlyph('right')} tabs`);
});

test('the strip names the tabs only when both arrows are declared', async () => {
  // A panel that offers tabs but withholds the arrows — the stop question's own keys —
  // must not be told its arrows switch tabs: the token goes, and `↑↓` still moves.
  const held = await stripFrame(stripView({
    keys: [
      { cap: keyGlyph('return'), label: 'open' },
      { cap: '^d', label: 'stop/kill' },
    ],
  }));
  const bottom = held.lines.findIndex((l) => l.includes('╰'));
  const hint = held.lines[bottom - 1]!;
  expect(hint).toContain(`${keyGlyph('up')}${keyGlyph('down')} pick`);
  expect(hint).not.toContain(`${keyGlyph('left')}${keyGlyph('right')} tabs`);
  // With both arrows declared the strip says the token once (the first test pins the
  // exact hint, arrows never said twice).
  const both = await stripFrame(stripView());
  expect(both.frame).toContain(`${keyGlyph('left')}${keyGlyph('right')} tabs`);
});

// ONE token, computed once for both looks: a panel that closes on ↑ names the close on
// its first row, and a hint reading `↑↓ pick` there would hide it. A list of one row has
// no close to offer — the key does not close it — so the token says nothing.
test('the move token names the close on a closing panel\'s first row, the same in both looks', async () => {
  const bottom = (lines: string[]) => lines.findIndex((l) => l.includes('╰'));
  const top = await stripFrame(stripView({ cursor: 0, upAtTopCloses: true }));
  const hint = top.lines[bottom(top.lines) - 1]!;
  expect(hint).toContain(`${keyGlyph('up')} close · ${keyGlyph('down')} pick`);
  expect(hint).not.toContain(`${keyGlyph('up')}${keyGlyph('down')} pick`);
  // A row deeper the close is gone, and the plain move is said — as for a panel that
  // never closes on ↑.
  const deeper = await stripFrame(stripView({ cursor: 2, upAtTopCloses: true }));
  expect(deeper.frame).toContain(`${keyGlyph('up')}${keyGlyph('down')} pick`);
  expect(deeper.frame).not.toContain(`${keyGlyph('up')} close`);
  // One row: no move to pick from, and no close to name.
  const single = await stripFrame(stripView({ rows: [{ id: 'sub:a', text: 'a › writing' }], cursor: 0, upAtTopCloses: true }));
  expect(single.frame).not.toContain(`${keyGlyph('up')} close`);
  expect(single.frame).not.toContain(`${keyGlyph('up')}${keyGlyph('down')} pick`);
  // The window look says the same token: the two cannot disagree.
  const asWindow = await stripFrame(stripView({ cursor: 0, look: 'window', upAtTopCloses: true }));
  expect(asWindow.frame).toContain(`${keyGlyph('up')} close · ${keyGlyph('down')} pick`);
  expect(asWindow.frame).not.toContain(`${keyGlyph('up')}${keyGlyph('down')} pick`);
});

test('a strip with no rows names only the keys that act', async () => {
  // An empty tab: the picker withholds the rows' keys, so the hint says the way out and
  // the way across, and nothing that would act on no row.
  const { lines } = await stripFrame(stripView({
    rows: [],
    keys: [
      { cap: keyGlyph('left'), label: 'tabs' },
      { cap: keyGlyph('right'), label: 'tabs' },
    ],
  }));
  const bottom = lines.findIndex((l) => l.includes('╰'));
  const hint = lines[bottom - 1]!;
  expect(hint).toContain([`${keyGlyph('escape')} close`, `${keyGlyph('left')}${keyGlyph('right')} tabs`].join(' · '));
  expect(hint).not.toContain(`${keyGlyph('return')} open`);
  expect(hint).not.toContain('stop/kill');
  expect(hint).not.toContain(`${keyGlyph('up')}${keyGlyph('down')} pick`);
});

test('a short chat box drops the tab row before squeezing the list below two rows', async () => {
  // A 9-row area gives a 5-row chat box (rows 2-6) and the strip is all of it. With the
  // frame and the hint taking three rows, a tab row would leave ONE list row, so it is
  // dropped and the list keeps its two. The tabs still exist, so the arrows still walk
  // them and the hint still says so.
  const { lines } = await stripFrame(stripView(), 100, 9);
  const top = lines.findIndex((l) => l.includes('╭'));
  const bottom = lines.findIndex((l) => l.includes('╰'));
  expect(top).toBe(2);
  expect(bottom).toBe(6);
  expect(lines.join('\n')).not.toContain('Subagents (2)');
  expect(bottom - 1 - (top + 1)).toBe(2);
  expect(lines[bottom - 1]).toContain(`${keyGlyph('escape')} close`);
  expect(lines[bottom - 1]).toContain(`${keyGlyph('left')}${keyGlyph('right')} tabs`);
  expect(lines[bottom - 1]).not.toContain(`${keyGlyph('left')} tabs`);
});

test('the bottom look is composed over the chat, not drawn in its place', async () => {
  const backend = new TestBackend(100, 40);
  const handle = await render(h(renderChatModal, {
    ...baseChat,
    width: 100,
    height: 40,
    theme: stripTheme(),
    messages: [{ role: 'user', content: 'transcript words' }],
    input: 'draft words',
    cursor: 11,
    panel: stripView(),
  }), backend);
  const lines = (backend.lastFrame ?? '').split('\n');
  // The transcript still draws above the strip...
  const said = lines.findIndex((l) => l.includes('› transcript words'));
  const stripTab = lines.findIndex((l) => l.includes('Subagents (2)'));
  const stripTop = stripTab - 1;
  expect(said).toBeGreaterThanOrEqual(0);
  expect(said).toBeLessThan(stripTop);
  // ...the strip takes the same 12 rows at the chat box's bottom (box rows 4-35)...
  expect(stripTop).toBe(24);
  // ...the way out and the transcript share ONE frame...
  expect(lines[stripTop + 10]).toContain(`${keyGlyph('escape')} close`);
  // ...and the field underneath it is covered while the panel is up.
  expect(backend.lastFrame).not.toContain('draft words');
  handle.unmount();
});

test('a tall window anchors the strip to the chat box and covers the field', async () => {
  // 100x80: the chat box is 65 rows (82%), centred on rows 8-72; the strip is its last 12
  // rows (61-72). The field sits at the box's bottom, so a three-line draft is entirely
  // under the strip — no draft row shows below the strip's top row.
  const backend = new TestBackend(100, 80);
  const handle = await render(h(renderChatModal, {
    ...baseChat,
    width: 100,
    height: 80,
    theme: stripTheme(),
    messages: [{ role: 'user', content: 'tail of the transcript' }],
    input: 'first draft line\nsecond draft line\nthird draft line',
    cursor: 51,
    panel: stripView(),
  }), backend);
  const lines = (backend.lastFrame ?? '').split('\n');
  const stripTab = lines.findIndex((l) => l.includes('Subagents (2)'));
  const stripTop = stripTab - 1;
  expect(stripTop).toBe(61);
  expect(lines.findIndex((l) => l.includes('› tail of the transcript'))).toBeLessThan(stripTop);
  expect(backend.lastFrame).not.toContain('first draft line');
  expect(backend.lastFrame).not.toContain('third draft line');
  // The strip's bottom border is the chat box's own bottom border row (8 + 65 - 1), with
  // nothing of the chat drawn below it.
  expect(lines[72]).toContain('╰');
  expect(lines.slice(73).every((l) => !l.includes('╰'))).toBe(true);
  handle.unmount();
});

test('a docked chat draws the strip on its own bottom row', async () => {
  // A docked pane is the chat's whole area: the strip takes its last twelve rows, the
  // transcript stays above it, the field under it is covered, and the way out sits on
  // the row over the pane's bottom border.
  const backend = new TestBackend(60, 30);
  const handle = await render(h(renderChatModal, {
    ...baseChat,
    width: 60,
    height: 30,
    docked: true,
    fullscreen: true,
    focused: false,
    theme: stripTheme(),
    messages: [{ role: 'user', content: 'dock words' }],
    input: 'draft words',
    cursor: 11,
    panel: stripView(),
  }), backend);
  const lines = (backend.lastFrame ?? '').split('\n');
  const stripTab = lines.findIndex((l) => l.includes('Subagents (2)'));
  expect(stripTab - 1).toBe(18);
  expect(lines.findIndex((l) => l.includes('› dock words'))).toBeLessThan(18);
  expect(lines[28]).toContain(`${keyGlyph('escape')} close`);
  expect(lines[29]).toContain('╰');
  expect(backend.lastFrame).not.toContain('draft words');
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
  // `open` notes draw a trail's calls as the lines they are; `step` folds them into a
  // record a line (`⌁ search · ok`), whose arguments are its body.
  const o: RowOpts = { wrap: stringWidth(line) + 3, folds: { open: true, except: new Set() }, viewLines: 20, notes: 'open', detailsKey: '^o', renderers: {}, now: 0, palette: {} };
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
  // The stretch the run is in opened: the run's own one-line row is behind the group's.
  const rows = chatRows([msg] as never, { wrap, folds: { open: false, except: new Set(['group:0:steps:0']) }, viewLines: 20, notes: 'step', detailsKey: '^o', renderers: {}, now: 0, palette: {} }).map(rowText);
  const row = rows.find((r) => r.startsWith('▸'));
  expect(row).toBe(`${text} ✗`);
});

test("a group line's ✗ carries the trail's tone: warn when the same tool recovered, error when it did not", () => {
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

test("the question's own-words field takes a line break, and the hint names the key", async () => {
  let state = askStart([{ question: 'Which branch?', options: [{ label: 'master' }, { label: 'develop' }] }] as never);
  for (const c of 'alpha') state = askKey(state, { name: c } as never);
  state = askKey(state, { name: 'return', shift: true } as never);
  for (const c of 'bravo') state = askKey(state, { name: c } as never);
  const backend = new TestBackend(100, 24);
  const handle = await render(h(renderChatModal, { ...baseChat, width: 100, messages: [], pendingQuestion: state } as never), backend);
  const rows = backend.lastFrame.split('\n');
  const first = rows.findIndex((r) => r.includes('alpha'));
  const second = rows.findIndex((r) => r.includes('bravo'));
  expect(first).toBeGreaterThan(0);
  expect(second).toBe(first + 1); // the break draws as its own row under the first
  expect(backend.lastFrame).toContain('new line'); // the hint names the key, as the chat's does
  handle.unmount();
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
// The chat drawn at 120×30, with the ink each of its rows is drawn at.
const chatFrame = async (extra: Record<string, unknown>) => {
  const backend = new TestBackend(120, 30);
  const handle = await render(h(renderChatModal, { ...baseChat, width: 120, height: 30, ...extra } as never), backend);
  const lines = (backend.lastFrame ?? '').split('\n');
  const grid = backend.lastBuffer!;
  const dimAt = (text: string) => {
    const y = lines.findIndex((l) => l.includes(text));
    return y < 0 ? null : grid.get(lines[y]!.indexOf(text), y).style.dim === true;
  };
  handle.unmount();
  return { lines, dimAt };
};
// The same frame with the question in the field's place — what the rows are read against
// while the question waits.
const leadFrame = (extra: Record<string, unknown>) => chatFrame({
  messages: [leadMsg],
  pendingQuestion: askStart([{ question: 'Which branch?', options: [{ label: 'master' }, { label: 'develop' }] }]),
  ...extra,
});

test('the run before a pending question draws open and lit', async () => {
  // Folded: the whole stretch — both runs and the thought between them — is one line.
  const folded = chatRows([leadMsg] as never, leadOpts());
  expect(folded.map(rowText).filter(Boolean)).toEqual(['+ 1 thought, 1 read, 1 tool']);
  expect(folded.some((r) => r.reason)).toBe(false);

  // The question waits: the last run — the one the ask follows — draws each step in
  // full at full ink, and keeps its fold id so a click still folds it, when the run is
  // not lit. The older run and the thought keep their folded look: a group of their own.
  const lit = chatRows([leadMsg] as never, leadOpts(true));
  const litText = lit.map(rowText);
  expect(litText).toContain('The branch is unclear.');
  const lead = lit.find((r) => rowText(r) === 'The branch is unclear.');
  expect(lead?.quiet).not.toBe(true);
  expect(lead?.step).not.toBe(true);
  expect(lead?.fold).toBe('0:steps:1');
  expect(litText.filter((t) => t.startsWith('+ '))).toEqual(['+ 1 thought, 1 read', '+ 1 tool']);
  expect(lit.some((r) => r.reason)).toBe(false);

  // On the screen, one question or a wizard alike: the block in the field's place says
  // nothing about the rows — `pendingQuestion` alone leaves them folded, and only the
  // transcript's own flag lights the run. Lit, the run's rows are at full ink and the
  // group beside them is dim.
  const waiting = await leadFrame({});
  expect(waiting.dimAt('+ 1 thought, 1 read, 1 tool')).toBe(true);
  const litFrame = await leadFrame({ askPending: true });
  expect(litFrame.dimAt('The branch is unclear.')).toBe(false);
  expect(litFrame.dimAt('+ 1 thought, 1 read')).toBe(true);
});

test('the lead-in lights under a message drawn after it, and nowhere else', () => {
  // A view or a note lands below the turn's narration (a command's block, /compact's
  // line); the question is still read against the narration above it.
  const note = { role: 'note', content: 'compacted', summary: 'kept 12 messages' };
  const lit = chatRows([leadMsg, note] as never, leadOpts(true)).map(rowText);
  expect(lit).toContain('The branch is unclear.');
  expect(lit).toContain('+ 1 thought, 1 read');
  // Without the flag, the same list folds it again: one stretch, one line.
  const folded = chatRows([leadMsg, note] as never, leadOpts()).map(rowText);
  expect(folded).toContain('+ 1 thought, 1 read, 1 tool');
  // And an older turn is never the one lit: only the newest assistant message is.
  const older = { role: 'assistant', content: 'Done.' };
  const both = chatRows([leadMsg, older] as never, leadOpts(true)).map(rowText);
  expect(both).toContain('+ 1 thought, 1 read, 1 tool');
});

// ─── The answer to a message steered in mid-turn ─────────────────────────────
// The steer's answer is the LAST text written after the steered-in row and before
// either the turn's answer or the person's next message: it draws at full ink and
// carries `→` in the gutter, under the `› ` of the message it answers. The turn's own
// answer keeps its one `ƒ`, and the narration before the steer's answer stays dim.
// The gutter's own `→`: the arrow stands in the two-cell column under the `› `, never
// inside a row's text (`▸ read_file → ok`). An answered question's `→` sits in that same
// cell, for the same reason — none of these builds holds a question.
const gutterArrows = (lines: string[]) => lines.filter((l) => l.includes('→') && l.indexOf('→') === l.indexOf('│') + 2);

test('a message steered in mid-turn gets the answer mark on the last text before the turn settles', async () => {
  const { lines, dimAt } = await chatFrame({
    messages: [
      { role: 'user', content: 'прикинь, сколько файлов', midTurn: true },
      {
        role: 'assistant', content: 'Итог',
        parts: [
          { kind: 'tools', runs: [{ name: 'list_dir', outcome: 'ok' }] },
          { kind: 'text', text: 'Смотрю.' },
          { kind: 'tools', runs: [{ name: 'read_file', outcome: 'ok' }] },
          { kind: 'text', text: 'Ответ на вопрос.' },
        ],
      },
    ],
  });
  // The last text of the stretch is the steer's answer: `→` in the gutter, full ink.
  const answer = lines.find((l) => l.includes('Ответ на вопрос.')) ?? '';
  expect(answer).toContain('→ Ответ на вопрос.');
  expect(dimAt('Ответ на вопрос.')).toBe(false);
  // One mark per steer — not a second one on any other row.
  expect(gutterArrows(lines)).toHaveLength(1);
  // The narration before it answers nothing and keeps neither the mark nor the ink: it
  // is a dim row of the stretch, folded into the group's line with the calls — the
  // call before the narration and the one after it both counted there.
  expect(lines.some((l) => l.includes('Смотрю.'))).toBe(false);
  expect(lines.some((l) => l.includes('+ 2 reads'))).toBe(true);
  // The turn's own answer keeps the one `ƒ`.
  const settled = lines.find((l) => l.includes('Итог')) ?? '';
  expect(settled).toMatch(/ƒ Итог/);
  expect(settled).not.toContain('→');
});

test('a steer answered by ending the turn there keeps ƒ and gets no →', async () => {
  const { lines } = await chatFrame({
    messages: [
      { role: 'user', content: 'а что с git?', midTurn: true },
      {
        role: 'assistant', content: 'Три изменённые строки.',
        parts: [{ kind: 'tools', runs: [{ name: 'git_status', outcome: 'ok' }] }],
      },
    ],
  });
  // The text the turn ends on IS the answer: `ƒ`, never `→`.
  const answer = lines.find((l) => l.includes('Три изменённые строки.')) ?? '';
  expect(answer).toMatch(/ƒ Три изменённые строки\./);
  expect(gutterArrows(lines)).toEqual([]);
});

test('a steer answered before the turn settles marks the last text it wrote, one per stretch', async () => {
  // The ruled trade-off: a stretch of narration and calls with no step after it cannot be
  // told from an answer, so its last text is marked like one — and the turn's own answer
  // still keeps `ƒ`, with one `→` for the stretch.
  const { lines } = await chatFrame({
    messages: [
      { role: 'user', content: 'а что с git?', midTurn: true },
      {
        role: 'assistant', content: 'Итог',
        parts: [
          { kind: 'text', text: 'Смотрю.' },
          { kind: 'tools', runs: [{ name: 'git_status', outcome: 'ok' }] },
        ],
      },
    ],
  });
  const marks = gutterArrows(lines);
  expect(marks).toHaveLength(1);
  expect(marks[0]).toContain('Смотрю.');
  const settled = lines.find((l) => l.includes('Итог')) ?? '';
  expect(settled).toMatch(/ƒ Итог/);
});

test('a dim hostAsk row does not join the steer answer', async () => {
  // The host's own ask after a `!!command` is a dim row of the person's side: it ends
  // the stretch the steered-in row opened, so the text after it is not the steer's
  // answer and carries no `→`.
  const { lines } = await chatFrame({
    messages: [
      { role: 'user', content: 'прикинь, сколько файлов', midTurn: true },
      { role: 'user', content: 'The host asks one thing', hostAsk: true },
      {
        role: 'assistant', content: 'Итог',
        parts: [
          { kind: 'tools', runs: [{ name: 'list_dir', outcome: 'ok' }] },
          { kind: 'text', text: 'Ответ хосту.' },
        ],
      },
    ],
  });
  expect(lines.some((l) => l.includes('The host asks one thing'))).toBe(true);
  expect(gutterArrows(lines)).toEqual([]);
});

// ─── A stretch of the work, folded to one line ───────────────────────────────
// Consecutive dim rows — a folded run, a thought, a trail of calls, a console block,
// the gaps between them — are ONE collapsible line: what it counts by kind (opencode's
// grammar), how long its commands took, and the worst state it holds. Any bright row
// ends the stretch before it, and so does a row of the person's: nothing of theirs is
// ever hidden in a fold.
const groupOpts = (folds: { open: boolean; except: Set<string> } = { open: false, except: new Set() }): RowOpts => ({
  wrap: 60, folds, viewLines: 20, notes: 'step', detailsKey: '^o', renderers: {}, now: 0, palette: {},
});

test('a stretch of dim rows collapses to one line counting its tools and thoughts', async () => {
  const msg = {
    role: 'assistant', content: 'Done.',
    parts: [
      { kind: 'reasoning', text: 'Read the log first.' },
      { kind: 'tools', runs: [{ name: 'git_status', outcome: 'ok' }] },
      { kind: 'tools', runs: [{ name: 'git_diff', outcome: 'ok' }] },
      { kind: 'reasoning', text: 'The branch is unclear.' },
      { kind: 'tools', runs: [{ name: 'git_log', outcome: 'ok' }] },
    ],
  };
  const rows = chatRows([msg] as never, groupOpts());
  // One line where the stretch began — opencode's kind order, thought before tool.
  const summary = rows.find((r) => r.group);
  expect(rowText(summary!)).toBe('+ 2 thoughts, 3 tools');
  // Its members are folded away: no trail's head, no thought's header.
  expect(rows.some((r) => r.meta || r.reasonHeader)).toBe(false);
  const folded = await chatFrame({ messages: [msg] });
  expect(folded.lines.some((l) => l.includes('▸ + 2 thoughts, 3 tools'))).toBe(true);
  // A click opens it: the same line, now `▾`, over its records — one line per thought
  // and one per call, each opening to its own body.
  const opened = chatRows([msg] as never, groupOpts({ open: false, except: new Set(['group:0:reasoning:0']) }));
  expect(rowText(opened.find((r) => r.group)!)).toBe('+ 2 thoughts, 3 tools');
  expect(opened.filter((r) => r.record?.kind === 'thought').map(rowText)).toEqual(['thought', 'thought']);
  expect(opened.filter((r) => r.record?.kind === 'tool').map(rowText)).toEqual(['⌁ git_status · ok', '⌁ git_diff · ok', '⌁ git_log · ok']);
  // The trail heads and the thought headers the records replaced are gone; their bodies
  // are drawn only when a record is opened.
  expect(opened.some((r) => r.meta || r.reasonHeader)).toBe(false);
  const shown = await chatFrame({ messages: [msg], folds: { open: false, except: new Set(['group:0:reasoning:0']) } });
  expect(shown.lines.some((l) => l.includes('▾ + 2 thoughts, 3 tools'))).toBe(true);
});

test('a bright row ends the group that precedes it and the next dim row starts a new one', () => {
  const reasoned = {
    role: 'assistant', content: 'Итог',
    parts: [{ kind: 'text', text: 'Смотрю.' }, { kind: 'tools', runs: [{ name: 'git_status', outcome: 'ok' }] }],
  };
  const steered = { role: 'user', content: 'а что с git?', midTurn: true };
  // The steer's answer is the lit run: its rows are bright, so the group before it
  // ends there and the calls that came earlier count alone.
  const answered = {
    role: 'assistant', content: 'Итог',
    parts: [{ kind: 'tools', runs: [{ name: 'read_file', outcome: 'ok' }] }, { kind: 'text', text: 'Ответ на вопрос.' }],
  };
  const again = {
    role: 'assistant', content: 'Итог',
    parts: [{ kind: 'text', text: 'Ещё смотрю.' }, { kind: 'tools', runs: [{ name: 'git_log', outcome: 'ok' }, { name: 'git_diff', outcome: 'ok' }] }],
  };
  const rows = chatRows([reasoned, steered, answered, again] as never, groupOpts());
  const text = rows.map(rowText);
  // Three stretches, three summaries — each counting only its own members.
  expect(text.filter((r) => r.startsWith('+ '))).toEqual(['+ 1 tool', '+ 1 read', '+ 2 tools']);
  // The bright rows themselves are never folded away.
  expect(rows.some((r) => r.steerAnswer)).toBe(true);
  expect(text).toContain('Ответ на вопрос.');

  // A change title is bright too, and so are the hunks under it: they split a stretch
  // the same way, and neither the title nor the diff is ever hidden.
  const changed = {
    role: 'assistant', content: '',
    parts: [
      { kind: 'tools', runs: [{ name: 'git_status', outcome: 'ok' }] },
      { kind: 'change', change: { title: 'src/a.ts', diff: '@@ -1,1 +1,1 @@\n-a\n+b', added: 1, removed: 1, hidden: 0 } },
      { kind: 'tools', runs: [{ name: 'git_log', outcome: 'ok' }, { name: 'git_diff', outcome: 'ok' }] },
    ],
  };
  const split = chatRows([changed] as never, groupOpts()).map(rowText);
  const title = split.findIndex((r) => r.startsWith('✎'));
  expect(split[title]).toBe('✎ src/a.ts · +1 −1');
  expect(split.slice(0, title)).toContain('+ 1 tool');
  expect(split.slice(title)).toContain('+ 2 tools');
});

test('the ✎ block draws the same rows for a whole record as for one that holds the cut', () => {
  // A rewrite of every line: 201 diff lines, well past the eighty the chat draws. A
  // record that keeps them all lays out the same row STRINGS as one holding the first
  // eighty — the number gutter is sized by the rows drawn, so its padding cannot move.
  const before = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const after = Array.from({ length: 100 }, (_, i) => `new ${i + 1}`).join('\n') + '\n';
  const whole = changeView({ title: 'clone/app.ts', before, after })!;
  const cut: ChangeView = { title: 'clone/app.ts', ...unifiedDiff(before, after) };
  expect(whole.diff.split('\n').length).toBeGreaterThan(CHANGE_DRAW_MAX_LINES);
  expect(cut.diff.split('\n')).toHaveLength(CHANGE_DRAW_MAX_LINES);
  const drawnOf = (change: ChangeView) =>
    chatRows([{ role: 'assistant', content: '', parts: [{ kind: 'change', change }] }] as never, groupOpts()).map(rowText);
  const drawn = drawnOf(whole);
  expect(drawn).toEqual(drawnOf(cut));
  // The rows themselves: seventy-nine diff rows under the title — the hunk header is
  // not a row — and one note counting everything past the eighty drawn lines.
  expect(drawn.some((r) => r.trimEnd().endsWith('-line 1'))).toBe(true);
  expect(drawn.some((r) => r.includes('-line 79'))).toBe(true);
  expect(drawn.some((r) => r.includes('-line 80'))).toBe(false);
  expect(drawn).toContain('… 121 more lines');
});

test('a group with a live item shows a busy line with a spinner while it runs', async () => {
  // A round being written and a command still running: the round stays on the screen
  // as it arrives — the command's own block is what folds, and it says what it is
  // waiting on rather than what it has finished.
  const msg = {
    role: 'assistant', content: '', live: 'щас гляну',
    parts: [{ kind: 'tools', runs: [{ name: 'git_status', outcome: 'ok' }] }],
  };
  const running = {
    role: 'view', content: '',
    views: [{ kind: 'console', data: { command: 'bun test', cwd: '~', text: 'running…' }, phase: 'live', startedAt: 0 }],
  };
  const rows = chatRows([msg, running] as never, { ...groupOpts(), now: 6000 });
  const summary = rows.find((r) => r.group?.busy === true);
  // The wording of what still runs, and no counts: a count of work not yet finished
  // would be a lie.
  expect(rowText(summary!)).toBe('Running command…');
  // The text being typed under it is drawn, never folded away.
  expect(rows.map(rowText)).toContain('щас гляну');
  // On the screen it spins where the fold marker stands — a static label reads as stuck.
  const backend = new TestBackend(80, 24);
  const handle = await render(h(renderChatModal, { ...baseChat, messages: [msg, running] as never, now: 6000 }), backend);
  expect(backend.lastFrame).toContain('⠋ Running command…');
  expect(backend.lastFrame).toContain('щас гляну');
  expect(backend.lastFrame).not.toContain('⠋ +');
  handle.unmount();
});

test("a group's counts never change with a fold state inside it", () => {
  const msg = {
    role: 'assistant', content: 'Done.',
    parts: [
      { kind: 'reasoning', text: 'Read the log first.' },
      { kind: 'text', text: 'Now the file.' },
      { kind: 'tools', runs: [{ name: 'read_file', outcome: 'ok' }, { name: 'read_file', outcome: 'ok' }] },
    ],
  };
  const label = (except: string[] = []) => {
    const rows = chatRows([msg] as never, groupOpts({ open: false, except: new Set(except) }));
    return rowText(rows.find((r) => r.group)!);
  };
  // Folded, then with the run's own fold opened (its calls are rows of their own now),
  // then with the group opened over that open run: one summary, the same counts.
  expect(label()).toBe('+ 1 thought, 2 reads');
  expect(label(['0:steps:0'])).toBe('+ 1 thought, 2 reads');
  expect(label(['group:0:reasoning:0', '0:steps:0'])).toBe('+ 1 thought, 2 reads');
});

test('a group counts a run_command as a command, and a finished console block with its time', () => {
  const shell = {
    role: 'assistant', content: 'Done.',
    parts: [{ kind: 'tools', runs: [{ name: 'run_command', outcome: 'ok', write: true }] }],
  };
  expect(rowText(chatRows([shell] as never, groupOpts()).find((r) => r.group)!)).toBe('+ 1 command');
  // A console block is a command too — and the stretch says how long its commands took.
  const block = {
    role: 'view', content: '',
    views: [{ kind: 'console', data: { command: 'bun test', cwd: '~', text: 'ok', exitCode: 0, ms: 8000 }, phase: 'done', startedAt: 0 }],
  };
  expect(rowText(chatRows([block] as never, groupOpts()).find((r) => r.group)!)).toBe('+ 1 command · 8s');
});

test('a group counts a lone read without a plural', () => {
  const msg = { role: 'assistant', content: 'Done.', parts: [{ kind: 'tools', runs: [{ name: 'list_dir', outcome: 'ok' }] }] };
  expect(rowText(chatRows([msg] as never, groupOpts()).find((r) => r.group)!)).toBe('+ 1 read');
});

// Two console blocks of one turn are the stretch the group counts: no `ƒ Ran N
// commands` head stands over them, and the summary carries the failure's `✗`.
test('two console blocks fold into the group, and no Ran head stands over them', async () => {
  const block = (command: string, seq: number, exitCode: number, ms: number) => ({
    role: 'view', content: '',
    views: [{ kind: 'console', seq, turn: 3, phase: 'done', startedAt: 0, data: { command, cwd: '~', text: command, exitCode, ...(exitCode ? { status: `exit ${exitCode}` } : {}), ms } }],
  });
  const blocks = [block('echo one', 1, 0, 800), block('echo two', 2, 1, 400)];
  const rows = chatRows(blocks as never, groupOpts());
  expect(rows.map(rowText)).toEqual(['+ 2 commands · 1s ✗']);
  expect(rows.find((r) => r.group)!.group!.marks).toBe('✗');
  const { lines } = await chatFrame({ messages: blocks });
  expect(lines.filter((l) => /(Ran|Running) \d+ commands/.test(l))).toEqual([]);
  expect(lines.some((l) => /\+ 2 commands .*✗/.test(l))).toBe(true);
});

// The same is true of a command that asked the person something: `‼` is on the
// stretch's own line while it holds that block, so what happened inside it is read
// without opening the stretch at all.
test("a collapsed group's line keeps the `‼` of a command that asked", async () => {
  const interactive = { role: 'view', content: '', views: [{ kind: 'console', data: { command: 'bun test', cwd: '~', text: 'ok', exitCode: 0, ms: 300, interactive: true }, phase: 'done', startedAt: 0 }] };
  const rows = chatRows([interactive] as never, groupOpts());
  expect(rows.map(rowText)).toEqual(['+ 1 command · <1s ‼']);
  expect(rows.find((r) => r.group)!.group!.marks).toBe('‼');
  const { lines } = await chatFrame({ messages: [interactive] });
  expect(lines.some((l) => /▸ \+ 1 command .*‼/.test(l))).toBe(true);
});

// ─── A record: one line per thought, call and console block ──────────────────
// Opening a stretch opens it one level: a thought, a call and a console block are one
// line each (`thought: <title>`, `⌁ <tool> · <status>`, `! <command> · <status>`), and
// each is a fold of its own — a click opens that record's body in place and nothing
// else's. The bodies are the rows the renderer already lays out for those blocks.
const recordMsg = {
  role: 'assistant', content: '',
  parts: [
    { kind: 'reasoning', text: '**Read the log first.**\n\nThe log is long.' },
    { kind: 'tools', runs: [{ name: 'git_status', outcome: 'ok' }, { name: 'git_diff', outcome: 'ok' }] },
  ],
};
const consoleMsg = {
  role: 'view', content: '',
  views: [{ kind: 'console', data: { command: 'echo "hi"', cwd: '~', text: 'hi', exitCode: 1, ms: 300, status: 'exit 1' }, phase: 'done', startedAt: 0 }],
};
// The stretch the two messages make, and its own id: the fold id of the row it begins
// with (the first thought's header).
const RECORD_GROUP = 'group:0:reasoning:0';
const recordOpts = (except: string[] = []): RowOpts => ({
  wrap: 80, folds: { open: false, except: new Set(except) }, viewLines: 20, notes: 'step', detailsKey: '^o',
  renderers: { console: renderConsole }, now: 0, palette: {},
});
const records = (except: string[] = []) => chatRows([recordMsg, consoleMsg] as never, recordOpts([RECORD_GROUP, ...except]));

test('an open group shows one record line per tool call and per thought', async () => {
  const rows = records();
  // One line each, in the order the work happened; the console's own state stays on
  // its line, and the interactive mark rides the marker the block is drawn with.
  expect(rows.filter((r) => r.record).map((r) => [r.record!.kind, rowText(r)])).toEqual([
    ['thought', 'thought: Read the log first.'],
    ['tool', '⌁ git_status · ok'],
    ['tool', '⌁ git_diff · ok'],
    ['console', '! echo "hi" · ✗ exit 1 · <1s'],
  ]);
  // The bodies are not drawn until a record is opened: no thought text, no output.
  const text = rows.map(rowText);
  expect(text).not.toContain('The log is long.');
  expect(text.some((t) => t.includes('│ hi'))).toBe(false);
  // Each record is a fold line of its own, inside the group's own id.
  for (const row of rows.filter((r) => r.record)) {
    expect(row.foldLine).toBe(true);
    expect(row.fold).toBe(row.record!.id);
    expect(row.record!.id.startsWith(`${RECORD_GROUP}:`)).toBe(true);
  }
  // On screen: the markers say the line opens, and the ink is quiet — the work, not a
  // thing the model said.
  const { lines, dimAt } = await chatFrame({ messages: [recordMsg, consoleMsg], folds: { open: false, except: new Set([RECORD_GROUP]) } });
  expect(lines.some((l) => l.includes('▸ thought: Read the log first.'))).toBe(true);
  expect(lines.some((l) => l.includes('▸ ⌁ git_status · ok'))).toBe(true);
  expect(lines.some((l) => l.includes('▸ ! echo "hi" · ✗ exit 1 · <1s'))).toBe(true);
  expect(lines.some((l) => l.includes('The log is long.'))).toBe(false);
  expect(lines.some((l) => l.includes('│ hi'))).toBe(false);
  expect(dimAt('⌁ git_status')).toBe(true);
  // An interactive block keeps its `‼` on the record's marker.
  const interactive = { role: 'view', content: '', views: [{ kind: 'console', data: { command: 'bun test', cwd: '~', text: 'ok', exitCode: 0, ms: 300, interactive: true }, phase: 'done', startedAt: 0 }] };
  const marked = chatRows([recordMsg, interactive] as never, recordOpts([RECORD_GROUP]));
  expect(rowText(marked.find((r) => r.record?.kind === 'console')!)).toBe('‼ bun test · interactive · ✓ <1s');
  // A body opened in the pager names what it is.
  const row = (kind: string) => rows.find((r) => r.record?.kind === kind)!;
  expect(pagerTitle([row('thought')], row('thought').record!.id)).toBe('thought');
  expect(pagerTitle([row('tool')], row('tool').record!.id)).toBe('tool call');
  expect(pagerTitle([row('console')], row('console').record!.id)).toBe('output');
});

test('a record expands to its own body and collapses again', async () => {
  const thoughtId = `${RECORD_GROUP}:1`;
  const toolId = `${RECORD_GROUP}:2`;
  const outputId = `${RECORD_GROUP}:4`;
  // The thought's own body under its line — the calls and the console stay one line each.
  const thoughtOpen = records([thoughtId]);
  expect(thoughtOpen.map(rowText)).toContain('The log is long.');
  expect(thoughtOpen.filter((r) => r.record).map(rowText)).toEqual([
    'thought: Read the log first.', '⌁ git_status · ok', '⌁ git_diff · ok', '! echo "hi" · ✗ exit 1 · <1s',
  ]);
  expect(thoughtOpen.map(rowText).some((t) => t.includes('→ ok'))).toBe(false);
  // On screen the open record is `▾`, and the body sits in the record's own block.
  const shown = await chatFrame({ messages: [recordMsg, consoleMsg], folds: { open: false, except: new Set([RECORD_GROUP, thoughtId]) } });
  expect(shown.lines.some((l) => l.includes('▾ thought: Read the log first.'))).toBe(true);
  expect(shown.lines.some((l) => l.includes('The log is long.'))).toBe(true);
  // A call opens to what it was given and what it answered; the console to its output.
  const toolOpen = records([toolId, outputId]);
  const toolText = toolOpen.map(rowText);
  expect(toolText).toContain('→ ok');
  expect(toolText.some((t) => t.includes('│ hi'))).toBe(true);
  expect(toolText).not.toContain('The log is long.');
  // The click path is the folds' own: the record row carries its id, and the same
  // toggle the chat applies to a click takes the body away again.
  const row = thoughtOpen.find((r) => r.record?.kind === 'thought')!;
  expect(row.fold).toBe(thoughtId);
  const closed = chatRows([recordMsg, consoleMsg] as never, recordOpts());
  expect(closed.map(rowText)).not.toContain('The log is long.');
  // `^o` opens one level at a time: the stretches first — a record a line each — then
  // every record's body, then it closes everything.
  const level1 = nextFoldLevel({ open: false, except: new Set() }, closed);
  expect(level1.open).toBe(true);
  const atLevel1 = chatRows([recordMsg, consoleMsg] as never, { ...recordOpts(), folds: level1 });
  const level2 = nextFoldLevel(level1, atLevel1);
  const atLevel2 = chatRows([recordMsg, consoleMsg] as never, { ...recordOpts(), folds: level2 });
  expect(atLevel2.map(rowText)).toContain('The log is long.');
  expect(atLevel2.map(rowText)).toContain('→ ok');
  expect(nextFoldLevel(level2, atLevel2).open).toBe(false);
});

// A command is read by the command it ran — `⌁ run_command · ok` would hide the one fact
// the line exists for — and a write that landed still says so on its record line.
test('a command record line shows the command, and a landed write keeps its ✎', () => {
  const recordOf = (run: Record<string, unknown>) => {
    const msg = { role: 'assistant', content: '', parts: [{ kind: 'tools', runs: [run] }] };
    const group = chatRows([msg] as never, groupOpts()).find((r) => r.group)!;
    const opened = groupOpts({ open: false, except: new Set([group.group!.id]) });
    return chatRows([msg] as never, opened).find((r) => r.record?.kind === 'tool')!;
  };
  expect(rowText(recordOf({ name: 'run_command', args: { command: 'bun test' }, outcome: 'ok' }))).toBe('⌁ bun test · ok');
  const wrote = rowText(recordOf({ name: 'write', args: {}, write: true, outcome: 'applied' }));
  expect(wrote).toContain('applied');
  expect(wrote).toContain('✎');
});

// A command can carry a line break (a short string arg is kept verbatim) and a
// view-less `run_command` is a trail record: its line is still ONE row, or the rows the
// conversation counts and the rows on screen drift apart.
test('a command record line is one row, whatever line breaks the command carried', async () => {
  const msg = { role: 'assistant', content: '', parts: [{ kind: 'tools', runs: [{ name: 'run_command', args: { command: 'cd /tmp\nls' }, outcome: 'declined' }] }] };
  const group = chatRows([msg] as never, groupOpts()).find((r) => r.group)!;
  const opened = groupOpts({ open: false, except: new Set([group.group!.id]) });
  const recordRow = chatRows([msg] as never, opened).find((r) => r.record?.kind === 'tool')!;
  expect(rowText(recordRow)).toBe('⌁ cd /tmp ls · declined ✗');
  expect(rowText(recordRow)).not.toContain('\n');
  const frame = await chatFrame({ messages: [msg], folds: opened.folds });
  expect(frame.lines.filter((l) => l.includes('⌁ cd /tmp'))).toHaveLength(1);
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


// The column's measures, as the chat's keys read them.
const room = (over: Record<string, unknown> = {}) => chatRoom({ width: 80, height: 24, input: '', ...over });

test('chatRoom says hidden for a question, a y/n, /context, the pager, the picker and a panel', () => {
  expect(room().hidden).toBe(false);
  expect(room({ pendingConfirm: { name: 'run_command', args: '{}' } }).hidden).toBe(true);
  expect(room({ pendingQuestion: askStart([{ question: 'q?', header: 'h', options: [{ label: 'a', description: 'd' }, { label: 'b', description: 'e' }] }] as never) }).hidden).toBe(true);
  expect(room({ pager: { rows: [], title: 't' } }).hidden).toBe(true);
  expect(room({ watch: { path: ['a'], rows: [], state: '', ended: false, ask: null } }).hidden).toBe(true);
  expect(room({ panel: {} }).hidden).toBe(true);
});

// A watched child (ask-children-spec.md (watching a child)): its rows in the list's place under a
// breadcrumb title, the hint row naming what it does and the keys, and none of the session's
// plan, queue, field or completion.
test('the chat draws a watched child: breadcrumb title, its rows, state and keys in the hint row, no field or plan', async () => {
  const o: RowOpts = { wrap: 60, folds: { open: false, except: new Set() }, viewLines: 20, notes: 'step', detailsKey: '^o', renderers: {}, now: 0, palette: {} };
  const rows = chatRows([{ role: 'user', content: 'child task' }, { role: 'assistant', content: 'child words' }], o);
  const draw = async (watch: Record<string, unknown>) => {
    const backend = new TestBackend(100, 24);
    const handle = await render(h(renderChatModal, {
      ...baseChat, width: 100, messages: [{ role: 'user', content: 'session words' }], queued: ['queued thing'], input: 'draft text',
      todo: [{ id: '1', text: 'session plan item', status: 'pending' }],
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
  for (const hidden of ['draft text', 'queued thing', 'session plan item', 'history']) expect(live).not.toContain(hidden);
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

// Draw the panel at the width the chat will hand it, and read back the frame. A
// narrow terminal is a real case — `width`/`wrap` draw the panel at one.
async function diffFrame(props: {
  sections: DiffSection[];
  collapsed: ReadonlySet<string>;
  cursor: string | null;
  palette?: Record<string, string | undefined>;
  width?: number;
  wrap?: number;
  loading?: boolean;
  gitless?: boolean;
  failed?: boolean;
}) {
  const { width, wrap, ...rest } = props;
  const backend = new TestBackend(width ?? 80, 24);
  const handle = await render(h(renderDiffPanel, {
    ...rest,
    gitless: props.gitless ?? false,
    failed: props.failed ?? false,
    wrap: wrap ?? 74,
    bg: 'black',
  }), backend);
  const frame = backend.lastFrame ?? '';
  return { frame, handle, backend };
}

test('the diff panel lists a file with its hunks and folds what is collapsed', async () => {
  const section: DiffSection = {
    root: '/r', base: 'HEAD',
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
  const empty: DiffSection = { root: '/r', base: 'HEAD', files: [] };
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
    root: '/r', base: 'HEAD',
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
  const section: DiffSection = { root: '/r', base: 'HEAD', files };
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
      root: '/a', base: 'HEAD',
      files: [{ status: 'M', path: 'a.txt', added: 2, removed: 1, hunks: '@@ -1 +1 @@\n-x\n+y\n+z' }],
    },
    {
      root: '/b', base: 'HEAD',
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
    root: '/r', base: 'HEAD',
    files: [{ status: 'M', path: 'src/app.ts', added: 12, removed: 3, hunks: '@@ -1,3 +1,12 @@\n-gone\n+here' }],
  };
  const drawn = await diffFrame({
    sections: [section], collapsed: new Set(), cursor: diffFileKey('/r', 'src/app.ts'),
    palette: { accent: 'cyan', add: 'green', del: 'red', addBg: '#003b00', delBg: '#3b0000' },
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
  // the palette's `add` for what came in, `del` for what went out: a deletion is not
  // what waits on the person.
  expect(fgAt('src/app.ts')).toBe('cyan');
  expect(fgAt('+here')).toBe('green');
  expect(fgAt('-gone')).toBe('red');
  // The line number is chrome: a drag over the row copies the code and not the gutter.
  const y = rowOf('-gone');
  const drag = drawn.handle.select({ x: 2, y }, { x: 30, y });
  expect(drag).not.toContain('1');
  expect(drag).toContain('-gone');
  drawn.handle.unmount();
});

// The band is the palette's and covers the code area only: the line-number gutter keeps
// the panel's own ground, the band runs past the end of the text to the panel's right
// edge — and a drag over the row still copies the code alone.
test('a diff row wears the palette band across the code area, never over the gutter', async () => {
  const section: DiffSection = {
    root: '/r', base: 'HEAD',
    files: [{ status: 'M', path: 'a.txt', added: 1, removed: 1, hunks: '@@ -1 +1 @@\n-one\n+two' }],
  };
  const drawn = await diffFrame({
    sections: [section], collapsed: new Set(), cursor: null,
    palette: { bg: 'black', add: 'green', del: 'red', addBg: '#003b00', delBg: '#3b0000' },
  });
  const rows = drawn.frame.split('\n');
  const y = rows.findIndex((r) => r.includes('-one'));
  const x = rows[y]!.indexOf('-one');
  const at = (col: number) => drawn.backend.lastBuffer!.get(col, y).style;
  expect(at(x).bg).toBe('#3b0000');
  expect(at(x + 20).bg).toBe('#3b0000'); // well past the text
  expect(at(2).bg).toBe('black');        // the file's line number keeps the panel's ground
  const drag = drawn.handle.select({ x: 2, y }, { x: 60, y });
  expect(drag).toContain('-one');
  expect(drag).not.toContain('1');
  drawn.handle.unmount();
});

// Review Focus: the band is width-relative — on a narrow panel it still covers the
// code area alone, and the number beside the code still keeps the panel's ground.
test('on a narrow panel the band still covers the code area alone', async () => {
  const section: DiffSection = {
    root: '/r', base: 'HEAD',
    files: [{ status: 'M', path: 'a-file.txt', added: 1, removed: 1, hunks: '@@ -1 +1 @@\n-one removed line\n+two' }],
  };
  const drawn = await diffFrame({
    sections: [section], collapsed: new Set(), cursor: null,
    palette: { bg: 'black', add: 'green', del: 'red', addBg: '#003b00', delBg: '#3b0000' },
    width: 40, wrap: 34,
  });
  const rows = drawn.frame.split('\n');
  const y = rows.findIndex((r) => r.includes('-one'));
  expect(y).toBeGreaterThanOrEqual(0);
  const x = rows[y]!.indexOf('-one');
  const at = (col: number) => drawn.backend.lastBuffer!.get(col, y).style;
  expect(at(x).bg).toBe('#3b0000');   // under the code
  expect(at(x + 6).bg).toBe('#3b0000');
  expect(at(x - 1).bg).toBe('black'); // the number beside it keeps the panel's ground
  drawn.handle.unmount();
});

test('a hunk longer than the chat\'s 80-line cap is drawn whole', async () => {
  // `unifiedDiff`'s 80 lines are the in-chat `✎` block's cap; the panel is a reader and
  // draws every row the section holds, however tall.
  const added = Array.from({ length: 100 }, (_, i) => `+line ${i + 1}`).join('\n');
  const section: DiffSection = {
    root: '/r', base: 'HEAD',
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
    root: '/r', base: 'HEAD',
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
    root: '/r', base: 'HEAD',
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
  root: '/r', base: 'HEAD',
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

// ─── /diff: the walk's items and the moves ────────────────────────────────────
// The cursor rests on a row of interest — a file's own row or a hunk's first row —
// and `diffPanelItems` lists those rows in the drawn order. The moves walk one kind
// of row over it: file rows (↑/↓) or hunk starts (] [), each clamped at the ends.
const walkSections: DiffSection[] = [{
  root: '/r', base: 'HEAD',
  files: [
    { status: 'M', path: 'a.txt', added: 3, removed: 2, hunks: '@@ -1,2 +1,3 @@\n-x\n+y\n+z\n@@ -20,2 +21,2 @@\n-p\n+q' },
    { status: 'A', path: 'b.txt', added: 1, removed: 0, hunks: '@@ -0,0 +1 @@\n+new' },
  ],
}];
const aFile: DiffCursor = { fileKey: diffFileKey('/r', 'a.txt'), hunk: -1 };
const aHunk0: DiffCursor = { fileKey: aFile.fileKey, hunk: 0 };
const aHunk1: DiffCursor = { fileKey: aFile.fileKey, hunk: 1 };
const bFile: DiffCursor = { fileKey: diffFileKey('/r', 'b.txt'), hunk: -1 };
const bHunk0: DiffCursor = { fileKey: bFile.fileKey, hunk: 0 };

test('diffPanelItems walks file rows and hunk starts in drawn order', () => {
  // Two files — the first with two hunks, the second folded by key. The fold is what
  // takes the second file's hunks out of the walk: its row is all it offers.
  expect(diffPanelItems(walkSections, new Set([bFile.fileKey]))).toEqual([aFile, aHunk0, aHunk1, bFile]);
  expect(diffPanelItems(walkSections, new Set())).toEqual([aFile, aHunk0, aHunk1, bFile, bHunk0]);
  // A file with a note has no hunk rows under it, so its row is all it offers too.
  const noted: DiffSection[] = [{ root: '/r', base: 'HEAD', files: [{ status: 'M', path: 'img.png', added: 0, removed: 0, hunks: '', note: 'binary' }] }];
  expect(diffPanelItems(noted, new Set())).toEqual([{ fileKey: diffFileKey('/r', 'img.png'), hunk: -1 }]);
  // A file keyed by something other than its drawn path keys its row by that.
  const keyed: DiffSection[] = [{ root: '/r', base: 'HEAD', files: [{ ...noted[0]!.files[0]!, path: 'draft.md', key: 'notes.md' }] }];
  expect(diffPanelItems(keyed, new Set())).toEqual([{ fileKey: diffFileKey('/r', 'notes.md'), hunk: -1 }]);
});

test('diffFileMove walks file rows and clamps at the ends', () => {
  const items = diffPanelItems(walkSections, new Set());
  // From no cursor at all, the direction picks the end to start from.
  expect(diffFileMove(items, null, 1)).toEqual(aFile);
  expect(diffFileMove(items, null, -1)).toEqual(bFile);
  expect(diffFileMove(items, aFile, 1)).toEqual(bFile);
  expect(diffFileMove(items, bFile, -1)).toEqual(aFile);
  // At either end a move past the end stays put: the walk never wraps or falls off.
  expect(diffFileMove(items, aFile, -1)).toEqual(aFile);
  expect(diffFileMove(items, bFile, 1)).toEqual(bFile);
  // From a hunk's row the next file row below is the next file's own row.
  expect(diffFileMove(items, aHunk1, 1)).toEqual(bFile);
});

test('diffHunkMove walks hunk starts across files', () => {
  const items = diffPanelItems(walkSections, new Set());
  // From a file's own row a hunk move lands on that file's first hunk…
  expect(diffHunkMove(items, aFile, 1)).toEqual(aHunk0);
  // …and from its last hunk on the next file's first hunk: hunk starts cross files.
  expect(diffHunkMove(items, aHunk1, 1)).toEqual(bHunk0);
  expect(diffHunkMove(items, bHunk0, -1)).toEqual(aHunk1);
  // The last hunk start of the walk is its end: one more step stays put.
  expect(diffHunkMove(items, bHunk0, 1)).toEqual(bHunk0);
  // With every file folded there is no hunk start at all — the cursor is unchanged.
  const folded = diffPanelItems(walkSections, new Set([aFile.fileKey, bFile.fileKey]));
  expect(diffHunkMove(folded, bHunk0, 1)).toEqual(bHunk0);
  expect(diffHunkMove(folded, null, -1)).toBeNull();
});

test('diffFirstItem and diffLastItem are the ends of the list', () => {
  const items = diffPanelItems(walkSections, new Set());
  expect(diffFirstItem(items)).toEqual(items[0]!);
  expect(diffLastItem(items)).toEqual(items[items.length - 1]!);
  expect(diffFirstItem([])).toBeNull();
  expect(diffLastItem([])).toBeNull();
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

// ─── one palette for a diff wherever the chat draws it ───────────────────────
// The `✎` block of a write and a ```diff fence in an answer take the chat's own
// `add`/`del` and their grounds — the same the `/diff` panel reads.

test('a change block and a diff the model writes take the chat palette', async () => {
  const chat = { ...MODAL_COLOR_DEFAULTS.chat, add: 'greenBright', del: 'redBright', addBg: '#123456', delBg: '#654321' };
  const messages = [{
    role: 'assistant',
    content: 'Here:\n```diff\n-old\n+new\n```',
    parts: [{ kind: 'change', change: { title: 'src/a.ts', diff: '@@ -1,1 +1,1 @@\n-a\n+b', added: 1, removed: 1, hidden: 0 } }],
  }];
  const backend = new TestBackend(80, 24);
  const handle = await render(h(renderChatModal, { ...baseChat, theme: { modals: { chat } }, messages }), backend);
  const lines = backend.lastFrame.split('\n');
  const styleAt = (needle: string) => {
    const y = lines.findIndex((r) => r.includes(needle));
    expect(y).toBeGreaterThanOrEqual(0);
    return backend.lastBuffer!.get(lines[y]!.indexOf(needle), y).style;
  };
  // The write's own block …
  expect(styleAt('-a')).toMatchObject({ fg: 'redBright', bg: '#654321' });
  expect(styleAt('+b')).toMatchObject({ fg: 'greenBright', bg: '#123456' });
  // … and the fence the model wrote, which is laid out by the same helper.
  expect(styleAt('-old')).toMatchObject({ fg: 'redBright', bg: '#654321' });
  expect(styleAt('+new')).toMatchObject({ fg: 'greenBright', bg: '#123456' });
  handle.unmount();
});

// Review Focus: a palette that names no band draws NO band — the palette is the whole
// word on what a changed row looks like, and the ink is still the palette's.
test('a palette without bands draws no band, and the ink is the palette\'s', async () => {
  const chat = { ...MODAL_COLOR_DEFAULTS.chat, add: 'blue', del: 'magenta', addBg: undefined, delBg: undefined };
  const messages = [{ role: 'assistant', content: 'x', parts: [{ kind: 'change', change: { title: 'a', diff: '@@ -1 +1 @@\n-a\n+b', added: 1, removed: 1, hidden: 0 } }] }];
  const backend = new TestBackend(80, 24);
  const handle = await render(h(renderChatModal, { ...baseChat, theme: { modals: { chat } }, messages }), backend);
  const rows = backend.lastFrame.split('\n');
  const y = rows.findIndex((r) => r.includes('-a'));
  const style = backend.lastBuffer!.get(rows[y]!.indexOf('-a'), y).style;
  expect(style.fg).toBe('magenta');
  // `default` is flowtty's "no background" sentinel — the writer drops it, so the row
  // wears the ground it sits on and nothing else. Never the layout's dark fallback.
  expect([undefined, 'default']).toContain(style.bg);
  expect(style.bg).not.toBe('#3b0000');
  handle.unmount();
});

// Review Focus: the all-keys-missing palette (a panel's own object, a test's partial
// one) draws the diff as it reads — the layout's own inks, no band of anyone's.
test('a palette that names none of the diff keys draws no band in either drawer', async () => {
  const chat = { accent: 'cyan', bg: 'black', text: 'white' };
  const messages = [{ role: 'assistant', content: 'x', parts: [{ kind: 'change', change: { title: 'a', diff: '@@ -1 +1 @@\n-a\n+b', added: 1, removed: 1, hidden: 0 } }] }];
  const backend = new TestBackend(80, 24);
  const handle = await render(h(renderChatModal, { ...baseChat, theme: { modals: { chat } }, messages }), backend);
  const rows = backend.lastFrame.split('\n');
  const styleOf = (needle: string) => {
    const row = rows.findIndex((r) => r.includes(needle));
    expect(row).toBeGreaterThanOrEqual(0);
    return backend.lastBuffer!.get(rows[row]!.indexOf(needle), row).style;
  };
  // The same in both drawers: no band of anyone's — `default` or nothing at all.
  expect([undefined, 'default']).toContain(styleOf('-a').bg);
  expect([undefined, 'default']).toContain(styleOf('+b').bg);
  handle.unmount();

  const section: DiffSection = {
    root: '/r', base: 'HEAD',
    files: [{ status: 'M', path: 'a.txt', added: 1, removed: 1, hunks: '@@ -1 +1 @@\n-one\n+two' }],
  };
  const drawn = await diffFrame({ sections: [section], collapsed: new Set(), cursor: null, palette: chat });
  const drows = drawn.frame.split('\n');
  const dy = drows.findIndex((r) => r.includes('-one'));
  // The row sits on the panel's own ground — `bg` from the palette — and on nothing else.
  expect(drawn.backend.lastBuffer!.get(drows[dy]!.indexOf('-one'), dy).style.bg).toBe('black');
  drawn.handle.unmount();
});

// Review Focus: a change block inside a stretch opened with `^o` is the same rows —
// the fold is a filter over rows the palette already painted.
test('a change block in an opened stretch takes the same palette', () => {
  const chat = { ...MODAL_COLOR_DEFAULTS.chat, add: 'greenBright', del: 'redBright', addBg: '#123456', delBg: '#654321' };
  const changed = {
    role: 'assistant', content: '',
    parts: [
      { kind: 'tools', runs: [{ name: 'git_status', outcome: 'ok' }] },
      { kind: 'change', change: { title: 'src/a.ts', diff: '@@ -1,1 +1,1 @@\n-a\n+b', added: 1, removed: 1, hidden: 0 } },
    ],
  };
  const rows = chatRows([changed] as never, { ...groupOpts(), notes: 'open', palette: chat });
  const spans = rows.flatMap((r) => r.spans ?? []);
  expect(spans.find((s) => s.text === '-a')).toMatchObject({ color: 'redBright', background: '#654321' });
  expect(spans.find((s) => s.text === '+b')).toMatchObject({ color: 'greenBright', background: '#123456' });
});
