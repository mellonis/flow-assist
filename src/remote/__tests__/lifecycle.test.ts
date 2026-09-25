import { expect, test } from 'bun:test';
import { registerRemoteStop, stopRemotePlugins } from '../lifecycle';

test('runs every registered stop in parallel: both start before either finishes', async () => {
  const order: string[] = [];
  let resolveA!: () => void;
  let resolveB!: () => void;
  const a = new Promise<void>((r) => { resolveA = r; });
  const b = new Promise<void>((r) => { resolveB = r; });
  const unregA = registerRemoteStop(async () => { order.push('a-start'); await a; order.push('a-done'); });
  const unregB = registerRemoteStop(async () => { order.push('b-start'); await b; order.push('b-done'); });
  const done = stopRemotePlugins();
  // Both microtask queues get a turn before either deferred resolves — if the two
  // stops ran one after another, 'b-start' would not appear yet.
  await Promise.resolve();
  await Promise.resolve();
  expect(order).toEqual(['a-start', 'b-start']);
  resolveA();
  resolveB();
  await done;
  expect(order).toContain('a-done');
  expect(order).toContain('b-done');
  unregA();
  unregB();
});

test('bounds the wait: a stop that never resolves does not hold stopRemotePlugins past ~1.5s', async () => {
  const unreg = registerRemoteStop(() => new Promise<void>(() => {}));
  const start = Date.now();
  await stopRemotePlugins();
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(1_800);
  expect(elapsed).toBeGreaterThanOrEqual(1_400);
  unreg();
});

test('unregister removes a stop before it ever runs', async () => {
  let called = false;
  const unreg = registerRemoteStop(async () => { called = true; });
  unreg();
  await stopRemotePlugins();
  expect(called).toBe(false);
});

test('a stop that throws synchronously does not sink the others', async () => {
  let otherCalled = false;
  const unregBad = registerRemoteStop(() => { throw new Error('boom'); });
  const unregGood = registerRemoteStop(async () => { otherCalled = true; });
  await stopRemotePlugins();
  expect(otherCalled).toBe(true);
  unregBad();
  unregGood();
});
