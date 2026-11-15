// The composite pieces the renderer draws the data components from: the
// progress bar, the percent text, the task-state glyph, the tone as a
// palette token, and text cut to a cell width. Pure strings and numbers in,
// strings out — no host imports, and `fit` takes the stringWidth to measure
// with, so the renderer passes ui.stringWidth (cells per grapheme cluster)
// and this module never depends on flowtty. checkTree already refuses the
// bad inputs, so the fallbacks here are the renderer's last line of defence.
import { TONE_TOKENS } from './tree.ts';

// A value clamped to 0–100, a non-finite value reading 0 — the bar and the
// percent text read a broken value the same way.
const clampPct = (value: number): number => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0);

// The bar of `width` cells for a 0–100 value: filled blocks, the rest empty,
// and no width below 1 draws at all (''). The filled count floors, so the
// bar never exceeds its width; the width itself rounds to a whole number.
export function bar(value: number, width: number): string {
  const w = Math.max(0, Math.round(width));
  const filled = Math.floor((clampPct(value) / 100) * w);
  return '█'.repeat(filled) + '░'.repeat(w - filled);
}

// The value as a whole-percent string: floored, clamped to 0–100, a
// non-finite value reading 0.
export function percentText(value: number): string {
  return `${Math.floor(clampPct(value))}%`;
}

export type TTaskState = 'done' | 'running' | 'queued' | 'failed';

const TASK_GLYPH: Record<TTaskState, string> = { done: '✓', running: '●', queued: '○', failed: '✗' };

// The one glyph per task state; an unknown state reads '?', the way outline
// reads an unknown node type — checkTree refuses a state that is not one of
// the four, so this is defence only.
export function taskGlyph(state: TTaskState): string {
  return TASK_GLYPH[state] ?? '?';
}

// The tone as a palette token: the token itself when it names one, 'default'
// otherwise. A literal colour is not a token — checkTree refuses one, and
// this is the renderer's last line of defence.
export function toneToken(tone: unknown): string {
  return typeof tone === 'string' && TONE_TOKENS.includes(tone) ? tone : 'default';
}

// The text cut to `width` cells, measured by the injected stringWidth: a
// text that fits is returned as is; a wider one is cut to the longest prefix
// that still leaves one cell for the '…', and a width below 1 fits nothing.
export function fit(text: string, width: number, stringWidth: (s: string) => number): string {
  if (width < 1) return '';
  if (stringWidth(text) <= width) return text;
  let prefix = '';
  for (const ch of text) {
    if (stringWidth(prefix + ch) >= width) break;
    prefix += ch;
  }
  return `${prefix}…`;
}
