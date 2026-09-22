// Host two-phase input dispatch. The key unit is the host ordering helper
// `twoPhaseDispatch` (observers first, never consume; then the consumer race; then
// the host fallback). `partitionInput`/`runConsumers` live in
// src/loader/registry.ts — the host dispatcher reuses them, so this test exercises
// the wiring too. React rendering is not asserted here (the e2e tests draw it).

import { expect, test } from 'bun:test';
import { twoPhaseDispatch } from '../app';
import { partitionInput, runConsumers } from '../../loader/registry';

test('twoPhaseDispatch runs observers first, never consuming; consumers short-circuit', () => {
  const order: string[] = [];
  const registry = [
    { mode: 'observe', priority: () => 1000, handler: () => { order.push('obs'); } },
    { mode: 'consume', priority: () => 10, handler: () => { order.push('cons'); return true; } },
  ];
  // partitionInput is still what governs the split; twoPhaseDispatch is
  // the host ordering: observers (never consume) → consumer race → fallback.
  const { observers, consumers } = partitionInput(registry, {});
  expect(observers).toHaveLength(1);
  expect(consumers).toHaveLength(1);
  const consumed = twoPhaseDispatch(registry, {}, { name: 'enter' });
  // Observer ran first and did not consume (the consumer still saw the key and
  // consumed it). Fallback was skipped because a consumer returned true.
  expect(order).toEqual(['obs', 'cons']);
  expect(consumed).toBe(true);
});

test('twoPhaseDispatch consumer phase short-circuits on the first strict-true', () => {
  const order: string[] = [];
  const registry = [
    { mode: 'consume', priority: () => 50, handler: () => { order.push('c1'); return true; } },
    { mode: 'consume', priority: () => 10, handler: () => { order.push('c2'); return true; } },
  ];
  const consumed = twoPhaseDispatch(registry, {}, { name: 'x' }, () => { order.push('fallback'); return true; });
  // The first consumer (priority 50) consumed; the second and the fallback never ran.
  expect(order).toEqual(['c1']);
  expect(consumed).toBe(true);
});

test('twoPhaseDispatch invites the fallback only when no consumer consumes', () => {
  const order: string[] = [];
  const registry = [
    { mode: 'observe', priority: () => 100, handler: () => { order.push('obs'); } },
    { mode: 'consume', priority: () => 1, handler: () => false },
  ];
  const consumed = twoPhaseDispatch(registry, {}, { name: 'z' }, () => { order.push('fallback'); return true; });
  expect(order).toEqual(['obs', 'fallback']);
  expect(consumed).toBe(true);
});

test('twoPhaseDispatch never hands a mouse button to a handler or the fallback — it is the drag-selection\'s', () => {
  const seen: string[] = [];
  const registry = [
    { mode: 'observe', priority: () => 1000, handler: (k: { name?: string }) => { seen.push(`obs:${k.name}`); } },
    // A consumer that takes every key, as the y/n pause and an open question do.
    { mode: 'consume', priority: () => 100, handler: (k: { name?: string }) => { seen.push(`cons:${k.name}`); return true; } },
  ];
  for (const name of ['mousedown', 'mousedrag', 'mouseup']) {
    expect(twoPhaseDispatch(registry, {}, { name, x: 3, y: 4, button: 'left' }, () => { seen.push('fallback'); return true; })).toBe(false);
  }
  expect(seen).toEqual([]);
  // The wheel is still a key: scroll boxes hear it themselves, and a handler may too.
  twoPhaseDispatch(registry, {}, { name: 'wheelup', x: 3, y: 4 });
  expect(seen).toEqual(['obs:wheelup', 'cons:wheelup']);
});

test('runConsumers stops at the first strict-true handler (host-race semantics)', () => {
  let hits = 0;
  const consumers = [
    { handler: () => { hits++; return true; } },
    { handler: () => { hits++; return 1; } },
  ];
  expect(runConsumers(consumers as never, {})).toBe(true);
  expect(hits).toBe(1);
});