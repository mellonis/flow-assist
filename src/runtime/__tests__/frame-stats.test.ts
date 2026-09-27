// The frame meter: each frame tagged by the input that led to it, timed from that
// input, kept per kind; a slow one logged; a key that painted nothing lends its time to
// no later frame.
import { expect, test } from 'bun:test';
import { TestBackend } from '@flowtty/core/testing';
import { createFrameMeter, inputKind, metered, percentile } from '../frame-stats';

const stats = (o: Partial<{ commits: number; applied: number; skipped: number; layoutMs: number; paintMs: number; drawMs: number }> = {}) =>
  ({ commits: 1, applied: 0, skipped: 0, layoutMs: 1, paintMs: 1, drawMs: 1, ...o });

// A clock and a macrotask queue the test moves by hand.
const rig = (slowMs = 50) => {
  let t = 0;
  const later: (() => void)[] = [];
  const slow: string[] = [];
  const meter = createFrameMeter({ now: () => t, slowMs, window: 5, later: (fn) => { later.push(fn); }, onSlow: (l) => slow.push(l) });
  return { meter, slow, at: (n: number) => { t = n; }, drain: () => { for (const fn of later.splice(0)) fn(); } };
};

test('what kind of input a key is', () => {
  expect(inputKind({ name: 'a' })).toBe('typing');
  expect(inputKind({ name: 'backspace' })).toBe('typing');
  expect(inputKind({ name: 'paste' })).toBe('typing');
  expect(inputKind({ name: 'wheelup' })).toBe('wheel');
  expect(inputKind({ name: 'wheeldown' })).toBe('wheel');
  expect(inputKind({ name: 'a', ctrl: true })).toBe('other');
  expect(inputKind({ name: 'return' })).toBe('other');
  expect(inputKind({ name: 'mousedown' })).toBe('other');
});

test('percentiles are nearest-rank', () => {
  expect(percentile([], 50)).toBe(0);
  expect(percentile([5], 95)).toBe(5);
  const v = Array.from({ length: 100 }, (_x, i) => i + 1);
  expect(percentile(v, 50)).toBe(50);
  expect(percentile(v, 95)).toBe(95);
  expect(percentile(v, 100)).toBe(100);
});

test('a frame is tagged by its input and timed from the first input of the burst', () => {
  const r = rig();
  r.at(10);
  for (let i = 0; i < 30; i++) r.meter.input({ name: 'wheeldown' });
  r.at(14);
  r.meter.frame(stats({ commits: 30, applied: 3, skipped: 40 }));
  const [f] = r.meter.frames('wheel');
  expect(f).toMatchObject({ kind: 'wheel', latencyMs: 4, inputs: 30, commits: 30, applied: 3, skipped: 40, workMs: 3 });
  // A frame nothing led to is a redraw, timed by its own work.
  r.meter.frame(stats());
  expect(r.meter.frames('redraw')).toHaveLength(1);
  expect(r.meter.frames('redraw')[0]!.latencyMs).toBeUndefined();
});

test('a key that painted nothing does not lend its time to a later frame', () => {
  const r = rig();
  r.at(0);
  r.meter.input({ name: 'a' });
  r.drain();
  r.at(2000);
  r.meter.frame(stats());
  expect(r.meter.frames('typing')).toHaveLength(0);
  expect(r.meter.frames('redraw')).toHaveLength(1);
  expect(r.slow).toEqual([]);
});

test('each kind keeps its last frames only', () => {
  const r = rig();
  for (let i = 0; i < 8; i++) { r.meter.input({ name: 'a' }); r.meter.frame(stats({ commits: i })); }
  expect(r.meter.frames('typing').map((f) => f.commits)).toEqual([3, 4, 5, 6, 7]);
  expect(r.meter.totals()).toEqual({ frames: 8, slow: 0 });
});

test('a slow frame is logged once, with its counters', () => {
  const r = rig(50);
  r.at(0);
  r.meter.input({ name: 'a' });
  r.at(80);
  r.meter.frame(stats({ commits: 2, applied: 7, skipped: 90, layoutMs: 30, paintMs: 10, drawMs: 5 }));
  r.meter.frame(stats());
  expect(r.slow).toEqual(['[perf] slow frame · typing · input→frame 80 ms (1 input) · layout 30 paint 10 draw 5.0 ms · 2 commits · 7 applied / 90 skipped']);
  expect(r.meter.totals()).toEqual({ frames: 2, slow: 1 });
  // A redraw is slow by its own work.
  r.meter.frame(stats({ layoutMs: 60 }));
  expect(r.slow.at(-1)).toStartWith('[perf] slow frame · redraw · layout 60');
});

test('the report says p50/p95/max of each kind, and the headline the p95s', () => {
  const r = rig();
  for (const lat of [2, 4, 6, 8, 20]) { r.at(0); r.meter.input({ name: 'a' }); r.at(lat); r.meter.frame(stats()); }
  const lines = r.meter.report();
  expect(lines[0]).toBe('[perf] the last 5 frames of each kind · 5 frames since start, 0 slower than 50 ms (each logged)');
  expect(lines).toContain('[perf] typing: 5 frames · input→frame p50 6.0 p95 20 max 20 ms · layout+paint+draw p50 3.0 p95 3.0 max 3.0 ms · commits p50 1 p95 1 max 1 · applied p50 0 p95 0 max 0 · skipped p50 0 p95 0 max 0');
  expect(lines).toContain('[perf] wheel: no frames');
  expect(r.meter.headline()).toBe('perf: typing p95 20 ms');
  expect(createFrameMeter().headline()).toBe('perf: no frames yet');
});

test('the meter never throws into flowtty', () => {
  const meter = createFrameMeter({ onSlow: () => { throw new Error('log gone'); }, slowMs: 0 });
  expect(() => meter.frame(stats())).not.toThrow();
  expect(() => meter.input(null as never)).not.toThrow();
});

test('the metered backend reports each key before its listener hears it', () => {
  const heard: string[] = [];
  const meter = createFrameMeter();
  const spy = { ...meter, input: (k: { name?: string }) => { heard.push(`meter:${k.name}`); } };
  const backend = new TestBackend(20, 5);
  metered(backend, spy).onKey!((k) => { heard.push(`app:${k.name}`); return undefined; });
  backend.press({ name: 'down' });
  expect(heard).toEqual(['meter:down', 'app:down']);
});
