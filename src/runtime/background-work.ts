// Whose work the running code is, carried through every await of it — a plugin's
// tool the work calls included, which has no ctx of the chat's to tell it. Two things
// are carried, each on its own:
// - the background mark: a background task's run (its `task` conversation's turn,
//   `Conversation.startChild`). What only the chat's own turn may do (open a screen,
//   src/runtime/screens.ts) asks `inBackgroundWork()`;
// - the owner: the conversation whose turn it is, set by every turn for itself. A turn
//   may be started from another's context (a queued task from the run that freed its
//   slot, a follow-up turn from the task whose result it reads), so none reads the owner
//   it was called in. What belongs to a session rather than to the screen (a screen it
//   opens, a message a plugin posts) asks `workOwner()`.
// Both outlive the turn in whatever it left running (a timer a plugin's tool started).
// The owner ends where a conversation hands control to the host (`outsideWork`): what
// the app draws while a turn streams, and what a component starts from there, is
// nobody's work.
import { AsyncLocalStorage } from 'node:async_hooks';

const work = new AsyncLocalStorage<boolean>();

// Runs `fn` as background work: everything it awaits reads `inBackgroundWork()` as true.
export const asBackgroundWork = <T>(fn: () => T): T => work.run(true, fn);
// Runs `fn` outside the mark, whatever started it: a session's own turn is the chat's,
// though a task's result started it.
export const asForegroundWork = <T>(fn: () => T): T => work.run(false, fn);
export const inBackgroundWork = (): boolean => work.getStore() === true;

// A conversation, as this layer reads one: whether a view draws it at the moment it is asked, and its kind
// (`session`, `task`, `oneshot`).
export interface WorkOwner { readonly attached: boolean; readonly kind: string }

const owner = new AsyncLocalStorage<WorkOwner>();

// Runs `fn` as `o`'s work: everything it awaits reads `workOwner()` as `o`.
export const asConversationWork = <T>(o: WorkOwner, fn: () => T): T => owner.run(o, fn);
export const workOwner = (): WorkOwner | undefined => owner.getStore();
// Runs `fn` as nobody's work: where a conversation hands control to the host — a redraw,
// its listeners — what the host does next, and whatever that starts (a render, an
// effect, a timer of a plugin's component), is not the turn's. The background mark
// stays: a follow-up turn a task's result starts reads it until its own `send`.
export const outsideWork = <T>(fn: () => T): T => owner.exit(fn);
// A session's work while no view draws it — the person is in another one. Asked at the
// call, not at the turn's start: a turn may be left, or taken back, midway.
export const inUnattachedWork = (): boolean => { const o = owner.getStore(); return !!o && o.kind === 'session' && !o.attached; };
