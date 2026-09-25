import { expect, test } from 'bun:test';
import { BACKOFF_MS, MAX_FAILURES, supervise } from '../supervisor';
import type { Transport } from '../transport';

// A transport the test closes by hand; `made` holds one entry per factory call, in order.
function scripted() {
  const made: Array<{ t: Transport & { start(): Promise<void> }; close: (why: { code?: number }) => void; sent: string[] }> = [];
  const factory = () => {
    const closes: Array<(w: { code?: number }) => void> = []; const lines: Array<(l: string) => void> = []; const sent: string[] = [];
    const t = { send: (l: string) => { sent.push(l); }, onLine: (f: (l: string) => void) => { lines.push(f); }, onClose: (f: (w: { code?: number }) => void) => { closes.push(f); }, close: async () => {}, start: async () => {} };
    const entry = { t, close: (why: { code?: number }) => closes.forEach((f) => f(why)), sent, lines };
    made.push(entry);
    return t;
  };
  return { factory, made };
}
// Timers the test fires by hand.
function timers() {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  return { timer: (fn: () => void, ms: number) => { const e = { fn, ms }; pending.push(e); return { clear: () => { const i = pending.indexOf(e); if (i !== -1) pending.splice(i, 1); } }; }, fire: () => { const e = pending.shift(); e?.fn(); return e?.ms; }, pending };
}

test('a close restarts after the backoff, onRestart fires, and a clean run resets the backoff', async () => {
  const { factory, made } = scripted(); const tm = timers(); const log: string[] = [];
  const s = supervise(factory, { name: 'fake', log: (l) => log.push(l), timer: tm.timer });
  let restarts = 0; s.onRestart(() => restarts++);
  await s.start();
  expect(made.length).toBe(1);
  made[0]!.close({ code: 3 });
  expect(tm.fire()).toBe(BACKOFF_MS[0]);
  await Promise.resolve();
  expect(made.length).toBe(2);
  expect(restarts).toBe(1);
  made[1]!.close({ code: 3 });
  expect(tm.fire()).toBe(BACKOFF_MS[1]);
  s.send('hello?');
  await Promise.resolve();
  expect(made[2]!.sent).toEqual(['hello?']); // send goes to the live one
  expect(log.some((l) => l.includes('restarting in 2.0 s'))).toBe(true);
});

test('five consecutive failures give up and say so; close during backoff spawns nothing more', async () => {
  const { factory, made } = scripted(); const tm = timers(); const log: string[] = [];
  const s = supervise(factory, { name: 'fake', log: (l) => log.push(l), timer: tm.timer });
  await s.start();
  for (let i = 0; i < MAX_FAILURES; i++) { made.at(-1)!.close({ code: 1 }); tm.fire(); await Promise.resolve(); }
  expect(made.length).toBe(MAX_FAILURES + 1);
  made.at(-1)!.close({ code: 1 });
  expect(tm.pending.length).toBe(0);
  expect(log.at(-1)).toContain('disabled until restart');
  const { factory: f2, made: m2 } = scripted(); const tm2 = timers();
  const s2 = supervise(f2, { name: 'fake', log: () => {}, timer: tm2.timer });
  await s2.start();
  m2[0]!.close({ code: 1 });
  await s2.close(0);
  expect(tm2.pending.length).toBe(0);
  expect(m2.length).toBe(1);
});

test('the layer above hears one close per crash, and lines from whichever transport is live', async () => {
  const { factory, made } = scripted(); const tm = timers();
  const s = supervise(factory, { name: 'fake', log: () => {}, timer: tm.timer });
  const closes: unknown[] = []; const lines: string[] = [];
  s.onClose((w) => closes.push(w)); s.onLine((l) => lines.push(l));
  await s.start();
  made[0]!.lines.forEach((f) => f('a'));
  made[0]!.close({ code: 2 });
  tm.fire(); await Promise.resolve();
  made[1]!.lines.forEach((f) => f('b'));
  expect(closes).toEqual([{ code: 2 }]);
  expect(lines).toEqual(['a', 'b']);
});

// A transport whose `start()` rejects and also fires its own `onClose` for the same
// death — the shape `stdioTransport` produces on a spawn error (`c.on('error', ...)`
// calls both `reject()` and `closeOnce()`). Instance 0 always comes up cleanly.
function crashingOnRestart() {
  const closesOf: Array<Array<(w: { code?: number; error?: string }) => void>> = [];
  let calls = 0;
  const factory = () => {
    const idx = calls++;
    const closes: Array<(w: { code?: number; error?: string }) => void> = [];
    closesOf.push(closes);
    return {
      send: () => {},
      onLine: () => {},
      onClose: (f: (w: { code?: number; error?: string }) => void) => { closes.push(f); },
      close: async () => {},
      start: () => {
        if (idx === 0) return Promise.resolve();
        closes.forEach((f) => f({ error: 'boom' }));
        return Promise.reject(new Error('boom'));
      },
    };
  };
  return { factory, closesOf, calls: () => calls };
}

test('a rejected start that also closes for the same crash counts once, not twice', async () => {
  const { factory, closesOf, calls } = crashingOnRestart(); const tm = timers(); const log: string[] = [];
  const s = supervise(factory, { name: 'fake', log: (l) => log.push(l), timer: tm.timer });
  const closesSeen: unknown[] = []; s.onClose((w) => closesSeen.push(w));
  await s.start();
  closesOf[0]!.forEach((f) => f({ code: 1 }));
  expect(tm.pending.length).toBe(1); // exactly one restart scheduled for the one death
  tm.fire();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(calls()).toBe(2); // the restart attempt ran once
  expect(closesSeen).toEqual([{ code: 1 }, { error: 'boom' }]); // one close per crash, not two for the second
  expect(tm.pending.length).toBe(1); // the crash scheduled exactly one more restart, not an orphaned second timer
});

test('a rejected start counts toward the failure limit however long the previous run took, so five in a row still give up once', async () => {
  const { factory, closesOf } = crashingOnRestart(); const tm = timers(); const log: string[] = [];
  const s = supervise(factory, { name: 'fake', log: (l) => log.push(l), timer: tm.timer });
  await s.start();
  for (let i = 0; i < MAX_FAILURES; i++) {
    closesOf.at(-1)!.forEach((f) => f({ code: 1 }));
    tm.fire();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  }
  expect(tm.pending.length).toBe(0);
  expect(log.filter((l) => l.includes('disabled until restart')).length).toBe(1);
});

test('a run that lived longer than a second resets the backoff to the first step', async () => {
  const { factory, made } = scripted(); const tm = timers(); const log: string[] = [];
  let clock = 0;
  const s = supervise(factory, { name: 'fake', log: (l) => log.push(l), timer: tm.timer, now: () => clock });
  await s.start();
  clock += 100; // a quick death
  made[0]!.close({ code: 1 });
  expect(tm.fire()).toBe(BACKOFF_MS[0]); // first failure
  await Promise.resolve();
  clock += 100; // quick again — a second failure in a row, backoff escalates
  made[1]!.close({ code: 1 });
  expect(tm.fire()).toBe(BACKOFF_MS[1]);
  await Promise.resolve();
  clock += 5_000; // this run lived past the one-second threshold
  made[2]!.close({ code: 1 });
  expect(tm.fire()).toBe(BACKOFF_MS[0]); // long run resets to the first step
});

// Rejects every attempt, and only after the fake clock has advanced past the
// quick-death threshold — so an unmodified `now`-based "quick" check would read
// each one as a long-lived run instead of a failure to start at all.
function slowCrash(clock: { value: number }) {
  let calls = 0;
  const factory = () => {
    calls++;
    return {
      send: () => {},
      onLine: () => {},
      onClose: () => {},
      close: async () => {},
      start: () => { clock.value += 1_500; return Promise.reject(new Error('timed out')); },
    };
  };
  return { factory, calls: () => calls };
}

test('a start that takes over a second to reject still counts toward the failure limit', async () => {
  const clock = { value: 0 };
  const { factory, calls } = slowCrash(clock);
  const tm = timers(); const log: string[] = [];
  const s = supervise(factory, { name: 'fake', log: (l) => log.push(l), timer: tm.timer, now: () => clock.value });
  await expect(s.start()).rejects.toThrow('timed out');
  for (let i = 0; i < MAX_FAILURES + 2 && tm.pending.length > 0; i++) {
    tm.fire();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  }
  expect(tm.pending.length).toBe(0);
  expect(log.at(-1)).toContain('disabled until restart');
  expect(calls()).toBe(MAX_FAILURES + 1); // the initial start plus one restart per failure up to the limit
});
