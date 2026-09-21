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
import { createPlan, todoGlyph } from '../assistant/plan.js';
import { apiHistory, compactConversation, chatLanguage } from '../assistant/agent.js';
import { copyTarget, copyToClipboard } from '../assistant/copy.js';
import { createShellState, formatShell, nextCwd, runShell, shellLimits } from '../assistant/shell.js';
import { KEEP_SESSIONS, SESSION_VERSION, closeSession, flushOnExit, listSessions, loadSession, newSessionId, pruneSessions, saveSession, sessionToContinue, sessionWhen, sessionsDir, type Session } from '../assistant/sessions.js';
import type { ChatMessage } from '../assistant/agent.js';
import type { ChangeView } from '../assistant/diff.js';
import { editorReducer } from '@flowtty/core';
import { chatFieldWidth } from '../views/modals.js';
import { askKey, askStart, type AskQuestion, type AskState } from '../assistant/ask.js';
import { loadMemories, memoryFilePath, saveMemories } from '../runtime/services/memory.js';
import { keptAfterClear, memoryCommand } from '../assistant/memory-command.js';
import { CONTEXT_WARN_AT, DEFAULT_CONTEXT_WINDOW, contextBadge, readContext } from '../assistant/context-meter.js';
import { chatTools } from '../loader/tools.js';
import type { Make } from '../loader/plugin.js';
import type { Plugin } from '../loader/plugin.js';

// Slash-commands of the chat — a single source for runChatCommand and Tab-completion.
// `/analyze` is a tracker slash command and is removed.
const CHAT_COMMANDS = ['compact', 'context', 'copy', 'resume', 'clear', 'memory', 'log', 'exit'];

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
  duration?: number;
  stopped?: boolean;
  // What the turn's writes changed — drawn as diff blocks above the answer.
  changes?: ChangeView[];
  [k: string]: unknown;
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
    keys: { chat: 'F' },
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
          // Show the model's «thinking» (reasoning_content): folded by default (one
          // dim-line «▸ reasoning»), Ctrl+r unfolds/folds all.
          const [showReasoning, setShowReasoning] = f.useState(false);
          // Process indicator: spinner + elapsed request time. t0Ref — send start,
          // tickRef — setInterval ticking elapsedMs. On completion the time «freezes»
          // and binds to the last assistant message («· 12.4s»).
          const [elapsedMs, setElapsedMs] = f.useState(0);
          const t0Ref = f.useRef(0);
          const tickRef = f.useRef<ReturnType<typeof setInterval> | null>(null);
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
            // The model narrates tool calls aloud in the answer — that is verbosity. Ask
            // it to think silently and only output the result. Always answer in English,
            // since this chat UI is English-only.
            const chatLang = chatLanguage((f.config as Record<string, unknown>).ai as Record<string, unknown>);
            const directive = `Always respond in ${chatLang}. Answer concisely and to the point: only the outcome, no description of your actions, plans, attempts or searches («Let me try…», «Let me check…») — think silently, give the conclusion in the answer. Never claim you changed, created or deleted something unless a write tool actually returned success for it; if a write was declined or errored, say so instead. If the user asks why you did not run a tool, or says they do not see its result, do NOT just restate that the tool was already called («it’s already done», «it was scheduled»): actually re-run it now, or ask the user to confirm the repeat («run it again?»). Never claim a result you have not seen returned.`;
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
              { system: baseStatic(), memory: memoryBlock(), plan: planBlock(), summary, tools: [...chatTools(), ...(((f.services as Record<string, any>).pluginAiTools ?? []) as unknown[])], messages: apiHistory(apiRef.current) },
              window,
              u ? u.promptTokens + u.completionTokens : undefined,
            );
          };

          const assembleSystem = () => {
            const summary = summaryRef.current ? `Summary of the conversation so far (older turns were compacted):\n${summaryRef.current}` : '';
            const parts = [baseStatic(), memoryBlock(), planBlock(), summary].filter(Boolean);
            return parts.length ? parts.join('\n\n') : null;
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
            displayMsgs.push({ role: opts.fromBackground ? 'bg' : 'user', content: q });
            apiMsgs.push({ role: 'user', content: q });
            // The question joins the model's history now, so a failed or cancelled
            // turn still leaves it on record; the turn's transcript follows on success.
            apiRef.current = [...apiRef.current, { role: 'user', content: q }];
            setMessages(displayMsgs);
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
            // Tick the indicator every 120ms: spinner frame + tenths of a second.
            if (tickRef.current) clearInterval(tickRef.current);
            tickRef.current = setInterval(() => setElapsedMs(Date.now() - t0Ref.current), 120);
            disarmEsc();
            const abort = new AbortController();
            abortRef.current = abort;
            const ai = (f.config.ai ?? {}) as Record<string, any>;
            let failed = false, aborted = false;
            try {
              const chatResult = await (f.services as Record<string, any>).chatLLM(apiMsgs, {
                baseUrl: ai.baseUrl,
                model: ai.model,
                token: process.env[ai.tokenEnv ?? 'LLM_TOKEN'],
                signal: abort.signal,
                // Debug-log of tool calls (opt-in: config.debug.logTools).
                logTools: !!((f.config as Record<string, any>)?.debug?.logTools),
                // Plugin ai-tools (aiTools): agentChat runs their own run(args, toolCtx).
                extraTools: (f.services as Record<string, any>).pluginAiTools ?? [],
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
                  const args = typeof argsStr === 'string' ? argsStr : JSON.stringify(argsStr ?? '');
                  const command = shellCommandOf(name, args);
                  if (contextOpenRef.current) setContextOpen(false);
                  pendingRef.current = { name, args, resolve };
                  setPendingAsk({ name, args, ...(command != null ? { command } : {}) });
                  f.notify();
                }),
                // What a write changed goes on the answer being written the moment the
                // write lands — a block of its own that stays in the chat. Only on the
                // display message: `apiRef` gets the transcript, which never holds it.
                onToolRun: (run: { changes?: ChangeView[] }) => {
                  // The tool is done: until the model's next token it is thinking.
                  if (toolLabelRef.current) setToolLabel('');
                  setPhase('thinking');
                  if (!run.changes?.length) { f.notify(); return; }
                  const added = run.changes;
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
                  f.notify();
                },
                // Diagnostic trace of what EACH round emitted: finish_reason + how many
                // tool_calls streamed. Logged unconditionally so the `l` panel shows
                // whether the model actually attempted a tool call (`finish=tool_calls
                // toolCalls=1`) or just narrated a status change without calling
                // (`finish=stop toolCalls=0`). The missing "▸ tool calls" fold in the
                // chat was AMBIGUOUS — this disambiguates it.
                onRound: (info: { index: number; finishReason: string; toolCalls: number; contentLen: number }) => {
                  (f.services as Record<string, any>).pushLog?.(`[round ${info.index}] finish=${info.finishReason} toolCalls=${info.toolCalls} content=${info.contentLen}ch`);
                },
                // Round content streams LIVE (the agent calls onLive per token). Which this
                // is — a retelling of moves or the answer — onLiveCommit decides at the end
                // of the round. We accumulate in `live`; while alive it renders in the fold,
                // on commit it goes to `process` (retelling) or `content` (answer).
                onLive: (delta: string) => {
                  if (!delta) return;
                  if (toolLabelRef.current) setToolLabel(''); // the tool is done: the model is writing
                  setPhase('writing');
                  setMessages(cur => {
                    const next = cur.slice();
                    const last = next[next.length - 1];
                    if (last?.role === 'assistant') next[next.length - 1] = { ...last, live: (last.live || '') + delta };
                    else next.push({ role: 'assistant', content: '', live: delta });
                    return next;
                  });
                },
                // reasoning and content arrive in one chunk as parallel streams: we
                // accumulate reasoning in a separate message field (not content!).
                onReasoning: (delta: string) => {
                  if (toolLabelRef.current) setToolLabel(''); // the tool is done: the model is thinking
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
                  setMessages(cur => {
                    const next = cur.slice();
                    const last = next[next.length - 1];
                    if (last?.role !== 'assistant') {
                      next.push({ role: 'assistant', content: isAnswer ? text : '', process: isAnswer ? '' : text });
                      return next;
                    }
                    if (isAnswer) {
                      next[next.length - 1] = { ...last, content: text, live: '' };
                    } else {
                      next[next.length - 1] = { ...last, process: (last.process || '') + text, live: '' };
                    }
                    return next;
                  });
                },
              });
              (f.services as Record<string, any>).pushLog?.(`[chat] ${q.slice(0, 40)}… → ${(apiMsgs[apiMsgs.length - 1]?.content ?? '').length || 0} chars`);
              // A persistent trail of executed tools: put it on the last assistant message
              // so the render shows «▸ update_issue … → applied/declined/error».
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
                  const last = next[next.length - 1];
                  if (last?.role === 'assistant') next[next.length - 1] = { ...last, toolRuns: runs };
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
              }
            } finally {
              if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
              const finalMs = Date.now() - t0Ref.current;
              setElapsedMs(finalMs);
              // Bind the duration to the last assistant message (persistent «· 12.4s»),
              // and mark an answer stopped with Esc: cut short, «The» reads like a whole
              // (and odd) answer unless the line under it says it was stopped.
              setMessages(cur => {
                const next = cur.slice();
                const last = next[next.length - 1];
                if (last?.role === 'assistant' && last.duration == null) next[next.length - 1] = { ...last, duration: finalMs, ...(aborted ? { stopped: true } : {}) };
                return next;
              });
              // Empty answer: the model gave only reasoning (it is in the «reasoning» fold)
              // but no final text — say so explicitly. Error and cancel (Esc) are not an
              // empty answer — they already have their own indication (⚠ error / quiet log).
              if (!contentRef.current.trim() && !failed && !aborted) {
                setEmptyNotice('The turn ran out of steps before a final answer — only reasoning came back (^r shows it). Narrow the question, or say "continue".');
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
            setElapsedMs(0);
            if (tickRef.current) clearInterval(tickRef.current);
            tickRef.current = setInterval(() => setElapsedMs(Date.now() - t0Ref.current), 120);
            disarmEsc();
            const abort = new AbortController();
            abortRef.current = abort;
            const cwd = shellRef.current.cwd();
            const { timeoutMs, maxChars } = shellLimits(f.config as { shell?: unknown });
            let stopped = false;
            try {
              const r = await runShell(cmd, { cwd, timeoutMs, maxChars, signal: abort.signal });
              stopped = r.stopped;
              // `cd` sticks, as in a terminal — within the roots.
              const move = nextCwd(f.config as Record<string, unknown>, cwd, r.pwd);
              if (move.cwd !== cwd) shellRef.current.setCwd(move.cwd);
              const { display, forModel } = formatShell(cmd, r, cwd, timeoutMs, { after: move.cwd, note: move.note });
              setMessages((cur) => [...cur, { role: 'shell', content: display, command: cmd }]);
              apiRef.current = [...apiRef.current, { role: 'shell', content: forModel }];
              (f.services as Record<string, any>).pushLog?.(`[shell] ${cmd.slice(0, 60)} → ${r.error ? `error: ${r.error}` : r.stopped ? 'stopped' : r.timedOut ? 'timed out' : `exit ${r.code}`}`);
            } catch (e) {
              setError(`!: ${(e as Error).message}`);
            } finally {
              if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
              setElapsedMs(Date.now() - t0Ref.current);
              streamRef.current = false;
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
            setElapsedMs(0);
            if (tickRef.current) clearInterval(tickRef.current);
            tickRef.current = setInterval(() => setElapsedMs(Date.now() - t0Ref.current), 120);
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

          const runChatCommand = (cmd: string) => {
            const [name, ...rest] = cmd.split(/\s+/);
            const arg = rest.join(' ');
            switch (name) {
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
                setError(null);
                setEmptyNotice('');
                setToolCount(0);
                setToolLabel('');
                setElapsedMs(0);
                setShowReasoning(false);
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
            handler: (key) => {
              if (!open) return false;
              // While awaiting a write confirmation (y/n pause), the chat consumes ALL
              // keys: 'y'/⏎ — confirm, 'n'/Esc — decline; normal field input is paused.
              // An open question consumes every key too: arrows/digits/Space/⏎ answer it,
              // Esc dismisses it, and in the free-text field every printable key is text.
              if (askRef.current) {
                const next = askKey(askRef.current.state, key);
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
              // Ctrl+r — fold/unfold the model's «thinking».
              if (key.name === 'r' && key.ctrl) { setShowReasoning(v => !v); return true; }
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
                { multiline: true, width: chatFieldWidth(width) },
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
            width, height, theme: f.config.theme, messages, input, streaming, error, toolLabel, phase, showReasoning, cursor, escArmed,
            shellMode,
            pendingConfirm: pendingAsk,
            pendingQuestion,
            queued,
            subject: (f.services as { chatSubject?: () => string | null }).chatSubject?.() ?? null,
            elapsed: elapsedMs, emptyNotice, toolCount, completions,
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