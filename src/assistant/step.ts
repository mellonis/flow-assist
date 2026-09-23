// A turn drawn in TIME ORDER, and what the model said on the way.
//
// A turn is one assistant message, and it used to be laid out by category: a step
// line, the text already shown, every diff of the turn, then the answer. A round's
// text that turned out to carry a tool call was moved into the "already shown" slot
// — above every diff of the turn — so with a tall diff it left the screen, and the
// ✎ block was the last thing on it again, as if a second write had happened.
//
// Now the message carries its PARTS in the order they happened (`TurnPart`): the text
// of each round that went on to call a tool (a STEP), the calls themselves (a `tools`
// part — the trail, where the calls happened), and each change a write reported. The
// text of a round stays where it was drawn; the final round is the answer
// (`content`), drawn after them. Pure: the chat keeps the parts, the view
// (src/views/modals.ts) lays them out.
//
//   - **Steps come in runs.** Consecutive steps — each with the calls it made — are
//     one RUN; anything else visible — calls no step made, a ✎ change, a command's
//     block (a message of its own) — ends it (`turnSegments`).
//   - **`step` mode (the default) folds each run to ONE dim row** at its own place:
//     the newest step of the run, and how many there are (`runRowText`). A click
//     opens that run alone, `^o` every run; opened, each step is drawn in full, dim,
//     where it happened, with the calls it made under it.
//   - **`open` mode draws every step in full, in the normal colour** — steps do not
//     fold; each step's calls are a trail line of their own under it.
//   - **The `Next:` token is never drawn** (`shownText`). The prompt asks for one
//     line starting `Next:` before a tool call — the sentence after it is the step,
//     the token is protocol. The answer is drawn exactly as written (`answerText`).

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
// A step's text as the model wrote it (the `Next:` token included — it is taken out
// where it is drawn), the calls a round made (consecutive calls with nothing drawn
// between them share one part), or a change a write reported.
export interface CallRun { name: string; args?: unknown; write?: boolean; outcome: string; detail?: string }
export type TurnPart = { kind: 'text'; text: string } | { kind: 'tools'; runs: CallRun[] } | { kind: 'change'; change: ChangeView };

// A call as a part keeps it: what the trail draws, never the tool's whole result (a
// file's contents would ride in every session save) and never its changes or views,
// which are parts and messages of their own.
export function callRun(raw: unknown): CallRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || typeof r.outcome !== 'string') return null;
  const detail = typeof r.detail === 'string' ? r.detail : r.detail == null ? '' : JSON.stringify(r.detail);
  return { name: r.name, ...(r.args !== undefined ? { args: r.args } : {}), ...(r.write ? { write: true } : {}), outcome: r.outcome, ...(detail ? { detail: detail.slice(0, 300) } : {}) };
}

// Calls added to a turn's parts: into the last part when it is calls too, so
// `read_file` twice with nothing between is one line (`read_file ×2`).
export function addCalls(parts: readonly TurnPart[], runs: readonly CallRun[]): TurnPart[] {
  if (!runs.length) return [...parts];
  const last = parts.at(-1);
  if (last?.kind === 'tools') return [...parts.slice(0, -1), { kind: 'tools', runs: [...last.runs, ...runs] }];
  return [...parts, { kind: 'tools', runs: [...runs] }];
}

// A round that went on to call a tool has ended: its text becomes a step. A round
// that wrote nothing leaves no step — but when the calls before it were a step's own,
// it leaves an empty one, so its calls are not taken for that step's (`addCalls` would
// add them to the step's part, and `turnSegments` would draw them inside its run).
export function endRound(parts: readonly TurnPart[], text: string): TurnPart[] {
  if (String(text ?? '').trim()) return [...parts, { kind: 'text', text }];
  const [before, last] = [parts.at(-2), parts.at(-1)];
  if (last?.kind === 'tools' && before?.kind === 'text' && shownText(before.text)) return [...parts, { kind: 'text', text: '' }];
  return [...parts];
}

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
    else if (r.kind === 'tools' && Array.isArray(r.runs)) {
      const runs = r.runs.map(callRun).filter((c): c is CallRun => c !== null);
      if (runs.length) out.push({ kind: 'tools', runs });
    } else if (r.kind === 'change') {
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

// A step's text as it is drawn — while it streams and once it is a step: a line
// starting `Next:` keeps its sentence and loses the token (a model that keeps to the
// prompt writes exactly one such line per step, and it IS the step), and a LAST line
// that could still become one (`N`, `Nex`…) is held back until it says what it is — a
// few characters nobody sees, rather than a token that appears and vanishes.
export function shownText(text: string): string {
  const lines = String(text ?? '').split('\n');
  const kept: string[] = [];
  lines.forEach((line, i) => {
    const head = tidy(line);
    if (NEXT_LINE.test(head)) {
      const said = head.replace(NEXT_LINE, '');
      if (said) kept.push(said);
      return;
    }
    if (i === lines.length - 1 && head && MAYBE_NEXT.test(head)) return;
    kept.push(line);
  });
  return kept.join('\n').trim();
}

// The answer as it is drawn: exactly as the model wrote it. A `Next: restart the
// server` in an answer is advice to the person, not protocol.
export function answerText(text: string): string {
  return String(text ?? '').trim();
}

// A step that is nothing but its `Next:` line — the plan the prompt asks for before a
// call. A group of commands takes such a message in: its head says what ran.
export function isPlanOnly(text: string): boolean {
  const lines = String(text ?? '').split('\n').map(tidy).filter(Boolean);
  return lines.length > 0 && lines.every((l) => NEXT_LINE.test(l));
}

// ─── Runs ─────────────────────────────────────────────────────────────────────
// What a message draws between its reasoning and its answer, in order: runs of
// steps, the calls and the changes. Runs and calls are numbered — `n` is the block's
// fold id, and it never changes as the turn grows, since parts are only ever appended.
// A step with nothing left to draw does not break a run.
//
// A step's own calls — the calls of the round whose text it is, right after it — are
// the step's: they belong to its run (`calls[i]` beside `steps[i]`) and do not end it,
// or no two steps could ever share a run, each being followed by what it called. Calls
// with no step before them (a round that wrote nothing, or calls after a change) are a
// block of their own, and end a run like a change does. Every stretch of calls is
// numbered, the step's own included, so its id is the same in both modes.
export interface StepCalls { n: number; runs: CallRun[] }
export type TurnSegment =
  | { kind: 'run'; n: number; steps: string[]; calls: (StepCalls | null)[] }
  | { kind: 'tools'; n: number; runs: CallRun[] }
  | { kind: 'change'; change: ChangeView };

export function turnSegments(parts: readonly TurnPart[]): TurnSegment[] {
  const out: TurnSegment[] = [];
  let runs = 0;
  let calls = 0;
  // Whether the part just before was a step that drew something — its calls are its own.
  let afterStep = false;
  for (const p of parts) {
    if (p.kind === 'change') { out.push({ kind: 'change', change: p.change }); afterStep = false; continue; }
    if (p.kind === 'tools') {
      const last = out.at(-1);
      if (afterStep && last?.kind === 'run') last.calls[last.calls.length - 1] = { n: calls++, runs: p.runs };
      else out.push({ kind: 'tools', n: calls++, runs: p.runs });
      afterStep = false;
      continue;
    }
    const text = shownText(p.text);
    if (!text) { afterStep = false; continue; }
    const last = out.at(-1);
    if (last?.kind === 'run') { last.steps.push(text); last.calls.push(null); }
    else out.push({ kind: 'run', n: runs++, steps: [text], calls: [null] });
    afterStep = true;
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
