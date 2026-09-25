// A transport that comes back. Over a factory of transports it presents ONE
// `RestartingTransport`: lines and closes come from whichever is live, a close of a
// transport that had started starts the next after a backoff (1 → 2 → 4 → 8 → 16 →
// 30 s), `onRestart` tells the layer above to say `hello` again, and more than five
// failures in a row — six, with the defaults — give up with `disabled until restart`
// in the log. A run that lived longer resets the count. The very first `start()` is
// not a restart: if it never comes up —
// whether it rejects, or closes before resolving — that rejects to the caller alone;
// nothing is scheduled and no close reaches the layer above, since nothing was ever
// up for it to hear about. `close` stops the supervisor for good: a pending restart is
// cleared, nothing is started after it, and an attempt already spawning when `close`
// runs is closed itself rather than left running unmanaged — the very first `start()`
// then rejects instead of quietly resolving.
import type { RestartingTransport, Transport, TransportClose } from './transport.js';

export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
export const MAX_FAILURES = 5;
const QUICK_DEATH_MS = 1_000;

export interface SuperviseOpts {
  name: string;
  log: (line: string) => void;
  backoffMs?: number[];
  maxFailures?: number;
  now?: () => number;
  timer?: (fn: () => void, ms: number) => { clear(): void };
}

export function supervise(factory: () => Transport & { start(): Promise<void> }, opts: SuperviseOpts): RestartingTransport {
  const backoff = opts.backoffMs ?? BACKOFF_MS;
  const maxFailures = opts.maxFailures ?? MAX_FAILURES;
  const now = opts.now ?? Date.now;
  const timer = opts.timer ?? ((fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return { clear: () => clearTimeout(h) }; });
  const lines: Array<(l: string) => void> = [];
  const closes: Array<(w: TransportClose) => void> = [];
  const restarts: Array<() => void> = [];
  let current: (Transport & { start(): Promise<void> }) | null = null;
  let startedAt = 0;
  let failures = 0;
  let pending: { clear(): void } | null = null;
  let done = false;
  // True once ANY attempt has ever completed a successful `start()`. Before that, a
  // death is the loader's problem — it already sees the rejection from `start()` — not
  // the supervisor's restart loop; after it, every later death is.
  let startedOnce = false;

  // `hadStarted` is false for a transport that never got past its own `start()` —
  // that always counts as a failure, however long the attempt took; only a
  // transport that did start distinguishes a quick death from a run that lived.
  const scheduleRestart = (hadStarted: boolean) => {
    const quick = !hadStarted || now() - startedAt < QUICK_DEATH_MS;
    failures = quick ? failures + 1 : 1;
    if (failures > maxFailures) { opts.log(`[${opts.name}] stopped ${failures} times in a row — disabled until restart`); return; }
    const ms = backoff[Math.min(failures - 1, backoff.length - 1)]!;
    opts.log(`[${opts.name}] stopped — restarting in ${(ms / 1000).toFixed(1)} s`);
    pending = timer(() => {
      pending = null;
      const { t, p } = bringUp();
      p.then(
        () => {
          // `close()` ran while this restart was still spawning: it saw `current`
          // pointing at `t` but a transport that has not yet resolved `start()` may
          // no-op its own `close` (a child not yet marked spawned, say), so it is
          // closed again here, now that it is actually up, instead of left running
          // with nobody managing it.
          if (done) { void t.close(0); return; }
          restarts.forEach((f) => f());
        },
        () => {}, // a rejection here is already handled inside bringUp
      );
    }, ms);
  };
  // Not `async`: returns `t.start()`'s own promise rather than `await`ing it, so
  // `onRestart` fires in the one microtask after that promise settles instead of an
  // extra tick later.
  const bringUp = (): { t: Transport & { start(): Promise<void> }; p: Promise<void> } => {
    const t = factory();
    // `settled` is true once this attempt's death has been counted. A transport can
    // announce its own end two ways — `onClose`, and a `start()` that rejects — and a
    // spawn error fires both (`transport-stdio.ts`'s `error` handler calls `reject`
    // then `closeOnce`) for the one death; only the first to arrive schedules a
    // restart. `up` is true once `start()` has actually resolved, which is what
    // `scheduleRestart` needs to tell "never came up" from "came up, then died".
    let settled = false;
    let up = false;
    current = t;
    startedAt = now();
    t.onLine((l) => { if (current === t) lines.forEach((f) => f(l)); });
    t.onClose((why) => {
      if (done || settled) return;
      settled = true;
      if (current === t) current = null;
      if (!startedOnce) return; // never came up even once — the caller's own start() rejection is the whole story
      closes.forEach((f) => f(why));
      scheduleRestart(up);
    });
    // One `.then` with both reactions, not a `.catch` chained onto the returned
    // promise: chaining would cost the caller's own `.then` an extra microtask tick
    // relative to `t.start()` settling, and `onRestart` is timed against that.
    const p = t.start();
    p.then(
      () => { up = true; startedOnce = true; },
      (e: unknown) => {
        if (!done && !settled) {
          settled = true;
          if (current === t) current = null;
          if (!startedOnce) return; // never came up even once — nothing to restart
          opts.log(`[${opts.name}] restart failed: ${e instanceof Error ? e.message : String(e)}`);
          scheduleRestart(up);
        }
      },
    );
    return { t, p };
  };

  return {
    start: () => {
      const { t, p } = bringUp();
      // `close()` may run while this very first `start()` is still pending: it sees
      // `current` pointing at `t`, but a transport that has not yet resolved `start()`
      // may no-op its own `close` (a child not yet marked spawned, say), so nothing
      // actually stops here. Closing again once `t.start()` resolves — and rejecting
      // rather than quietly resolving, since the caller asked to close, not to start
      // — is what keeps this in step with the restart path's own fix above.
      return p.then(() => {
        if (done) { void t.close(0); throw new Error(`${opts.name}: closed while starting`); }
      });
    },
    send: (l) => current?.send(l),
    onLine: (f) => { lines.push(f); },
    onClose: (f) => { closes.push(f); },
    onRestart: (f) => { restarts.push(f); },
    close: async (graceMs) => { done = true; pending?.clear(); pending = null; await current?.close(graceMs); current = null; },
  };
}
