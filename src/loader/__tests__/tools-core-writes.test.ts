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
  // The note is the capability rule: the person's y/n (the auto mode answers), never a
  // promise the mode cannot keep.
  expect(r.note).toContain("person's y/n");
  expect(r.note).not.toContain('config_set');
});

test('writes: null reads as the optional key left out: a bare worker', () => {
  expect(taskWritesOf({ writes: null })).toEqual({ writes: 'ask', note: '' });
});

test('writes wins in the reverse conflict: allow with write: false follows the allow path, never deny', () => {
  expect(taskWritesOf({ writes: 'allow', write: false })).toEqual(taskWritesOf({ writes: 'allow' }));
});

test('a second unknown writes value is an error naming the three', () => {
  const r = taskWritesOf({ writes: 'nope' });
  expect(r).toMatchObject({ writes: 'error' });
  expect(r.note).toContain('allow, ask, deny');
});
