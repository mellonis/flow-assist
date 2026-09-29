// Plugin «assistant»: a chat with the LLM about the current task. A self-sufficient
// modal: owns the messages, input, streaming and scroll. THE HOST does the network
// (host.services.chatLLM) — the plugin never touches it; the endpoint is read from
// host.config.ai through `llmOpts` (provider, baseUrl, model, the token's variable).
//   - what the person's screens show and the refresh after a write are asked of the
//     plugins through two generic hooks (`services.chatContext` / `services.afterWrite`,
//     see AGENTS.md, plugin contract) — the chat names no plugin's data.
//   - the chat's language is `ai.assistantLanguage` (chatLanguage).

import fs from 'node:fs';
import { useSyncExternalStore } from 'react';
import os from 'node:os';
import path from 'node:path';
import { addTrigger } from '../loader/registry.js';
import { bgActiveCount } from '../loader/tools-core.js';
import { autoBadge, autoCommand, autoSaid, nextAutoMode } from '../assistant/auto.js';
import { NOTES_MODES, notesCommand, notesMode, notesSaid, type NotesMode } from '../assistant/step.js';
import { lineTab, lineView, type TabWalk } from '../config/commandline.js';
import { completePath, completeSlash, listDirectory, type ChatCommandDef } from '../config/fieldcomplete.js';
import type { CompleteResult } from '../config/commands.js';
import { redactDeep, redactSecrets } from '../assistant/secrets.js';
import { compactConversation } from '../assistant/agent.js';
import { copyTarget, copyToClipboard } from '../assistant/copy.js';
import { cdChatTarget, realOf, shellAutoRun, shellRoots, startNote, tildePath } from '../assistant/shell.js';
import {
  JOURNAL_DAYS, KEEP_SESSIONS, acquireLock, closeSession, cutTitle, flushOnExit, journalPath, listSessions, loadSession, lockPath,
  makeLockToken, dropEmptyDirs, moveSessionToProject, pickToContinue, projectHome, projectSessions, pruneSessions, removeSession, renameSession, sessionFingerprint,
  sessionRows, sessionTitle, sessionWhen, sessionsDir, sweepJournals, type Session,
} from '../assistant/sessions.js';
import { exportMarkdown, readJournal, rowOf, type JournalEvent } from '../assistant/journal.js';
import { pickerKey, pickerReload, pickerStart, type PickerAction, type PickerState } from '../assistant/session-picker.js';
import type { ChangeView } from '../assistant/diff.js';
import { VIEW_CAPS, fence, type ViewRenderers } from '../assistant/views.js';
import { renderConsole } from '../assistant/console-view.js';
import { editorReducer } from '@flowtty/core';
import { z } from 'zod';
import { appliesOnRestart, modelMaySave, modelMaySet } from '../config/schema.js';
import { anchorRow, askFieldWidth, blockRows, roomForBlock, chatFieldWidth, chatRows, chatWrapWidth, firstFoldRow, liveChatStatus, pagerTitle, pendingChatRows, renderChatStatus, renderChatStrip, rowAnchor, viewGroupFor, type RowOpts, type Viewport } from '../views/modals.js';
import { CHAT_MODES, chatModeOf, inRect, type ChatMode, type PanelLayout } from '../runtime/panel-layout.js';
import { allFolded, flipFolds, isClicked, isOpen, openInFull, pageable, toggleFold, type FoldState } from '../assistant/folds.js';
import { groupOpen, toggleGroup } from '../assistant/view-groups.js';
import { bindingGlyph, firstGlyph, isKey, isMouseButton, isMouseKey, keyGlyph } from '../playback/keys.js';
import { hoverEnabled } from '../config/mouse.js';
import { askKey } from '../assistant/ask.js';
import { memoryCommand, type Shown } from '../assistant/memory-command.js';
import { migrateMemoryJson, removeFact, writeIndex } from '../assistant/memory-store.js';
import { acceptFact, firstStart, firstStartPending } from '../assistant/memory-trust.js';
import { memoryFilePath } from '../runtime/services/memory.js';
import { ensureWorkspace, workspaceFor, workspaceNote, workspaceRoot } from '../assistant/workspace.js';
import { CONTEXT_WARN_AT, cacheLine, contextBadge } from '../assistant/context-meter.js';
import { recallLine } from '../assistant/recall.js';
import { contextTitle, type ContextItem } from '../assistant/screen-context.js';
import {
  IMAGES_OFF, imageLimits, imagesInText, insertToken, loadImageFile, pastedPaths, readClipboardImage, removeTokenAt,
  type ClipboardImage, type LoadedOk,
} from '../assistant/images.js';
import type { Make } from '../loader/plugin.js';
import { decodeBangLine, encodeBangLine, keptInHistory, pushHistory, type HistoryCommand } from '../assistant/prompt-history.js';
import type { Plugin } from '../loader/plugin.js';
import type { PluginApi } from '../runtime/plugin-api.js';
import { isPanelSpec, panelAnswer, panelKey as commandPanelKey, panelKeys, panelRows, panelStart, panelTop, type PanelSpec, type PanelState } from '../assistant/command-panel.js';
import type { Command as PluginCommand } from '../loader/plugin.js';
import type { ChatMsg, ConversationDeps, ConversationEvent, SendOptions, ViewPort } from '../assistant/conversation-types.js';
import { Conversation } from '../assistant/conversation.js';
import { personSpoke, projectHere } from '../assistant/conversation-session.js';
import { configLineOf, shellCommandOf } from '../assistant/confirm-policy.js';

// Slash-commands of the chat — a single source for runChatCommand and Tab-completion.
// `/analyze` is a tracker slash command and is removed.
// `history: false` would keep a command out of the ↑/↓ history, which is saved with the
// session — for a command whose argument may carry a secret
// (src/assistant/prompt-history.ts). None of these takes one: a path, a number, a
// mode word, a session's name.
// `values` is what a command's argument may be, and Tab completes it from them
// (src/config/fieldcomplete.ts). `/resume`'s are the saved sessions, read where the
// sessions directory is known (`chatCommandDefs` in the chat).
type ChatCommand = HistoryCommand & ChatCommandDef;
const CHAT_COMMAND_DEFS: ChatCommand[] = [
  { name: 'compact' }, { name: 'context' }, { name: 'copy' }, { name: 'image' }, { name: 'resume' }, { name: 'sessions' }, { name: 'new' }, { name: 'title' }, { name: 'export' }, { name: 'clear' }, { name: 'memory', values: ['project', 'global', 'forget', 'accept'] }, { name: 'workspace' },
  // `cd`'s own argument is a path, not a fixed set of values — its completion is
  // special-cased in `chatComplete`, the way shell mode's own path completion is.
  { name: 'cd' },
  { name: 'auto', values: ['reads', 'all', 'off'] }, { name: 'notes', values: NOTES_MODES }, { name: 'mode', values: CHAT_MODES }, { name: 'log' }, { name: 'exit' },
];
const CHAT_COMMANDS = CHAT_COMMAND_DEFS.map((c) => c.name);

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

// What ⏎ on the empty field sends after a turn stopped at a turn limit
// (`ai.maxRounds`, `ai.maxTurnTokens`).
export const CONTINUE_WORD = 'continue';
export { STOPPED_TURN, failedTurn, roundCapTurn } from '../assistant/system-prompt.js';
export { allServices } from '../assistant/conversation-turn.js';
export { configLineOf, shellCommandOf } from '../assistant/confirm-policy.js';

// The app-glue dispatched to by the :ask command.
interface AssistantCtx {
  openChat?(text?: string): unknown;
}

// config.plugins.assistant, as the chat reads it.
const assistantConfig = (host: { config?: unknown }) =>
  ((host as { config?: { plugins?: Record<string, Record<string, unknown> | undefined> } }).config?.plugins?.assistant ?? {}) as Record<string, unknown>;

// What a conversation is handed from the chat's host: every member reads the host when
// it is called, since the App rebinds some services on every render.
function chatDeps(host: PluginApi['host'], lockToken: string, current: () => Conversation | null): ConversationDeps {
  const svc = () => host.services as Record<string, any>;
  return {
    config: () => host.config,
    services: () => host.services,
    chatLLM: (m, o) => svc().chatLLM(m, o),
    compact: compactConversation,
    // The App's own array, spliced in place when a plugin joins late or changes its
    // tools: a turn hands it to `agentChat`, which re-reads the registry every round.
    pluginAiTools: () => svc().pluginAiTools ?? [],
    pluginToken: host.pluginToken,
    viewRenderers: () => (svc().viewRenderers as ViewRenderers | undefined) ?? { console: renderConsole },
    screen: () => { try { return (svc().chatContext as (() => ContextItem[]) | undefined)?.() ?? []; } catch { return []; } },
    afterWrite: () => { void (svc().afterWrite as (() => Promise<void>) | undefined)?.(); },
    notify: () => host.notify(),
    showMessage: (text) => svc().showMessage?.(text),
    pushLog: (line) => svc().pushLog?.(line),
    sessionsDir: () => sessionsDir(host.config),
    lockToken,
    // Read when called: a plugin that joins late is seen.
    screens: () => svc().screens as ReturnType<ConversationDeps['screens']>,
    current,
  };
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
    // `sessions` (Ctrl+S) opens the session picker from anywhere — a chord, since the
    // chat's field would type a letter; the terminal's raw mode leaves Ctrl+S to the app,
    // not to flow control.
    // `toEnd` (End) brings the conversation back to its end from wherever it was
    // scrolled to — when End has nothing to do in the field (see the chat's handler).
    keys: { chat: 'F', sessions: 'ctrl+s', details: ['ctrl+o', 'ctrl+r'], toEnd: 'end', chatFocus: 'ctrl+]', chatCollapse: 'ctrl+\\' },
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
    // The model may change where the chat opens and which side the panel docks on — a
    // layout the person undoes with one command. `mode` is read when the chat mounts
    // (`/mode` moves it for the run); `panel.side` on every draw.
    configSchema: z.object({
      mode: z.enum(['panel', 'window', 'full'])
        .register(modelMaySet, { reason: 'where the chat opens — a layout, undone with one command' })
        .register(modelMaySave, { reason: 'where the chat opens — a layout, undone with one command' })
        .register(appliesOnRestart, {})
        .optional(),
      panel: z.object({
        side: z.enum(['right', 'bottom'])
          .register(modelMaySet, { reason: 'which side the chat\'s panel docks on — a layout, undone with one command' })
          .register(modelMaySave, { reason: 'which side the chat\'s panel docks on — a layout, undone with one command' })
          .optional(),
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
          // not hear its own keys then) — ChatMessages fills it. `count` is the run
          // length a flick over one read carries (TtyBackend collapses it into one key).
          const wheelRef = ui.useRef<((up: boolean, count?: number) => void) | null>(null);
          // What brings the conversation's list to its end (`toEnd`), filled by the view.
          const toEndRef = ui.useRef<(() => void) | null>(null);
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
          // One token for this chat instance's whole life (not per process — see
          // sessions.ts, "Ownership lock"): what makes a lock this instance's own.
          // `useRef`'s init runs on every render, so `makeLockToken()` (a UUID) would
          // otherwise be generated and discarded on every one but the first; the ref
          // starts empty and is filled in once, here, on the first render only.
          const lockTokenRef = ui.useRef('');
          if (!lockTokenRef.current) lockTokenRef.current = makeLockToken();
          const lockToken = lockTokenRef.current;
          // The conversation this chat draws. `useRef`'s argument is evaluated on every render,
          // so the object is made once, into an empty ref, as the lock token is.
          const convRef = ui.useRef<Conversation | null>(null);
          // What the chat does when its conversation starts or ends work, parks a y/n or a
          // question, fails, or lands a background result. Bound once, when the conversation is
          // made; each handler reaches this render's functions through the ref.
          const viewFx = ui.useRef<Partial<{ [T in ConversationEvent['type']]: (ev: Extract<ConversationEvent, { type: T }>) => void }>>({});
          const bindView = (c: Conversation) => {
            c.on('turn-start', (ev) => viewFx.current['turn-start']?.(ev));
            c.on('turn-end', (ev) => viewFx.current['turn-end']?.(ev));
            c.on('confirm', (ev) => viewFx.current.confirm?.(ev));
            c.on('question', (ev) => viewFx.current.question?.(ev));
            c.on('notice', (ev) => viewFx.current.notice?.(ev));
            c.on('inbox', (ev) => viewFx.current.inbox?.(ev));
            c.on('activity', (ev) => viewFx.current.activity?.(ev));
          };
          if (!convRef.current) { const c = new Conversation(chatDeps(host, lockToken, () => convRef.current)); bindView(c); convRef.current = c; }
          // This render's conversation. `adopt` moves it to the one that replaces it, so a key
          // this render's handler takes before the next render reaches the new one; what
          // outlives a render (a timer, an effect, a service) reads `convRef` instead.
          let conv = convRef.current;
          // What the chat draws of its conversation: one snapshot, the same object until
          // something drawn changes (`Conversation.getSnapshot`).
          const snap = useSyncExternalStore(conv.subscribe, conv.getSnapshot);
          const messages = snap.messages as ChatMsg[];
          const streaming = snap.busy !== null;
          const { label: toolLabel, phase, verb, toolCount, turnTokens } = snap.activity;
          const { continueOffer, queued, autoMode } = snap;
          const pendingAsk = snap.pendingConfirm;
          const pendingQuestion = snap.pendingQuestion;
          // The empty-answer line names the key that opens the reasoning, as bound when drawn.
          const detailsCap = firstGlyph(host.keys.details);
          const emptyNotice = snap.emptyAnswer ? `The turn ended without a final answer — only reasoning came back${detailsCap ? ` (${detailsCap} shows it)` : ''}. Narrow the question, or say "continue".` : '';
          // What the chat drew: its clicks map rows of this list, and the conversation's saves and
          // notes read it (`Conversation.rows`).
          const drawnRef = ui.useRef<ChatMsg[]>([]);
          drawnRef.current = messages;
          conv.drawnRows = messages;
          // The last `/memory` listing the person saw: what `/memory accept <n>` may accept.
          const memoryShownRef = ui.useRef<Shown[] | null>(null);
          // `/context` opens a panel in the field's place, like a write confirmation — it
          // is a look at the conversation, not a line of it. The ref is for the key
          // handler; the state is for the render.
          const contextOpenRef = ui.useRef(false);
          const [contextOpen, setContextOpenState] = ui.useState(false);
          const setContextOpen = (v: boolean) => { contextOpenRef.current = v; setContextOpenState(v); host.notify(); };
          // `/sessions` and the `sessions` key: the picker, drawn in the conversation's
          // place (src/assistant/session-picker.ts). The ref is for the key handler, the
          // state for the render; null — closed.
          const pickerRef = ui.useRef<PickerState | null>(null);
          const [picker, setPickerState] = ui.useState<PickerState | null>(null);
          // Closed, it gives the conversation back: an answer that came behind it is seen
          // (`markSeen`, through a ref — it is defined further down).
          const markSeenRef = ui.useRef<() => void>(() => {});
          const setPicker = (next: PickerState | null) => { pickerRef.current = next; setPickerState(next); if (!next) markSeenRef.current(); host.notify(); };
          // A plugin command's panel (`ctx.openPanel`, src/assistant/command-panel.ts),
          // drawn in the conversation's place as the picker is; null — none. Its rows are
          // the plugin's and read at every draw, and a tick redraws it every second while
          // it is up, so what it says of time (`retrying in 12 s`) moves.
          const panelRef = ui.useRef<PanelState | null>(null);
          const [panel, setPanelState] = ui.useState<PanelState | null>(null);
          const setPanel = (next: PanelState | null) => { panelRef.current = next; setPanelState(next); if (!next) markSeenRef.current(); host.notify(); };
          const [, setPanelTick] = ui.useState(0);
          ui.useEffect(() => {
            if (!panel) return;
            const t = setInterval(() => { setPanelTick((n: number) => n + 1); host.notify(); }, 1000);
            (t as { unref?: () => void }).unref?.();
            return () => clearInterval(t);
          }, [!!panel]);
          const [input, setInput] = ui.useState('');
          const [error, setError] = ui.useState<string | null>(null);
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
          const [scrollTo, setScrollTo] = ui.useState<{ row: number; n: number; pin?: boolean } | null>(null);
          const scrollSeq = ui.useRef(0);
          // The mouse press a click may still come out of: the cell it landed on and
          // when. A drag clears it — a drag is a selection and never a fold.
          const pressRef = ui.useRef<{ x: number; y: number; at: number } | null>(null);
          // The block open in the pager (its fold id), or null — a block a click opened
          // that is taller than the rows the conversation has for it. The conversation's,
          // like the folds: Esc closes it, and closing the chat, /clear and /resume drop
          // it. `pagerShownRef` says whether the last render drew it: only a pager on
          // screen holds the keys.
          const [pager, setPagerState] = ui.useState<string | null>(null);
          const pagerRef = ui.useRef<string | null>(null);
          const pagerShownRef = ui.useRef(false);
          const setPager = (id: string | null) => { pagerRef.current = id; if (!id) pagerShownRef.current = false; setPagerState(id); if (!id) markSeenRef.current(); };
          // Process indicator: spinner + the seconds of whatever is running NOW.
          // `conv.turnStartedAt` — when the turn started, which is what the finished answer's quiet
          // line says (`· 12.4s`). `conv.segmentStartedAt` — when the thing on the status line started:
          // a tool the moment it was called, the model's round the moment the tool
          // ended. A turn that runs a build sat at `3m 12s`, which says nothing about
          // what is happening; the number a person wants there is how long the RUNNING
          // thing has taken. tickRef ticks elapsedMs off `conv.segmentStartedAt`.
          const [elapsedMs, setElapsedMs] = ui.useState(0);
          const tickRef = ui.useRef<ReturnType<typeof setInterval> | null>(null);
          // Tab-completion cycle: { base, idx, cmd } — by which prefix the matches were
          // built, the last selected command in that list and its text. Repeat Tab cycles;
          // changing the prefix (typed/deleted) restarts.
          // The Tab walk through the field's completion candidates — the `:` line's own
          // (src/config/commandline.ts); over as soon as the field is anything else.
          const tabRef = ui.useRef<TabWalk | null>(null);
          const inputRef = ui.useRef(input); inputRef.current = input;
          // Input field caret — an index (codepoint) in `input`. Kept in a ref so the
          // handler reads a fresh value.
          const [cursor, setCursor] = ui.useState(0);
          const cursorRef = ui.useRef(cursor); cursorRef.current = cursor;
          // Messages sent while an answer was coming. During a turn each reaches the
          // model at the turn's next request boundary — after the current tool results —
          // as the person's message (`beforeRequest` in `send`); one HELD (⇥ on the empty
          // field) waits for the turn's end instead, and one naming an image waits with
          // everything behind it (`queueWait`).
          // What is left when the turn ends goes out in order then (a stopped or failed
          // turn puts it back into the field instead — `restoreQueue`); ↑ on an empty
          // field takes the last one back until it is delivered. `conv.queue` is what the
          // handlers act on (`conv.queueWait` is the rule), the snapshot's `queued` is
          // what the render draws.
          // Prompt history for ↑/↓. `histAt` is the entry on screen (null = the draft),
          // `histShown` is its text — an arrow only replaces the field while it still
          // shows exactly that, so a draft being typed is never lost to a keypress.
          const histAt = ui.useRef<number | null>(null);
          const histShown = ui.useRef<string>('');
          const setField = (t: string) => { setInput(t); inputRef.current = t; setCursor(t.length); host.notify(); };
          // Bang LEVEL — `!` typed into an EMPTY field steps it UP: 0 (normal) → 1
          // (shell mode, `! ` in the shell colour replaces `› `) → 2 (interactive
          // mode, `!!`, the same colour — see src/views/modals.ts). Enter at level 1
          // runs the field text as a plain shell command; at level 2 it hands the
          // terminal over (runShellCommand below). Backspace and Esc on an empty
          // field each step the level back DOWN by one. It is UI state of the field
          // only: never saved with the session (the chat's `ViewPort.draft`, below)
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
            const texts = convRef.current!.restoreQueue();
            if (!texts) return;
            const draft = bangLevelRef.current && inputRef.current ? encodeBangLine(bangLevelRef.current as 1 | 2, inputRef.current) : inputRef.current;
            const text = [...texts, draft].filter((t) => t.trim()).join('\n\n');
            setBangLevel(0);
            histAt.current = null;
            histShown.current = '';
            setField(text);
          };
          // ── The auto mode (src/assistant/auto.ts) — how much of a turn runs without
          // the y/n. This conversation's and nothing else's: it is not in the session
          // file, so a restart opens on `ask`, and `/clear`, `/resume` and a change of
          // task put it back there too. `conv.autoMode` is the one value: the confirmation
          // closure reads it when it runs, and the render draws it from the snapshot.
          // ── The steps (src/assistant/step.ts) — how the text the model writes between
          // tool calls is drawn. `plugins.assistant.notes` is where a conversation
          // starts, `/notes` moves it for this one only, and `/clear` puts it back
          // where the config says. The ref is for the key handler and the command,
          // which are closures made before the state they would read.
          const configNotes = (): NotesMode => notesMode((host.config.plugins as Record<string, { notes?: unknown }> | undefined)?.assistant?.notes);
          const [notes, setNotesState] = ui.useState<NotesMode>(configNotes());
          const notesRef = ui.useRef<NotesMode>(notes);
          const setNotes = (m: NotesMode) => { notesRef.current = m; setNotesState(m); };
          // ── Folds ── the rows a click lands on, and what opening one does to the
          // scroll. The rows are laid out by the view and cached per message object,
          // so asking for them here is a lookup, not a second layout.
          // The display list as the view's own functions read it — the same objects,
          // and so the same cached rows.
          const drawn = () => drawnRef.current as Parameters<typeof chatRows>[0];
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
          // Put a row at the top of the conversation, once the rows have changed —
          // under the pin (`pin: true`) so an opened block's own first row is never
          // the one it covers, or at the literal row otherwise (a fold closing keeps
          // the screen position the eye was already at, pin or no pin).
          const askScroll = (row: number, pin = false) => setScrollTo({ row: Math.max(0, row), n: ++scrollSeq.current, pin });
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
              if (at >= 0) askScroll(at, true);
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
            // While the pager is drawn a click folds nothing in the conversation it
            // stands in for, and a drag is flowtty's selection of the pager's own text.
            if (pagerShownRef.current) { pressRef.current = null; return false; }
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
            // A block taller than the rows the conversation has for it — measured whole,
            // as the pager would show it, and at the conversation's own width, since the
            // question is whether it fits THERE — opens in the pager and stays folded
            // here. Below that it opens inline. Never while a y/n or a question waits:
            // that is answered in the conversation, and a pager would cover it.
            if (opening && pageable(id) && !conv.confirm && !conv.question) {
              const v = viewportRef.current;
              const whole = blockRows(drawn(), { ...rowOpts(openInFull(foldsRef.current, id)), viewLines: VIEW_CAPS.lines }, id).length;
              if (v && whole > roomForBlock(v.height)) { setPager(id); host.notify(); return true; }
            }
            applyFolds(toggleFold(foldsRef.current, id), opening ? id : null);
            return true;
          };

          // ── Sessions (src/assistant/sessions.ts) ───────────────────────────────
          // The conversation is written to disk after every change, so a restart
          // continues it. A session gets its id — and its ownership lock — when it
          // first has something to keep; `/clear` starts a new one and leaves the old
          // for `/resume`.
          const sessDir = sessionsDir(host.config);
          // What `/resume` numbers: the current project's sessions, newest first — the
          // top level's when there is no project. The picker's Tab reaches the others.
          const resumeList = () => (sessDir ? projectSessions(listSessions(sessDir), conv.currentProject()) : []);
          // The chat's commands with `/resume`'s values filled in: the saved sessions,
          // newest first, numbered as `/resume` lists them, each number labelled with
          // its title. Read when the field is drawn, so the list is the one on disk.
          // The plugins' commands marked for the chat (`chat: true`), by the bare name the
          // person types, after the chat's own; a name the chat's own commands have stays
          // the chat's, and the first plugin to claim a name keeps it.
          const pluginChatCommands = (): Array<{ name: string; cmd: PluginCommand }> => {
            const reg = (Array.isArray(host.commandRegistry) ? host.commandRegistry : []) as PluginCommand[];
            const taken = new Set<string>(CHAT_COMMANDS);
            const out: Array<{ name: string; cmd: PluginCommand }> = [];
            for (const c of reg) {
              if (!c || c.chat !== true || typeof c.run !== 'function' || typeof c.name !== 'string') continue;
              const bare = (c.name.includes(':') ? c.name.slice(c.name.lastIndexOf(':') + 1) : c.name).toLowerCase();
              if (!bare || taken.has(bare)) continue;
              taken.add(bare);
              out.push({ name: bare, cmd: c });
            }
            return out;
          };
          const chatCommandDefs: ChatCommandDef[] = [
            ...CHAT_COMMAND_DEFS.map((c) => (c.name === 'resume'
              ? { ...c, values: () => resumeList().slice(0, 15).map((s, i) => ({ value: String(i + 1), label: s.title || '(untitled)' })) }
              : c)),
            ...pluginChatCommands().map(({ name, cmd }) => ({ name, values: cmd.values, complete: cmd.complete })),
          ];
          // What the ↑/↓ history asks of a command: the chat's own, and a plugin's as it
          // declares (`history: false` for one whose argument may be a secret).
          const historyCommands = () => [...CHAT_COMMAND_DEFS, ...pluginChatCommands().map(({ name, cmd }) => ({ name, history: cmd.history }))];
          // What the field completes, from its text alone: in shell mode the word being
          // typed as a path under the shell's directory (nothing outside the roots by
          // real path — `dirAllowed`'s own rule); `/cd`'s own argument the same way, but
          // directories only — a file is never where it goes; otherwise a `/command` and
          // its argument. Drawn and walked through `lineView` / `lineTab`, exactly as the
          // `:` line is.
          const CD_ARG = /^\/cd(?:\s([\s\S]*))?$/i;
          const chatComplete = (text: string): CompleteResult => {
            const pathDeps = { cwd: conv.shell.cwd(), roots: shellRoots(host.config as Record<string, unknown>).map(realOf), list: listDirectory, real: realOf };
            if (bangLevelRef.current) return completePath(text, pathDeps);
            const cd = CD_ARG.exec(text);
            if (cd && cd[1] !== undefined) return completePath(cd[1], { ...pathDeps, dirsOnly: true });
            return completeSlash(text, chatCommandDefs);
          };
          const sessConf = (host.config.sessions ?? {}) as { resume?: unknown; keep?: unknown; journalDays?: unknown };
          const startedRef = ui.useRef(false);
          const unhookExitRef = ui.useRef<(() => void) | null>(null);
          if (!startedRef.current && sessDir) {
            startedRef.current = true;
            // Whatever happens at exit, the last change is written (a pending
            // debounced save would otherwise be lost with the process) and the lock
            // released, in that order — AFTER the final save.
            unhookExitRef.current = flushOnExit(() => { const c = convRef.current!; c.save({ silent: true }); c.releaseLock(); });
            setTimeout(() => {
              try { pruneSessions(sessDir, Number.isInteger(sessConf.keep) ? Number(sessConf.keep) : KEEP_SESSIONS); } catch { /* not fatal */ }
              try { sweepJournals(sessDir, typeof sessConf.journalDays === 'number' ? sessConf.journalDays : JOURNAL_DAYS); } catch { /* not fatal */ }
              if (sessConf.resume === false || drawnRef.current.length) return;
              // The newest session of the project the shell starts in — of all of them
              // when that project has none.
              const c = convRef.current!;
              let here: string | null = null;
              try { here = projectHere(c); } catch { /* no project */ }
              const all = listSessions(sessDir);
              const last = pickToContinue(all, here);
              if (!last) {
                // Nothing here: a new session. Sessions of other projects are one key and
                // Tab away, and the note says so.
                if (!projectSessions(all, here).length && all.length) {
                  const key = firstGlyph(host.keys.sessions ?? []);
                  (host.services as Record<string, any>).showMessage?.(`No session in this project yet — ${key ? `${key}, then ` : '/sessions, then '}${keyGlyph('tab')} for all`);
                  host.notify();
                }
                return;
              }
              // The fingerprint first, stat before the content read just below — see
              // applySession's own comment for why the order matters.
              const fp = sessionFingerprint(last.dir, last.id);
              const s = loadSession(last.dir, last.id);
              if (!s) return;
              const outcome = acquireLock(last.dir, s.id, lockToken);
              if (outcome.status === 'held') {
                c.pushNote(`Session "${s.title || s.id}" is open in another flow-assist process — started a new one. (lock: ${lockPath(last.dir, s.id)})`);
                host.notify();
                return;
              }
              // The chat's first conversation, which has done nothing yet (the list is
              // empty), is the one the session is opened into.
              c.applySession(s, fp, last.dir); applySessionView(s);
              (host.services as Record<string, any>).showMessage?.(`Continued «${s.title || 'the last session'}» — /new starts a new one, /sessions lists them all`);
              host.notify();
            }, 0);
          }
          // Component unmount is the other leaving-the-session trigger (exit, /clear,
          // /resume are handled at their own sites below): a pending coalesce timer must
          // not fire into whatever the chat looks like by then, and a last, silent save
          // and the lock's release.
          ui.useEffect(() => () => {
            const c = convRef.current!;
            unhookExitRef.current?.();
            if (c.liveTimer) clearTimeout(c.liveTimer);
            if (!sessDir) return;
            c.save({ silent: true });
            c.releaseLock();
          }, []);
          // Exit «arming» by Esc: 0 — not armed; else ms when the first Esc was pressed.
          // A second Esc within the window closes the chat; any other key disarms.
          const [escArmAt, setEscArmAt] = ui.useState(0);
          const escTimer = ui.useRef<ReturnType<typeof setTimeout> | null>(null);
          // y/n pause on a writing operation (write-flag tool → agentChat →
          // confirmWrite): while the promise hangs, input pauses and a confirmation
          // block renders. `conv.confirm` holds { name, args, resolve } — read by the
          // input-handler (always current); the snapshot's `pendingConfirm` is what the
          // render draws.
          // `ask_user`: the same kind of pause, but the person picks among options.
          // `conv.question` is what the input handler steps key by key (always current);
          // the snapshot's `pendingQuestion` is what the render draws.
          // What the conversation reads of this chat: made once, attached once.
          const portRef = ui.useRef<ViewPort | null>(null);
          if (!portRef.current) {
            portRef.current = {
              // The chat open, and neither the picker, the pager nor a plugin's panel drawn
              // in its place.
              showsEnd: () => openRef.current && !pickerRef.current && !pagerRef.current && !panelRef.current,
              open: () => openRef.current,
              input: () => inputRef.current,
              // A /command or !command in the field is being run, not drafted (it was
              // "/clear" itself); a non-zero bang-level field has no leading `!`/`!!`
              // left to catch by that regex, so its own flag is checked too — it is
              // not a draft either.
              draft: () => ((bangLevelRef.current || /^\s*[/!]/.test(inputRef.current)) ? '' : inputRef.current),
            };
            conv.attach(portRef.current);
          }
          markSeenRef.current = () => convRef.current!.markSeen();
          // The chat's half of opening a saved session (`Conversation.applySession` does
          // the model's first).
          const applySessionView = (s: Session) => {
            setNotes(configNotes()); // its own answer to how the steps are drawn
            setFolds(allFolded()); // and the exceptions pointed into a conversation that is gone
            setPager(null);
            setPanel(null);
            histAt.current = null;
            setBangLevel(0); // the level is never saved — a restored draft is plain text
            setField(s.draft);
          };
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

          // A file changed while the app was off is asked about as the app starts.
          ui.useEffect(() => { const t = setTimeout(() => { void convRef.current!.askConfigChanges(); }, 0); return () => clearTimeout(t); }, []);

          // What the person's screens show now, as the plugins describe it
          // (src/assistant/screen-context.ts). Read fresh for every request — every
          // round of a turn — and never kept: not in `conv.api`, not in the session.
          const screenNow = (): ContextItem[] => {
            try { return (host.services as { chatContext?: () => ContextItem[] }).chatContext?.() ?? []; } catch { return []; }
          };
          // The start: the directory is the default (or a restored session's, which
          // `applySession` sets). A timer made after the session's own start-up timer,
          // so a continued session is in place first — the start-up only continues one
          // into an empty list.
          ui.useEffect(() => {
            const t = setTimeout(() => {
              // Said once per launch, before the project note that follows from
              // `refreshProject`: only when nothing already set the directory (a
              // continued session's own `shellCwd` decides where it goes instead,
              // ./sessions.ts `applySession`, whose start-up timer runs first) and the
              // app's start directory was outside every configured root, so the first
              // one took over instead. A TOAST (`showMessage`), not `pushNote`: a
              // continued session that starts outside the roots every time it is
              // opened — restarted daily, say — would otherwise gain one more
              // permanent row and journal line per launch, forever; the toast is seen
              // and gone, never part of what a save or the journal keeps.
              if (!convRef.current!.shell.saved()) {
                const note = startNote(host.config as Record<string, unknown>, convRef.current!.shell.start());
                if (note) (host.services as Record<string, any>).showMessage?.(note);
              }
              convRef.current!.refreshProject();
              // The memory an older host kept in one list moves into the global
              // workspace once (src/assistant/memory-store.ts), and the person is told —
              // what was one list for every project is every project's now, and some of
              // it may belong to one project only.
              try {
                // The moved facts are the host's only as part of the first start
                // (src/assistant/memory-trust.ts): a memory.json that turns up after it is
                // a file a command could have written, and its facts wait for the person.
                const firstLook = firstStartPending();
                const { moved } = migrateMemoryJson(memoryFilePath(host.config), workspaceFor(host.config, null, 'global'));
                if (firstLook) firstStart(workspaceRoot(host.config));
                if (moved) {
                  convRef.current!.pushNote(`Moved ${moved} ${moved === 1 ? 'memory' : 'memories'} from ${tildePath(memoryFilePath(host.config))} into the global workspace, as files — ${moved === 1 ? 'it is' : 'they are'} every project's now. /memory lists them; ask the assistant to move one that belongs to a single project into it.${firstLook ? '' : ` ${moved === 1 ? 'It is' : 'They are'} not sent until you accept ${moved === 1 ? 'it' : 'them'}: /memory accept.`}`);
                  host.notify();
                }
              } catch (e) { (host.services as Record<string, any>).pushLog?.(`[memory] moving memory.json failed: ${(e as Error).message}`); }
            }, 0);
            return () => clearTimeout(t);
          }, []);

          // A message: the field's text, or the text a caller brings (the host's ask
          // after a `!!command`, `/log`, a queued message); `Conversation.send` runs the turn.
          const send = (text: string | null = null, opts: SendOptions = {}) => conv.send(text ?? inputRef.current, opts);
          // Tick the indicator every 120ms: spinner frame + tenths of a second of
          // whatever is running now (`conv.segmentStartedAt`), not of the whole turn.
          const startTicker = () => {
            if (tickRef.current) clearInterval(tickRef.current);
            tickRef.current = setInterval(() => setElapsedMs(Date.now() - convRef.current!.segmentStartedAt), 120);
          };
          viewFx.current = {
            'turn-start': (ev) => {
              // The command leaves the field the moment it is submitted, as a sent
              // message does (it is in ↑ already); what the person types while it runs
              // is theirs.
              if (ev.kind === 'command') { setField(''); setError(null); startTicker(); return; }
              // Only a message from the field touches the field's history walk: a follow-up
              // turn for the inbox leaves whatever is being typed, or recalled, as it is.
              if (!ev.fromInbox) { histAt.current = null; histShown.current = ''; }
              // Neither the host's ask nor a follow-up turn for the inbox came from the
              // field: whatever is being typed there (keys pressed right as the program
              // handed the terminal back, a half-written message) stays.
              if (!ev.hostAsk && !ev.fromInbox) { setInput(''); inputRef.current = ''; setCursor(0); }
              setError(null);
              startTicker();
              disarmEsc();
            },
            // A new segment on the status line: its seconds start from 0.
            activity: () => setElapsedMs(0),
            'turn-end': (ev) => {
              if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
              if (ev.end.kind !== 'turn') setElapsedMs(ev.end.ms); // the command's whole time, as its line last said
              // A stopped or failed run's queue comes back into the field.
              if (ev.end.outcome === 'stopped' || ev.end.outcome === 'failed') restoreQueue();
            },
            confirm: (ev) => {
              if (!ev.request) return;
              if (contextOpenRef.current) setContextOpen(false);
              // So does a pager: the y/n is what the person must see and answer.
              if (pagerRef.current) setPager(null);
            },
            // A question is answered in the conversation: a pager over it closes.
            question: (ev) => { if (ev.parked && pagerRef.current) setPager(null); },
            notice: (ev) => setError(ev.text),
            // Landed while the chat is closed: counted unread, and one alert.
            inbox: (ev) => {
              if (ev.shown) return;
              unreadRef.current += ev.items.length;
              setUnread(unreadRef.current);
              publish({ unread: unreadRef.current });
              // Nobody is looking at the chat: say so beyond the footer counter.
              const first = String(ev.items[0]).split('\n')[0]!.slice(0, 120);
              (host.services as { alert?: (title: string, body?: string) => void }).alert?.('flow-assist', ev.items.length > 1 ? `${first} (+${ev.items.length - 1} more)` : first);
            },
          };

          // `!command` / `!!command`: refused while anything runs, and said how to use when empty
          // (the chat's own words); the conversation runs it (src/assistant/conversation-shell.ts).
          const runShellCommand = (cmd: string, interactive = false): void => {
            if (conv.busy) { setError('an answer or a command is still running — wait, or stop it with Esc'); return; }
            if (!cmd) { setError(interactive ? '!! runs an interactive program with the terminal — e.g. !!git add -p' : '! runs a shell command — e.g. !git status'); return; }
            void conv.runShell(cmd, interactive);
          };

          // ── in-chat commands ── `/context` says how full the model's context is,
          // `/compact` replaces the history with a summary (a one-shot non-streaming
          // call), `/clear` starts over. There is no `/refresh-context`: the system
          // prompt is assembled anew for every message, so there was nothing to refresh.

          const compactNow = () => conv.compact();

          // ── Attaching an image ── a dropped or pasted path, `/image`, Ctrl+V. What the
          // person attaches goes into the field as a token, `[Image #N]`, at `base` (the
          // field as it stands, or an empty one for `/image`); a refusal says why, and
          // nothing is attached — never a file shrunk or dropped quietly.
          type ImagesRead = { images: false; error: string } | { images: true; loaded: LoadedOk[]; refusal: string | null };
          const readImages = (paths: string[], base: string): ImagesRead => {
            const lim = imageLimits(host.config.ai);
            const loaded = paths.map((p) => loadImageFile(p, conv.shell.cwd(), lim.maxBytes));
            // A file that is not there, or not an image: these are not images being
            // attached — a paste of them is text, `/image` names the first.
            const other = loaded.find((l) => !l.ok && l.reason !== 'too-big');
            if (other && !other.ok) return { images: false, error: other.error };
            if (!lim.enabled) return { images: true, loaded: [], refusal: IMAGES_OFF };
            const big = loaded.find((l) => !l.ok);
            if (big && !big.ok) return { images: true, loaded: [], refusal: big.error };
            const count = imagesInText(base, conv.images).length + loaded.length;
            if (count > lim.maxPerMessage) return { images: true, loaded: [], refusal: `a message carries at most ${lim.maxPerMessage} image${lim.maxPerMessage === 1 ? '' : 's'} (ai.images.maxPerMessage) — this one would have ${count}` };
            return { images: true, loaded: loaded as LoadedOk[], refusal: null };
          };
          const attach = (loaded: LoadedOk[], base: { value: string; cursor: number }) => {
            let at = base;
            for (const l of loaded) at = insertToken(at.value, at.cursor, conv.attachImage(l));
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

          // Switches this chat to a saved session — `/resume <n>` and the picker's ⏎. The
          // one being left is written first, so it is on the list to come back to; one
          // another flow-assist process holds is refused with a note naming its lock.
          // true — switched.
          // `dir` — the directory its file is in (a list's row says).
          const openSession = (id: string, title: string, dir: string): boolean => {
            const prev = convRef.current!;
            if (!sessDir) return false;
            if (prev.busy) { setError('an answer is still coming — stop it (Esc) before switching sessions'); return false; }
            prev.save();
            // The fingerprint first, stat before the content read just below — see
            // applySession's own comment for why the order matters.
            const fp = sessionFingerprint(dir, id);
            const s = loadSession(dir, id);
            if (!s) { setError('that session file cannot be read'); return false; }
            // Held by another live flow-assist process: refuse and stay put. Own lock
            // already, or free/stale, and this acquires it — side-effect free when held,
            // so nothing to undo on the refusal.
            if (id !== prev.sessionId) {
              const outcome = acquireLock(dir, id, lockToken);
              if (outcome.status === 'held') {
                prev.pushNote(`Session "${title || id}" is open in another flow-assist process. (lock: ${lockPath(dir, id)})`);
                // `/resume <n>` in the field is the command, done; from the picker the
                // field holds the person's draft, which stays.
                if (/^\s*\//.test(inputRef.current)) setField('');
                host.notify();
                return false;
              }
            }
            setError(null);
            if (id !== prev.sessionId) prev.releaseLock(); // leaving the old one
            // The session opens into a conversation of its own; the one left is parked.
            prev.close('park');
            const next = new Conversation(chatDeps(host, lockToken, () => convRef.current), { turn: prev.turn, verb: prev.verb, drawnRows: prev.drawnRows, memoryMissingSaid: prev.memoryMissingSaid });
            adopt(next);
            next.applySession(s, fp, dir); applySessionView(s);
            (host.services as Record<string, any>).showMessage?.(`Resumed «${s.title || 'session'}»`);
            host.notify();
            return true;
          };
          // The picker: the list is read here and after a rename or a delete — never per
          // keystroke; the filter runs over what was read. The conversation in this chat
          // is written first, so it is listed as it is now. A pending y/n or question is
          // answered before anything else: the chat opens on it, and the key is pressed
          // again once it is answered.
          const openPicker = () => {
            // Closed, collapsed, or docked with the plugin at the keys: the chat opens and
            // takes the keyboard, or the picker would draw where no key reaches it.
            if (!focusedRef.current) openChat();
            if (!sessDir) { setError('sessions are not saved here (no sessions directory)'); return; }
            if (conv.confirm || conv.question) return;
            conv.save();
            // An error left from before would stand in the picker's notice line and hide
            // every notice it gives.
            setError(null);
            // The picker takes the conversation's place, where a pager left open while
            // the plugin had the keys stands: the pager goes, and so does a panel.
            setPager(null);
            setPanel(null);
            setPicker(pickerStart(sessionRows(sessDir, lockToken), conv.currentProject()));
          };
          // What a picker key asked for (session-picker.ts' `PickerAction`).
          const pickerAction = (a: PickerAction) => {
            const p = pickerRef.current;
            if (!sessDir || !p) return;
            const titleOf = (id: string) => p.rows.find((r) => r.id === id)?.title || id;
            const dirOf = (id: string) => p.rows.find((r) => r.id === id)?.dir ?? sessDir;
            switch (a.kind) {
              case 'close': setPicker(null); return;
              case 'new': if (startNew()) setPicker(null); return;
              case 'open': {
                if (openSession(a.id, titleOf(a.id), dirOf(a.id))) { setPicker(null); return; }
                // Refused — an answer still coming (the error line says so), or taken by
                // another process since the list was read: the picker stays, re-read.
                const rows = sessionRows(sessDir, lockToken);
                const now = rows.find((r) => r.id === a.id);
                setPicker(pickerReload(p, rows, now?.lock === 'held' ? `"${titleOf(a.id)}" is open in another flow-assist process — it cannot be opened here` : ''));
                return;
              }
              case 'rename': {
                const title = cutTitle(a.title);
                let outcome = 'renamed';
                if (a.id === conv.sessionId) { conv.title = title; conv.save(); }
                else outcome = renameSession(dirOf(a.id), a.id, title, lockToken);
                const notice = outcome === 'held' ? `"${titleOf(a.id)}" is open in another flow-assist process — it cannot be renamed here`
                  : outcome === 'missing' ? `"${titleOf(a.id)}" is gone — its file was removed`
                  : `Renamed to «${title}»`;
                setPicker(pickerReload(p, sessionRows(sessDir, lockToken), notice));
                return;
              }
              case 'delete': {
                const done = removeSession(dirOf(a.id), a.id, lockToken);
                if (done === 'deleted') dropEmptyDirs(dirOf(a.id), sessDir); // a project's last one
                const notice = done === 'deleted' ? `Deleted «${titleOf(a.id)}»`
                  : done === 'held' ? `"${titleOf(a.id)}" is open in another flow-assist process — it cannot be deleted`
                  : `"${titleOf(a.id)}" is the session in this chat — it cannot be deleted from here`;
                setPicker(pickerReload(p, sessionRows(sessDir, lockToken), notice));
                return;
              }
              case 'move': {
                // The picker itself already refused a held row, this chat's own, and one
                // already here (session-picker.ts, purely, off the row it read); this
                // re-checks all three with the lock, since that row can be stale by the
                // time the key lands, and does the actual move (sessions.ts).
                const from = dirOf(a.id);
                const dest = conv.currentProject();
                const outcome = moveSessionToProject(from, a.id, sessDir, dest, lockToken);
                if (outcome === 'moved') {
                  dropEmptyDirs(from, sessDir); // the project's last session there, its mirror dir too
                  // A background task, or a fork, still writing to this id by its OLD home
                  // would otherwise miss it (AGENTS.md, "sessions per project" — `conv.homes`).
                  if (conv.homes.has(a.id)) conv.homes.set(a.id, projectHome(sessDir, dest));
                }
                const notice = outcome === 'moved' ? `Moved «${titleOf(a.id)}» to ${dest ? tildePath(dest) : 'no project'}`
                  : outcome === 'held' ? `"${titleOf(a.id)}" is open in another flow-assist process — it cannot be moved`
                  : outcome === 'ours' ? `"${titleOf(a.id)}" is the session in this chat — switch away first`
                  : outcome === 'here' ? `"${titleOf(a.id)}" is already in this project`
                  : outcome === 'missing' ? `"${titleOf(a.id)}" is gone — its file was removed`
                  : `"${titleOf(a.id)}" could not be moved — a session already exists there`;
                setPicker(pickerReload(p, sessionRows(sessDir, lockToken), notice));
                return;
              }
            }
          };
          // Leaves the conversation on screen for a new one: the chat's listeners and port move to
          // it, and it is what the chat draws from the next render on (and what this render's
          // handler reaches at once).
          const adopt = (next: Conversation) => {
            const port = portRef.current!;
            convRef.current?.detach(port);
            bindView(next);
            convRef.current = next;
            conv = next;
            next.attach(port);
          };
          // A fresh conversation in this chat — `/clear` and `/new` both. The one left is closed
          // (what it ran is stopped; a late callback journals where it happened and draws nothing);
          // the person's ↑/↓ history, the turn counter, the last verb and the list as last drawn
          // carry over — they are the chat's field's and status line's, and what the chat showed.
          const renew = (prev: Conversation, reason: 'clear' | 'new') => {
            prev.close(reason);
            const next = new Conversation(chatDeps(host, lockToken, () => convRef.current), { prompts: prev.prompts, turn: prev.turn, verb: prev.verb, drawnRows: prev.drawnRows, memoryMissingSaid: prev.memoryMissingSaid });
            adopt(next);
            next.startFresh();
            // A plugin's news held for the stopped turn's end lands now, under the fresh rows.
            const held = prev.laterNotes; prev.laterNotes = [];
            for (const n of held) next.pluginNote(n);
            resetView();
          };
          // The chat's half of a fresh conversation: the field, its bang level, the notes mode, the
          // folds, the pager, the error line, the clock.
          const resetView = () => {
            if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
            setInput(''); inputRef.current = '';
            setCursor(0);
            setBangLevel(0); // a fresh conversation opens on a plain prompt
            setNotes(configNotes()); // the steps go back to what the config asks for
            setError(null);
            setElapsedMs(0);
            setFolds(allFolded()); // everything folded again, and no exceptions left over
            setPager(null);
            setPanel(null);
            disarmEsc();
            host.notify();
          };
          // `/new`: a fresh session, the one being left written and kept as it is — not
          // closed (what `/clear` does), so a restart with nothing said since continues
          // it. Refused while an answer or a `!command` runs, as a switch is.
          const startNew = (): boolean => {
            const prev = convRef.current!;
            if (prev.busy) { setError('an answer is still coming — stop it (Esc) before starting a new session'); return false; }
            prev.save();
            prev.releaseLock();
            renew(prev, 'new');
            (host.services as Record<string, any>).showMessage?.('New session — /sessions lists the others');
            return true;
          };

          // A plugin's panel takes the conversation's place, as the picker does: the chat
          // opens and takes the keyboard for it, and a pending y/n or question is answered
          // first.
          const openPanel = (spec: PanelSpec) => {
            if (!isPanelSpec(spec)) return;
            if (!focusedRef.current) openChat();
            if (conv.confirm || conv.question) return;
            setError(null);
            setPager(null);
            setPicker(null);
            setPanel(panelStart(spec));
          };
          // A panel key's answer: a line for its notice, or a panel over it — laid on the
          // panel it ran in, and dropped when that one has gone meanwhile (an answer that
          // came after Esc).
          const panelStep = (step: ReturnType<typeof commandPanelKey>) => {
            setPanel(step.state);
            if (!step.run || !step.state) return;
            const at = panelTop(step.state);
            const apply = (answer: unknown) => {
              const cur = panelRef.current;
              if (!cur || panelTop(cur) !== at) return;
              setPanel(panelAnswer(cur, answer));
            };
            const fail = (e: unknown) => apply(`⚠ ${(e as Error)?.message ?? String(e)}`);
            try {
              const r = step.run.def.run(step.run.id);
              if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(apply, fail);
              else apply(r);
            } catch (e) { fail(e); }
          };
          // A plugin's command run from the chat: what it says is a note (display only,
          // never sent), a failure the chat's error line, and it may open a panel.
          const runPluginCommand = (name: string, cmd: PluginCommand, arg: string) => {
            setField('');
            const fail = (e: unknown) => { setError(redactSecrets(`/${name}: ${(e as Error)?.message ?? String(e)}`)); host.notify(); };
            const ctx = {
              surface: 'chat',
              // The command's plugin speaks: its name in front, held while a turn runs.
              say: (text: string) => conv.pluginNote(`[${cmd.name.includes(':') ? cmd.name.slice(0, cmd.name.indexOf(':')) : name}] ${String(text ?? '')}`),
              showMessage: (text: string) => (host.services as Record<string, any>).showMessage?.(text),
              error: (text: string) => { setError(redactSecrets(String(text ?? ''))); host.notify(); },
              openPanel,
              config: host.config,
            };
            try {
              const r = cmd.run?.(ctx, arg) as unknown;
              if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).catch(fail);
            } catch (e) { fail(e); }
            host.notify();
          };
          const runChatCommand = (cmd: string) => {
            const [name, ...rest] = cmd.split(/\s+/);
            const arg = rest.join(' ');
            switch (name) {
              case 'auto': {
                // How much runs without a y/n, for this conversation. `reads`, `all` or
                // `off`; the bare command takes the next rung, as the key does.
                const want = autoCommand(arg);
                if (!want) { setError('/auto takes reads, all or off — or nothing to step to the next one'); return; }
                const next = want === 'cycle' ? nextAutoMode(conv.autoMode) : want;
                conv.setAutoMode(next);
                setField('');
                (host.services as Record<string, any>).showMessage?.(autoSaid(next, shellAutoRun(host.config as { shell?: unknown })));
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
                  conv.pushNote(`the chat is in ${modeRef.current} mode${small} · /mode ${CHAT_MODES.join('|')}`);
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
              case 'cd': {
                // The person's own move — like `!cd`, not the model's `cd` tool: free to
                // go anywhere with no roots configured, held to them by the real path
                // otherwise. It goes through the SAME `setCwd` as `!cd`, run_command's own
                // `cd` and the `cd` tool, so the project's instructions are read again
                // (`conv.onShellSet` → `refreshProject`) and the hint row shows it at once.
                const asked = arg.trim();
                setField('');
                const config = host.config as Record<string, unknown>;
                if (!asked) {
                  // Bare `/cd`: back to the start directory (or the first root) — the
                  // same default `/clear` and `/new` reset to.
                  conv.shell.setCwd(null);
                  conv.pushNote(`now in ${conv.shell.cwd()}`);
                  host.notify();
                  return;
                }
                const target = asked === '-' ? conv.shell.previous() : asked;
                if (asked === '-' && !target) { setError('/cd -: nowhere to go back to yet'); return; }
                try {
                  // `target` is already absolute for `-`; `cdChatTarget`'s `path.resolve`
                  // leaves an absolute path as it is, so this still re-checks it against
                  // the roots (they may have changed since it was left).
                  const dir = cdChatTarget(config, target!, conv.shell.cwd());
                  conv.shell.setCwd(dir);
                  conv.pushNote(`now in ${dir}`);
                  host.notify();
                } catch (e) {
                  setError(`/cd: ${(e as Error).message}`);
                }
                return;
              }
              case 'workspace': {
                // The person's own look into the project's workspace — a note, never a
                // message: what the model wrote there is not the person's to send back.
                const ws = workspaceFor(host.config, conv.currentProject(), 'project');
                ensureWorkspace(ws);
                conv.pushNote(workspaceNote(arg, ws, fence));
                setField('');
                host.notify();
                return;
              }
              case 'memory': {
                // The person's own view of the model's memory; nothing here reaches the
                // model. A `note` is a display-only message: `conv.api` — the model's
                // history — is not touched.
                // An accept is checked against the last listing the person saw (`shown`).
                const res = memoryCommand(arg, conv.memoryLists(), memoryShownRef.current);
                if (res.shown) memoryShownRef.current = res.shown;
                // Said as it happened: a fact whose file could not be removed is named.
                const failed = (res.forget ?? []).filter((f) => !removeFact(workspaceFor(host.config, conv.currentProject(), f.scope), f.id));
                if (res.forget?.length) memoryShownRef.current = null;
                // An accept records the hash of the text the listing showed, which the
                // command checked is still the file's; MEMORY.md then lists it.
                for (const a of res.accept ?? []) {
                  const ws = workspaceFor(host.config, conv.currentProject(), a.scope);
                  if (acceptFact(ws, a.id, a.hash)) writeIndex(ws);
                }
                conv.pushNote(failed.length ? `${res.note}\nNot removed (the file could not be deleted): ${failed.map((f) => `memory/${f.id}.md`).join(', ')}.` : res.note);
                setField('');
                host.notify();
                return;
              }
              case 'export': {
                // `/export [path]`: this session as a markdown document, rendered from its
                // journal (src/assistant/journal.ts, `exportMarkdown`) — or, for a session
                // that has none, from what its state holds, saying the beginning may be
                // missing. The path is the shell's directory's (`~` the home), a file named
                // after the session when none is given. The person typed it, so there is no
                // y/n — that pause is for what the MODEL writes; what is there already is
                // never overwritten, and the file is the person's alone, as the session is.
                setField('');
                const msgs = (drawnRef.current as Record<string, unknown>[]).filter((m) => m.role !== 'system');
                if (!msgs.some((m) => personSpoke(String(m.role)))) { setError('/export: nothing to export yet — nothing has been said in this session'); return; }
                const id = conv.sessionId;
                const title = conv.title || sessionTitle(msgs);
                let events: JournalEvent[] | null = null;
                const home = id ? (conv.homes.get(id) ?? null) : null;
                try { events = home ? readJournal(journalPath(home, id)) : null; } catch { /* not an id — no journal */ }
                const md = events
                  ? exportMarkdown(events, { title, id })
                  : exportMarkdown(msgs.map((m) => rowOf(m, viewRenderers)).filter((e): e is JournalEvent => e !== null), { title, id: id || 'unsaved', noJournal: true });
                const target = path.resolve(conv.shell.cwd(), arg.trim() ? arg.trim().replace(/^~(?=\/|$)/, os.homedir()) : `session-${id || 'unsaved'}.md`);
                try {
                  fs.writeFileSync(target, md, { mode: 0o600, flag: 'wx' });
                } catch (e) {
                  setError((e as NodeJS.ErrnoException).code === 'EEXIST' ? `/export: already exists, not overwritten — ${tildePath(target)}` : `/export: ${(e as Error).message}`);
                  return;
                }
                conv.pushNote(`Exported this session to ${tildePath(target)}`);
                host.notify();
                return;
              }
              case 'title': {
                // `/title <text>` names this session — kept in its file, so a restart keeps
                // it; `/title` alone says what it is called, as a note (display only, like
                // `/mode`'s): a toast is drawn under a chat that covers the whole terminal.
                // Nothing is sent.
                const text = cutTitle(arg);
                setField('');
                if (!text) {
                  const now = conv.title || sessionTitle(drawnRef.current as Record<string, unknown>[]);
                  const said = now ? `This session is «${now}» — /title <text> renames it` : 'This session has no title yet — /title <text> gives it one';
                  conv.pushNote(said);
                  host.notify();
                  return;
                }
                conv.title = text;
                conv.save(); // nothing said yet — kept here and written with the first save
                (host.services as Record<string, any>).showMessage?.(`Renamed to «${text}»`);
                host.notify();
                return;
              }
              case 'resume': {
                // The saved sessions; with a number — go back to that one. The session
                // being left is written first, so it is on the list to come back to.
                if (!sessDir) { setError('sessions are not saved here (no sessions directory)'); return; }
                conv.save();
                const list = resumeList();
                const n = Number(arg.trim());
                if (!arg.trim()) {
                  const lines = list.slice(0, 15).map((s, i) => `${i + 1}. ${s.title || '(untitled)'} — ${sessionWhen(s.updatedAt)}, ${s.turns} message${s.turns === 1 ? '' : 's'}${s.id === conv.sessionId ? ' · this one' : ''}`);
                  conv.pushNote(lines.length ? `Sessions (newest first) — /resume <number> opens one:\n${lines.join('\n')}` : `No saved sessions in this project yet — ${firstGlyph(host.keys.sessions ?? []) || '/sessions'}, then ${keyGlyph('tab')} for all`);
                  setField('');
                  host.notify();
                  return;
                }
                const pick = Number.isInteger(n) && n >= 1 ? list[n - 1] : undefined;
                if (!pick) { setError(`/resume takes a number from the list (1–${list.length})`); return; }
                openSession(pick.id, pick.title, pick.dir);
                return;
              }
              case 'sessions':
                setField('');
                openPicker();
                return;
              case 'clear': {
                // The session is written and left for /resume — closed, so a restart does
                // not bring back what was just cleared; what follows is a new one.
                const prev = convRef.current!;
                prev.save();
                if (sessDir && prev.sessionId) { try { closeSession(prev.homes.get(prev.sessionId) ?? sessDir, prev.sessionId); } catch { /* not fatal */ } }
                prev.releaseLock();
                renew(prev, 'clear');
                return;
              }
              case 'new':
                startNew();
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
              default: {
                const plugin = pluginChatCommands().find((p) => p.name === String(name ?? '').toLowerCase());
                if (plugin) { runPluginCommand(plugin.name, plugin.cmd, arg); return; }
                setError(`unknown command /${name} — available: ${[...CHAT_COMMANDS, ...pluginChatCommands().map((p) => p.name)].map(c => `/${c}`).join(', ')}`);
                return;
              }
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
            setPager(null);
            setPicker(null); // its rows were read for this visit; the key reads them anew
            setPanel(null);
            conv.save(); // the draft too
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
            conv.markSeen(); // the session's end is on screen now
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
            if (key.name === 'c' && conv.canStop()) { conv.stop(keyGlyph({ name: 'c', ctrl: true })); return 'handled'; }
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
            const c = conv.confirm;
            return pendingChatRows({
              width: w,
              question: conv.question?.state ?? null,
              confirm: c ? { name: c.name, args: c.args, command: shellCommandOf(c.name, c.args) ?? undefined, line: configLineOf(c.name, c.args) ?? undefined, ...(c.input ? { input: c.input } : {}) } : null,
              todo: conv.plan.snapshot(),
              queued: conv.queue.length,
            });
          };
          // The block in the pager. Drawn while the block resolves (a list replaced under
          // it shows nothing, and holds no key); a docked chat that gives the keys to the
          // plugin keeps it on screen, as it keeps the picker, and gets it back live. It is
          // drawn in the conversation's place inside the chat's own frame, laid out at the
          // conversation's width — the width it was measured against.
          const pagerRows = pager && !picker && open
            ? blockRows(messages as Parameters<typeof blockRows>[0], { ...rowOpts(openInFull(folds, pager)), viewLines: VIEW_CAPS.lines }, pager)
            : [];
          const pagerShown = !!pager && pagerRows.length > 0;
          pagerShownRef.current = pagerShown;
          (host.store as Record<string, any>).chat = { open, unread, mode, focus, openChat, closeChat, send, messages, streaming, toolLabel, cursor, escArmed, pendingConfirm: pendingAsk, ctrlKey, panelKey, pointer, note: (text: string) => convRef.current!.pluginNote(text), statusRow: statusRow ? liveChatStatus(() => statusRef.current as never, collapsedBusy) : null, footerStatus, layout, needRows,
            // What holds back a screen a plugin or the model opens (src/runtime/screens.ts),
            // read from the refs at the moment it is asked.
            // The draft counts while the chat has the keys: folded away, or with the keys on
            // the plugin's side, nobody is typing into it.
            busy: () => convRef.current!.busy, typing: () => focusedRef.current && inputRef.current.trim() !== '', asking: () => !!convRef.current!.confirm || !!convRef.current!.question };
          // A host-reachable channel to put a message into the chat from OUTSIDE (a
          // `background` task's result, `Conversation.deliver`). Registered per render
          // (idempotent), so a detached timer holding an older copy still reaches the
          // conversation this chat draws.
          (host.services as Record<string, any>).postToChat = (text: string) => convRef.current!.deliver(text);
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
              // The picker stands in the conversation's place: a button or the wheel must
              // not reach the list it hides. A pending y/n or question is drawn with the
              // conversation instead (the render's own condition), and a click reaches it.
              const pickerDrawn = (!!pickerRef.current || !!panelRef.current) && !conv.confirm && !conv.question;
              if (pickerDrawn && isMouseKey(key.name)) return false;
              if (pickerDrawn && (key.name === 'wheelup' || key.name === 'wheeldown')) return true;
              // A press, a drag or a release. It is consumed only when it actually
              // folded something: a drag that reported "handled" per dragged cell
              // would cost a re-render a cell, and every other click must be free.
              // A click in the panel folds whichever side has the keyboard. A move or
              // the pointer leaving is flowtty's hover, already drawn: nothing here, and
              // a press waiting for its release keeps waiting.
              if (isMouseKey(key.name)) return isMouseButton(key.name) && mouse(key);
              // The pager is a reader: Esc brings the conversation back, and every other
              // key stops here — nothing reaches the field, the folds or the model.
              // PgUp/PgDn and the wheel are its own list's, which hears them first.
              if (focused && pagerShownRef.current) {
                if (key.name === 'escape') { setPager(null); host.notify(); }
                return true;
              }
              if (!focused) {
                // The conversation's own list does not hear the wheel while the plugin
                // has the keys; over the list it still scrolls it. Over the pager (drawn
                // in the list's place) the wheel scrolls nothing — the conversation it
                // hides stays where it was left — and reaches no one else either.
                const v = viewportRef.current;
                if ((key.name === 'wheelup' || key.name === 'wheeldown') && v && typeof key.x === 'number' && typeof key.y === 'number'
                  && key.x >= v.left && key.x < v.left + v.width && key.y >= v.top && key.y < v.top + v.height) {
                  if (!pagerShownRef.current) wheelRef.current?.(key.name === 'wheelup', key.count ?? 1);
                  return true;
                }
                return false;
              }
              // While awaiting a write confirmation (y/n pause), the chat consumes ALL
              // keys: 'y'/⏎ — confirm, 'n'/Esc — decline; normal field input is paused.
              // An open question consumes every key too: arrows/digits/Space/⏎ answer it,
              // Esc dismisses it, and in the free-text field every printable key is text.
              if (conv.question) {
                // The same width the block draws its field in, so the caret moves the
                // way it is shown to move.
                const next = askKey(conv.question.state, key, askFieldWidth(chatWrapWidth(width, fullscreenRef.current)));
                if (next.done) conv.answerQuestion(next);
                else conv.setQuestion(next);
                return true;
              }
              // The context panel holds the keys while it is up; Esc or ⏎ put it away.
              if (contextOpenRef.current) {
                if (key.name === 'escape' || key.name === 'return') setContextOpen(false);
                return true;
              }
              if (conv.confirm) {
                if (key.name === 'escape' || key.name === 'n') { conv.answerConfirm(false); return true; }
                if (key.name === 'y' || key.name === 'return') { conv.answerConfirm(true); return true; }
                return true;
              }
              // A plugin's panel holds the keys while it is up, as the picker does: ↑/↓, Esc
              // and the plugin's own keys, nothing else — after a pending question or y/n.
              if (panelRef.current) {
                setError(null);
                panelStep(commandPanelKey(panelRef.current, key));
                return true;
              }
              // The picker holds the keys while it is up — after a pending question or
              // y/n, which are drawn over it and answered first.
              if (pickerRef.current) {
                setError(null); // a new key makes the last error stale; the action may set another
                const step = pickerKey(pickerRef.current, key, chatWrapWidth(width, fullscreenRef.current));
                setPicker(step.state);
                if (step.action) pickerAction(step.action);
                return true;
              }
              if (isKey(host.keys.sessions ?? [], key)) { openPicker(); return true; }
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
                const cut = removeTokenAt(inputRef.current, cursorRef.current, key.name === 'backspace' ? 'back' : 'forward', (n) => conv.images.has(n));
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
                if (conv.stop('')) { disarmEsc(); return true; }
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
                const next = nextAutoMode(conv.autoMode);
                conv.setAutoMode(next);
                (host.services as Record<string, any>).showMessage?.(autoSaid(next, shellAutoRun(host.config as { shell?: unknown })));
                host.notify();
                return true;
              }
              // ── Tab on the EMPTY field with a message queued in a turn: the last one is
              // held for the turn's end, or let go at the next step again.
              if (key.name === 'tab' && !key.shift && !key.meta && !key.ctrl && inputRef.current === '' && conv.inTurn && conv.queue.length) {
                conv.toggleHoldLast();
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
              // entry (how a shell command is stored, see `runShell`, src/assistant/
              // conversation-shell.ts) is shown the way it was typed: the matching bang
              // level, the field holding `cmd` with its bang(s) stripped.
              if (key.name === 'up' || key.name === 'down') {
                // ↑ on an EMPTY field takes the last queued message back for editing,
                // before history — which it reaches once the queue is empty. The bang
                // level goes to 0: a message is not a command.
                if (key.name === 'up' && inputRef.current === '' && conv.queue.length) {
                  histAt.current = null;
                  histShown.current = '';
                  setBangLevel(0);
                  setField(conv.takeBackLast()!);
                  return true;
                }
                const hist = conv.prompts;
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
              // `toEnd` — back to the conversation's end, what the `↓` control over it
              // does on a click. End is the field's own key too (the end of the line), so
              // the field keeps it while there is text after the caret — a later line of
              // a draft included: only an End on an empty field, or with the caret at the
              // very end of the draft, jumps, and only while the list is away from the end.
              if (isKey(host.keys.toEnd ?? [], key) && viewportRef.current && !viewportRef.current.atEnd
                && cursorRef.current >= inputRef.current.length) { toEndRef.current?.(); return true; }
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
                  if (!conv.busy) setBangLevel(0);
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
                  const kept = keptInHistory(cmd, historyCommands());
                  if (kept) pushHistory(conv.prompts, cmd);
                  histAt.current = null;
                  histShown.current = '';
                  const before = conv.prompts;
                  runChatCommand(cmd.slice(1));
                  if (kept && conv.prompts !== before) pushHistory(conv.prompts, cmd);
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
                else if (conv.busy) {
                  // An answer is coming: queue instead of dropping the keypress.
                  if (cmd) { conv.enqueue(cmd); setField(''); }
                } else if (!cmd && conv.continueOffer) void send(CONTINUE_WORD);
                else send();
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
          // The `sessions` key wherever the chat does not have the keyboard (the start
          // screen, a plugin's screen). A chord: `addTrigger` compares the bare name, so
          // the whole key is compared here.
          host.useInputHandler({
            mode: 'consume',
            priority: (u) => (u.cmdOpen || u.modalActive || focused ? 0 : 10),
            handler: (key) => {
              if (focused || !isKey(host.keys.sessions ?? [], key)) return false;
              openPicker();
              return true;
            },
          });
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
            // `Esc stops` only while there is something it stops (see `Conversation.canStop`) — and not
            // while a docked chat has given the keyboard to the plugin: Esc is its then.
            stoppable: conv.canStop() && focused,
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
            shellCwd: bangLevel ? tildePath(conv.shell.cwd()) : '',
            // How much runs without a y/n — said on the hint line, so the mode is never
            // a hidden state, while an answer is coming as much as between turns.
            // `autoRun` (the person's `shell.autoRun`, read per draw) changes what `all`
            // is called: commands run unasked too.
            autoMode,
            autoRun: shellAutoRun(host.config as { shell?: unknown }),
            // The numbers the conversation's images carry — their tokens are drawn as
            // attachments — and whether attaching is on (the hint names Ctrl+V then).
            imageNumbers: [...conv.images.keys()],
            imagesOn: imageLimits(host.config.ai).enabled,
            fullscreen,
            pager: pagerShown && pager ? { rows: pagerRows, title: pagerTitle(pagerRows, pager) } : null,
            // Docked beside the plugin's screen: the frame marks which side has the keys.
            docked: layout === 'panel',
            focused,
            wheel: wheelRef,
            toEnd: toEndRef,
            escWord: layout === 'panel' ? 'collapse' : 'close',
            pendingConfirm: pendingAsk,
            pendingQuestion,
            picker,
            // A plugin command's panel: its rows as the plugin gives them now, its keys
            // with their caps.
            panel: panel ? (() => {
              const { rows, error: rowsError } = panelRows(panel);
              const top = panelTop(panel);
              // Everything the plugin put in it is redacted before it is drawn.
              return redactDeep({
                title: top.title, rows: rows.map((r) => ({ ...r })), cursor: Math.min(panel.cursor, Math.max(0, rows.length - 1)),
                notice: rowsError ? `⚠ ${rowsError}` : panel.notice, empty: top.empty ?? '',
                keys: panelKeys(panel).map((k) => ({ cap: keyGlyph(k.key), label: k.label })), nested: panel.stack.length > 1,
              });
            })() : null,
            // What a click acts on is underlined under the pointer when the backend
            // reports hover (`ui.mouse` and `ui.hover`, read at start like the backend).
            hover: hoverEnabled(host.config as Record<string, unknown>),
            // A click on a row of the picker or a panel puts the cursor there, as ↑/↓
            // would; ⏎ still opens.
            onPickRow: (index: number) => {
              const p = pickerRef.current;
              if (p) { if (p.mode === 'list' && index !== p.cursor) setPicker({ ...p, cursor: index, notice: '' }); return; }
              const q = panelRef.current;
              if (q && index !== q.cursor) setPanel({ ...q, cursor: index });
            },
            // What this chat is doing, for its own row: a y/n or a question waits, or a
            // turn or a `!command` runs.
            pickerOwn: pendingAsk || pendingQuestion ? 'waiting' : streaming ? 'working' : 'idle',
            queued: queued.map((m) => m.text),
            // What the last queued message waits for: the turn's next step, or its end
            // (held, ⇥) — none outside a turn, where it goes when the command ends.
            // By the delivery's own rule (`queueWait`).
            queueWaits: queued.length && conv.inTurn ? conv.queueWait(queued, queued.length - 1) : null,
            // The title names what is on screen — the items' labels.
            subject: contextTitle(screen),
            elapsed: elapsedMs, emptyNotice, toolCount, completion, continueOffer,
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
            ...(() => {
              const r = conv.contextReading(screen);
              // How many of the history's items go as stubs now — after /compact the
              // set still names ids, but the history holds none of them.
              const stubbedNow = () => conv.recallItems().filter((i) => conv.recall.stubbed.has(i.id)).length;
              return { contextBadge: contextBadge(r), contextWarn: r.ratio >= CONTEXT_WARN_AT, contextPanel: contextOpen ? r : null, contextCacheLine: contextOpen ? cacheLine(conv.usage) : '', contextRecallLine: contextOpen ? recallLine(stubbedNow(), conv.recall.recalled.size) : '' };
            })(),
            // The assistant's task plan (todo tool): a snapshot so the render never
            // mutates the tool's module state. Re-read every render, so a plan the
            // LLM edits (via notify()) shows up immediately.
            todo: conv.plan.snapshot(),
          });
        };
      },
    },
  });
}

export default buildAssistantPlugin;
