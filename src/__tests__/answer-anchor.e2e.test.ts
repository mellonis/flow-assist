// A long answer is read from its first line: while it fits, the conversation follows
// the bottom; once its first row would leave the top (under the pinned question), the
// list stops there and the rest grows below the fold. AGENTS.md, "Where the eye is
// left" under The chat.

import { expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted.ts';

// One list item per row, so a line of the answer is exactly one row of the list.
const items = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `- ${prefix} ${String(from + i).padStart(2, '0')}`).join('\n');

// 35 terminal rows leave the chat window's conversation 20 rows.
const ROWS = 35;

const CONVERSATION_ROWS = 20;

// The conversation's lines, top to bottom: under the window's top border and its
// padding row, above the status or hint line, the field and the rows around them.
function conversation(frame: string): string[] {
  const lines = frame.split('\n');
  const top = lines.findIndex((l) => l.includes('╭'));
  const bottom = lines.findIndex((l) => l.includes('╰'));
  const rows = lines.slice(top + 2, bottom - 5).map((l) => l.replace(/^\s*│/, '').replace(/│\s*$/, '').trimEnd());
  expect(rows).toHaveLength(CONVERSATION_ROWS);
  return rows;
}

// The row the eye starts on: the one under the pinned question when it is pinned.
function topRow(frame: string, question: string): string {
  const rows = conversation(frame);
  return rows[0]!.includes(`› ${question}`) ? rows[1]! : rows[0]!;
}

test('a long answer stops at its first line, under the pinned question, and stays there through the stream', async () => {
  const model = new ScriptedModel();
  model.script([{ text: items('answer line', 1, 25) }, { hold: true }, { text: `\n${items('answer line', 26, 40)}` }]);
  const ui = await bootApp(model, 100, ROWS);
  await ui.press('F');
  await ui.type('print forty lines');
  await ui.press('return');
  await settle(20);
  // The first rows came in and passed the bottom: the question is pinned, the answer's
  // first line is the row right under it.
  expect(conversation(ui.backend.lastFrame)[0]).toContain('› print forty lines');
  expect(topRow(ui.backend.lastFrame, 'print forty lines')).toContain('answer line 01');
  expect(ui.backend.lastFrame).not.toContain('answer line 25');

  model.release();
  await settle(20);
  expect(topRow(ui.backend.lastFrame, 'print forty lines')).toContain('answer line 01');
  expect(ui.backend.lastFrame).not.toContain('answer line 40');

  // The person reads on with PgDn.
  await ui.press('pagedown');
  expect(topRow(ui.backend.lastFrame, 'print forty lines')).not.toContain('answer line 01');
  expect(ui.backend.lastFrame).toContain('answer line 30');
  await ui.press('pagedown');
  expect(ui.backend.lastFrame).toContain('answer line 40');
  ui.app.unmount();
});

test('a short answer leaves the list at the bottom, as it always did', async () => {
  const model = new ScriptedModel();
  model.script([{ text: items('filler', 1, 15) }], [{ text: items('short', 1, 5) }]);
  const ui = await bootApp(model, 100, ROWS);
  await ui.press('F');
  await ui.type('fill the screen');
  await ui.press('return');
  await settle(20);
  await ui.type('five lines');
  await ui.press('return');
  await settle(20);
  const rows = conversation(ui.backend.lastFrame);
  // Followed to the end: the last line of the answer is on screen, the start of the
  // conversation is not.
  expect(ui.backend.lastFrame).toContain('short 05');
  expect(ui.backend.lastFrame).toContain('› five lines');
  expect(ui.backend.lastFrame).not.toContain('filler 01');
  expect(rows.findLastIndex((r) => r.trim() !== '')).toBeGreaterThan(rows.length - 4);
  ui.app.unmount();
});

test('a person who scrolled up during the answer keeps their place', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ text: items('filler', 1, 15) }],
    [{ text: items('answer line', 1, 8) }, { hold: true }, { text: `\n${items('answer line', 9, 40)}` }],
  );
  const ui = await bootApp(model, 100, ROWS);
  await ui.press('F');
  await ui.type('fill the screen');
  await ui.press('return');
  await settle(20);
  await ui.type('print forty lines');
  await ui.press('return');
  await settle(20);
  await ui.press('pageup');
  const before = conversation(ui.backend.lastFrame);
  expect(before.join('\n')).toContain('filler');

  model.release();
  await settle(20);
  expect(conversation(ui.backend.lastFrame)).toEqual(before);
  ui.app.unmount();
});

test('back at the end mid-answer, the list follows again — the answer does not pull it back to its start', async () => {
  const model = new ScriptedModel();
  model.script([{ text: items('answer line', 1, 25) }, { hold: true }, { text: `\n${items('answer line', 26, 40)}` }]);
  const ui = await bootApp(model, 100, ROWS);
  await ui.press('F');
  await ui.type('print forty lines');
  await ui.press('return');
  await settle(20);
  expect(topRow(ui.backend.lastFrame, 'print forty lines')).toContain('answer line 01');
  // To the end of what has come so far: from here the list follows.
  await ui.press('pagedown');
  await ui.press('pagedown');
  expect(ui.backend.lastFrame).toContain('answer line 25');

  model.release();
  await settle(20);
  expect(ui.backend.lastFrame).toContain('answer line 40');
  expect(ui.backend.lastFrame).not.toContain('answer line 01');
  ui.app.unmount();
});

test('the chat opened again mid-answer follows the end it opens at', async () => {
  const model = new ScriptedModel();
  model.script([{ text: items('answer line', 1, 25) }, { hold: true }, { text: `\n${items('answer line', 26, 40)}` }]);
  const ui = await bootApp(model, 100, ROWS);
  await ui.press('F');
  await ui.type('print forty lines');
  await ui.press('return');
  await settle(20);
  await ui.press('pagedown');
  await ui.press('pagedown');
  expect(ui.backend.lastFrame).toContain('answer line 25');
  // Ctrl+] closes the window and opens it again: the conversation is mounted anew, at
  // its end, with the answer's first line long above it.
  ui.backend.press({ name: ']', ctrl: true });
  await settle();
  expect(ui.backend.lastFrame).not.toContain('answer line');
  ui.backend.press({ name: ']', ctrl: true });
  await settle();
  expect(ui.backend.lastFrame).toContain('answer line 25');

  model.release();
  await settle(20);
  expect(ui.backend.lastFrame).toContain('answer line 40');
  ui.app.unmount();
});

test('a background result landing under an anchored answer does not move the reader', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'background', args: { task: 'count the TODO comments' } }],
    // The turn is held open, so the result — shown only once no turn is being
    // written — can only land after the answer has stopped at its first line.
    [{ text: items('answer line', 1, 40) }, { hold: true }],
    [{ text: 'There are 14 TODO comments.' }],
  );
  const ui = await bootApp(model, 100, ROWS);
  await ui.press('F');
  await ui.type('count the TODOs in the background');
  await ui.press('return');
  await settle(40);
  expect(model.requests).toHaveLength(3);
  expect(topRow(ui.backend.lastFrame, 'count the TODOs in the background')).toContain('answer line 01');
  const before = conversation(ui.backend.lastFrame);
  model.release();
  await settle(40);
  // The turn ended and the result landed; the reader was not moved.
  expect(ui.backend.lastFrame).not.toContain('Esc stops');
  // (The gutter is left out: the live mark became the answer's `ƒ`.)
  const text = (rows: string[]) => rows.map((r) => r.slice(3));
  expect(text(conversation(ui.backend.lastFrame))).toEqual(text(before));
  // It did land — below the fold, where the conversation ends.
  for (let i = 0; i < 4; i++) await ui.press('pagedown');
  expect(ui.backend.lastFrame).toContain('There are 14 TODO comments.');
  ui.app.unmount();
});

test('the next message sent from an anchored answer scrolls to the end', async () => {
  const model = new ScriptedModel();
  model.script([{ text: items('answer line', 1, 40) }], [{ text: 'the newest answer' }]);
  const ui = await bootApp(model, 100, ROWS);
  await ui.press('F');
  await ui.type('print forty lines');
  await ui.press('return');
  await settle(20);
  expect(topRow(ui.backend.lastFrame, 'print forty lines')).toContain('answer line 01');
  await ui.type('again');
  await ui.press('return');
  await settle(20);
  expect(ui.backend.lastFrame).toContain('the newest answer');
  expect(ui.backend.lastFrame).toContain('answer line 40');
  ui.app.unmount();
});

test('a background result landing under a short answer is followed, as it always was', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'background', args: { task: 'count the TODO comments' } }],
    // Just short enough: its first line is the row under the pinned question.
    [{ text: items('answer line', 1, 19) }],
    [{ text: 'There are 14 TODO comments.' }],
  );
  const ui = await bootApp(model, 100, ROWS);
  await ui.press('F');
  await ui.type('count the TODOs in the background');
  await ui.press('return');
  await settle(40);
  expect(model.requests).toHaveLength(3);
  // The result is on screen, and the answer's first line has gone above it: it is not
  // the answer that grew.
  expect(ui.backend.lastFrame).toContain('There are 14 TODO comments.');
  expect(ui.backend.lastFrame).not.toContain('answer line 01');
  ui.app.unmount();
});

test('back at the end by the wheel mid-answer, the list follows again', async () => {
  const model = new ScriptedModel();
  model.script([{ text: items('answer line', 1, 25) }, { hold: true }, { text: `\n${items('answer line', 26, 40)}` }]);
  const ui = await bootApp(model, 100, ROWS);
  await ui.press('F');
  await ui.type('print forty lines');
  await ui.press('return');
  await settle(20);
  expect(topRow(ui.backend.lastFrame, 'print forty lines')).toContain('answer line 01');
  for (let i = 0; i < 10; i++) ui.backend.wheel('down', 20, 8);
  await settle();
  expect(ui.backend.lastFrame).toContain('answer line 25');

  model.release();
  await settle(20);
  expect(ui.backend.lastFrame).toContain('answer line 40');
  ui.app.unmount();
});

test('a session resumed with a long last answer opens at its end — no answer is arriving', async () => {
  const model = new ScriptedModel();
  model.script([{ text: items('answer line', 1, 40) }]);
  const ui = await bootApp(model, 100, ROWS);
  await ui.press('F');
  await ui.type('print forty lines');
  await ui.press('return');
  await settle(20);
  expect(topRow(ui.backend.lastFrame, 'print forty lines')).toContain('answer line 01');
  await ui.type('/clear');
  await ui.press('return');
  await settle(20);
  await ui.type('/resume 1');
  await ui.press('return');
  await settle(20);
  expect(ui.backend.lastFrame).toContain('answer line 40');
  expect(topRow(ui.backend.lastFrame, 'print forty lines')).not.toContain('answer line 01');
  ui.app.unmount();
});

// The list holds a row by keeping the box's own scroll position once it is off the
// end; a round that turned out to carry a call folds its rows into one step row, and
// the box keeps that position through the shrink rather than going back to the end.
test('an anchored round that turns into a step leaves the reader where the turn began', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ text: items('round one', 1, 25) }, { hold: true }, { tool: 'datetime', args: {} }],
    [{ text: items('round two', 1, 10) }, { hold: true }, { text: `\n${items('round two', 11, 40)}` }],
  );
  const ui = await bootApp(model, 100, ROWS);
  await ui.press('F');
  await ui.type('go');
  await ui.press('return');
  await settle(20);
  expect(topRow(ui.backend.lastFrame, 'go')).toContain('round one 01');
  model.release();
  await settle(20);
  model.release();
  await settle(20);
  const top = topRow(ui.backend.lastFrame, 'go');
  expect(top).toContain('▸');
  expect(top).toContain('round one');
  expect(ui.backend.lastFrame).toContain('round two 01');
  expect(ui.backend.lastFrame).not.toContain('round two 40');
  ui.app.unmount();
});
