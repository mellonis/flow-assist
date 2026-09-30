// A conversation: the model's history and the list the person reads, what runs and what
// waits, the session it is saved as. The chat draws one and drives it (AGENTS.md, "The chat").
import { apiHistory, requestTools, type ChatMessage, type TokenUsage } from './agent.js';
import { askStart, type AskQuestion, type AskState } from './ask.js';
import type { AutoMode } from './auto.js';
import type { ConfirmPolicy } from './confirm-policy.js';
import { DEFAULT_CONTEXT_WINDOW, readContext, type ContextReading } from './context-meter.js';
import { dataUrl, imageLimits, imagesInText, readImageData, type ImageRef, type LoadedOk, type ResolvedImage } from './images.js';
import type { JournalEvent } from './journal.js';
import { keptAfterClear, type MemoryLists } from './memory-command.js';
import { readFacts } from './memory-store.js';
import { markFacts, memoryRecordNotes } from './memory-trust.js';
import { createPlan, type Plan } from './plan.js';
import { findInstructions, instructionsNote, type ProjectInstructions } from './project-instructions.js';
import { applyRecall, bulkyItems, createRecallState, recallLimits, type BulkyItem, type RecallState } from './recall.js';
import { screenBlock, type ContextItem } from './screen-context.js';
import { redactSecrets } from './secrets.js';
import { unseenAnswer, type Session, type SessionFingerprint } from './sessions.js';
import { createShellState, tildePath, type ShellState } from './shell.js';
import { baseStatic, memoryBlock, planBlock, projectBlock, summaryBlock } from './system-prompt.js';
import { createToolSet, toolLoadingMode, type ToolSet } from './tool-loading.js';
import { pickVerb, verbList } from './verbs.js';
import type { ViewRecord } from './views.js';
import type { ToolDef } from '../loader/tools.js';
import { workspaceFor } from './workspace.js';
import { asBackgroundWork } from '../runtime/background-work.js';
import { callOf, lastAnswerOf, type BusyKind, type ChatMsg, type ChildResult, type ChildSpec, type ChildStart, type CloseReason, type ConversationDeps, type ConversationEvent, type ConversationKind, type ConversationSnapshot, type ConversationStatus, type PendingConfirm, type Queued, type QueueWait, type SendOptions, type TurnEnd, type ViewPort } from './conversation-types.js';
import {
  applySession, currentProject, ensureSessionId, journal, journaledChatLLM, journalTo, markSeen, persist, pushNote,
  releaseLockOf, writeSession, NO_FILE,
} from './conversation-session.js';
import { askConfigChanges, compact, runTurn } from './conversation-turn.js';
import { runShell } from './conversation-shell.js';

export { NO_FILE };
// Live views, coalesced: the latest record per view waits at most
// LIVE_REDRAW_MS, so a command printing thousands of lines a second costs a few
// redraws, not thousands. A view's first state and its final phase are placed at
// once — the block must appear when the call starts, and its end must not wait.
export const LIVE_REDRAW_MS = 200;

// What an image stands for, as its data is cached: its path and its hash.
export const imageKey = (r: ImageRef) => `${r.path}\0${r.sha256}`;

// The fields a chat draws, each written through `draw`.
type Drawn = 'busyDrawn' | 'toolLabel' | 'phase' | 'verb' | 'toolCount' | 'turnTokens' | 'emptyAnswer'
  | 'continueOffer' | 'queuedDrawn' | 'autoMode' | 'confirmDrawn' | 'questionDrawn';

let keys = 0;

export class Conversation {
  readonly key = `c${++keys}`;
  readonly kind: ConversationKind;
  // A `task`'s label, which tags its journal lines in the conversation that started it.
  label = '';
  // The tree: the conversation that started this one (null for a session) and how deep
  // it is (a session 0, its task 1, …).
  parent: Conversation | null = null;
  depth = 0;
  // A child's journal lines go through this to its parent's (a task keeps no journal of
  // its own); null for a conversation that journals itself.
  journalRoute: ((ev: JournalEvent) => void) | null = null;
  // A child's project is its parent's, whatever directory its shell moves to; undefined:
  // decided as a session decides it.
  inheritedProject: string | null | undefined = undefined;
  readonly deps: ConversationDeps;
  // Who answers a write's y/n in this conversation (src/assistant/confirm-policy.ts):
  // `ask` for the chat's; decided when it is made, never changed.
  readonly policy: ConfirmPolicy;

  // ── the model's side
  // The plan is this conversation's: handed to the `todo` tool through the tool context,
  // emptied by /clear — never module state, which would outlive the conversation it
  // describes.
  plan: Plan = createPlan();
  // Setting the shell's directory reads the project's instructions again.
  onShellSet: () => void = () => this.refreshProject();
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
  // What runs while `busy`: a turn, a `!command`, a `!!command`, a slash command.
  busyKind: BusyKind = 'turn';
  // How the last piece of work ended; null before the first.
  lastEnd: TurnEnd | null = null;
  inTurn = false;
  // Which turn a view belongs to — groups never span two. Never reset: it belongs to
  // the chat's whole history, and a conversation that replaces another in the chat
  // counts on from it.
  turn = 0;
  abort: AbortController | null = null;
  // Which key stopped the running turn or `!command`: '' for Esc (and for a reset that
  // aborts it), the cap otherwise (`^c`) — the quiet line under the answer and a
  // command's outcome say `stopped (^c)`. Cleared when one starts.
  stopKey = '';
  toolLabel = '';
  // What the model is doing when no tool runs: 'writing' only while its text
  // arrives; before the first token, while it reasons, and between tools (it is
  // working out the next call) it is 'thinking'.
  phase: 'thinking' | 'writing' = 'thinking';
  verb = '';
  // Tool calls in this turn (for the status line).
  toolCount = 0;
  turnStartedAt = 0;
  segmentStartedAt = 0;
  turnTokens = 0;
  // The turn's sum of `cachedTokens` alone, across every round — kept on the answer's
  // message as `cached` (never drawn on the status line: it is the session's record of
  // the turn's cache hits, not a live figure). A round that reported nothing adds nothing.
  turnCached = 0;
  content = '';
  // The last turn ended with reasoning and no final text.
  emptyAnswer = false;
  continueOffer = false;
  // Whether the round being streamed carries a tool call — heard the moment its first
  // fragment arrives (`onRoundKind`), and from then on its text is a step, not the answer.
  // Never read inside a `setRows` updater: every updater is a pure function of the list;
  // what it needs to know is read when the callback fires, and handed to it.
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
  // A plugin's news said while a turn runs waits for the turn's end (`note` on the
  // store, bound to `services.chatNote` by the App).
  laterNotes: string[] = [];
  // The settings-file guard's run in progress: one at a time.
  configAsk: Promise<void> | null = null;
  // The missing memory record was said (once while it is missing) — once for every
  // conversation of the host that made it, through `deps.said`.
  private ownSaid = { memoryMissing: false };
  get memoryMissingSaid(): boolean { return (this.deps.said ?? this.ownSaid).memoryMissing; }
  set memoryMissingSaid(v: boolean) { (this.deps.said ?? this.ownSaid).memoryMissing = v; }

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

  // The chat has left this conversation for good (`close`): a turn or a `!command` still
  // running from it writes into it alone, and it draws nothing more.
  private isClosed = false;
  get closed(): boolean { return this.isClosed; }

  // `carry` — what a conversation that replaces another in the chat takes over from it:
  // the ↑/↓ history (the same array), the turn counter, the last verb, the list as the
  // chat last drew it (until the chat draws this one). `policy` — who answers a write's
  // y/n, `ask` unless said. `kind` — `session` unless said.
  constructor(deps: ConversationDeps, carry: { prompts?: string[]; turn?: number; verb?: string; drawnRows?: ChatMsg[] | null; policy?: ConfirmPolicy; kind?: ConversationKind } = {}) {
    this.deps = deps;
    this.policy = carry.policy ?? { kind: 'ask' };
    this.kind = carry.kind ?? 'session';
    // Cannot ask ⇒ declines, by construction: a run with nobody to answer is never handed
    // a y/n that nobody will ever settle.
    if (this.policy.kind === 'ask' && deps.canAsk === false) {
      throw new Error('a conversation with nobody to ask cannot have the policy "ask" — give it "none"');
    }
    this.shell = createShellState(() => deps.config(), null, () => this.onShellSet());
    if (carry.prompts) this.prompts = carry.prompts;
    if (carry.turn) this.turn = carry.turn;
    if (carry.verb) this.verb = carry.verb;
    if (carry.drawnRows !== undefined) this.drawnRows = carry.drawnRows;
  }

  // A new conversation as a driver starts one: its kind and policy said, and — as the
  // chat does when it mounts — the project's instructions read for the shell's start
  // directory, since making a shell does not read them.
  static fresh(deps: ConversationDeps, init: { kind: ConversationKind; policy: ConfirmPolicy }): Conversation {
    const c = new Conversation(deps, init);
    c.refreshProject();
    return c;
  }

  // A saved session opened into a conversation of its own. The caller took `fingerprint`
  // before it read `session`, and holds the session's lock (`applySession`'s order); the
  // shell's saved directory reads the project's instructions again.
  static restore(deps: ConversationDeps, session: Session, fingerprint: SessionFingerprint, dir: string, init: { policy: ConfirmPolicy } = { policy: { kind: 'ask' } }): Conversation {
    const c = new Conversation(deps, { kind: 'session', policy: init.policy });
    c.applySession(session, fingerprint, dir);
    return c;
  }

  // ── what the chat draws (`getSnapshot`)
  messages: ChatMsg[] = [];
  // The list as the chat last drew it; null: no chat reports one.
  drawnRows: ChatMsg[] | null = null;
  busyDrawn = false;
  confirmDrawn: PendingConfirm | null = null;
  questionDrawn: AskState | null = null;
  queuedDrawn: Queued[] = [];
  private version = 0;
  private snap: ConversationSnapshot | null = null;
  private listeners = new Set<() => void>();
  private tellSoon = false;
  // Which deferred telling is the armed one: a telling at once disarms the one waiting.
  private tellGen = 0;

  // For `useSyncExternalStore`. Fields, not methods: the chat hands React the same two
  // functions on every render, so React does not subscribe again.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = (): ConversationSnapshot => {
    if (this.snap?.version !== this.version) {
      this.snap = {
        version: this.version, key: this.key, kind: this.kind,
        messages: this.messages,
        // The kind is read live, not drawn: a chat that draws it must write it through `draw`.
        busy: this.busyDrawn ? this.busyKind : null,
        activity: { label: this.toolLabel, phase: this.phase, verb: this.verb, toolCount: this.toolCount, turnTokens: this.turnTokens },
        pendingConfirm: this.confirmDrawn, pendingQuestion: this.questionDrawn,
        queued: this.queuedDrawn, autoMode: this.autoMode,
        continueOffer: this.continueOffer, emptyAnswer: this.emptyAnswer,
      };
    }
    return this.snap;
  };
  // A change the chat draws. The snapshot moves at once; when the subscribers hear of it
  // depends on when it happens. The chat's React root is concurrent, and React renders a
  // store's change as urgent work, before the next await resumes — where a state change
  // made outside a key handler waits for the scheduler's next task, run from
  // `setImmediate`, together with every other change made meanwhile. So:
  // - Outside a turn, and for what the person must see as it happens (the busy mark, the
  //   y/n, the question, the queue, the auto mode), the subscribers are told at once;
  //   whatever still waits to be told goes with it.
  // - While a turn runs, they are told once per macrotask: a stream's deltas draw once
  //   per network read, not once per delta. The telling waits two `setImmediate` steps,
  //   behind any task React's scheduler queued in the same turn of the event loop (the
  //   chat's ticker, the App's notify): that task's render reads this snapshot, and the
  //   telling then finds nothing new to draw — told first, the two would draw twice.
  // A write that changes nothing tells nobody, as React skips a state set to the value
  // it holds.
  private changed(now = false): void {
    this.version += 1;
    if (now || !this.inTurn) { this.tell(); return; }
    if (this.tellSoon) return;
    this.tellSoon = true;
    const g = ++this.tellGen;
    setImmediate(() => setImmediate(() => { if (this.tellSoon && g === this.tellGen) this.tell(); }));
  }
  private tell(): void {
    this.tellSoon = false;
    for (const listener of [...this.listeners]) listener();
  }
  private draw<K extends Drawn>(key: K, value: Conversation[K], now = false): void {
    if (Object.is(this[key], value)) return;
    (this as Conversation)[key] = value;
    this.changed(now);
  }
  setRows(next: ChatMsg[] | ((cur: ChatMsg[]) => ChatMsg[])): void {
    const list = typeof next === 'function' ? next(this.messages) : next;
    if (list === this.messages) return;
    this.messages = list;
    this.changed();
  }
  setBusyDrawn(on: boolean): void { this.draw('busyDrawn', on, true); }
  drawConfirm(p: PendingConfirm | null): void { this.draw('confirmDrawn', p, true); }
  drawQuestion(q: AskState | null): void { this.draw('questionDrawn', q, true); }
  get status(): ConversationStatus {
    if (this.confirm || this.question) return 'waiting';
    if (this.busy) return 'working';
    return unseenAnswer(this.messages, this.answeredAt, this.seenAt) ? 'done' : 'idle';
  }

  // ── the chat that draws it
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
  // The list as the model's own reads see it: as the chat last drew it (what a save
  // writes, what the notes' "said once" checks), or the list itself with no chat.
  rows(): ChatMsg[] { return this.drawnRows ?? this.messages; }

  // The last answer in the list (`lastAnswerOf`). '' when no answer has text.
  lastAnswer(): string { return lastAnswerOf(this.messages); }

  // The chat leaves this conversation for good. What runs is stopped for /clear and /new
  // (a pending y/n is declined `by: 'reset'`, a question dismissed); for a switch nothing
  // runs, since the chat refuses one while anything does. Work still in flight afterwards
  // writes its journal lines where it happened and nothing else: the object draws nothing
  // more (no listeners), saves nothing (`persist`, `save`) and holds no timer. The save
  // and the lock's release are the chat's, before it closes.
  close(reason: CloseReason): void {
    if (this.isClosed) return;
    if (reason === 'clear' || reason === 'new') {
      this.abort?.abort();
      this.abort = null;
      if (this.confirm) this.answerConfirm(false, 'reset');
    }
    this.dismissQuestion();
    this.isClosed = true;
    if (this.liveTimer) { clearTimeout(this.liveTimer); this.liveTimer = null; }
    this.liveBuf.clear();
    this.liveSeen.clear();
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.clearInbox();
    this.inbox = [];
    this.queue = [];
    this.projectNote = null; // a note held for a turn's end described the conversation left
    this.emit({ type: 'closed', reason });
    this.handlers.clear();
    this.listeners.clear();
    this.port = null;
  }

  // A fresh conversation's first rows: what the memory keeps across a /clear (said, or
  // the assistant "still knowing" an earlier prompt reads as the reset failing), then —
  // after the list is set, so the note lands in it — the first root's instructions.
  startFresh(): void {
    const l = this.memoryLists();
    const kept = keptAfterClear([...l.project, ...l.global].filter((f) => !f.outside).length);
    if (kept) this.journal({ t: 'row', role: 'note', text: kept });
    this.setRows(kept ? [{ role: 'note', content: kept }] : []);
    // The default directory (the start directory, or the first root when that lies outside
    // every one); the new shell's `told` is empty already.
    this.shell.setCwd(null);
  }

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

  setAutoMode(mode: AutoMode): void { this.draw('autoMode', mode, true); }

  // ── what runs, as the status line draws it
  setToolLabel(v: string): void { this.draw('toolLabel', v); }
  setPhase(p: 'thinking' | 'writing'): void { this.draw('phase', p); }
  // The word the line says for either phase (src/assistant/verbs.ts): one per
  // model request, picked when the request goes out — never in the render, so it
  // cannot change under the person within a round. `verb` is what the next pick
  // avoids repeating.
  nextVerb(): void { this.draw('verb', pickVerb(verbList(this.deps.config() as { ui?: { verbs?: unknown } }), this.verb)); }
  setToolCount(n: number): void { this.draw('toolCount', n); }
  setTurnTokens(n: number): void { this.draw('turnTokens', n); }
  setEmptyAnswer(on: boolean): void { this.draw('emptyAnswer', on); }
  setContinueOffer(on: boolean): void { this.draw('continueOffer', on); }
  // What is on the status line now starts its own clock; the chat's seconds start from 0.
  beginSegment(): void { this.segmentStartedAt = Date.now(); this.emit({ type: 'activity' }); }
  // A tool has ended: its label goes, and the clock on the line is the model's
  // round from here. Only when one was actually running — the callbacks of a turn
  // all report the end of a tool, and the first of them to fire owns it.
  endToolSegment(): void { if (this.toolLabel) { this.setToolLabel(''); this.beginSegment(); } }

  // ── stopping what runs
  // Whether Esc / Ctrl+C have something to stop: a run whose controller has not
  // been aborted yet. A run that goes on after its abort (a tool that ignores its
  // signal) does not hold the keys: Esc goes back to its idle steps and Ctrl+C
  // arms the exit, so the person can always leave.
  canStop(): boolean { return !!this.abort && !this.abort.signal.aborted; }
  // Stops what runs: a pending y/n is declined and a question dismissed first (the turn
  // would wait on them), then the running work is aborted. `glyph` names the key: ''
  // for Esc, the cap for another.
  stop(glyph: string): boolean {
    if (!this.canStop()) return false;
    if (this.confirm) this.answerConfirm(false, 'stop');
    this.dismissQuestion();
    this.stopKey = glyph;
    this.abort?.abort();
    return true;
  }

  // ── children
  // A background task started from the turn journaled as `journalId`: a `task`
  // conversation with its own plan, shell (starting where this one's is), tool set and
  // abort; no screens, no one to ask, no log lines, and no journal or state file of its
  // own — its `call-start`, `confirm` and `call` lines go into this turn's journal,
  // tagged `task: <label>` (a grandchild's own label kept). Refused past
  // `ai.subagentDepth`. Nothing runs until `run()`, which closes the child when it ends;
  // the caller admits and schedules it.
  startChild(spec: ChildSpec, journalId: string): ChildStart {
    const max = Number((this.deps.config().ai as { subagentDepth?: unknown } | undefined)?.subagentDepth ?? 2);
    if (this.depth >= max) return { refused: `Background chaining depth exceeded (max ${max}) — finish this task; do not spawn further background tasks.` };
    const deps: ConversationDeps = {
      ...this.deps,
      sessionsDir: () => null, screens: () => undefined, screen: () => [], canAsk: false,
      notify: () => {}, pushLog: () => {}, current: undefined,
    };
    const child = new Conversation(deps, { kind: 'task', policy: { kind: 'always-no' } });
    child.parent = this;
    child.depth = this.depth + 1;
    child.label = spec.label;
    child.inheritedProject = this.currentProject();
    const kept = new Set(['call-start', 'confirm', 'call']);
    child.journalRoute = (ev) => { if (kept.has(ev.t)) this.journalTo(journalId, { task: spec.label, ...ev }); };
    child.shell.setCwd(this.shell.cwd());
    const run = async (): Promise<ChildResult> => {
      try {
        // An empty task (or a second `run`) starts no turn: a failure, said as one.
        if (!(await asBackgroundWork(() => child.send(spec.prompt)))) return { outcome: 'failed', text: '', error: 'nothing to send' };
        const end = child.lastEnd;
        const outcome = (end?.outcome ?? 'failed') as ChildResult['outcome'];
        return {
          outcome,
          text: child.content.trim(),
          ...(end?.error ? { error: end.error } : {}),
          ...(outcome === 'limit' && end?.limit ? { limit: { rounds: end.limit.rounds, lastStep: end.limit.lastStep } } : {}),
        };
      } finally {
        // Its save and inbox timers go with it.
        child.close('park');
      }
    };
    return { child, run };
  }

  // ── the work (src/assistant/conversation-turn.ts)
  // A turn with the model; false with nothing to send, or with something running.
  send(text: string, opts?: SendOptions): Promise<boolean> { return runTurn(this, text, opts); }
  // `/compact`.
  compact(): void { compact(this); }
  // The person's `!command`, or `!!command` with `interactive` (src/assistant/conversation-shell.ts);
  // the caller has refused a busy conversation and an empty command.
  runShell(cmd: string, interactive = false): Promise<void> { return runShell(this, cmd, interactive); }

  // ── the y/n and the question
  // Resolves the y/n pause: ok=true confirms the writing op (tool runs),
  // ok=false declines it (agentChat returns «declined» as the tool result).
  // `by` — who settled it: the person's key, or a stop or reset that closed it.
  answerConfirm(ok: boolean, by: 'person' | 'stop' | 'reset' = 'person'): void {
    const p = this.confirm;
    if (!p) return;
    this.confirm = null;
    this.drawConfirm(null);
    p.resolve(ok, by);
    this.emit({ type: 'confirm', request: null });
    this.deps.notify();
    // The inbox the y/n held lands now (a turn still running holds it on).
    setTimeout(() => this.takeInbox(), 0);
  }
  // The settings-file guard's y/n (src/assistant/conversation-turn.ts), one run at a time.
  askConfigChanges(): Promise<void> { return askConfigChanges(this); }
  // `ask_user`: the same kind of pause as the y/n, but the person picks among options.
  // The chat steps the state key by key (src/assistant/ask.ts) and hands it back.
  askUser(questions: AskQuestion[]): Promise<AskState> {
    return new Promise<AskState>((resolve) => {
      const state = askStart(questions);
      this.question = { state, resolve };
      this.drawQuestion(state);
      // The chat: a question is answered in the conversation — a pager over it closes.
      this.emit({ type: 'question', state, parked: true });
      this.deps.notify();
    });
  }
  setQuestion(state: AskState): void {
    if (!this.question) return;
    this.question.state = state;
    this.drawQuestion(state);
    this.deps.notify();
  }
  answerQuestion(done: AskState): void {
    const a = this.question;
    if (!a) return;
    this.question = null;
    this.drawQuestion(null);
    a.resolve(done);
    this.emit({ type: 'question', state: null });
    this.deps.notify();
    // The inbox the question held lands now (a turn still running holds it on).
    setTimeout(() => this.takeInbox(), 0);
  }
  // Leaving the chat or resetting it must not leave the tool hanging: an unanswered
  // question is reported to the model as dismissed.
  dismissQuestion(): void { if (this.question) this.answerQuestion({ ...this.question.state, done: true, cancelled: true }); }
  // No live view tracked and no coalesce timer pending — the state a session is opened
  // into (`applySession`).
  resetLiveViews(): void {
    this.liveSeen.clear();
    this.liveBuf.clear();
    if (this.liveTimer) { clearTimeout(this.liveTimer); this.liveTimer = null; }
  }
  resetImages(refs: ImageRef[] = [], seq = 0): void {
    this.images = new Map(refs.map((r) => [r.n, r]));
    this.imageSeq = Math.max(seq, 0, ...refs.map((r) => r.n));
    this.imageData = new Map();
    this.imageNoted = new Set();
    this.imageRefusalSaid = false;
  }

  // ── what waits: the inbox
  // The inbox: what reaches the chat from outside the conversation — a background
  // task's result — and is not the person's. It is a queue of its own, apart from
  // the person's (`queue`): it never enters a running turn and is taken only
  // when one ends (`takeInbox`). A short interval retries while something
  // holds it (a y/n, a question) and clears itself once the inbox is empty.
  // A host-reachable channel to put a message into the chat from OUTSIDE
  // (a `background` task's result; the chat binds `services.postToChat` to it). An
  // item is never dropped while the conversation is open: it waits in the inbox until it
  // can land. A closed conversation takes nothing.
  deliver(text: string): void {
    if (this.closed) return;
    const q = String(text ?? '').trim();
    if (!q) return;
    this.inbox.push(q);
    if (!this.inboxTimer) this.inboxTimer = setInterval(() => this.takeInbox(), 400);
    this.takeInbox();
  }
  clearInbox(): void { if (this.inboxTimer) { clearInterval(this.inboxTimer); this.inboxTimer = null; } }
  // ── Two queues meet at a turn's end: the person's (`queue`, delivered at
  // the next round boundary) and the inbox (`inbox`, never inside a turn).
  // Every item waiting in the inbox lands at once, each as its own row — on
  // screen, in the model's history (role 'bg', its `<label> finished:` line
  // saying what it is), in the journal — and, with the chat closed, in the
  // unread count and one alert. `keepLast` leaves the last item to `send`, which
  // draws it as the follow-up turn's message. Returns what it took.
  landInbox(keepLast = false): string[] {
    const items = this.inbox;
    if (!items.length) return [];
    this.inbox = [];
    this.clearInbox();
    const rows = keepLast ? items.slice(0, -1) : items;
    if (rows.length) {
      for (const q of rows) this.journal({ t: 'row', role: 'bg', text: q });
      this.setRows((cur) => [...cur, ...rows.map((q): ChatMsg => ({ role: 'bg', content: q }))]);
      this.api = [...this.api, ...rows.map((q): ChatMessage => ({ role: 'bg', content: q }))];
      this.persist();
    }
    // The chat: with the chat closed, the unread count grows by every item and one alert
    // names the first (`(+N more)`).
    this.emit({ type: 'inbox', items, shown: this.port?.open() ?? false });
    this.deps.notify();
    return items;
  }
  // A y/n or a question waiting for the person holds the inbox (it lands once
  // answered); so does a running turn, a `!command` or a slash command, and a
  // queued message about to go out, which carries the inbox itself. A draft
  // in the field and a closed chat hold nothing.
  inboxHeld(): boolean { return this.busy || !!this.confirm || !!this.question || this.queue.length > 0; }
  // Takes the inbox when nothing holds it: the items land, and ONE follow-up turn
  // runs for all of them (`ai.backgroundFollowUp`, true unless set false; false
  // keeps the rows, read with the person's next message). `rows` lands what waits
  // and starts no turn for it.
  takeInbox(mode: 'turn' | 'rows' = 'turn'): void {
    if (!this.inbox.length) { this.clearInbox(); return; }
    if (this.inboxHeld()) return;
    const followUp = (this.deps.config().ai as { backgroundFollowUp?: unknown } | undefined)?.backgroundFollowUp !== false;
    if (mode === 'rows' || !followUp) { this.landInbox(); return; }
    const last = this.landInbox(true).at(-1)!;
    void this.send(last, { fromInbox: true });
  }
  // A turn, a `!command` or a slash command has ended. The person's queued
  // messages go first, in order, and the first carries the inbox: its rows land
  // just ahead of it, so the model reads them together and no turn is spent on
  // them alone. With nothing queued the inbox is taken as it is. A stopped or
  // failed run puts the queue back into the field (the chat's `restoreQueue`, on
  // the `turn-end` event every caller emits just before this) and lands the
  // inbox as rows only: the person has just stopped the work, or it failed. A
  // turn that ended at a limit (`atLimit`) sends the queue as usual, but with
  // nothing queued lands the inbox as rows only too: a follow-up turn would take
  // the place of its `⏎ continue`, and the continued turn reads the rows.
  afterTurn(ok: boolean, atLimit = false): void {
    // A screen that waited for this turn opens now — or, the turn stopped or
    // failed, never (src/runtime/screens.ts).
    this.deps.screens()?.afterTurn(ok);
    if (ok && this.queue.length) {
      setTimeout(() => {
        const next = this.queue.shift();
        // ↑ took it back meanwhile.
        if (!next) { this.takeInbox(); return; }
        this.syncQueue();
        if (!this.confirm && !this.question) this.landInbox();
        void this.send(next.text);
      }, 0);
    } else if (ok && !atLimit) setTimeout(() => this.takeInbox(), 0);
    else this.takeInbox('rows');
  }

  // ── what waits: the person's queue
  // When a queued message reaches the model in a running turn — the one rule the
  // delivery and the queue line share. A message naming an image waits for the
  // turn's end (it goes as a message of its own, images and all) and keeps every
  // message behind it waiting too: it was not held by choice, and delivering the
  // later text first would reorder what the person wrote. A message held with ⇥
  // waits alone: the person held that one on purpose, and a correction typed
  // after it is meant to reach the model now.
  queueWait(list: readonly Queued[], at: number): QueueWait {
    const img = list.slice(0, at + 1).findIndex((m) => imagesInText(m.text, this.images).length > 0);
    if (img === at) return 'image';
    if (img >= 0) return 'behind';
    return list[at]!.hold ? 'end' : 'step';
  }
  syncQueue(): void { this.queuedDrawn = this.queue.slice(); this.changed(true); this.deps.notify(); }
  // ⏎ while an answer is coming: queued instead of dropped.
  enqueue(text: string): void { this.queue.push({ text }); this.syncQueue(); }
  // ↑ on an empty field: the last queued message back for editing; null with none.
  takeBackLast(): string | null {
    const last = this.queue.pop();
    if (!last) return null;
    this.syncQueue();
    return last.text;
  }
  // ⇥ on the empty field in a turn: the last one held for the turn's end, or let go at
  // the next step again. false with nothing queued.
  toggleHoldLast(): boolean {
    const last = this.queue.at(-1);
    if (!last) return false;
    this.queue = [...this.queue.slice(0, -1), { ...last, hold: !last.hold }];
    this.syncQueue();
    return true;
  }
  // A stopped or failed turn's queue, in order, the queue emptied; null when nothing
  // was queued. The chat puts the texts back into the field.
  restoreQueue(): string[] | null {
    if (!this.queue.length) return null;
    const texts = this.queue.map((m) => m.text);
    this.queue = [];
    this.syncQueue();
    return texts;
  }

  // ── recall and the meter
  // The items the history holds, computed once per history (`api` is
  // replaced, never mutated) — hashing every result on every render would not do.
  recallItems(): BulkyItem[] {
    const api = this.api;
    let items = this.itemsCache.get(api);
    if (!items) { items = bulkyItems(api, recallLimits(this.deps.config().ai).minChars); this.itemsCache.set(api, items); }
    return items;
  }
  // The model's history as it is SENT: `apiHistory`'s shape with every stubbed item
  // replaced by its stub — for the request, the meter and /compact alike.
  sentHistory(): ChatMessage[] {
    const history = apiHistory(this.api);
    return recallLimits(this.deps.config().ai).enabled ? applyRecall(history, this.recallItems(), this.recall.stubbed) : history;
  }
  contextWindow(): number { return Number((this.deps.config().ai as { contextWindow?: unknown } | undefined)?.contextWindow) || DEFAULT_CONTEXT_WINDOW; }
  // How full the model's context is (assistant/context-meter.ts). `extra` is what
  // the history will hold beyond `api` (a turn's transcript so far), and
  // `measure: false` asks for the estimate even when a figure was reported.
  contextReading(screen: ContextItem[] = this.deps.screen(), extra: ChatMessage[] = [], measure = true): ContextReading {
    const cfg = this.deps.config();
    const u = measure ? this.usage : null;
    return readContext(
      // The tools the next request will CARRY — with tools on demand, the core ones,
      // what was loaded and the index; not every tool there is.
      // The history as it goes out: a stubbed item counts as its stub, not its content.
      { system: [baseStatic(cfg), this.screensBlock(), projectBlock(this.project)].filter(Boolean).join('\n\n'), memory: this.memoryBlock(), plan: planBlock(this.plan.snapshot()), summary: summaryBlock(this.summary), screen: screenBlock(screen), tools: requestTools(this.deps.pluginAiTools() as ToolDef[], toolLoadingMode(cfg.ai), this.toolSet), messages: [...this.sentHistory(), ...extra] },
      this.contextWindow(),
      u ? u.promptTokens + u.completionTokens : undefined,
    );
  }

  // ── what the system prompt reads
  // The plugins' screens the model can open, and the keys the person presses
  // (src/runtime/screens.ts): read from the plugins as they are before each round,
  // so a plugin that joined late, or one disabled or enabled in `:plugins`, is
  // in the next round's list as it now stands. '' with nothing to list.
  screensBlock(): string { return this.deps.screens()?.promptBlock() ?? ''; }
  // The memory as the conversation sees it: its project's facts and the global
  // ones (src/assistant/memory-store.ts), read from the files each time, each
  // marked when the host did not write it (src/assistant/memory-trust.ts).
  memoryLists(): MemoryLists {
    const cfg = this.deps.config();
    const project = this.currentProject();
    const read = (ws: string) => markFacts(ws, readFacts(ws));
    return {
      project: project ? read(workspaceFor(cfg, project, 'project')) : [],
      global: read(workspaceFor(cfg, project, 'global')),
      projectLabel: project ? tildePath(project) : '',
    };
  }
  // The prompt's memory index (src/assistant/system-prompt.ts, `memoryBlock`), from the
  // facts as read now.
  memoryBlock(): string {
    // A record gone missing while the app runs sends nothing, and says so once.
    const missing = memoryRecordNotes('later');
    if (missing.length && !this.memoryMissingSaid) { this.memoryMissingSaid = true; for (const n of missing) this.pluginNote(n); }
    if (!missing.length) this.memoryMissingSaid = false;
    const l = this.memoryLists();
    return memoryBlock(l.project, l.global);
  }
  // A note is said once: not again when the list already ends in the same one
  // (a continued session that said it before the restart).
  pushProjectNote(note: string): void {
    const said = this.rows().findLast((m) => m.role === 'note' && String(m.content ?? '').startsWith('Project instructions:'));
    if (said?.content !== note) this.journal({ t: 'row', role: 'note', text: note });
    this.setRows((cur) => {
      const last = cur.findLast((m) => m.role === 'note' && String(m.content ?? '').startsWith('Project instructions:'));
      return last?.content === note ? cur : [...cur, { role: 'note', content: note }];
    });
    this.deps.notify();
  }
  // The shell's directory was set: read its instructions again and say so when
  // the files picked up changed.
  refreshProject(): void {
    const next = findInstructions(this.deps.config() as Record<string, unknown>, this.shell.cwd());
    const note = instructionsNote(this.project, next);
    this.project = next;
    if (!note) return;
    if (this.inTurn) this.projectNote = note;
    else this.pushProjectNote(note);
  }

  // A plugin's news: a note now, or under the turn's answer when one runs.
  // What a plugin says is redacted here (src/assistant/secrets.ts): a server's URL
  // or a header it names may hold a token.
  pluginNote(raw: string): void {
    const text = redactSecrets(raw);
    if (!text) return;
    if (this.inTurn) { this.laterNotes.push(text); return; }
    this.pushNote(text);
    this.deps.notify();
  }

  // ── images
  imagesInText(text: string): ImageRef[] { return imagesInText(text, this.images); }
  // The next `[Image #N]`: its number, given out on from the last one.
  attachImage(l: LoadedOk): number {
    const ref: ImageRef = { n: ++this.imageSeq, ...l.ref };
    this.images.set(ref.n, ref);
    // Read once, here: the bytes the person attached are the ones sent.
    this.imageData.set(imageKey(ref), dataUrl(ref.mime, l.data));
    return ref.n;
  }
  // An image on its way to the provider: the bytes read when it was attached, or —
  // after a restart — read again from its path and checked against its hash. A file
  // gone or changed is said once, in a note (`notes`); the message then goes as its
  // text and `[image unavailable: name]`.
  resolveImage(ref: ImageRef, notes: string[]): ResolvedImage {
    if (!imageLimits(this.deps.config().ai).enabled) return { ok: false, why: 'off' };
    const key = imageKey(ref);
    const hit = this.imageData.get(key);
    if (hit) return { ok: true, url: hit };
    const r = readImageData(ref);
    if (r.ok) {
      const url = dataUrl(ref.mime, r.data);
      this.imageData.set(key, url);
      return { ok: true, url };
    }
    if (!this.imageNoted.has(key)) {
      this.imageNoted.add(key);
      // A tool's returned image has no token (`n` 0): it is named by its name.
      notes.push(`${ref.n ? `Image #${ref.n} (${ref.name})` : `The image ${ref.name} a tool returned`} ${r.why === 'missing' ? `is no longer at ${ref.path}` : 'has changed on disk since it was attached'} — the model gets the text of that message without it.`);
    }
    return { ok: false, why: r.why };
  }

  // ── Live views (src/assistant/views.ts) ── placing what `turn`/`liveBuf`/`liveSeen`
  // collect.
  placeViews(recs: ViewRecord[]): void {
    this.setRows((cur) => {
      const next = cur.slice();
      for (const rec of recs) {
        const at = next.findLastIndex((m) => callOf(m) === rec.callId);
        // A discarded view keeps its message, drawing nothing: removing it would move
        // the fold id of every message after it.
        const gone = rec.phase === 'discarded';
        const views = gone ? [] : [{ ...rec, turn: this.turn }];
        // A new object every time — the row cache is keyed by the message object — and
        // the role it already has (a `!command` stays `shell`).
        if (at >= 0) next[at] = { ...next[at]!, views, ...(gone ? { discardedCallId: rec.callId } : {}) };
        else if (!gone) next.push({ role: 'view', content: '', views });
      }
      return next;
    });
  }
  flushLive(): void {
    if (this.liveTimer) { clearTimeout(this.liveTimer); this.liveTimer = null; }
    const recs = [...this.liveBuf.values()];
    this.liveBuf.clear();
    if (recs.length) { this.placeViews(recs); this.deps.notify(); }
  }
  // A change that arrives after the chat left this conversation (/clear, /new, /resume)
  // is dropped here, before it touches `liveBuf` / `liveSeen` or arms a flush.
  offerLive(rec: ViewRecord): void {
    if (this.isClosed) return;
    if (!rec.callId) return; // nothing to find this record by again
    this.liveBuf.set(rec.callId, rec);
    const first = !this.liveSeen.has(rec.callId);
    this.liveSeen.add(rec.callId);
    if (first || rec.phase !== 'live') { this.flushLive(); return; }
    this.liveTimer ??= setTimeout(() => this.flushLive(), LIVE_REDRAW_MS);
  }
}
