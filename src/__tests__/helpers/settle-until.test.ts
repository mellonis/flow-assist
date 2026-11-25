import { expect, test } from 'bun:test';
import { settleUntil } from './scripted.ts';

// A wait that gives up quietly reads as success until some later assertion fails on a
// frame nobody can connect to it. The give-up is a failure of its own, and it names the
// condition that never held.

test('a condition that never comes fails the wait, naming the condition', async () => {
  let ran = false;
  function stillHeld(): boolean { ran = true; return false; }
  await expect(settleUntil(stillHeld, 3)).rejects.toThrow(/stillHeld/);
  expect(ran).toBe(true);
});

test('a condition that comes ends the wait', async () => {
  let n = 0;
  await settleUntil(() => ++n >= 2, 10);
  expect(n).toBeGreaterThanOrEqual(2);
});
