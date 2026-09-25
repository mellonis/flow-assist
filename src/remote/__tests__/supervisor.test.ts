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

// A transport whose very first `start()` dies via both `onClose` and a rejection —
// the same double-fire shape `crashingOnRestart` uses for a later attempt, but here
// on the very first attempt: nothing has ever come up, so the death is the caller's
// own `start()` rejection to deal with, not the supervisor's restart loop.
function crashingOnFirstStart() {
  let calls = 0;
  const closes: Array<(w: { error?: string }) => void> = [];
  const factory = () => {
    calls++;
    return {
      send: () => {},
      onLine: () => {},
      onClose: (f: (w: { error?: string }) => void) => { closes.push(f); },
      close: async () => {},
      start: () => { closes.forEach((f) => f({ error: 'boom' })); return Promise.reject(new Error('boom')); },
    };
  };
  return { factory, calls: () => calls };
}

test('a first start that dies via onClose and a rejection schedules no restart and forwards no close', async () => {
  const { factory, calls } = crashingOnFirstStart();
  const tm = timers(); const log: string[] = [];
  const s = supervise(factory, { name: 'fake', log: (l) => log.push(l), timer: tm.timer });
  const closesSeen: unknown[] = []; s.onClose((w) => closesSeen.push(w));
  await expect(s.start()).rejects.toThrow('boom');
  expect(tm.pending.length).toBe(0); // no restart scheduled
  expect(calls()).toBe(1); // the factory ran once — no auto-retry
  expect(closesSeen).toEqual([]); // nothing was ever up, so the layer above hears nothing
  expect(log).toEqual([]); // no restart bookkeeping for a plugin that never came up once
});

// A transport whose `close()` mirrors a real one's no-op-before-spawn guard (it does
// nothing until `start()` has actually resolved), and whose `start()` the test
// resolves by hand — for proving a restart still spawning when `close()` runs is
// closed for real once it comes up, rather than left running unmanaged.
function restartInFlight() {
  const made: Array<{ closedWith: number[]; onCloseFns: Array<(w: { code?: number }) => void>; resolveStart?: () => void }> = [];
  let calls = 0;
  const factory = () => {
    const idx = calls++;
    const onCloseFns: Array<(w: { code?: number }) => void> = [];
    const closedWith: number[] = [];
    const entry: (typeof made)[number] = { closedWith, onCloseFns };
    let up = idx === 0;
    made.push(entry);
    return {
      send: () => {},
      onLine: () => {},
      onClose: (f: (w: { code?: number }) => void) => { onCloseFns.push(f); },
      close: async (graceMs: number) => { if (up) closedWith.push(graceMs); }, // a no-op before this instance is actually up
      start: idx === 0
        ? async () => {}
        : () => new Promise<void>((resolve) => { entry.resolveStart = () => { up = true; resolve(); }; }),
    };
  };
  return { factory, made };
}

test('close during an in-flight restart fires no onRestart and closes the transport once it comes up', async () => {
  const { factory, made } = restartInFlight(); const tm = timers();
  const s = supervise(factory, { name: 'fake', log: () => {}, timer: tm.timer });
  let restarts = 0; s.onRestart(() => restarts++);
  await s.start();
  made[0]!.onCloseFns.forEach((f) => f({ code: 1 })); // schedule a restart
  tm.fire(); // spawns instance 1 — its start() is pending until resolveStart is called
  await s.close(0); // close() runs while instance 1 has not yet resolved start()
  expect(made[1]!.closedWith).toEqual([]); // not actually closed — it was never up
  made[1]!.resolveStart!();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(restarts).toBe(0); // no onRestart after close()
  expect(made[1]!.closedWith).toEqual([0]); // closed for real once it came up, instead of left running
});

// Instance 0 starts cleanly, so `startedOnce` is true before anything else happens.
// Every later attempt is a restart whose `start()` rejects only after the fake clock
// has advanced past the quick-death threshold, with no accompanying `onClose` — so
// `scheduleRestart`'s `!hadStarted ||` is what stops that elapsed time from reading
// as a run that lived, on a restart rather than the first attempt.
function slowCrashAfterFirstStart(clock: { value: number }) {
  const closesOf: Array<Array<(w: { code?: number }) => void>> = [];
  let calls = 0;
  const factory = () => {
    const idx = calls++;
    const closes: Array<(w: { code?: number }) => void> = [];
    closesOf.push(closes);
    return {
      send: () => {},
      onLine: () => {},
      onClose: (f: (w: { code?: number }) => void) => { closes.push(f); },
      close: async () => {},
      start: () => {
        if (idx === 0) return Promise.resolve();
        clock.value += 1_500;
        return Promise.reject(new Error('timed out'));
      },
    };
  };
  return { factory, closesOf };
}

test('a restart whose start takes over a second to reject still counts toward the failure limit', async () => {
  const clock = { value: 0 };
  const { factory, closesOf } = slowCrashAfterFirstStart(clock);
  const tm = timers(); const log: string[] = [];
  const s = supervise(factory, { name: 'fake', log: (l) => log.push(l), timer: tm.timer, now: () => clock.value });
  await s.start(); // instance 0, starts cleanly
  closesOf[0]!.forEach((f) => f({ code: 1 })); // close it — schedules the first restart
  for (let i = 0; i < MAX_FAILURES + 2 && tm.pending.length > 0; i++) {
    tm.fire();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  }
  expect(tm.pending.length).toBe(0);
  expect(log.at(-1)).toContain('disabled until restart');
});

// Mirrors `restartInFlight`'s no-op-before-up `close`, but for the very first attempt
// (there is no instance 0 to distinguish it from) — for proving the same
// close-races-an-in-flight-start gap Finding 2 fixed for a restart is also fixed for
// the very first `start()`.
function firstStartInFlight() {
  let up = false;
  const closedWith: number[] = [];
  const onCloseFns: Array<(w: { code?: number }) => void> = [];
  let resolveStart: () => void = () => {};
  const factory = () => ({
    send: () => {},
    onLine: () => {},
    onClose: (f: (w: { code?: number }) => void) => { onCloseFns.push(f); },
    close: async (graceMs: number) => { if (up) closedWith.push(graceMs); }, // a no-op before this instance is actually up
    start: () => new Promise<void>((resolve) => { resolveStart = () => { up = true; resolve(); }; }),
  });
  return { factory, closedWith, onCloseFns, resolveStart: () => resolveStart() };
}

test('close during the very first in-flight start closes the transport once it comes up, and start() rejects', async () => {
  const { factory, closedWith, onCloseFns, resolveStart } = firstStartInFlight();
  const tm = timers();
  const s = supervise(factory, { name: 'fake', log: () => {}, timer: tm.timer });
  let restarts = 0; s.onRestart(() => restarts++);
  const startPromise = s.start(); // pending — the factory's start() has not resolved yet
  await s.close(0); // close() runs while start() is still pending — a no-op on a transport not yet up
  expect(closedWith).toEqual([]); // not actually closed yet — it was never up
  resolveStart(); // the factory's start() now resolves — the transport is actually up
  await expect(startPromise).rejects.toThrow(); // start() rejects rather than quietly resolving
  expect(closedWith).toEqual([0]); // closed for real once it came up, instead of left running
  onCloseFns.forEach((f) => f({ code: 1 })); // even if it goes on to report its own close
  expect(restarts).toBe(0); // done blocks scheduling regardless — startedOnce never gets a chance to
  expect(tm.pending.length).toBe(0);
});
