// Plugin «assistant»: a chat with the LLM about the current task. A self-sufficient
// modal: owns the messages, input, streaming and scroll. THE HOST does the network
// (ft.services.chatLLM) — the plugin never touches it; config read from
// ft.config.ai (baseUrl/model/tokenEnv), token from process.env[tokenEnv].
//   - `ft.services.currentIssue`/`currentComments`/`openIssue` are tracker-specific
//     → referenced as possibly-undefined (a tracker plugin may supply them later).
//   - `get_feature_context` returns "unavailable" until a plugin supplies
//     `ctx.buildFeatureContext` (not set here — a plugin's services may provide it).
//   - the chat's language is `ai.assistantLanguage` (chatLanguage).

import { addTrigger, chatUser } from '../loader/registry.js';
import { bgActiveCount, todoSnapshot } from '../loader/tools-core.js';
import { apiHistory, compactConversation, chatLanguage } from '../assistant/agent.js';
import type { ChatMessage } from '../assistant/agent.js';
import { loadMemories, memoryFilePath } from '../runtime/services/memory.js';
import type { Make } from '../loader/plugin.js';
import type { Plugin } from '../loader/plugin.js';

// Slash-commands of the chat — a single source for runChatCommand and Tab-completion.
// `/analyze` is a tracker slash command and is removed.
const CHAT_COMMANDS = ['refresh-context', 'compact', 'clear', 'exit'];

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
        description: 'Open a chat with the LLM about the current issue (and send the text if provided)',
      },
    ],
    keys: { chat: 'A' },
    views: { chat: renders.chat },
    components: {
      chat: (ft) => {
        const f = ft as AssistantFT;
        return function ChatModal() {
          const { width, height } = f.useTerminalSize();
          const [open, setOpen] = f.useState(false);
          const [messages, setMessages] = f.useState<ChatMsg[]>([]);
          const [input, setInput] = f.useState('');
          const [streaming, setStreaming] = f.useState(false);
          const [error, setError] = f.useState<string | null>(null);
          const [toolLabel, setToolLabel] = f.useState(''); // «⚙ calling get_issue…» during tool rounds
          const [scroll, setScroll] = f.useState(0);
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
          const ctxIssueIdRef = f.useRef<string | number | null>(null); // the task the context/session was built for
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
          // Exit «arming» by Esc: 0 — not armed; else ms when the first Esc was pressed.
          // A second Esc within the window closes the chat; any other key disarms.
          const [escArmAt, setEscArmAt] = f.useState(0);
          const escTimer = f.useRef<ReturnType<typeof setTimeout> | null>(null);
          // y/n pause on a writing operation (write-flag tool → agentChat →
          // confirmWrite): while the promise hangs, input pauses and a confirmation
          // block renders. pendingRef holds { name, args, resolve } — read by the
          // input-handler (a ref, always current); pendingAsk is only for render.
          const pendingRef = f.useRef<{ name: string; args: string; resolve: (ok: boolean) => void } | null>(null);
          const [pendingAsk, setPendingAsk] = f.useState<{ name: string; args: string } | null>(null);

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
            const plan = todoSnapshot();
            if (!plan.length) return '';
            const order = { in_progress: 0, pending: 1, done: 2 };
            const lines = [...plan].sort((a, b) => order[a.status] - order[b.status]).map((t) => {
              const g = t.status === 'done' ? '☑' : t.status === 'in_progress' ? '◐' : '☐';
              const w = t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'in progress' : 'pending';
              return `${g} ${t.id} · ${t.text} (${w})`;
            });
            return `## Current task plan (the \`todo\` tool)\nYou maintain it through \`todo\`; it changes only when you call the tool.\n${lines.join('\n')}`;
          };
          // The full system context of a message = the «cheap» base (directive+identity)
          // + fresh memory + the current plan. No network: the base is synchronous,
          // memory a local file, the plan the tool's module state.
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
            displayMsgs.push({ role: opts.fromBackground ? 'bg' : 'user', content: q });
            apiMsgs.push({ role: 'user', content: q });
            // The question joins the model's history now, so a failed or cancelled
            // turn still leaves it on record; the turn's transcript follows on success.
            apiRef.current = [...apiRef.current, { role: 'user', content: q }];
            setMessages(displayMsgs);
            setInput('');
            inputRef.current = '';
            setCursor(0);
            setError(null);
            setStreaming(true);
            t0Ref.current = Date.now();
            setElapsedMs(0);
            contentRef.current = '';
            setEmptyNotice('');
            setToolCount(0);
            // Tick the indicator every 120ms: spinner frame + tenths of a second.
            if (tickRef.current) clearInterval(tickRef.current);
            tickRef.current = setInterval(() => setElapsedMs(Date.now() - t0Ref.current), 120);
            setScroll(0);
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
                  // buildFeatureContext is NOT set here: get_feature_context returns
                  // «unavailable» until a plugin supplies ctx.buildFeatureContext (a
                  // tracker/feature plugin may provide it via ...ft.services).
                  memoryFile: memoryFilePath(f.config),
                  // The plugin's OWN host-issued token. The CALLER never supplies a
                  // name here — a raw plugin-name string is ignored by the memory
                  // tool (it resolves `plugin` scope only through a token the host
                  // issued), so a plugin can present itself but not impersonate one.
                  pluginToken: f.pluginToken,
                  // Pass the host services into toolCtx: a plugin ai-tool may call
                  // ctx.<service>. This supplements the host bundle, not replaces it.
                  ...(f.services as Record<string, unknown>),
                },
                // The y/n pause on a writing op: agentChat calls confirmWrite for tools
                // with a write-flag, we set pendingRef + pendingAsk and wait for the
                // input-handler to resolve the promise ('y'/Enter — yes, 'n'/Esc — no).
                confirmWrite: (name: string, argsStr: unknown) => new Promise<boolean>((resolve) => {
                  const args = typeof argsStr === 'string' ? argsStr : JSON.stringify(argsStr ?? '');
                  pendingRef.current = { name, args, resolve };
                  setPendingAsk({ name, args });
                  f.notify();
                }),
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
                  if (toolLabel) setToolLabel('');
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
                  if (toolLabel) setToolLabel('');
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
              // After a real write, refresh the detail/cache — otherwise an open ticket and
              // a subsequent context show the pre-write text. openIssue intentionally does
              // not close the chat.
              if (runs.some(r => (r as { write?: boolean; outcome?: string }).write && (r as { outcome?: string }).outcome === 'applied')) {
                const id = (f.services as Record<string, any>).currentIssue?.id;
                if (id) (f.services as Record<string, any>).openIssue?.(id).catch((e: Error) => (f.services as Record<string, any>).pushLog?.(`[chat] refresh failed: ${e.message}`));
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
              // Bind the duration to the last assistant message (persistent «· 12.4s»).
              setMessages(cur => {
                const next = cur.slice();
                const last = next[next.length - 1];
                if (last?.role === 'assistant' && last.duration == null) next[next.length - 1] = { ...last, duration: finalMs };
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
              setStreaming(false);
              setToolLabel('');
              abortRef.current = null;
            }
            return true;
          };

          // ── in-chat commands: `/refresh-context`, `/compact`, `/clear` ──
          // (like /compact and /clear in Claude Code): `/refresh-context` shows the
          // current system-context WITHOUT network, `/compact` compresses the history
          // into one sys-memo (a one-shot non-streaming call), `/clear` fully resets.
          const refreshContext = (show: boolean) => {
            setError(null);
            const sys = assembleSystem();
            if (!sys) return;
            if (show) {
              setMessages(cur => [{ role: 'system', content: sys }, ...cur.filter(m => m.role !== 'system')]);
              setInput('');
              inputRef.current = '';
              setCursor(0);
              setScroll(0);
              (f.services as Record<string, any>).showMessage?.('Context refreshed');
            }
            f.notify();
          };

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
            if (streamRef.current || msgsRef.current.length < 2) return;
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
              const last = msgsRef.current[msgsRef.current.length - 1];
              summaryRef.current = summaryRef.current ? `${summaryRef.current}\n\n${summary}` : summary;
              apiRef.current = [];
              setMessages([{ role: 'system', content: summary }, ...(last ? [last] : [])]);
              setInput('');
              inputRef.current = '';
              setCursor(0);
              setScroll(0);
              (f.services as Record<string, any>).showMessage?.('History compacted');
            });
          };

          const runChatCommand = (cmd: string) => {
            const [name, ...rest] = cmd.split(/\s+/);
            const arg = rest.join(' ');
            void arg;
            switch (name) {
              case 'clear':
                // Full session reset: clear not only messages but everything that would
                // survive a rebuild — emptyNotice, the tool name/counter, the time, the
                // stream/tick, the context.
                if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
                abortRef.current?.abort(); abortRef.current = null;
                if (pendingRef.current) settleConfirm(false);
                ctxIssueIdRef.current = null;
                contentRef.current = '';
                // A cleared session must not have a pre-clear background result surface in
                // the fresh chat: drop any queued-but-unsent delivery and stop the flush
                // interval. (A task still RUNNING delivers after /clear — that is a new,
                // legitimate result; only already-queued pending ones are stale.)
                bgQueueRef.current = [];
                clearFlush();
                apiRef.current = []; summaryRef.current = '';
                setMessages([]);
                setInput(''); inputRef.current = '';
                setCursor(0);
                setError(null);
                setEmptyNotice('');
                setToolCount(0);
                setToolLabel('');
                setElapsedMs(0);
                setScroll(0);
                setShowReasoning(false);
                setStreaming(false);
                disarmEsc();
                f.notify();
                return;
              case 'refresh-context': refreshContext(true); return;
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
            setOpen(false);
            f.notify();
          };

          const openChat = (initialText?: string) => {
            const issueId = (f.services as Record<string, any>).currentIssue?.id ?? null;
            // Task change — a new session (fresh context); re-opening the same task
            // continues the history, nothing is cleared.
            if (issueId !== ctxIssueIdRef.current) {
              ctxIssueIdRef.current = issueId;
              apiRef.current = []; summaryRef.current = '';
              setMessages([]);
              // Task change — a new session: reset the status fields too, else the
              // «limit of steps» warning / tool name from the old task moves into the new.
              setEmptyNotice('');
              setToolLabel('');
              setToolCount(0);
            }
            setOpen(true);
            setScroll(0);
            setError(null);
            const t = initialText ?? '';
            setInput(t);
            inputRef.current = t;
            setCursor(Array.from(t).length);
            disarmEsc();
            f.notify();
            if (t.trim()) send(t);
          };

          (f.store as Record<string, any>).chat = { open, openChat, closeChat, send, messages, streaming, toolLabel, cursor, escArmed, pendingConfirm: pendingAsk };
          // Drains the background-result queue: feeds the next queued result through
          // `send` (which appends it + streams the analysis) once the chat is idle —
          // not streaming, no half-typed draft. `send()` closes the re-entrancy
          // window SYNCHRONOUSLY (sets streamRef.current = true at its top, before any
          // await), so a fast interval tick can't re-enter it before the stream state
          // renders — and unlike setting it HERE, it doesn't trip send()'s own
          // `if (streamRef.current) return false` guard (which dropped the result).
          flushPending = () => {
            if (streamRef.current || inputRef.current) return;
            const q = bgQueueRef.current.shift();
            if (q == null) { clearFlush(); return; }
            setOpen(true);
            f.notify();
            void send(q, { fromBackground: true });
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
            priority: (ui) => (ui.cmdOpen || ui.welcome) ? 0 : (open ? 100 : 0),
            handler: (key) => {
              if (!open) return false;
              // While awaiting a write confirmation (y/n pause), the chat consumes ALL
              // keys: 'y'/⏎ — confirm, 'n'/Esc — decline; normal field input is paused.
              if (pendingRef.current) {
                if (key.name === 'escape' || key.name === 'n') { settleConfirm(false); return true; }
                if (key.name === 'y' || key.name === 'enter' || key.name === 'return') { settleConfirm(true); return true; }
                return true;
              }
              // Any key except the second Esc disarms the exit.
              if (key.name !== 'escape' && escArmAt > 0) disarmEsc();
              // ── Esc: non-empty field → clear; streaming → abort; armed → exit;
              // otherwise arm + hint «Enter Esc again to exit».
              if (key.name === 'escape') {
                if (inputRef.current.length > 0) {
                  setInput(''); inputRef.current = '';
                  setCursor(0);
                  disarmEsc();
                  return true;
                }
                if (streamRef.current) { abortRef.current?.abort(); return true; }
                if (escArmed) { closeChat(); return true; }
                armEsc();
                return true;
              }
              // ── Tab: slash-command autocomplete (refresh-context/compact/clear/exit).
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
                    setCursor(Array.from(newText).length);
                    tabRef.current = { base, idx: nxt, cmd: matches[nxt] };
                    f.notify();
                    return true;
                  }
                }
                tabRef.current = null;
                return true;
              }
              // ── Shift+Enter / Alt+Enter — a newline in the input; Enter — send.
              if ((key.name === 'enter' || key.name === 'return') && (key.shift || key.meta)) {
                const chars = Array.from(inputRef.current);
                const at = cursorRef.current;
                chars.splice(at, 0, '\n');
                const next = chars.join('');
                setInput(next); inputRef.current = next;
                setCursor(at + 1);
                disarmEsc();
                f.notify();
                return true;
              }
              if (key.name === 'enter' || key.name === 'return') {
                const cmd = inputRef.current.trim();
                disarmEsc();
                if (cmd.startsWith('/')) runChatCommand(cmd.slice(1)); else send();
                return true;
              }
              if (key.name === 'up') { setScroll(s => Math.min(s + 1, 1e6)); return true; }
              if (key.name === 'down') { setScroll(s => Math.max(0, s - 1)); return true; }
              // Ctrl+r — fold/unfold the model's «thinking».
              if (key.name === 'r' && key.ctrl) { setShowReasoning(v => !v); return true; }
              // ── caret movement in the input field (codepoint index) ──
              if (key.name === 'left') { setCursor(c => Math.max(0, c - 1)); return true; }
              if (key.name === 'right') { setCursor(c => Math.min(Array.from(inputRef.current).length, c + 1)); return true; }
              if (key.name === 'home') { setCursor(0); return true; }
              if (key.name === 'end') { setCursor(Array.from(inputRef.current).length); return true; }
              // Readline emulation: Ctrl+A/Ctrl+E — start/end of line (like a shell).
              if (key.name === 'a' && key.ctrl) { setCursor(0); return true; }
              if (key.name === 'e' && key.ctrl) { setCursor(Array.from(inputRef.current).length); return true; }
              // ── deletion by caret: Backspace — char BEFORE the caret, Delete — UNDER it.
              if (key.name === 'backspace' || key.name === 'delete') {
                const chars = Array.from(inputRef.current);
                const at = cursorRef.current;
                if (key.name === 'backspace') {
                  if (at <= 0) return true;
                  chars.splice(at - 1, 1);
                  setCursor(at - 1);
                } else {
                  if (at >= chars.length) return true;
                  chars.splice(at, 1);
                  setCursor(at);
                }
                const next = chars.join('');
                setInput(next); inputRef.current = next;
                return true;
              }
              if (key.name && key.name.length === 1 && !key.ctrl && !key.meta) {
                const ch = key.shift ? key.name.toUpperCase() : key.name;
                const chars = Array.from(inputRef.current);
                const at = cursorRef.current;
                chars.splice(at, 0, ch);
                const next = chars.join('');
                setInput(next); inputRef.current = next;
                setCursor(at + 1);
                return true;
              }
              return true;
            },
          });
          // Trigger-open: `A` (Shift+a) opens the chat from any base state (a tracker-
          // agnostic host has no task-detail overlay, so the old `overlay === 'detail'`
          // gate was always false and `A` never fired). triggerOpenable still guards the
          // command line / welcome / global search / open modal and when the chat is
          // already open; closed is not handled by the base consumer (priority 0).
          addTrigger({ ft: f, action: 'chat', isOpen: () => open, open: () => openChat() });
          if (!open) return null;
          // Slash-command autocomplete (visible candidate list), derived from the
          // live input: shown while it starts with '/' and no argument is typed yet.
          // `sel` is the highlighted index (Tab cycles through the matches; a new
          // prefix restarts at the first). The chat VIEW renders this.
          let completions: { matches: string[]; sel: number } | null = null;
          if (input.startsWith('/') && !input.includes(' ')) {
            const prefix = input.slice(1);
            const matches = CHAT_COMMANDS.filter((c) => c.startsWith(prefix));
            if (matches.length) {
              const sel = tabRef.current && tabRef.current.base === prefix ? Math.min(tabRef.current.idx, matches.length - 1) : 0;
              completions = { matches, sel };
            }
          }
          return (f.viewRegistry.chat as (p: Record<string, unknown>) => unknown)({
            width, height, theme: f.config.theme, messages, input, streaming, error, scroll, toolLabel, showReasoning, cursor, escArmed,
            pendingConfirm: pendingAsk,
            currentIssueId: (f.services as Record<string, any>).currentIssue?.id,
            elapsed: elapsedMs, emptyNotice, toolCount, completions,
            // Live count of IN-FLIGHT background tasks (the host re-renders via
            // notify() when one is armed or completes).
            bgCount: bgActiveCount(),
            // The assistant's task plan (todo tool): a snapshot so the render never
            // mutates the tool's module state. Re-read every render, so a plan the
            // LLM edits (via notify()) shows up immediately.
            todo: todoSnapshot(),
          });
        };
      },
    },
  });
}

export default buildAssistantPlugin;