import { expect, test } from 'bun:test';
import { frameSteered } from '../assistant/conversation-types';

// The rules block the frame ends with, written out as it must read: both comparisons below
// are of the WHOLE string, so a typo inside it cannot pass.
const RULES = ` - guidance or correction: fold it into the goal of this turn and keep working;
   no separate answer is needed.
 - a question about plans, reasons or state: answer it here briefly, then keep
   working — unless your answer is what the person is weighing: end the turn and
   wait for them.
 - "stop", or a new task meant instead of this one: end the turn.`;

test('a mid-turn frame keeps the person\'s words first and marks the message steered in', () => {
  expect(frameSteered('use the other file', false)).toBe(`use the other file\n\n[Written while the work was running — steered in mid-turn.\n${RULES}]`);
});

test('a queue-turn frame says the message was written while the previous turn ran', () => {
  expect(frameSteered('use the other file', true)).toBe(`use the other file\n\n[Written while the previous turn was running — queued, and it goes out now.\n${RULES}]`);
});
