// Plugin loader. The host is NOT fs-scanned for built-ins (they live in
// `src/plugins/`) and DOES fs-resolve the enabled plugin set at startup. `loadPlugins`
// always builds the four built-ins (core/assistant/keycaps/log), then loads every
// enabled plugin from `plugins-enabled/`, all of them at once: import its default
// builder, call it with `{ renders, config, make, z }` and the host's mark registries,
// and await it — a builder may be async. They join the list in the order they are
// enabled, whichever finished first. A broken plugin is skipped with a line in the
// loader's notes, and so is one the person has not trusted (./trust.ts) — before its
// manifest is read, so none of its code runs and no process of its starts.
//
// Two ways to wait. By default everything is awaited — every remote plugin's handshake
// and every plugin's `ready` — which is what the one-shot prompt and the CLI need: they
// read the tools once, and there is no screen to show anything sooner. Given `late`, a
// remote plugin is not awaited: its handshake goes on in the background and the plugin
// joins the running app when it completes, and a plugin's `ready` is only noted
// (./late.ts). The interactive app loads that way and draws at once.
//
// `renders` is the renderer bundle ({ help, chat, log }) that the runtime
// supplies at startup — the built-in `core.views.help` / `assistant.views.chat` /
// `log.views.log` reference `renders.help` / `renders.chat` / `renders.log`. `make`
// is injectable too (tests can supply a custom factory); it defaults to
// `makeFactory(config)`.
//
// NOTE: `PluginRepo` exposes only methods, not its `enabledDir`, so
// `loadPlugins` also accepts an optional `enabledDir` to resolve
// `plugins-enabled/<name>` for dynamic import. When it is absent (and an enabled
// plugin exists), that plugin is skipped with a warning — the test uses an empty
// enabled set, so this never triggers there.

import { makeFactory } from './plugin.js';
import type { Make, MakeFactoryConfig, Plugin } from './plugin.js';
import type { PluginRepo } from './repo.js';
import { buildCorePlugin } from '../plugins/core.js';
import { buildAssistantPlugin } from '../plugins/assistant.js';
import { buildKeycapsPlugin } from '../plugins/keycaps.js';
import { buildLogPlugin } from '../plugins/log.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { appliesOnRestart, modelMaySave, modelMaySet } from '../config/schema.js';
import { THIS_HOST, pluginCompat, readPluginManifest } from './compat.js';
import { isRemoteManifest, remotePlugin, transportFor } from '../remote/index.js';
import { refreshToolRegistry } from './tools.js';
import { skipLine, type LatePlugins } from './late.js';
import { checkPluginTrust, shownName, unreadableTrustText, untrustedText, type TrustOptions, type Untrusted } from './trust.js';

// A plugin builder: `build<X>Plugin({ renders, config, make, z, modelMaySet, modelMaySave,
// appliesOnRestart, toolsChanged })` → Plugin (or a promise of one).
// `z` is the host's zod, handed to every builder: a plugin with no bundler (and so no
// runtime dependencies — the compiled binary cannot import a package from disk) still
// declares its `configSchema`, and it is the same zod the host validates with. The
// three registries beside it are the host's marks (src/config/schema.ts): a plugin
// registers a key of its own `configSchema` in them — what the model may set or save,
// what is read only at start. A mark is found by its node in the host's registry, so
// it must be these, never a registry of the plugin's own.
const MARKS = { modelMaySet, modelMaySave, appliesOnRestart };
// `toolsChanged` is for a plugin whose tool groups change while the app runs (the `mcp`
// plugin, as its servers connect, drop and are turned off): it sets `tools` on the plugin
// object `make` returned and calls this, and the registry reads every plugin's groups
// again (`refreshToolRegistry`). An addition like the marks: a plugin that must also run
// on an older host checks that it is there.
const EXTRAS = { ...MARKS, toolsChanged: refreshToolRegistry };
type BuilderCtx = { renders: Record<string, unknown>; config: Record<string, unknown>; make: Make; z: typeof z } & typeof EXTRAS;
type BuiltinBuilder = (ctx: BuilderCtx) => Plugin;

const BUILTINS: BuiltinBuilder[] = [buildCorePlugin, buildAssistantPlugin, buildKeycapsPlugin, buildLogPlugin];

// Resolves a plugin's entry FILE so the loader imports a concrete module, not a
// directory. The compiled binary can `import()` an on-disk `.ts` FILE (and follow
// its relative + node_modules imports), but it CANNOT `import()` an on-disk
// DIRECTORY — even with a `package.json` `main` — because bun resolves the dir
// against the embedded `/$bunfs` virtual FS. That mismatch is what made the binary
// skip every enabled plugin (`Cannot find module '.../plugins-enabled/tracker'`),
// while `bun src/cli.ts` worked only by luck of the runtime's directory resolution.
// Importing the entry FILE makes both paths resolve identically.
function resolvePluginEntry(pluginDir: string): string {
  // A single-file plugin (a symlink to a .ts): import the file directly.
  if (statSync(pluginDir).isFile()) return pluginDir;
  // A plugin directory: honour `package.json` `main`, else try the conventional
  // entry paths. `main` may be `./src/index.ts` or `src/index.ts`; `join`
  // normalizes both against the plugin dir.
  const pkgFile = join(pluginDir, 'package.json');
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { main?: unknown };
      if (typeof pkg.main === 'string' && pkg.main) {
        const entry = join(pluginDir, pkg.main);
        if (existsSync(entry)) return entry;
      }
    } catch {
      // Malformed package.json — fall through to the conventional paths.
    }
  }
  for (const candidate of ['./src/index.ts', './index.ts']) {
    const entry = join(pluginDir, candidate);
    if (existsSync(entry)) return entry;
  }
  throw new Error('no resolvable entry file (package.json main or ./src/index.ts)');
}

// `description` from a plugin's manifest.json; undefined when there is none.
function manifestDescription(pluginDir: string): string | undefined {
  try {
    const m = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf8')) as { description?: unknown };
    return typeof m.description === 'string' && m.description.trim() ? m.description.trim() : undefined;
  } catch {
    return undefined;
  }
}

export interface LoadPluginsOptions {
  config: Record<string, unknown>;
  repo: PluginRepo;
  renders?: Record<string, unknown>;
  make?: Make;
  // The `plugins-enabled/` dir, needed only to dynamically import enabled plugins.
  // Omitted → enabled plugins are skipped (built-ins still load).
  enabledDir?: string;
  // Where the loader says what it skipped and why, a line each — the host puts them in
  // its log. A skip is also said on stderr, as before the app has a screen.
  notes?: string[];
  // How a remote plugin's process is reached (src/remote/transports.ts); a test hands
  // in a transport over in-memory streams.
  remoteTransport?: typeof transportFor;
  // The running app's: what is not awaited goes here and joins it later (./late.ts).
  // Absent — everything is awaited.
  late?: LatePlugins;
  // Where the enabled plugins the person has not trusted are listed (./trust.ts): none of
  // their code runs; the start screen names them.
  untrusted?: Untrusted[];
  // What the start screen says of the trust record, once: the plugins the first start
  // trusted, or that the record cannot be read.
  trustNotes?: string[];
  // The trust record's file and whether this runs in the model's shell — a test's own.
  trust?: TrustOptions;
}

export async function loadPlugins({
  config,
  repo,
  renders = {},
  make = makeFactory(config as MakeFactoryConfig),
  enabledDir,
  notes = [],
  remoteTransport,
  late,
  untrusted = [],
  trustNotes = [],
  trust,
}: LoadPluginsOptions): Promise<Plugin[]> {
  const skip = (name: string, why: string) => {
    const line = skipLine(name, why);
    console.warn(line);
    notes.push(line);
  };
  const plugins: Plugin[] = [];

  // Built-ins: always present and not removable (they are not part of the enabled
  // symlink set).
  for (const build of BUILTINS) {
    try {
      plugins.push(build({ renders, config, make, z, ...EXTRAS }));
    } catch (e) {
      console.warn(`[plugins] builtin skipped: ${(e as Error).message}`);
    }
  }

  // Enabled plugins, all at once: one that waits on a process or a server does not hold
  // up the next. Each resolves to its plugin, or to null once its skip is said.
  const listed = await repo.enabledPlugins();
  // Only a plugin the person trusts is looked at further — its manifest read, its code
  // imported or its process started (./trust.ts). The first check of a directory trusts
  // what is there and says so once.
  let enabled = listed;
  if (enabledDir) {
    const check = checkPluginTrust(enabledDir, listed, trust);
    const said = (line: string) => { notes.push(`[plugins] ${line}`); trustNotes.push(line); if (!late) console.warn(`[plugins] ${line}`); };
    if (check.bootstrapped?.length) said(`trusted at first start: ${check.bootstrapped.join(', ')}`);
    if (check.unreadable) said(unreadableTrustText(check.unreadable));
    for (const u of check.untrusted) {
      untrusted.push(u);
      skip(shownName(u.name), untrustedText(u));
    }
    enabled = listed.filter((n) => check.trusted.includes(n));
  }
  late?.order(enabled);
  const loads = enabled.map(async (name): Promise<Plugin | null> => {
    if (!enabledDir) {
      console.warn(`[plugins] skip ${name}: no enabledDir provided`);
      return null;
    }
    // Whether it can run here is read from its manifest before any of its code runs.
    const manifest = readPluginManifest(join(enabledDir, name));
    const compat = pluginCompat(manifest, THIS_HOST);
    if (!compat.ok) {
      skip(name, compat.reason);
      return null;
    }
    if (compat.note) notes.push(`[plugins] ${name} ${compat.note}`);
    if (isRemoteManifest(manifest)) {
      // A plugin in another language: a process the host talks to, built into a
      // Plugin by the adapter — the rest of the loader never knows (docs/plugins.md,
      // "A plugin in another language").
      // What the adapter and the transport say — the process's stderr, a restart. Waiting,
      // it goes to stderr and the notes the app's log starts with; late, to the app's log
      // itself, whenever it is said (the console is the screen's then).
      const log = late ? (line: string) => late.note(line) : (line: string) => { console.warn(line); notes.push(line); };
      const remote = (async () => {
        const transport = (remoteTransport ?? transportFor)(manifest, join(enabledDir, name), { log });
        return remotePlugin({ manifest, transport, config, make, log });
      })();
      if (late) {
        late.expect(name, remote);
        return null;
      }
      try {
        return await remote;
      } catch (e) {
        skip(name, (e as Error).message);
        return null;
      }
    }
    try {
      // Import the entry FILE (not the symlinked directory), so the compiled binary
      // and the runtime resolve plugins the same way — see resolvePluginEntry.
      const entry = resolvePluginEntry(join(enabledDir, name));
      const mod = (await import(pathToFileURL(entry).href)) as {
        default?: unknown;
        build?: unknown;
      };
      const build = (mod.default ?? mod.build) as unknown;
      if (typeof build !== 'function') {
        skip(name, 'default export is not a builder function');
        return null;
      }
      // A builder may be async. One whose plugin waits on someone (an MCP server lists
      // its tools once connected) returns at once and says so with `ready`; it is the
      // plugin's job to bound that wait.
      const plugin = await (build as (ctx: BuilderCtx) => Plugin | Promise<Plugin>)({ renders, config, make, z, ...EXTRAS });
      // What the plugin IS, in its author's words, for the start screen — from its
      // manifest, unless the shape says it itself.
      plugin.description ??= manifestDescription(join(enabledDir, name));
      if (plugin.ready) {
        if (late) late.wait(plugin.name, plugin.ready);
        else await plugin.ready.catch(() => undefined);
      }
      return plugin;
    } catch (e) {
      skip(name, (e as Error).message);
      return null;
    }
  });
  for (const plugin of await Promise.all(loads)) if (plugin) plugins.push(plugin);

  return plugins;
}

export default loadPlugins;