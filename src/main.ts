// The CLI. Classifies argv into a subcommand (`parseCli`), then `main` dispatches: no
// args → interactive TUI (`renderApp`), `config …` → the config subcommand
// (get/set/unset/help on the host schema), `plugins ls|install|trust|remove|update` →
// the plugin repo, any other argv → a one-shot `<prompt>`: one headless conversation
// (src/assistant/oneshot.ts), and `--help`/`--version`.
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
import { configStartupNotes, guardConfigFiles, inModelShell, loadConfig, settingsChangedSince, settingsFileHashes } from './config/load.js';

import {
  configSource,
  configValue,
  parseValue,
  setConfigValue,
  unsetConfigValue,
  configWarnings,
} from './config/load.js';
import { parseConfigArgs } from './config/commands.js';
import { createPluginRepo } from './loader/repo.js';
import { stopRemotePlugins } from './remote/lifecycle.js';
import { noPluginsNote } from './loader/install-root.js';
import { fetchPluginFromRegistry } from './loader/registry-download.js';
import { installPluginArchive, isArchiveSource } from './loader/archive-install.js';
import { checkPluginTrust, isPluginName, shownName, trustCommand, trustPlugin, unreadableTrustText, untrustPlugin, untrustedText, type Untrusted } from './loader/trust.js';
import { createInterface } from 'node:readline/promises';
import { memoryRecordNotes } from './assistant/memory-trust.js';
import type { PluginRepo } from './loader/repo.js';
import type { PluginRepo as RepoShape } from './loader/host-group.js';
import { loadPlugins, loadTrustedPlugin } from './loader/build.js';
import { createLatePlugins } from './loader/late.js';
import { assembleToolRegistry, pluginConfigs } from './loader/tools.js';
import { renderApp } from './runtime/app.js';
import { redactSecrets, refreshSecrets } from './assistant/secrets.js';
import { consoleBridge } from './runtime/console-log.js';
import { Conversation } from './assistant/conversation.js';
import { oneShotOutcome } from './assistant/oneshot.js';
import { ConversationRegistry } from './assistant/registry.js';
import { runExitHooks } from './assistant/sessions.js';
import { ONESHOT_WITHHELD } from './assistant/conversation-turn.js';
import { createServices } from './runtime/services.js';
import { hostVersion } from './version.js';
import { renderChatModal, renderHelp, renderLogModal, renderReminder } from './views/modals.js';
import { purgePluginMemories } from './runtime/services/memory.js';
import { mouseOption } from './config/mouse.js';

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
  | { cmd: 'prompt'; args: string[]; allowWrites?: true }
  | { cmd: 'help'; args: string[] }
  | { cmd: 'version'; args: string[] };

// Maps argv to a subcommand. Pure: no I/O, no config reads — easy to unit-test.
// A prompt is ANY argv that does not start with `config`/`plugins`/`--help`/
// `--version`; an empty argv starts the interactive TUI. `--allow-writes` counts only
// before the prompt: once the prompt has begun, it is a word of it.
export function parseCli(argv: string[]): ParseResult {
  const args = argv ?? [];
  const first = (args[0] ?? '').toLowerCase();

  if (first === '--help' || first === '-h' || first === 'help') return { cmd: 'help', args };
  if (first === '--version' || first === '-v' || first === 'version') return { cmd: 'version', args };
  if (first === 'config') return { cmd: 'config', args: args.slice(1) };
  if (first === 'plugins') return { cmd: 'plugins', args: args.slice(1) };
  if (args.length === 0) return { cmd: 'interactive', args: [] };
  if (args[0] === '--allow-writes') return { cmd: 'prompt', args: args.slice(1), allowWrites: true };
  return { cmd: 'prompt', args };
}

// ─── main ─────────────────────────────────────────────────────────────────────
export async function main(argv: string[]): Promise<void> {
  const parsed = parseCli(argv);
  const config = loadConfig();
  // The secrets this config and the environment name, taken out of every text the
  // model, the screen and the records see (src/assistant/secrets.ts).
  refreshSecrets(config);
  // A settings file changed since it was last accepted is not used (src/config/load.ts,
  // the guard): the app asks about it; with no chat to ask in, the reason is said.
  if (parsed.cmd === 'config' || parsed.cmd === 'plugins' || parsed.cmd === 'prompt') {
    for (const note of configStartupNotes()) console.error(note);
  }
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
      if (!parsed.args.length) {
        console.error('flow-assist: --allow-writes needs a prompt after it:  flow-assist --allow-writes "your request"');
        process.exitCode = 1;
        return;
      }
      gateLlmConfig(config);
      process.exitCode = await runPrompt(parsed.args, config, repo, parsed.allowWrites ? { allowWrites: true } : {});
      return;
    case 'interactive':
      gateLlmConfig(config);
      await runInteractive(config, repo);
      return;
  }
}

// ─── config subcommand ────────────────────────────────────────────────────────
// `io` is where the lines go — the console, or a test's own lists.
// What `config set`/`unset` says when the model's command ran it (src/config/load.ts).
const MODEL_SHELL_NOTE = 'config: saved to config.local.json, but it waits for the person\'s yes in flow-assist — a command the assistant runs cannot accept a setting';

type ConfigIo = { out: (line: string) => void; err: (line: string) => void };
const consoleIo: ConfigIo = { out: (l) => console.log(l), err: (l) => console.error(l) };

export async function runConfig(args: string[], config: Record<string, unknown>, repo?: PluginRepo, io: ConfigIo = consoleIo): Promise<void> {
  const { sub, key, value, session } = parseConfigArgs(args);

  // The value on stdout as it has always been (`config get x | jq` reads it bare), and
  // where it comes from on stderr.
  if (sub === 'get' && key) {
    const v = configValue(config, key);
    io.out(v === undefined ? `no key ${key}` : JSON.stringify(v));
    io.err(`source: ${configSource(config, key)}`);
    return;
  }

  // A session value lives as long as the app that holds it; this process ends with
  // the command, so there is no session here to lay it on.
  if (session) {
    io.err(`config: --session changes a setting for a running app only — inside it, run :config ${sub} --session ${key ?? '<key>'}${sub === 'set' ? ` ${value ?? '<value>'}` : ''}`);
    process.exitCode = 1;
    return;
  }

  if (sub === 'set' && key && value !== undefined) {
    // A plugin's key is validated by the plugin's own schema — so the plugins are loaded
    // (only for such a key: everything else needs none of them).
    const schemas = key.startsWith('plugins.') && repo ? pluginConfigs(await loadPlugins({ config, repo, renders, enabledDir })) : undefined;
    // The one path every `config set` takes (src/config/load.ts). A value is only
    // echoed once it is really on disk: printing it before a failed write would read
    // as "saved".
    const res = setConfigValue(config, key, parseValue(value), { scope: 'saved', pluginConfigs: schemas });
    if (!res.ok) {
      io.out(res.error);
      process.exitCode = 1;
      return;
    }
    io.out(JSON.stringify(res.value));
    if (inModelShell()) io.err(MODEL_SHELL_NOTE);
    return;
  }

  if (sub === 'unset' && key) {
    const res = unsetConfigValue(config, key, { scope: 'saved' });
    if (!res.ok) {
      io.out(res.error);
      process.exitCode = 1;
      return;
    }
    io.out(`config: unset ${key}`);
    if (inModelShell()) io.err(MODEL_SHELL_NOTE);
    return;
  }

  printConfigHelp();
}

// ─── plugins subcommand ───────────────────────────────────────────────────────
// Where the plugins are and where the lines go: the install's own and the console,
// unless a test gives its own. A plugin the person installs here is trusted — its name
// and where its link leads (src/loader/trust.ts) — and so is one they name to
// `plugins trust`; a host process started from a command the model runs records
// neither, and says so.
// `confirm` asks the person a y/n (a terminal's, when stdin is one; none otherwise).
export type PluginsDeps = { availableDir: string; enabledDir: string; io?: ConfigIo; confirm?: ((question: string) => Promise<boolean>) | null };

// What an install says when the model's command ran it: installed, not trusted.
const notTrustedYet = (name: string) => `plugin '${name}' is not trusted: a command the assistant runs cannot trust a plugin — run \`${trustCommand(name)}\` yourself`;

// A y/n on the terminal, when there is one to ask on.
function terminalConfirm(): ((question: string) => Promise<boolean>) | null {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null;
  return async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try { return /^y(es)?$/i.test((await rl.question(`${question} (y/n) `)).trim()); } finally { rl.close(); }
  };
}

export async function runPlugins(args: string[], config: Record<string, unknown>, repo: PluginRepo, deps: PluginsDeps = { availableDir, enabledDir }): Promise<void> {
  const io = deps.io ?? consoleIo;
  const sub = (args[0] ?? '').toLowerCase();
  const yes = args.includes('--yes');
  const name = args.slice(1).find((a) => a !== '--yes');
  // The person's own install is their word that the plugin, as installed now, may load.
  // From a command the model runs it is not: whatever was trusted under the name is
  // forgotten, so what it installed never loads on an old word. Says which it was.
  const trustInstalled = (installed: string): string => {
    if (inModelShell()) {
      untrustPlugin(deps.enabledDir, installed);
      io.err(notTrustedYet(installed));
      return 'installed, not trusted';
    }
    const t = trustPlugin(deps.enabledDir, installed, { yes: true });
    if (!t.ok) { io.err(t.error); return 'installed, not trusted'; }
    return 'installed and trusted';
  };

  if (sub === 'ls' || sub === 'list') {
    const entries = await repo.list();
    // Read only: listing never runs the first start or forgets anything.
    const check = checkPluginTrust(deps.enabledDir, await repo.enabledPlugins(), { readOnly: true });
    const untrusted = new Map(check.untrusted.map((u) => [u.name, u]));
    if (check.unreadable) io.out(unreadableTrustText(check.unreadable));
    for (const e of entries) {
      const u = untrusted.get(e.name);
      if (u?.refused || !isPluginName(e.name)) {
        io.out(`${shownName(e.name)}  [${untrustedText({ name: e.name, refused: true })}]`);
        continue;
      }
      const state = e.disabled ? 'disabled' : e.active ? (u ? `active, ${untrustedText(u)}` : 'active') : 'inactive';
      const source = e.source && e.source !== 'git' ? ` (${e.source})` : '';
      const missing = e.missingDeps.length ? `  missing: ${e.missingDeps.join(',')}` : '';
      const settingMiss = e.missingSettings?.length ? `  missing settings: ${e.missingSettings.join(',')}` : '';
      const incompatible = e.broken ? '  broken link' : e.incompatible ? `  ${e.incompatible}` : '';
      io.out(`${e.name}  v${e.version || '-'}  [${state}]${source}${incompatible}${missing}${settingMiss}`);
    }
    const note = noPluginsNote(deps.enabledDir, (await repo.enabledPlugins()).length, existsSync);
    if (note) io.out(note);
    return;
  }

  // An archive (a .tar.gz path or an https URL) is unpacked into plugins-available/
  // and enabled; a name is linked from there or fetched from the registry.
  if (sub === 'install' && name && isArchiveSource(name)) {
    const res = await installPluginArchive(name, { availableDir: deps.availableDir, enabledDir: deps.enabledDir });
    if (res.ok && res.name) {
      const trusted = trustInstalled(res.name);
      const how = res.replaced ? `${res.previousVersion ? `replaced (was v${res.previousVersion})` : 'replaced'}, ${trusted.replace('installed, ', '').replace('installed and ', '')}` : trusted;
      io.out(`plugin '${res.name}'${res.version ? ` v${res.version}` : ''} ${how} — restart the assistant for the change to take effect`);
    } else io.out(`plugins install: ${res.error}`);
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === 'install' && name) {
    const res = await repo.install(name);
    io.out(res.ok ? `plugin '${name}' ${trustInstalled(name)} — restart the assistant for the change to take effect` : res.error ?? '');
    if (!res.ok) process.exitCode = 1;
    return;
  }

  // A plugin linked or unpacked into plugins-enabled/ some other way — by hand, by a
  // kit's installer, or one whose link now leads elsewhere — loads once trusted here.
  // A link that leads elsewhere than when it was trusted is shown with both targets and
  // recorded only after a yes: `--yes`, or the person's y/n on a terminal.
  if (sub === 'trust' && name) {
    let res = trustPlugin(deps.enabledDir, name, { yes });
    if (!res.ok && res.confirm) {
      io.err(`plugin '${name}' was trusted at ${res.confirm.was}`);
      io.err(`its link now leads to ${res.confirm.now}`);
      const ask = deps.confirm === undefined ? terminalConfirm() : deps.confirm;
      if (!ask) {
        io.err(`not trusted — run \`${trustCommand(name)} --yes\` to trust the new target`);
        process.exitCode = 1;
        return;
      }
      if (!(await ask(`trust '${name}' at ${res.confirm.now}?`))) {
        io.err(`plugin '${name}' is not trusted`);
        process.exitCode = 1;
        return;
      }
      res = trustPlugin(deps.enabledDir, name, { yes: true });
    }
    if (res.ok) io.out(`plugin '${name}' trusted: ${res.target}${res.was ? ` (was ${res.was})` : ''} — restart the assistant for the change to take effect`);
    else {
      io.err(res.error);
      process.exitCode = 1;
    }
    return;
  }

  if (sub === 'remove' && name) {
    const res = await repo.remove(name);
    // On a successful uninstall, purge the plugin's memory (its `plugin`-scope facts)
    // so they don't linger after the plugin is gone.
    if (res.ok) purgePluginMemories(config, name);
    // The person's removal: the trust and its tombstone both go. From a command the
    // assistant runs, the tombstone stays, so a link put back elsewhere still shows
    // where it led before and its trust still asks.
    if (res.ok) untrustPlugin(deps.enabledDir, name, { clear: !inModelShell() });
    io.out(res.ok ? `plugin '${name}' removed — restart the assistant for the change to take effect` : res.error ?? '');
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === 'update') {
    const res = await repo.update(name);
    io.out(res.ok ? (name ? `plugin '${name}' updated — restart the assistant for the change to take effect` : 'plugins updated — restart the assistant for the change to take effect') : res.error ?? '');
    if (!res.ok) process.exitCode = 1;
    return;
  }

  printPluginsHelp(io);
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
// What a one-shot run is handed besides its prompt: `allowWrites` from the command
// line, and where it reads its plugins and writes its answer — the install's own and
// the process's streams unless a test gives its own. It returns the exit code
// (`src/assistant/oneshot.ts`, `oneShotOutcome`).
export type PromptDeps = {
  allowWrites?: boolean;
  enabledDir?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
};

export async function runPrompt(args: string[], config: Record<string, unknown>, repo: PluginRepo, deps: PromptDeps = {}): Promise<number> {
  // The settings files as the run finds them: one that changes on disk while it runs is
  // said at the end, and not applied (src/config/load.ts, the guard).
  const settingsBefore = settingsFileHashes();
  const prompt = args.join(' ');
  const dir = deps.enabledDir ?? enabledDir;
  const out = deps.out ?? ((text: string) => { process.stdout.write(text); });
  const err = deps.err ?? ((text: string) => { process.stderr.write(text); });
  let conv: Conversation | null = null;
  try {
    const plugins = await loadPlugins({ config, repo, renders, enabledDir: dir });
    const registry = assembleToolRegistry({ plugins, config, repo: repo as unknown as RepoShape });
    // On stderr, so an answer piped elsewhere stays clean.
    const note = noPluginsNote(dir, (await repo.enabledPlugins()).length, existsSync);
    if (note) err(`[plugins] ${note}\n`);
    // The host's services with the REAL primitives (open_browser spawns `open`), and its
    // `chatLLM`, which applies the config's limits and tool loading as the chat's does.
    const services = createServices({ config, tools: registry, repo, onExit: () => {} });
    // One conversation nobody can answer: every write declined, or — `--allow-writes` —
    // the person's yes given in advance, each write said on stderr as it runs.
    // Headless: nobody to ask (`canAsk: false`), no screen, no sessions directory — so no
    // session file, no journal, no lock — and no App to redraw. The services are the host's
    // own (`createServices`), whose `chatLLM` applies the config's limits, tool loading,
    // result cap, image limits and endpoint, as the chat's does. Nothing is shown, so
    // `current` finds nothing, and there is no settings-file service: the guard never asks
    // here. Every run of the model it makes withholds `ONESHOT_WITHHELD`, the turn's own and
    // each a tool starts through `ctx.chatLLM` alike: a nested run offered `background` or
    // `remind` could leave work or a timer running after the answer prints.
    const conversations = new ConversationRegistry({
      config: () => config,
      services: () => services as unknown as Record<string, unknown>,
      notify: () => {},
      sessionsDir: () => null,
      canAsk: false,
      withhold: ONESHOT_WITHHELD,
    });
    conv = conversations.fresh({
      kind: 'oneshot',
      policy: deps.allowWrites ? { kind: 'allow-writes', say: (line) => err(`${line}\n`) } : { kind: 'none' },
    });
    const sent = await conv.send(prompt);
    const said = oneShotOutcome(sent ? conv.lastEnd : null, conv.lastAnswer(), settingsChangedSince(settingsBefore));
    if (said.out !== undefined) out(said.out);
    if (said.err) err(said.err);
    return said.code;
  } catch (e) {
    // A throw on the way (the plugin repository unreadable, a provider's client failing
    // outside the turn) reaches the command line's own printing (src/cli.ts), its
    // message redacted as every other stderr line. A plugin that fails to load is not a
    // throw: the loader skips it, and its line is redacted there (`skipLine`).
    throw new Error(redactSecrets(e instanceof Error ? e.message : String(e)), { cause: e });
  } finally {
    // Its timers go with it (the save it arms, with nowhere to save), or they would hold
    // the process open.
    conv?.close('exit');
  }
}

// ─── interactive TUI ──────────────────────────────────────────────────────────
// The mouse and its hover, from `ui.mouse` and `ui.hover` (src/config/mouse.ts).
export { mouseEnabled, mouseOption } from './config/mouse.js';

// The TUI needs a terminal on BOTH ends: it draws on stdout and reads keys from
// stdin. Started in a pipe, in CI or with its input redirected, flowtty ≥
// 1.0.0-alpha.12 throws rather than writing escape codes into the pipe (or, with
// stdin piped, quitting at once with nothing said). Either way the person deserves
// a sentence and the way that does work without a terminal.
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
  // From here on the settings files are what `main` read: a change the app does not make
  // itself is asked about in the chat before it is applied (src/config/load.ts).
  guardConfigFiles();
  // What the loader skipped, and why, goes into the app's log too.
  const loadNotes: string[] = [];
  // The screen is drawn at once: a remote plugin's process and a plugin that waits on
  // its servers join the app when they are ready (src/loader/late.ts). The one-shot
  // prompt and the CLI wait for everything instead — they read the tools once.
  const late = createLatePlugins();
  // An enabled plugin the person has not trusted is not loaded; the start screen names it.
  const untrusted: Untrusted[] = [];
  const trustNotes: string[] = [];
  // Why each plugin was skipped — the `:plugins` panel says it on the plugin's row.
  const skipped = new Map<string, string>();
  const plugins = await loadPlugins({ config, repo, renders, enabledDir, notes: loadNotes, late, untrusted, trustNotes, skipped });
  // What the `:plugins` panel needs to enable, restart and trust a plugin while the app
  // runs (src/runtime/plugins-panel.ts): the same dirs, and the loader's own way to load
  // one — its trust checked first, and loaded from where it was trusted.
  const site = { repo, enabledDir, skipped, untrusted, load: (name: string) => loadTrustedPlugin(name, { config, enabledDir, renders, log: (line) => late.note(line) }) };
  // The app opens the plugins' screens (`ui_open`); the one-shot prompt has none.
  const registry = assembleToolRegistry({ plugins, config, repo: repo as unknown as RepoShape, screens: true });
  // The backend holds the console while it owns the screen; with `onConsole` set every
  // line goes to the log (`L`) at once and nothing is printed again at exit.
  const consoleLog = consoleBridge();
  const backend = new TtyBackend(process.stdout, process.stdin, { mouse: mouseOption(config), onConsole: consoleLog.onConsole });

  let handle: { unmount(): void } | undefined;
  // Guards against a second call landing while the first is still waiting on remote
  // plugins to stop — the exit path runs once.
  let exiting = false;
  const onExit = () => {
    if (exiting) return;
    exiting = true;
    // The sessions' exit hooks first, while nothing has been awaited: every live
    // conversation is saved, unlocked and closed, and each task still running says so in
    // its session's journal (./assistant/registry.ts, `closeAll`). The unmount after it
    // finds nothing left to write.
    runExitHooks();
    handle?.unmount();
    backend.dispose?.();
    // What was printed through the console while the app ran, now that the terminal is
    // the shell's again: the log that showed it is gone with the app.
    const printed = consoleLog.kept();
    if (printed.length) process.stderr.write(`${printed.join('\n')}\n`);
    // Every remote plugin gets a chance to say `shutdown` and its transport a chance
    // to close cleanly (./remote/lifecycle.ts) before the process itself goes; the
    // exit hook (./remote/transport-stdio.ts) is the backstop for whatever this
    // leaves running.
    void stopRemotePlugins().then(() => process.exit(0));
  };
  const pluginsNote = await missingPluginsNote(repo);
  handle = await renderApp(backend, { plugins, config, renders: {}, tools: registry, onExit, pluginsNote: pluginsNote ?? undefined, loadNotes, consoleLog, late, untrusted, trustNotes: [...trustNotes, ...memoryRecordNotes()], site });
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
      '  flow-assist plugins <cmd> ...     ls|install|trust|remove|update plugins',
      '  flow-assist <prompt>              One-shot chat with the loaded tool registry;',
      '                                    it declines every write, as it cannot ask',
      '  flow-assist --allow-writes <prompt>',
      '                                    One-shot chat whose writes run unasked, each said',
      '                                    on stderr (config_set, an unlisted web_fetch and',
      '                                    a plugin\'s run_command are still declined)',
      '  flow-assist --help                Show this help',
      '  flow-assist --version             Show the host version',
    ].join('\n'),
  );
}

function printConfigHelp(): void {
  console.log(
    [
      'config subcommands:',
      '  config get <key>            Print the value at a dot path (or "no key <key>");',
      '                              where it comes from (local, config, default) on stderr',
      '  config set <key> <value>    Save a value to config.local.json (validated against the schema)',
      '                              Inside the app, :config set --session <key> <value> sets it for that run only',
      '  config unset <key>          Remove a key from config.local.json',
      '  config help                 Show this help',
      '',
      'Example keys: ai.model, ai.baseUrl, cache.enabled, debug.logTools, memory.file',
    ].join('\n'),
  );
}

function printPluginsHelp(io: ConfigIo = consoleIo): void {
  io.out(
    [
      'plugins subcommands:',
      '  plugins ls                List available plugins',
      '  plugins install <name>    Install and trust a plugin (symlink from plugins-available)',
      '  plugins install <file>    Install and trust a plugin archive (.tar.gz, a path or an https URL)',
      '  plugins trust <name>      Trust a plugin in plugins-enabled that was put there another way',
      '                            (--yes: trust it though its link leads elsewhere than it did)',
      '  plugins remove <name>     Remove a plugin (unlink from plugins-enabled)',
      '  plugins update [name]     Re-fetch registry-managed plugins (an archive: install the newer one)',
    ].join('\n'),
  );
}
