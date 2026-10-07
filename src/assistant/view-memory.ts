// What the chat remembers of a conversation's view while the conversation is left
// loaded and taken back (AGENTS.md (a host makes its conversations through one
// registry)): the folds and the notes mode. Pure: the chat owns
// the map, keyed by the conversation object, so an entry is never read for another
// one and goes with the object.
import type { FoldState } from './folds.js';
import type { NotesMode } from './step.js';

export interface ViewMemory {
  folds: FoldState;
  notes: NotesMode;
}

// An entry that shares nothing with the live state: the exception set is copied, so a
// click made in another conversation never reaches it.
export function rememberView(folds: FoldState, notes: NotesMode): ViewMemory {
  return { folds: { open: folds.open, except: new Set(folds.except) }, notes };
}

// The folds of an entry, as a state the chat may own and change.
export function recalledFolds(m: ViewMemory): FoldState {
  return { open: m.folds.open, except: new Set(m.folds.except) };
}
