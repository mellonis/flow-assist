// What the chat remembers of a conversation's view while the conversation is left
// loaded and taken back (AGENTS.md (The chat draws a `Conversation`'s snapshot)): the
// folds, the notes mode, the place in the list and the caret. Pure: the chat owns the
// map, keyed by the conversation object, so an entry is never read for another one and
// goes with the object.
import type { FoldState } from './folds.js';
import type { NotesMode } from './step.js';

export interface ViewMemory {
  folds: FoldState;
  notes: NotesMode;
  // Where the list was left: null while it rested at its end (and follows it), else the
  // row at its top, said as a message and the offset into it (`rowAnchor`), so it
  // survives rows arriving meanwhile and the folds laid out again.
  place: { at: number; within: number } | null;
  // The caret in the draft, with the draft text it belongs to: the draft may have grown
  // while the conversation was away (a stopped or failed turn puts its queue ahead of
  // it), and then the caret is not where it was.
  caret: { text: string; at: number } | null;
}

// An entry that shares nothing with the live state: the exception set is copied, so a
// click made in another conversation never reaches it.
export function rememberView(folds: FoldState, notes: NotesMode, place: ViewMemory['place'], caret: ViewMemory['caret']): ViewMemory {
  return { folds: { open: folds.open, except: new Set(folds.except) }, notes, place, caret };
}

// The folds of an entry, as a state the chat may own and change.
export function recalledFolds(m: ViewMemory): FoldState {
  return { open: m.folds.open, except: new Set(m.folds.except) };
}
