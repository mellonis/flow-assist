// How fast the app answers, measured per painted frame. flowtty calls `onFrame` after
// every frame it paints (docs/app.md in @flowtty/react, "frame stats") with the React
// commits the frame gathered, the boxes whose layout was re-applied or left alone, and
// the layout, paint and draw times. The meter keeps the last FRAME_WINDOW frames of each
// kind, where a frame's kind is the input that led to it: typing, the wheel, any other
// key or mouse event, or none at all (a redraw — an answer streaming, a timer).
//
// For a frame an input led to, the time that counts is the one the person waits: from
// the first input since the previous frame to the end of this one — the React render
// included, which the frame's own times leave out. A redraw has no input to count from,
// so its time is the frame's own (layout + paint + draw). `:perf` reports both, per
// kind; a frame slower than SLOW_FRAME_MS writes one line to the host log, at most one
// every SLOW_LOG_EVERY_MS.
//
// This is the app's concern, not any plugin's: the meter lives in the runtime, hears the
// keys where the backend reports them and is read by the host's `:perf`.

import type { Backend } from '@flowtty/core';
import type { FrameStats } from '@flowtty/react';
import { isPrintableKey } from '../playback/keys.js';

export type InputKind = 'typing' | 'wheel' | 'other';
export type FrameKind = InputKind | 'redraw';
export const FRAME_KINDS: readonly FrameKind[] = ['typing', 'wheel', 'other', 'redraw'];

// The frames kept per kind.
export const FRAME_WINDOW = 200;
// A frame this slow (input to paint, or a redraw's own time) is logged.
export const SLOW_FRAME_MS = 50;
// At most one slow-frame line this often: a lagging app is slow frame after frame, and
// a line each would flood the log it is read in. The frames in between are counted
// into the next line.
export const SLOW_LOG_EVERY_MS = 1000;

export interface FrameRecord extends FrameStats {
  kind: FrameKind;
  // From the first input since the previous frame to the end of this one; none for a
  // redraw.
  latencyMs?: number;
  // layout + paint + draw.
  workMs: number;
  // The input events this frame answered (a wheel flick in one read is many).
  inputs: number;
}

type KeyLike = { name?: string; ctrl?: boolean; meta?: boolean };

// Which kind of input a key is. A printable character, Backspace, Delete and a paste
// are typing; a wheel step is the wheel; everything else (arrows, Enter, chords, clicks,
// the pointer moving) is other.
export function inputKind(key: KeyLike): InputKind {
  const name = key.name ?? '';
  if (name === 'wheelup' || name === 'wheeldown') return 'wheel';
  if (name === 'backspace' || name === 'delete' || name === 'paste') return 'typing';
  if (isPrintableKey({ name, ctrl: key.ctrl, meta: key.meta })) return 'typing';
  return 'other';
}

export interface FrameMeter {
  // An input event arrived (the backend's key listener, before anything handles it).
  input: (key: KeyLike) => void;
  // flowtty's `onFrame`. Never throws: a throw there would end the app.
  frame: (stats: FrameStats) => void;
  // The frames kept of a kind, oldest first.
  frames: (kind: FrameKind) => readonly FrameRecord[];
  // How many frames were counted, and how many were slow, since the meter started.
  totals: () => { frames: number; slow: number };
  // What `:perf` writes into the log, one line each.
  report: () => string[];
  // The one line `:perf` shows: the p95 of each kind that has frames.
  headline: () => string;
}

export interface FrameMeterOptions {
  now?: () => number;
  window?: number;
  slowMs?: number;
  // Where a slow frame's line goes (the host log).
  onSlow?: (line: string) => void;
  slowEveryMs?: number;
  // Runs `fn` once the input's own synchronous work and its paint are over; a stamp no
  // frame took by then is dropped, so a key that changed nothing never lends its time
  // to an unrelated frame later. The paint is a microtask after the commit, so a
  // macrotask is after it.
  later?: (fn: () => void) => void;
}

// The value at percentile `p` (0..100) of `values`, nearest rank; 0 for none.
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

const ms = (n: number) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));

function spread(values: readonly number[], fmt: (n: number) => string): string {
  return `p50 ${fmt(percentile(values, 50))} p95 ${fmt(percentile(values, 95))} max ${fmt(Math.max(...values))}`;
}

// The one log line of a slow frame: what it answered and every counter it carried, and
// how many slow frames since the previous line were folded into this one.
export function slowFrameLine(r: FrameRecord, folded = 0): string {
  const more = folded ? ` · +${folded} slow frame${folded === 1 ? '' : 's'} since the last line` : '';
  const waited = r.latencyMs === undefined ? '' : ` · input→frame ${ms(r.latencyMs)} ms (${r.inputs} input${r.inputs === 1 ? '' : 's'})`;
  return `[perf] slow frame · ${r.kind}${waited} · layout ${ms(r.layoutMs)} paint ${ms(r.paintMs)} draw ${ms(r.drawMs)} ms · ${r.commits} commit${r.commits === 1 ? '' : 's'} · ${r.applied} applied / ${r.skipped} skipped${more}`;
}

export function createFrameMeter(opts: FrameMeterOptions = {}): FrameMeter {
  const now = opts.now ?? (() => performance.now());
  const size = Math.max(1, opts.window ?? FRAME_WINDOW);
  const slowMs = opts.slowMs ?? SLOW_FRAME_MS;
  const slowEvery = opts.slowEveryMs ?? SLOW_LOG_EVERY_MS;
  let lastSlowLine = -Infinity;
  let folded = 0;
  const later = opts.later ?? ((fn: () => void) => { setTimeout(fn, 0); });
  const kept = new Map<FrameKind, FrameRecord[]>(FRAME_KINDS.map((k) => [k, []]));
  let pending: { kind: InputKind; at: number; inputs: number } | null = null;
  let frames = 0;
  let slow = 0;

  const input = (key: KeyLike) => {
    try {
      const kind = inputKind(key);
      if (pending) {
        // The frame is tagged by the latest input, timed from the first.
        pending.kind = kind;
        pending.inputs += 1;
        return;
      }
      const stamp = { kind, at: now(), inputs: 1 };
      pending = stamp;
      later(() => { if (pending === stamp) pending = null; });
    } catch { /* the meter never stands in the way of a key */ }
  };

  const frame = (stats: FrameStats) => {
    try {
      const at = now();
      const p = pending;
      pending = null;
      const record: FrameRecord = {
        ...stats,
        kind: p ? p.kind : 'redraw',
        ...(p ? { latencyMs: Math.max(0, at - p.at) } : {}),
        workMs: stats.layoutMs + stats.paintMs + stats.drawMs,
        inputs: p ? p.inputs : 0,
      };
      const list = kept.get(record.kind)!;
      list.push(record);
      if (list.length > size) list.shift();
      frames += 1;
      if ((record.latencyMs ?? record.workMs) >= slowMs) {
        slow += 1;
        if (at - lastSlowLine < slowEvery) folded += 1;
        else {
          lastSlowLine = at;
          const line = slowFrameLine(record, folded);
          folded = 0;
          opts.onSlow?.(line);
        }
      }
    } catch { /* flowtty ends the app on a throw from onFrame */ }
  };

  const report = (): string[] => {
    const lines = [`[perf] the last ${size} frames of each kind · ${frames} frames since start, ${slow} slower than ${slowMs} ms`];
    for (const kind of FRAME_KINDS) {
      const list = kept.get(kind)!;
      if (!list.length) { lines.push(`[perf] ${kind}: no frames`); continue; }
      const waited = list.filter((r) => r.latencyMs !== undefined).map((r) => r.latencyMs!);
      const parts = [
        `[perf] ${kind}: ${list.length} frame${list.length === 1 ? '' : 's'}`,
        ...(waited.length ? [`input→frame ${spread(waited, ms)} ms`] : []),
        `layout+paint+draw ${spread(list.map((r) => r.workMs), ms)} ms`,
        `commits ${spread(list.map((r) => r.commits), String)}`,
        `applied ${spread(list.map((r) => r.applied), String)}`,
        `skipped ${spread(list.map((r) => r.skipped), String)}`,
      ];
      lines.push(parts.join(' · '));
    }
    return lines;
  };

  const headline = (): string => {
    const parts = FRAME_KINDS.flatMap((kind) => {
      const list = kept.get(kind)!;
      if (!list.length) return [];
      return [`${kind} p95 ${ms(percentile(list.map((r) => r.latencyMs ?? r.workMs), 95))} ms`];
    });
    return parts.length ? `perf: ${parts.join(' · ')}` : 'perf: no frames yet';
  };

  return { input, frame, frames: (kind) => kept.get(kind)!, totals: () => ({ frames, slow }), report, headline };
}

// The backend with every input event reported to the meter first — wrapped around the
// root backend, under the host's own key path (`hostKeyed` in app.tsx), which hands a
// key nothing took to flowtty a second time: the meter hears each key once.
export function metered(root: Backend, meter: FrameMeter): Backend {
  return new Proxy(root, {
    get(target, prop) {
      if (prop === 'onKey' && typeof target.onKey === 'function') {
        return (listener: (key: never) => unknown) => target.onKey!(((key: KeyLike) => {
          meter.input(key);
          return listener(key as never);
        }) as never);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
