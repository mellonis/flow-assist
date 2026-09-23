// Plugin «assistant»: a chat with the LLM about the current task. A self-sufficient
// modal: owns the messages, input, streaming and scroll. THE HOST does the network
// (ft.services.chatLLM) — the plugin never touches it; config read from
// ft.config.ai (baseUrl/model/tokenEnv), token from process.env[tokenEnv].
//   - what the chat is about and the refresh after a write are asked of the plugins
//     through two generic hooks (`services.chatSubject` / `services.afterWrite`,
//     see AGENTS.md, plugin contract) — the chat names no plugin's data.
//   - the chat's language is `ai.assistantLanguage` (chatLanguage).

import { addTrigger, chatUser } from '../loader/registry.js';
import { bgActiveCount } from '../loader/tools-core.js';
import { autoBadge, autoCommand, autoConfirms, autoSaid, nextAutoMode, type AutoMode } from '../assistant/auto.js';
import { createPlan, todoGlyph } from '../assistant/plan.js';
import {
  dueStep, emptyStep, joinNarration, liveKind, notesCommand, notesMode, notesSaid, offerStep, stepWaitMs,
  type LiveKind, type NotesMode, type StepState,
} from '../assistant/step.js';
import { apiHistory, compactConversation, chatLanguage, requestTools, transcriptSoFar } from '../assistant/agent.js';
import { createToolSet, toolLoadingMode } from '../assistant/tool-loading.js';
import { copyTarget, copyToClipboard } from '../assistant/copy.js';
import { createShellState, formatShell, nextCwd, runShell, shellLimits, tildePath } from '../assistant/shell.js';
import { KEEP_SESSIONS, SESSION_VERSION, closeSession, flushOnExit, listSessions, loadSession, newSessionId, pruneSessions, saveSession, sessionToContinue, sessionWhen, sessionsDir, type Session } from '../assistant/sessions.js';
import type { ChatMessage } from '../assistant/agent.js';
import type { ChangeView } from '../assistant/diff.js';
import { VIEW_CAPS, type ViewRecord, type ViewRenderers } from '../assistant/views.js';
import { capConsoleText, consoleData, renderConsole } from '../assistant/console-view.js';
import { editorReducer } from '@flowtty/core';
import { z } from 'zod';
import { anchorRow, askFieldWidth, chatFieldWidth, chatRows, chatWrapWidth, firstFoldRow, rowAnchor, type RowOpts, type Viewport } from '../views/modals.js';
import { allFolded, flipFolds, isClicked, isOpen, toggleFold, type FoldState } from '../assistant/folds.js';
import { firstGlyph, isKey, isMouseButton } from '../playback/keys.js';
import { askKey, askStart, type AskQuestion, type AskState } from '../assistant/ask.js';
import { loadMemories, memoryFilePath, saveMemories } from '../runtime/services/memory.js';
import { keptAfterClear, memoryCommand } from '../assistant/memory-command.js';
import { CONTEXT_WARN_AT, DEFAULT_CONTEXT_WINDOW, contextBadge, readContext } from '../assistant/context-meter.js';
import {
  IMAGES_OFF, dataUrl, imageLimits, imagesInText, insertToken, isImageRefusal, loadImageFile, pastedPaths, readClipboardImage, readImageData, removeTokenAt, wireMessages,
  type ClipboardImage, type ImageRef, type LoadedOk, type ResolvedImage,
} from '../assistant/images.js';
import type { Make } from '../loader/plugin.js';
import type { Plugin } from '../loader/plugin.js';

// Slash-commands of the chat — a single source for runChatCommand and Tab-completion.
// `/analyze` is a tracker slash command and is removed.
const CHAT_COMMANDS = ['compact', 'context', 'copy', 'image', 'resume', 'clear', 'memory', 'auto', 'notes', 'fullscreen', 'log', 'exit'];

// A plain object holding every enumerable service, inherited ones included.
// `for…in` walks the prototype chain, which is exactly what a spread does not.
export function allServices(services: object): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const key in services) flat[key] = (services as Record<string, unknown>)[key];
  return flat;
}

// `/log [N]`: the person shares the tail of the host log with the model, as their
// own message. The model has no log tool — what it sees of the log is what the
// person chose to show, when they chose to show it.
export const LOG_SHARE_DEFAULT = 20;
export const LOG_SHARE_MAX = 200;
export function logShareMessage(lines: readonly string[], arg = ''): string | null {
  const asked = Number.parseInt(arg, 10);
  const n = Math.min(Number.isFinite(asked) && asked > 0 ? asked : LOG_SHARE_DEFAULT, LOG_SHARE_MAX);
  const tail = lines.slice(-n);
  if (!tail.length) return null;
  return `Host log, last ${tail.length} line${tail.length === 1 ? '' : 's'}:\n\`\`\`\n${tail.join('\n')}\n\`\`\``;
}

// How a turn that did not finish ends in the MODEL's history — an assistant message,
// read as the model's own previous turn. A question left there unanswered was answered
// with the next one: the model went back to what the person had stopped.
export const STOPPED_TURN = '(Stopped by the person before I finished. I am not resuming this request unless they ask me to.)';
export function failedTurn(message: unknown): string {
  const why = String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `(This turn failed before I could finish${why ? `: ${why}` : ''}.)`;
}

// Something the person said or did: a message, or a `!command` they ran. A session
// with neither is not worth saving.
const personSpoke = (role: string) => role === 'user' || role === 'shell';

// The command of a `run_command` call, so the y/n block can show the line itself
// rather than its JSON. null — some other tool, or arguments that do not parse.
export function shellCommandOf(name: string, args: string): string | null {
  if (name !== 'run_command' && !name.endsWith(':run_command')) return null;
  try {
    const a = JSON.parse(args) as { command?: unknown; cwd?: unknown };
    if (typeof a.command !== 'string') return null;
    return typeof a.cwd === 'string' && a.cwd.trim() ? `${a.command}   # in ${a.cwd}` : a.command;
  } catch {
    return null;
  }
}

// A chat message. `role` is the OpenAI role; `content` may be null when a message
// carries tool_calls. Extra fields ride along (live/reasoning/process/toolRuns/…).
interface ChatMsg {
  role: string;
  content?: string | null;
  live?: string;
  reasoning?: string;
  process?: string;
  toolRuns?: unknown[];
  // The step line: the last finished sentence of the narration this message carries
  // (src/assistant/step.ts). Display only, like `process` itself.
  step?: string;
  duration?: number;
  stopped?: boolean;
  // What the turn's writes changed — drawn as diff blocks above the answer.
  changes?: ChangeView[];
  // A block a tool asked the host to draw (role 'view') — a command's output so far.
  views?: ViewRecord[];
  // The call a DISCARDED view belonged to — kept on the message so a later final for
  // the same call still finds it (ids are places among drawn messages; removing the
  // message would move every fold id after it).
  discardedCallId?: string;
  [k: string]: unknown;
}

// The message this turn's answer is being written into: the last assistant message
// the turn has not yet stamped with its duration. It is looked up rather than assumed
// to be the last one, because a tool's view (a command's output) is a message of its
// own and may well sit after it — and the turn's seconds and its tool trail belong on
// the answer whatever landed below it. −1 when the turn has no answer message yet.
function answerAt(list: ChatMsg[]): number {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]!;
    if (m.role === 'assistant' && m.duration == null) return i;
  }
  return -1;
}

// The message the narration belongs to — the last the assistant spoke in, stamped
// with its duration or not. A step held back by the one-a-second floor lands after
// the turn has ended as easily as during it, and it belongs to the message that was
// narrating either way. −1 when the assistant has not spoken yet.
function narratedAt(list: ChatMsg[]): number {
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.role === 'assistant') return i;
  return -1;
}

// The app-glue dispatched to by the :ask command.
interface AssistantCtx {
  openChat?(text?: string): unknown;
}

// The `ft` runtime the chat component receives (typed by shape, loose where the
// runtime is not yet present). `services`/`store`/`viewRegistry`/`config` are
// opaque so any member access type-checks — their exact members are the
// runtime's concern.
interface AssistantFT {
  useTerminalSize(): { width: number; height: number };
  useState<T>(init: T): [T, (v: T | ((prev: T) => T)) => void];
  useRef<T>(init: T): { current: T };
  // `key`/`ui` are typed `any` so the same interface is structurally compatible with
  // the host's `TriggerFT` (used by `addTrigger`) AND accepts the direct
  // `(key) => boolean` handlers the component passes — the runtime is the
  // real source of these shapes.
  useInputHandler(opts: {
    mode: string;
    priority: (ui: any) => number;
    handler: (key: any, ui: any) => boolean;
    // The chat's conversation is the one handler that reads the mouse buttons.
    mouse?: boolean;
  }): void;
  store: Record<string, unknown>;
  services: Record<string, unknown>;
  viewRegistry: Record<string, unknown>;
  config: Record<string, unknown>;
  notify(): void;
  keys: Record<string, string | string[]>;
  // The plugin's own identity token, a Symbol the HOST issued and bound in the
  // mount closure. Relayed into toolCtx so the memory tool's `plugin` scope
  // resolves to the true owner (the assistant). Unforgeable: only the host maps
  // tokens to names, so the assistant can present itself but never impersonate.
  pluginToken?: symbol;
}

type BuildAssistantParams = {
  renders: Record<string, unknown>;
  config: Record<string, unknown>;
  make: Make;
};

export function buildAssistantPlugin({ renders, config, make }: BuildAssistantParams): Plugin {
  return make('assistant', {
    name: 'assistant',
    commands: [
      {
        name: 'ask', aliases: ['chat'],
        run: (ctx, arg) => (ctx as AssistantCtx).openChat?.(arg),
        usage: 'ask [text]', minArgs: 0, maxArgs: -1,
        description: 'Open the chat; with text, send it',
      },
    ],
    // `details` opens what the chat folds — the narration, a turn's tool calls, a
    // command's capped output — and closes it again. It is an ACTION, not a key
    // written into the handler, so `config.keys.details` moves it and every hint
    // draws the cap of whatever it is bound to. `^r` stays beside `^o`: it is in
    // every hint people have read so far, and a key that quietly stopped working
    // would be the worst way to learn about the new one.
    keys: { chat: 'F', details: ['ctrl+o', 'ctrl+r'] },
    // config.plugins.assistant: `fullscreen` — the chat takes the whole terminal from
    // the start (`/fullscreen on|off` switches it for the session); `notes` — how the
    // model's narration between tool calls is drawn (`/notes` switches it for the
    // conversation); `colors` — the chat's palette override
    // (src/playback/theme.ts); `runOutputLines` — how many lines of a command's output
    // stand in the chat before ^r unfolds the rest (a display cap of its own, quite
    // apart from `shell.maxChars`, which is how much the MODEL is given).
    configSchema: z.object({
      fullscreen: z.boolean().optional(),
      notes: z.enum(['step', 'fold', 'open', 'hidden']).optional(),
      runOutputLines: z.number().int().positive().optional(),
      colors: z.record(z.string(), z.unknown()).optional(),
    }).optional(),
    // The footer's word for the chat while it is closed: the key that opens it and,
    // when background results landed meanwhile, how many are waiting. Open, the
    // chat says its own keys inside its frame.
    usesCache: false,
    keycaps: (ft) => {
      const p = ft as { keyCap?: (action: string) => string; store?: { chat?: { open?: boolean; unread?: number } } };
      const chat = p.store?.chat;
      if (chat?.open) return [];
      // The cap of whatever `chat` is bound to now — not a letter written here.
      const cap = p.keyCap?.('chat') ?? '';
      if (!cap) return [];
      return [`${cap} chat${chat?.unread ? ` · ◆ ${chat.unread} new` : ''}`];
    },
    views: { chat: renders.chat },
    components: {
      chat: (ft) => {
        const f = ft as AssistantFT;
        return function ChatModal() {
          const { width, height } = f.useTerminalSize();
          const [open, setOpen] = f.useState(false);
          // The whole terminal instead of a centred window: config.plugins.assistant.
          // fullscreen to start with, `/fullscreen [on|off]` for the session. The ref is
          // for the key handler (the field's width decides up/down across wrapped rows).
          const [fullscreen, setFullscreenState] = f.useState(Boolean((f.config.plugins as Record<string, { fullscreen?: boolean }> | undefined)?.assistant?.fullscreen));
          const fullscreenRef = f.useRef(fullscreen); fullscreenRef.current = fullscreen;
          // `openRef` is what the detached background flush reads (a timer's closure
          // would see a stale `open`); `unread` counts results that landed while the
          // chat was closed — the footer shows it, opening the chat clears it.
          const openRef = f.useRef(open); openRef.current = open;
          const [unread, setUnread] = f.useState(0);
          const unreadRef = f.useRef(unread); unreadRef.current = unread;
          // The host draws its footer BEFORE this component re-renders, so what the
          // footer reads (`ft.store.chat.open` / `.unread`) is patched synchronously at
          // the moment it changes — otherwise the footer runs one render behind and
          // "F chat" vanishes on close.
          const publish = (patch: { open?: boolean; unread?: number }) => {
            const store = f.store as Record<string, any>;
            store.chat = { ...(store.chat ?? {}), ...patch };
          };
          // The plan is this conversation's: made here, handed to the `todo` tool through
          // the tool context, emptied by /clear. It used to be module state and so
          // outlived the conversation it described.
          const planRef = f.useRef(createPlan());
          // Where this conversation's shell commands run — `!command` and the model's
          // run_command share it; `cd` moves it. The conversation's, like the plan: a
          // background run gets its own, /clear and a change of task reset it.
          const shellRef = f.useRef(createShellState(() => f.config as Record<string, unknown>));
          // Which turn a view belongs to — groups never span two.
          const turnRef = f.useRef(0);
          // Live views, coalesced: the latest record per view waits here at most
          // LIVE_REDRAW_MS, so a command printing thousands of lines a second costs a few
          // redraws, not thousands. A view's first state and its final phase are placed at
          // once — the block must appear when the call starts, and its end must not wait.
          const LIVE_REDRAW_MS = 200;
          const liveBuf = f.useRef(new Map<string, ViewRecord>());
          const liveSeen = f.useRef(new Set<string>());
          const liveTimer = f.useRef<ReturnType<typeof setTimeout> | null>(null);
          // The tools the model has loaded (tools on demand, src/assistant/tool-loading.ts).
          // The conversation's, like the plan: its history calls them, so it is saved
          // with the session, kept through /compact, emptied by /clear and a change of task.
          const toolSetRef = f.useRef(createToolSet());
          // What the provider reported for the last turn: its prompt plus the answer it
          // produced is, to a close approximation, the size of the NEXT request.
          const usageRef = f.useRef<{ promptTokens: number; completionTokens: number } | null>(null);
          // `/context` opens a panel in the field's place, like a write confirmation — it
          // is a look at the conversation, not a line of it. The ref is for the key
          // handler; the state is for the render.
          const contextOpenRef = f.useRef(false);
          const [contextOpen, setContextOpenState] = f.useState(false);
          const setContextOpen = (v: boolean) => { contextOpenRef.current = v; setContextOpenState(v); f.notify(); };
          const [messages, setMessages] = f.useState<ChatMsg[]>([]);
          const [input, setInput] = f.useState('');
          const [streaming, setStreaming] = f.useState(false);
          const [error, setError] = f.useState<string | null>(null);
          const [toolLabelState, setToolLabelState] = f.useState(''); // «⚙ calling get_issue…» during tool rounds
          // Mirrored in a ref: the stream callbacks are closures made when the message was
          // sent, and they read the label to clear it. Reading the state there saw the
          // value at send time — empty — so the label of a finished tool never cleared and
          // the chat looked stuck on it while the model was already writing.
          const toolLabelRef = f.useRef('');
          const toolLabel = toolLabelState;
          const setToolLabel = (v: string) => { toolLabelRef.current = v; setToolLabelState(v); };
          // What the model is doing when no tool runs: 'writing' only while its text
          // arrives; before the first token, while it reasons, and between tools (it is
          // working out the next call) it is 'thinking'. One word for all of it read
          // "writing…" while nothing was being written.
          const [phase, setPhase] = f.useState<'thinking' | 'writing'>('thinking');
          // What is open and what is folded (src/assistant/folds.ts): one global
          // state, plus the blocks a click has made an exception of. `details` (^o)
          // is the master switch; a click opens the block under it alone. The
          // conversation's, like the auto mode — never saved, and `/clear`, `/resume`
          // and a change of task all come back to everything folded.
          const [folds, setFoldsState] = f.useState<FoldState>(allFolded());
          const foldsRef = f.useRef(folds);
          const setFolds = (s: FoldState) => { foldsRef.current = s; setFoldsState(s); };
          // What the conversation last said about where it is on the screen — the
          // view reports it, and a click is turned into a row with it.
          const viewportRef = f.useRef<Viewport | null>(null);
          // A row the list should be put at the top of once the rows have changed, and
          // the nonce that makes a repeat of the same row ask again.
          const [scrollTo, setScrollTo] = f.useState<{ row: number; n: number } | null>(null);
          const scrollSeq = f.useRef(0);
          // The mouse press a click may still come out of: the cell it landed on and
          // when. A drag clears it — a drag is a selection and never a fold.
          const pressRef = f.useRef<{ x: number; y: number; at: number } | null>(null);
          // Process indicator: spinner + the seconds of whatever is running NOW.
          // t0Ref — when the turn started, which is what the finished answer's quiet
          // line says (`· 12.4s`). segRef — when the thing on the status line started:
          // a tool the moment it was called, the model's round the moment the tool
          // ended. A turn that runs a build sat at `3m 12s`, which says nothing about
          // what is happening; the number a person wants there is how long the RUNNING
          // thing has taken. tickRef ticks elapsedMs off segRef.
          const [elapsedMs, setElapsedMs] = f.useState(0);
          const t0Ref = f.useRef(0);
          const segRef = f.useRef(0);
          const tickRef = f.useRef<ReturnType<typeof setInterval> | null>(null);
          // What is on the status line now starts its own clock.
          const beginSegment = () => { segRef.current = Date.now(); setElapsedMs(0); };
          // A tool has ended: its label goes, and the clock on the line is the model's
          // round from here. Only when one was actually running — the callbacks below
          // all report the end of a tool, and the first of them to fire owns it.
          const endToolSegment = () => { if (toolLabelRef.current) { setToolLabel(''); beginSegment(); } };
          // What the provider said this TURN has cost: every round's prompt plus its
          // completion, added up as the rounds report (`onRound`). A different number
          // from `usageRef` above, which is the last round alone — the size of the next
          // request, and so how full the context is. Nothing is estimated here: a
          // provider that reports no usage leaves this at 0 and no figure is drawn.
          const [turnTokens, setTurnTokensState] = f.useState(0);
          const turnTokensRef = f.useRef(0);
          const setTurnTokens = (n: number) => { turnTokensRef.current = n; setTurnTokensState(n); };
          // Empty answer: the model output only reasoning (goes to the fold) but no
          // final text. contentRef accumulates the final content (onDelta) — by it we
          // decide «empty?» and show an amber status message.
          const contentRef = f.useRef('');
          const [emptyNotice, setEmptyNotice] = f.useState('');
          const [toolCount, setToolCount] = f.useState(0); // tool calls in this turn (for the status)
          const abortRef = f.useRef<AbortController | null>(null);
          const ctxSubjectRef = f.useRef<string | null>(null); // what the screen was about when this session began
          // Tab-completion cycle: { base, idx, cmd } — by which prefix the matches were
          // built, the last selected command in that list and its text. Repeat Tab cycles;
          // changing the prefix (typed/deleted) restarts.
          const tabRef = f.useRef<{ base: string; idx: number; cmd: string } | null>(null);
          const inputRef = f.useRef(input); inputRef.current = input;
          const msgsRef = f.useRef(messages); msgsRef.current = messages;
          // The MODEL's history, kept apart from the display list above. `messages`
          // holds what the person reads (final text + process/toolRuns/live); this
          // holds what was actually exchanged — tool calls and tool results included
          // — and is what every turn replays. See `apiHistory` for why the display
          // list must never stand in for it.
          const apiRef = f.useRef<ChatMessage[]>([]);
          // `/compact`'s summary. It rides in the system context of every later turn;
          // a display-only `system` message would be dropped by `send` and lost.
          const summaryRef = f.useRef<string>('');
          const streamRef = f.useRef(streaming); streamRef.current = streaming;
          // Background-result queue (populated by `postToChat`, see below): results are
          // NOT dropped when the chat is busy — they wait here and are auto-fed through
          // `send` (analyzed) one at a time once the chat is idle. A short interval
          // drives the flush; it self-clears when the queue empties.
          const bgQueueRef = f.useRef<string[]>([]);
          const flushTimer = f.useRef<ReturnType<typeof setInterval> | null>(null);
          const clearFlush = () => {
            if (flushTimer.current) { clearInterval(flushTimer.current); flushTimer.current = null; }
          };
          let flushPending: () => void = () => {};
          // Input field caret — an index (codepoint) in `input`. Kept in a ref so the
          // handler reads a fresh value.
          const [cursor, setCursor] = f.useState(0);
          const cursorRef = f.useRef(cursor); cursorRef.current = cursor;
          // Messages sent while an answer was coming. They go out in order when the
          // turn ends; Esc takes the last one back into the field. queueRef is what
          // the handlers act on, `queued` mirrors it for the render.
          const queueRef = f.useRef<string[]>([]);
          const [queued, setQueued] = f.useState<string[]>([]);
          const syncQueue = () => { setQueued(queueRef.current.slice()); f.notify(); };
          // Prompt history for ↑/↓. `histAt` is the entry on screen (null = the draft),
          // `histShown` is its text — an arrow only replaces the field while it still
          // shows exactly that, so a draft being typed is never lost to a keypress.
          const historyRef = f.useRef<string[]>([]);
          const histAt = f.useRef<number | null>(null);
          const histShown = f.useRef<string>('');
          const setField = (t: string) => { setInput(t); inputRef.current = t; setCursor(t.length); f.notify(); };
          // Shell MODE — `!` typed into an EMPTY field flips it (`! ` in the shell
          // colour replaces `› `, see src/views/modals.ts); Enter then runs the field
          // text exactly as the legacy `!<text>` path always has, and the mode reverts
          // right after — one command per `!`, like Claude Code's bash mode. It is UI
          // state of the field only: never saved with the session (snapshotSession's
          // draft rule below) and never restored on a restart.
          const [shellMode, setShellModeState] = f.useState(false);
          const shellModeRef = f.useRef(shellMode);
          const setShellMode = (v: boolean) => { shellModeRef.current = v; setShellModeState(v); };
          // ── The auto mode (src/assistant/auto.ts) — how much of a turn runs without
          // the y/n. This conversation's and nothing else's: it is not in the session
          // file, so a restart opens on `ask`, and `/clear`, `/resume` and a change of
          // task put it back there too. The ref is what the confirmation closure reads
          // (it was made when the message was sent, and would otherwise see the mode of
          // that moment for the whole turn); the state is for the render.
          const [autoMode, setAutoModeState] = f.useState<AutoMode>('ask');
          const autoModeRef = f.useRef<AutoMode>(autoMode);
          const setAutoMode = (m: AutoMode) => { autoModeRef.current = m; setAutoModeState(m); };
          // ── The narration (src/assistant/step.ts) — how what the model says between
          // tool calls is drawn. `plugins.assistant.notes` is where a conversation
          // starts, `/notes` moves it for this one only, and `/clear` puts it back
          // where the config says. The ref is for the key handler and the command,
          // which are closures made before the state they would read.
          const configNotes = (): NotesMode => notesMode((f.config.plugins as Record<string, { notes?: unknown }> | undefined)?.assistant?.notes);
          const [notes, setNotesState] = f.useState<NotesMode>(configNotes());
          const notesRef = f.useRef<NotesMode>(notes);
          const setNotes = (m: NotesMode) => { notesRef.current = m; setNotesState(m); };
          // The step line's own state: what it says, when it last changed, and a change
          // waiting for the floor to pass. It is this CONVERSATION's — never module
          // state — and every turn starts it again, so a turn's first step is never
          // held back and the floor only ever guards the flicker within one turn.
          // `narrationRef` accumulates the same text the message's `process` does, out
          // here where it can be read without a render.
          const stepRef = f.useRef<StepState>(emptyStep());
          const narrationRef = f.useRef('');
          // What the round being streamed IS, and whether any of it was drawn as the
          // answer before that was known. A round used to be classified at its END,
          // and a round that turned out to carry a tool call had the paragraph the
          // person was reading taken away again — so it is decided on arrival, from
          // the `Next:` shape the prompt asks for and from the tool-call fragments the
          // agent reports the moment they start arriving. `drawn` is what makes the
          // difference between text that was never shown (nothing to keep) and text
          // that was (kept where it is, dim).
          const roundRef = f.useRef<{ kind: LiveKind; drawn: boolean }>({ kind: 'unknown', drawn: false });
          const resetRound = () => { roundRef.current = { kind: 'unknown', drawn: false }; };
          const stepTimer = f.useRef<ReturnType<typeof setTimeout> | null>(null);
          const clearStepTimer = () => { if (stepTimer.current) { clearTimeout(stepTimer.current); stepTimer.current = null; } };
          const resetStep = () => { clearStepTimer(); stepRef.current = emptyStep(); narrationRef.current = ''; resetRound(); };
          // A change the floor held back is not dropped: it lands on the message that
          // was narrating as soon as the second is up, whether or not the turn is still
          // running.
          const scheduleStep = () => {
            const wait = stepWaitMs(stepRef.current, Date.now());
            if (!wait) return;
            stepTimer.current = setTimeout(() => {
              stepTimer.current = null;
              stepRef.current = dueStep(stepRef.current, Date.now());
              const shown = stepRef.current.shown;
              setMessages((cur) => {
                const next = cur.slice();
                const at = narratedAt(next);
                if (at >= 0) next[at] = { ...next[at]!, step: shown };
                return next;
              });
              f.notify();
            }, wait);
          };
          // One round of narration has arrived; what the line should say now comes back.
          // Only rounds that carried tool calls reach here — the answer's own text never
          // feeds the line, which is what made the first version of it flicker through
          // the answer as it streamed.
          const advanceStep = (narration: string): string => {
            clearStepTimer();
            stepRef.current = offerStep(stepRef.current, narration, Date.now());
            scheduleStep();
            return stepRef.current.shown;
          };
          // ── Folds ── the rows a click lands on, and what opening one does to the
          // scroll. The rows are laid out by the view and cached per message object,
          // so asking for them here is a lookup, not a second layout.
          // The display list as the view's own functions read it — the same objects,
          // and so the same cached rows.
          const drawn = () => msgsRef.current as Parameters<typeof chatRows>[0];
          // A renderer that cannot draw is said once per kind in the log, not once per frame.
          const failedKinds = f.useRef(new Set<string>());
          const onViewFail = (kind: string, why: string) => {
            if (failedKinds.current.has(kind)) return;
            failedKinds.current.add(kind);
            (f.services as Record<string, any>).pushLog?.(`[view] ${kind}: ${why} — drawn as one line`);
          };
          // Every renderer the chat can draw a view with — the host's own `console`
          // (collected at boot, src/loader/registry.ts) plus each plugin's, qualified
          // by its name; the same default the view's own `renderChatModal` falls back
          // to, so a host that somehow boots with no `services.viewRenderers` draws
          // views identically whichever of the two places below reads it.
          const viewRenderers: ViewRenderers = (f.services as { viewRenderers?: ViewRenderers }).viewRenderers ?? { console: renderConsole };
          const rowOpts = (state: FoldState): RowOpts => ({
            wrap: chatWrapWidth(width, fullscreenRef.current),
            folds: state,
            viewLines: Number((f.config.plugins as Record<string, { runOutputLines?: unknown }> | undefined)?.assistant?.runOutputLines) || VIEW_CAPS.folded,
            notes: notesRef.current,
            // Empty when the action is unbound — every hint that names it then
            // leaves it out, rather than teaching a key that does nothing.
            detailsKey: firstGlyph(f.keys.details),
            renderers: viewRenderers,
            now: Date.now(),
            palette: ((f.config.theme as { modals?: { chat?: Record<string, string | undefined> } } | undefined)?.modals?.chat ?? {}),
            onViewFail,
          });
          // Put a row at the top of the conversation, once the rows have changed.
          const askScroll = (row: number) => setScrollTo({ row: Math.max(0, row), n: ++scrollSeq.current });
          // A fold changed. Opening a block puts its FIRST row at the top of the
          // screen — a block taller than the window used to land on its last line,
          // which is the end of what the person opened it to read. Anything else keeps
          // the line they were on where it was: the rows a fold adds or takes away
          // above the view would otherwise slide the whole conversation under them.
          const applyFolds = (next: FoldState, opened: string | null) => {
            const before = foldsRef.current;
            const v = viewportRef.current;
            const rows = opened ? chatRows(drawn(), rowOpts(next)) : [];
            setFolds(next);
            if (opened) {
              const at = firstFoldRow(rows, opened);
              if (at >= 0) askScroll(at);
            } else if (v && v.atEnd) {
              // Resting at the end of the conversation: the rows a fold adds or takes
              // away are all above the reader, and the list follows the bottom by
              // itself. Asking it to scroll would move exactly what is staying put.
            } else if (v) {
              const where = rowAnchor(drawn(), rowOpts(before), v.scrollTop);
              askScroll(anchorRow(drawn(), rowOpts(next), where));
            }
            f.notify();
          };
          // The key: everything at once, and the exceptions go with it. There is no one
          // block to anchor on, so the person keeps the text they were reading.
          const flipAllFolds = () => applyFolds(flipFolds(foldsRef.current), null);
          // Which block a click landed on — null for a cell that is not a fold line and
          // not inside an open block, which is most of the screen and does nothing.
          const foldAt = (x: number, y: number): string | null => {
            const v = viewportRef.current;
            if (!v || x < v.left || x >= v.left + v.width) return null;
            const line = y - v.top;
            if (line < 0 || line >= v.height) return null;
            // The pinned question is painted over the top row: a click there is on the
            // pin, not on the row beneath it.
            if (v.pinned && line === 0) return null;
            const rows = chatRows(drawn(), rowOpts(foldsRef.current));
            return rows[v.scrollTop + line]?.fold ?? null;
          };
          // A click: a press and a release on the SAME cell, with no drag between them
          // and inside the quarter second a finger takes. Anything else is a drag, and
          // a drag is flowtty's selection — it copies, and it must never fold.
          const CLICK_MS = 250;
          const mouse = (key: { name?: string; x?: number; y?: number }): boolean => {
            if (key.name === 'mousedrag') { pressRef.current = null; return false; }
            if (key.name === 'mousedown') { pressRef.current = { x: Number(key.x), y: Number(key.y), at: Date.now() }; return false; }
            const down = pressRef.current;
            pressRef.current = null;
            if (!down || down.x !== Number(key.x) || down.y !== Number(key.y) || Date.now() - down.at > CLICK_MS) return false;
            const id = foldAt(down.x, down.y);
            if (id == null) return false;
            // Which way this click goes: for a block that follows the global state,
            // away from it; for the trail's cap, which never does, simply on.
            const opening = id.endsWith(':calls') ? !isClicked(foldsRef.current, id) : !isOpen(foldsRef.current, id);
            applyFolds(toggleFold(foldsRef.current, id), opening ? id : null);
            return true;
          };

          // ── Images (src/assistant/images.ts) ── what each `[Image #N]` of this
          // conversation stands for, and the last N given out. The conversation's, like
          // the plan: saved with the session, emptied by /clear and a change of task. The
          // TEXT decides what a message sends — the tokens in it this map knows — so the
          // field, a queued message, ↑/↓ and the draft need nothing beside their text.
          const imagesRef = f.useRef(new Map<number, ImageRef>());
          const imageSeqRef = f.useRef(0);
          // The `data:` URL of an image, once read and found unchanged — built on the way to
          // the provider, never kept in a message or written to disk. Keyed by path + hash.
          const imageDataRef = f.useRef(new Map<string, string>());
          // Images already said to be gone, so the note is not repeated with every message;
          // and whether the provider's refusal of an image has been explained.
          const imageNotedRef = f.useRef(new Set<string>());
          const imageRefusalSaidRef = f.useRef(false);
          const imageKey = (r: ImageRef) => `${r.path}\0${r.sha256}`;
          const resetImages = (refs: ImageRef[] = [], seq = 0) => {
            imagesRef.current = new Map(refs.map((r) => [r.n, r]));
            imageSeqRef.current = Math.max(seq, 0, ...refs.map((r) => r.n));
            imageDataRef.current = new Map();
            imageNotedRef.current = new Set();
            imageRefusalSaidRef.current = false;
          };

          // ── Sessions (src/assistant/sessions.ts) ───────────────────────────────
          // The conversation is written to disk after every change, so a restart
          // continues it. A session gets its id when it first has something to keep;
          // `/clear` starts a new one and leaves the old for `/resume`.
          const sessDir = sessionsDir(f.config);
          const sessConf = (f.config.sessions ?? {}) as { resume?: unknown; keep?: unknown };
          const sessionIdRef = f.useRef('');
          const createdAtRef = f.useRef('');
          const saveTimer = f.useRef<ReturnType<typeof setTimeout> | null>(null);
          const snapshotSession = (): Session => {
            if (!sessionIdRef.current) { sessionIdRef.current = newSessionId(); createdAtRef.current = new Date().toISOString(); }
            return {
              version: SESSION_VERSION, id: sessionIdRef.current, title: '', createdAt: createdAtRef.current, updatedAt: new Date().toISOString(),
              messages: msgsRef.current as Record<string, unknown>[], api: apiRef.current as unknown as Record<string, unknown>[],
              summary: summaryRef.current, plan: planRef.current.snapshot(), usage: usageRef.current,
              // A /command or !command in the field is being run, not drafted (it was
              // "/clear" itself); a shell-mode field has no leading `!` left to catch by
              // that regex, so its own flag is checked too — it is not a draft either.
              prompts: historyRef.current.slice(-100), draft: (shellModeRef.current || /^\s*[/!]/.test(inputRef.current)) ? '' : inputRef.current, subject: ctxSubjectRef.current,
              shellCwd: shellRef.current.saved(),
              tools: toolSetRef.current.names(),
              // Refs only — a path and a hash per image, never its bytes.
              images: [...imagesRef.current.values()], imageSeq: imageSeqRef.current,
              closed: false, // written means in use — a resumed cleared session is open again
            };
          };
          const writeSession = () => {
            if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
            if (!sessDir || !msgsRef.current.some((m) => personSpoke(m.role))) return; // nothing said or run yet
            try { saveSession(sessDir, snapshotSession()); } catch (e) {
              (f.services as Record<string, any>).pushLog?.(`[session] not saved: ${(e as Error).message}`);
            }
          };
          // After the render that carries the change — the screen list is read from msgsRef.
          const persist = () => {
            if (saveTimer.current) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => { saveTimer.current = null; writeSession(); }, 250);
          };
          const writeRef = f.useRef(writeSession); writeRef.current = writeSession;
          const applySession = (s: Session) => {
            sessionIdRef.current = s.id; createdAtRef.current = s.createdAt;
            ctxSubjectRef.current = s.subject ?? null;
            apiRef.current = s.api as unknown as ChatMessage[];
            summaryRef.current = s.summary;
            planRef.current.load(s.plan);
            shellRef.current.setCwd(s.shellCwd ?? null);
            toolSetRef.current.load(s.tools);
            liveSeen.current.clear(); liveBuf.current.clear(); // the calls they tracked belong to the conversation being left
            resetImages(s.images ?? [], s.imageSeq ?? 0);
            setAutoMode('ask'); // another conversation is another conversation's mode
            setNotes(configNotes()); // and its own answer to how much narration is drawn
            resetStep(); // the step line belonged to the turn that is being left
            setFolds(allFolded()); // and the exceptions pointed into a conversation that is gone
            usageRef.current = s.usage;
            historyRef.current = s.prompts.slice();
            histAt.current = null;
            msgsRef.current = s.messages as ChatMsg[];
            setMessages(s.messages as ChatMsg[]);
            setShellMode(false); // the mode is never saved — a restored draft is plain text
            setField(s.draft);
          };
          const startedRef = f.useRef(false);
          if (!startedRef.current && sessDir) {
            startedRef.current = true;
            // Whatever happens at exit, the last change is written (a pending
            // debounced save would otherwise be lost with the process).
            flushOnExit(() => writeRef.current());
            setTimeout(() => {
              try { pruneSessions(sessDir, Number.isInteger(sessConf.keep) ? Number(sessConf.keep) : KEEP_SESSIONS); } catch { /* not fatal */ }
              if (sessConf.resume === false || msgsRef.current.length) return;
              const s = sessionToContinue(sessDir);
              if (!s) return;
              applySession(s);
              (f.services as Record<string, any>).showMessage?.(`Continued «${s.title || 'the last session'}» — /clear starts a new one, /resume lists others`);
              f.notify();
            }, 0);
          }
          // Exit «arming» by Esc: 0 — not armed; else ms when the first Esc was pressed.
          // A second Esc within the window closes the chat; any other key disarms.
          const [escArmAt, setEscArmAt] = f.useState(0);
          const escTimer = f.useRef<ReturnType<typeof setTimeout> | null>(null);
          // y/n pause on a writing operation (write-flag tool → agentChat →
          // confirmWrite): while the promise hangs, input pauses and a confirmation
          // block renders. pendingRef holds { name, args, resolve } — read by the
          // input-handler (a ref, always current); pendingAsk is only for render.
          const pendingRef = f.useRef<{ name: string; args: string; resolve: (ok: boolean) => void } | null>(null);
          const [pendingAsk, setPendingAsk] = f.useState<{ name: string; args: string; command?: string } | null>(null);
          // `ask_user`: the same kind of pause, but the person picks among options.
          // askRef is what the input handler steps key by key (a ref, always current);
          // pendingQuestion mirrors it for the render.
          const askRef = f.useRef<{ state: AskState; resolve: (done: AskState) => void } | null>(null);
          const [pendingQuestion, setPendingQuestion] = f.useState<AskState | null>(null);
          const settleAsk = (done: AskState) => {
            const a = askRef.current;
            if (!a) return;
            askRef.current = null;
            setPendingQuestion(null);
            a.resolve(done);
            f.notify();
          };
          // Leaving the chat or resetting it must not leave the tool hanging: an
          // unanswered question is reported to the model as dismissed.
          const dismissAsk = () => { if (askRef.current) settleAsk({ ...askRef.current.state, done: true, cancelled: true }); };

          // ── Esc-exit logic (double Esc) ─────────────────────────────────────────
          const armEsc = () => {
            if (escTimer.current) clearTimeout(escTimer.current);
            setEscArmAt(Date.now());
            // Self-disarm: if after the first Esc nothing is pressed for a while, the
            // arm fades so a stray Esc later does not eject from the chat unintentionally.
            escTimer.current = setTimeout(() => { setEscArmAt(0); escTimer.current = null; f.notify(); }, 3200);
          };
          const disarmEsc = () => {
            if (escTimer.current) { clearTimeout(escTimer.current); escTimer.current = null; }
            setEscArmAt(0);
          };
          const escArmed = escArmAt > 0 && (Date.now() - escArmAt) < 3200;

          // Resolves the y/n pause: ok=true confirms the writing op (tool runs),
          // ok=false declines it (agentChat returns «declined» as the tool result).
          const settleConfirm = (ok: boolean) => {
            const p = pendingRef.current;
            if (!p) return;
            pendingRef.current = null;
            setPendingAsk(null);
            p.resolve(ok);
            f.notify();
          };

          // The «cheap» synchronous base: a directive about the reply (language/
          // brevity), who it is answering, a write-language directive. No network — it
          // is assembled instantly on every message, so it is not cached.
          const baseStatic = () => {
            // Who speaks — the LLM does not know itself: mix in `config.user` (when the
            // person set one) so it addresses a human.
            const who = chatUser(f.config as { user?: { name?: unknown; login?: unknown } });
            const identity = who
              ? `You are talking to ${who.name}${who.login && who.login !== who.name ? ` (login ${who.login})` : ''}. Address the answer to them, not to an anonymous service account.`
              : '';
            // Between tool calls the model writes prose, because it has nothing else to
            // write there. Asking it not to narrate did not work — it narrated anyway,
            // at whatever length. So it is asked for a SHAPE instead: one short `Next:`
            // line before a call, which is exactly what the chat draws as the step line
            // (src/assistant/step.ts), and nothing else. The final answer is not a
            // step, so the line is asked for before a call only.
            const chatLang = chatLanguage((f.config as Record<string, unknown>).ai as Record<string, unknown>);
            const directive = `Always respond in ${chatLang}. Answer concisely and to the point: only the outcome, and no retelling of your own moves in the final answer. Before you call a tool, write ONE short line that starts with "Next:" and says what you are about to do — nothing else between calls, no plans, no commentary, no repetition of what you already said. Do not begin the final answer with "Next:". Never claim you changed, created or deleted something unless a write tool actually returned success for it; if a write was declined or errored, say so instead. If the user asks why you did not run a tool, or says they do not see its result, do NOT just restate that the tool was already called («it’s already done», «it was scheduled»): actually re-run it now, or ask the user to confirm the repeat («run it again?»). Never claim a result you have not seen returned.`;
            // Write-language directive. The tracker named tracker tools here; the host is
            // tracker-agnostic, so it is generalized to any write/persist tool.
            const writeLangDirective = `When you write or persist content (a write tool: memory, config set/unset, fs, or any tool that writes), write in ${chatLang}.`;
            return [directive, identity, writeLangDirective].filter(Boolean).join('\n\n');
          };

          // The fresh memory block: every message re-reads the file, so a note added or
          // edited mid-session lands in the next answer immediately. Empty → '' (block
          // not added).
          const memoryBlock = () => {
            const mems = loadMemories(memoryFilePath(f.config));
            return mems.length
              ? `## Persistent memory\nFacts remembered across sessions (the \`memory\` tool adds/updates/removes them). Consider them when answering.\n${mems.map(m => `- ${m.scope}: ${m.text}`).join('\n')}`
              : '';
          };
          // The CURRENT task plan (the `todo` tool), re-read every message so the model
          // sees the live checkboxes it created and must keep in sync. The rendered
          // `▾ plan` block only reflects `todo` calls — so this block instructs it to
          // route every state change through the tool, never to describe the status in
          // prose (the bug it hits: it narrates "42 → done" in chat but the block never
          // moves because `todo complete` was never called). Empty → '' (no block).
          const planBlock = () => {
            const plan = planRef.current.snapshot();
            if (!plan.length) return '';
            const order = { in_progress: 0, pending: 1, done: 2 };
            const lines = [...plan].sort((a, b) => order[a.status] - order[b.status]).map((t) => {
              const w = t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'in progress' : 'pending';
              return `${todoGlyph(t.status)} ${t.id} · ${t.text} (${w})`;
            });
            return `## Current task plan (the \`todo\` tool)\nYou maintain it through \`todo\`; it changes only when you call the tool.\n${lines.join('\n')}`;
          };
          // The full system context of a message = the «cheap» base (directive+identity)
          // + fresh memory + the current plan. No network: the base is synchronous,
          // memory a local file, the plan the tool's module state.
          // How full the model's context is (assistant/context-meter.ts).
          const contextReading = () => {
            const summary = summaryRef.current ? `Summary of the conversation so far (older turns were compacted):\n${summaryRef.current}` : '';
            const window = Number((f.config.ai as { contextWindow?: unknown } | undefined)?.contextWindow) || DEFAULT_CONTEXT_WINDOW;
            const u = usageRef.current;
            return readContext(
              // The tools the next request will CARRY — with tools on demand, the core ones,
              // what was loaded and the index; not every tool there is.
              { system: baseStatic(), memory: memoryBlock(), plan: planBlock(), summary, tools: requestTools((f.services as Record<string, any>).pluginAiTools ?? [], toolLoadingMode(f.config.ai), toolSetRef.current), messages: apiHistory(apiRef.current) },
              window,
              u ? u.promptTokens + u.completionTokens : undefined,
            );
          };

          const assembleSystem = () => {
            const summary = summaryRef.current ? `Summary of the conversation so far (older turns were compacted):\n${summaryRef.current}` : '';
            const parts = [baseStatic(), memoryBlock(), planBlock(), summary].filter(Boolean);
            return parts.length ? parts.join('\n\n') : null;
          };

          // An image on its way to the provider: the bytes read when it was attached, or —
          // after a restart — read again from its path and checked against its hash. A file
          // gone or changed is said once, in a note (`notes`); the message then goes as its
          // text and `[image unavailable: name]`.
          const resolveImage = (ref: ImageRef, notes: string[]): ResolvedImage => {
            if (!imageLimits(f.config.ai).enabled) return { ok: false, why: 'off' };
            const key = imageKey(ref);
            const hit = imageDataRef.current.get(key);
            if (hit) return { ok: true, url: hit };
            const r = readImageData(ref);
            if (r.ok) {
              const url = dataUrl(ref.mime, r.data);
              imageDataRef.current.set(key, url);
              return { ok: true, url };
            }
            if (!imageNotedRef.current.has(key)) {
              imageNotedRef.current.add(key);
              notes.push(`Image #${ref.n} (${ref.name}) ${r.why === 'missing' ? `is no longer at ${ref.path}` : 'has changed on disk since it was attached'} — the model gets the text of that message without it.`);
            }
            return { ok: false, why: r.why };
          };

          // ── Live views (src/assistant/views.ts) ── placing what `turnRef`/`liveBuf`/
          // `liveSeen` (declared with the other refs above) collect.
          const callOf = (m: ChatMsg) => (m.views as ViewRecord[] | undefined)?.[0]?.callId ?? m.discardedCallId;
          const placeViews = (recs: ViewRecord[]) => setMessages((cur) => {
            const next = cur.slice();
            for (const rec of recs) {
              const at = next.findLastIndex((m) => callOf(m) === rec.callId);
              // A discarded view keeps its message, drawing nothing: removing it would move
              // the fold id of every message after it.
              const gone = rec.phase === 'discarded';
              const views = gone ? [] : [{ ...rec, turn: turnRef.current }];
              // A new object every time — the row cache is keyed by the message object — and
              // the role it already has (a `!command` stays `shell`).
              if (at >= 0) next[at] = { ...next[at]!, views, ...(gone ? { discardedCallId: rec.callId } : {}) };
              else if (!gone) next.push({ role: 'view', content: '', views });
            }
            return next;
          });
          const flushLive = () => {
            if (liveTimer.current) { clearTimeout(liveTimer.current); liveTimer.current = null; }
            const recs = [...liveBuf.current.values()];
            liveBuf.current.clear();
            if (recs.length) { placeViews(recs); f.notify(); }
          };
          const offerLive = (rec: ViewRecord) => {
            liveBuf.current.set(rec.callId!, rec);
            const first = !liveSeen.current.has(rec.callId!);
            liveSeen.current.add(rec.callId!);
            if (first || rec.phase !== 'live') { flushLive(); return; }
            liveTimer.current ??= setTimeout(flushLive, LIVE_REDRAW_MS);
          };

          const send = async (text: string | null = null, opts: { fromBackground?: boolean } = {}) => {
            const q = (text ?? inputRef.current).trim();
            if (!q || streamRef.current) return false;
            // Close the re-entrancy window SYNCHRONOUSLY, before any await: send() is
            // called from the input handler, the background flush, and the slash
            // command. Without this, a `background` result flushed while the chat is
            // about to go idle could double-fire. (The render also syncs
            // `streamRef.current = streaming`, but that only runs after React commits.)
            streamRef.current = true;
            // System context is assembled WITHOUT network on every message: replace the
            // old (role system) with a fresh one where memory is current (directive+
            // identity+memory). The chat history (user/assistant) is kept.
            const sys = assembleSystem();
            // DISPLAY source vs LLM role are split: a `background` result stays role 'bg'
            // so the render labels it Background (it is NOT the user's own message, and
            // must never render as "You"), while for the model it is still a prompt to
            // answer — apiMsgs maps 'bg' → 'user'. History messages are re-mapped too.
            const history = msgsRef.current.filter(m => m.role !== 'system').map(m => ({ ...m }));
            const apiMsgs: ChatMessage[] = apiHistory(apiRef.current);
            const displayMsgs = [...history];
            if (sys) { displayMsgs.unshift({ role: 'system', content: sys }); apiMsgs.unshift({ role: 'system', content: sys }); }
            if (!opts.fromBackground && historyRef.current.at(-1) !== q) historyRef.current.push(q);
            histAt.current = null;
            histShown.current = '';
            // The images the text names, in the order it names them. A background result
            // is the model's writing and carries none.
            const images = opts.fromBackground ? [] : imagesInText(q, imagesRef.current);
            const asked: ChatMessage = { role: 'user', content: q, ...(images.length ? { images } : {}) };
            apiMsgs.push(asked);
            // What goes to the provider: every image of the history as a part — read now,
            // not kept in the history, which holds its ref.
            const notes: string[] = [];
            const wire = wireMessages(apiMsgs, (ref) => resolveImage(ref, notes));
            const wireHasImages = wire.some((m) => Array.isArray(m.content));
            for (const note of notes) displayMsgs.push({ role: 'note', content: note });
            // On screen the message is its text, with the numbers of the images sent, so
            // their tokens are drawn as attachments.
            displayMsgs.push({ role: opts.fromBackground ? 'bg' : 'user', content: q, ...(images.length ? { images: images.map((r) => r.n) } : {}) });
            // The question joins the model's history now, so a failed or cancelled
            // turn still leaves it on record; the turn's transcript follows on success.
            apiRef.current = [...apiRef.current, asked];
            setMessages(displayMsgs);
            turnRef.current += 1; // views this turn opens are its own, never the last turn's
            persist(); // the question survives a restart even if the answer does not
            setInput('');
            inputRef.current = '';
            setCursor(0);
            setError(null);
            setStreaming(true);
            setPhase('thinking');
            t0Ref.current = Date.now();
            setElapsedMs(0);
            contentRef.current = '';
            setEmptyNotice('');
            setToolCount(0);
            setTurnTokens(0); // what the last turn cost is not what this one costs
            resetStep(); // this turn narrates for itself; its first step is immediate
            // Tick the indicator every 120ms: spinner frame + tenths of a second of
            // whatever is running now (`segRef`), not of the whole turn.
            beginSegment();
            if (tickRef.current) clearInterval(tickRef.current);
            tickRef.current = setInterval(() => setElapsedMs(Date.now() - segRef.current), 120);
            disarmEsc();
            const abort = new AbortController();
            abortRef.current = abort;
            const ai = (f.config.ai ?? {}) as Record<string, any>;
            let failed = false, aborted = false;
            // The loop ran out of rounds with no answer. It is said where the answer
            // would be, in the warn colour, and it replaces the dim line under the
            // field that a wall of grey tool lines used to hide.
            let roundLimit = 0;
            try {
              const chatResult = await (f.services as Record<string, any>).chatLLM(wire, {
                baseUrl: ai.baseUrl,
                model: ai.model,
                token: process.env[ai.tokenEnv ?? 'LLM_TOKEN'],
                signal: abort.signal,
                // Debug-log of tool calls (opt-in: config.debug.logTools).
                logTools: !!((f.config as Record<string, any>)?.debug?.logTools),
                // Plugin ai-tools (aiTools): agentChat runs their own run(args, toolCtx).
                extraTools: (f.services as Record<string, any>).pluginAiTools ?? [],
                // What this conversation has loaded; `tools_load` adds to it mid-turn.
                // The mode (`ai.toolLoading`) is applied by the `chatLLM` service.
                toolSet: toolSetRef.current,
                toolCtx: {
                  plan: planRef.current,
                  shell: shellRef.current,
                  memoryFile: memoryFilePath(f.config),
                  // The plugin's OWN host-issued token. The CALLER never supplies a
                  // name here — a raw plugin-name string is ignored by the memory
                  // tool (it resolves `plugin` scope only through a token the host
                  // issued), so a plugin can present itself but not impersonate one.
                  pluginToken: f.pluginToken,
                  askUser: (questions: AskQuestion[]) => new Promise<AskState>((resolve) => {
                    const state = askStart(questions);
                    askRef.current = { state, resolve };
                    setPendingQuestion(state);
                    f.notify();
                  }),
                  // Every service a tool may call through ctx — flattened, not spread:
                  // `ft.services` is a per-plugin view whose HOST services sit on its
                  // prototype, and `...obj` copies own properties only. Spreading it
                  // silently handed tools a ctx with no chatLLM, config, showMessage or
                  // pushLog — `background` answered "no LLM service" and nothing ran.
                  ...allServices(f.services),
                },
                // The y/n pause on a writing op: agentChat calls confirmWrite for tools
                // with a write-flag, we set pendingRef + pendingAsk and wait for the
                // input-handler to resolve the promise ('y'/Enter — yes, 'n'/Esc — no).
                confirmWrite: (name: string, argsStr: unknown) => new Promise<boolean>((resolve) => {
                  // The one place a confirmation may be answered without the person:
                  // the auto mode (src/assistant/auto.ts), which only `all` ever lets
                  // say yes and never for run_command or an unlisted web_fetch. It
                  // answers BEFORE anything on screen moves — a call that does not
                  // pause must not close the `/context` panel the person is reading.
                  // Nothing here relaxes what agentChat asks about: a tool with no
                  // write flag never reaches this function, and the trail and the ✎
                  // diff block still show what ran.
                  if (autoConfirms(autoModeRef.current, name)) { resolve(true); return; }
                  const args = typeof argsStr === 'string' ? argsStr : JSON.stringify(argsStr ?? '');
                  const command = shellCommandOf(name, args);
                  if (contextOpenRef.current) setContextOpen(false);
                  pendingRef.current = { name, args, resolve };
                  setPendingAsk({ name, args, ...(command != null ? { command } : {}) });
                  f.notify();
                }),
                // A view a tool opened, and every change to it. Its message is pushed on
                // the FIRST change, so it has its place — and its fold id — from the
                // start: a block opened while it ran is still open when it ends.
                onToolLive: (rec: ViewRecord) => offerLive(rec),
                // What a write changed goes on the answer being written the moment the
                // write lands — a block of its own that stays in the chat. Only on the
                // display message: `apiRef` gets the transcript, which never holds it.
                onToolRun: (run: { changes?: ChangeView[] }) => {
                  // The tool is done: until the model's next token it is thinking, and
                  // the seconds on the line are the round's from here.
                  endToolSegment();
                  setPhase('thinking');
                  // Any view this call opened has already been placed by `onToolLive`,
                  // final phase included — flush now rather than waiting on the coalesce
                  // timer, so it is on screen before the next round's tool label appears.
                  flushLive();
                  const added = run.changes ?? [];
                  if (!added.length) { f.notify(); return; }
                  setMessages(cur => {
                    const next = cur.slice();
                    const last = next[next.length - 1];
                    if (last?.role === 'assistant') next[next.length - 1] = { ...last, changes: [...((last.changes as ChangeView[] | undefined) ?? []), ...added] };
                    else next.push({ role: 'assistant', content: '', changes: added });
                    return next;
                  });
                  f.notify();
                },
                onTool: (name: string, args: unknown) => {
                  setToolLabel(`⚙ ${name}(${String(args ?? '').slice(0, 40)})…`);
                  setToolCount(c => c + 1); // call counter for the turn — in the status line
                  beginSegment(); // the seconds on the line are this tool's now
                  f.notify();
                },
                // Diagnostic trace of what EACH round emitted: finish_reason + how many
                // tool_calls streamed. Logged unconditionally so the `l` panel shows
                // whether the model actually attempted a tool call (`finish=tool_calls
                // toolCalls=1`) or just narrated a status change without calling
                // (`finish=stop toolCalls=0`). The missing "▸ tool calls" fold in the
                // chat was AMBIGUOUS — this disambiguates it.
                onRound: (info: { index: number; finishReason: string; toolCalls: number; contentLen: number; usage?: { promptTokens: number; completionTokens: number } }) => {
                  // What the turn costs: a round is billed for its prompt and its
                  // answer, and a turn is several rounds. Only what the provider
                  // actually reported is counted — one that reports nothing leaves the
                  // figure off the screen rather than putting a guess there.
                  if (info.usage) setTurnTokens(turnTokensRef.current + info.usage.promptTokens + info.usage.completionTokens);
                  (f.services as Record<string, any>).pushLog?.(`[round ${info.index}] finish=${info.finishReason} toolCalls=${info.toolCalls} content=${info.contentLen}ch${info.usage ? ` tokens=${info.usage.promptTokens + info.usage.completionTokens}` : ''}`);
                },
                // Round content streams LIVE (the agent calls onLive per token). Which this
                // is — a retelling of moves or the answer — onLiveCommit decides at the end
                // of the round. We accumulate in `live`; while alive it renders in the fold,
                // on commit it goes to `process` (retelling) or `content` (answer).
                // This round carries tool calls — heard the moment the first fragment
                // of one arrives. A model that ignores the `Next:` shape is caught
                // here instead of at the end of the round: whatever of its text is
                // already on screen stays where it is, dim, and the rest of it is
                // never drawn as the answer.
                onRoundKind: () => {
                  roundRef.current.kind = 'notes';
                  setMessages(cur => {
                    const next = cur.slice();
                    const last = next[next.length - 1];
                    if (last?.role === 'assistant' && last.live) next[next.length - 1] = { ...last, liveAs: roundRef.current.drawn ? 'notes' : '' };
                    return next;
                  });
                  f.notify();
                },
                onLive: (delta: string) => {
                  if (!delta) return;
                  endToolSegment(); // the tool is done: the model is writing
                  setPhase('writing');
                  setMessages(cur => {
                    const next = cur.slice();
                    const last = next[next.length - 1];
                    const live = (last?.role === 'assistant' ? (last.live || '') : '') + delta;
                    // What this text is, worked out from the text itself. `unknown` is
                    // the handful of characters that could still turn into `Next:`:
                    // nothing is drawn for them, and that is a few tokens nobody sees
                    // rather than a paragraph that appears and vanishes.
                    const r = roundRef.current;
                    if (r.kind !== 'notes') r.kind = liveKind(live);
                    if (r.kind === 'answer') r.drawn = true;
                    const liveAs: '' | 'answer' | 'notes' = r.kind === 'answer' ? 'answer' : r.drawn ? 'notes' : '';
                    // The step line is NOT offered here: it is worked out when the
                    // round commits (`onLiveCommit`). Offering it per token schedules
                    // the floor's timer per token, and the line then lands on a
                    // message the next token has already replaced.
                    if (last?.role === 'assistant') next[next.length - 1] = { ...last, live, liveAs };
                    else next.push({ role: 'assistant', content: '', live: delta, liveAs });
                    return next;
                  });
                },
                // reasoning and content arrive in one chunk as parallel streams: we
                // accumulate reasoning in a separate message field (not content!).
                onReasoning: (delta: string) => {
                  endToolSegment(); // the tool is done: the model is thinking
                  setPhase('thinking');
                  setMessages(cur => {
                    const next = cur.slice();
                    const last = next[next.length - 1];
                    if (last?.role === 'assistant') next[next.length - 1] = { ...last, reasoning: (last.reasoning || '') + delta };
                    else next.push({ role: 'assistant', content: '', reasoning: delta });
                    return next;
                  });
                },
                // End of a round: where to put the live content. isAnswer=true — the final
                // answer (in content), false — the retelling of moves (in process).
                onLiveCommit: (text: string, isAnswer: boolean) => {
                  // contentRef is fixed SYNCHRONOUSLY (not in the setMessages updater):
                  // react defers the updater to render, while send() reads contentRef in
                  // finally right after await — there it would still be empty, and the
                  // «limit of steps» warning popped even on a normal answer.
                  if (isAnswer) contentRef.current = text;
                  // The rounds of narration are kept APART: appended with nothing
                  // between them their sentences ran together ("…there are.Now I will
                  // count them…"), in the fold and in the step line alike. The step is
                  // worked out here rather than in the updater below, which react may
                  // call more than once and which must stay a pure function of the list.
                  const narration = isAnswer ? '' : joinNarration(narrationRef.current, text);
                  if (!isAnswer) narrationRef.current = narration;
                  const step = isAnswer ? '' : advanceStep(narration);
                  // Narration that was DRAWN before its round was known stays where it
                  // was drawn: the commit moves it into the fold as it always did, and
                  // keeps a copy here so the rows the person was reading do not go.
                  const keep = !isAnswer && roundRef.current.drawn ? text : '';
                  resetRound();
                  setMessages(cur => {
                    const next = cur.slice();
                    const last = next[next.length - 1];
                    if (last?.role !== 'assistant') {
                      // A fresh message (a tool's view landed under the last one): it
                      // carries this round's narration only, while the step line stays
                      // the turn's — the last thing it said it is doing.
                      next.push({ role: 'assistant', content: isAnswer ? text : '', process: isAnswer ? '' : text, ...(isAnswer ? {} : { step, ...(keep ? { shown: keep } : {}) }) });
                      return next;
                    }
                    if (isAnswer) {
                      // The answer is only added to, never replaced: the rows stay
                      // exactly as they were drawn and simply stop being provisional.
                      next[next.length - 1] = { ...last, content: text, live: '', liveAs: '' };
                    } else {
                      next[next.length - 1] = {
                        ...last, process: joinNarration(last.process, text), live: '', liveAs: '', step,
                        ...(keep ? { shown: joinNarration(last.shown as string | undefined, keep) } : {}),
                      };
                    }
                    return next;
                  });
                },
              });
              (f.services as Record<string, any>).pushLog?.(`[chat] ${q.slice(0, 40)}… → ${q.length} chars${images.length ? ` + ${images.length} image${images.length === 1 ? '' : 's'}` : ''}`);
              // A persistent trail of executed tools: put it on the last assistant message
              // so the render shows «▸ update_issue … → applied/declined/error».
              roundLimit = Number((chatResult as { roundLimit?: number } | undefined)?.roundLimit ?? 0);
              const turn = (chatResult as { transcript?: ChatMessage[]; content?: string } | undefined);
              const reported = (chatResult as { usage?: { promptTokens: number; completionTokens: number } } | undefined)?.usage;
              if (reported) usageRef.current = reported;
              apiRef.current = [
                ...apiRef.current,
                ...(turn?.transcript?.length ? turn.transcript : [{ role: 'assistant', content: turn?.content ?? '' }]),
              ];
              const runs = (chatResult as { toolRuns?: unknown[] } | undefined)?.toolRuns ?? [];
              if (runs.length) {
                setMessages(cur => {
                  const next = cur.slice();
                  const at = answerAt(next);
                  if (at >= 0) next[at] = { ...next[at]!, toolRuns: runs };
                  return next;
                });
              }
              // After a real write the plugins reload what they show — otherwise an open
              // document keeps the text from before the write. It does not close the chat.
              if (runs.some(r => (r as { write?: boolean; outcome?: string }).write && (r as { outcome?: string }).outcome === 'applied')) {
                void (f.services as { afterWrite?: () => Promise<void> }).afterWrite?.();
              }
            } catch (e) {
              // Esc during a stream is an expected cancel (AbortError) — not shown as an
              // error in the panel, but logged quietly.
              if ((e as Error)?.name === 'AbortError') {
                aborted = true;
                (f.services as Record<string, any>).pushLog?.('[chat] aborted by user');
              } else {
                failed = true;
                setError((e as Error).message);
                (f.services as Record<string, any>).pushLog?.(`[chat] error: ${(e as Error).message}`);
                // A model that cannot take images answers the first one with a 400. Said
                // once, in the provider's words, with the one switch that stops it — the
                // image stays in the history, so every later message would fail the same.
                const why = String((e as Error)?.message ?? '');
                if (wireHasImages && isImageRefusal(why) && !imageRefusalSaidRef.current) {
                  imageRefusalSaidRef.current = true;
                  setMessages((cur) => [...cur, { role: 'note', content: `The provider refused the image: ${why.slice(0, 300)}\nIf this model cannot take images: config set ai.images.enabled false — images already in the conversation then go as their names only.` }]);
                }
              }
              // The question is already in the model's history; left there alone it is a
              // question still waiting, and the next request shows the model two in a row —
              // it answers both, and goes back to the work the person stopped. So the
              // turn is closed in the model's own voice, after the tool calls that did
              // run (a write that landed before Esc happened; `apiHistory` drops a call
              // left without its result). Stopped: not to be picked up again unless
              // asked. Failed: said as a failure, so a retry the person asks for reads as
              // one. Model-side only — the screen says `stopped (Esc)` or the error.
              apiRef.current = [
                ...apiRef.current,
                ...transcriptSoFar(e),
                { role: 'assistant', content: aborted ? STOPPED_TURN : failedTurn((e as Error)?.message) },
              ];
            } finally {
              if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
              // The TURN's seconds — what the answer's quiet line keeps. The status
              // line's own number was the last running thing's and is gone with it.
              const finalMs = Date.now() - t0Ref.current;
              // Bind the TURN's duration and what it cost to this turn's answer (the
              // persistent «· 12.4 s · 3.1k tok» — read after the fact, where the
              // status line was about what was running), and mark an answer stopped
              // with Esc: cut short, «The» reads like a whole (and odd) answer unless
              // the line under it says it was stopped.
              const spent = turnTokensRef.current;
              setMessages(cur => {
                const next = cur.slice();
                const at = answerAt(next);
                if (at >= 0) next[at] = { ...next[at]!, duration: finalMs, ...(spent ? { tokens: spent } : {}), ...(aborted ? { stopped: true } : {}), ...(roundLimit ? { roundLimit } : {}) };
                return next;
              });
              // Empty answer: the model gave only reasoning but no final text — say so
              // explicitly. Error and cancel (Esc) are not an empty answer — they
              // already have their own indication (⚠ error / quiet log); neither is a
              // turn that ran out of rounds, which now says so in the conversation
              // itself, where the answer would have been.
              if (!contentRef.current.trim() && !failed && !aborted && !roundLimit) {
                const opens = firstGlyph(f.keys.details);
                setEmptyNotice(`The turn ended without a final answer — only reasoning came back${opens ? ` (${opens} shows it)` : ''}. Narrow the question, or say "continue".`);
              }
              // Sync streamRef to false HERE, not just via the render
              // (line ~128 streamRef.current = streaming). If a render is ever
              // skipped — chat closed mid-turn, a runtime batching quirk, an
              // aborted turn that does not commit — streamRef would stay true
              // forever and flushPending would defer EVERY background result
              // permanently (the chat "stops working" after the first answer).
              // streamRef now mirrors the stream lifecycle synchronously: true
              // from its top guard (line ~225), false again when the stream ends.
              streamRef.current = false;
              // A plan finished in this turn has nothing left to show: all it would say is
              // "N done", hanging over the next question. It goes when the answer ends (as
              // in Claude Code); a plan with anything still open stays.
              {
                const items = planRef.current.snapshot();
                if (items.length && items.every((t) => t.status === 'done')) planRef.current.reset();
              }
              flushLive();
              persist();
              setStreaming(false);
              setToolLabel('');
              abortRef.current = null;
              // The person's queued messages go first, in order; a cancelled turn
              // keeps them queued rather than firing into a conversation just stopped.
              if (!aborted && queueRef.current.length) {
                const nextQueued = queueRef.current.shift() as string;
                syncQueue();
                setTimeout(() => { void send(nextQueued); }, 0);
              } else {
                // A background result that arrived mid-turn lands the moment the turn
                // ends, not on the flush timer's next 400 ms tick.
                setTimeout(() => flushPending(), 0);
              }
            }
            return true;
          };

          // ── `!command` — the person runs a shell command (src/assistant/shell.ts) ──
          // The chat is busy exactly as while an answer is written — the same spinner,
          // and Esc stops it — but no model turn is spent: the result joins the model's
          // history and is read with the person's next message, as a background result is.
          const runShellCommand = async (cmd: string) => {
            if (streamRef.current) { setError('an answer or a command is still running — wait, or stop it with Esc'); return; }
            if (!cmd) { setError('! runs a shell command — e.g. !git status'); return; }
            streamRef.current = true; // closed synchronously, as in send()
            const line = `!${cmd}`;
            if (historyRef.current.at(-1) !== line) historyRef.current.push(line);
            histAt.current = null;
            histShown.current = '';
            // The field is emptied now: Esc clears a non-empty field before it stops anything.
            setInput(''); inputRef.current = ''; setCursor(0);
            setError(null);
            setEmptyNotice('');
            setToolCount(0);
            setStreaming(true);
            setToolLabel(`$ ${cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd}`);
            t0Ref.current = Date.now();
            // The command is the only thing running, so the segment is the whole of it.
            beginSegment();
            if (tickRef.current) clearInterval(tickRef.current);
            tickRef.current = setInterval(() => setElapsedMs(Date.now() - segRef.current), 120);
            disarmEsc();
            const abort = new AbortController();
            abortRef.current = abort;
            const cwd = shellRef.current.cwd();
            const { timeoutMs, maxChars } = shellLimits(f.config as { shell?: unknown });
            let stopped = false;
            try {
              // The person's command gets the same live block as the model's. The
              // message is still role `shell`: it joins apiRef and ↑/↓ as it always did.
              const startedAt = Date.now();
              const callId = `shell#${startedAt}`;
              const liveRec = (data: unknown, phase: ViewRecord['phase'] = 'live'): ViewRecord => ({ kind: 'console', data, phase, startedAt, callId });
              liveSeen.current.add(callId);
              setMessages((cur) => [...cur, { role: 'shell', content: '', command: cmd, views: [{ ...liveRec({ command: cmd, cwd: tildePath(cwd), text: '', showCwd: true }), turn: turnRef.current }] }]);
              let raw = '';
              const onOutput = (chunk: string) => {
                raw += chunk;
                if (raw.length > maxChars * 2) raw = raw.slice(-maxChars);
                offerLive(liveRec({ command: cmd, cwd: tildePath(cwd), text: capConsoleText(raw), showCwd: true }));
              };
              const r = await runShell(cmd, { cwd, timeoutMs, maxChars, signal: abort.signal, onOutput });
              stopped = r.stopped;
              // `cd` sticks, as in a terminal — within the roots.
              const move = nextCwd(f.config as Record<string, unknown>, cwd, r.pwd);
              if (move.cwd !== cwd) shellRef.current.setCwd(move.cwd);
              const { display, forModel } = formatShell(cmd, r, cwd, timeoutMs, { after: move.cwd, note: move.note });
              flushLive();
              // The block says where a `cd` inside the command left the directory — or
              // that one tried to leave the roots and stayed — the same facts the old
              // markdown line carried, now on the live view instead.
              const data = consoleData(cmd, r, cwd, timeoutMs, true, { movedTo: tildePath(move.cwd), note: move.note });
              setMessages((cur) => {
                const next = cur.slice();
                const at = next.findLastIndex((m) => callOf(m) === callId);
                const done = { role: 'shell', content: display, command: cmd, views: [{ ...liveRec(data, 'done'), turn: turnRef.current }] };
                if (at >= 0) next[at] = done; else next.push(done);
                return next;
              });
              apiRef.current = [...apiRef.current, { role: 'shell', content: forModel }];
              (f.services as Record<string, any>).pushLog?.(`[shell] ${cmd.slice(0, 60)} → ${r.error ? `error: ${r.error}` : r.stopped ? 'stopped' : r.timedOut ? 'timed out' : `exit ${r.code}`}`);
            } catch (e) {
              setError(`!: ${(e as Error).message}`);
            } finally {
              if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
              setElapsedMs(Date.now() - t0Ref.current);
              streamRef.current = false;
              flushLive();
              persist();
              setStreaming(false);
              setToolLabel('');
              abortRef.current = null;
              // What the person queued meanwhile goes out now — unless they stopped the
              // command, as a stopped answer keeps the queue.
              if (!stopped && queueRef.current.length) {
                const nextQueued = queueRef.current.shift() as string;
                syncQueue();
                setTimeout(() => { void send(nextQueued); }, 0);
              } else {
                setTimeout(() => flushPending(), 0);
              }
              f.notify();
            }
          };

          // ── in-chat commands ── `/context` says how full the model's context is,
          // `/compact` replaces the history with a summary (a one-shot non-streaming
          // call), `/clear` starts over. There is no `/refresh-context`: the system
          // prompt is assembled anew for every message, so there was nothing to refresh.

          // ── generic async slash command ──────────────────────────────────────────
          // Runs a slash command asynchronously, NON-BLOCKING, using the SAME live
          // spinner as an LLM round («⚙ <label>…» + the elapsed tick via t0/tick/
          // elapsed): the chat stays interactive while the command works. A long-running
          // plugin command runs through this helper. Guards
          // on an active stream — one activity at a time.
          const runAsyncCommand = (label: string, fn: () => Promise<void>): void => {
            if (streamRef.current) return;
            setError(null);
            setStreaming(true);
            setToolLabel(`⚙ ${label}…`);
            t0Ref.current = Date.now();
            beginSegment(); // the command is the one thing running
            if (tickRef.current) clearInterval(tickRef.current);
            tickRef.current = setInterval(() => setElapsedMs(Date.now() - segRef.current), 120);
            fn()
              .catch((e) => setError((e as Error).message))
              .finally(() => {
                if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
                setElapsedMs(Date.now() - t0Ref.current);
                setStreaming(false);
                setToolLabel('');
              });
          };

          const compactNow = () => {
            if (streamRef.current || apiRef.current.length < 2) return;
            // The command body; the spinner/label/elapsed-tick live in
            // runAsyncCommand, which clears streaming/toolLabel on completion.
            runAsyncCommand('compact', async () => {
              const ai = (f.config.ai ?? {}) as Record<string, any>;
              // Compact what the MODEL saw (tool results included), not the display list.
              const summary = await compactConversation(apiHistory(apiRef.current), {
                baseUrl: ai.baseUrl,
                model: ai.model,
                token: process.env[ai.tokenEnv ?? 'LLM_TOKEN'],
              });
              summaryRef.current = summaryRef.current ? `${summaryRef.current}\n\n${summary}` : summary;
              usageRef.current = null; // the measured size was of the history just replaced
              apiRef.current = [];
              // The loaded tools stay (`toolSetRef`): the work the summary describes goes on
              // with them, and loading them again would spend a round for nothing.
              // What the MODEL sees shrank to the summary; what the PERSON sees stays —
              // the conversation above is theirs to scroll. (It used to be wiped down to
              // the last message, which read as /clear.) A note marks where the model's
              // view now begins and shows the summary it was given.
              setMessages((cur) => [...cur, { role: 'note', content: `── compacted ── the model now sees a summary of everything above, not the messages themselves:\n${summary}` }]);
              persist();
              setInput('');
              inputRef.current = '';
              setCursor(0);
              (f.services as Record<string, any>).showMessage?.('History compacted');
            });
          };

          // ── Attaching an image ── a dropped or pasted path, `/image`, Ctrl+V. What the
          // person attaches goes into the field as a token, `[Image #N]`, at `base` (the
          // field as it stands, or an empty one for `/image`); a refusal says why, and
          // nothing is attached — never a file shrunk or dropped quietly.
          type ImagesRead = { images: false; error: string } | { images: true; loaded: LoadedOk[]; refusal: string | null };
          const readImages = (paths: string[], base: string): ImagesRead => {
            const lim = imageLimits(f.config.ai);
            const loaded = paths.map((p) => loadImageFile(p, shellRef.current.cwd(), lim.maxBytes));
            // A file that is not there, or not an image: these are not images being
            // attached — a paste of them is text, `/image` names the first.
            const other = loaded.find((l) => !l.ok && l.reason !== 'too-big');
            if (other && !other.ok) return { images: false, error: other.error };
            if (!lim.enabled) return { images: true, loaded: [], refusal: IMAGES_OFF };
            const big = loaded.find((l) => !l.ok);
            if (big && !big.ok) return { images: true, loaded: [], refusal: big.error };
            const count = imagesInText(base, imagesRef.current).length + loaded.length;
            if (count > lim.maxPerMessage) return { images: true, loaded: [], refusal: `a message carries at most ${lim.maxPerMessage} image${lim.maxPerMessage === 1 ? '' : 's'} (ai.images.maxPerMessage) — this one would have ${count}` };
            return { images: true, loaded: loaded as LoadedOk[], refusal: null };
          };
          const attach = (loaded: LoadedOk[], base: { value: string; cursor: number }) => {
            let at = base;
            for (const l of loaded) {
              const ref: ImageRef = { n: ++imageSeqRef.current, ...l.ref };
              imagesRef.current.set(ref.n, ref);
              // Read once, here: the bytes the person attached are the ones sent.
              imageDataRef.current.set(imageKey(ref), dataUrl(ref.mime, l.data));
              at = insertToken(at.value, at.cursor, ref.n);
            }
            tabRef.current = null;
            histAt.current = null;
            setInput(at.value); inputRef.current = at.value;
            setCursor(at.cursor); cursorRef.current = at.cursor;
            setError(null);
            disarmEsc();
            f.notify();
          };
          // A paste that is paths, all of them images, attaches them. true — handled; false
          // — the paste is text and goes in as it is (after a refusal is said, too: the
          // path stays in the field, nothing the person pasted is lost).
          const pasteImages = (text: string): boolean => {
            for (const paths of pastedPaths(text)) {
              const r = readImages(paths, inputRef.current);
              if (!r.images) continue;
              if (r.refusal) { setError(`not attached: ${r.refusal}`); return false; }
              attach(r.loaded, { value: inputRef.current, cursor: cursorRef.current });
              return true;
            }
            return false;
          };
          // The image on the clipboard. From a key (Ctrl+V, an empty paste) an empty
          // clipboard is a short hint and nothing else; from `/image` it is said in the chat.
          const attachClipboard = (from: 'key' | 'command') => {
            if (!imageLimits(f.config.ai).enabled) { setError(`not attached: ${IMAGES_OFF}`); return; }
            const read = (f.services as { clipboardImage?: () => ClipboardImage }).clipboardImage ?? (() => readClipboardImage());
            const clip = read();
            if (!clip.ok) {
              if (from === 'key' && clip.none) (f.services as Record<string, any>).showMessage?.(clip.error);
              else setError(`not attached: ${clip.error}`);
              return;
            }
            const base = from === 'command' ? { value: '', cursor: 0 } : { value: inputRef.current, cursor: cursorRef.current };
            const r = readImages([clip.path], base.value);
            if (!r.images) { setError('not attached: what the clipboard gave is not an image'); return; }
            if (r.refusal) { setError(`not attached: ${r.refusal}`); return; }
            attach(r.loaded, base);
          };
          // A field that is a /command or a !command, or in shell mode, is not a message:
          // an image has nowhere to go there, and a pasted path is the command's argument.
          const fieldTakesImages = () => !shellModeRef.current && !/^\s*[/!]/.test(inputRef.current);

          const runChatCommand = (cmd: string) => {
            const [name, ...rest] = cmd.split(/\s+/);
            const arg = rest.join(' ');
            switch (name) {
              case 'auto': {
                // How much runs without a y/n, for this conversation. `reads`, `all` or
                // `off`; the bare command takes the next rung, as the key does.
                const want = autoCommand(arg);
                if (!want) { setError('/auto takes reads, all or off — or nothing to step to the next one'); return; }
                const next = want === 'cycle' ? nextAutoMode(autoModeRef.current) : want;
                setAutoMode(next);
                setField('');
                (f.services as Record<string, any>).showMessage?.(autoSaid(next));
                f.notify();
                return;
              }
              case 'notes': {
                // How the narration is drawn, for THIS conversation. The config key is
                // where a conversation starts; this moves it from there and nothing is
                // saved — /clear comes back to the config's own answer. The bare
                // command says where things stand rather than guessing at a next rung:
                // four modes have no obvious order to step through.
                const want = notesCommand(arg);
                if (!want) { setError('/notes takes step, fold, open or hidden — or nothing to say which is on'); return; }
                const next = want === 'say' ? notesRef.current : want;
                setNotes(next);
                setField('');
                (f.services as Record<string, any>).showMessage?.(notesSaid(next));
                f.notify();
                return;
              }
              case 'fullscreen': {
                // For the person; nothing is sent. `on`/`off`, or a toggle with no word.
                const v = arg.trim().toLowerCase();
                if (v && v !== 'on' && v !== 'off') { setError('/fullscreen takes on or off, or nothing to toggle'); return; }
                const next = v === 'on' ? true : v === 'off' ? false : !fullscreenRef.current;
                fullscreenRef.current = next;
                setFullscreenState(next);
                setField('');
                f.notify();
                return;
              }
              case 'log': {
                const svc = f.services as Record<string, any>;
                const shared = logShareMessage((svc.log?.read?.() ?? svc.logs ?? []) as string[], arg);
                if (shared) void send(shared); else setError('the log is empty — nothing to share');
                return;
              }
              case 'memory': {
                // The person's own view of the model's memory; nothing here reaches the
                // model. A `note` is a display-only message: `apiRef` — the model's
                // history — is not touched.
                const file = memoryFilePath(f.config);
                const res = memoryCommand(arg, loadMemories(file));
                if (res.next) saveMemories(res.next, file);
                setMessages((cur) => [...cur, { role: 'note', content: res.note }]);
                setField('');
                f.notify();
                return;
              }
              case 'resume': {
                // The saved sessions; with a number — go back to that one. The session
                // being left is written first, so it is on the list to come back to.
                if (!sessDir) { setError('sessions are not saved here (no sessions directory)'); return; }
                writeSession();
                const list = listSessions(sessDir);
                const n = Number(arg.trim());
                if (!arg.trim()) {
                  const lines = list.slice(0, 15).map((s, i) => `${i + 1}. ${s.title || '(untitled)'} — ${sessionWhen(s.updatedAt)}, ${s.turns} message${s.turns === 1 ? '' : 's'}${s.id === sessionIdRef.current ? ' · this one' : ''}`);
                  setMessages((cur) => [...cur, { role: 'note', content: lines.length ? `Sessions (newest first) — /resume <number> opens one:\n${lines.join('\n')}` : 'No saved sessions yet.' }]);
                  setField('');
                  f.notify();
                  return;
                }
                const pick = Number.isInteger(n) && n >= 1 ? list[n - 1] : undefined;
                if (!pick) { setError(`/resume takes a number from the list (1–${list.length})`); return; }
                if (streamRef.current) { setError('an answer is still coming — stop it (Esc) before switching sessions'); return; }
                const s = loadSession(sessDir, pick.id);
                if (!s) { setError('that session file cannot be read'); return; }
                dismissAsk();
                queueRef.current = []; setQueued([]); bgQueueRef.current = [];
                setError(null); setEmptyNotice(''); setToolLabel(''); setToolCount(0);
                applySession(s);
                (f.services as Record<string, any>).showMessage?.(`Resumed «${s.title || 'session'}»`);
                f.notify();
                return;
              }
              case 'clear':
                // Full session reset: clear not only messages but everything that would
                // survive a rebuild — emptyNotice, the tool name/counter, the time, the
                // stream/tick, the context. The session is written and left for /resume
                // — closed, so a restart does not bring back what was just cleared;
                // what follows is a new one.
                writeSession();
                if (sessDir && sessionIdRef.current) { try { closeSession(sessDir, sessionIdRef.current); } catch { /* not fatal */ } }
                sessionIdRef.current = ''; createdAtRef.current = '';
                if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
                abortRef.current?.abort(); abortRef.current = null;
                if (pendingRef.current) settleConfirm(false);
                dismissAsk();
                ctxSubjectRef.current = null;
                contentRef.current = '';
                // A cleared session must not have a pre-clear background result surface in
                // the fresh chat: drop any queued-but-unsent delivery and stop the flush
                // interval. (A task still RUNNING delivers after /clear — that is a new,
                // legitimate result; only already-queued pending ones are stale.)
                bgQueueRef.current = [];
                clearFlush();
                apiRef.current = []; summaryRef.current = ''; queueRef.current = []; setQueued([]);
                // A new conversation starts with no plan: the old one described work the
                // model no longer remembers.
                planRef.current.reset();
                shellRef.current.setCwd(null); // back to the first root
                toolSetRef.current.reset(); // a new conversation starts from the index
                liveSeen.current.clear(); liveBuf.current.clear(); // the calls they tracked are gone with the conversation
                resetImages(); // numbering starts again at [Image #1]
                usageRef.current = null; // measured for a conversation that is gone
                // /clear ends the conversation, not the memory — and says so, or the
                // assistant "still knowing" an earlier prompt reads as /clear failing.
                {
                  const kept = keptAfterClear(loadMemories(memoryFilePath(f.config)));
                  setMessages(kept ? [{ role: 'note', content: kept }] : []);
                }
                setInput(''); inputRef.current = '';
                setCursor(0);
                setShellMode(false); // a fresh conversation opens on a plain prompt
                setAutoMode('ask'); // and asks again: the mode was granted for the work just cleared
                setNotes(configNotes()); // the narration goes back to what the config asks for
                resetStep(); // the step line described work that is gone
                setError(null);
                setEmptyNotice('');
                setToolCount(0);
                setToolLabel('');
                setElapsedMs(0);
                setFolds(allFolded()); // everything folded again, and no exceptions left over
                setStreaming(false);
                disarmEsc();
                f.notify();
                return;
              case 'context':
                // For the person; nothing is sent and nothing joins the conversation.
                setField('');
                setContextOpen(true);
                return;
              case 'copy': {
                // For the person; nothing is sent and nothing joins the conversation.
                const target = copyTarget(messages as { role?: string; content?: unknown }[], arg);
                if ('error' in target) { setError(target.error); return; }
                // The terminal's clipboard sequence where there is one, the platform's tool
                // where not (`services.copy`); what was copied is said here, once.
                const done = (f.services as { copy?: (t: string) => { ok: boolean; error?: string } }).copy?.(target.text) ?? copyToClipboard(target.text);
                if (!done.ok) { setError(`/copy: ${done.error}`); return; }
                setField('');
                (f.services as Record<string, any>).showMessage?.(`Copied ${target.what} — ${Array.from(target.text).length} chars`);
                f.notify();
                return;
              }
              case 'image': {
                // `/image <path>` attaches a file; `/image` alone, the clipboard's image. The
                // field held the command, so the token starts a fresh one.
                const raw = cmd.slice('image'.length).trim();
                if (!raw) { attachClipboard('command'); return; }
                const readings = pastedPaths(raw, { anyPath: true });
                let first: ImagesRead | null = null;
                for (const paths of readings) {
                  const r = readImages(paths, '');
                  first ??= r;
                  if (!r.images) continue;
                  if (r.refusal) { setError(`not attached: ${r.refusal}`); return; }
                  attach(r.loaded, { value: '', cursor: 0 });
                  return;
                }
                const why = first && !first.images ? first.error : undefined;
                setError(`not attached: ${why ?? `no image at ${raw}`}`);
                return;
              }
              case 'compact': compactNow(); return;
              case 'exit': closeChat(); return;
              default: setError(`unknown command /${name} — available: ${CHAT_COMMANDS.map(c => `/${c}`).join(', ')}`); return;
            }
          };

          // Closing does NOT abort the stream: the chat component is always mounted, the
          // answer finishes «in the background» and is visible on re-open. Session is not
          // cleared. Closing via Esc//exit just disarms the exit and hides the panel.
          const closeChat = () => {
            disarmEsc();
            // Closing during a y/n pause: do not wait — decline the op, else the
            // confirmWrite promise would hang and the stream never finish.
            if (pendingRef.current) settleConfirm(false);
            dismissAsk();
            writeSession(); // the draft too
            setOpen(false);
            openRef.current = false; // the background flush may fire before the next render
            publish({ open: false });
            f.notify();
          };

          const openChat = (initialText?: string) => {
            const subject = (f.services as { chatSubject?: () => string | null }).chatSubject?.() ?? null;
            // A change of subject — a new session (fresh context); re-opening on the same
            // subject continues the history, nothing is cleared.
            if (subject !== ctxSubjectRef.current) {
              // The conversation about the other task is saved and stays on /resume.
              const had = msgsRef.current.some((m) => m.role === 'user');
              writeSession();
              sessionIdRef.current = ''; createdAtRef.current = '';
              if (had) (f.services as Record<string, any>).showMessage?.(`A new session for ${subject ?? 'no task'} — /resume goes back to the previous one`);
              ctxSubjectRef.current = subject;
              apiRef.current = []; summaryRef.current = ''; queueRef.current = []; setQueued([]);
              usageRef.current = null;
              planRef.current.reset();
              shellRef.current.setCwd(null);
              toolSetRef.current.reset();
              liveSeen.current.clear(); liveBuf.current.clear(); // the calls they tracked belong to the other task
              resetImages();
              setAutoMode('ask'); // the new task has not been given the old one's leeway
              setNotes(configNotes()); // nor kept the narration the old one was set to
              resetStep();
              setFolds(allFolded()); // the blocks a click had opened belong to the other task
              msgsRef.current = [];
              setMessages([]);
              // Task change — a new session: reset the status fields too, else the
              // «limit of steps» warning / tool name from the old task moves into the new.
              setEmptyNotice('');
              setToolLabel('');
              setToolCount(0);
            }
            setOpen(true);
            openRef.current = true;
            setUnread(0);
            unreadRef.current = 0;
            publish({ open: true, unread: 0 });
            setError(null);
            // Only a caller that brings text replaces the field: re-opening the chat
            // keeps the draft the person left in it.
            if (initialText !== undefined) {
              setInput(initialText);
              inputRef.current = initialText;
              setCursor(Array.from(initialText).length);
            }
            disarmEsc();
            f.notify();
            if (initialText?.trim()) send(initialText);
          };

          (f.store as Record<string, any>).chat = { open, unread, openChat, closeChat, send, messages, streaming, toolLabel, cursor, escArmed, pendingConfirm: pendingAsk };
          // Lands the next background result. It is SHOWN as soon as no turn is being
          // written (a streaming turn keeps rewriting the display list's last message,
          // so a result cannot be appended under it) — a half-typed draft does not hold
          // it back, the chat is not opened for it, and no model turn is spent on it:
          // the result joins the model's history and is read with the person's next
          // message. With the chat closed it is counted as unread for the footer.
          //
          // `ai.backgroundFollowUp: true` opts back into the assistant reacting by
          // itself — a turn per result — and then only with the chat open, the field
          // empty and nothing queued, so it never talks over the person.
          flushPending = () => {
            if (streamRef.current) return;
            const q = bgQueueRef.current[0];
            if (q == null) { clearFlush(); return; }
            const followUp = (f.config.ai as { backgroundFollowUp?: unknown } | undefined)?.backgroundFollowUp === true;
            if (followUp && openRef.current && !inputRef.current && !queueRef.current.length) {
              bgQueueRef.current.shift();
              void send(q, { fromBackground: true });
              return;
            }
            bgQueueRef.current.shift();
            setMessages((cur) => [...cur, { role: 'bg', content: q }]);
            apiRef.current = [...apiRef.current, { role: 'bg', content: q }];
            persist();
            if (!openRef.current) {
              unreadRef.current += 1;
              setUnread(unreadRef.current);
              publish({ unread: unreadRef.current });
              // Nobody is looking at the chat: say so beyond the footer counter.
              (f.services as { alert?: (title: string, body?: string) => void }).alert?.('flow-assist', String(q).split('\n')[0].slice(0, 120));
            }
            f.notify();
          };
          // A host-reachable channel to inject a message into the chat from OUTSIDE
          // (e.g. a `background` task's result). Registered per render (idempotent) so
          // a detached timer reads the latest closure — the same live-reference pattern
          // as the React-bound services. Reads live state via refs, so an old closure is
          // still current. Results are QUEUED, not dropped: if the chat is busy (mid-
          // answer or drafting), the result waits here and is auto-analyzed when the
          // chat goes idle — so a back-to-back burst of background tasks all land.
          (f.services as Record<string, any>).postToChat = (text: string) => {
            const q = String(text ?? '').trim();
            if (!q) return;
            bgQueueRef.current.push(q);
            if (!flushTimer.current) flushTimer.current = setInterval(() => flushPending(), 400);
            flushPending();
          };
          // While the chat is open it owns the KEYBOARD: priority 100 (like log/tags).
          // The host dims the overlay-detail via ui.modalActive, so its consumer (also
          // 100) does not contend for 'r'/'c' etc.
          f.useInputHandler({
            mode: 'consume',
            priority: (ui) => ui.cmdOpen ? 0 : (open ? 100 : 0),
            // A mouse button reaches THIS handler and no other (`twoPhaseDispatch`
            // drops one before every handler that was written for keys). It is read
            // here alone because the conversation is the only thing on screen that
            // knows what is under the pointer.
            mouse: true,
            handler: (key) => {
              if (!open) return false;
              // A press, a drag or a release. It is consumed only when it actually
              // folded something: a drag that reported "handled" per dragged cell
              // would cost a re-render a cell, and every other click must be free.
              if (isMouseButton(key.name)) return mouse(key);
              // While awaiting a write confirmation (y/n pause), the chat consumes ALL
              // keys: 'y'/⏎ — confirm, 'n'/Esc — decline; normal field input is paused.
              // An open question consumes every key too: arrows/digits/Space/⏎ answer it,
              // Esc dismisses it, and in the free-text field every printable key is text.
              if (askRef.current) {
                // The same width the block draws its field in, so the caret moves the
                // way it is shown to move.
                const next = askKey(askRef.current.state, key, askFieldWidth(chatWrapWidth(width, fullscreenRef.current)));
                if (next.done) settleAsk(next);
                else { askRef.current.state = next; setPendingQuestion(next); f.notify(); }
                return true;
              }
              // The context panel holds the keys while it is up; Esc or ⏎ put it away.
              if (contextOpenRef.current) {
                if (key.name === 'escape' || key.name === 'return') setContextOpen(false);
                return true;
              }
              if (pendingRef.current) {
                if (key.name === 'escape' || key.name === 'n') { settleConfirm(false); return true; }
                if (key.name === 'y' || key.name === 'return') { settleConfirm(true); return true; }
                return true;
              }
              // Any key except the second Esc disarms the exit.
              if (key.name !== 'escape' && escArmAt > 0) disarmEsc();
              // ── Shell mode: `!` on an EMPTY, non-shell field switches the prompt
              // instead of being typed — the field never holds the `!` itself, unlike
              // the legacy path below. After other text, or already in the mode, `!`
              // falls through to the editor as a plain character (a shell command may
              // start with one). Backspace on an empty shell-mode field leaves the mode
              // without deleting anything else — there is nothing there to delete.
              if (key.name === '!' && !key.ctrl && !key.meta && !shellMode && inputRef.current === '') {
                setShellMode(true);
                return true;
              }
              if (key.name === 'backspace' && shellMode && inputRef.current === '') {
                setShellMode(false);
                return true;
              }
              // ── Images. A paste is ONE key and is matched as one — never decoded into
              // characters. An empty paste is the only thing a terminal sends for Cmd+V
              // when the clipboard holds an image and no text (most send nothing at all),
              // so it means "the clipboard's image", as Ctrl+V does. A paste that is the
              // path of an image file (a file dragged onto the terminal arrives as one)
              // attaches it; any other paste goes to the editor below as text.
              if (key.name === 'paste') {
                const pasted = String(key.text ?? '');
                if (!pasted.trim()) { if (fieldTakesImages()) attachClipboard('key'); return true; }
                if (fieldTakesImages() && pasteImages(pasted)) return true;
              }
              if (key.name === 'v' && key.ctrl && !key.meta) {
                if (fieldTakesImages()) attachClipboard('key');
                return true;
              }
              // A token goes whole: Backspace right after it, Delete right before it.
              if ((key.name === 'backspace' || key.name === 'delete') && !key.ctrl && !key.meta) {
                const cut = removeTokenAt(inputRef.current, cursorRef.current, key.name === 'backspace' ? 'back' : 'forward', (n) => imagesRef.current.has(n));
                if (cut) {
                  tabRef.current = null;
                  disarmEsc();
                  setInput(cut.value); inputRef.current = cut.value;
                  setCursor(cut.cursor); cursorRef.current = cut.cursor;
                  f.notify();
                  return true;
                }
              }
              // ── Esc: non-empty field → clear; empty shell-mode field → leave the
              // mode (closest thing first, before Esc starts arming a chat-wide exit —
              // the same order as the field-clearing step above); streaming → abort;
              // armed → exit; otherwise arm + hint «Enter Esc again to exit».
              if (key.name === 'escape') {
                if (inputRef.current.length > 0) {
                  setInput(''); inputRef.current = '';
                  setCursor(0);
                  disarmEsc();
                  return true;
                }
                if (shellMode) {
                  setShellMode(false);
                  disarmEsc();
                  return true;
                }
                if (queueRef.current.length) {
                  setField(queueRef.current.pop() as string);
                  syncQueue();
                  return true;
                }
                if (streamRef.current) { abortRef.current?.abort(); return true; }
                if (escArmed) { closeChat(); return true; }
                armEsc();
                return true;
              }
              // ── Shift+Tab steps the auto mode (ask → reads → all → ask), the way
              // Claude Code's auto-accept is stepped. It is the chat's own fixed key,
              // not a bound action: the chat owns the keyboard while it is open, and
              // Shift+Tab was doing the plain Tab's completion — a completion nobody
              // asked for by holding Shift.
              if (key.name === 'tab' && key.shift && !key.meta && !key.ctrl) {
                const next = nextAutoMode(autoModeRef.current);
                setAutoMode(next);
                (f.services as Record<string, any>).showMessage?.(autoSaid(next));
                f.notify();
                return true;
              }
              // ── Tab: slash-command autocomplete (CHAT_COMMANDS).
              if (key.name === 'tab' && !key.meta && !key.ctrl) {
                const text = inputRef.current;
                if (text.startsWith('/')) {
                  const rest = text.slice(1);
                  const sp = rest.search(/\s/);
                  const curPrefix = sp === -1 ? rest : rest.slice(0, sp);
                  const suffix = sp === -1 ? '' : rest.slice(sp);
                  let base: string, idx: number;
                  if (tabRef.current && rest === tabRef.current.cmd) {
                    base = tabRef.current.base; idx = tabRef.current.idx;
                  } else {
                    base = curPrefix; idx = -1;
                  }
                  const matches = CHAT_COMMANDS.filter((c) => c.startsWith(base));
                  if (matches.length) {
                    const nxt = (idx + 1) % matches.length;
                    const newText = `/${matches[nxt]}${suffix}`;
                    setInput(newText); inputRef.current = newText;
                    setCursor(newText.length);
                    tabRef.current = { base, idx: nxt, cmd: matches[nxt] };
                    f.notify();
                    return true;
                  }
                }
                tabRef.current = null;
                return true;
              }
              // ── ↑/↓ — prompt history, but only while the field is empty or still shows
              // the history entry untouched; in a draft they move the caret between its
              // rows (the editor below), so a draft is never replaced. A `!cmd` entry
              // (how a shell command is stored, see runShellCommand) is shown the way it
              // was typed: shell mode on, the field holding `cmd` with the `!` stripped.
              if (key.name === 'up' || key.name === 'down') {
                const hist = historyRef.current;
                const untouched = inputRef.current === '' || (histAt.current != null && inputRef.current === histShown.current);
                if (untouched) {
                  if (!hist.length) return true;
                  const at = histAt.current;
                  const next = key.name === 'up' ? (at == null ? hist.length - 1 : Math.max(0, at - 1)) : (at == null ? null : at + 1 >= hist.length ? null : at + 1);
                  histAt.current = next;
                  const raw = next == null ? '' : hist[next]!;
                  const isShell = raw.startsWith('!');
                  histShown.current = isShell ? raw.slice(1) : raw;
                  setShellMode(isShell);
                  setField(histShown.current);
                  return true;
                }
              }
              // `details` — the master switch: with anything folded it opens
              // everything, pressed again it closes everything, and either way the
              // blocks a click made an exception of go back to following it. A bound
              // action, so `config.keys.details` moves it; it answers to ^o and still
              // to ^r, which every hint written before it named.
              if (isKey(f.keys.details ?? [], key)) { flipAllFolds(); return true; }
              // PgUp/PgDn and the wheel belong to the conversation's own scroll box (the
              // view's <ScrollBox> hears them itself).
              // ── Everything else is EDITING, and that is flowtty's editor reducer: caret
              // motion by character, word and visual row, Home/End and the kill bindings
              // per line, a paste going in as ONE key with its line breaks kept (so a
              // pasted newline does not send and pasted letters fire no binding), and
              // the newline keys — Shift+Enter, Alt+Enter, backslash-then-Enter. It says
              // `submit` for a plain Enter; what that means here is the chat's business.
              const act = editorReducer(
                { value: inputRef.current, cursor: cursorRef.current },
                key as Parameters<typeof editorReducer>[1],
                { multiline: true, width: chatFieldWidth(width, fullscreenRef.current) },
              );
              if (act.kind === 'submit') {
                const cmd = inputRef.current.trim();
                disarmEsc();
                if (shellMode) {
                  // One command per `!`, like Claude Code's bash mode — but only once
                  // it actually SUBMITS: while something else is still running,
                  // runShellCommand refuses without touching the field (the same
                  // "refused, not queued" contract `!command` always had), and a
                  // retried Enter must go through that same refusal again, not fall
                  // into a mode-less field where the text queues as a chat message
                  // instead. An empty command still exits the mode — it did submit,
                  // runShellCommand's own check just has nothing to run.
                  if (!streamRef.current) setShellMode(false);
                  void runShellCommand(cmd);
                } else if (cmd.startsWith('/')) runChatCommand(cmd.slice(1));
                // A `!command` typed as plain text (not via shell mode — e.g. pasted
                // whole into an empty field, since a paste is never decoded into a
                // mode switch) still runs, the legacy way. Refused while something
                // runs rather than queued: a command fired later, into a state nobody
                // is looking at, is a surprise.
                else if (cmd.startsWith('!')) void runShellCommand(cmd.slice(1).trim());
                else if (streamRef.current) {
                  // An answer is coming: queue instead of dropping the keypress.
                  if (cmd) { queueRef.current.push(cmd); setField(''); syncQueue(); }
                } else send();
                return true;
              }
              if (act.kind === 'edit') {
                if (act.state.value !== inputRef.current) { tabRef.current = null; disarmEsc(); }
                setInput(act.state.value); inputRef.current = act.state.value;
                setCursor(act.state.cursor); cursorRef.current = act.state.cursor;
                f.notify();
              }
              return true;
            },
          });
          // Trigger-open: `F` (Shift+f) opens the chat from any base state (a tracker-
          // agnostic host has no task-detail overlay, so the old `overlay === 'detail'`
          // gate was always false and the key never fired). triggerOpenable still guards the
          // command line / an open modal and when the chat is
          // already open; closed is not handled by the base consumer (priority 0).
          addTrigger({ ft: f, action: 'chat', isOpen: () => open, open: () => openChat() });
          if (!open) return null;
          // Slash-command completion, shown INLINE in the field: `matches[sel]` is the
          // suggestion and the view draws the part of it not typed yet right after the
          // caret; the other matches are named beside it. While Tab is walking the
          // candidates the field already holds a whole command, so the list is taken
          // from the prefix the walk started from (`tabRef.base`), not from the field —
          // otherwise the first Tab would narrow the list to the one it just picked.
          let completions: { matches: string[]; sel: number } | null = null;
          if (input.startsWith('/') && !input.includes(' ')) {
            const typed = input.slice(1);
            const walking = tabRef.current && tabRef.current.cmd === typed ? tabRef.current : null;
            const matches = CHAT_COMMANDS.filter((c) => c.startsWith(walking ? walking.base : typed));
            if (matches.length) completions = { matches, sel: walking ? Math.min(walking.idx, matches.length - 1) : 0 };
          }
          return (f.viewRegistry.chat as (p: Record<string, unknown>) => unknown)({
            width, height, theme: f.config.theme, messages, input, streaming, error, toolLabel, phase, cursor, escArmed,
            // What is open and what is folded, the cap of the key that changes it, and
            // the two channels a click needs: where the conversation is on the screen,
            // and which row to put at the top once a fold has changed the rows.
            folds,
            detailsKey: firstGlyph(f.keys.details),
            onViewport: (v: Viewport) => { viewportRef.current = v; },
            scrollTo,
            shellMode,
            // How much runs without a y/n — said on the hint line, so the mode is never
            // a hidden state, while an answer is coming as much as between turns.
            autoMode,
            // The numbers the conversation's images carry — their tokens are drawn as
            // attachments — and whether attaching is on (the hint names Ctrl+V then).
            imageNumbers: [...imagesRef.current.keys()],
            imagesOn: imageLimits(f.config.ai).enabled,
            fullscreen,
            pendingConfirm: pendingAsk,
            pendingQuestion,
            queued,
            subject: (f.services as { chatSubject?: () => string | null }).chatSubject?.() ?? null,
            elapsed: elapsedMs, emptyNotice, toolCount, completions,
            // What the turn has cost so far, as the provider reported it (0 — nothing
            // reported, and nothing is drawn).
            turnTokens,
            // How many lines a block a CLICK opens shows; `^o` opens it in full.
            viewLines: Number((f.config.plugins as Record<string, { runOutputLines?: unknown }> | undefined)?.assistant?.runOutputLines) || VIEW_CAPS.folded,
            // How the narration between tool calls is drawn — one step line by default.
            notes,
            // Every renderer the chat can draw a view with (the host's own `console`
            // plus each plugin's, collected at boot — src/loader/registry.ts). The
            // same value `rowOpts` above reads, and the same fallback `renderChatModal`
            // itself defaults to.
            viewRenderers,
            now: Date.now(),
            onViewFail,
            // Live count of IN-FLIGHT background tasks (the host re-renders via
            // notify() when one is armed or completes).
            bgCount: bgActiveCount(),
            ...(() => { const r = contextReading(); return { contextBadge: contextBadge(r), contextWarn: r.ratio >= CONTEXT_WARN_AT, contextPanel: contextOpen ? r : null }; })(),
            // The assistant's task plan (todo tool): a snapshot so the render never
            // mutates the tool's module state. Re-read every render, so a plan the
            // LLM edits (via notify()) shows up immediately.
            todo: planRef.current.snapshot(),
          });
        };
      },
    },
  });
}

export default buildAssistantPlugin;