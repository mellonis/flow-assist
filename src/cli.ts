#!/usr/bin/env bun
// CLI entry point. Classifies argv into a subcommand (`parseCli`), then `main`
// dispatches: no args → interactive TUI (`renderApp`), `config …` → the config
// subcommand (get/set/unset/help on the host schema), `plugins ls|install|remove|update`
// → the plugin repo, any other argv → a one-shot `<prompt>` chat via `agentChat`,
// and `--help`/`--version`.
//
// This is the program entrypoint for the `bin` (`./dist/cli.js`). All of the
// heavy lifting (config, plugins, registry, TUI, agent) is consumed from the
// already-built modules; here we only wire them together and translate argv.

import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { TtyBackend } from '@flowtty/tty-backend';
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
import { fetchPluginFromRegistry } from './loader/registry-download.js';
import type { PluginRepo } from './loader/repo.js';
import type { PluginRepo as RepoShape } from './loader/host-group.js';
import { loadPlugins } from './loader/build.js';
import { assembleToolRegistry } from './loader/tools.js';
import { renderApp } from './runtime/app.js';
import { agentChat } from './assistant/agent.js';
import { createLogService } from './runtime/services/log.js';
import { createServices } from './runtime/services.js';
import { hostVersion } from './version.js';
import { renderChatModal, renderHelp, renderLogModal, renderReminder } from './views/modals.js';
import { purgePluginMemories } from './runtime/services/memory.js';

// The built-in modal renderers (Task #20). The host is tracker-agnostic: these
// are the surfaces for the built-in chat/help/log modals, handed to plugins as
// a `renders` bundle so core.ts reads viewRegistry.help, log.ts viewRegistry.log
// and assistant.ts viewRegistry.chat. Without them the modals collapse to the
// NOOP_VIEW placeholder and render blank.
const renders = { chat: renderChatModal, help: renderHelp, log: renderLogModal, reminder: renderReminder };

// The project root is one directory up from this file (`src/cli.ts` → the repo
// root; `dist/cli.js` → the same root). The plugin sources live in
// `plugins-available/` (git-tracked) and the ACTIVE set is exposed through
// `plugins-enabled/` (a symlink dir). Registry downloads are wired to the real
// fetcher (`fetchPluginFromRegistry`): when a source is absent locally,
// `plugins install/update` fetch it from a GitLab Generic Packages Registry,
// which needs a DA_PLUGIN_REGISTRY_TOKEN (read-only). If the token is unset, the repo falls
// back to "not available locally" cleanly.
//
// Robustness guard: when the entry is bundle-wrapped the runtime dirname may
// contain `bunfs` (the virtual filesystem), or the plugin dirs may simply not
// exist next to the entry. In either case fall back to `process.cwd()` so the
// plugin dirs resolve to a real, writable location.
const candidateRoot = resolve(import.meta.dirname, '..');
const candidateAvailable = join(candidateRoot, 'plugins-available');
const candidateEnabled = join(candidateRoot, 'plugins-enabled');
const projectRoot =
  import.meta.dirname.includes('bunfs') || !(existsSync(candidateAvailable) && existsSync(candidateEnabled))
    ? process.cwd()
    : candidateRoot;
const availableDir = join(projectRoot, 'plugins-available');
const enabledDir = join(projectRoot, 'plugins-enabled');
// The registry fetcher reads env defaults at construction (DA_PLUGIN_REGISTRY_URL /
// DA_PLUGIN_REGISTRY_PROJECT / DA_PLUGIN_REGISTRY_TOKEN) so the CLI still runs `plugins ls`
// without a token; a missing token only surfaces as an error at download time.
const fetchPlugin = fetchPluginFromRegistry({
  baseUrl: process.env.DA_PLUGIN_REGISTRY_URL,
  projectId: process.env.DA_PLUGIN_REGISTRY_PROJECT,
  token: process.env.DA_PLUGIN_REGISTRY_TOKEN ?? process.env.GITLAB_TOKEN,
  availableDir,
});

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
      await runConfig(parsed.args, config);
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
async function runConfig(args: string[], config: Record<string, unknown>): Promise<void> {
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
    const check = validateConfigWriteValue(hostConfigSchema, key, parsed);
    if (!check.ok) {
      console.log(check.error);
      process.exitCode = 1;
      return;
    }
    saveConfigSetting(key, check.value);
    console.log(JSON.stringify(check.value));
    return;
  }

  if (sub === 'unset' && key) {
    saveConfigUnset(key);
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
      const source = e.source === 'registry' ? ' (registry)' : '';
      const missing = e.missingDeps.length ? `  missing: ${e.missingDeps.join(',')}` : '';
      const settingMiss = e.missingSettings?.length ? `  missing settings: ${e.missingSettings.join(',')}` : '';
      console.log(`${e.name}  v${e.version || '-'}  [${state}]${source}${missing}${settingMiss}`);
    }
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

  // Plugin ai-tools live in the assembled registry as synthetic groups whose id
  // ends with `:aiTools` — collect their tools for the agent's extraTools.
  const aiTools = registry.groups.filter((g) => g.id.endsWith(':aiTools')).flatMap((g) => g.tools);

  // The one-shot prompt has no TUI, so build the host services (real openBrowser,
  // cache, log, memory) and pass them as toolCtx. An ai-tool's run already fuses
  // the owning plugin's services; host services here supply the REAL primitives
  // (open_browser spawns `open`, not a tracker no-op stub) that one-shot lacks.
  const services = createServices({ config, tools: registry, repo, onExit: () => {} });

  const result = await agentChat([{ role: 'user', content: prompt }], {
    baseUrl: ai.baseUrl as string | undefined,
    model: ai.model as string | undefined,
    token: process.env[(ai.tokenEnv as string | undefined) ?? 'LLM_TOKEN'],
    extraTools: aiTools,
    toolCtx: services as never,
    logToolRun: log.logToolRun,
    onLive: (delta: string) => process.stdout.write(delta),
  });
  process.stdout.write('\n' + result.content + '\n');
}

// ─── interactive TUI ──────────────────────────────────────────────────────────
async function runInteractive(config: Record<string, unknown>, repo: PluginRepo): Promise<void> {
  const plugins = await loadPlugins({ config, repo, renders, enabledDir });
  const registry = assembleToolRegistry({ plugins, config, repo: repo as unknown as RepoShape });
  const backend = new TtyBackend();

  let handle: { unmount(): void } | undefined;
  const onExit = () => {
    handle?.unmount();
    backend.dispose?.();
    process.exit(0);
  };
  handle = await renderApp(backend, { plugins, config, renders: {}, tools: registry, onExit });
}

// ─── help text ────────────────────────────────────────────────────────────────
function printUsage(): void {
  console.log(
    [
      'developer-assistant',
      '',
      'Usage:',
      '  developer-assistant                       Start the interactive TUI',
      '  developer-assistant config <cmd> ...      get|set|unset|help on host config',
      '  developer-assistant plugins <cmd> ...     ls|install|remove|update plugins',
      '  developer-assistant <prompt>              One-shot chat with the loaded tool registry',
      '  developer-assistant --help                Show this help',
      '  developer-assistant --version             Show the host version',
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
      '  plugins remove <name>     Remove a plugin (unlink from plugins-enabled)',
      '  plugins update [name]     Re-fetch registry-managed plugins',
    ].join('\n'),
  );
}

// Only run when this module is the program entrypoint (the bin), not when a test
// imports `parseCli`.
if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}