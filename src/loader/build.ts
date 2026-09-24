// Plugin loader. The host is NOT fs-scanned for built-ins (they live in
// `src/plugins/`) and DOES fs-resolve the enabled plugin set at startup. `loadPlugins`
// always builds the four built-ins (core/assistant/keycaps/log), then loads every
// enabled plugin from `plugins-enabled/` (import its default builder, call it with
// `{ renders, config, make, z }` and await it — a builder may be async). A broken
// plugin is skipped with `console.warn`.
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
import { THIS_HOST, pluginCompat, readPluginManifest } from './compat.js';

// A plugin builder: `build<X>Plugin({ renders, config, make, z })` → Plugin (or a promise of one).
// `z` is the host's zod, handed to every builder: a plugin with no bundler (and so no
// runtime dependencies — the compiled binary cannot import a package from disk) still
// declares its `configSchema`, and it is the same zod the host validates with.
type BuiltinBuilder = (ctx: { renders: Record<string, unknown>; config: Record<string, unknown>; make: Make; z: typeof z }) => Plugin;

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
}

export async function loadPlugins({
  config,
  repo,
  renders = {},
  make = makeFactory(config as MakeFactoryConfig),
  enabledDir,
  notes = [],
}: LoadPluginsOptions): Promise<Plugin[]> {
  const skip = (name: string, why: string) => {
    const line = `[plugins] skip ${name}: ${why}`;
    console.warn(line);
    notes.push(line);
  };
  const plugins: Plugin[] = [];

  // Built-ins: always present and not removable (they are not part of the enabled
  // symlink set).
  for (const build of BUILTINS) {
    try {
      plugins.push(build({ renders, config, make, z }));
    } catch (e) {
      console.warn(`[plugins] builtin skipped: ${(e as Error).message}`);
    }
  }

  // Enabled plugins: import each default builder from `plugins-enabled/<name>`.
  const enabled = await repo.enabledPlugins();
  for (const name of enabled) {
    if (!enabledDir) {
      console.warn(`[plugins] skip ${name}: no enabledDir provided`);
      continue;
    }
    // Whether it can run here is read from its manifest before any of its code runs.
    const compat = pluginCompat(readPluginManifest(join(enabledDir, name)), THIS_HOST);
    if (!compat.ok) {
      skip(name, compat.reason);
      continue;
    }
    if (compat.note) notes.push(`[plugins] ${name} ${compat.note}`);
    try {
      // Import the entry FILE (not the symlinked directory), so the compiled binary
      // and the runtime resolve plugins the same way — see resolvePluginEntry.
      const entry = resolvePluginEntry(join(enabledDir, name));
      const mod = (await import(pathToFileURL(entry).href)) as {
        default?: unknown;
        build?: unknown;
      };
      const build = (mod.default ?? mod.build) as unknown;
      if (typeof build === 'function') {
        // A builder may be async: a plugin whose tools are known only after it has asked
        // someone (an MCP server lists its tools once connected) returns a promise. It is
        // the plugin's job to bound that wait — the app starts only after it.
        const plugin = await (build as (ctx: Parameters<BuiltinBuilder>[0]) => Plugin | Promise<Plugin>)({ renders, config, make, z });
        // What the plugin IS, in its author's words, for the start screen — from its
        // manifest, unless the shape says it itself.
        plugin.description ??= manifestDescription(join(enabledDir, name));
        plugins.push(plugin);
      } else {
        skip(name, 'default export is not a builder function');
      }
    } catch (e) {
      skip(name, (e as Error).message);
    }
  }

  return plugins;
}

export default loadPlugins;