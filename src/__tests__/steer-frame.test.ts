import { expect, test } from 'bun:test';
import { frameSteered } from '../assistant/conversation-types';

test('a mid-turn frame keeps the person\'s words first and marks the message steered in', () => {
  const out = frameSteered('use the other file', false);
  expect(out.startsWith('use the other file\n\n[Written while the work was running — steered in mid-turn.')).toBe(true);
  expect(out).toContain('fold it into the goal of this turn');
  expect(out).toContain('a question about plans, reasons or state');
  expect(out.trimEnd().endsWith('end the turn.]')).toBe(true);
});

test('a queue-turn frame says the message was written while the previous turn ran', () => {
  const out = frameSteered('use the other file', true);
  expect(out.startsWith('use the other file\n\n[Written while the previous turn was running — queued, and it goes out now.')).toBe(true);
  expect(out).toContain('fold it into the goal of this turn');
});
