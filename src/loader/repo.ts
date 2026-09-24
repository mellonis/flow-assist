// Plugin repository. The host keeps plugins in `plugins-available/` (git-tracked
// sources) and exposes the ACTIVE set through `plugins-enabled/` (a directory of
// symlinks, gitignored). This module is the single repository layer under both the
// CLI subcommands and the built-in `host` tool group: `install` symlinks a
// source into `enabled` (or downloads it from the plugin registry when the source
// is absent), `remove` unlinks it, `list` reads every available manifest, and
// `update` re-fetches only registry-managed plugins.
//
// Networking is never done here. `fetchPlugin` is injected by the caller (the real
// HTTP + untar implementation is registry-download.ts, reading FLOW_ASSIST_PLUGIN_REGISTRY_TOKEN /
// FLOW_ASSIST_PLUGIN_REGISTRY_URL / FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT); tests inject a fake so
// this module stays hermetic (no network, no tar). The config paths are also
// dependency-injected (NOT imported from src/config): `createPluginRepo` receives
// `availableDir` / `enabledDir` / `projectRoot` as explicit parameters.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { THIS_HOST, pluginCompat, readPluginManifest } from './compat.js';

// ─── Types ────────────────────────────────────────────────────────────────────

// Outcome of a mutating repo operation (install/remove/update).
export interface InstallResult {
  ok: boolean;
  error?: string;
}

// A discovered plugin, as reported by `list()`. `source` is the provenance marker:
// 'registry' when the plugin was downloaded (a `.flow-assist-source` file containing
// 'registry' is present), otherwise 'git' (a locally-checked-out clone). `surfaces`
// and `tools` are surfaced from the manifest when present. `builtin` plugins are
// omitted entirely (they live in `plugins/`, not `enabled`, and cannot be removed).
export interface RepoEntry {
  name: string;
  version: string;
  description: string;
  active: boolean;
  missingDeps: string[];
  missingSettings?: string[];
  // Why this host cannot load it (src/loader/compat.ts) — `incompatible: built for host
  // API 1, host provides 2`; absent when it can.
  incompatible?: string;
  source?: PluginSource;
  surfaces?: string[];
  tools?: string[];
}

// Injection point for the registry download (registry-download.ts is the real one).
export type FetchPlugin = (name: string, version?: string) => Promise<{ version: string }>;

// Options passed to `createPluginRepo`. All paths are injected so the repo is
// hermetic: the caller (the CLI) passes the real plugin dirs.
export interface PluginRepoOptions {
  availableDir: string;
  enabledDir: string;
  projectRoot: string;
  fetchPlugin?: FetchPlugin;
}

// The repository surface consumed by the runtime and the `host` tool group. The
// consumer (`host-group.ts`) declares these as optional `(...args) => Promise<unknown>`;
// method syntax keeps this assignable under bivariance.
export interface PluginRepo {
  list(): Promise<RepoEntry[]>;
  install(name: string): Promise<InstallResult>;
  remove(name: string): Promise<InstallResult>;
  update(name?: string): Promise<InstallResult>;
  enabledPlugins(): Promise<string[]>;
}

// A parsed `manifest.json` (subsets we consume; unknown fields preserved).
interface Manifest {
  name?: string;
  version?: string;
  description?: string;
  deps?: Record<string, string>;
  builtin?: boolean;
  surfaces?: string[];
  tools?: string[];
  requiredSettings?: string[];
  [key: string]: unknown;
}

// ─── Low-level helpers ────────────────────────────────────────────────────────

const SOURCE_MARKER = '.flow-assist-source';
const REGISTRY_SOURCE = 'registry';

// A plugin name must be a single filesystem path segment: non-empty, not `.`/`..`,
// no path separators, no NUL. Names are joined into `availableDir`/`enabledDir`
// paths (install/remove/update), so rejecting a name that could traverse or escape
// the plugin dirs is cheap defense-in-depth against CLI-supplied input. Returns the
// trimmed name when valid, else null.
function validPluginName(name: string): string | null {
  const s = String(name ?? '').trim();
  if (!s || s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0')) return null;
  return s;
}

// Reads and parses a plugin's manifest, tolerating a missing/blank manifest.
function readManifest(pluginDir: string): Manifest {
  const file = join(pluginDir, 'manifest.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  } catch {
    return {};
  }
}

// Writes the registry provenance marker into a plugin dir. Written by `install`/
// `update` after a download so `update`/`list` can tell registry-managed plugins
// from git checkouts (a git clone is left unmarked).
function writeSourceMarker(pluginDir: string): void {
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, SOURCE_MARKER), `${REGISTRY_SOURCE}\n`, 'utf8');
}

// Where a plugin came from: 'registry' (downloaded by name), 'archive' (installed
// from a .tar.gz file or URL — archive-install.ts), 'git' (checked out, or unmarked).
// `linked` — enabled by a link to a plugin kept outside `plugins-available/` (a
// plugin in a repository of its own).
export type PluginSource = 'git' | 'registry' | 'archive' | 'linked';

// Provenance for a plugin dir, read from its `.flow-assist-source` marker; 'git' when
// there is none.
function sourceFor(pluginDir: string): PluginSource {
  const marker = join(pluginDir, SOURCE_MARKER);
  if (existsSync(marker)) {
    const content = readFileSync(marker, 'utf8');
    if (content.includes(REGISTRY_SOURCE)) return REGISTRY_SOURCE;
    if (content.includes('archive')) return 'archive';
  }
  return 'git';
}

// Does a manifest `deps` entry resolve to an existing target? A `file:` spec is
// resolved relative to the PLUGIN dir (the base where the manifest lives), which
// matches how the package manager resolves the plugin's own `file:` deps; a
// non-`file:` spec (a bare package name) cannot be resolved without a
// registry/node_modules, so it counts as missing.
function depTargetExists(spec: string, baseDir: string): boolean {
  if (!spec || typeof spec !== 'string') return false;
  if (spec.startsWith('file:')) {
    const rel = spec.slice('file:'.length);
    const target = resolve(baseDir, rel);
    return existsSync(target);
  }
  return false;
}

function isBuiltDistribution(pluginDir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')) as { main?: unknown };
    if (typeof pkg.main !== 'string' || !pkg.main) return false;
    return existsSync(join(pluginDir, pkg.main)) && !existsSync(join(pluginDir, 'src'));
  } catch {
    return false;
  }
}

// Computes a plugin's missing deps from its manifest (a pure helper shared by the
// exported `resolveDeps` and the `list` method, which closes over the real dirs).
function missingDepsFor(pluginDir: string): string[] {
  // A BUILT plugin (as `plugin:publish` ships it: the bundle named by package.json's
  // `main`, and no `src/`) carries its dependencies inside the bundle. Its manifest
  // still lists them — for whoever builds it — but none can be missing, and saying
  // "missing: @acme/client" about a plugin that loads and works is a false alarm.
  if (isBuiltDistribution(pluginDir)) return [];
  const manifest = readManifest(pluginDir);
  const missing: string[] = [];
  for (const [dep, spec] of Object.entries(manifest.deps ?? {})) {
    if (!depTargetExists(spec, pluginDir)) missing.push(dep);
  }
  return missing;
}

// Computes a plugin's missing required settings (env vars) from its manifest.
// A `requiredSettings` entry is "missing" when its env var is unset or empty.
// Mirrors `missingDepsFor` and is reported for available + enabled plugins alike,
// so a plugin that cannot load due to a missing setting is visible before it
// throws. Pure in the sense that it reads only the manifest + process.env.
function missingSettingsFor(pluginDir: string): string[] {
  const manifest = readManifest(pluginDir);
  const missing: string[] = [];
  for (const key of manifest.requiredSettings ?? []) {
    if (!process.env[key]) missing.push(key);
  }
  return missing;
}

// ─── Standalone dependency resolver ───────────────────────────────────────────
// Checks a plugin's manifest `deps` and reports the ones that cannot be resolved
// (e.g. `@acme/client` → `file:../client` when the target is absent). Options are supplied so the function can also be used standalone;
// without a context it cannot resolve anything and reports no misses.
export function resolveDeps(
  name: string,
  opts?: { availableDir: string; projectRoot: string },
): { missing: string[] } {
  if (!opts?.availableDir) return { missing: [] };
  const pluginDir = join(opts.availableDir, name);
  return { missing: missingDepsFor(pluginDir) };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createPluginRepo({ availableDir, enabledDir, projectRoot, fetchPlugin }: PluginRepoOptions): PluginRepo {
  // Registry-managed plugin names: every available plugin whose `.flow-assist-source` says
  // 'registry'. Used by `update(name?)` with no name to re-fetch them all.
  const registryManagedNames = (): string[] => {
    if (!existsSync(availableDir)) return [];
    return readdirSync(availableDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => sourceFor(join(availableDir, d.name)) === REGISTRY_SOURCE)
      .map((d) => d.name);
  };

  // Downloads a registry plugin into its available dir (marking it 'registry'),
  // then symlinks it into `enabled`. `fetchPlugin` materializes `plugins-available/<name>/`.
  const fetchAndLink = async (name: string): Promise<InstallResult> => {
    const n = validPluginName(name);
    if (!n) return { ok: false, error: `plugin '${name}' — invalid name (must be a single path segment)` };
    if (!fetchPlugin) {
      return {
        ok: false,
        error: `plugin '${n}' not available locally and no registry token (set FLOW_ASSIST_PLUGIN_REGISTRY_TOKEN)`,
      };
    }
    const pluginDir = join(availableDir, n);
    try {
      await fetchPlugin(n);
      writeSourceMarker(pluginDir);
      const compat = pluginCompat(readManifest(pluginDir), THIS_HOST);
      if (!compat.ok) return { ok: false, error: `plugin '${n}' is ${compat.reason}` };
      const enabledLink = join(enabledDir, n);
      mkdirSync(enabledDir, { recursive: true });
      if (!existsSync(enabledLink)) symlinkSync(pluginDir, enabledLink);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };

  return {
    // Installs a plugin: if the source is present locally, symlink it; if absent and
    // a fetchPlugin is injected, download-then-symlink; otherwise fail cleanly.
    async install(name: string): Promise<InstallResult> {
      const n = validPluginName(name);
      if (!n) return { ok: false, error: `plugin '${name}' — invalid name (must be a single path segment)` };
      const pluginDir = join(availableDir, n);
      const enabledLink = join(enabledDir, n);
      if (existsSync(enabledLink)) {
        return { ok: false, error: `plugin '${n}' is already installed` };
      }
      if (existsSync(join(pluginDir, 'manifest.json'))) {
        const compat = pluginCompat(readManifest(pluginDir), THIS_HOST);
        if (!compat.ok) return { ok: false, error: `plugin '${n}' is ${compat.reason}` };
        try {
          // plugins-enabled/ is gitignored: a fresh checkout has none, and the first
          // install used to fail with ENOENT.
          mkdirSync(enabledDir, { recursive: true });
          symlinkSync(pluginDir, enabledLink);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      }
      // Source absent — try the registry, which materializes the dir + symlinks it.
      return fetchAndLink(n);
    },

    // Removes a plugin: unlinks it from `enabled`. The available dir (and any
    // `.flow-assist-source` marker) is left in place so re-install is instant.
    async remove(name: string): Promise<InstallResult> {
      const n = validPluginName(name);
      if (!n) return { ok: false, error: `plugin '${name}' — invalid name (must be a single path segment)` };
      const enabledLink = join(enabledDir, n);
      if (!existsSync(enabledLink)) {
        return { ok: false, error: `plugin '${n}' is not installed` };
      }
      try {
        unlinkSync(enabledLink);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },

    // Updates a plugin: registry-only re-download of the latest published version.
    // Git checkouts are never clobbered — only `.flow-assist-source=registry` plugins are
    // re-fetched; a git plugin is skipped with a "use `git pull`" hint. `name` given
    // updates that one; omitted updates every registry-managed plugin.
    async update(name?: string): Promise<InstallResult> {
      const n = name == null ? null : validPluginName(name);
      if (name != null && n === null) {
        return { ok: false, error: `plugin '${name}' — invalid name (must be a single path segment)` };
      }
      const targets = name ? [n!] : registryManagedNames();
      if (!targets.length) {
        return { ok: false, error: 'no registry-managed plugins to update' };
      }
      // Single-name update: a skip (git) or a failed fetch is a hard failure.
      if (name) {
        const pluginDir = join(availableDir, n!);
        if (!existsSync(join(pluginDir, 'manifest.json'))) {
          return { ok: false, error: `plugin '${name}' is not installed` };
        }
        const source = sourceFor(pluginDir);
        if (source === 'archive') {
          return { ok: false, error: `plugin '${name}' was installed from an archive — install the newer archive to update it` };
        }
        if (source !== REGISTRY_SOURCE) {
          return { ok: false, error: `plugin '${name}' is a git checkout — use 'git pull' to update` };
        }
        return fetchAndLink(n!);
      }
      // Batch update: re-fetch every registry-managed plugin; a git plugin is
      // skipped with a hint and does not fail the run.
      for (const n of targets) {
        const pluginDir = join(availableDir, n);
        if (sourceFor(pluginDir) !== REGISTRY_SOURCE) continue;
        const res = await fetchAndLink(n);
        if (!res.ok) return { ok: false, error: `update '${n}': ${res.error}` };
      }
      return { ok: true };
    },

    // Lists all plugins from `plugins-available/*/manifest.json`, skipping built-ins.
    async list(): Promise<RepoEntry[]> {
      if (!existsSync(availableDir)) return [];
      const entries: RepoEntry[] = [];
      for (const dirEntry of readdirSync(availableDir, { withFileTypes: true })) {
        if (!dirEntry.isDirectory()) continue;
        const pluginDir = join(availableDir, dirEntry.name);
        const manifest = readManifest(pluginDir);
        // Built-ins live in `plugins/`, not `enabled`, cannot be removed, and are not
        // shown as removable. `RepoEntry` has no `builtin` field, so omit them.
        if (manifest.builtin) continue;
        const entry: RepoEntry = {
          name: manifest.name ?? dirEntry.name,
          version: manifest.version ?? '',
          description: manifest.description ?? '',
          active: existsSync(join(enabledDir, dirEntry.name)),
          missingDeps: missingDepsFor(pluginDir),
          missingSettings: missingSettingsFor(pluginDir),
          source: sourceFor(pluginDir),
        };
        const compat = pluginCompat(manifest, THIS_HOST);
        if (!compat.ok) entry.incompatible = compat.reason;
        if (manifest.surfaces && manifest.surfaces.length) entry.surfaces = manifest.surfaces;
        if (manifest.tools && manifest.tools.length) entry.tools = manifest.tools;
        entries.push(entry);
      }
      // A plugin enabled by a link to somewhere else — kept in a repository of its own —
      // is listed too, with whether this host can load it.
      const inAvailable = (() => { try { return realpathSync(availableDir); } catch { return resolve(availableDir); } })();
      if (existsSync(enabledDir)) {
        for (const name of readdirSync(enabledDir)) {
          const link = join(enabledDir, name);
          if (!lstatSync(link).isSymbolicLink() || entries.some((e) => e.name === name)) continue;
          let target: string;
          try { target = realpathSync(link); } catch { continue; }
          if (target === inAvailable || target.startsWith(`${inAvailable}/`)) continue;
          const manifest = readPluginManifest(target) as Manifest;
          const entry: RepoEntry = {
            name,
            version: typeof manifest.version === 'string' ? manifest.version : '',
            description: typeof manifest.description === 'string' ? manifest.description : '',
            active: true,
            missingDeps: [],
            source: 'linked',
          };
          const compat = pluginCompat(manifest, THIS_HOST);
          if (!compat.ok) entry.incompatible = compat.reason;
          entries.push(entry);
        }
      }
      return entries;
    },

    // Active (enabled) plugin names — the symbols/contents of `plugins-enabled/`.
    async enabledPlugins(): Promise<string[]> {
      if (!existsSync(enabledDir)) return [];
      return readdirSync(enabledDir).filter((n) => lstatSync(join(enabledDir, n)).isSymbolicLink());
    },
  };
}