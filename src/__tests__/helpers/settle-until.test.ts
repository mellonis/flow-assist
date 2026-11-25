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

// A wait's budget is either a number of settles or a wall-clock deadline: a fixture that
// polls a drawn frame needs the first, a fixture that polls a real process needs the
// second (its hops take as long as they take).
test('a millisecond budget gives up after the wall time, naming its label', async () => {
  const t0 = Date.now();
  await expect(settleUntil(() => false, { ms: 120 }, 'the host to answer')).rejects.toThrow(/the host to answer/);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
});

test('a label replaces the condition source in the failure', async () => {
  await expect(settleUntil(() => false, 2, 'the picker to open')).rejects.toThrow(/the picker to open/);
});
