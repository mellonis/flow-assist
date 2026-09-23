// A turn drawn in TIME ORDER, and what the model said on the way.
//
// A turn is one assistant message, and it used to be laid out by category: a step
// line, the text already shown, every diff of the turn, then the answer. A round's
// text that turned out to carry a tool call was moved into the "already shown" slot
// — above every diff of the turn — so with a tall diff it left the screen, and the
// ✎ block was the last thing on it again, as if a second write had happened.
//
// Now the message carries its PARTS in the order they happened (`TurnPart`): the text
// of each round that went on to call a tool (a STEP), and each change a write
// reported. The text of a round stays where it was drawn; the final round is the
// answer (`content`), drawn after them. Pure: the chat keeps the parts, the view
// (src/views/modals.ts) lays them out.
//
//   - **Steps come in runs.** Consecutive steps with nothing visible between them are
//     one RUN; anything visible — a ✎ change, a command's block (a message of its
//     own) — ends it (`turnSegments`).
//   - **`step` mode (the default) folds each run to ONE dim row** at its own place:
//     the newest step of the run, and how many there are (`runRowText`). A click
//     opens that run alone, `^o` every run; opened, each step is drawn in full, dim,
//     where it happened.
//   - **`open` mode draws every step in full, in the normal colour** — no folds.
//   - **A `Next:` line is never drawn** (`shownText`). The prompt asks for one before
//     a tool call; it is protocol, not something to read.

import type { ChangeView } from './diff.js';

// ─── The mode ─────────────────────────────────────────────────────────────────
// How the steps are drawn (`plugins.assistant.notes`, `/notes` for the conversation).
export type NotesMode = 'step' | 'open';
export const NOTES_MODES: readonly NotesMode[] = ['step', 'open'];

// A mode written anywhere a person can write one (the config file, `/notes`).
// Anything unrecognised is `step` — which is also how the modes that were dropped,
// `fold` and `hidden`, read in a config file written before: a hand-edited config
// must not leave the chat with a narration area nobody can explain.
export function notesMode(raw: unknown): NotesMode {
  const word = String(raw ?? '').trim().toLowerCase();
  return (NOTES_MODES as readonly string[]).includes(word) ? (word as NotesMode) : 'step';
}

// What `/notes <arg>` asked for: a mode, `'say'` for the bare command (which only
// reports where the conversation stands), or null for a word that means nothing here.
export function notesCommand(arg: string): NotesMode | 'say' | null {
  const word = String(arg ?? '').trim().toLowerCase();
  if (!word) return 'say';
  return (NOTES_MODES as readonly string[]).includes(word) ? (word as NotesMode) : null;
}

// The sentence said when the mode changes, and by the bare `/notes`.
export function notesSaid(mode: NotesMode): string {
  if (mode === 'open') return 'notes: open — every step in full, where it happened';
  return 'notes: step — each run of steps folds to one dim line where it happened';
}

// ─── The parts of a turn ──────────────────────────────────────────────────────
// A step's text as the model wrote it (Next: lines included — they are filtered
// where it is drawn), or a change a write reported.
export type TurnPart = { kind: 'text'; text: string } | { kind: 'change'; change: ChangeView };

// The parts of a message as whatever holds them gave them — a session file may have
// been hand-edited or cut short. Anything that is not a part a renderer can draw is
// dropped, never drawn and never thrown on.
export function readParts(raw: unknown): TurnPart[] {
  if (!Array.isArray(raw)) return [];
  const out: TurnPart[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const r = p as Record<string, unknown>;
    if (r.kind === 'text' && typeof r.text === 'string') out.push({ kind: 'text', text: r.text });
    else if (r.kind === 'change') {
      const change = readChange(r.change);
      if (change) out.push({ kind: 'change', change });
    }
  }
  return out;
}

// A change as a session kept it: the title and the hunks must be text; a count that
// is not a number reads as 0.
export function readChange(raw: unknown): ChangeView | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.title !== 'string' || typeof c.diff !== 'string') return null;
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return { title: c.title, diff: c.diff, added: n(c.added), removed: n(c.removed), hidden: n(c.hidden) };
}

// ─── What of a text is drawn ──────────────────────────────────────────────────
// The shape the prompt asks for before a tool call.
const NEXT_LINE = /^next\s*:\s*/i;
// Still short enough to grow into `Next:` — `N`, `Ne`, `Nex`, `Next`, `Next ` .
const MAYBE_NEXT = /^n(e(x(t\s*)?)?)?$/i;

// One line as a person should read it: no list marker, no heading hashes, no
// backticks or asterisks around a word, whitespace collapsed. Underscores are left
// alone — `read_file` is a name, not emphasis.
function tidy(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The text as it is drawn: every `Next:` line taken out, and a LAST line that could
// still become one (`N`, `Nex`…) held back until it says what it is — a few
// characters nobody sees, rather than a line that appears and vanishes. The same
// function lays out a round while it streams, a step and the answer, so a round that
// ends keeps exactly the rows it was drawn with.
export function shownText(text: string): string {
  const lines = String(text ?? '').split('\n');
  const kept: string[] = [];
  lines.forEach((line, i) => {
    const head = tidy(line);
    if (NEXT_LINE.test(head)) return;
    if (i === lines.length - 1 && head && MAYBE_NEXT.test(head)) return;
    kept.push(line);
  });
  return kept.join('\n').trim();
}

// ─── Runs ─────────────────────────────────────────────────────────────────────
// What a message draws between its reasoning and its answer, in order: runs of
// steps (each numbered — `n` is the run's fold id, and a run never changes number as
// the turn grows, since parts are only ever appended) and changes. A step whose text
// is all `Next:` draws nothing and does not break a run.
export type TurnSegment = { kind: 'run'; n: number; steps: string[] } | { kind: 'change'; change: ChangeView };

export function turnSegments(parts: readonly TurnPart[]): TurnSegment[] {
  const out: TurnSegment[] = [];
  let runs = 0;
  for (const p of parts) {
    if (p.kind === 'change') { out.push({ kind: 'change', change: p.change }); continue; }
    const text = shownText(p.text);
    if (!text) continue;
    const last = out.at(-1);
    if (last?.kind === 'run') last.steps.push(text);
    else out.push({ kind: 'run', n: runs++, steps: [text] });
  }
  return out;
}

// ─── The row a folded run is ──────────────────────────────────────────────────
// A sentence ends in `.`, `!` or `?`, possibly inside a closing quote or bracket.
const ENDS_SENTENCE = /[.!?]["'”’)\]]*$/;

// The last COMPLETE sentence of one line, or '' while it is still being written.
function lastSentenceOf(line: string): string {
  const parts = line.split(/(?<=[.!?]["'”’)\]]*)\s+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!.trim();
    if (part && ENDS_SENTENCE.test(part)) return part;
  }
  return '';
}

// What a step says in one line: its last finished sentence, or — when it finished
// none — its first line. The input is a step as drawn (`shownText`).
export function stepSummary(text: string): string {
  const lines = String(text ?? '').split('\n').map(tidy).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const sentence = lastSentenceOf(lines[i]!);
    if (sentence) return sentence;
  }
  return lines[0] ?? '';
}

// The folded run's row: `▸ ` + the newest step + how many steps the run holds — no
// count for a run of one. Exactly one terminal row: the summary is cut so the count
// always fits.
export function runRowText(steps: readonly string[], width: number): string {
  const count = steps.length > 1 ? `  (${steps.length} steps)` : '';
  const head = '▸ ';
  const room = Math.max(1, width - Array.from(head).length - Array.from(count).length);
  return cutStep(`${head}${cutStep(stepSummary(steps.at(-1) ?? ''), room)}${count}`, width);
}

// A line of chrome takes exactly ONE terminal row, so what does not fit is cut with an
// ellipsis rather than wrapped. Counted in characters, as the grid counts them.
export function cutStep(text: string, width: number): string {
  const chars = Array.from(String(text ?? ''));
  if (width <= 0) return '';
  if (chars.length <= width) return chars.join('');
  if (width === 1) return '…';
  return `${chars.slice(0, width - 1).join('')}…`;
}
