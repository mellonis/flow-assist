// The step line: what the model last said it is doing, in ONE dim row under the
// answer, instead of the folded `▸ notes` header and the last two lines of prose.
//
// Between tool calls the model writes prose, and the one thing in it worth seeing is
// what it is about to do. The naive line — the tail of whatever had arrived, redrawn
// on every token — changed six times over a single turn, grew mid-sentence, and
// picked up the final answer as it streamed. The settled line, recorded at a live
// streaming pace over the same turn, changed twice. Three rules make the difference,
// and they are the whole of this module:
//
//   - **Only a complete sentence is shown.** A sentence ends in `.`, `!` or `?`;
//     while a new one is being written the previous one stays. The input is read as a
//     PREFIX of what the model is writing: every line but the last was closed by its
//     newline, the last one only by its own punctuation.
//   - **A `Next:` line is complete when its line is.** The prompt asks for one short
//     line starting `Next:` before a tool call, and a model writing to that shape
//     often leaves the full stop off. The line is the whole step either way, so the
//     newline that ends it is as good as a full stop — and the `Next:` itself is
//     protocol, not something to read, so it is stripped.
//   - **At most one change a second.** A change that comes too soon waits (`pending`)
//     and lands when the second is up; the caller schedules that with `stepWaitMs`.
//
// What is NOT here, because it was the prototype's real bug: the answer's own text
// never feeds the line. Only the narration of rounds that carried tool calls does —
// the caller passes what it accumulates in `process`, never a round's `live` or the
// final content. Reasoning does not feed it either: the status line already says
// `thinking…`, and ^r unfolds the reasoning as it always did.

// How the narration is drawn, and how much of it (`plugins.assistant.notes`,
// `/notes` for the conversation).
export type NotesMode = 'step' | 'fold' | 'open' | 'hidden';
export const NOTES_MODES: readonly NotesMode[] = ['step', 'fold', 'open', 'hidden'];

// A mode written anywhere a person can write one (the config file, `/notes`).
// Anything unrecognised is `step`: a hand-edited config must not leave the chat with
// a narration area nobody can explain.
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
  if (mode === 'fold') return 'notes: fold — the narration behind a ▸ header, its last lines under it';
  if (mode === 'open') return 'notes: open — the whole narration, unfolded';
  if (mode === 'hidden') return 'notes: hidden — the narration is not drawn (^r still opens the tool calls)';
  return 'notes: step — one dim line, the last thing it said it is doing';
}

// ─── Keeping the rounds apart ─────────────────────────────────────────────────
// A round's narration is one chunk; a turn is several. Appended with nothing
// between them the sentences ran together — "…how many there are.Now I will count
// them…" — in the fold, and in anything reading the accumulated text. A blank line
// keeps them apart as the paragraphs they are, for the markdown the fold lays out
// as much as for the sentence rule below.
export function joinNarration(before: string | undefined, chunk: string): string {
  return [String(before ?? '').trimEnd(), String(chunk ?? '').trim()].filter(Boolean).join('\n\n');
}

// ─── The sentence ─────────────────────────────────────────────────────────────
// A sentence ends in `.`, `!` or `?`, possibly inside a closing quote or bracket.
const ENDS_SENTENCE = /[.!?]["'”’)\]]*$/;
// The shape the prompt asks for before a tool call.
const NEXT_LINE = /^next\s*:\s*/i;

// One line of narration as a person should read it: no list marker, no heading
// hashes, no backticks or asterisks around a word, whitespace collapsed. Underscores
// are left alone — `read_file` is a name, not emphasis.
function tidy(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The last COMPLETE sentence of one line, or '' while it is still being written.
function lastSentenceOf(line: string): string {
  const parts = line.split(/(?<=[.!?]["'”’)\]]*)\s+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!.trim();
    if (part && ENDS_SENTENCE.test(part)) return part;
  }
  return '';
}

// What the line should say for this narration — '' when nothing in it is finished
// yet, and then the caller keeps whatever it was showing.
export function lastStep(narration: string): string {
  const lines = String(narration ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    // Every line but the last was closed by the newline after it; the last line is
    // still being written, so only its own punctuation can close it.
    const closed = i < lines.length - 1;
    const line = tidy(lines[i]!);
    if (!line) continue;
    if (NEXT_LINE.test(line)) {
      if (closed || ENDS_SENTENCE.test(line)) return line.replace(NEXT_LINE, '').trim();
      continue;
    }
    const sentence = lastSentenceOf(line);
    if (sentence) return sentence;
  }
  return '';
}

// ─── One change a second ──────────────────────────────────────────────────────
// The floor is on the CHANGE, not on the reading: a new sentence that arrives too
// soon is held and shown when the second is up, so nothing is lost and nothing
// flickers.
export const STEP_FLOOR_MS = 1000;

export interface StepState {
  // What the line says now.
  shown: string;
  // When it last changed. 0 — it has not yet, and the first change is immediate.
  at: number;
  // A change that came inside the floor and is waiting for it.
  pending: string;
}

export const emptyStep = (): StepState => ({ shown: '', at: 0, pending: '' });

// New narration has arrived. The state that comes back is what to draw.
export function offerStep(state: StepState, narration: string, now: number): StepState {
  const cand = lastStep(narration);
  if (!cand || cand === state.shown) return state.pending ? { ...state, pending: '' } : state;
  if (state.at && now - state.at < STEP_FLOOR_MS) return state.pending === cand ? state : { ...state, pending: cand };
  return { shown: cand, at: now, pending: '' };
}

// The floor is up: whatever was waiting becomes what the line says.
export function dueStep(state: StepState, now: number): StepState {
  if (!state.pending || now - state.at < STEP_FLOOR_MS) return state;
  return { shown: state.pending, at: now, pending: '' };
}

// How long until a waiting change may be shown — 0 when nothing waits.
export function stepWaitMs(state: StepState, now: number): number {
  if (!state.pending) return 0;
  return Math.max(0, STEP_FLOOR_MS - (now - state.at));
}

// The line is chrome and takes exactly ONE terminal row, so what does not fit is cut
// with an ellipsis rather than wrapped. Counted in characters, as the grid counts
// them.
export function cutStep(text: string, width: number): string {
  const chars = Array.from(String(text ?? ''));
  if (width <= 0) return '';
  if (chars.length <= width) return chars.join('');
  if (width === 1) return '…';
  return `${chars.slice(0, width - 1).join('')}…`;
}
