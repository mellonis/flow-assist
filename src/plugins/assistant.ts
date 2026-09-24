// Plugin «assistant»: a chat with the LLM about the current task. A self-sufficient
// modal: owns the messages, input, streaming and scroll. THE HOST does the network
// (host.services.chatLLM) — the plugin never touches it; the endpoint is read from
// host.config.ai through `llmOpts` (provider, baseUrl, model, the token's variable).
//   - what the person's screens show and the refresh after a write are asked of the
//     plugins through two generic hooks (`services.chatContext` / `services.afterWrite`,
//     see AGENTS.md, plugin contract) — the chat names no plugin's data.
//   - the chat's language is `ai.assistantLanguage` (chatLanguage).

import { addTrigger, chatUser } from '../loader/registry.js';
import { bgActiveCount } from '../loader/tools-core.js';
import { autoBadge, autoCommand, autoConfirms, autoSaid, nextAutoMode, type AutoMode } from '../assistant/auto.js';
import { createPlan, todoGlyph } from '../assistant/plan.js';
import { pickVerb, verbList } from '../assistant/verbs.js';
import { NOTES_MODES, addCalls, callRun, endRound, startsWithNext, notesCommand, notesMode, notesSaid, type CallRun, type NotesMode, type TurnPart } from '../assistant/step.js';
import { lineTab, lineView, type TabWalk } from '../config/commandline.js';
import { completePath, completeSlash, listDirectory, type ChatCommandDef } from '../config/fieldcomplete.js';
import type { CompleteResult } from '../config/commands.js';
import { apiHistory, compactConversation, chatLanguage, requestTools, transcriptSoFar } from '../assistant/agent.js';
import { createToolSet, toolLoadingMode } from '../assistant/tool-loading.js';
import { llmOpts } from '../assistant/llm-endpoint.js';
import { copyTarget, copyToClipboard } from '../assistant/copy.js';
import { createShellState, formatShell, nextCwd, realOf, runShell, shellLimits, shellRoots, tildePath, type ShellResult } from '../assistant/shell.js';
import {
  KEEP_SESSIONS, SESSION_VERSION, acquireLock, closeSession, flushOnExit, listSessions, loadSession, lockPath,
  makeLockToken, newSessionId, pruneSessions, releaseLock, saveSession, sessionFingerprint, sessionFingerprintsEqual,
  sessionTitle, sessionWhen, sessionsDir, type Session, type SessionFingerprint,
} from '../assistant/sessions.js';
import type { ChatMessage, TokenUsage } from '../assistant/agent.js';
import type { ChangeView } from '../assistant/diff.js';
import { VIEW_CAPS, type ViewRecord, type ViewRenderers } from '../assistant/views.js';
import { capConsoleData, consoleData, renderConsole } from '../assistant/console-view.js';
import { INTERACTIVE_ASK, runInteractive, type InteractiveDeps } from '../assistant/interactive.js';
import { editorReducer } from '@flowtty/core';
import { z } from 'zod';
import { anchorRow, askFieldWidth, chatFieldWidth, chatRows, chatWrapWidth, firstFoldRow, liveChatStatus, pendingChatRows, renderChatStatus, renderChatStrip, rowAnchor, viewGroupFor, type RowOpts, type Viewport } from '../views/modals.js';
import { CHAT_MODES, chatModeOf, inRect, type ChatMode, type PanelLayout } from '../runtime/panel-layout.js';
import { allFolded, flipFolds, isClicked, isOpen, toggleFold, type FoldState } from '../assistant/folds.js';
import { groupOpen, toggleGroup } from '../assistant/view-groups.js';
import { bindingGlyph, firstGlyph, isKey, isMouseButton, keyGlyph } from '../playback/keys.js';
import { askKey, askStart, type AskQuestion, type AskState } from '../assistant/ask.js';
import { loadMemories, memoryFilePath, saveMemories } from '../runtime/services/memory.js';
import { keptAfterClear, memoryCommand } from '../assistant/memory-command.js';
import { CONTEXT_WARN_AT, DEFAULT_CONTEXT_WINDOW, cacheLine, contextBadge, readContext, short as shortTokens } from '../assistant/context-meter.js';
import { contextTitle, screenBlock, type ContextItem } from '../assistant/screen-context.js';
import {
  IMAGES_OFF, dataUrl, imageLimits, imagesInText, insertToken, isImageRefusal, loadImageFile, pastedPaths, readClipboardImage, readImageData, removeTokenAt, wireMessages,
  type ClipboardImage, type ImageRef, type LoadedOk, type ResolvedImage,
} from '../assistant/images.js';
import type { Make } from '../loader/plugin.js';
import { decodeBangLine, encodeBangLine, keptInHistory, pushHistory, type HistoryCommand } from '../assistant/prompt-history.js';
import type { Plugin } from '../loader/plugin.js';
import type { PluginApi } from '../runtime/plugin-api.js';

// Slash-commands of the chat — a single source for runChatCommand and Tab-completion.
// `/analyze` is a tracker slash command and is removed.
// `history: false` would keep a command out of the ↑/↓ history, which is saved with the
// session — for a command whose argument may carry a secret
// (src/assistant/prompt-history.ts). None of these takes one: a path, a number, a
// mode word.
// `values` is what a command's argument may be, and Tab completes it from them
// (src/config/fieldcomplete.ts). `/resume`'s are the saved sessions, read where the
// sessions directory is known (`chatCommandDefs` in the chat).
type ChatCommand = HistoryCommand & ChatCommandDef;
const CHAT_COMMAND_DEFS: ChatCommand[] = [
  { name: 'compact' }, { name: 'context' }, { name: 'copy' }, { name: 'image' }, { name: 'resume' }, { name: 'clear' }, { name: 'memory' },
  { name: 'auto', values: ['reads', 'all', 'off'] }, { name: 'notes', values: NOTES_MODES }, { name: 'mode', values: CHAT_MODES }, { name: 'log' }, { name: 'exit' },
];
const CHAT_COMMANDS = CHAT_COMMAND_DEFS.map((c) => c.name);

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
// carries tool_calls. Extra fields ride along (live/reasoning/parts/duration/…).
interface ChatMsg {
  role: string;
  content?: string | null;
  // The round being written now, and whether it is known to carry a tool call — then
  // it is a step, not the answer (src/assistant/step.ts).
  live?: string;
  liveQuiet?: boolean;
  reasoning?: string;
  // The turn so far in the order it happened: the steps (the text of each round that
  // went on to call a tool) and the changes its writes reported. Display only.
  parts?: TurnPart[];
  duration?: number;
  stopped?: boolean;
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
// own and may well sit after it — and the turn's seconds and what it cost belong on
// the answer whatever landed below it. −1 when the turn has no answer message yet.
function answerAt(list: ChatMsg[]): number {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]!;
    if (m.role === 'assistant' && m.duration == null) return i;
  }
  return -1;
}


// The app-glue dispatched to by the :ask command.
interface AssistantCtx {
  openChat?(text?: string): unknown;
}

// config.plugins.assistant, as the chat reads it.
const assistantConfig = (host: { config?: unknown }) =>
  ((host as { config?: { plugins?: Record<string, Record<string, unknown> | undefined> } }).config?.plugins?.assistant ?? {}) as Record<string, unknown>;

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
    // `details` opens what the chat folds — the runs of steps, the reasoning, a turn's
    // tool calls, a command's capped output — and closes it again. It is an ACTION, not a key
    // written into the handler, so `config.keys.details` moves it and every hint
    // draws the cap of whatever it is bound to. `^r` stays beside `^o`: it is in
    // every hint people have read so far, and a key that quietly stopped working
    // would be the worst way to learn about the new one.
    // `chatFocus` (Ctrl+]) moves the keyboard between the chat and the plugin, and
    // `chatCollapse` (Ctrl+\) folds a docked chat away and brings it back. Both are
    // taken by the App before any handler (src/runtime/app.tsx), so no plugin can keep
    // them from the person.
    keys: { chat: 'F', details: ['ctrl+o', 'ctrl+r'], chatFocus: 'ctrl+]', chatCollapse: 'ctrl+\\' },
    // config.plugins.assistant: `mode` — where the chat is (src/runtime/panel-layout.ts):
    // `panel` beside the plugin's screen (the default), `window` over it, `full` the
    // whole terminal; `/mode` switches it for the session, and an old `fullscreen: true`
    // reads as `full`. `panel.side` (`right`, or `bottom`; a right panel goes to the
    // bottom by itself on a terminal under 120 columns) and `panel.size` (percent of the
    // width on the right, of the height at the bottom). `notes` — how the
    // text the model writes between tool calls is drawn (`/notes` switches it for the
    // conversation); `colors` — the chat's palette override
    // (src/playback/theme.ts); `runOutputLines` — how many lines of a command's output
    // a click on its block shows (a display cap of its own, quite apart from
    // `shell.maxChars`, which is how much the MODEL is given); `^o` opens it in full.
    configSchema: z.object({
      mode: z.enum(['panel', 'window', 'full']).optional(),
      panel: z.object({
        side: z.enum(['right', 'bottom']).optional(),
        size: z.number().int().min(10).max(90).optional(),
      }).optional(),
      // Read as `mode: full` (true) — a legacy key; there is no `/fullscreen` command.
      fullscreen: z.boolean().optional(),
      // `fold` and `hidden` were dropped; a config file that still says one is read as
      // `step` (`notesMode`) — the plugin's config is checked only when it is written.
      notes: z.enum(['step', 'open']).optional(),
      runOutputLines: z.number().int().positive().optional(),
      colors: z.record(z.string(), z.unknown()).optional(),
    }).optional(),
    // The footer's word for the chat while it is closed: the key that opens it and,
    // when background results landed meanwhile, how many are waiting. Open, the
    // chat says its own keys inside its frame.
    usesCache: false,
    keycaps: (api) => {
      const p = (api as PluginApi).host as { keyCap?: (action: string) => string; store?: { chat?: { open?: boolean; unread?: number; layout?: ChatMode; focus?: string; footerStatus?: boolean } } };
      const chat = p.store?.chat;
      // The collapsed chat's status is on the footer row and already says `^] chat`:
      // only what it does not say — the unread count — is left to add.
      if (!chat?.open && chat?.footerStatus) return chat.unread ? [`◆ ${chat.unread} new`] : [];
      // Docked and open with the plugin at the keys: the footer says how to get back.
      if (chat?.open && chat.layout === 'panel' && chat.focus === 'plugin') {
        const cap = p.keyCap?.('chatFocus') ?? '';
        return cap ? [`${cap} chat`] : [];
      }
      if (chat?.open) return [];
      // The cap of whatever `chat` is bound to now — not a letter written here.
      const cap = p.keyCap?.('chat') ?? '';
      if (!cap) return [];
      return [`${cap} chat${chat?.unread ? ` · ◆ ${chat.unread} new` : ''}`];
    },
    views: { chat: renders.chat },
    // Where the chat is, before anything renders: the App lays the screen out by it on
    // its very first frame, before the chat has published anything of its own.
    setup: (api) => {
      const { host } = api as PluginApi;
      const store = host.store as Record<string, any>;
      store.chat = { ...(store.chat ?? {}), mode: chatModeOf(assistantConfig(host)), open: false, focus: 'plugin' };
    },
    components: {
      chat: (api) => {
        const { ui, host } = api as PluginApi;
        return function ChatModal() {
          // The room the chat has: its panel when docked, the terminal otherwise (the App
          // gives each side of the screen its own area).
          const { width, height } = host.useTerminalSize();
          // Open: shown — a window, the whole terminal, or a panel expanded. A docked
          // chat that is not open is COLLAPSED: out of the way on the right (its turn's
          // status on the plugin's bottom row), one row at the bottom.
          const [open, setOpen] = ui.useState(false);
          // Where the chat is (src/runtime/panel-layout.ts): config.plugins.assistant.mode
          // to start with, `/mode` for the session.
          const [mode, setModeState] = ui.useState<ChatMode>(chatModeOf(assistantConfig(host)));
          const modeRef = ui.useRef(mode); modeRef.current = mode;
          // Which side has the keyboard while the chat is docked and open. In the other
          // modes an open chat has it, as a window over the screen always had.
          const [focus, setFocusState] = ui.useState<'chat' | 'plugin'>('plugin');
          const focusRef = ui.useRef(focus); focusRef.current = focus;
          // Where the App docked the chat, this frame (null unless it is a panel).
          const dock = (host.services as { chatDock?: PanelLayout | null }).chatDock ?? null;
          // How the chat is DRAWN, which is the mode — except a panel on a terminal too
          // small to dock on (src/runtime/panel-layout.ts, `fits`): the App gives it no
          // dock, and it is a window for as long as the terminal stays that small. Every
          // check of how the chat behaves reads this; `mode` stays what was asked for.
          const layout: ChatMode = mode === 'panel' && !dock ? 'window' : mode;
          const layoutRef = ui.useRef(layout); layoutRef.current = layout;
          const focused = open && (layout !== 'panel' || focus === 'chat');
          const focusedRef = ui.useRef(focused); focusedRef.current = focused;
          // The window fills its area — the panel, or the whole terminal — rather than a
          // centred window over the screen. The ref is for the key handler (the field's
          // width decides up/down across wrapped rows).
          const fullscreen = layout !== 'window';
          const fullscreenRef = ui.useRef(fullscreen); fullscreenRef.current = fullscreen;
          // The wheel over the conversation while the plugin has the keys (the list does
          // not hear its own keys then) — ChatMessages fills it.
          const wheelRef = ui.useRef<((up: boolean) => void) | null>(null);
          // `openRef` is what the detached background flush reads (a timer's closure
          // would see a stale `open`); `unread` counts results that landed while the
          // chat was closed — the footer shows it, opening the chat clears it.
          const openRef = ui.useRef(open); openRef.current = open;
          const [unread, setUnread] = ui.useState(0);
          const unreadRef = ui.useRef(unread); unreadRef.current = unread;
          // The host draws its footer BEFORE this component re-renders, so what the
          // footer reads (`host.store.chat.open` / `.unread`) is patched synchronously at
          // the moment it changes — otherwise the footer runs one render behind and
          // "F chat" vanishes on close.
          const publish = (patch: { open?: boolean; unread?: number; mode?: ChatMode; focus?: 'chat' | 'plugin' }) => {
            const store = host.store as Record<string, any>;
            store.chat = { ...(store.chat ?? {}), ...patch };
          };
          // The plan is this conversation's: made here, handed to the `todo` tool through
          // the tool context, emptied by /clear — never module state, which would
          // outlive the conversation it describes.
          const planRef = ui.useRef(createPlan());
          // Where this conversation's shell commands run — `!command` and the model's
          // run_command share it; `cd` moves it. The conversation's, like the plan: a
          // background run gets its own, /clear resets it.
          const shellRef = ui.useRef(createShellState(() => host.config as Record<string, unknown>));
          // Which turn a view belongs to — groups never span two.
          const turnRef = ui.useRef(0);
          // Live views, coalesced: the latest record per view waits here at most
          // LIVE_REDRAW_MS, so a command printing thousands of lines a second costs a few
          // redraws, not thousands. A view's first state and its final phase are placed at
          // once — the block must appear when the call starts, and its end must not wait.
          const LIVE_REDRAW_MS = 200;
          const liveBuf = ui.useRef(new Map<string, ViewRecord>());
          const liveSeen = ui.useRef(new Set<string>());
          const liveTimer = ui.useRef<ReturnType<typeof setTimeout> | null>(null);
          // Bumped at every reset (/clear, /resume — the same places
          // liveSeen/liveBuf are cleared), never at anything else — turnRef is NOT reset
          // there, it belongs to the conversation's whole history. `send()` and the
          // `!command` runner each capture it when they START; every callback of theirs
          // that could still fire after a LATER reset (a tool's final phase, a change
          // report) compares its own captured value against the ref's CURRENT one and
          // drops the update if they differ — the turn it was for no longer exists, in
          // either the display or `apiRef`, and writing into the fresh one would be
          // exactly the "a stopped command from before /clear reappears in the cleared
          // chat" bug this guards.
          const epochRef = ui.useRef(0);
          // A pending coalesce timer must not fire into whatever the chat looks like by
          // then — unmounting is a reset the timer itself cannot observe.
          ui.useEffect(() => () => { if (liveTimer.current) clearTimeout(liveTimer.current); }, []);
          // The tools the model has loaded (tools on demand, src/assistant/tool-loading.ts).
          // The conversation's, like the plan: its history calls them, so it is saved
          // with the session, kept through /compact, emptied by /clear.
          const toolSetRef = ui.useRef(createToolSet());
          // What the provider reported for the last turn: its prompt plus the answer it
          // produced is, to a close approximation, the size of the NEXT request.
          const usageRef = ui.useRef<TokenUsage | null>(null);
          // `/context` opens a panel in the field's place, like a write confirmation — it
          // is a look at the conversation, not a line of it. The ref is for the key
          // handler; the state is for the render.
          const contextOpenRef = ui.useRef(false);
          const [contextOpen, setContextOpenState] = ui.useState(false);
          const setContextOpen = (v: boolean) => { contextOpenRef.current = v; setContextOpenState(v); host.notify(); };
          const [messages, setMessages] = ui.useState<ChatMsg[]>([]);
          const [input, setInput] = ui.useState('');
          const [streaming, setStreaming] = ui.useState(false);
          const [error, setError] = ui.useState<string | null>(null);
          const [toolLabelState, setToolLabelState] = ui.useState(''); // «⚙ calling get_issue…» during tool rounds
          // Mirrored in a ref: the stream callbacks are closures made when the message was
          // sent, and they read the label to clear it. Reading the state there saw the
          // value at send time — empty — so the label of a finished tool never cleared and
          // the chat looked stuck on it while the model was already writing.
          const toolLabelRef = ui.useRef('');
          const toolLabel = toolLabelState;
          const setToolLabel = (v: string) => { toolLabelRef.current = v; setToolLabelState(v); };
          // What the model is doing when no tool runs: 'writing' only while its text
          // arrives; before the first token, while it reasons, and between tools (it is
          // working out the next call) it is 'thinking'. One word for all of it read
          // "writing…" while nothing was being written.
          const [phase, setPhase] = ui.useState<'thinking' | 'writing'>('thinking');
          // The word the line says for either phase (src/assistant/verbs.ts): one per
          // model request, picked when the request goes out — never in the render, so it
          // cannot change under the person within a round. The ref is what the next
          // pick avoids repeating.
          const [verb, setVerbState] = ui.useState('');
          const verbRef = ui.useRef('');
          const nextVerb = () => {
            const word = pickVerb(verbList(host.config as { ui?: { verbs?: unknown } }), verbRef.current);
            verbRef.current = word;
            setVerbState(word);
          };
          // What is open and what is folded (src/assistant/folds.ts): one global
          // state, plus the blocks a click has made an exception of. `details` (^o)
          // is the master switch; a click opens the block under it alone. The
          // conversation's, like the auto mode — never saved, and `/clear` and `/resume`
          // both come back to everything folded.
          const [folds, setFoldsState] = ui.useState<FoldState>(allFolded());
          const foldsRef = ui.useRef(folds);
          const setFolds = (s: FoldState) => { foldsRef.current = s; setFoldsState(s); };
          // What the conversation last said about where it is on the screen — the
          // view reports it, and a click is turned into a row with it.
          const viewportRef = ui.useRef<Viewport | null>(null);
          // A row the list should be put at the top of once the rows have changed, and
          // the nonce that makes a repeat of the same row ask again.
          const [scrollTo, setScrollTo] = ui.useState<{ row: number; n: number } | null>(null);
          const scrollSeq = ui.useRef(0);
          // The mouse press a click may still come out of: the cell it landed on and
          // when. A drag clears it — a drag is a selection and never a fold.
          const pressRef = ui.useRef<{ x: number; y: number; at: number } | null>(null);
          // Process indicator: spinner + the seconds of whatever is running NOW.
          // t0Ref — when the turn started, which is what the finished answer's quiet
          // line says (`· 12.4s`). segRef — when the thing on the status line started:
          // a tool the moment it was called, the model's round the moment the tool
          // ended. A turn that runs a build sat at `3m 12s`, which says nothing about
          // what is happening; the number a person wants there is how long the RUNNING
          // thing has taken. tickRef ticks elapsedMs off segRef.
          const [elapsedMs, setElapsedMs] = ui.useState(0);
          const t0Ref = ui.useRef(0);
          const segRef = ui.useRef(0);
          const tickRef = ui.useRef<ReturnType<typeof setInterval> | null>(null);
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
          const [turnTokens, setTurnTokensState] = ui.useState(0);
          const turnTokensRef = ui.useRef(0);
          const setTurnTokens = (n: number) => { turnTokensRef.current = n; setTurnTokensState(n); };
          // The same sum, of `cachedTokens` alone, across every round of the turn — kept
          // on the answer's message as `cached` (never drawn on the status line: it is
          // the session's record of the turn's cache hits, not a live figure). A round
          // that reported nothing adds nothing.
          const turnCachedRef = ui.useRef(0);
          // Empty answer: the model output only reasoning (goes to the fold) but no
          // final text. contentRef accumulates the final content (onDelta) — by it we
          // decide «empty?» and show an amber status message.
          const contentRef = ui.useRef('');
          const [emptyNotice, setEmptyNotice] = ui.useState('');
          const [toolCount, setToolCount] = ui.useState(0); // tool calls in this turn (for the status)
          const abortRef = ui.useRef<AbortController | null>(null);
          // Which key stopped the running turn or `!command`: '' for Esc (and for a
          // reset that aborts it), the cap otherwise (`^c`) — the quiet line under the
          // answer and a command's outcome say `stopped (^c)`. Cleared when one starts.
          const stopKeyRef = ui.useRef('');
          // Whether Esc / Ctrl+C have something to stop: a run whose controller has not
          // been aborted yet. A run that goes on after its abort (a tool that ignores its
          // signal) does not hold the keys: Esc goes back to its idle steps and Ctrl+C
          // arms the exit, so the person can always leave.
          const canStop = () => !!abortRef.current && !abortRef.current.signal.aborted;
          // Tab-completion cycle: { base, idx, cmd } — by which prefix the matches were
          // built, the last selected command in that list and its text. Repeat Tab cycles;
          // changing the prefix (typed/deleted) restarts.
          // The Tab walk through the field's completion candidates — the `:` line's own
          // (src/config/commandline.ts); over as soon as the field is anything else.
          const tabRef = ui.useRef<TabWalk | null>(null);
          const inputRef = ui.useRef(input); inputRef.current = input;
          const msgsRef = ui.useRef(messages); msgsRef.current = messages;
          // The MODEL's history, kept apart from the display list above. `messages`
          // holds what the person reads (final text + parts/live); this
          // holds what was actually exchanged — tool calls and tool results included
          // — and is what every turn replays. See `apiHistory` for why the display
          // list must never stand in for it.
          const apiRef = ui.useRef<ChatMessage[]>([]);
          // `/compact`'s summary. It rides in the system context of every later turn;
          // a display-only `system` message would be dropped by `send` and lost.
          const summaryRef = ui.useRef<string>('');
          const streamRef = ui.useRef(streaming); streamRef.current = streaming;
          // Background-result queue (populated by `postToChat`, see below): results are
          // NOT dropped when the chat is busy — they wait here and are auto-fed through
          // `send` (analyzed) one at a time once the chat is idle. A short interval
          // drives the flush; it self-clears when the queue empties.
          const bgQueueRef = ui.useRef<string[]>([]);
          const flushTimer = ui.useRef<ReturnType<typeof setInterval> | null>(null);
          const clearFlush = () => {
            if (flushTimer.current) { clearInterval(flushTimer.current); flushTimer.current = null; }
          };
          let flushPending: () => void = () => {};
          // Input field caret — an index (codepoint) in `input`. Kept in a ref so the
          // handler reads a fresh value.
          const [cursor, setCursor] = ui.useState(0);
          const cursorRef = ui.useRef(cursor); cursorRef.current = cursor;
          // Messages sent while an answer was coming. They go out in order when the
          // turn ends (a stopped or failed turn puts them back into the field instead —
          // `restoreQueue`); ↑ on an empty field takes the last one back. queueRef is what
          // the handlers act on, `queued` mirrors it for the render.
          const queueRef = ui.useRef<string[]>([]);
          const [queued, setQueued] = ui.useState<string[]>([]);
          const syncQueue = () => { setQueued(queueRef.current.slice()); host.notify(); };
          // Prompt history for ↑/↓. `histAt` is the entry on screen (null = the draft),
          // `histShown` is its text — an arrow only replaces the field while it still
          // shows exactly that, so a draft being typed is never lost to a keypress.
          const historyRef = ui.useRef<string[]>([]);
          const histAt = ui.useRef<number | null>(null);
          const histShown = ui.useRef<string>('');
          const setField = (t: string) => { setInput(t); inputRef.current = t; setCursor(t.length); host.notify(); };
          // Bang LEVEL — `!` typed into an EMPTY field steps it UP: 0 (normal) → 1
          // (shell mode, `! ` in the shell colour replaces `› `) → 2 (interactive
          // mode, `!!`, the same colour — see src/views/modals.ts). Enter at level 1
          // runs the field text as a plain shell command; at level 2 it hands the
          // terminal over (runShellCommand below). Backspace and Esc on an empty
          // field each step the level back DOWN by one. It is UI state of the field
          // only: never saved with the session (snapshotSession's draft rule below)
          // and never restored on a restart.
          const [bangLevel, setBangLevelState] = ui.useState<0 | 1 | 2>(0);
          const bangLevelRef = ui.useRef(bangLevel);
          const setBangLevel = (v: 0 | 1 | 2) => { bangLevelRef.current = v; setBangLevelState(v); };
          // A turn that was stopped (Esc, Ctrl+C) or failed does not send the queue: the
          // queued messages come back into the field — in order, joined by blank lines,
          // AHEAD of whatever was typed meanwhile (the order they would have gone out
          // in) — and the person decides what to send. A failed request would most
          // likely fail again, and a stopped one was stopped on purpose. The bang
          // level goes to 0, as a message is not a command; a `!`/`!!` draft keeps
          // its bang(s).
          const restoreQueue = () => {
            if (!queueRef.current.length) return;
            const draft = bangLevelRef.current && inputRef.current ? encodeBangLine(bangLevelRef.current as 1 | 2, inputRef.current) : inputRef.current;
            const text = [...queueRef.current, draft].filter((t) => t.trim()).join('\n\n');
            queueRef.current = [];
            setBangLevel(0);
            histAt.current = null;
            histShown.current = '';
            setField(text);
            syncQueue();
          };
          // ── The auto mode (src/assistant/auto.ts) — how much of a turn runs without
          // the y/n. This conversation's and nothing else's: it is not in the session
          // file, so a restart opens on `ask`, and `/clear`, `/resume` and a change of
          // task put it back there too. The ref is what the confirmation closure reads
          // (it was made when the message was sent, and would otherwise see the mode of
          // that moment for the whole turn); the state is for the render.
          const [autoMode, setAutoModeState] = ui.useState<AutoMode>('ask');
          const autoModeRef = ui.useRef<AutoMode>(autoMode);
          const setAutoMode = (m: AutoMode) => { autoModeRef.current = m; setAutoModeState(m); };
          // ── The steps (src/assistant/step.ts) — how the text the model writes between
          // tool calls is drawn. `plugins.assistant.notes` is where a conversation
          // starts, `/notes` moves it for this one only, and `/clear` puts it back
          // where the config says. The ref is for the key handler and the command,
          // which are closures made before the state they would read.
          const configNotes = (): NotesMode => notesMode((host.config.plugins as Record<string, { notes?: unknown }> | undefined)?.assistant?.notes);
          const [notes, setNotesState] = ui.useState<NotesMode>(configNotes());
          const notesRef = ui.useRef<NotesMode>(notes);
          const setNotes = (m: NotesMode) => { notesRef.current = m; setNotesState(m); };
          // Whether the round being streamed carries a tool call — heard the moment
          // its first fragment arrives (`onRoundKind`), and from then on its text is a
          // step, not the answer. Kept HERE, beside the state and never inside a
          // `setMessages` updater: an updater runs when React gets to it, and a round
          // whose tokens and tool call arrive in one batch could otherwise be read
          // before its own updater has run — its text lost and the NEXT round taken
          // for it. Every updater is a pure function of the list; what it needs to know is
          // read here, when the callback fires, and handed to it.
          const roundToolsRef = ui.useRef(false);
          const resetRound = () => { roundToolsRef.current = false; };
          // ── Folds ── the rows a click lands on, and what opening one does to the
          // scroll. The rows are laid out by the view and cached per message object,
          // so asking for them here is a lookup, not a second layout.
          // The display list as the view's own functions read it — the same objects,
          // and so the same cached rows.
          const drawn = () => msgsRef.current as Parameters<typeof chatRows>[0];
          // A renderer that cannot draw is said once per kind in the log, not once per
          // frame. `onViewFail` fires from INSIDE `ChatMessages`' render (`frameView`,
          // called while laying out a message's rows) — `pushLog` ends in `notify()`
          // (App's own setState), and calling that while a different component is
          // still rendering is exactly what React refuses ("Cannot update a component
          // … while rendering a different component"). The set is updated synchronously
          // (so the next render in the same pass still sees the kind as said), and the
          // log write itself is pushed past the current render/commit with a microtask.
          const failedKinds = ui.useRef(new Set<string>());
          const onViewFail = (kind: string, why: string) => {
            if (failedKinds.current.has(kind)) return;
            failedKinds.current.add(kind);
            queueMicrotask(() => (host.services as Record<string, any>).pushLog?.(`[view] ${kind}: ${why} — drawn as one line`));
          };
          // Every renderer the chat can draw a view with — the host's own `console`
          // (collected at boot, src/loader/registry.ts) plus each plugin's, qualified
          // by its name; the same default the view's own `renderChatModal` falls back
          // to, so a host that somehow boots with no `services.viewRenderers` draws
          // views identically whichever of the two places below reads it.
          const viewRenderers: ViewRenderers = (host.services as { viewRenderers?: ViewRenderers }).viewRenderers ?? { console: renderConsole };
          const rowOpts = (state: FoldState): RowOpts => ({
            wrap: chatWrapWidth(width, fullscreenRef.current),
            folds: state,
            viewLines: Number((host.config.plugins as Record<string, { runOutputLines?: unknown }> | undefined)?.assistant?.runOutputLines) || VIEW_CAPS.folded,
            notes: notesRef.current,
            // Empty when the action is unbound — every hint that names it then
            // leaves it out, rather than teaching a key that does nothing.
            detailsKey: firstGlyph(host.keys.details),
            renderers: viewRenderers,
            now: Date.now(),
            palette: ((host.config.theme as { modals?: { chat?: Record<string, string | undefined> } } | undefined)?.modals?.chat ?? {}),
            onViewFail,
          });
          // Put a row at the top of the conversation, once the rows have changed.
          const askScroll = (row: number) => setScrollTo({ row: Math.max(0, row), n: ++scrollSeq.current });
          // A fold changed. Opening a block puts its FIRST row at the top of the
          // screen — landing on its last line instead would show the end of what the
          // person opened it to read. Anything else keeps
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
            host.notify();
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
            // A group's head is never a plain toggle: whether it reads open depends
            // on its members too (src/assistant/view-groups.ts), so `toggleGroup`
            // decides the whole group's next state, not `id` alone.
            if (id.endsWith(':group')) {
              const g = viewGroupFor(drawn(), rowOpts(foldsRef.current), id);
              if (!g) return false;
              const next = toggleGroup(foldsRef.current, g);
              applyFolds(next, groupOpen(next, g) ? id : null);
              return true;
            }
            // Which way this click goes: for a block that follows the global state,
            // away from it; for the trail's cap, which never does, simply on.
            const opening = id.endsWith(':calls') ? !isClicked(foldsRef.current, id) : !isOpen(foldsRef.current, id);
            applyFolds(toggleFold(foldsRef.current, id), opening ? id : null);
            return true;
          };

          // ── Images (src/assistant/images.ts) ── what each `[Image #N]` of this
          // conversation stands for, and the last N given out. The conversation's, like
          // the plan: saved with the session, emptied by /clear. The
          // TEXT decides what a message sends — the tokens in it this map knows — so the
          // field, a queued message, ↑/↓ and the draft need nothing beside their text.
          const imagesRef = ui.useRef(new Map<number, ImageRef>());
          const imageSeqRef = ui.useRef(0);
          // The `data:` URL of an image, once read and found unchanged — built on the way to
          // the provider, never kept in a message or written to disk. Keyed by path + hash.
          const imageDataRef = ui.useRef(new Map<string, string>());
          // Images already said to be gone, so the note is not repeated with every message;
          // and whether the provider's refusal of an image has been explained.
          const imageNotedRef = ui.useRef(new Set<string>());
          const imageRefusalSaidRef = ui.useRef(false);
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
          // continues it. A session gets its id — and its ownership lock — when it
          // first has something to keep; `/clear` starts a new one and leaves the old
          // for `/resume`.
          const sessDir = sessionsDir(host.config);
          // The chat's commands with `/resume`'s values filled in: the saved sessions,
          // newest first, numbered as `/resume` lists them, each number labelled with
          // its title. Read when the field is drawn, so the list is the one on disk.
          const chatCommandDefs: ChatCommandDef[] = CHAT_COMMAND_DEFS.map((c) => (c.name === 'resume'
            ? { ...c, values: () => (sessDir ? listSessions(sessDir).slice(0, 15).map((s, i) => ({ value: String(i + 1), label: s.title || '(untitled)' })) : []) }
            : c));
          // What the field completes, from its text alone: in shell mode the word being
          // typed as a path under the shell's directory (nothing outside the roots by
          // real path — `dirAllowed`'s own rule); otherwise a `/command` and its
          // argument. Drawn and walked through `lineView` / `lineTab`, exactly as the
          // `:` line is.
          const chatComplete = (text: string): CompleteResult => (bangLevelRef.current
            ? completePath(text, { cwd: shellRef.current.cwd(), roots: shellRoots(host.config as Record<string, unknown>).map(realOf), list: listDirectory, real: realOf })
            : completeSlash(text, chatCommandDefs));
          const sessConf = (host.config.sessions ?? {}) as { resume?: unknown; keep?: unknown };
          const sessionIdRef = ui.useRef('');
          const createdAtRef = ui.useRef('');
          const saveTimer = ui.useRef<ReturnType<typeof setTimeout> | null>(null);
          // One token for this chat instance's whole life (not per process — see
          // sessions.ts, "Ownership lock"): what makes a lock this instance's own.
          // `useRef`'s init runs on every render, so `makeLockToken()` (a UUID) would
          // otherwise be generated and discarded on every one but the first; the ref
          // starts empty and is filled in once, here, on the first render only.
          const lockTokenRef = ui.useRef('');
          if (!lockTokenRef.current) lockTokenRef.current = makeLockToken();
          const lockToken = lockTokenRef.current;
          // The zero fingerprint: what a session with nothing written yet, or one this
          // instance has not read or written at all, starts from — the same value
          // `sessionFingerprint` reads back for a file that does not exist.
          const NO_FILE: SessionFingerprint = { rev: 0, mtimeMs: 0, size: 0 };
          // The fingerprint (rev + mtimeMs + size) this instance last read or wrote for
          // the session it currently holds — what a save compares the disk against
          // before overwriting it (sessions.ts, "sessionFingerprint").
          const fingerprintRef = ui.useRef<SessionFingerprint>(NO_FILE);
          const releaseCurrentLock = () => { if (sessDir && sessionIdRef.current) releaseLock(sessDir, sessionIdRef.current, lockToken); };
          const snapshotSession = (): Session => {
            if (!sessionIdRef.current) {
              sessionIdRef.current = newSessionId(); createdAtRef.current = new Date().toISOString(); fingerprintRef.current = NO_FILE;
              if (sessDir) acquireLock(sessDir, sessionIdRef.current, lockToken); // a fresh id — nothing else could hold it
            }
            return {
              version: SESSION_VERSION, id: sessionIdRef.current, title: '', createdAt: createdAtRef.current, updatedAt: new Date().toISOString(),
              messages: msgsRef.current as Record<string, unknown>[], api: apiRef.current as unknown as Record<string, unknown>[],
              summary: summaryRef.current, plan: planRef.current.snapshot(), usage: usageRef.current,
              // A /command or !command in the field is being run, not drafted (it was
              // "/clear" itself); a non-zero bang-level field has no leading `!`/`!!`
              // left to catch by that regex, so its own flag is checked too — it is
              // not a draft either.
              prompts: historyRef.current.slice(-100), draft: (bangLevelRef.current || /^\s*[/!]/.test(inputRef.current)) ? '' : inputRef.current,
              shellCwd: shellRef.current.saved(),
              tools: toolSetRef.current.names(),
              // Refs only — a path and a hash per image, never its bytes.
              images: [...imagesRef.current.values()], imageSeq: imageSeqRef.current,
              closed: false, // written means in use — a resumed cleared session is open again
            };
          };
          // The fork note's text.
          const forkNoteText = (messages: Record<string, unknown>[], id: string): string =>
            `Session "${sessionTitle(messages) || id}" was changed elsewhere — saved this conversation as a new session.`;
          // `silent` — nothing shown, no notify — for the paths that write on the way
          // out (exit, unmount): the screen is not going to be read again, though the
          // fork itself (never overwrite what changed) still happens even there.
          const writeSession = (opts: { silent?: boolean } = {}) => {
            if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
            if (!sessDir || !msgsRef.current.some((m) => personSpoke(m.role))) return; // nothing said or run yet
            try {
              const snap = snapshotSession();
              const disk = sessionFingerprint(sessDir, snap.id);
              if (!sessionFingerprintsEqual(disk, fingerprintRef.current)) {
                // Someone else changed this file since we last read or wrote it — an
                // older host with no lock, a hand edit (rev alone would miss a hand
                // edit that leaves the number untouched, or two foreign writes that
                // both have no `rev` field at all). Never overwrite what we have not
                // seen: fork this conversation into a new session instead.
                const forkedId = newSessionId();
                const now = new Date().toISOString();
                releaseCurrentLock();
                acquireLock(sessDir, forkedId, lockToken);
                const forked: Session = { ...snap, id: forkedId, createdAt: now, updatedAt: now };
                const fp = saveSession(sessDir, forked);
                sessionIdRef.current = forkedId; createdAtRef.current = now; fingerprintRef.current = fp;
                const text = forkNoteText(snap.messages, snap.id);
                if (!opts.silent) {
                  setMessages((cur) => [...cur, { role: 'note', content: text }]);
                  host.notify();
                }
                return;
              }
              fingerprintRef.current = saveSession(sessDir, snap);
            } catch (e) {
              (host.services as Record<string, any>).pushLog?.(`[session] not saved: ${(e as Error).message}`);
            }
          };
          // After the render that carries the change — the screen list is read from msgsRef.
          const persist = () => {
            if (saveTimer.current) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => { saveTimer.current = null; writeSession(); }, 250);
          };
          const writeRef = ui.useRef(writeSession); writeRef.current = writeSession;
          // `fingerprint` is the caller's — taken with a stat BEFORE the content in
          // `s` was read, never re-derived here. Reading it fresh off the disk at
          // this point (after `s` was already loaded) would leave a window: a
          // foreign write landing between the two reads would then be recorded as
          // "seen" even though `s` never saw it, and the next save would silently
          // overwrite it. Taking the fingerprint first means a write in that window
          // is instead caught — the next save finds the disk has moved and forks.
          const applySession = (s: Session, fingerprint: SessionFingerprint) => {
            sessionIdRef.current = s.id; createdAtRef.current = s.createdAt;
            fingerprintRef.current = fingerprint;
            apiRef.current = s.api as unknown as ChatMessage[];
            summaryRef.current = s.summary;
            planRef.current.load(s.plan);
            shellRef.current.setCwd(s.shellCwd ?? null);
            toolSetRef.current.load(s.tools);
            resetLiveViews(); // the calls they tracked belong to the conversation being left
            resetImages(s.images ?? [], s.imageSeq ?? 0);
            setAutoMode('ask'); // another conversation is another conversation's mode
            setNotes(configNotes()); // and its own answer to how the steps are drawn
            resetRound(); // the round being written belonged to the conversation being left
            setFolds(allFolded()); // and the exceptions pointed into a conversation that is gone
            usageRef.current = s.usage;
            historyRef.current = s.prompts.slice();
            histAt.current = null;
            msgsRef.current = s.messages as ChatMsg[];
            setMessages(s.messages as ChatMsg[]);
            setBangLevel(0); // the level is never saved — a restored draft is plain text
            setField(s.draft);
          };
          const startedRef = ui.useRef(false);
          const unhookExitRef = ui.useRef<(() => void) | null>(null);
          if (!startedRef.current && sessDir) {
            startedRef.current = true;
            // Whatever happens at exit, the last change is written (a pending
            // debounced save would otherwise be lost with the process) and the lock
            // released, in that order — AFTER the final save.
            unhookExitRef.current = flushOnExit(() => { writeRef.current({ silent: true }); releaseCurrentLock(); });
            setTimeout(() => {
              try { pruneSessions(sessDir, Number.isInteger(sessConf.keep) ? Number(sessConf.keep) : KEEP_SESSIONS); } catch { /* not fatal */ }
              if (sessConf.resume === false || msgsRef.current.length) return;
              const last = listSessions(sessDir)[0];
              if (!last || last.closed) return;
              // The fingerprint first, stat before the content read just below — see
              // applySession's own comment for why the order matters.
              const fp = sessionFingerprint(sessDir, last.id);
              const s = loadSession(sessDir, last.id);
              if (!s) return;
              const outcome = acquireLock(sessDir, s.id, lockToken);
              if (outcome.status === 'held') {
                setMessages((cur) => [...cur, { role: 'note', content: `Session "${s.title || s.id}" is open in another flow-assist process — started a new one. (lock: ${lockPath(sessDir, s.id)})` }]);
                host.notify();
                return;
              }
              applySession(s, fp);
              (host.services as Record<string, any>).showMessage?.(`Continued «${s.title || 'the last session'}» — /clear starts a new one, /resume lists others`);
              host.notify();
            }, 0);
          }
          // Component unmount is the other leaving-the-session trigger (exit, /clear,
          // /resume are handled at their own sites below): a
          // last, silent save and the lock's release.
          ui.useEffect(() => () => {
            unhookExitRef.current?.();
            if (!sessDir) return;
            writeRef.current({ silent: true });
            releaseCurrentLock();
          }, []);
          // Exit «arming» by Esc: 0 — not armed; else ms when the first Esc was pressed.
          // A second Esc within the window closes the chat; any other key disarms.
          const [escArmAt, setEscArmAt] = ui.useState(0);
          const escTimer = ui.useRef<ReturnType<typeof setTimeout> | null>(null);
          // y/n pause on a writing operation (write-flag tool → agentChat →
          // confirmWrite): while the promise hangs, input pauses and a confirmation
          // block renders. pendingRef holds { name, args, resolve } — read by the
          // input-handler (a ref, always current); pendingAsk is only for render.
          const pendingRef = ui.useRef<{ name: string; args: string; resolve: (ok: boolean) => void } | null>(null);
          const [pendingAsk, setPendingAsk] = ui.useState<{ name: string; args: string; command?: string } | null>(null);
          // `ask_user`: the same kind of pause, but the person picks among options.
          // askRef is what the input handler steps key by key (a ref, always current);
          // pendingQuestion mirrors it for the render.
          const askRef = ui.useRef<{ state: AskState; resolve: (done: AskState) => void } | null>(null);
          const [pendingQuestion, setPendingQuestion] = ui.useState<AskState | null>(null);
          const settleAsk = (done: AskState) => {
            const a = askRef.current;
            if (!a) return;
            askRef.current = null;
            setPendingQuestion(null);
            a.resolve(done);
            host.notify();
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
            escTimer.current = setTimeout(() => { setEscArmAt(0); escTimer.current = null; host.notify(); }, 3200);
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
            host.notify();
          };

          // The «cheap» synchronous base: a directive about the reply (language/
          // brevity), who it is answering, a write-language directive. No network — it
          // is assembled instantly on every message, so it is not cached.
          const baseStatic = () => {
            // Who speaks — the LLM does not know itself: mix in `config.user` (when the
            // person set one) so it addresses a human.
            const who = chatUser(host.config as { user?: { name?: unknown; login?: unknown } });
            const identity = who
              ? `You are talking to ${who.name}${who.login && who.login !== who.name ? ` (login ${who.login})` : ''}. Address the answer to them, not to an anonymous service account.`
              : '';
            // Between tool calls the model writes prose, because it has nothing else to
            // write there. Asking it not to narrate did not work — it narrated anyway,
            // at whatever length. So it is asked for a SHAPE instead: one short `Next:`
            // line before a call and nothing else — the chat never draws that line
            // (src/assistant/step.ts), so a model that keeps to it leaves nothing but
            // what it did on screen. The final answer is not a step, so the line is
            // asked for before a call only.
            const chatLang = chatLanguage((host.config as Record<string, unknown>).ai as Record<string, unknown>);
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
            const mems = loadMemories(memoryFilePath(host.config));
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
          // What the person's screens show now, as the plugins describe it
          // (src/assistant/screen-context.ts). Read fresh for every request — every
          // round of a turn — and never kept: not in `apiRef`, not in the session.
          const screenNow = (): ContextItem[] => {
            try { return (host.services as { chatContext?: () => ContextItem[] }).chatContext?.() ?? []; } catch { return []; }
          };
          // How full the model's context is (assistant/context-meter.ts).
          const contextReading = (screen: ContextItem[] = screenNow()) => {
            const summary = summaryRef.current ? `Summary of the conversation so far (older turns were compacted):\n${summaryRef.current}` : '';
            const window = Number((host.config.ai as { contextWindow?: unknown } | undefined)?.contextWindow) || DEFAULT_CONTEXT_WINDOW;
            const u = usageRef.current;
            return readContext(
              // The tools the next request will CARRY — with tools on demand, the core ones,
              // what was loaded and the index; not every tool there is.
              { system: baseStatic(), memory: memoryBlock(), plan: planBlock(), summary, screen: screenBlock(screen), tools: requestTools((host.services as Record<string, any>).pluginAiTools ?? [], toolLoadingMode(host.config.ai), toolSetRef.current), messages: apiHistory(apiRef.current) },
              window,
              u ? u.promptTokens + u.completionTokens : undefined,
            );
          };

          // The system prompt of a message = the «cheap» base (directive+identity) + fresh
          // memory + the current plan + the summary. No network: the base is synchronous,
          // memory a local file, the plan the tool's module state. It is also what the
          // display list keeps as its system message (and so the session), which is one
          // reason what the screens show is not in it; the other is the cache — it goes
          // at the end of each request instead (`requestTail`, `screenNow`).
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
            if (!imageLimits(host.config.ai).enabled) return { ok: false, why: 'off' };
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
            if (recs.length) { placeViews(recs); host.notify(); }
          };
          // `epoch` is the caller's own — captured when the turn or the `!command` that
          // opened this view STARTED, so a change that arrives after a LATER reset
          // (/clear, /resume) is dropped here, before it ever touches
          // `liveBuf`/`liveSeen` or triggers a flush into the fresh conversation.
          const offerLive = (rec: ViewRecord, epoch: number) => {
            if (epoch !== epochRef.current) return;
            if (!rec.callId) return; // nothing to find this record by again
            liveBuf.current.set(rec.callId, rec);
            const first = !liveSeen.current.has(rec.callId);
            liveSeen.current.add(rec.callId);
            if (first || rec.phase !== 'live') { flushLive(); return; }
            liveTimer.current ??= setTimeout(flushLive, LIVE_REDRAW_MS);
          };
          // /clear and /resume both call this: the calls liveSeen/
          // liveBuf tracked belong to the conversation being left, and the pending
          // coalesce timer (if any) is for a view that conversation drew — cancelled,
          // not left to fire into whatever replaces it. The epoch bump is what actually
          // stops anything already in flight for the old conversation (a tool's own
          // final phase, `!command`'s own completion) from landing in the new one; it is
          // the one thing here that is never reset itself.
          const resetLiveViews = () => {
            liveSeen.current.clear();
            liveBuf.current.clear();
            if (liveTimer.current) { clearTimeout(liveTimer.current); liveTimer.current = null; }
            epochRef.current += 1;
          };

          // `hostAsk`: the text is the HOST's request, sent as the person's message (after
          // an interactive `!!command`, "look at what it printed") — drawn as the host's,
          // never kept in ↑/↓.
          const send = async (text: string | null = null, opts: { fromBackground?: boolean; hostAsk?: boolean } = {}) => {
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
            const apiMsgs: ChatMessage[] = apiHistory(apiRef.current);
            // What this message ADDS to the screen list; laid onto the list as it is when
            // React applies it (below), never onto what was last drawn.
            const added: ChatMsg[] = [];
            if (sys) apiMsgs.unshift({ role: 'system', content: sys });
            if (!opts.fromBackground && !opts.hostAsk) pushHistory(historyRef.current, q);
            histAt.current = null;
            histShown.current = '';
            // The images the text names, in the order it names them. A background result
            // is the model's writing and carries none.
            const images = opts.fromBackground || opts.hostAsk ? [] : imagesInText(q, imagesRef.current);
            const asked: ChatMessage = { role: 'user', content: q, ...(images.length ? { images } : {}) };
            apiMsgs.push(asked);
            // What goes to the provider: every image of the history as a part — read now,
            // not kept in the history, which holds its ref.
            const notes: string[] = [];
            const wire = wireMessages(apiMsgs, (ref) => resolveImage(ref, notes));
            const wireHasImages = wire.some((m) => Array.isArray(m.content));
            for (const note of notes) added.push({ role: 'note', content: note });
            // On screen the message is its text, with the numbers of the images sent, so
            // their tokens are drawn as attachments.
            added.push({ role: opts.fromBackground ? 'bg' : 'user', content: q, ...(images.length ? { images: images.map((r) => r.n) } : {}), ...(opts.hostAsk ? { hostAsk: true } : {}) });
            // The question joins the model's history now, so a failed or cancelled
            // turn still leaves it on record; the turn's transcript follows on success.
            apiRef.current = [...apiRef.current, asked];
            // An UPDATER, over the list as it is — not a list built from `msgsRef`, which
            // is what was last DRAWN. A message sent from a zero-delay timer (the queue
            // after a turn, a `!command` or a slash command; the ask after `!!`) can run
            // before the render carrying what just ended, and a plain list then threw that
            // update away: the finished block came back live, ticking forever.
            setMessages((cur) => [...(sys ? [{ role: 'system', content: sys } as ChatMsg] : []), ...cur.filter((m) => m.role !== 'system'), ...added]);
            turnRef.current += 1; // views this turn opens are its own, never the last turn's
            // This turn's own conversation identity — captured now, compared against
            // `epochRef.current` by every one of this turn's async callbacks that could
            // still fire after a LATER reset (a tool's view, its changes, the turn's own
            // final flush): a mismatch means the conversation it was for is gone.
            const epoch = epochRef.current;
            persist(); // the question survives a restart even if the answer does not
            // The host's ask did not come from the field: whatever is being typed there
            // (keys pressed right as the program handed the terminal back) stays.
            if (!opts.hostAsk) {
              setInput('');
              inputRef.current = '';
              setCursor(0);
            }
            setError(null);
            setStreaming(true);
            setPhase('thinking');
            nextVerb(); // the turn's first request gets a word of its own
            t0Ref.current = Date.now();
            setElapsedMs(0);
            contentRef.current = '';
            setEmptyNotice('');
            setToolCount(0);
            setTurnTokens(0); // what the last turn cost is not what this one costs
            turnCachedRef.current = 0;
            resetRound(); // the turn starts with a round nobody knows anything about yet
            // Tick the indicator every 120ms: spinner frame + tenths of a second of
            // whatever is running now (`segRef`), not of the whole turn.
            beginSegment();
            if (tickRef.current) clearInterval(tickRef.current);
            tickRef.current = setInterval(() => setElapsedMs(Date.now() - segRef.current), 120);
            disarmEsc();
            const abort = new AbortController();
            abortRef.current = abort;
            stopKeyRef.current = '';
            const ai = (host.config.ai ?? {}) as Record<string, any>;
            let failed = false, aborted = false;
            // The loop ran out of rounds with no answer. It is said where the answer
            // would be, in the warn colour, and it replaces the dim line under the
            // field that a wall of grey tool lines would otherwise hide.
            let roundLimit = 0;
            try {
              const chatResult = await (host.services as Record<string, any>).chatLLM(wire, {
                ...llmOpts(ai),
                signal: abort.signal,
                // Debug-log of tool calls (opt-in: config.debug.logTools).
                logTools: !!((host.config as Record<string, any>)?.debug?.logTools),
                // Plugin ai-tools (aiTools): agentChat runs their own run(args, toolCtx).
                extraTools: (host.services as Record<string, any>).pluginAiTools ?? [],
                // What the screens show, read again before every round of the turn and
                // sent at the END of its request, after the conversation — past what the
                // provider caches, and never into the history.
                requestTail: () => screenBlock(screenNow()),
                // What this conversation has loaded; `tools_load` adds to it mid-turn.
                // The mode (`ai.toolLoading`) is applied by the `chatLLM` service.
                toolSet: toolSetRef.current,
                toolCtx: {
                  plan: planRef.current,
                  shell: shellRef.current,
                  memoryFile: memoryFilePath(host.config),
                  // The plugin's OWN host-issued token. The CALLER never supplies a
                  // name here — a raw plugin-name string is ignored by the memory
                  // tool (it resolves `plugin` scope only through a token the host
                  // issued), so a plugin can present itself but not impersonate one.
                  pluginToken: host.pluginToken,
                  askUser: (questions: AskQuestion[]) => new Promise<AskState>((resolve) => {
                    const state = askStart(questions);
                    askRef.current = { state, resolve };
                    setPendingQuestion(state);
                    host.notify();
                  }),
                  // Every service a tool may call through ctx — flattened, not spread:
                  // `host.services` is a per-plugin view whose HOST services sit on its
                  // prototype, and `...obj` copies own properties only. Spreading it
                  // silently handed tools a ctx with no chatLLM, config, showMessage or
                  // pushLog — `background` answered "no LLM service" and nothing ran.
                  ...allServices(host.services),
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
                  host.notify();
                }),
                // A view a tool opened, and every change to it. Its message is pushed on
                // the FIRST change, so it has its place — and its fold id — from the
                // start: a block opened while it ran is still open when it ends.
                onToolLive: (rec: ViewRecord) => offerLive(rec, epoch),
                // What a write changed goes on the answer being written the moment the
                // write lands — a block of its own that stays in the chat. Only on the
                // display message: `apiRef` gets the transcript, which never holds it.
                onToolRun: (run: { changes?: ChangeView[]; views?: unknown[] }) => {
                  // A call whose result arrives after a LATER reset (/clear mid-turn,
                  // most often): the conversation it ran in is gone from both the screen
                  // and `apiRef`, and every one of this callback's effects — the status
                  // line, the flush, the ✎ diff block — belongs to it, never to whatever
                  // is on screen now.
                  if (epoch !== epochRef.current) return;
                  // The tool is done: until the model's next token it is thinking, and
                  // the seconds on the line are the round's from here.
                  endToolSegment();
                  setPhase('thinking');
                  // Any view this call opened has already been placed by `onToolLive`,
                  // final phase included — flush now rather than waiting on the coalesce
                  // timer, so it is on screen before the next round's tool label appears.
                  flushLive();
                  // The call and what it changed go into the turn in its own order: under
                  // the step that led to it, above whatever the model writes next. A call
                  // that left a view is shown by that view (a message of its own, placed
                  // by `onToolLive`), so it is not drawn a second time as a trail line.
                  const call = run.views?.length ? null : callRun(run);
                  const calls: CallRun[] = call ? [call] : [];
                  const changed: TurnPart[] = (run.changes ?? []).map((change) => ({ kind: 'change', change }));
                  if (!calls.length && !changed.length) { host.notify(); return; }
                  setMessages(cur => {
                    const next = cur.slice();
                    const last = next[next.length - 1];
                    if (last?.role === 'assistant') next[next.length - 1] = { ...last, parts: [...addCalls(last.parts ?? [], calls), ...changed] };
                    else next.push({ role: 'assistant', content: '', parts: [...addCalls([], calls), ...changed] });
                    return next;
                  });
                  host.notify();
                },
                onTool: (name: string, args: unknown) => {
                  setToolLabel(`⚙ ${name}(${String(args ?? '').slice(0, 40)})…`);
                  setToolCount(c => c + 1); // call counter for the turn — in the status line
                  beginSegment(); // the seconds on the line are this tool's now
                  host.notify();
                },
                // Diagnostic trace of what EACH round emitted: finish_reason + how many
                // tool_calls streamed. Logged unconditionally so the `l` panel shows
                // whether the model actually attempted a tool call (`finish=tool_calls
                // toolCalls=1`) or just narrated a status change without calling
                // (`finish=stop toolCalls=0`). The missing "▸ tool calls" fold in the
                // chat was AMBIGUOUS — this disambiguates it.
                onRound: (info: { index: number; finishReason: string; toolCalls: number; contentLen: number; usage?: TokenUsage }) => {
                  // This request is done: the next one — after its tools — says a new word.
                  nextVerb();
                  // What the turn costs: a round is billed for its prompt and its
                  // answer, and a turn is several rounds. Only what the provider
                  // actually reported is counted — one that reports nothing leaves the
                  // figure off the screen rather than putting a guess there.
                  if (info.usage) setTurnTokens(turnTokensRef.current + info.usage.promptTokens + info.usage.completionTokens);
                  if (typeof info.usage?.cachedTokens === 'number') turnCachedRef.current += info.usage.cachedTokens;
                  (host.services as Record<string, any>).pushLog?.(`[round ${info.index}] finish=${info.finishReason} toolCalls=${info.toolCalls} content=${info.contentLen}ch${info.usage ? ` tokens=${info.usage.promptTokens + info.usage.completionTokens}` : ''}`);
                },
                // Round content streams LIVE (the agent calls onLive per token) into `live`,
                // drawn in full and dim with a live mark until the round says what it is:
                // `onRoundKind` — it carries a tool call, so it is a step — or the round
                // ending without one (`onLiveCommit(…, true)`) — the answer.
                // This round carries tool calls — heard the moment the first fragment
                // of one arrives. Whatever of its text is on screen stays exactly where
                // it is: in `step` it joins its run's row, in `open` it keeps its rows.
                onRoundKind: () => {
                  roundToolsRef.current = true;
                  setMessages(cur => {
                    const next = cur.slice();
                    const last = next[next.length - 1];
                    if (last?.role === 'assistant' && last.live) next[next.length - 1] = { ...last, liveQuiet: true };
                    return next;
                  });
                  host.notify();
                },
                onLive: (delta: string) => {
                  if (!delta) return;
                  endToolSegment(); // the tool is done: the model is writing
                  setPhase('writing');
                  // Read now, not in the updater (see `roundToolsRef`): a tool call that
                  // came before the text makes the text a step from its first character.
                  const quiet = roundToolsRef.current;
                  setMessages(cur => {
                    const next = cur.slice();
                    const last = next[next.length - 1];
                    if (last?.role === 'assistant') next[next.length - 1] = { ...last, live: (last.live || '') + delta, liveQuiet: quiet || last.liveQuiet === true };
                    else next.push({ role: 'assistant', content: '', live: delta, liveQuiet: quiet });
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
                // End of a round: where its text goes. isAnswer=true — the final answer
                // (`content`), false — a step, appended to the turn's parts in its place.
                // Either way the rows it was drawn with stay where they are.
                onLiveCommit: (text: string, isAnswer: boolean) => {
                  // contentRef is fixed SYNCHRONOUSLY (not in the setMessages updater):
                  // react defers the updater to render, while send() reads contentRef in
                  // finally right after await — there it would still be empty, and the
                  // «limit of steps» warning popped even on a normal answer.
                  if (isAnswer) contentRef.current = text;
                  // The next round starts knowing nothing — reset here, where the
                  // callback fires, never in the updater below.
                  resetRound();
                  const step: TurnPart[] = !isAnswer && text.trim() ? [{ kind: 'text', text }] : [];
                  setMessages(cur => {
                    const next = cur.slice();
                    const last = next[next.length - 1];
                    if (last?.role !== 'assistant') {
                      // A fresh message (a tool's view landed under the last one). It is
                      // pushed even for a round that said nothing, as it always was: the
                      // turn's trail and how it ended go on the message after the view.
                      next.push({ role: 'assistant', content: isAnswer ? text : '', ...(step.length ? { parts: step } : {}) });
                      return next;
                    }
                    // The answer is only added to, never replaced: the rows stay exactly
                    // as they were drawn and simply stop being provisional.
                    if (isAnswer) next[next.length - 1] = { ...last, content: text, live: '', liveQuiet: false };
                    else next[next.length - 1] = { ...last, parts: endRound(last.parts ?? [], text), live: '', liveQuiet: false };
                    return next;
                  });
                },
              });
              (host.services as Record<string, any>).pushLog?.(`[chat] ${q.slice(0, 40)}… → ${q.length} chars${images.length ? ` + ${images.length} image${images.length === 1 ? '' : 's'}` : ''}`);
              roundLimit = Number((chatResult as { roundLimit?: number } | undefined)?.roundLimit ?? 0);
              const turn = (chatResult as { transcript?: ChatMessage[]; content?: string } | undefined);
              const reported = (chatResult as { usage?: TokenUsage } | undefined)?.usage;
              if (reported) usageRef.current = reported;
              apiRef.current = [
                ...apiRef.current,
                ...(turn?.transcript?.length ? turn.transcript : [{ role: 'assistant', content: turn?.content ?? '' }]),
              ];
              // The calls are already in the turn, where they were made (`onToolRun`).
              const runs = (chatResult as { toolRuns?: unknown[] } | undefined)?.toolRuns ?? [];
              // After a real write the plugins reload what they show — otherwise an open
              // document keeps the text from before the write. It does not close the chat.
              if (runs.some(r => (r as { write?: boolean; outcome?: string }).write && (r as { outcome?: string }).outcome === 'applied')) {
                void (host.services as { afterWrite?: () => Promise<void> }).afterWrite?.();
              }
            } catch (e) {
              // Esc during a stream is an expected cancel (AbortError) — not shown as an
              // error in the panel, but logged quietly.
              if ((e as Error)?.name === 'AbortError') {
                aborted = true;
                (host.services as Record<string, any>).pushLog?.('[chat] aborted by user');
              } else {
                failed = true;
                setError((e as Error).message);
                (host.services as Record<string, any>).pushLog?.(`[chat] error: ${(e as Error).message}`);
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
              const cachedSpent = turnCachedRef.current;
              setMessages(cur => {
                // A round cut off by Esc or an error never said what it was. Its text
                // stays where it was drawn: a round known to carry a tool call — or
                // one that began with the `Next:` plan the prompt asks for before a
                // call — is a step (drawn exactly as it streamed, the token never);
                // any other is what the answer had come to (and the line under it
                // says it was stopped).
                const next = cur.map((m): ChatMsg => {
                  if (m.role !== 'assistant' || !m.live) return m;
                  const { live, liveQuiet, ...rest } = m;
                  return liveQuiet || startsWithNext(live)
                    ? { ...rest, parts: [...(rest.parts ?? []), { kind: 'text', text: live }] }
                    : { ...rest, content: `${rest.content ?? ''}${live}` };
                });
                const at = answerAt(next);
                if (at >= 0) next[at] = { ...next[at]!, duration: finalMs, ...(spent ? { tokens: spent } : {}), ...(cachedSpent ? { cached: cachedSpent } : {}), ...(aborted ? { stopped: true, ...(stopKeyRef.current ? { stoppedBy: stopKeyRef.current } : {}) } : {}), ...(roundLimit ? { roundLimit } : {}) };
                return next;
              });
              // Empty answer: the model gave only reasoning but no final text — say so
              // explicitly. Error and cancel (Esc) are not an empty answer — they
              // already have their own indication (⚠ error / quiet log); neither is a
              // turn that ran out of rounds, which now says so in the conversation
              // itself, where the answer would have been.
              if (!contentRef.current.trim() && !failed && !aborted && !roundLimit) {
                const opens = firstGlyph(host.keys.details);
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
              // A reset mid-turn already cleared liveBuf/liveSeen/liveTimer — this is
              // for the ordinary case, and a stale one finds nothing to flush regardless.
              if (epoch === epochRef.current) flushLive();
              persist();
              setStreaming(false);
              setToolLabel('');
              abortRef.current = null;
              // The person's queued messages go first, in order; a stopped or failed
              // turn puts them back into the field instead (`restoreQueue`) rather than
              // firing them into a conversation just stopped.
              if (!aborted && !failed && queueRef.current.length) {
                const nextQueued = queueRef.current.shift() as string;
                syncQueue();
                setTimeout(() => { void send(nextQueued); }, 0);
              } else {
                restoreQueue();
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
          // `interactive` is `!!command` (src/assistant/interactive.ts): the program gets
          // the terminal, what it printed is recorded, and once it is back the recording
          // lands the same way — and a turn starts at once with the host's ask to look at
          // it. Refused while anything runs, exactly as `!` is: a program taking the
          // terminal under a running turn would put its recording in the middle of that
          // turn's history, and hide a y/n the turn may be waiting on.
          const runShellCommand = async (cmd: string, interactive = false) => {
            if (streamRef.current) { setError('an answer or a command is still running — wait, or stop it with Esc'); return; }
            if (!cmd) { setError(interactive ? '!! runs an interactive program with the terminal — e.g. !!git add -p' : '! runs a shell command — e.g. !git status'); return; }
            streamRef.current = true; // closed synchronously, as in send()
            const line = encodeBangLine(interactive ? 2 : 1, cmd);
            pushHistory(historyRef.current, line);
            histAt.current = null;
            histShown.current = '';
            // The field is emptied now: the command is in its block from here on.
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
            stopKeyRef.current = '';
            const cwd = shellRef.current.cwd();
            const { timeoutMs, maxChars } = shellLimits(host.config as { shell?: unknown });
            let stopped = false;
            // The person's command gets the same live block as the model's. The message
            // is still role `shell`: it joins apiRef and ↑/↓ as it always did. Declared
            // OUTSIDE the try so the catch below can still find the message by `callId`
            // if something throws after it was pushed; `epoch` is this command's own
            // conversation identity, captured now — a completion that arrives after a
            // LATER /clear (or /resume) must not touch the fresh
            // conversation's messages, session-facing history or shell directory.
            const startedAt = Date.now();
            const callId = `shell#${startedAt}`;
            const liveRec = (data: unknown, phase: ViewRecord['phase'] = 'live'): ViewRecord => ({ kind: 'console', data, phase, startedAt, callId });
            const epoch = epochRef.current;
            // Set once an interactive run's recording has joined the model's history: the
            // turn that looks at it starts when this command is done (the `finally`).
            let ask = false;
            try {
              liveSeen.current.add(callId);
              setMessages((cur) => [...cur, { role: 'shell', content: '', command: cmd, views: [{ ...liveRec(capConsoleData({ command: cmd, cwd: tildePath(cwd), text: '', showCwd: true, interactive })), turn: turnRef.current }] }]);
              let raw = '';
              const onOutput = (chunk: string) => {
                raw += chunk;
                if (raw.length > maxChars * 2) raw = raw.slice(-maxChars);
                offerLive(liveRec(capConsoleData({ command: cmd, cwd: tildePath(cwd), text: raw, showCwd: true })), epoch);
              };
              // The interactive run holds no AbortController of its own: while it runs the
              // terminal is the program's, and no key reaches the chat (flowtty's TTY
              // backend stops reading its input for the hand-over) — Esc and Ctrl+C are
              // the program's keys.
              let recorded = true;
              let r: ShellResult;
              if (interactive) {
                const svc = host.services as { suspend?: <T>(fn: () => T | Promise<T>) => Promise<T>; interactive?: InteractiveDeps };
                const run = await runInteractive(cmd, { cwd, maxChars, suspend: svc.suspend ?? (async (fn) => fn()) }, svc.interactive ?? {});
                r = run.result;
                recorded = run.recorded;
              } else {
                r = await runShell(cmd, { cwd, timeoutMs, maxChars, signal: abort.signal, onOutput });
              }
              stopped = r.stopped;
              if (r.stopped && stopKeyRef.current) r.stoppedBy = stopKeyRef.current;
              const move = nextCwd(host.config as Record<string, unknown>, cwd, r.pwd);
              const { display, forModel } = formatShell(cmd, r, cwd, timeoutMs, { after: move.cwd, note: move.note, ...(interactive ? { interactive: { recorded } } : {}) });
              // Everything from here on is display/model-facing state for THIS
              // conversation — skipped whole for a stale epoch (a /clear mid-command:
              // the command still finishes, and without this its block would land in
              // the fresh, cleared chat).
              if (epoch === epochRef.current) {
                // `cd` sticks, as in a terminal — within the roots.
                if (move.cwd !== cwd) shellRef.current.setCwd(move.cwd);
                flushLive();
                // The block says where a `cd` inside the command left the directory — or
                // that one tried to leave the roots and stayed — the same facts the old
                // markdown line carried, now on the live view instead.
                const data = consoleData(cmd, r, cwd, timeoutMs, true, { movedTo: tildePath(move.cwd), note: move.note, interactive });
                setMessages((cur) => {
                  const next = cur.slice();
                  const at = next.findLastIndex((m) => callOf(m) === callId);
                  const done = { role: 'shell', content: display, command: cmd, views: [{ ...liveRec(data, 'done'), turn: turnRef.current }] };
                  if (at >= 0) next[at] = done; else next.push(done);
                  return next;
                });
                // An interactive run reaches the model only with something to look at: no
                // `script` to record with, or nothing left once the full-screen program's
                // own screen is dropped (vim, less, top), and it is only a block on screen —
                // a turn spent on "(no output)" would cost a request for nothing.
                const seen = !interactive || (recorded && !!r.output.trim());
                if (seen) apiRef.current = [...apiRef.current, { role: 'shell', content: forModel }];
                if (interactive && !r.error && !seen) {
                  const why = recorded
                    ? 'Nothing was printed outside the full-screen program — the assistant was not asked.'
                    : 'No usable `script` on PATH — the program ran with the terminal, but nothing was recorded, so the assistant was not asked.';
                  setMessages((cur) => [...cur, { role: 'note', content: why }]);
                }
                ask = interactive && seen;
              }
              (host.services as Record<string, any>).pushLog?.(`[shell] ${interactive ? '!! ' : ''}${cmd.slice(0, 60)} → ${r.error ? `error: ${r.error}` : r.stopped ? 'stopped' : r.timedOut ? 'timed out' : r.signal ? `killed by ${r.signal}` : `exit ${r.code}`}`);
            } catch (e) {
              stopped = true; // a command that could not run keeps the queue, as a failed turn does
              setError(`!: ${(e as Error).message}`);
              // The block stops ticking rather than waiting forever for a completion
              // that is never coming — marked failed in place, keeping whatever it had
              // already shown (the way a tool's own thrown view does, agent.ts).
              if (epoch === epochRef.current) {
                setMessages((cur) => {
                  const next = cur.slice();
                  const at = next.findLastIndex((m) => callOf(m) === callId);
                  if (at < 0) return cur;
                  const target = next[at]!;
                  const views = (target.views as ViewRecord[] | undefined) ?? [];
                  if (!views.length) return cur;
                  next[at] = { ...target, views: [{ ...views[0]!, phase: 'failed', turn: turnRef.current }] };
                  return next;
                });
              }
            } finally {
              if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
              setElapsedMs(Date.now() - t0Ref.current);
              // An interactive run that was recorded goes on into the turn that looks at
              // it. The chat stays BUSY until that turn has started (the `send` waits one
              // tick, for the render that carries the command's block): a message typed
              // in between queues behind the ask, as behind any turn — never ahead of it.
              const askNow = ask && epoch === epochRef.current;
              streamRef.current = askNow;
              if (epoch === epochRef.current) flushLive();
              persist();
              if (!askNow) setStreaming(false);
              setToolLabel('');
              abortRef.current = null;
              if (askNow) {
                setTimeout(() => {
                  streamRef.current = false;
                  if (epoch !== epochRef.current) { setStreaming(false); return; }
                  void send(INTERACTIVE_ASK, { hostAsk: true });
                }, 0);
              }
              // What the person queued meanwhile goes out now — unless they stopped the
              // command: then it comes back into the field, as after a stopped answer.
              else if (!stopped && queueRef.current.length) {
                const nextQueued = queueRef.current.shift() as string;
                syncQueue();
                setTimeout(() => { void send(nextQueued); }, 0);
              } else {
                restoreQueue();
                setTimeout(() => flushPending(), 0);
              }
              host.notify();
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
          // Esc and Ctrl+C stop it like a turn: it gets the turn's AbortController, and
          // the wait is raced against the abort, so a request that ignores its signal
          // still lets go of the chat at once. `fn` checks the signal before it applies
          // anything, so a result arriving after the stop changes nothing.
          const runAsyncCommand = (label: string, fn: (signal: AbortSignal) => Promise<void>): void => {
            if (streamRef.current) return;
            streamRef.current = true; // closed synchronously, as in send()
            const abort = new AbortController();
            abortRef.current = abort;
            stopKeyRef.current = '';
            const stopped = new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true }));
            // The command leaves the field the moment it is submitted, as a sent message
            // does (it is in ↑ already); what the person types while it runs is theirs.
            setField('');
            let ok = false;
            setError(null);
            setStreaming(true);
            setToolLabel(`⚙ ${label}…`);
            t0Ref.current = Date.now();
            beginSegment(); // the command is the one thing running
            if (tickRef.current) clearInterval(tickRef.current);
            tickRef.current = setInterval(() => setElapsedMs(Date.now() - segRef.current), 120);
            Promise.race([fn(abort.signal), stopped])
              .then(() => { ok = !abort.signal.aborted; })
              .catch((e) => setError((e as Error)?.name === 'AbortError' ? `/${label} stopped (${stopKeyRef.current || keyGlyph('escape')})` : (e as Error).message))
              .finally(() => {
                if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
                setElapsedMs(Date.now() - t0Ref.current);
                if (abortRef.current === abort) abortRef.current = null;
                streamRef.current = false;
                setStreaming(false);
                setToolLabel('');
                // What was queued meanwhile goes out now, as after an answer — unless the
                // command was stopped or failed: then it comes back into the field.
                if (ok && queueRef.current.length) {
                  const nextQueued = queueRef.current.shift() as string;
                  syncQueue();
                  setTimeout(() => { void send(nextQueued); }, 0);
                } else restoreQueue();
                host.notify();
              });
          };

          const compactNow = () => {
            if (streamRef.current || apiRef.current.length < 2) return;
            // The command body; the spinner/label/elapsed-tick live in
            // runAsyncCommand, which clears streaming/toolLabel on completion.
            runAsyncCommand('compact', async (signal) => {
              const ai = (host.config.ai ?? {}) as Record<string, any>;
              // How big the model's view was — as `ctx N%` read it.
              const before = contextReading().used;
              // Compact what the MODEL saw (tool results included), not the display list.
              const summary = await compactConversation(apiHistory(apiRef.current), { ...llmOpts(ai), signal });
              if (signal.aborted) return; // stopped: the history stays as it was
              summaryRef.current = summaryRef.current ? `${summaryRef.current}\n\n${summary}` : summary;
              usageRef.current = null; // the measured size was of the history just replaced
              apiRef.current = [];
              // The loaded tools stay (`toolSetRef`): the work the summary describes goes on
              // with them, and loading them again would spend a round for nothing.
              // What the MODEL sees shrank to the summary; what the PERSON sees stays —
              // the conversation above is theirs to scroll. (Wiping it down to
              // the last message instead would read as /clear.) A note marks where the model's
              // view now begins — one row, how big that view was and is now (the same
              // reading `ctx N%` shows) — with the summary it was given folded under it.
              const after = contextReading().used;
              const sizes = before > 0 && after > 0 ? ` · ~${shortTokens(before)} → ~${shortTokens(after)} tokens` : '';
              setMessages((cur) => [...cur, { role: 'note', content: `── compacted${sizes} ──`, summary }]);
              persist();
              (host.services as Record<string, any>).showMessage?.('History compacted');
            });
          };

          // ── Attaching an image ── a dropped or pasted path, `/image`, Ctrl+V. What the
          // person attaches goes into the field as a token, `[Image #N]`, at `base` (the
          // field as it stands, or an empty one for `/image`); a refusal says why, and
          // nothing is attached — never a file shrunk or dropped quietly.
          type ImagesRead = { images: false; error: string } | { images: true; loaded: LoadedOk[]; refusal: string | null };
          const readImages = (paths: string[], base: string): ImagesRead => {
            const lim = imageLimits(host.config.ai);
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
            host.notify();
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
            if (!imageLimits(host.config.ai).enabled) { setError(`not attached: ${IMAGES_OFF}`); return; }
            const read = (host.services as { clipboardImage?: () => ClipboardImage }).clipboardImage ?? (() => readClipboardImage());
            const clip = read();
            if (!clip.ok) {
              if (from === 'key' && clip.none) (host.services as Record<string, any>).showMessage?.(clip.error);
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
          const fieldTakesImages = () => !bangLevelRef.current && !/^\s*[/!]/.test(inputRef.current);

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
                (host.services as Record<string, any>).showMessage?.(autoSaid(next));
                host.notify();
                return;
              }
              case 'notes': {
                // How the steps are drawn, for THIS conversation. The config key is where
                // a conversation starts; this moves it from there and nothing is saved —
                // /clear comes back to the config's own answer. The bare command says
                // where things stand rather than toggling.
                const want = notesCommand(arg);
                if (!want) { setError('/notes takes step or open — or nothing to say which is on'); return; }
                const next = want === 'say' ? notesRef.current : want;
                setNotes(next);
                setField('');
                (host.services as Record<string, any>).showMessage?.(notesSaid(next));
                host.notify();
                return;
              }
              case 'mode': {
                // For the person; nothing is sent. `/mode panel|window|full` moves the
                // chat for the session and gives it the keyboard; `/mode` alone says
                // where it is — in the chat, as a note (display only, like /memory's
                // list): a toast is drawn under a chat that covers the whole terminal.
                const v = arg.trim().toLowerCase();
                if (v && !(CHAT_MODES as readonly string[]).includes(v)) { setError(`/mode takes ${CHAT_MODES.join(', ')} — or nothing to say which is on`); return; }
                setField('');
                if (!v) {
                  const small = modeRef.current === 'panel' && layoutRef.current !== 'panel' ? ' (drawn as a window: the terminal is too small for a panel)' : '';
                  setMessages((cur) => [...cur, { role: 'note', content: `the chat is in ${modeRef.current} mode${small} · /mode ${CHAT_MODES.join('|')}` }]);
                  host.notify();
                  return;
                }
                setMode(v as ChatMode);
                return;
              }
              case 'log': {
                const svc = host.services as Record<string, any>;
                const shared = logShareMessage((svc.log?.read?.() ?? svc.logs ?? []) as string[], arg);
                if (shared) void send(shared); else setError('the log is empty — nothing to share');
                return;
              }
              case 'memory': {
                // The person's own view of the model's memory; nothing here reaches the
                // model. A `note` is a display-only message: `apiRef` — the model's
                // history — is not touched.
                const file = memoryFilePath(host.config);
                const res = memoryCommand(arg, loadMemories(file));
                if (res.next) saveMemories(res.next, file);
                setMessages((cur) => [...cur, { role: 'note', content: res.note }]);
                setField('');
                host.notify();
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
                  host.notify();
                  return;
                }
                const pick = Number.isInteger(n) && n >= 1 ? list[n - 1] : undefined;
                if (!pick) { setError(`/resume takes a number from the list (1–${list.length})`); return; }
                if (streamRef.current) { setError('an answer is still coming — stop it (Esc) before switching sessions'); return; }
                // The fingerprint first, stat before the content read just below — see
                // applySession's own comment for why the order matters.
                const fp = sessionFingerprint(sessDir, pick.id);
                const s = loadSession(sessDir, pick.id);
                if (!s) { setError('that session file cannot be read'); return; }
                // Held by another live flow-assist process: refuse and stay put. Own
                // lock already, or free/stale, and this acquires it — side-effect free
                // when held, so nothing to undo on the refusal below.
                if (pick.id !== sessionIdRef.current) {
                  const outcome = acquireLock(sessDir, pick.id, lockToken);
                  if (outcome.status === 'held') {
                    setMessages((cur) => [...cur, { role: 'note', content: `Session "${pick.title || pick.id}" is open in another flow-assist process. (lock: ${lockPath(sessDir, pick.id)})` }]);
                    setField('');
                    host.notify();
                    return;
                  }
                }
                dismissAsk();
                queueRef.current = []; setQueued([]); bgQueueRef.current = [];
                setError(null); setEmptyNotice(''); setToolLabel(''); setToolCount(0);
                if (pick.id !== sessionIdRef.current) releaseCurrentLock(); // leaving the old one for /resume
                applySession(s, fp);
                (host.services as Record<string, any>).showMessage?.(`Resumed «${s.title || 'session'}»`);
                host.notify();
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
                releaseCurrentLock();
                sessionIdRef.current = ''; createdAtRef.current = ''; fingerprintRef.current = NO_FILE;
                if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
                abortRef.current?.abort(); abortRef.current = null;
                if (pendingRef.current) settleConfirm(false);
                dismissAsk();
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
                resetLiveViews(); // the calls they tracked are gone with the conversation
                resetImages(); // numbering starts again at [Image #1]
                usageRef.current = null; // measured for a conversation that is gone
                // /clear ends the conversation, not the memory — and says so, or the
                // assistant "still knowing" an earlier prompt reads as /clear failing.
                {
                  const kept = keptAfterClear(loadMemories(memoryFilePath(host.config)));
                  setMessages(kept ? [{ role: 'note', content: kept }] : []);
                }
                setInput(''); inputRef.current = '';
                setCursor(0);
                setBangLevel(0); // a fresh conversation opens on a plain prompt
                setAutoMode('ask'); // and asks again: the mode was granted for the work just cleared
                setNotes(configNotes()); // the steps go back to what the config asks for
                resetRound(); // the round being written belonged to work that is gone
                setError(null);
                setEmptyNotice('');
                setToolCount(0);
                setToolLabel('');
                setElapsedMs(0);
                setFolds(allFolded()); // everything folded again, and no exceptions left over
                setStreaming(false);
                disarmEsc();
                host.notify();
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
                const done = (host.services as { copy?: (t: string) => { ok: boolean; error?: string } }).copy?.(target.text) ?? copyToClipboard(target.text);
                if (!done.ok) { setError(`/copy: ${done.error}`); return; }
                setField('');
                (host.services as Record<string, any>).showMessage?.(`Copied ${target.what} — ${Array.from(target.text).length} chars`);
                host.notify();
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

          // Which side has the keyboard (docked and open). Patched into the store at once,
          // like `open`: the App reads it for the footer and the title bar's mark.
          const setFocus = (next: 'chat' | 'plugin') => {
            if (next !== 'chat') disarmEsc();
            setFocusState(next);
            focusRef.current = next;
            publish({ focus: next });
            host.notify();
          };

          // Closing does NOT abort the stream: the chat component is always mounted, the
          // answer finishes «in the background» and is visible on re-open. Session is not
          // cleared. Closing via Esc//exit just disarms the exit and hides the panel.
          // Docked, "closed" is COLLAPSED: the panel folds away and the plugin gets the
          // keyboard; the conversation and a running turn carry on.
          // A pending y/n or question is NOT answered by closing — folding the chat away
          // (Ctrl+], the collapse key) is not a "no". It stays pending, the closed chat
          // says it is waiting (`statusRow`), and opening it shows it again. Esc still
          // declines or dismisses it first, in the handler, before Esc Esc can close;
          // `/exit` cannot be typed while one is up.
          const closeChat = () => {
            disarmEsc();
            writeSession(); // the draft too
            setOpen(false);
            openRef.current = false; // the background flush may fire before the next render
            publish({ open: false });
            setFocus('plugin');
          };

          // Opening the chat continues the conversation whatever the screen shows: what
          // is on screen reaches the model at the end of every request
          // (`screenNow`), and a person who wants a fresh conversation says /clear.
          // Docked, opening is expanding — and the keyboard comes with it.
          const openChat = (initialText?: string) => {
            setOpen(true);
            openRef.current = true;
            setUnread(0);
            unreadRef.current = 0;
            setFocusState('chat');
            focusRef.current = 'chat';
            publish({ open: true, unread: 0, focus: 'chat' });
            setError(null);
            // Only a caller that brings text replaces the field: re-opening the chat
            // keeps the draft the person left in it.
            if (initialText !== undefined) {
              setInput(initialText);
              inputRef.current = initialText;
              setCursor(Array.from(initialText).length);
            }
            disarmEsc();
            host.notify();
            if (initialText?.trim()) send(initialText);
          };

          // `/mode`: the chat moves and keeps everything it holds (the App's slots do not
          // change with it — src/runtime/app.tsx); it comes up open, with the keyboard.
          const setMode = (next: ChatMode) => {
            setModeState(next);
            modeRef.current = next;
            publish({ mode: next });
            openChat();
          };

          // Ctrl+] (`chatFocus`) and the collapse key (`chatCollapse`), taken by the App
          // before any handler. Docked: Ctrl+] brings a collapsed panel back with the
          // keyboard, else moves the keyboard to the other side; the collapse key folds
          // the panel away (the plugin gets the keys) and brings it back. In a window or
          // the whole terminal Ctrl+] opens the chat or closes it — the plugin has the
          // keyboard whenever the chat is not over it — and the collapse key is nobody's.
          // A panel drawn as a window on a terminal too small to dock on answers both keys
          // the way a window answers Ctrl+] — the person asked for a panel, and the key
          // that collapses one must not go dead.
          const panelKey = (which: 'focus' | 'collapse'): boolean => {
            if (layoutRef.current !== 'panel') {
              if (which === 'collapse' && modeRef.current !== 'panel') return false;
              if (openRef.current) closeChat(); else openChat();
              return true;
            }
            if (!openRef.current) { openChat(); return true; }
            if (which === 'collapse') { closeChat(); return true; }
            setFocus(focusRef.current === 'chat' ? 'plugin' : 'chat');
            return true;
          };
          // A press on the screen: the keyboard goes to the pane it landed in, as a click
          // into a window does anywhere else.
          const pointer = (x: number, y: number) => {
            const d = (host.services as { chatDock?: PanelLayout | null }).chatDock;
            if (layoutRef.current !== 'panel' || !openRef.current || !d || d.collapsed) return;
            const next = inRect(d.panel, x, y) ? 'chat' : 'plugin';
            if (next !== focusRef.current) setFocus(next);
          };

          // Ctrl+C / Ctrl+D / Ctrl+Z are the App's (src/runtime/exit-keys.ts: a second
          // press exits or suspends), taken before any handler — a pending y/n or an
          // open question would swallow them. The open chat speaks first:
          // - Ctrl+C with a turn or a `!command` running stops it, exactly as Esc does
          //   (a pending y/n is declined and a question dismissed first, or the turn
          //   would wait on them forever) — 'handled', and nothing is armed;
          // - Ctrl+D in a field with text is the editor's forward delete — 'field', and
          //   the key goes to the handler below; in an empty field it arms the exit.
          // Any of the three disarms Esc's own exit, as every other key does.
          const ctrlKey = (key: { name?: string }): 'handled' | 'field' | undefined => {
            // Docked with the plugin at the keys, these are the plugin's side's, as with
            // the chat closed.
            if (!openRef.current || (layoutRef.current === 'panel' && focusRef.current !== 'chat')) return undefined;
            disarmEsc();
            if (key.name === 'c' && canStop()) {
              if (pendingRef.current) settleConfirm(false);
              dismissAsk();
              stopKeyRef.current = keyGlyph({ name: 'c', ctrl: true });
              abortRef.current?.abort();
              return 'handled';
            }
            if (key.name === 'd' && inputRef.current !== '') return 'field';
            return undefined;
          };
          // What the collapsed panel says of the running turn — on the plugin's bottom row
          // (the App draws it there) or on the one row a bottom panel keeps. The key that
          // brings the panel back, from its binding.
          // A y/n or a question left pending when the chat was closed says so in every
          // mode — on the footer row in a window or the whole terminal too (Ctrl+] closes
          // those, and the question must not be forgotten behind them).
          const focusCap = bindingGlyph(host.keys.chatFocus);
          const waiting = !open && (!!pendingAsk || !!pendingQuestion);
          const statusRow = !open && (layout === 'panel' || waiting)
            ? renderChatStatus({ theme: host.config.theme as never, streaming, toolLabel, phase, verb, elapsed: elapsedMs, keyHint: focusCap ? `${focusCap} chat` : '', waiting })
            : null;
          // The App draws that status on the plugin's footer row as a component that ticks
          // by itself (`liveChatStatus`), reading what this render built — so the seconds
          // move without the whole App, the plugin's surface with it, being redrawn for
          // them. The App is asked to redraw only when the status comes or goes: a turn
          // starts or ends collapsed, or starts or stops waiting on the person.
          const collapsedBusy = layout === 'panel' && !open && !waiting && (streaming || !!toolLabel);
          const statusRef = ui.useRef<unknown>(null);
          statusRef.current = statusRow;
          ui.useEffect(() => { host.notify(); }, [collapsedBusy, waiting]);
          // `footerStatus`: the status goes on the plugin's footer row (not on a bottom
          // panel's own strip), and it names the key that brings the chat back — the
          // footer's `F chat` beside it would say "chat" twice.
          // With Ctrl+]'s action unbound the status names no key, and the footer's own
          // hint is the only way back that is said.
          const footerStatus = statusRow != null && dock?.side !== 'bottom' && !!focusCap;
          // The rows a pending question or y/n needs at a panel's width (the App grows a
          // bottom panel to it, or draws the chat as a window while it waits — see
          // `pendingChatRows`). Read from the refs: the App asks before this re-renders.
          const needRows = (w: number): number => {
            const c = pendingRef.current;
            return pendingChatRows({
              width: w,
              question: askRef.current?.state ?? null,
              confirm: c ? { name: c.name, args: c.args, command: shellCommandOf(c.name, c.args) ?? undefined } : null,
              todo: planRef.current.snapshot(),
              queued: queueRef.current.length,
            });
          };
          (host.store as Record<string, any>).chat = { open, unread, mode, focus, openChat, closeChat, send, messages, streaming, toolLabel, cursor, escArmed, pendingConfirm: pendingAsk, ctrlKey, panelKey, pointer, statusRow: statusRow ? liveChatStatus(() => statusRef.current as never, collapsedBusy) : null, footerStatus, layout, needRows };
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
            const followUp = (host.config.ai as { backgroundFollowUp?: unknown } | undefined)?.backgroundFollowUp === true;
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
              (host.services as { alert?: (title: string, body?: string) => void }).alert?.('flow-assist', String(q).split('\n')[0].slice(0, 120));
            }
            host.notify();
          };
          // A host-reachable channel to inject a message into the chat from OUTSIDE
          // (e.g. a `background` task's result). Registered per render (idempotent) so
          // a detached timer reads the latest closure — the same live-reference pattern
          // as the React-bound services. Reads live state via refs, so an old closure is
          // still current. Results are QUEUED, not dropped: if the chat is busy (mid-
          // answer or drafting), the result waits here and is auto-analyzed when the
          // chat goes idle — so a back-to-back burst of background tasks all land.
          (host.services as Record<string, any>).postToChat = (text: string) => {
            const q = String(text ?? '').trim();
            if (!q) return;
            bgQueueRef.current.push(q);
            if (!flushTimer.current) flushTimer.current = setInterval(() => flushPending(), 400);
            flushPending();
          };
          // While the chat is open it owns the KEYBOARD: priority 100 (like log/tags).
          // The host dims the overlay-detail via ui.modalActive, so its consumer (also
          // 100) does not contend for 'r'/'c' etc.
          host.useInputHandler({
            mode: 'consume',
            // Docked with the plugin at the keys, the chat asks for none — only for what
            // nobody else took (priority 1), which is the wheel over its conversation.
            priority: (ui) => ui.cmdOpen ? 0 : (focused ? 100 : open ? 1 : 0),
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
              // A click in the panel folds whichever side has the keyboard.
              if (isMouseButton(key.name)) return mouse(key);
              if (!focused) {
                // The conversation's own list does not hear the wheel while the plugin
                // has the keys; over the list it still scrolls it.
                const v = viewportRef.current;
                if ((key.name === 'wheelup' || key.name === 'wheeldown') && v && typeof key.x === 'number' && typeof key.y === 'number'
                  && key.x >= v.left && key.x < v.left + v.width && key.y >= v.top && key.y < v.top + v.height) {
                  wheelRef.current?.(key.name === 'wheelup');
                  return true;
                }
                return false;
              }
              // While awaiting a write confirmation (y/n pause), the chat consumes ALL
              // keys: 'y'/⏎ — confirm, 'n'/Esc — decline; normal field input is paused.
              // An open question consumes every key too: arrows/digits/Space/⏎ answer it,
              // Esc dismisses it, and in the free-text field every printable key is text.
              if (askRef.current) {
                // The same width the block draws its field in, so the caret moves the
                // way it is shown to move.
                const next = askKey(askRef.current.state, key, askFieldWidth(chatWrapWidth(width, fullscreenRef.current)));
                if (next.done) settleAsk(next);
                else { askRef.current.state = next; setPendingQuestion(next); host.notify(); }
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
              // ── Bang level: `!` on an EMPTY field steps it UP (0 → 1 shell mode →
              // 2 interactive mode) instead of being typed — the field never holds the
              // bang itself, unlike the legacy path below. After other text, or
              // already at level 2 (the top), `!` falls through to the editor as a
              // plain character (a shell command may start with one, and so may text
              // typed at level 2). Backspace on an empty field steps the level back
              // DOWN by one, without deleting anything else — there is nothing there
              // to delete.
              if (key.name === '!' && !key.ctrl && !key.meta && bangLevel < 2 && inputRef.current === '') {
                setBangLevel((bangLevel + 1) as 1 | 2);
                return true;
              }
              if (key.name === 'backspace' && bangLevel > 0 && inputRef.current === '') {
                setBangLevel((bangLevel - 1) as 0 | 1);
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
                  host.notify();
                  return true;
                }
              }
              // ── Esc: a turn (or a `!command`) running → stop it, on the FIRST press,
              // touching neither the field nor the queue — the queue comes back into the
              // field once the turn has ended (see `restoreQueue`). Clearing the
              // field and taking the queue back first instead would mean, with a message
              // queued, that the second Esc throws the message
              // away and only the third stops the tool. Idle: non-empty field → clear; empty field at a non-zero bang
              // level → step the level DOWN by one, same as Backspace (closest thing
              // first, before Esc starts arming a chat-wide exit) — leaving `!!` for
              // good this way takes two Escs, one per level; armed → close (docked, that
              // is collapse: closeChat folds the panel and hands the plugin the keys);
              // otherwise arm + hint «Esc again to exit» («… to collapse» docked).
              if (key.name === 'escape') {
                if (canStop()) { stopKeyRef.current = ''; abortRef.current?.abort(); disarmEsc(); return true; }
                if (inputRef.current.length > 0) {
                  setInput(''); inputRef.current = '';
                  setCursor(0);
                  disarmEsc();
                  return true;
                }
                if (bangLevel > 0) {
                  setBangLevel((bangLevel - 1) as 0 | 1);
                  disarmEsc();
                  return true;
                }
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
                (host.services as Record<string, any>).showMessage?.(autoSaid(next));
                host.notify();
                return true;
              }
              // ── Tab: completion — a `/command`, its argument, a path in shell mode
              // (`chatComplete`). It takes the offer drawn after the caret and then walks
              // the other candidates, the `:` line's way; only with the caret at the end
              // of a one-line field, where the offer is drawn.
              if (key.name === 'tab' && !key.meta && !key.ctrl) {
                const text = inputRef.current;
                if (!text.includes('\n') && cursorRef.current >= text.length) {
                  const next = lineTab(text, tabRef.current, chatComplete);
                  tabRef.current = next.walk;
                  if (next.input !== text) {
                    setInput(next.input); inputRef.current = next.input;
                    setCursor(next.input.length); cursorRef.current = next.input.length;
                    host.notify();
                  }
                } else tabRef.current = null;
                return true;
              }
              // ── ↑/↓ — prompt history, but only while the field is empty or still shows
              // the history entry untouched; in a draft they move the caret between its
              // rows (the editor below), so a draft is never replaced. A `!cmd`/`!!cmd`
              // entry (how a shell command is stored, see runShellCommand) is shown the
              // way it was typed: the matching bang level, the field holding `cmd` with
              // its bang(s) stripped.
              if (key.name === 'up' || key.name === 'down') {
                // ↑ on an EMPTY field takes the last queued message back for editing,
                // before history — which it reaches once the queue is empty. The bang
                // level goes to 0: a message is not a command.
                if (key.name === 'up' && inputRef.current === '' && queueRef.current.length) {
                  histAt.current = null;
                  histShown.current = '';
                  setBangLevel(0);
                  setField(queueRef.current.pop() as string);
                  syncQueue();
                  return true;
                }
                const hist = historyRef.current;
                const untouched = inputRef.current === '' || (histAt.current != null && inputRef.current === histShown.current);
                if (untouched) {
                  if (!hist.length) return true;
                  const at = histAt.current;
                  const next = key.name === 'up' ? (at == null ? hist.length - 1 : Math.max(0, at - 1)) : (at == null ? null : at + 1 >= hist.length ? null : at + 1);
                  histAt.current = next;
                  const raw = next == null ? '' : hist[next]!;
                  const { level, cmd: shown } = decodeBangLine(raw);
                  histShown.current = shown;
                  setBangLevel(level);
                  setField(histShown.current);
                  return true;
                }
              }
              // `details` — the master switch: with anything folded it opens
              // everything, pressed again it closes everything, and either way the
              // blocks a click made an exception of go back to following it. A bound
              // action, so `config.keys.details` moves it; it answers to ^o and still
              // to ^r, which every hint written before it named.
              if (isKey(host.keys.details ?? [], key)) { flipAllFolds(); return true; }
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
                key as unknown as Parameters<typeof editorReducer>[1],
                { multiline: true, width: chatFieldWidth(width, fullscreenRef.current) },
              );
              if (act.kind === 'submit') {
                const cmd = inputRef.current.trim();
                disarmEsc();
                if (bangLevel > 0) {
                  // One command per bang, like Claude Code's bash mode — but only once
                  // it actually SUBMITS: while something else is still running,
                  // runShellCommand refuses without touching the field (the same
                  // "refused, not queued" contract `!command` always had), and a
                  // retried Enter must go through that same refusal again, not fall
                  // into a mode-less field where the text queues as a chat message
                  // instead. An empty command still drops the level — it did submit,
                  // runShellCommand's own check just has nothing to run.
                  if (!streamRef.current) setBangLevel(0);
                  // Enter runs the field text exactly as it reads — level 1 as the
                  // plain command, level 2 handed to the terminal — with no
                  // inspecting it for a leading `!`, which would force an interactive
                  // run and eat the bang a literal shell negation needs.
                  void runShellCommand(cmd, bangLevel === 2);
                } else if (cmd.startsWith('/')) {
                  // A command goes into ↑/↓ like any line (unless it says `history:
                  // false`) — before it runs, and again after if it replaced the
                  // history: `/resume 2` loads that session's own, and ↑ there should
                  // still offer the `/resume` that led to it.
                  const kept = keptInHistory(cmd, CHAT_COMMAND_DEFS);
                  if (kept) pushHistory(historyRef.current, cmd);
                  histAt.current = null;
                  histShown.current = '';
                  const before = historyRef.current;
                  runChatCommand(cmd.slice(1));
                  if (kept && historyRef.current !== before) pushHistory(historyRef.current, cmd);
                }
                // A `!command`/`!!command` typed as plain text (not via the bang
                // level — e.g. pasted whole into an empty field, since a paste is
                // never decoded into a level change, or a queued draft restored with
                // its bang(s) still on it) still runs, the legacy way, read with the
                // same decoder history uses. Refused while something runs rather than
                // queued: a command fired later, into a state nobody is looking at,
                // is a surprise.
                else if (cmd.startsWith('!')) {
                  const { level, cmd: decoded } = decodeBangLine(cmd);
                  void runShellCommand(decoded.trim(), level === 2);
                }
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
                host.notify();
              }
              return true;
            },
          });
          // Trigger-open: `F` (Shift+f) opens the chat from any base state (a domain-
          // agnostic host has no task-detail overlay, so a gate checking
          // `overlay === 'detail'` would always be false and the key would never
          // fire). triggerOpenable still guards the
          // command line / an open modal and when the chat is
          // already open; closed is not handled by the base consumer (priority 0).
          addTrigger({ host, action: 'chat', isOpen: () => focused, open: () => openChat() });
          if (!open) {
            // Collapsed at the bottom, the panel keeps one row: the turn's status, or how
            // to bring it back.
            if (layout !== 'panel' || dock?.side !== 'bottom') return null;
            const cap = focusCap || bindingGlyph(host.keys.chatCollapse);
            return renderChatStrip({ width, theme: host.config.theme as never, status: statusRow, keyHint: cap ? `${cap} chat` : '', unread });
          }
          // What the screens show, asked once per draw: the title names it and the meter
          // counts it, as the next request will carry it.
          const screen = screenNow();
          // The field's completion, shown INLINE: the part of the offer not typed yet
          // right after the caret, its label, the other candidates beside it — a
          // `/command`, its argument, or a path in shell mode (`chatComplete`), through
          // the `:` line's own `lineView`. While Tab walks the candidates the field
          // already holds a whole one, and the view takes the list from where the walk
          // started (`tabRef`), not from the field. Only with the caret at the end of a
          // one-line field, where the offer can be drawn.
          const completion = !input.includes('\n') && cursor >= input.length ? lineView(input, tabRef.current, chatComplete) : null;
          return (host.viewRegistry.chat as (p: Record<string, unknown>) => unknown)({
            width, height, theme: host.config.theme, messages, input, streaming, error, toolLabel, phase, verb, cursor, escArmed,
            // An armed Ctrl+C / Ctrl+D / Ctrl+Z (the App's, `^c again to exit`) — drawn
            // where `Esc again to exit` is.
            armedHint: (host.services as { armedHint?: string }).armedHint ?? '',
            // `Esc stops` only while there is something it stops (see `canStop`) — and not
            // while a docked chat has given the keyboard to the plugin: Esc is its then.
            stoppable: canStop() && focused,
            // What is open and what is folded, the cap of the key that changes it, and
            // the two channels a click needs: where the conversation is on the screen,
            // and which row to put at the top once a fold has changed the rows.
            folds,
            detailsKey: firstGlyph(host.keys.details),
            onViewport: (v: Viewport) => { viewportRef.current = v; },
            scrollTo,
            bangLevel,
            // Where `!` / `!!` will run, for the hint row in shell mode — read only
            // there, since `cwd()` checks the directory against the roots on disk.
            shellCwd: bangLevel ? tildePath(shellRef.current.cwd()) : '',
            // How much runs without a y/n — said on the hint line, so the mode is never
            // a hidden state, while an answer is coming as much as between turns.
            autoMode,
            // The numbers the conversation's images carry — their tokens are drawn as
            // attachments — and whether attaching is on (the hint names Ctrl+V then).
            imageNumbers: [...imagesRef.current.keys()],
            imagesOn: imageLimits(host.config.ai).enabled,
            fullscreen,
            // Docked beside the plugin's screen: the frame marks which side has the keys.
            docked: layout === 'panel',
            focused,
            wheel: wheelRef,
            escWord: layout === 'panel' ? 'collapse' : 'close',
            pendingConfirm: pendingAsk,
            pendingQuestion,
            queued,
            // The title names what is on screen — the items' labels.
            subject: contextTitle(screen),
            elapsed: elapsedMs, emptyNotice, toolCount, completion,
            // What the turn has cost so far, as the provider reported it (0 — nothing
            // reported, and nothing is drawn).
            turnTokens,
            // How many lines a block a CLICK opens shows; `^o` opens it in full.
            viewLines: Number((host.config.plugins as Record<string, { runOutputLines?: unknown }> | undefined)?.assistant?.runOutputLines) || VIEW_CAPS.folded,
            // How the steps between tool calls are drawn — each run folded by default.
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
            ...(() => { const r = contextReading(screen); return { contextBadge: contextBadge(r), contextWarn: r.ratio >= CONTEXT_WARN_AT, contextPanel: contextOpen ? r : null, contextCacheLine: contextOpen ? cacheLine(usageRef.current) : '' }; })(),
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