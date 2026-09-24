// Core tool group: memory, config, and the current-feature context. Always on
// (not gated by config.ai.disabledTools). The host config/memory modules are
// imported directly (there is no import cycle — this module only pulls from
// config and runtime/services).
//
// Contract of a group: { id, alwaysOn, tools, exec(name, args, ctx) } where
// `args` is an already-parsed object and `ctx` is the runtime context
// ({ memoryFile, configLocalPath }). Each writing tool is
// flagged `write` (true or a predicate `(args) => boolean`).

import { hostConfigSchema } from '../config/schema.js';
import { loadConfig, getDeep, getSchemaAtPath, describeSchema, unwrapNode, configSchemaAt } from '../config/load.js';
import { loadMemories, saveMemories, memoryFilePath, refuseMemory } from '../runtime/services/memory.js';
import { openInBrowser } from '../runtime/services.js';
import { resolveIdentityToken } from '../runtime/plugin-identity.js';
import { DEFAULT_THEME } from '../playback/theme.js';
import { writtenKey } from '../playback/keys.js';
import { createPlan, type Plan } from '../assistant/plan.js';
import type { ToolGroup, ToolDef } from './tools.js';
import { WEB_DEFAULTS } from '../assistant/web-fetch.js';
import { SHELL_DEFAULTS, createShellState } from '../assistant/shell.js';
import { parseAskArgs, askResult, type AskQuestion, type AskState } from '../assistant/ask.js';
import type { Change } from '../assistant/diff.js';
import { TOOLS_LOAD } from '../assistant/tool-loading.js';
import { TOOL_RESULT_MAX_CHARS_CEILING, TOOL_RESULT_MAX_CHARS_DEFAULT } from '../assistant/tool-result-cap.js';
import { IMAGE_DEFAULTS } from '../assistant/images.js';
import { ANTHROPIC_BASE_URL, DEFAULT_MAX_TOKENS, llmOpts } from '../assistant/llm-endpoint.js';

// Runtime context handed to core tools by the caller: the resolved memory
// file (absent → resolved from config), the config.local.json path, and the active
// plugin's identity token (a `plugin` memory scope resolves to the plugin it was
// issued to — the host maps the token to the name; a caller cannot forge one).
export interface CoreCtx {
  memoryFile?: string;
  configLocalPath?: string;
  pluginToken?: symbol;
  // Supplied by an interactive chat: shows the questions and resolves once the
  // person has answered or dismissed them. Absent where there is nobody to ask.
  askUser?: (questions: AskQuestion[]) => Promise<Pick<AskState, 'answers' | 'cancelled'>>;
  // Supplied by `agentChat` to every call: a tool that edits something reports what
  // it looked like before and after, and the chat shows the diff under the answer.
  // Display only — the model never gets it. Report only a change that was made.
  reportChange?: (change: Change) => void;
  // Also supplied by `agentChat`: how a tool's RESULT is shown — a kind and data a
  // renderer draws and the host frames (src/assistant/views.ts). `run_command` reports
  // its output this way (kind `console`). Display only, like a reported change, and
  // capped by the host; a kind with no renderer draws as one dim line naming it.
  // `reportChange` stays the shorthand it is, and becomes a kind of its own here later.
  reportView?: (kind: string, data?: unknown) => void;
}

// Resolves the memory `plugin` scope to the owning plugin name from the host-issued
// identity token. Only a Symbol the host actually issued maps to a name — a
// caller-injected raw string or a foreign token resolves to undefined.
function pluginScopeName(ctx: CoreCtx): string | undefined {
  return ctx.pluginToken !== undefined ? resolveIdentityToken(ctx.pluginToken) : undefined;
}

// Renders a resolved hotkey map ({ action: [keys] }) compactly for tool output:
// a single-key action renders as the bare name, multiple as `a/b`. Used by the
// config tool so `config get/explain keys` reports the effective bindings.
// Shown as a person WRITES a key ("enter", "space"), since this is what the model
// repeats to them in a `config set keys.…` command.
function prettyKeys(map: Record<string, string[]>): string {
  // An action with no key says so — `quit:` with nothing after it read as a gap in
  // the listing. (quit is unbound by default: it is the `:quit` command.)
  const parts = Object.values(map).map((ks) => (ks.length ? ks.map(writtenKey).join('/') : '(unbound)'));
  return `{ ${Object.keys(map).map((a, i) => `${a}: ${parts[i]}`).join(', ')} }`;
}

// An ACTIVE default for a top-level config key, reported when the config value is
// unset so the LLM can explain the key accurately instead of guessing (it once
// claimed cache is off by default — it is actually ON unless config.cache.enabled
// is false). These mirror the consuming modules; keep in sync. Most are constants
// (the "unset" default), since a set key needs no default note. A full path
// (`ai.toolLoading`) is looked up before its top-level key.
const KEY_DEFAULTS: Record<string, string> = {
  'ai.provider': `unset — an OpenAI-compatible chat-completions API at ai.baseUrl with the token from LLM_TOKEN (or the variable ai.tokenEnv names). config set ai.provider anthropic talks to Anthropic's own Messages API instead: ai.baseUrl defaults to ${ANTHROPIC_BASE_URL}, the token to ANTHROPIC_API_KEY, and ai.model is a Claude model id (claude-sonnet-5, claude-opus-5-5); the tools, the system prompt and the turn so far are cached between requests, and the model's thinking shows in the chat's thinking fold. A base URL of your own includes /v1 (requests go to <ai.baseUrl>/messages)`,
  'ai.maxTokens': `${DEFAULT_MAX_TOKENS} — the longest answer one request may get, with ai.provider anthropic only (that API requires one; thinking counts against it). A fixed thinking budget that leaves the answer less than 1024 under it is lowered to fit (the log says so)`,
  'ai.thinking': 'unset — the model thinks as it does by default (the current Claude models decide for themselves; their thinking is not shown). With ai.provider anthropic: config set ai.thinking \'{"adaptive":true}\' asks for adaptive thinking and shows a summary of it in the chat\'s thinking fold; {"budgetTokens":N} (at least 1024) is a fixed budget, for older models only — the current ones refuse it',
  'ai.toolLoading': `onDemand — each request carries the core tools in full and only an index (name and one line) of the others; the model loads what it needs with ${TOOLS_LOAD}, and a loaded tool stays for the rest of the conversation (/clear empties the set). config set ai.toolLoading all sends every tool in full on every request — more tokens per request, for a model that does not load tools well`,
  'ai.toolResultMaxChars': `${TOOL_RESULT_MAX_CHARS_DEFAULT} — a tool result longer than this is cut before it joins the conversation: the head is kept, a short tail too, and a note in between says how much was cut and asks for less (a filter, a limit, one item). Only what is SENT is capped — a command's own block and the tool trail always show what really happened. A tool may declare its own higher cap for one call, up to ${TOOL_RESULT_MAX_CHARS_CEILING}. config set ai.toolResultMaxChars 80000 raises the default`,
  // Said in full: "can I show it a screenshot?" is asked of the assistant, and so is
  // "why was my image refused?".
  'ai.images': `enabled: true — the person can show the model images in the chat: drag a file onto the terminal or paste its path (the whole paste must be the path), /image <path>, or /image, Ctrl+V or Cmd+V for the image on the clipboard (macOS: pngpaste or osascript; Linux: wl-paste or xclip). Each becomes an [Image #N] token in the text; the file is read only when the person attaches it, and kept in the session as its path and hash, not its bytes. maxBytes: ${IMAGE_DEFAULTS.maxBytes} (a bigger file is refused, never shrunk), maxPerMessage: ${IMAGE_DEFAULTS.maxPerMessage}. A model that cannot take images: config set ai.images.enabled false — attaching is then refused, and images already in the conversation go as their names only`,
  cache: 'enabled: true; ON unless config.cache.enabled = false',
  theme: `${JSON.stringify(DEFAULT_THEME)}; flowtty default theme`,
  debug: 'logTools: false',
  // Said in full because it answers a question people really ask the assistant:
  // "why can't I select text with the mouse?"
  ui: 'mouse: true — the wheel scrolls the chat, and dragging with the mouse selects text and copies it to the clipboard when the button is released ("Copied N chars"); a drag stays inside the pane it started in (the conversation, a window, a board column), so borders, markers and the next panel are left out, and a wrapped paragraph copies as one line. The terminal\'s own selection still works with its bypass held (Option in iTerm2, Shift in most Linux terminals, fn in Apple Terminal). config set ui.mouse false gives the mouse back to the terminal (takes effect on restart). In the chat, /copy copies the last answer\'s code block (/copy answer — the whole answer) without the mouse. verbs: a list of words the chat\'s status line picks one from per model request while the model works (default: a built-in list of gerunds); config set ui.verbs \'["Thinking"]\' pins one',
  memory: 'file: memory.json in the config directory; empty to start',
  sessions: 'dir: sessions/ in the config directory; resume: true — the chat continues the latest session on start (a restart or an update loses nothing); keep: 50 sessions. In the chat, /resume lists the saved sessions and /resume <n> opens one; /clear starts a new session and keeps the old one',
  fs: 'legacy — roots is read as shell.roots (and by the repo plugin after plugins.repo.roots / shell.roots) for one release; set shell.roots instead',
  web: `allowlist: [] — every web_fetch asks the person first (a background task cannot fetch at all); a host on the list is fetched without asking, even a local one. maxBytes: ${WEB_DEFAULTS.maxBytes}, timeoutMs: ${WEB_DEFAULTS.timeoutMs}. The web_fetch tool is its own group: config set ai.disabledTools ["web"] turns it off`,
  shell: `timeoutMs: ${SHELL_DEFAULTS.timeoutMs} (the whole process group is killed after it), maxChars: ${SHELL_DEFAULTS.maxChars} (the END of the output is kept), roots: [] (no roots: commands start in the app's own directory and cd anywhere). Two ways to run a command: the person types !command in the chat (e.g. !bun test) — it runs in the first shell.roots directory (else the app's own), the directory is remembered between commands like a terminal's (cd moves it, only within the roots; variables are not kept; /clear goes back to the first root), Esc stops it, and the output joins the conversation without spending a model turn (!!command runs an interactive program with the terminal instead, records what it printed under script, and asks the model to look at it at once — unless nothing was recorded: no usable script, or a full-screen program such as vim/less/top that leaves nothing printed; then it is only shown); and the model's run_command tool, which asks the person y/n before every command and is never run by a background task. config set ai.disabledTools ["shell"] turns run_command off (! stays)`,
  // "always LOADED", not always visible: each built-in is configured via its own
  // config.plugins.<name>.* namespace. keycaps is OFF by default — its panel shows
  // only when config.plugins.keycaps.enabled = true. Saying "always active" made the
  // LLM conclude "already on, nothing to enable" and refuse the request.
  plugins: 'built-in core, assistant, keycaps, log are always LOADED; each is configured via config.plugins.<name>.* (keycaps shows its panel only when config.plugins.keycaps.enabled = true — it is OFF by default)',
  // Said in full: "what is that dim ▸ line?" and "where did the text go?" are asked of
  // the assistant. The full path, so the other assistant keys keep the `plugins` note
  // above.
  'plugins.assistant.notes': 'A turn is drawn in the order it happened: what the model said between tool calls (its steps), the calls, each diff, then the answer. step (the default) — each stretch of steps (with the calls each made) folds to ONE dim ▸ line where it began: the latest step and how many there were; a click opens that stretch, Ctrl+o opens all. open — every step in full, in the normal colour. The "Next:" a step starts with is never shown, only the sentence after it. In the chat, /notes [step|open] changes it for the current conversation only. The older values fold and hidden are read as step',
};

// Resolves the zod node for a config key, falling back to a plugin's own
// configSchema for `plugins.<name>.*` paths. The host schema sees `plugins` only as
// an opaque `record(string, unknown)`, so it cannot describe a flag a plugin
// declares (e.g. config.plugins.keycaps.enabled) — without this fallback the config
// tool would report the flag as an "unknown key" and config set plugins.keycaps.enabled
// would fail, which is exactly the dead-end the LLM hit.
function schemaAt(key: string, pluginConfigs?: Record<string, unknown>): any {
  return configSchemaAt(hostConfigSchema, key, pluginConfigs);
}

// Normalizes a memory scope to the host scope-model. Only two literals are accepted:
// 'host' (host-wide) and 'plugin' (the current plugin's memory — the host resolves it
// to the plugin name via the host-issued identity token; without a valid token it
// errors rather than silently writing an unattributed entry). 'global' is a legacy
// alias for 'host'. Empty → 'host' (the default). Anything else is rejected, so the
// memory tool stops accepting ad-hoc values (e.g. an obsolete "issue:TRK-1") that
// orphan entries.
function normalizeScope(raw: string | undefined, ctx: CoreCtx): { scope: string; error?: string } {
  const s = String(raw ?? 'host').trim();
  const scope = s === 'global' ? 'host' : s;
  if (!scope) return { scope: 'host' };
  if (scope === 'plugin') {
    const name = pluginScopeName(ctx);
    if (name) return { scope: name };
    return { scope, error: "scope 'plugin' needs a plugin context (no valid plugin identity token attached) — use 'host' for host-wide memory" };
  }
  if (scope !== 'host') return { scope, error: `invalid scope '${scope}' — expected 'host' or 'plugin'` };
  return { scope: 'host' };
}

// Renders the current date/time in a given IANA zone (default: the host local
// zone), plus epoch seconds and the UTC ISO timestamp. Lets the LLM answer
// time-sensitive questions — LLMs do not reliably know "now". An invalid zone
// returns a friendly error instead of throwing (the tool must never crash).
function describeDatetime(zone: string): string {
  const now = new Date();
  let parts: Record<string, string>;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, weekday: 'long', timeZoneName: 'longOffset',
    }).formatToParts(now).reduce((m, p) => {
      if (p.type !== 'literal') m[p.type] = p.value;
      return m;
    }, {} as Record<string, string>);
  } catch {
    return `Invalid timezone '${zone}' — use an IANA name like 'Europe/Moscow' or 'UTC'.`;
  }
  return [
    `timezone: ${zone} (${parts.timeZoneName})`,
    `epoch: ${Math.floor(now.getTime() / 1000)}`,
    `iso-utc: ${now.toISOString()}`,
    `local: ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} (${parts.weekday})`,
  ].join('\n');
}

// Duration-word → milliseconds map for the `remind` tool's `in` argument.
const DURATION_MS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000, d: 86400000,
  day: 86400000, days: 86400000,
};

// Parses the `remind` tool's time spec to a delay in ms. `in` is a duration from
// now ("3 minutes"); `at` is a wall-clock time today ("14:30", past → tomorrow).
// Exactly one must be provided; an unparseable value returns a friendly error.
function parseReminderMs(inArg: string, atArg: string): { ms: number } | { error: string } {
  const inStr = inArg.trim().toLowerCase();
  if (inStr) {
    const m = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(inStr);
    const unit = m ? DURATION_MS[m[2]] : undefined;
    if (!m || !unit) return { error: `Unparseable duration '${inArg}' — use e.g. "90 seconds", "3 minutes", "2 hours".` };
    return { ms: parseFloat(m[1]) * unit };
  }
  const atStr = atArg.trim();
  if (atStr) {
    const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(atStr);
    if (!t) return { error: `Unparseable time '${atArg}' — use "HH:MM" or "HH:MM:SS" (24h).` };
    const now = new Date();
    const target = new Date(now);
    target.setHours(Number(t[1]), Number(t[2]), Number(t[3] ?? 0), 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return { ms: Math.max(0, target.getTime() - now.getTime()) };
  }
  return { error: '`in` (a duration) or `at` (a clock time) is required.' };
}

// Background-task concurrency: a module-level counter + FIFO queue so a runaway
// agent cannot spawn unbounded CONCURRENT detached agent runs (each is a live LLM
// call). Schedule is unbounded — a task is just a timer until it fires — but at
// most MAX run at once. Overflow is QUEUED, not dropped: when a running task frees
// a slot the next queued one is promoted. (Dropping silently turned a burst — e.g.
// several "run X in 1s" — into tasks that "didn't start" from the user's view.)
let bgRunning = 0;
const MAX_BG_TASKS = 3;
const bgQueue: Array<() => void> = [];
// A background task may chain follow-up background tasks (a task whose subtask
// needs further work — e.g. "build, then fix and rebuild on failure"). But an
// agent must NOT recurse `background` forever: this caps how deep a chain may go
// (0 = the main chat's task · 1 = a task it spawned · 2 = deepest, no further).
const MAX_BG_DEPTH = 2;
// In-flight background work — what the chat's «N in background» indicator counts. A task
// is counted from the moment it is SCHEDULED (its `in`/`at` delay armed) until it
// fully completes: armed-but-delayed + queued-for-a-slot + running. `bgRunning` is
// the execution cap; `bgActive` is the user-facing count.
let bgActive = 0;

// Runs `run` under the concurrency cap: start immediately if a slot is free,
// otherwise enqueue and start when the next slot frees. The counter covers only
// RUNNING tasks (not merely-scheduled ones), so delayed tasks don't hold a slot.
function runBg(run: () => Promise<void>): void {
  const start = () => {
    bgRunning++;
    void run().finally(() => {
      bgRunning--;
      const next = bgQueue.shift();
      if (next) next(); // promote the next queued task into the freed slot
    });
  };
  if (bgRunning < MAX_BG_TASKS) start();
  else bgQueue.push(start);
}

// Live count of IN-FLIGHT background tasks (armed / queued / running), for the
// chat's «N in background» indicator. The host's notify() drives the re-render that
// updates it — called when a task is armed, when it starts, and when it completes.
export function bgActiveCount(): number {
  return bgActive;
}

// ─── The assistant's task plan ────────────────────────────────────────────────
// The plan is the CONVERSATION's (`src/assistant/plan.ts`): whoever owns one — the
// chat, a background run, an eval — creates it and passes it as `ctx.plan`. A caller
// with no conversation of its own (the one-shot CLI, a bare `execChatTool`) gets
// `processPlan`, which lives as long as the process — for a one-shot that IS the
// conversation.
export type { TodoItem, TodoStatus } from '../assistant/plan.js';
const processPlan = createPlan();

export const coreTools = (config: Record<string, unknown>, resolvedKeys?: Record<string, string[]>, pluginConfigs?: Record<string, unknown>): ToolGroup => ({
  id: 'core',
  alwaysOn: true,
  tools: [
    {
      type: 'function',
      function: {
        name: 'memory',
        description: 'Persistent cross-session memory. Facts the user asks you to remember are stored here and injected into the system prompt (re-read on every message, so edits take effect immediately). action: "list" — show stored memories (optional scope and/or label filter); "add" — store a new one (text, optional label to classify it, scope: "host" for host-wide memory or "plugin" for the current plugin\'s memory, default "host"); "update" — edit an existing one (id + text and/or scope and/or label); "forget" — delete by id. This writes only a local JSON file on this machine, not the tracker. Every entry is sent with every later request, forever: store ONE durable fact per entry — a preference, a convention, a name — as a short sentence that stands without the conversation it came from. Never task state, a number that will change, or anything the session already holds; never a secret or a token. Before adding, list and UPDATE the entry that already says it rather than adding a near-copy. The host refuses a duplicate, an entry over 300 characters and more than 100 entries; the person sees and prunes the list with /memory.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'add', 'update', 'forget'], description: 'list — read stored memories; add — store a new one; update — edit an existing one; forget — delete by id.' },
            text: { type: 'string', description: 'Memory text (for add/update).' },
            scope: { type: 'string', description: 'Optional scope: "host" (host-wide, default) or "plugin" (the current plugin\'s memory — the host resolves the plugin).' },
            label: { type: 'string', description: 'Optional label to classify a memory, e.g. the name of the tool a fact relates to (config, host:plugins_list, memory …). Use it to filter memories by topic: prefix the label with the tool name, then list with the same label to recall only that tool\'s facts.' },
            id: { type: 'string', description: 'Memory id (for update/forget; from action=list).' },
          },
          required: ['action'],
        },
      },
      // Memory is intentionally NOT write-confirmed: it is a low-stakes, local,
      // reversible scratchpad (a JSON file on this machine). A confirm on every
      // add/update/forget would break the transparent persistence the tool exists
      // for — the assistant should record/update/drop facts quietly. (config
      // set/unset/… stays confirmed — it changes hotkeys/model/cache, real behavior.)
    },
    {
      type: 'function',
      function: {
        name: 'config_schema',
        description: 'The shape of the configuration, so you can help the person set it up: every key with its type, whether it is set, its active default, the effective key bindings and each plugin\'s own flags. It shows NO values and cannot write — the person changes config themselves with `config set <key> <value>`; answer with that exact command.',
        parameters: { type: 'object', properties: { key: { type: 'string', description: 'Optional dot path to narrow the listing to one subtree, e.g. "ai" or "plugins.<name>".' } } },
      },
    },
    {
      type: 'function',
      function: {
        name: 'datetime',
        description: 'The CURRENT date and time (LLMs do not reliably know "now"). Read-only, no side effects. Call this before answering anything time-sensitive — today\'s date, what weekday it is, deadlines, relative dates, schedules, "how long since/as of when". Returns the timezone, epoch seconds, UTC ISO timestamp and the set local clock time. Optional `zone`: an IANA timezone (e.g. "Europe/Moscow", "UTC") to report that zone\'s time instead of the host local one.',
        parameters: { type: 'object', properties: { zone: { type: 'string', description: 'Optional IANA timezone (e.g. "Europe/Moscow", "UTC") — default: the host local timezone.' } }, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'remind',
        description: 'Schedule a timed reminder that pops a centered, top-most banner in the TUI after a delay (dismiss with Esc). Call when the user asks to be reminded of something later — e.g. "remind me in 3 minutes to blink". `in`: a duration from now ("90 seconds", "3 minutes", "2 hours"); OR `at`: a wall-clock time today ("14:30" / "17:00:00", 24h; if already past, tomorrow). Exactly one of `in`/`at` is required, plus `text`. The reminder is ephemeral (session-only) and fires once; dismissed by Esc, confirmed by the banner.',
        parameters: { type: 'object', properties: {
          text: { type: 'string', description: 'The reminder content to fire (e.g. "blink").' },
          in: { type: 'string', description: 'A duration from now, e.g. "90 seconds", "3 minutes", "2 hours".' },
          at: { type: 'string', description: 'A wall-clock time today, "HH:MM" or "HH:MM:SS" (24h); if already past, tomorrow.' },
        }, required: ['text'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'background',
        description: 'Run a task in the BACKGROUND: offload a self-contained job to a separate agent run that has tool access, return immediately (the chat stays usable), and report the result when it completes — as a toast + log entry AND a message returned into the chat (the assistant opens it and, when idle, analyzes it in the conversation). Call when the user wants something done later without blocking the conversation — e.g. "запусти сборку в фоне и скажи когда готово", "посмотри что в репо и отчитайся позже". `task` (required): the work to do, in natural language. `label`: a short name for the task/notification (default: the task, clipped). `in`/`at`: an optional delay before it starts (a duration like "10 seconds", or a clock time). The task runs read-only (write tools are declined) and bounded (up to 12 tool rounds). You may spawn a follow-up `background` task for a further step, but keep the chain to ONE level. The chat shows how many background tasks are in flight.',
        parameters: { type: 'object', properties: {
          task: { type: 'string', description: 'The work to do in the background, in natural language — e.g. "count the tests in src and report the number".' },
          label: { type: 'string', description: 'Optional short name for the task/notification (default: the task, clipped to ~40 chars).' },
          in: { type: 'string', description: 'Optional delay before it starts, e.g. "10 seconds", "2 minutes".' },
          at: { type: 'string', description: 'Optional clock time to start, "HH:MM" or "HH:MM:SS" (24h); if already past, tomorrow.' },
        }, required: ['task'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'todo',
        description: 'The task plan the chat renders as `▾ plan`. It changes only through this tool, so call it whenever the plan or an item\'s status should change. Target an item by `id` or by `text`. Use `set` with the full list when several items change at once, `start`/`complete` for a single item.',
        parameters: { type: 'object', properties: {
          action: { type: 'string', enum: ['list', 'set', 'add', 'start', 'complete', 'uncomplete', 'update', 'remove', 'clear'], description: 'list — read the plan; set — replace the whole plan with `todos`; add — append pending item(s); start / complete / uncomplete — mark in progress / done / pending; update — new `text` for an item (needs `id`); remove — delete an item; clear — empty the plan.' },
          todos: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } }, required: ['text'] }, description: 'For `set`: the full plan, each item { text, status? } (status defaults to pending). An empty array empties the plan.' },
          items: { type: 'array', items: { type: 'string' }, description: 'For `add`: several pending items in one call.' },
          text: { type: 'string', description: 'For add/update: the item text. For start/complete/uncomplete/remove: the item to target — matched exactly, then case-insensitively, then as a substring.' },
          id: { type: 'number', description: 'The item id from `list`; an alternative to `text`.' },
        }, required: ['action'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ask_user',
        description: 'Ask the person a question and wait for the answer. Use it when a decision is genuinely theirs and you cannot settle it from the request, the context or a sensible default — not for things you can look up, and not to ask permission to continue. Offer 2–4 concrete options per question; put the one you recommend first and end its label with "(Recommended)". Do not add an "Other" option: the person can always answer in their own words.',
        parameters: { type: 'object', properties: {
          questions: { type: 'array', minItems: 1, maxItems: 4, description: '1–4 questions, asked in turn.', items: { type: 'object', properties: {
            question: { type: 'string', description: 'The full question, ending with a question mark.' },
            header: { type: 'string', description: 'A very short label for the question (a word or two).' },
            options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', properties: {
              label: { type: 'string', description: 'The choice, 1–5 words.' },
              description: { type: 'string', description: 'What choosing it means or costs.' },
            }, required: ['label'] } },
            multiSelect: { type: 'boolean', description: 'true when several options can be chosen together.' },
          }, required: ['question', 'options'] } },
        }, required: ['questions'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'open_url',
        description: 'NAVIGATION ONLY — open a URL in the system browser. It does NOT fetch the page content — it only opens the URL in the user\'s browser. Use it when the user asks to OPEN a page, not to read data (use a read tool for that). Pass a FULL URL; when a tool result carries a ready web link for an entity (a `webUrl` field), pass that link as-is rather than assembling one by hand.',
        parameters: { type: 'object', properties: { url: { type: 'string', description: 'Full URL to open in the browser (e.g. "https://example.com"), or a `webUrl` taken from a tool result.' } }, required: ['url'] },
      },
    },
  ],
  exec: async (name, args, ctx: CoreCtx) => {
    switch (name) {
      case 'ask_user': {
        const parsed = parseAskArgs(args);
        if ('error' in parsed) return `ask_user: ${parsed.error}`;
        // A one-shot prompt or a background task has no chat to ask in: answer at
        // once rather than hang on a question nobody will see.
        if (!ctx.askUser) return 'ask_user: there is nobody to ask here (not an interactive chat). Proceed on your best assumption and say which one you made.';
        const done = await ctx.askUser(parsed.questions);
        return askResult({ ...done, questions: parsed.questions, index: 0, cursor: 0, picked: [], typing: false, text: '', caret: 0, done: true });
      }
      case 'open_url': {
        // Universal browser opener: the host owns the primitive (openInBrowser).
        // The tool takes a FULL URL — a plugin that knows an entity's web address
        // hands it over as `webUrl` in its own tool results.
        const url = String(args.url ?? '').trim();
        if (!url) return 'No URL provided';
        openInBrowser(url);
        return `Opened ${url} in the browser`;
      }
      case 'memory': {
        // The assistant's memory lives in a local JSON file (ctx.memoryFile from
        // the caller, or resolved from config.memory.file, or the default).
        // `list` reads, `add` appends, `update` edits an existing entry by id
        // (text and/or scope), `forget` deletes by id. The contents are injected
        // into the system prompt (re-read on every message — edits take effect
        // immediately). Writes only a file on this machine, not the tracker.
        const action = String(args.action ?? '').trim();
        const memFile = ctx.memoryFile ?? memoryFilePath(config);
        const list = loadMemories(memFile);
        if (action === 'list') {
          const raw = String(args.scope ?? '').trim();
          // Empty filter → all memories; a given scope is normalized (global→host,
          // plugin→resolved name) and filtered exactly, so legacy entries still match.
          const filter = raw ? (raw === 'global' ? 'host' : raw === 'plugin' ? (pluginScopeName(ctx) ?? raw) : raw) : '';
          const label = String(args.label ?? '').trim();
          const filtered = list.filter(m => (!filter || m.scope === filter) && (!label || m.label === label));
          if (!filtered.length) return 'No memories stored yet.';
          return filtered.map(m => `[${m.id}] (${m.scope})${m.label ? ` [${m.label}]` : ''} ${m.text}`).join('\n');
        }
        if (action === 'add') {
          const text = String(args.text ?? '').trim();
          if (!text) return 'text is required — the memory text to store.';
          // What the description asks for, the host holds it to: the model reads other
          // people's text, so a rule it may ignore is not a rule. A near-copy of a
          // fact already stored, a paragraph, or one entry past the cap is refused —
          // and the refusal says what to do instead.
          const refusal = refuseMemory(list, text);
          if (refusal) return refusal;
          const { scope, error } = normalizeScope(args.scope as string | undefined, ctx);
          if (error) return error;
          const label = String(args.label ?? '').trim() || undefined;
          const id = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          list.push({ id, text, scope, label, ts: Date.now() });
          saveMemories(list, memFile);
          return `Memory stored (${id}, scope ${scope}). It will be injected into subsequent messages.`;
        }
        if (action === 'update') {
          const id = String(args.id ?? '').trim();
          if (!id) return 'id is required — memory id (from memory action=list).';
          const idx = list.findIndex(m => m.id === id);
          if (idx === -1) return `Memory ${id} not found.`;
          const hasText = args.text != null && String(args.text).trim() !== '';
          const hasScope = args.scope != null && String(args.scope).trim() !== '';
          // Present-but-empty label clears it (|| undefined), so update can drop a label.
          const hasLabel = args.label != null;
          if (!hasText && !hasScope && !hasLabel) return 'text, scope and/or label is required — the memory fields to update (id must exist).';
          const next = { ...list[idx], ts: Date.now() };
          if (hasText) next.text = String(args.text).trim();
          if (hasLabel) next.label = String(args.label).trim() || undefined;
          if (hasScope) {
            const { scope, error } = normalizeScope(args.scope as string | undefined, ctx);
            if (error) return error;
            next.scope = scope;
          }
          list[idx] = next;
          saveMemories(list, memFile);
          return `Memory ${id} updated. It will be injected into subsequent messages.`;
        }
        if (action === 'forget') {
          const id = String(args.id ?? '').trim();
          if (!id) return 'id is required — memory id (from memory action=list).';
          const kept = list.filter(m => m.id !== id);
          if (kept.length === list.length) return `Memory ${id} not found.`;
          saveMemories(kept, memFile);
          return `Memory ${id} deleted.`;
        }
        return 'action is required — list|add|update|forget.';
      }
      case 'config_schema': {
        // Read-only and value-free by design: config is the model's own leash
        // (disabledTools, baseUrl, tokenEnv, plugin roots) and the assistant reads
        // other people's text, so the person owns the values and the model sees only
        // the structure. `configLocalPath` points a test at a temp file.
        const key = String(args.key ?? '').trim();
        const cfg = loadConfig(ctx.configLocalPath ? { localPath: ctx.configLocalPath } : undefined);
        const rows: string[] = [];
        const leaf = (path: string, node: unknown) => {
          const top = path.split('.')[0]!;
          const state = getDeep(cfg, path) == null ? 'unset' : 'set';
          // The note of the key itself, else of the nearest parent that has one
          // (`ai.images.enabled` → `ai.images`), else of its top-level section.
          const parents = path.split('.').map((_, i, all) => all.slice(0, all.length - i).join('.'));
          const dflt = parents.map((p) => KEY_DEFAULTS[p]).find(Boolean) ?? KEY_DEFAULTS[top];
          const note = state === 'unset' && dflt ? ` (default: ${dflt})` : '';
          rows.push(`- ${path}: ${describeSchema(node)} — ${state}${note}`);
        };
        const walk = (path: string, node: unknown) => {
          const shape = unwrapNode(node)?.shape as Record<string, unknown> | undefined;
          if (shape && Object.keys(shape).length) for (const k of Object.keys(shape)) walk(path ? `${path}.${k}` : k, shape[k]);
          else if (path) leaf(path, node);
        };
        const roots: [string, unknown][] = [];
        const hostShape = (unwrapNode(hostConfigSchema)?.shape ?? {}) as Record<string, unknown>;
        for (const k of Object.keys(hostShape)) if (k !== 'plugins') roots.push([k, hostShape[k]]);
        for (const name of Object.keys(pluginConfigs ?? {})) roots.push([`plugins.${name}`, pluginConfigs![name]]);
        const wanted = roots.filter(([path]) => !key || path === key || path.startsWith(`${key}.`) || key.startsWith(`${path}.`));
        if (key && !wanted.length) return `config_schema: unknown key ${key}`;
        for (const [path, node] of wanted) {
          if (key && key.startsWith(`${path}.`)) {
            const sub = schemaAt(key, pluginConfigs);
            if (!sub) return `config_schema: unknown key ${key}`;
            walk(key, sub);
          } else walk(path, node);
        }
        if (resolvedKeys && (!key || key === 'keys' || key.startsWith('keys.'))) {
          rows.push(`Effective key bindings (host defaults + plugin keys; \`keys\` is an override map): ${prettyKeys(resolvedKeys)}`);
        }
        rows.push('You cannot read values or write config. To change something, give the person the exact command: config set <key> <value> (config unset <key> to clear).');
        return rows.join('\n');
      }
      case 'datetime': {
        // Current date/time in the requested zone (or the host local one). LLMs
        // do not reliably know "now", so this grounds time-sensitive answers.
        const zone = String(args.zone ?? '').trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
        return describeDatetime(zone);
      }
      case 'remind': {
        // A timed reminder: parse the delay, then delegate to the host's
        // setReminder service (which owns the timer + banner/log delivery). The
        // tool is a thin parser — the host runtime does the scheduling, so it
        // stays alive across the agent turn and fires even on later re-renders.
        // Banner-only: a reminder cannot run a host action (that scope is the
        // `background` tool, which offloads work and reports the result).
        const text = String(args.text ?? '').trim();
        if (!text) return 'text is required — the reminder content to fire.';
        const parsed = parseReminderMs(String(args.in ?? ''), String(args.at ?? ''));
        if ('error' in parsed) return parsed.error;
        const set = (ctx as { setReminder?: (text: string, ms: number) => void }).setReminder;
        if (typeof set !== 'function') return 'Reminder unavailable: no reminder service (the host must be interactive).';
        set(text, parsed.ms);
        return `Reminder set: "${text}" in ${Math.round(parsed.ms / 1000)}s — a banner will pop here (Esc dismisses).`;
      }
      case 'background': {
        // Offload a self-contained task to a DETACHED agent run: parse the task,
        // schedule a nested agentChat (via ctx.chatLLM — the same agent loop with
        // tool access) that runs autonomously, and deliver the result when it
        // completes. The tool returns immediately, so the chat stays usable while
        // the task works. Read-only by default (confirmWrite declines writes): an
        // autonomous task has no human to answer a y/n, and a hidden write is a
        // side effect — so writes are declined, not silently applied.
        const task = String(args.task ?? '').trim();
        if (!task) return 'task is required — the work to do in the background.';
        const label = String(args.label ?? '').trim() || task.slice(0, 40);
        // Start delay: `in`/`at` (like remind), or immediately when neither is given.
        let ms = 0;
        const inStr = String(args.in ?? '').trim();
        const atStr = String(args.at ?? '').trim();
        if (inStr || atStr) {
          const parsed = parseReminderMs(inStr, atStr);
          if ('error' in parsed) return parsed.error;
          ms = parsed.ms;
        }
        const chatLLM = (ctx as { chatLLM?: (messages: unknown[], opts: Record<string, unknown>) => Promise<{ content?: string }> }).chatLLM;
        if (typeof chatLLM !== 'function') return 'Background tasks unavailable: no LLM service (the host must be interactive).';
        // Chaining depth: a background task may spawn follow-up background tasks
        // (the nested agent has `background` in its tool set and it is read-only,
        // so it is always allowed). But a chain must not recurse forever — cap how
        // deep it may go. `_bgDepth` is threaded through toolCtx by the caller.
        const depth = Number((ctx as { _bgDepth?: number })._bgDepth ?? 0);
        if (depth >= MAX_BG_DEPTH) return `Background chaining depth exceeded (max ${MAX_BG_DEPTH}) — finish this task; do not spawn further background tasks.`;
        // A focused one-shot agent: autonomous, tool-using, returns a concise result.
        // Grounding rule: the agent is FRESH (no conversation context), so a time/date
        // question is answered from stale or absent memory unless it calls `datetime`.
        // Demand the tool for anything "now"-sensitive — that is what makes the result
        // the ACTUAL time at fire-time, not a guess.
        const prompt = 'You are a background worker. Complete the task below autonomously using the available tools, then return ONLY a concise result (a few sentences). Do not ask questions or wait for the user — act. You may spawn a follow-up `background` task if the work needs a further step (e.g. "build, then fix and rebuild on failure"), but keep the chain at most ONE level and only if it is genuinely needed. IMPORTANT: if the task asks for the current time, date, weekday, or a relative duration, you MUST call the `datetime` tool to get it (never answer from memory — it will be stale).\n\nTask: ' + task;
        const extraTools = (ctx as { pluginAiTools?: ToolDef[] }).pluginAiTools ?? [];
        // Spread the live toolCtx so the nested run's tools resolve config, memory
        // plugin scope, and host services the same way the chat's do. Thread the
        // chain depth so a follow-up background task knows how deep it is.
        // …minus `askUser`: a background task runs while the person is doing something
        // else, and a question popping up would seize every key mid-sentence. With
        // no hook, `ask_user` answers "nobody to ask" and the task proceeds on a
        // stated assumption.
        // A background run is a conversation of its own: it plans on its own plan and
        // never touches the checkboxes of the chat that started it.
        // Its shell directory is its own too, starting at the default: whatever it runs
        // (and run_command is declined there anyway) never moves the chat's.
        // So are its loaded tools: it is given no `toolSet`, so it starts from the index
        // and loads what it needs, and nothing it loads reaches the chat's set.
        const bgConfig = ((ctx as { config?: Record<string, unknown> }).config ?? {}) as Record<string, unknown>;
        const toolCtx = { ...(ctx as Record<string, unknown>), _bgDepth: depth + 1, askUser: undefined, plan: createPlan(), shell: createShellState(() => bgConfig) };
        // The nested run needs its OWN LLM credentials — the same way the chat's
        // send() derives them (`llmOpts(ai)`: the provider, base URL, model, token).
        // `ctx` is the chat's toolCtx (config + host services), so read ai.* from it;
        // without these agentChat throws "LLM_TOKEN is not set" and the task fails
        // even though the chat itself authenticates fine.
        const ai = ((ctx as { config?: { ai?: Record<string, unknown> } }).config?.ai ?? {}) as Record<string, unknown>;
        // Count the task as in-flight from the moment it is ARMED (its delay starts),
        // so the chat's «N in background» indicator reflects a scheduled-but-not-yet-firing
        // task too — and re-render NOW so the count appears during the wait.
        bgActive++;
        (ctx as { notify?: () => void }).notify?.();
        setTimeout(() => {
          void runBg(async () => {
            try {
              // Text only: a background task never gets images. It has no person to have
              // attached one, and the model's own words cannot make the host read a file
              // as an image.
              const res = await chatLLM(
                [{ role: 'system', content: prompt }, { role: 'user', content: task }],
                { extraTools: extraTools as ToolDef[], toolCtx, maxRounds: 12, confirmWrite: () => false,
                  ...llmOpts(ai) },
              );
              const result = String(res?.content ?? '').trim() || '(no output)';
              (ctx as { showMessage?: (m: string) => void }).showMessage?.(`⏳ ${label} done`);
              (ctx as { pushLog?: (e: string) => void }).pushLog?.(`[bg] ${label}: ${result}`);
              // Return the result to the chat too (the assistant registers `postToChat`):
              // it opens the chat and, when idle, feeds the result through `send`, so the
              // assistant analyzes it in the conversation rather than only toasting it.
              // The `Background` role label (render) already marks it as a background
              // result, so the text itself does NOT repeat the "[background]" prefix.
              (ctx as { postToChat?: (t: string) => void }).postToChat?.(`${label} finished:\n${result}`);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              (ctx as { showMessage?: (m: string) => void }).showMessage?.(`⚠ ${label} failed: ${msg}`);
              (ctx as { pushLog?: (e: string) => void }).pushLog?.(`[bg] ${label} error: ${msg}`);
              (ctx as { postToChat?: (t: string) => void }).postToChat?.(`${label} failed:\n${msg}`);
            } finally {
              bgActive--;
              (ctx as { notify?: () => void }).notify?.();
            }
          });
        }, ms);
        return `Background task started (${label}) — will report when done${ms ? ` in ${Math.round(ms / 1000)}s` : ''}.`;
      }
      case 'todo': {
        // Not write-confirmed (like memory): a y/n pause on every `todo add` would
        // make the plan unusable, and it is a low-stakes reversible scratchpad. Every
        // change calls ctx.notify() so the chat redraws the block.
        const c = ctx as { plan?: Plan; notify?: () => void };
        return (c.plan ?? processPlan).exec(args, c.notify);
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  },
});

export default coreTools;