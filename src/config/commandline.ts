// The command line's completion, as the chat's field does it. With one candidate it is
// INLINE: the part of the suggestion not typed yet is drawn right after the caret, and
// Tab takes it. With two or more a LIST opens beside the line (`openList`): ↑/↓ move
// the selection, Tab and Enter take it, Esc closes it until the text changes, and the
// inline rest shows the selected candidate. The list keeps one height while it is open,
// so typing does not move the screen by a row at a time. While the list is closed (Esc)
// Tab still takes the offer and walks the other candidates, one per press.
//
// Pure: what to draw and what a key does are computed from the text and the list's
// state, so both are tested without a terminal. The chat's field goes through the same
// functions with a completer of its own (src/config/fieldcomplete.ts), so a
// `/command`'s argument and a path in shell mode are drawn and taken exactly as a `:`
// command is.
import type { CompleteResult } from './commands.js';

// A Tab walk in progress: `stem` is the text before the word being completed, `head`
// what the person had typed of that word, `shown` the line as Tab left it. The walk
// is over as soon as the line is anything else.
export interface TabWalk { stem: string; head: string; idx: number; shown: string }

export interface LineView {
  // The untyped rest of the suggestion, drawn after the caret. '' when there is
  // nothing to offer, or while walking (the line already holds a whole candidate).
  ghost: string;
  // What the offered candidate's label says (a session's title beside its number);
  // '' when it has none.
  label: string;
  // The other candidates, named beside it — each with its label after it, when it
  // has one.
  others: string[];
}

type Complete = (text: string) => CompleteResult;

// `head` is the prefix of the word being completed and `best` its replacement, so the
// text before that word is the input minus `head`.
const stemOf = (input: string, head: string) => input.slice(0, input.length - head.length);

const walking = (input: string, walk: TabWalk | null): walk is TabWalk => !!walk && walk.shown === input;

const named = (c: string, labels: Record<string, string> | undefined) => (labels?.[c] ? `${c} ${labels[c]}` : c);

export function lineView(input: string, walk: TabWalk | null, complete: Complete): LineView {
  if (!input.trim()) return { ghost: '', label: '', others: [] };
  if (walking(input, walk)) {
    // The candidates of the walk, taken from where it STARTED — from the line as it
    // stands they would narrow to the one Tab just picked.
    const comp = complete(walk.stem + walk.head);
    const all = comp.candidates;
    if (all.length > 1) {
      const at = walk.idx % all.length;
      return { ghost: '', label: comp.labels?.[all[at]!] ?? '', others: all.filter((_, i) => i !== at).map((c) => named(c, comp.labels)) };
    }
  }
  const comp = complete(input);
  const fits = comp.best && comp.best.toLowerCase().startsWith(comp.head.toLowerCase()) && input.endsWith(comp.head);
  const ghost = fits ? comp.best.slice(comp.head.length) : '';
  return { ghost, label: fits ? comp.labels?.[comp.best] ?? '' : '', others: comp.candidates.filter((c) => c !== comp.best).map((c) => named(c, comp.labels)) };
}

export function lineTab(input: string, walk: TabWalk | null, complete: Complete): { input: string; walk: TabWalk | null } {
  if (!input.trim()) return { input, walk: null };
  if (walking(input, walk)) {
    const all = complete(walk.stem + walk.head).candidates;
    // A walk over more than one candidate steps to the next. Over exactly one there
    // is nowhere to step, and the line is completed anew from what it holds — which
    // is how a second Tab after a unique `dir/` walks into the directory.
    if (all.length > 1) {
      const idx = (walk.idx + 1) % all.length;
      const shown = walk.stem + all[idx]!;
      return { input: shown, walk: { ...walk, idx, shown } };
    }
  }
  const comp = complete(input);
  if (!comp.best || !input.endsWith(comp.head)) return { input, walk: null };
  // Replace the WORD being completed — not everything before the first space, which
  // is what turned `config ge` + Tab into `get ge`.
  const stem = stemOf(input, comp.head);
  const shown = stem + comp.best;
  return { input: shown, walk: { stem, head: comp.head, idx: Math.max(0, comp.candidates.indexOf(comp.best)), shown } };
}

// ─── The list ────────────────────────────────────────────────────────────────
// The most candidate rows the list shows; more are scrolled around the selection.
export const LIST_ROWS = 8;

// A line's list in progress. `text` is the line the state was last read against: when
// the line is anything else the selection and the Esc are void. `sel` indexes the
// candidates (-1: the completer's best), `closed` is Esc, and `height` the rows the
// list has needed since it opened, so it never shrinks while it is open.
export interface ListState { text: string; sel: number; closed: boolean; height: number }
export const newListState = (): ListState => ({ text: '', sel: -1, closed: false, height: 0 });

export interface ListRow { value: string; detail: string }
export interface CompletionList {
  // The rows in view, at most `LIST_ROWS`, scrolled around the selection.
  rows: ListRow[];
  // The selected row's place among `rows`.
  at: number;
  // Every candidate, and the selected one's number among them (from 1).
  total: number;
  number: number;
  // The selected candidate, and the rest of it after what is typed ('' when it does not
  // continue the typed word).
  selected: string;
  ghost: string;
  // What the selected candidate's label says, drawn beside the inline rest ('' when none).
  label: string;
  // The lines the list takes — the rows, the count line when there are more candidates
  // than rows, and blank lines up to the height it has had while open.
  height: number;
  // `3/41` when more candidates exist than rows are shown.
  count: string;
}

// The list for `input`, or null when none is open: fewer than two candidates, a line
// the completion does not end, or one closed by Esc. Reading it syncs `state` to the
// line — a changed line forgets the selection and the Esc — and keeps `height`, so it
// is safe to call from both the drawing and the keys.
export function openList(input: string, state: ListState, complete: Complete): CompletionList | null {
  if (state.text !== input) { state.text = input; state.sel = -1; state.closed = false; }
  const shut = () => { state.height = 0; return null; };
  if (state.closed || !input.trim()) return shut();
  const comp = complete(input);
  const all = comp.candidates;
  if (all.length < 2 || !input.endsWith(comp.head)) return shut();
  if (state.sel < 0 || state.sel >= all.length) state.sel = Math.max(0, all.indexOf(comp.best));
  const start = Math.max(0, Math.min(all.length - LIST_ROWS, state.sel - Math.floor(LIST_ROWS / 2)));
  const shown = all.slice(start, start + LIST_ROWS);
  const selected = all[state.sel]!;
  const fits = selected.toLowerCase().startsWith(comp.head.toLowerCase());
  const more = all.length > LIST_ROWS;
  state.height = Math.max(state.height, shown.length + (more ? 1 : 0));
  return {
    rows: shown.map((value) => ({ value, detail: comp.details?.[value] ?? comp.labels?.[value] ?? '' })),
    at: state.sel - start,
    total: all.length,
    number: state.sel + 1,
    selected,
    ghost: fits ? selected.slice(comp.head.length) : '',
    label: comp.labels?.[selected] ?? '',
    height: state.height,
    count: more ? `${state.sel + 1}/${all.length}` : '',
  };
}

// What the list does with a key. `handled: false`: no list is open, the key is the
// line's own. `input`: the line after the key, when it changed — Tab and Enter replace
// the word being completed with the selected candidate, as the inline Tab does. Taking
// a candidate the line already holds closes the list instead, so the next Enter is the
// line's own.
export type ListKey = { handled: false } | { handled: true; input?: string };
export function listKey(input: string, state: ListState, key: { name: string; shift?: boolean }, complete: Complete): ListKey {
  const list = openList(input, state, complete);
  if (!list) return { handled: false };
  const step = (by: number): ListKey => { state.sel = (state.sel + by + list.total) % list.total; return { handled: true }; };
  switch (key.name) {
    case 'down': return step(1);
    case 'up': return step(-1);
    case 'tab': return key.shift ? step(-1) : take(input, state, list, complete);
    case 'return': return take(input, state, list, complete);
    case 'escape': state.closed = true; return { handled: true };
    default: return { handled: false };
  }
}

function take(input: string, state: ListState, list: CompletionList, complete: Complete): ListKey {
  const comp = complete(input);
  const next = stemOf(input, comp.head) + list.selected;
  if (next === input) state.closed = true;
  return { handled: true, ...(next !== input ? { input: next } : {}) };
}

// The line as drawn: the list's selection as the inline rest, or the inline view alone
// while no list is open.
export function lineViewWithList(input: string, walk: TabWalk | null, state: ListState, complete: Complete): { view: LineView; list: CompletionList | null } {
  const list = openList(input, state, complete);
  return list ? { view: { ghost: list.ghost, label: list.label, others: [] }, list } : { view: lineView(input, walk, complete), list: null };
}
