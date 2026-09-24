// The CLI. Classifies argv into a subcommand (`parseCli`), then `main`
// dispatches: no args → interactive TUI (`renderApp`), `config …` → the config
// subcommand (get/set/unset/help on the host schema), `plugins ls|install|remove|update`
// → the plugin repo, any other argv → a one-shot `<prompt>` chat via `agentChat`,
// and `--help`/`--version`.
//
// The program's entry point is `cli.ts`, which sets NODE_ENV before importing this
// module (see there); this one is never run directly, so a test imports its pure
// helpers without starting anything. The heavy lifting (config, plugins, registry,
// TUI, agent) lives in the modules below; here they are only wired together.

// First, before any module that reads the environment as it loads: where this
// installation lives, and its `.env` (see install.ts).
import { projectRoot, availableDir, enabledDir } from './install.js';
import { existsSync } from 'node:fs';
import { TtyBackend, isInteractive } from '@flowtty/tty-backend';
import { loadConfig } from './config/load.js';
import { hostConfigSchema } from './config/schema.js';
import {
  getDeep,
  parseValue,
  validateConfigWriteValue,
  saveConfigSetting,
  saveConfigUnset,
  configWarnings,
} from './config/load.js';
import { createPluginRepo } from './loader/repo.js';
import { noPluginsNote } from './loader/install-root.js';
import { fetchPluginFromRegistry } from './loader/registry-download.js';
import { installPluginArchive, isArchiveSource } from './loader/archive-install.js';
import type { PluginRepo } from './loader/repo.js';
import type { PluginRepo as RepoShape } from './loader/host-group.js';
import { loadPlugins } from './loader/build.js';
import { assembleToolRegistry, pluginConfigs } from './loader/tools.js';
import { renderApp } from './runtime/app.js';
import { consoleBridge } from './runtime/console-log.js';
import { agentChat } from './assistant/agent.js';
import { toolLoadingMode } from './assistant/tool-loading.js';
import { toolResultCapFromConfig } from './assistant/tool-result-cap.js';
import { llmOpts } from './assistant/llm-endpoint.js';
import { createLogService } from './runtime/services/log.js';
import { createServices } from './runtime/services.js';
import { hostVersion } from './version.js';
import { renderChatModal, renderHelp, renderLogModal, renderReminder } from './views/modals.js';
import { purgePluginMemories } from './runtime/services/memory.js';

// The built-in modal renderers. The host knows no domain: these
// are the surfaces for the built-in chat/help/log modals, handed to plugins as
// a `renders` bundle so core.ts reads viewRegistry.help, log.ts viewRegistry.log
// and assistant.ts viewRegistry.chat. Without them the modals collapse to the
// NOOP_VIEW placeholder and render blank.
const renders = { chat: renderChatModal, help: renderHelp, log: renderLogModal, reminder: renderReminder };

// The project root holds the plugin sources in `plugins-available/` and the ACTIVE
// set in `plugins-enabled/` (a symlink dir): a source checkout's root, else the
// directory the compiled binary is installed in, else the working directory — see
// `resolveInstallRoot`, settled in install.ts. Registry downloads are wired to the
// real fetcher (`fetchPluginFromRegistry`): when a source is absent locally, `plugins
// install/update` fetch it from a GitLab Generic Packages Registry, which needs a
// FLOW_ASSIST_PLUGIN_REGISTRY_TOKEN (read-only). If the token is unset, the repo falls
// back to "not available locally" cleanly.
//
// The registry fetcher reads env defaults at construction (FLOW_ASSIST_PLUGIN_REGISTRY_URL /
// FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT / FLOW_ASSIST_PLUGIN_REGISTRY_TOKEN) so the CLI still runs `plugins ls`
// without a token; a missing token only surfaces as an error at download time.
const fetchPlugin = fetchPluginFromRegistry({
  baseUrl: process.env.FLOW_ASSIST_PLUGIN_REGISTRY_URL,
  projectId: process.env.FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT,
  token: process.env.FLOW_ASSIST_PLUGIN_REGISTRY_TOKEN ?? process.env.GITLAB_TOKEN,
  availableDir,
});

// Where the host looked for plugins, when it found none; null when there are some.
async function missingPluginsNote(repo: PluginRepo): Promise<string | null> {
  return noPluginsNote(enabledDir, (await repo.enabledPlugins()).length, existsSync);
}

// The classified command. `prompt` keeps the full argv so `main` can join it into
// the user's prompt text; `config`/`plugins` keep the subcommand args.
export type ParseResult =
  | { cmd: 'interactive'; args: string[] }
  | { cmd: 'config'; args: string[] }
  | { cmd: 'plugins'; args: string[] }
  | { cmd: 'prompt'; args: string[] }
  | { cmd: 'help'; args: string[] }
  | { cmd: 'version'; args: string[] };

// Maps argv to a subcommand. Pure: no I/O, no config reads — easy to unit-test.
// A prompt is ANY argv that does not start with `config`/`plugins`/`--help`/
// `--version`; an empty argv starts the interactive TUI.
export function parseCli(argv: string[]): ParseResult {
  const args = argv ?? [];
  const first = (args[0] ?? '').toLowerCase();

  if (first === '--help' || first === '-h' || first === 'help') return { cmd: 'help', args };
  if (first === '--version' || first === '-v' || first === 'version') return { cmd: 'version', args };
  if (first === 'config') return { cmd: 'config', args: args.slice(1) };
  if (first === 'plugins') return { cmd: 'plugins', args: args.slice(1) };
  if (args.length === 0) return { cmd: 'interactive', args: [] };
  return { cmd: 'prompt', args };
}

// ─── main ─────────────────────────────────────────────────────────────────────
export async function main(argv: string[]): Promise<void> {
  const parsed = parseCli(argv);
  const config = loadConfig();
  const repo = createPluginRepo({ availableDir, enabledDir, projectRoot, fetchPlugin });

  switch (parsed.cmd) {
    case 'help':
      printUsage();
      return;
    case 'version':
      console.log(hostVersion());
      return;
    case 'config':
      await runConfig(parsed.args, config, repo);
      return;
    case 'plugins':
      await runPlugins(parsed.args, config, repo);
      return;
    case 'prompt':
      gateLlmConfig(config);
      await runPrompt(parsed.args, config, repo);
      return;
    case 'interactive':
      gateLlmConfig(config);
      await runInteractive(config, repo);
      return;
  }
}

// ─── config subcommand ────────────────────────────────────────────────────────
async function runConfig(args: string[], config: Record<string, unknown>, repo?: PluginRepo): Promise<void> {
  const sub = (args[0] ?? '').toLowerCase();
  const key = args[1];

  if (sub === 'get' && key) {
    const value = getDeep(config, key);
    if (value === undefined) console.log(`no key ${key}`);
    else console.log(JSON.stringify(value));
    return;
  }

  if (sub === 'set' && key && args.length >= 3) {
    const parsed = parseValue(args.slice(2).join(' '));
    // A plugin's key is validated by the plugin's own schema — so the plugins are loaded
    // (only for such a key: everything else needs none of them).
    const schemas = key.startsWith('plugins.') && repo ? pluginConfigs(await loadPlugins({ config, repo, renders, enabledDir })) : undefined;
    const check = validateConfigWriteValue(hostConfigSchema, key, parsed, schemas);
    if (!check.ok) {
      console.log(check.error);
      process.exitCode = 1;
      return;
    }
    // A value is only echoed once it is really on disk: a failed write used to
    // print the value just the same, which read as "saved".
    if (!saveConfigSetting(key, check.value)) {
      console.log(`config: could not write ${key} — check that the config directory is writable`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(check.value));
    return;
  }

  if (sub === 'unset' && key) {
    if (!saveConfigUnset(key)) {
      console.log(`config: could not unset ${key} — check that the config directory is writable`);
      process.exitCode = 1;
      return;
    }
    console.log(`config: unset ${key}`);
    return;
  }

  printConfigHelp();
}

// ─── plugins subcommand ───────────────────────────────────────────────────────
async function runPlugins(args: string[], config: Record<string, unknown>, repo: PluginRepo): Promise<void> {
  const sub = (args[0] ?? '').toLowerCase();
  const name = args[1];

  if (sub === 'ls' || sub === 'list') {
    const entries = await repo.list();
    for (const e of entries) {
      const state = e.active ? 'active' : 'inactive';
      const source = e.source === 'registry' || e.source === 'archive' || e.source === 'linked' ? ` (${e.source})` : '';
      const missing = e.missingDeps.length ? `  missing: ${e.missingDeps.join(',')}` : '';
      const settingMiss = e.missingSettings?.length ? `  missing settings: ${e.missingSettings.join(',')}` : '';
      const incompatible = e.incompatible ? `  ${e.incompatible}` : '';
      console.log(`${e.name}  v${e.version || '-'}  [${state}]${source}${incompatible}${missing}${settingMiss}`);
    }
    const note = await missingPluginsNote(repo);
    if (note) console.log(note);
    return;
  }

  // An archive (a .tar.gz path or an https URL) is unpacked into plugins-available/
  // and enabled; a name is linked from there or fetched from the registry.
  if (sub === 'install' && name && isArchiveSource(name)) {
    const res = await installPluginArchive(name, { availableDir, enabledDir });
    const replacedNote = res.replaced ? (res.previousVersion ? `replaced (was v${res.previousVersion})` : 'replaced') : 'installed';
    console.log(res.ok
      ? `plugin '${res.name}'${res.version ? ` v${res.version}` : ''} ${replacedNote} — restart the assistant for the change to take effect`
      : `plugins install: ${res.error}`);
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === 'install' && name) {
    const res = await repo.install(name);
    console.log(res.ok ? `plugin '${name}' installed — restart the assistant for the change to take effect` : res.error);
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === 'remove' && name) {
    const res = await repo.remove(name);
    // On a successful uninstall, purge the plugin's memory (its `plugin`-scope facts)
    // so they don't linger after the plugin is gone.
    if (res.ok) purgePluginMemories(config, name);
    console.log(res.ok ? `plugin '${name}' removed — restart the assistant for the change to take effect` : res.error);
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === 'update') {
    const res = await repo.update(name);
    console.log(res.ok ? (name ? `plugin '${name}' updated — restart the assistant for the change to take effect` : 'plugins updated — restart the assistant for the change to take effect') : res.error);
    if (!res.ok) process.exitCode = 1;
    return;
  }

  printPluginsHelp();
}

// ─── LLM config gate ──────────────────────────────────────────────────────────
// Hard gate for LLM-facing subcommands (interactive TUI, one-shot prompt): if the
// config is invalid or the LLM is not fully configured, print every warning and
// refuse to start (exit 1). A soft warning alone would let the TUI boot, render,
// and only fail mid-chat — the user prefers to fail fast at startup. `config` and
// `plugins` subcommands do NOT need the LLM, so they are never gated here.
function gateLlmConfig(config: Record<string, unknown>): void {
  const warnings = configWarnings(config);
  if (!warnings.length) return;
  for (const w of warnings) console.error(w);
  console.error('config: refusing to start — set the config above (e.g. `config set ai.baseUrl <url>`), then retry.');
  process.exit(1);
}

// ─── one-shot prompt ──────────────────────────────────────────────────────────
async function runPrompt(args: string[], config: Record<string, unknown>, repo: PluginRepo): Promise<void> {
  const prompt = args.join(' ');
  const ai = (config.ai ?? {}) as Record<string, unknown>;
  const plugins = await loadPlugins({ config, repo, renders, enabledDir });
  const registry = assembleToolRegistry({ plugins, config, repo: repo as unknown as RepoShape });
  const log = createLogService(config);
  // On stderr, so an answer piped elsewhere stays clean.
  const note = await missingPluginsNote(repo);
  if (note) console.error(`[plugins] ${note}`);

  // Plugin ai-tools live in the assembled registry as synthetic groups whose id
  // ends with `:aiTools` — collect their tools for the agent's extraTools.
  const aiTools = registry.groups.filter((g) => g.id.endsWith(':aiTools')).flatMap((g) => g.tools);

  // The one-shot prompt has no TUI, so build the host services (real openBrowser,
  // cache, log, memory) and pass them as toolCtx. An ai-tool's run already fuses
  // the owning plugin's services; host services here supply the REAL primitives
  // (open_browser spawns `open`, not a tracker no-op stub) that one-shot lacks.
  const services = createServices({ config, tools: registry, repo, onExit: () => {} });

  const result = await agentChat([{ role: 'user', content: prompt }], {
    ...llmOpts(ai),
    extraTools: aiTools,
    toolLoading: toolLoadingMode(ai),
    toolResultMaxChars: toolResultCapFromConfig(ai),
    toolCtx: services as never,
    logToolRun: log.logToolRun,
    onLive: (delta: string) => process.stdout.write(delta),
  });
  process.stdout.write('\n' + result.content + '\n');
}

// ─── interactive TUI ──────────────────────────────────────────────────────────
// Whether the terminal reports the mouse to the app — the wheel, and the drag that
// selects and copies (flowtty's copy-on-select, wired in runtime/app.tsx). On unless
// `ui.mouse` is explicitly false: some people will rather have the terminal's own
// selection back.
export function mouseEnabled(config: Record<string, unknown>): boolean {
  return (config.ui as { mouse?: unknown } | undefined)?.mouse !== false;
}

// The TUI needs a terminal on BOTH ends: it draws on stdout and reads keys from
// stdin. Started in a pipe, in CI or with its input redirected, it used to write
// escape codes into the pipe (and, with stdin piped, quit at once with nothing said);
// flowtty ≥ 1.0.0-alpha.12 throws instead. Either way the person deserves a sentence
// and the way that does work without a terminal.
export function interactiveRefusal(stdout: { isTTY?: boolean }, stdin: { isTTY?: boolean }, interactive = isInteractive): string | null {
  if (interactive(stdout as never) && stdin.isTTY) return null;
  return [
    'flow-assist: the interactive screen needs a terminal (stdin and stdout).',
    'Without one, ask in one shot:  flow-assist "your question"',
    'Config and plugins work anywhere:  flow-assist config get <key> · flow-assist plugins ls',
  ].join('\n');
}

async function runInteractive(config: Record<string, unknown>, repo: PluginRepo): Promise<void> {
  const refusal = interactiveRefusal(process.stdout, process.stdin);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
  // What the loader skipped, and why, goes into the app's log too.
  const loadNotes: string[] = [];
  const plugins = await loadPlugins({ config, repo, renders, enabledDir, notes: loadNotes });
  const registry = assembleToolRegistry({ plugins, config, repo: repo as unknown as RepoShape });
  // The backend holds the console while it owns the screen; with `onConsole` set every
  // line goes to the log (`L`) at once and nothing is printed again at exit.
  const consoleLog = consoleBridge();
  const backend = new TtyBackend(process.stdout, process.stdin, { mouse: mouseEnabled(config), onConsole: consoleLog.onConsole });

  let handle: { unmount(): void } | undefined;
  const onExit = () => {
    handle?.unmount();
    backend.dispose?.();
    process.exit(0);
  };
  const pluginsNote = await missingPluginsNote(repo);
  handle = await renderApp(backend, { plugins, config, renders: {}, tools: registry, onExit, pluginsNote: pluginsNote ?? undefined, loadNotes, consoleLog });
}

// ─── help text ────────────────────────────────────────────────────────────────
function printUsage(): void {
  console.log(
    [
      'flow-assist',
      '',
      'Usage:',
      '  flow-assist                       Start the interactive TUI',
      '  flow-assist config <cmd> ...      get|set|unset|help on host config',
      '  flow-assist plugins <cmd> ...     ls|install|remove|update plugins',
      '  flow-assist <prompt>              One-shot chat with the loaded tool registry',
      '  flow-assist --help                Show this help',
      '  flow-assist --version             Show the host version',
    ].join('\n'),
  );
}

function printConfigHelp(): void {
  console.log(
    [
      'config subcommands:',
      '  config get <key>            Print the value at a dot path (or "no key <key>")',
      '  config set <key> <value>    Set a value (validated against the host schema)',
      '  config unset <key>          Remove a key from config.local.json',
      '  config help                 Show this help',
      '',
      'Example keys: ai.model, ai.baseUrl, cache.enabled, debug.logTools, memory.file',
    ].join('\n'),
  );
}

function printPluginsHelp(): void {
  console.log(
    [
      'plugins subcommands:',
      '  plugins ls                List available plugins',
      '  plugins install <name>    Install a plugin (symlink from plugins-available)',
      '  plugins install <file>    Install a plugin archive (.tar.gz, a path or an https URL)',
      '  plugins remove <name>     Remove a plugin (unlink from plugins-enabled)',
      '  plugins update [name]     Re-fetch registry-managed plugins (an archive: install the newer one)',
    ].join('\n'),
  );
}
