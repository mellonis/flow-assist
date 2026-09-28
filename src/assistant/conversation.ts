// A conversation: the model's history and the list the person reads, what runs and what
// waits, the session it is saved as. The chat draws one and drives it (AGENTS.md, "The chat").
import type { ChatMessage, TokenUsage } from './agent.js';
import type { AskState } from './ask.js';
import type { AutoMode } from './auto.js';
import type { ImageRef } from './images.js';
import type { JournalEvent } from './journal.js';
import { createPlan, type Plan } from './plan.js';
import type { ProjectInstructions } from './project-instructions.js';
import { createRecallState, type BulkyItem, type RecallState } from './recall.js';
import type { Session, SessionFingerprint } from './sessions.js';
import { createShellState, type ShellState } from './shell.js';
import { createToolSet, type ToolSet } from './tool-loading.js';
import type { ViewRecord } from './views.js';
import type { ChatMirror, ChatMsg, ConversationDeps, ConversationEvent, ConversationKind, Queued, ViewPort } from './conversation-types.js';
import {
  applySession, currentProject, ensureSessionId, journal, journaledChatLLM, journalTo, markSeen, persist, pushNote,
  releaseLockOf, writeSession, NO_FILE,
} from './conversation-session.js';

export { NO_FILE };
// Live views are coalesced: the latest record per view waits at most this long.
export const LIVE_REDRAW_MS = 200;

// What an image stands for, as its data is cached: its path and its hash.
export const imageKey = (r: ImageRef) => `${r.path}\0${r.sha256}`;

// A mirror for a conversation no chat draws (a test): it keeps the list and nothing else.
export function headlessMirror(): ChatMirror {
  let list: ChatMsg[] = [];
  const none = () => {};
  return {
    drawn: () => list, setDrawn: (l) => { list = l; },
    setMessages: (next) => { list = typeof next === 'function' ? next(list) : next; },
    setStreaming: none, setToolLabel: none, setPhase: none, setVerb: none, setToolCount: none, setTurnTokens: none,
    setEmptyAnswer: none, setContinueOffer: none, setQueued: none, setAutoMode: none,
    setPendingConfirm: none, setPendingQuestion: none, setElapsed: none,
  };
}

let keys = 0;

export class Conversation {
  readonly key = `c${++keys}`;
  readonly kind: ConversationKind = 'session';
  readonly deps: ConversationDeps;

  // ── the model's side
  // The plan is this conversation's: handed to the `todo` tool through the tool context,
  // emptied by /clear — never module state, which would outlive the conversation it
  // describes.
  plan: Plan = createPlan();
  onShellSet: () => void = () => {};
  // Where this conversation's shell commands run — `!command` and the model's
  // run_command share it; `cd` moves it. The conversation's, like the plan: a background
  // run gets its own, /clear resets it.
  shell: ShellState;
  // The AGENTS.md files for the shell's directory (src/assistant/project-
  // instructions.ts): read when the directory is set, put in the system prompt of every
  // request as "## Project instructions". `projectNote`: a note waiting for the turn to
  // end, when the directory moved in the middle of one (the `cd` tool): a note between a
  // turn's rounds would split its message in two.
  project: ProjectInstructions = { dir: '', root: null, files: [] };
  projectNote: string | null = null;
  // The tools the model has loaded (tools on demand, src/assistant/tool-loading.ts).
  // The conversation's, like the plan: its history calls them, so it is saved with the
  // session, kept through /compact, emptied by /clear.
  toolSet: ToolSet = createToolSet();
  // What the provider reported for the last turn: its prompt plus the answer it
  // produced is, to a close approximation, the size of the NEXT request.
  usage: TokenUsage | null = null;
  // Which bulky items go to the model as stubs (src/assistant/recall.ts) — the
  // conversation's, like the plan: decided in batches at the end of a turn, saved with
  // the session, reset by /clear. `recalled` is this turn's, for /context.
  recall: RecallState = createRecallState();
  itemsCache = new WeakMap<ChatMessage[], BulkyItem[]>();
  // The MODEL's history, kept apart from the display list the chat draws. That list
  // holds what the person reads (final text + parts/live); this holds what was actually
  // exchanged — tool calls and tool results included — and is what every turn replays.
  // See `apiHistory` for why the display list must never stand in for it.
  api: ChatMessage[] = [];
  // `/compact`'s summary. It rides in the system context of every later turn; a
  // display-only `system` message would be dropped by `send` and lost.
  summary = '';
  prompts: string[] = [];
  autoMode: AutoMode = 'ask';
  // Images (src/assistant/images.ts): what each `[Image #N]` of this conversation stands
  // for, and the last N given out. The conversation's, like the plan: saved with the
  // session, emptied by /clear. The TEXT decides what a message sends — the tokens in it
  // this map knows — so the field, a queued message, ↑/↓ and the draft need nothing
  // beside their text.
  images = new Map<number, ImageRef>();
  imageSeq = 0;
  // The `data:` URL of an image, once read and found unchanged — built on the way to
  // the provider, never kept in a message or written to disk. Keyed by path + hash.
  imageData = new Map<string, string>();
  // Images already said to be gone, so the note is not repeated with every message;
  // and whether the provider's refusal of an image has been explained.
  imageNoted = new Set<string>();
  imageRefusalSaid = false;

  // ── the running thing
  busy = false;
  inTurn = false;
  // Which turn a view belongs to — groups never span two. Never reset: it belongs to
  // the conversation's whole history.
  turn = 0;
  // Bumped at every reset (/clear, /resume — the same places `liveSeen` / `liveBuf` are
  // cleared), never at anything else. `send()` and the `!command` runner each capture it
  // when they START; every callback of theirs that could still fire after a LATER reset
  // (a tool's final phase, a change report) compares its own captured value against the
  // CURRENT one and drops the update if they differ — the turn it was for no longer
  // exists, in either the display or `api`, and writing into the fresh one would be
  // exactly the "a stopped command from before /clear reappears in the cleared chat" bug
  // this guards.
  epoch = 0;
  abort: AbortController | null = null;
  // Which key stopped the running turn or `!command`: '' for Esc (and for a reset that
  // aborts it), the cap otherwise (`^c`) — the quiet line under the answer and a
  // command's outcome say `stopped (^c)`. Cleared when one starts.
  stopKey = '';
  toolLabel = '';
  verb = '';
  turnStartedAt = 0;
  segmentStartedAt = 0;
  turnTokens = 0;
  // The turn's sum of `cachedTokens` alone, across every round — kept on the answer's
  // message as `cached` (never drawn on the status line: it is the session's record of
  // the turn's cache hits, not a live figure). A round that reported nothing adds nothing.
  turnCached = 0;
  content = '';
  continueOffer = false;
  roundTools = false;
  liveBuf = new Map<string, ViewRecord>();
  liveSeen = new Set<string>();
  liveTimer: ReturnType<typeof setTimeout> | null = null;
  confirm: { name: string; args: string; input?: string; resolve: (ok: boolean, by?: 'person' | 'stop' | 'reset') => void } | null = null;   // a write's y/n, or the settings guard's (`name: 'config'`)
  question: { state: AskState; resolve: (done: AskState) => void } | null = null;

  // ── what waits
  queue: Queued[] = [];
  inbox: string[] = [];
  inboxTimer: ReturnType<typeof setInterval> | null = null;
  // Takes the inbox when nothing holds it (the chat's render assigns it).
  takeInbox: (mode?: 'turn' | 'rows') => void = () => {};
  // A plugin's notes said while a turn runs, for under its answer.
  laterNotes: string[] = [];
  // The settings-file guard's run in progress: one at a time.
  configAsk: Promise<void> | null = null;
  // The missing memory record was said (once while it is missing).
  memoryMissingSaid = false;

  // ── the session
  sessionId = '';
  createdAt = '';
  // The session's title: fixed at its first save from the first line the person wrote
  // (`sessionTitle`), so it never drifts as the oldest messages are trimmed; `/title`
  // sets it. '' — not decided yet.
  title = '';
  sessionProject: string | null = null;
  homes = new Map<string, string>();
  // When the session's last turn ended with an answer, and when the chat last showed the
  // session's end — the picker's `done` is an answer after that (sessions.ts,
  // `unseenAnswer`). '' — never.
  answeredAt = '';
  seenAt = '';
  saveTimer: ReturnType<typeof setTimeout> | null = null;
  // The fingerprint (rev + mtimeMs + size) last read or written for the session this
  // conversation holds — what a save compares the disk against before overwriting it
  // (sessions.ts, "sessionFingerprint").
  fingerprint: SessionFingerprint = NO_FILE;
  journalBuf: JournalEvent[] = [];
  journalImport: Record<string, unknown>[] | null = null;
  // A fork continues the conversation under a new id: whatever was still writing to the
  // session left — a turn in flight, a `!command`, a background task — goes on in the
  // fork's journal, never in the parent's, which someone else is writing now. `/clear`
  // and `/new` are not forks: what ran before them stays in the session it ran in.
  forkedTo = new Map<string, string>();

  constructor(deps: ConversationDeps) {
    this.deps = deps;
    // Where this conversation's shell commands run; setting it reads the project's
    // instructions again (`onShellSet`).
    this.shell = createShellState(() => deps.config(), null, () => this.onShellSet());
  }

  // ── the chat that draws it
  // The chat's React state, written through its setters while the chat draws from its
  // own state; the chat assigns it on every render.
  mirror: ChatMirror = headlessMirror();
  port: ViewPort | null = null;
  private handlers = new Map<string, Set<(ev: ConversationEvent) => void>>();

  on<T extends ConversationEvent['type']>(type: T, fn: (ev: Extract<ConversationEvent, { type: T }>) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    const f = fn as (ev: ConversationEvent) => void;
    set.add(f);
    return () => { set!.delete(f); };
  }
  emit(ev: ConversationEvent): void {
    for (const fn of [...(this.handlers.get(ev.type) ?? [])]) fn(ev);
  }
  // Records the port; the end is seen when the port shows it.
  attach(port: ViewPort): void { this.port = port; this.markSeen(); }
  detach(port: ViewPort): void { if (this.port === port) this.port = null; }
  get attached(): boolean { return this.port !== null; }
  // The attached port's `showsEnd()`; false with none.
  shows(): boolean { return this.port?.showsEnd() ?? false; }
  // The list as the model's own reads see it: as last drawn.
  rows(): ChatMsg[] { return this.mirror.drawn(); }

  // ── the session (src/assistant/conversation-session.ts)
  ensureSessionId(): string { return ensureSessionId(this); }
  journal(ev: JournalEvent, opts?: { person?: boolean }): string { return journal(this, ev, opts); }
  journalTo(from: string, ev: JournalEvent): void { journalTo(this, from, ev); }
  journaledChatLLM(from: string) { return journaledChatLLM(this, from); }
  pushNote(content: string): void { pushNote(this, content); }
  save(opts?: { silent?: boolean }): void { writeSession(this, opts); }
  persist(): void { persist(this); }
  markSeen(): void { markSeen(this); }
  releaseLock(): void { releaseLockOf(this); }
  currentProject(): string | null { return currentProject(this); }
  applySession(s: Session, fingerprint: SessionFingerprint, dir: string): void { applySession(this, s, fingerprint, dir); }

  setAutoMode(mode: AutoMode): void { this.autoMode = mode; this.mirror.setAutoMode(mode); }
  // /clear and /resume both call this: the calls `liveSeen` / `liveBuf` tracked belong
  // to the conversation being left, and the pending coalesce timer (if any) is for a view
  // that conversation drew — cancelled, not left to fire into whatever replaces it. The
  // epoch bump is what actually stops anything already in flight for the old
  // conversation (a tool's own final phase, `!command`'s own completion) from landing in
  // the new one; it is the one thing here that is never reset itself.
  resetLiveViews(): void {
    this.liveSeen.clear();
    this.liveBuf.clear();
    if (this.liveTimer) { clearTimeout(this.liveTimer); this.liveTimer = null; }
    this.epoch += 1;
  }
  resetImages(refs: ImageRef[] = [], seq = 0): void {
    this.images = new Map(refs.map((r) => [r.n, r]));
    this.imageSeq = Math.max(seq, 0, ...refs.map((r) => r.n));
    this.imageData = new Map();
    this.imageNoted = new Set();
    this.imageRefusalSaid = false;
  }
}
