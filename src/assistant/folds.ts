// What is open in the chat, and what is folded.
//
// Everything foldable used to answer to one flag: `^r` opened the reasoning, the
// narration, every tool call of every turn and every capped command block at once, and
// to read the output of ONE command a person unfolded the whole conversation and folded
// it back. A click opens the block under it instead — so the state has to say more than
// "open" or "closed", and it has to say it in a way a key and a click cannot disagree
// about.
//
// One GLOBAL state — everything folded (where a conversation starts) or everything open
// — plus the blocks a click has made an exception of:
//
//   - a click toggles THAT block and nothing else, so opening one command's output
//     never turns into a sticky "expand mode" that brings the verbosity back;
//   - the key is the master switch and CLEARS the exceptions: with anything folded it
//     opens everything, pressed again it closes everything. After it the screen is
//     uniformly one or the other, so there is always a way back to a known state;
//   - a block that did not exist yet follows the global state: with everything open,
//     the next turn's tool calls and command output arrive open.
//
// Pure: no React, no clock. The chat owns the state and resets it with `/clear`, as it
// resets the auto mode and the narration mode.

export interface FoldState {
  // Everything is open unless a click said otherwise (and the other way round).
  open: boolean;
  // The blocks a click has turned away from the global state, by their ids.
  except: ReadonlySet<string>;
}

// Where a conversation starts, and where `/clear` puts it back.
export function allFolded(): FoldState {
  return { open: false, except: new Set() };
}

// Is this block open? A block nobody has clicked follows the global state.
export function isOpen(state: FoldState, id: string): boolean {
  return state.except.has(id) ? !state.open : state.open;
}

// A click on one block: it alone changes, whatever the rest of the screen is doing.
export function toggleFold(state: FoldState, id: string): FoldState {
  const except = new Set(state.except);
  if (!except.delete(id)) except.add(id);
  return { open: state.open, except };
}

// The key: anything folded → open everything; nothing folded → close everything. The
// exceptions go either way, which is what makes the result a state a person can see
// the whole of.
export function flipFolds(state: FoldState): FoldState {
  return { open: !state.open || state.except.size > 0, except: new Set() };
}

// A block that does NOT follow the global state: it stays folded until a click opens
// it, and the key that clears the exceptions puts it back. Exactly one block is like
// this — the earlier calls of an open tool trail. The trail is capped because sixty
// dim lines are a sheet of grey with the end of the turn lost in the middle of it, and
// a key meaning "open everything" is asking for the trail, not for all sixty rows of
// it. Whoever wants them clicks the line that stands for them.
export function isClicked(state: FoldState, id: string): boolean {
  return state.except.has(id);
}

// A block the person OPENED with a click — not merely one that is open because
// everything is. A group that forms around it must not fold it away.
export function clickedOpen(state: FoldState, id: string): boolean {
  return state.except.has(id) && isOpen(state, id);
}

// The blocks a message can have. `notes` is what it said on the way (its thinking and
// its narration), `tools` the trail of calls behind the one-line summary, `calls` the
// earlier calls an open trail caps away, `view` a command's output capped to its last
// lines, `group` the head consecutive commands fold under (src/assistant/view-groups.ts).
export type FoldKind = 'notes' | 'tools' | 'calls' | 'view' | 'group';

// A block's id. It names the message by its place in the conversation rather than by
// its object: the chat REPLACES a message whenever it changes (that is what makes the
// row cache correct), so an id tied to the object would be lost with every token that
// arrives. The place is counted over the messages that are DRAWN — the system prompt is
// not one of them, and it is unshifted onto the list again with every question, which
// would otherwise move every id by one.
export function foldId(index: number, kind: FoldKind, n = 0): string {
  return kind === 'view' ? `${index}:view:${n}` : `${index}:${kind}`;
}
