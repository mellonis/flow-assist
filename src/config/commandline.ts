// The command line's completion, as the chat's field does it: INLINE. The part of the
// suggestion not typed yet is drawn right after the caret, the other candidates follow
// on the same row, and Tab takes the offer and then walks the rest.
//
// It used to be a second row of candidates under the line, appearing and vanishing
// with every keystroke — the whole screen jumped by a row each time.
//
// Pure: what to draw and what Tab does are computed from the text, so both are tested
// without a terminal.
import type { CompleteResult } from './commands.js';

// A Tab walk in progress: `stem` is the text before the word being completed, `head`
// what the person had typed of that word, `shown` the line as Tab left it. The walk
// is over as soon as the line is anything else.
export interface TabWalk { stem: string; head: string; idx: number; shown: string }

export interface LineView {
  // The untyped rest of the suggestion, drawn after the caret. '' when there is
  // nothing to offer, or while walking (the line already holds a whole candidate).
  ghost: string;
  // The other candidates, named beside it.
  others: string[];
}

type Complete = (text: string) => CompleteResult;

// `head` is the prefix of the word being completed and `best` its replacement, so the
// text before that word is the input minus `head`.
const stemOf = (input: string, head: string) => input.slice(0, input.length - head.length);

const walking = (input: string, walk: TabWalk | null): walk is TabWalk => !!walk && walk.shown === input;

export function lineView(input: string, walk: TabWalk | null, complete: Complete): LineView {
  if (!input.trim()) return { ghost: '', others: [] };
  if (walking(input, walk)) {
    // The candidates of the walk, taken from where it STARTED — from the line as it
    // stands they would narrow to the one Tab just picked.
    const all = complete(walk.stem + walk.head).candidates;
    return { ghost: '', others: all.filter((_, i) => i !== walk.idx % all.length) };
  }
  const comp = complete(input);
  const fits = comp.best && comp.best.toLowerCase().startsWith(comp.head.toLowerCase()) && input.endsWith(comp.head);
  const ghost = fits ? comp.best.slice(comp.head.length) : '';
  return { ghost, others: comp.candidates.filter((c) => c !== comp.best) };
}

export function lineTab(input: string, walk: TabWalk | null, complete: Complete): { input: string; walk: TabWalk | null } {
  if (!input.trim()) return { input, walk: null };
  if (walking(input, walk)) {
    const all = complete(walk.stem + walk.head).candidates;
    if (!all.length) return { input, walk: null };
    const idx = (walk.idx + 1) % all.length;
    const shown = walk.stem + all[idx]!;
    return { input: shown, walk: { ...walk, idx, shown } };
  }
  const comp = complete(input);
  if (!comp.best || !input.endsWith(comp.head)) return { input, walk: null };
  // Replace the WORD being completed — not everything before the first space, which
  // is what turned `config ge` + Tab into `get ge`.
  const stem = stemOf(input, comp.head);
  const shown = stem + comp.best;
  return { input: shown, walk: { stem, head: comp.head, idx: Math.max(0, comp.candidates.indexOf(comp.best)), shown } };
}
