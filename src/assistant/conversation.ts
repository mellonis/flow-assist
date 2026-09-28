// A conversation: the model's history and the list the person reads, what runs and what
// waits, the session it is saved as. The chat draws one and drives it (AGENTS.md, "The chat").
import { apiHistory, requestTools, type ChatMessage, type TokenUsage } from './agent.js';
import type { AskState } from './ask.js';
import type { AutoMode } from './auto.js';
import { DEFAULT_CONTEXT_WINDOW, readContext, type ContextReading } from './context-meter.js';
import { dataUrl, imageLimits, imagesInText, readImageData, type ImageRef, type LoadedOk, type ResolvedImage } from './images.js';
import type { JournalEvent } from './journal.js';
import type { MemoryLists } from './memory-command.js';
import { readFacts } from './memory-store.js';
import { markFacts, memoryRecordNotes } from './memory-trust.js';
import { createPlan, type Plan } from './plan.js';
import { findInstructions, instructionsNote, type ProjectInstructions } from './project-instructions.js';
import { applyRecall, bulkyItems, createRecallState, recallLimits, type BulkyItem, type RecallState } from './recall.js';
import { screenBlock, type ContextItem } from './screen-context.js';
import { redactSecrets } from './secrets.js';
import type { Session, SessionFingerprint } from './sessions.js';
import { createShellState, tildePath, type ShellState } from './shell.js';
import { baseStatic, memoryBlock, planBlock, projectBlock, summaryBlock } from './system-prompt.js';
import { createToolSet, toolLoadingMode, type ToolSet } from './tool-loading.js';
import type { ViewRecord } from './views.js';
import { workspaceFor } from './workspace.js';
import { callOf, type ChatMirror, type ChatMsg, type ConversationDeps, type ConversationEvent, type ConversationKind, type Queued, type QueueWait, type ViewPort } from './conversation-types.js';
import {
  applySession, currentProject, ensureSessionId, journal, journaledChatLLM, journalTo, markSeen, persist, pushNote,
  releaseLockOf, writeSession, NO_FILE,
} from './conversation-session.js';

export { NO_FILE };
// Live views, coalesced: the latest record per view waits at most
// LIVE_REDRAW_MS, so a command printing thousands of lines a second costs a few
// redraws, not thousands. A view's first state and its final phase are placed at
// once — the block must appear when the call starts, and its end must not wait.
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
  // A plugin's news said while a turn runs waits for the turn's end (`note` on the
  // store, bound to `services.chatNote` by the App).
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
    this.shell = createShellState(() => deps.config(), null, () => this.onShellSet());
    // Setting the shell's directory reads the project's instructions again.
    this.onShellSet = () => this.refreshProject();
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
  syncQueue(): void { this.mirror.setQueued(this.queue.slice()); this.deps.notify(); }
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
      { system: [baseStatic(cfg), this.screensBlock(), projectBlock(this.project)].filter(Boolean).join('\n\n'), memory: this.memoryBlock(), plan: planBlock(this.plan.snapshot()), summary: summaryBlock(this.summary), screen: screenBlock(screen), tools: requestTools(this.deps.pluginAiTools() as never, toolLoadingMode(cfg.ai), this.toolSet), messages: [...this.sentHistory(), ...extra] },
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
    this.mirror.setMessages((cur) => {
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
    this.mirror.setMessages((cur) => {
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
  // `epoch` is the caller's own — captured when the turn or the `!command` that
  // opened this view STARTED, so a change that arrives after a LATER reset
  // (/clear, /resume) is dropped here, before it ever touches
  // `liveBuf`/`liveSeen` or triggers a flush into the fresh conversation.
  offerLive(rec: ViewRecord, epoch: number): void {
    if (epoch !== this.epoch) return;
    if (!rec.callId) return; // nothing to find this record by again
    this.liveBuf.set(rec.callId, rec);
    const first = !this.liveSeen.has(rec.callId);
    this.liveSeen.add(rec.callId);
    if (first || rec.phase !== 'live') { this.flushLive(); return; }
    this.liveTimer ??= setTimeout(() => this.flushLive(), LIVE_REDRAW_MS);
  }
}
