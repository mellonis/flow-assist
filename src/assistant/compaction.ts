// Compaction, the pure parts: what the model is asked to write when the conversation
// is folded into a summary, what is accepted back, and when the chat compacts by itself.
// Tool-call markup is stripped from a summary by ./tool-markup.ts.
//
// The summary is a HANDOFF — written for the model that continues the work, never
// for the person: fixed sections, no question, no pleasantries. It REPLACES the
// previous one, which the model is shown and told to carry forward, so what rides in
// the system context stays one document rather than a pile of old replies.

import { estimateTokens } from './context-meter.js';

export const HANDOFF_SECTIONS = ['Goal', 'Done', 'In progress', 'Open decisions', 'Facts learned'] as const;

// How each heading is recognised: at the start of a line, after any `#`, `*`, `_`
// or list mark, in any case. "Open questions" counts for "Open decisions".
const HEADING: Record<(typeof HANDOFF_SECTIONS)[number], RegExp> = {
  'Goal': /^[\s#*_>-]*goals?\b/im,
  'Done': /^[\s#*_>-]*done\b/im,
  'In progress': /^[\s#*_>-]*in progress\b/im,
  'Open decisions': /^[\s#*_>-]*open (?:decisions|questions)\b/im,
  'Facts learned': /^[\s#*_>-]*facts\b/im,
};

// A summary under BOTH of these is too short for what it replaces: under 1% of the
// compacted tokens, and under this many characters. A small conversation may well
// fold into a few lines; a long session may not.
export const SHORT_SHARE = 0.01;
export const SHORT_CHARS = 1500;

export function compactionInstruction(): string {
  return [
    'You are writing a HANDOFF. The conversation below is being compacted: everything in it is replaced by what you write, and a model that has not seen it continues the work from your text alone. Write for that model, not for the person — no question to the person, no greeting, no offer, no closing line.',
    '',
    'Use exactly these sections, each under its own heading, in this order:',
    '## Goal — what the person wants overall, in their terms.',
    '## Done — what is finished: commits (hash and subject), file paths, the commands that worked, verbatim.',
    '## In progress — what was being done when the conversation was cut, and the exact next step.',
    '## Open decisions — questions waiting for the person and choices not yet made; "none" when there are none.',
    '## Facts learned — pitfalls hit, conventions of this repository or project, commands and flags that work or fail, names and values that matter.',
    '',
    'When a previous handoff is given, yours REPLACES it: carry forward everything in it that still holds, and drop what was settled or went stale. Keep the specifics — names, paths, numbers, error texts — the next model cannot recover them. Plain text under the headings; never write a tool call. Scale the length to the work: a long session needs a long handoff.',
  ].join('\n');
}

// Why a summary is not a usable handoff, or null when it is.
export function summaryProblem(summary: string, compactedTokens: number): string | null {
  const text = summary.trim();
  const missing = HANDOFF_SECTIONS.filter((s) => !HEADING[s].test(text));
  const problems: string[] = [];
  if (!text) problems.push('it is empty');
  else if (missing.length) problems.push(`it is missing the sections ${missing.join(', ')}`);
  if (text && text.length < SHORT_CHARS && estimateTokens(text) < SHORT_SHARE * compactedTokens) {
    problems.push(`it is too short — ${text.length} characters for ~${Math.round(compactedTokens / 1000)}k tokens compacted`);
  }
  return problems.length ? problems.join('; ') : null;
}

// What the second attempt is told about the first.
export function retryNote(problem: string): string {
  return `Your first answer was not a usable handoff: ${problem}. Write it again — all five sections under their headings, with the specifics that let the work go on.`;
}

// ── Automatic compaction (`ai.autoCompact`) ──
// Before a request that would pass `threshold` of `ai.contextWindow`, the conversation
// is compacted first. On unless `enabled` is false; the threshold is held to 0.5–0.95
// — lower compacts all the time, higher leaves no room for the answer.
export interface AutoCompact { enabled: boolean; threshold: number }
export const AUTO_COMPACT_DEFAULTS: AutoCompact = { enabled: true, threshold: 0.8 };

export function autoCompactLimits(ai: unknown): AutoCompact {
  const c = (ai as { autoCompact?: { enabled?: unknown; threshold?: unknown } } | undefined)?.autoCompact ?? {};
  const t = typeof c.threshold === 'number' && Number.isFinite(c.threshold) ? Math.min(0.95, Math.max(0.5, c.threshold)) : AUTO_COMPACT_DEFAULTS.threshold;
  return { enabled: c.enabled !== false, threshold: t };
}

// Would a request of `tokens` pass the threshold?
export function overThreshold(tokens: number, window: number, limits: AutoCompact): boolean {
  return limits.enabled && window > 0 && tokens > limits.threshold * window;
}

// What the person's message says to the model once the work on it so far was folded
// into the handoff mid-turn: the question alone would read as not yet begun.
export const RESUMED_NOTE = '[The work on this message so far was compacted into the handoff in the system context — continue from its next step; do not start over.]';
