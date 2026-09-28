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
import type { SessionFingerprint } from './sessions.js';
import { createShellState, type ShellState } from './shell.js';
import { createToolSet, type ToolSet } from './tool-loading.js';
import type { ViewRecord } from './views.js';
import type { ConversationDeps, ConversationKind, Queued } from './conversation-types.js';

// The fingerprint of a session nothing has been read or written for yet — the value
// `sessionFingerprint` reads back for a file that does not exist.
export const NO_FILE: SessionFingerprint = { rev: 0, mtimeMs: 0, size: 0 };
// Live views are coalesced: the latest record per view waits at most this long.
export const LIVE_REDRAW_MS = 200;

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
}
