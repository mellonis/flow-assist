// Host services container. `createServices` wires the generic host services into
// a single `HostServices` object that plugins read via `ft.services`. The generic
// slice (cache/log/memory/config/chatLLM/compactChat/openBrowser/copyToClipboard)
// is initialized here, BEFORE plugins load; the React-bound slice
// (showMessage/pushLog/notify/logs/view) is bound by the App on every render
// (they need the render loop) — see app.tsx.

import { spawn } from 'node:child_process';
import { createCacheService } from './services/cache.js';
import { createLogService } from './services/log.js';
import { loadMemories, saveMemories, memoryFilePath } from './services/memory.js';
import { agentChat } from '../assistant/agent.js';
import { copyToClipboard as platformCopy } from '../assistant/copy.js';
import { toolLoadingMode } from '../assistant/tool-loading.js';
import { llmOpts } from '../assistant/llm-endpoint.js';
import type { AgentResult, AgentOpts, ChatMessage, ToolLogger } from '../assistant/agent.js';
import type { AiToolDef, ToolRegistry } from '../loader/tools.js';
import type { PluginRepo } from '../loader/repo.js';
import type { CacheService } from './services/cache.js';
import type { LogService } from './services/log.js';
import type { Memory } from './services/memory.js';
import type { ViewRenderers } from '../assistant/views.js';
import type { ContextItem } from '../assistant/screen-context.js';

// The assistant memory: a plugin reads/updates the memory file. `filePath` is
// resolved from config.memory.file (default under the host config dir).
export interface MemoryService {
  load(): Memory[];
  save(list: Memory[]): void;
  filePath(): string;
}

// The service bundle handed to plugins as `ft.services`. The React-bound members
// (showMessage/pushLog/notify/logs/view) are mutable — the App reassigns them
// each render so they stay fresh; the rest is stable.
export interface HostServices {
  cache: CacheService;
  log: LogService;
  memory: MemoryService;
  config: Record<string, unknown>;
  chatLLM: (messages: ChatMessage[], opts?: AgentOpts & Record<string, unknown>) => Promise<AgentResult>;
  pluginAiTools: AiToolDef[];
  openBrowser: (url: string) => void;
  copyToClipboard: (text: string) => void;
  // The image on the system clipboard, written to a private temporary file (the chat's
  // `/image`, Ctrl+V, an empty paste). Bound by `renderApp`; a test passes a fake.
  clipboardImage?: () => import('../assistant/images.js').ClipboardImage;
  showMessage: (msg: string) => void;
  onExit: () => void;
  clearCache: () => void;
  // Counts cache flushes. A flush empties the cache but changes nothing on screen — the
  // board and the issue that are open keep showing what they loaded — so `x` looked
  // like it did nothing. A plugin that draws cached data watches this number
  // (`useEffect(..., [ft.services.cacheEpoch])`) and reloads what it is showing.
  cacheEpoch: number;
  pushLog: (entry: string) => void;
  notify: () => void;
  logs: string[];
  // Schedules a timed reminder that fires in the TUI after `ms` milliseconds: it
  // presents the reminder as a centered top-most banner (`showReminder`) plus a
  // log entry. The delivery reads the LIVE React-bound channels at fire time (they
  // are reassigned each render), so a reminder still lands if the App re-rendered
  // after it was scheduled.
  setReminder: (text: string, ms: number) => void;
  // The reminder currently shown (the core plugin's `reminder` component reads
  // this — null/undefined means none is showing). Set by `showReminder`, cleared
  // by `dismissReminder` (bound by the App; the component's Esc/Enter handler
  // calls it).
  reminder: string | null;
  showReminder: (text: string) => void;
  dismissReminder: () => void;
  // Gets the person's attention when they may not be looking: a desktop
  // notification, or the terminal bell where none reaches the terminal (flowtty's
  // `notify` decides, and rings at most once a second). The App binds it; the
  // default is a no-op. Used by a fired reminder and by a background result that
  // lands while the chat is closed.
  alert: (title: string, body?: string) => void;
  // Puts text on the person's clipboard and says whether it got there: the terminal's
  // own clipboard sequence (OSC 52, through flowtty) where one went out, else the
  // platform's tool (`copyToClipboard` in assistant/copy.ts — pbcopy, wl-copy, xclip,
  // xsel). Apple Terminal has no OSC 52, so there it is always the tool. The App binds
  // it; the default, with no terminal at all, goes straight to the tool.
  copy: (text: string) => { ok: true } | { ok: false; error: string };
  // Opens a plugin surface as a favored overlay: the value names the surface
  // (plugin-defined), and while set the input race gives that surface the key.
  // The default is a no-op; the App rebinds it (app.tsx) so it mutates the shared
  // `ui.overlay` and re-renders. Generic — the tracker uses it for its detail view.
  setOverlay: (overlay: string | null) => void;
  // What an armed Ctrl+C / Ctrl+D / Ctrl+Z says (`^c again to exit`), '' when none is
  // armed. The App owns the arm (src/runtime/exit-keys.ts); the chat draws it on its
  // status line, the App on the bottom row of every other screen.
  armedHint: string;
  // The chat's side of two plugin hooks (`chatContext` / `afterWrite` in the plugin
  // shape): what the person's screens show now — every plugin's items, in load order,
  // sanitized and capped (src/assistant/screen-context.ts; a plugin with only the
  // deprecated `chatSubject` gives one item) — and "a write was applied, reload what
  // you show", sent to every plugin. The App binds both over the mounted plugins; the
  // defaults answer nothing and do nothing.
  chatContext: () => ContextItem[];
  afterWrite: () => Promise<void>;
  // Every view renderer the chat can draw a tool's block with: the host's own
  // `console` plus each plugin's, qualified `<plugin>:<kind>` (src/loader/registry.ts).
  // Bound by the App from the mounted plugins; absent means only `console` renders.
  viewRenderers?: ViewRenderers;
}

export interface CreateServicesOptions {
  config: Record<string, unknown>;
  tools?: ToolRegistry;
  repo?: PluginRepo;
  onExit: () => void;
}

// Opens a URL in the system browser (the generic primitive). The tracker builds
// `issueUrl(target)`; the host only opens. `spawn` is detached + unref'd so the
// TUI is not tied to the browser process.
export function openInBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

// Copies text to the system clipboard. Best-effort: a failure (no clipboard
// tool) is silently ignored so it never breaks the host. The tracker keeps its
// own copyToClipboard too; the host exposes it as a generic primitive.
export function copyToClipboard(text: string): void {
  try {
    const proc = process.platform === 'darwin'
      ? spawn('pbcopy')
      : process.platform === 'win32'
        ? spawn('clip')
        : spawn('xclip', ['-selection', 'clipboard']);
    proc.stdin.write(text);
    proc.stdin.end();
  } catch {
    // Clipboard is a nice-to-have; a failure must not throw.
  }
}

// Assembles the HostServices container. The generic slice is fully wired here;
// the React-bound slice (showMessage/pushLog/notify/logs/view) defaults to
// no-ops/stubs and is rebound by the App on every render. `tools` (the assembled
// ToolRegistry) is the source of plugin ai-tools: the synthetic
// `<plugin>:aiTools` groups carry the run-bearing defs the agent loop needs as
// `extraTools`. `repo` is accepted (the registry already owns it) but is not
// consumed directly.
export function createServices({ config, tools, repo, onExit }: CreateServicesOptions): HostServices {
  const cache = createCacheService(config);
  const log = createLogService(config);
  const memory: MemoryService = {
    load: () => loadMemories(memoryFilePath(config)),
    save: (list) => saveMemories(list, memoryFilePath(config)),
    filePath: () => memoryFilePath(config),
  };
  const pluginAiTools = (tools?.groups ?? [])
    .filter((g) => g.id.endsWith(':aiTools'))
    .flatMap((g) => g.tools as AiToolDef[]);

  const services: HostServices = {
    cache,
    log,
    memory,
    config,
    // `logToolRun` is wired from the log service so config.debug.logTools
    // (which `log.logToolRun` gates on) actually logs tool calls — the agent's
    // no-op default would otherwise leave it inert. A caller-supplied
    // `logToolRun` wins over ours.
    // `ai.toolLoading` is applied here, once, for the chat and a background task alike;
    // a caller that names a mode keeps it. So is the endpoint (`llmOpts`: the provider,
    // base URL, model, token): a plugin that passes only some of it still reaches the
    // model the person configured, on the wire they chose.
    chatLLM: (messages, opts) => agentChat(messages, {
      toolLoading: toolLoadingMode(config.ai),
      ...llmOpts(config.ai),
      ...opts,
      logToolRun: (opts?.logToolRun as ToolLogger | undefined) ?? log.logToolRun,
    }),
    pluginAiTools,
    openBrowser: openInBrowser,
    copyToClipboard,
    showMessage: () => {},
    onExit,
    clearCache: () => { cache.clear(); services.cacheEpoch += 1; },
    cacheEpoch: 0,
    pushLog: () => {},
    notify: () => {},
    logs: log.read(),
    setReminder: () => {},
    reminder: null,
    showReminder: () => {},
    dismissReminder: () => {},
    alert: () => {},
    copy: (text) => platformCopy(text),
    setOverlay: () => {},
    armedHint: '',
    chatContext: () => [],
    afterWrite: async () => {},
  };
  // Read the LIVE channels at fire time (the App reassigns showMessage/pushLog/
  // notify each render), so the reminder is delivered even if a render happened
  // after scheduling. setTimeout keeps the host alive for it — the interactive
  // TUI is long-running; a one-shot CLI exits before it fires. The banner is the
  // visual (the core `reminder` component reads services.reminder); the log line
  // keeps the audit trail.
  services.setReminder = (text, ms) => {
    setTimeout(() => {
      services.showReminder(text);
      services.pushLog(`⏰ Reminder: ${text}`);
      services.alert('⏰ Reminder', text);
    }, ms);
  };
  return services;
}