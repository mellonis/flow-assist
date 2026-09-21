// The chat as a person meets it, through the real TUI with a scripted model.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// The style of the cell where `text` starts (plus `offset` cells).
function styleAt(backend: { lastBuffer: any; lastFrame: string }, text: string, offset = 0) {
  const rows = backend.lastFrame.split('\n');
  const y = rows.findIndex((r) => r.includes(text));
  if (y < 0) throw new Error(`"${text}" is not on screen:\n${backend.lastFrame}`);
  return backend.lastBuffer.get(rows[y]!.indexOf(text) + offset, y).style as { fg?: string; bg?: string; bold?: boolean; dim?: boolean };
}

test('messages carry a marker and colour instead of a role label', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Three commits ahead of master.' }]);
  const ui = await bootApp(model, 100, 24);
  await ui.press('F');

  // The input reads as a field: a prompt in the accent colour, on its own ground.
  expect(ui.backend.lastFrame).toContain('› ');
  expect(styleAt(ui.backend, '› ').fg).toBe('cyan');
  expect(styleAt(ui.backend, '› ').bg).toBe('#1f1f2e');

  await ui.type('how far is my branch');
  await ui.press('return');
  await settle(14);
  const frame = ui.backend.lastFrame;

  // No role labels anywhere — the marker and the ground say who is speaking.
  for (const label of ['You', 'Assistant', 'Background', 'Context']) expect(frame).not.toMatch(new RegExp(`│ ${label}\\b`));
  expect(frame).toContain('› how far is my branch');
  expect(frame).toContain('Three commits ahead of master.');

  // The person's message: the same accent prompt as the field, on the user ground.
  const mine = styleAt(ui.backend, '› how far is my branch');
  expect(mine.fg).toBe('cyan');
  expect(mine.bg).toBe('#2b2b40');
  expect(styleAt(ui.backend, '› how far is my branch', 2).bg).toBe('#2b2b40');
  // The answer carries the assistant's own mark — ƒ, in its own colour — on the plain
  // modal ground, its text aligned under the message text.
  expect(frame).toMatch(/│ ƒ Three commits ahead/);
  const its = styleAt(ui.backend, 'ƒ Three commits ahead');
  expect(its.fg).toBe('green');
  expect(its.bg).toBe('black');
  expect(styleAt(ui.backend, 'Three commits ahead').bg).toBe('black');
  // The same mark signs the frame; the title dangles no preposition without a context.
  expect(frame).toContain('ƒ Flow Assist');
  expect(frame).not.toContain('Chat about');
  ui.app.unmount();
});

test('Enter while an answer is streaming queues the message, and it is sent when the turn ends', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Looking, ' }, { hold: true }, { text: 'three ahead.' }], [{ text: 'CI is green.' }]);
  const ui = await bootApp(model, 100, 26);
  await ui.press('F');
  await ui.type('how far is my branch');
  await ui.press('return');

  // The field stays a field while the answer comes — it used to turn into "…".
  await ui.type('and is CI green');
  expect(ui.backend.lastFrame).toContain('› and is CI green');
  await ui.press('return');

  // Queued, said so, and the field is free again. Nothing was sent yet.
  expect(ui.backend.lastFrame).toMatch(/queued.*and is CI green/);
  expect(ui.backend.lastFrame).not.toContain('› and is CI green');
  expect(model.requests).toHaveLength(1);

  model.release();
  await settle(24);

  // The queued message went out on its own, after the first turn — in order.
  expect(model.requests).toHaveLength(2);
  expect(model.requests[1]!.messages.at(-1)).toMatchObject({ role: 'user', content: 'and is CI green' });
  expect(ui.backend.lastFrame).toContain('CI is green.');
  expect(ui.backend.lastFrame).not.toMatch(/queued/);
  ui.app.unmount();
});

test('Esc takes the last queued message back into the field instead of cancelling the answer', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Looking, ' }, { hold: true }, { text: 'done.' }]);
  const ui = await bootApp(model, 100, 26);
  await ui.press('F');
  await ui.type('first');
  await ui.press('return');
  await ui.type('second thoughts');
  await ui.press('return');
  expect(ui.backend.lastFrame).toMatch(/queued/);

  await ui.press('escape');
  // Back in the field for editing; the answer is still coming.
  expect(ui.backend.lastFrame).toContain('› second thoughts');
  expect(ui.backend.lastFrame).not.toMatch(/queued/);

  model.release();
  await settle(24);
  expect(ui.backend.lastFrame).toContain('done.');
  expect(model.requests).toHaveLength(1);
  ui.app.unmount();
});

test('↑/↓ walk the prompt history; the draft in progress is not lost', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'one.' }], [{ text: 'two.' }]);
  const ui = await bootApp(model, 100, 26);
  await ui.press('F');
  await ui.type('first prompt');
  await ui.press('return');
  await settle(14);
  await ui.type('second prompt');
  await ui.press('return');
  await settle(14);

  const field = () => ui.backend.lastFrame.split('\n').filter((r) => r.includes('› ')).at(-1) ?? '';
  await ui.press('up');
  expect(field()).toContain('› second prompt');
  await ui.press('up');
  expect(field()).toContain('› first prompt');
  await ui.press('up'); // already the oldest — stays
  expect(field()).toContain('› first prompt');
  await ui.press('down');
  expect(field()).toContain('› second prompt');
  await ui.press('down'); // past the newest — back to the (empty) draft
  expect(field()).not.toContain('prompt');

  // A draft being typed is never replaced by an arrow key.
  await ui.type('a new draft');
  await ui.press('up');
  expect(field()).toContain('› a new draft');
  ui.app.unmount();
});

test('a slash command completes inline: the rest of it is shown in the field, Tab takes it', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 24);
  await ui.press('F');
  const fieldRow = () => ui.backend.lastFrame.split('\n').filter((r) => r.includes('› ')).at(-1) ?? '';

  // The continuation appears IN the field, after what was typed — not on a row of
  // candidates somewhere above it.
  await ui.type('/co');
  expect(fieldRow()).toContain('› /compact');
  expect(ui.backend.lastFrame.split('\n').filter((r) => /\/compact/.test(r))).toHaveLength(1);
  // Typed text is plain; the suggested rest is the accent colour, dimmed.
  expect(styleAt(ui.backend, '› /compact', 2).dim).toBeFalsy();
  const ghost = styleAt(ui.backend, '› /compact', 6); // the "p" of com|pact — past the caret cell
  expect(ghost.dim).toBe(true);
  expect(ghost.fg).toBe('cyan');

  // Tab takes it; the field now holds the whole command and nothing is suggested.
  await ui.press('tab');
  expect(fieldRow()).toContain('› /compact');
  expect(styleAt(ui.backend, '› /compact', 6).dim).toBeFalsy();

  // With several candidates the others are named beside it, and Tab walks them.
  await ui.press('escape');
  await ui.type('/');
  expect(fieldRow()).toMatch(/› \/context|› \/clear|› \/compact|› \/log|› \/exit/);
  expect(fieldRow()).toMatch(/⇥/);
  await ui.press('tab');
  const first = fieldRow();
  await ui.press('tab');
  expect(fieldRow()).not.toBe(first);
  ui.app.unmount();
});

test('text to the right of the caret is drawn like the text to its left', async () => {
  // It used to be dimmed — the placeholder's style had leaked onto real text, so
  // moving the caret back greyed out everything after it.
  const ui = await bootApp(new ScriptedModel(), 100, 24);
  await ui.press('F');
  await ui.type('hello world');
  await ui.press('left', 'left', 'left', 'left', 'left');
  const left = styleAt(ui.backend, '› hello world', 2); // "h"
  const right = styleAt(ui.backend, '› hello world', 10); // "o" of world, past the caret
  expect(left.dim).toBeFalsy();
  expect(right.dim).toBeFalsy();
  expect(right.fg).toBe(left.fg);
  ui.app.unmount();
});

test('a blank line between two thoughts is a row of the field on screen', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 24);
  await ui.press('F');
  await ui.type('first thought');
  ui.backend.press({ name: 'return', shift: true });
  ui.backend.press({ name: 'return', shift: true });
  await ui.type('second thought');
  const rows = ui.backend.lastFrame.split('\n');
  const first = rows.findIndex((r) => r.includes('› first thought'));
  const second = rows.findIndex((r) => r.includes('second thought'));
  expect(first).toBeGreaterThanOrEqual(0);
  // Exactly one row between them, and it is an empty row of the field itself.
  expect(second - first).toBe(2);
  expect(rows[first + 1]!.replace(/[│\s]/g, '')).toBe('');
  expect(ui.backend.lastBuffer!.get(rows[first]!.indexOf('›') + 4, first + 1).style.bg).toBe('#1f1f2e');
  ui.app.unmount();
});

test('the plan lists what is in progress first, and re-orders live without a crash', async () => {
  // Re-ordering keyed children used to abort Yoga inside flowtty, so the plan was
  // pinned to insertion order. Fixed in flowtty 1.0.0-alpha.5.
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'todo', args: { action: 'add', items: ['read the diff', 'run the tests', 'write the summary'] } }],
    [{ text: 'Planned.' }],
    [{ tool: 'todo', args: { action: 'start', text: 'write the summary' } }],
    [{ text: 'Started the summary.' }],
  );
  const ui = await bootApp(model, 100, 30);
  await ui.press('F');
  await ui.type('plan it');
  await ui.press('return');
  await settle(20);
  const order = () => ui.backend.lastFrame.split('\n').filter((r) => /[☐◐☑] \d+ · /.test(r)).map((r) => r.replace(/^.*· /, '').replace(/[│\s]+$/, ''));
  expect(order()).toEqual(['read the diff', 'run the tests', 'write the summary']);

  await ui.type('start the last one');
  await ui.press('return');
  await settle(24);
  // The item in progress moved to the top; the app is still alive and drew the answer.
  expect(order()).toEqual(['write the summary', 'read the diff', 'run the tests']);
  expect(ui.backend.lastFrame).toContain('Started the summary.');
  ui.app.unmount();
});

// A paste arrives as ONE key, { name: 'paste', text } (flowtty ≥ 1.0.0-alpha.6,
// bracketed paste); the test backend delivers it the way a terminal would.
const paste = (ui: { backend: { paste(text: string): void } }, text: string) => ui.backend.paste(text);

test('a multi-line paste lands in the field as text — it sends nothing and fires no binding', async () => {
  // Without bracketed paste a pasted newline IS the Enter key: the first line was
  // sent and the rest arrived as keystrokes, single-letter bindings included.
  const model = new ScriptedModel();
  const ui = await bootApp(model, 100, 26);
  await ui.press('F');
  await ui.type('see: ');
  paste(ui, 'TypeError: x is undefined\n    at run (a.ts:3)\n\nq y n A');
  await settle();

  const frame = ui.backend.lastFrame;
  expect(frame).toContain('› see: TypeError: x is undefined');
  expect(frame).toContain('at run (a.ts:3)');
  expect(frame).toContain('q y n A');
  // The blank line inside the paste is kept, nothing was sent, the chat is still open.
  const rows = frame.split('\n');
  expect(rows.findIndex((r) => r.includes('q y n A')) - rows.findIndex((r) => r.includes('at run (a.ts:3)'))).toBe(2);
  expect(model.requests).toHaveLength(0);

  // The caret is after the pasted text: typing continues it.
  await ui.type('!');
  expect(ui.backend.lastFrame).toContain('q y n A!');

  // Pasted in the middle, it goes in at the caret.
  await ui.press('escape');
  await ui.type('ab');
  await ui.press('left');
  paste(ui, 'XY');
  await settle();
  expect(ui.backend.lastFrame).toContain('› aXYb');
  ui.app.unmount();
});

test('a paste while the chat is closed does nothing — it never reaches a single-letter binding', async () => {
  const model = new ScriptedModel();
  const ui = await bootApp(model, 100, 26);
  const before = ui.backend.lastFrame;
  paste(ui, 'A quick q');
  await settle();
  expect(ui.backend.lastFrame).toBe(before);
  ui.app.unmount();
});

test('the wheel scrolls the conversation', async () => {
  const model = new ScriptedModel();
  model.script([{ text: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n\n') }]);
  const ui = await bootApp(model, 100, 22);
  await ui.press('F');
  await ui.type('print forty lines');
  await ui.press('return');
  await settle(20);
  expect(ui.backend.lastFrame).toContain('line 40');
  expect(ui.backend.lastFrame).not.toContain('line 30\n');
  // The question has scrolled out of view, so it is pinned above the conversation.
  expect(ui.backend.lastFrame).toContain('› print forty lines');

  // The scroll box answers the wheel only while the pointer is over it — as any
  // scrolling pane does. (20, 8) is inside the conversation; (0, 0) is the app title.
  for (let i = 0; i < 6; i++) ui.backend.wheel('up', 0, 0);
  await settle();
  expect(ui.backend.lastFrame).toContain('line 40');
  for (let i = 0; i < 6; i++) ui.backend.wheel('up', 20, 8);
  await settle();
  const up = ui.backend.lastFrame;
  expect(up).not.toContain('line 40');
  for (let i = 0; i < 6; i++) ui.backend.wheel('down', 20, 8);
  await settle();
  expect(ui.backend.lastFrame).toContain('line 40');
  // PgUp / PgDn need no pointer.
  await ui.press('pageup');
  expect(ui.backend.lastFrame).not.toContain('line 40');
  // Sending a message brings the view back to the newest rows.
  model.script([{ text: 'the newest answer' }]);
  await ui.type('again');
  await ui.press('return');
  await settle(20);
  expect(ui.backend.lastFrame).toContain('the newest answer');
  ui.app.unmount();
});

// A turn that hands work to the background: the model calls `background`, says so,
// and the nested run answers with RESULT. Three requests in all — a fourth would be
// the chat spending a turn on the result by itself.
const backgroundScript = (model: ScriptedModel, result: string) => model.script(
  [{ tool: 'background', args: { task: 'count the TODO comments' } }],
  [{ text: 'Started it in the background.' }],
  [{ text: result }],
);

test('a background result shows at once — a half-typed draft does not hold it back, and no turn is spent on it', async () => {
  // It used to wait for an EMPTY field with nothing on screen saying so: type half
  // a line, stop to think, and a finished task stayed invisible indefinitely.
  const model = new ScriptedModel();
  backgroundScript(model, 'There are 14 TODO comments.');
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await ui.type('count the TODOs in the background');
  await ui.press('return');
  await ui.type('meanwhile, half a th');
  await settle(40);

  const frame = ui.backend.lastFrame;
  expect(frame).toContain('◆ ');
  expect(frame).toContain('There are 14 TODO comments.');
  expect(frame).toContain('› meanwhile, half a th');
  expect(model.requests).toHaveLength(3);
  // The chat is open — the result is in front of the person, the terminal stays quiet.
  expect(ui.backend.notifications).toEqual([]);
  expect(ui.backend.bells).toBe(0);

  // The model still learns of it: the result rides in the history of the next turn.
  model.script([{ text: 'Noted: 14.' }]);
  await ui.press('escape');
  await ui.type('how many was that');
  await ui.press('return');
  await settle(20);
  const sent = model.requests.at(-1)!.messages as { role: string; content: string }[];
  expect(sent.some((m) => m.role === 'user' && String(m.content).includes('There are 14 TODO comments.'))).toBe(true);
  ui.app.unmount();
});

test('a fired reminder asks the terminal for attention as well as drawing its banner', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'remind', args: { in: '0.2 seconds', text: 'blink' } }],
    [{ text: 'Will do.' }],
  );
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await ui.type('remind me to blink');
  await ui.press('return');
  await settle(20);
  expect(ui.backend.notifications).toEqual([]);
  await new Promise((r) => setTimeout(r, 300));
  await settle(4);
  expect(ui.backend.lastFrame).toContain('blink');
  expect(ui.backend.notifications).toEqual([{ title: '⏰ Reminder', body: 'blink' }]);
  ui.app.unmount();
});

test('a background result does not open the chat — the footer says it is waiting', async () => {
  const model = new ScriptedModel();
  // The nested run is held, so the task is still working when the chat is closed.
  model.script(
    [{ tool: 'background', args: { task: 'count the TODO comments' } }],
    [{ text: 'Started it in the background.' }],
    [{ hold: true }, { text: 'There are 14 TODO comments.' }],
  );
  const ui = await bootApp(model, 100, 28);
  // Closed, the chat is reachable from the footer at all — and a chat hint alone
  // does not drag in the cache hint, which belongs to plugins that cache.
  expect(ui.backend.lastFrame).toMatch(/F chat/);
  expect(ui.backend.lastFrame).not.toContain('flush cache');

  await ui.press('F');
  await ui.type('count the TODOs in the background');
  await ui.press('return');
  await settle(20);
  await ui.press('escape', 'escape'); // close while the task is still running
  model.release();
  await settle(40);

  // Still closed. The host's toast announces the result first — it takes the
  // footer's place for four seconds — and the count is what remains once it is gone.
  expect(ui.backend.lastFrame).not.toContain('Flow Assist');
  expect(ui.backend.lastFrame).toContain('count the TODO comments done');
  // Nobody is looking at the chat, so the terminal is asked to say so too.
  expect(ui.backend.notifications).toEqual([{ title: 'flow-assist', body: 'count the TODO comments finished:' }]);
  await new Promise((r) => setTimeout(r, 4100));
  await settle(4);
  expect(ui.backend.lastFrame).not.toContain('Flow Assist');
  expect(ui.backend.lastFrame).toMatch(/F chat · ◆ 1 new/);

  // Opening it shows the result and clears the count.
  await ui.press('F');
  expect(ui.backend.lastFrame).toContain('There are 14 TODO comments.');
  await ui.press('escape', 'escape');
  expect(ui.backend.lastFrame).toMatch(/F chat/);
  expect(ui.backend.lastFrame).not.toMatch(/◆ \d+ new/);
  ui.app.unmount();
});

// ── The field's editing is flowtty's editor reducer. These pin what the chat relies
// on from it, through the real key path, so a flowtty upgrade that changes any of it
// fails here and not in somebody's terminal.
const fieldText = (ui: { backend: { lastFrame: string } }) =>
  (ui.backend.lastFrame.split('\n').filter((r) => r.includes('› ')).at(-1) ?? '').replace(/^.*› /, '').replace(/\s*│\s*$/, '');

test('an emoji is one character: the caret steps over it and backspace removes it whole', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'ok' }]);
  const ui = await bootApp(model, 100, 24);
  await ui.press('F');
  paste(ui, 'a😀b');
  await settle();
  await ui.press('left'); // before "b"
  await ui.press('backspace'); // the whole emoji goes — not half of a surrogate pair
  expect(fieldText(ui)).toBe('ab');
  await ui.press('return');
  await settle(14);
  // What reached the model is the clean string, with no lone surrogate in it.
  expect(model.requests[0]!.messages.at(-1)).toMatchObject({ role: 'user', content: 'ab' });
  ui.app.unmount();
});

test('an emoji can be typed, and a pasted CR never reaches the message', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'ok' }]);
  const ui = await bootApp(model, 100, 24);
  await ui.press('F');
  await ui.press('😀');
  paste(ui, 'one\r\ntwo\rthree');
  await settle();
  await ui.press('return');
  await settle(14);
  expect(model.requests[0]!.messages.at(-1)).toMatchObject({ role: 'user', content: '😀one\ntwo\nthree' });
  ui.app.unmount();
});

test('every newline key starts a new line, and none of them sends', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'ok' }]);
  const ui = await bootApp(model, 100, 24);
  await ui.press('F');
  await ui.type('a');
  ui.backend.press({ name: 'return', meta: true }); // Alt+Enter — what the hint names
  await settle();
  await ui.type('b');
  ui.backend.press({ name: 'return', shift: true }); // Shift+Enter, where the terminal sends it
  await settle();
  await ui.type('c\\');
  await ui.press('return'); // backslash-then-Enter: works in every terminal
  await ui.type('d');
  expect(model.requests).toHaveLength(0);
  await ui.press('return');
  await settle(14);
  expect(model.requests[0]!.messages.at(-1)).toMatchObject({ role: 'user', content: 'a\nb\nc\nd' });
  ui.app.unmount();
});

test('in a draft ↑/↓ move the caret between its rows; history is for an empty field', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'one.' }], [{ text: 'two.' }]);
  const ui = await bootApp(model, 100, 26);
  await ui.press('F');
  await ui.type('earlier prompt');
  await ui.press('return');
  await settle(14);

  paste(ui, 'top\nbottom');
  await settle();
  await ui.press('up'); // to the row above — NOT the history entry
  expect(ui.backend.lastFrame).not.toContain('› earlier prompt\n');
  await ui.type('!'); // lands on the first row, at the column the caret kept
  await ui.press('return');
  await settle(14);
  expect(model.requests[1]!.messages.at(-1)).toMatchObject({ role: 'user', content: 'top!\nbottom' });
  ui.app.unmount();
});

test('readline keys work in the field: word delete, kill to the line start', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'ok' }]);
  const ui = await bootApp(model, 100, 24);
  await ui.press('F');
  await ui.type('keep this drop');
  ui.backend.press({ name: 'w', ctrl: true }); // delete the word before the caret
  await settle();
  expect(fieldText(ui)).toBe('keep this');
  ui.backend.press({ name: 'u', ctrl: true }); // kill to the start of the line
  await settle();
  await ui.type('fresh');
  await ui.press('return');
  await settle(14);
  expect(model.requests[0]!.messages.at(-1)).toMatchObject({ role: 'user', content: 'fresh' });
  ui.app.unmount();
});

// ── The plan belongs to the conversation ──────────────────────────────────────
test('/clear starts a conversation with no plan, and a new chat does not inherit one', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'todo', args: { action: 'add', items: ['alpha item', 'beta item'] } }], [{ text: 'Planned.' }]);
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await ui.type('plan it');
  await ui.press('return');
  await settle(20);
  expect(ui.backend.lastFrame).toContain('▾ plan');
  expect(ui.backend.lastFrame).toContain('alpha item');

  // The plan described work the model no longer remembers after /clear. It used to
  // stay on screen — and in the system prompt — of the next conversation.
  await ui.type('/clear');
  await ui.press('return');
  await settle();
  expect(ui.backend.lastFrame).not.toContain('▾ plan');
  expect(ui.backend.lastFrame).not.toContain('alpha item');

  // …and the next turn's system prompt carries no plan block either.
  model.script([{ text: 'Hello.' }]);
  await ui.type('hi');
  await ui.press('return');
  await settle(14);
  expect(JSON.stringify(model.requests.at(-1)!.messages)).not.toContain('alpha item');
  ui.app.unmount();

  // A second chat in the same process — what every test after this one is.
  const other = await bootApp(new ScriptedModel(), 100, 28);
  await other.press('F');
  expect(other.backend.lastFrame).not.toContain('▾ plan');
  other.app.unmount();
});

test('a background task plans on its own plan, not on the chat\'s', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'background', args: { task: 'sweep the repo' } }],
    [{ text: 'Started it in the background.' }],
    // The nested run: it makes a plan of its own, then reports.
    [{ tool: 'todo', args: { action: 'add', items: ['nested step'] } }],
    [{ text: 'Swept.' }],
  );
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await ui.type('sweep it in the background');
  await ui.press('return');
  await settle(40);
  expect(ui.backend.lastFrame).toContain('Swept.');
  // Its checkboxes never appeared among the chat's.
  expect(ui.backend.lastFrame).not.toContain('nested step');
  expect(ui.backend.lastFrame).not.toContain('▾ plan');
  ui.app.unmount();
});

test('an open modal pushes the screen behind it back, and stays bright itself', async () => {
  // Something bright has to be BEHIND the chat and outside its frame. The start
  // screen is centred, so the chat covers all of it; an active guest's surface gets
  // the host's title bar in the top-left corner, which the chat does not reach.
  const guest = (make: any) => [make('boards', {
    name: 'boards',
    keycaps: () => ['c board'],
    components: { view: (ft: any) => function View() { return ft.h(ft.Text, null, 'a guest surface'); } },
  })];
  const ui = await bootApp(new ScriptedModel(), 100, 24, guest);
  // The host's own title, before anything is open.
  expect(styleAt(ui.backend, 'flow-assist').dim).toBeFalsy();
  await ui.press('F');
  // Behind the chat: same characters, dimmed. (A flag on the cell, not a repaint.)
  expect(ui.backend.lastFrame).toContain('flow-assist');
  expect(styleAt(ui.backend, 'flow-assist').dim).toBe(true);
  // The chat itself is not behind anything.
  expect(styleAt(ui.backend, 'ƒ Flow Assist').dim).toBeFalsy();
  expect(styleAt(ui.backend, '› ').dim).toBeFalsy();
  // Closed again, the screen comes back.
  await ui.press('escape', 'escape');
  expect(styleAt(ui.backend, 'flow-assist').dim).toBeFalsy();
  ui.app.unmount();
});
