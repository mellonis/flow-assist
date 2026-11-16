// The `subagent` tool's `writes` mapping (`taskWritesOf`): a bare call is a worker
// (writes and commands wait for the person's yes), the legacy `write` spelling reads as
// ask/deny, `writes` wins over `write`, an unknown value is refused naming the three,
// and a call may not grant its own `allow`.
import { expect, test } from 'bun:test';
import { taskWritesOf } from '../tools-core.js';

test('a task with no writes argument runs as ask', () => {
  expect(taskWritesOf({})).toEqual({ writes: 'ask', note: '' });
});

test('write: true maps to ask and write: false to deny', () => {
  expect(taskWritesOf({ write: true })).toEqual({ writes: 'ask', note: '' });
  expect(taskWritesOf({ write: false })).toEqual({ writes: 'deny', note: '' });
});

test('writes wins over write when both are given', () => {
  expect(taskWritesOf({ writes: 'deny', write: true })).toEqual({ writes: 'deny', note: '' });
});

test('an unknown writes value is an error naming the three', () => {
  const r = taskWritesOf({ writes: 'yes' });
  expect(r.writes).toBe('error');
  expect(r.note).toContain('allow, ask, deny');
});

test('a task may not grant itself allow', () => {
  const r = taskWritesOf({ writes: 'allow' });
  expect(r.writes).toBe('ask');
  expect(r.note).not.toBe('');
});
