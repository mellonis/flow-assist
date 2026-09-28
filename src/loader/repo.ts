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
  renameSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { THIS_HOST, pluginCompat, readPluginManifest } from './compat.js';
import { isRemoteManifest } from '../remote/transport.js';
import { DISABLED_DIR, isPluginName, untrustPlugin, type TrustOptions } from './trust.js';

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
  // A link in plugins-enabled/ to something that is gone.
  broken?: boolean;
  // A name that is not a plugin name (./trust.ts, `PLUGIN_NAME`): never loaded.
  refused?: boolean;
  // Installed and turned off by the person: its link waits in `plugins-enabled/.disabled/`.
  disabled?: boolean;
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
  // The trust record the repository forgets a plugin in (a remove, a disable); the
  // host's own when absent.
  trust?: TrustOptions;
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
  // Forgets that a plugin was trusted (./trust.ts).
  untrust(name: string): Promise<void>;
  // Turns an installed plugin off and on again, keeping it installed and its trust: its
  // link moves to `plugins-enabled/.disabled/` and back. The person's, from the app's
  // `:plugins` panel. Absent on a repository made by hand.
  disable?(name: string): Promise<InstallResult>;
  enable?(name: string): Promise<InstallResult>;
  // The names waiting in `plugins-enabled/.disabled/`.
  disabledPlugins?(): Promise<string[]>;
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
// Beside a registry plugin's directory while a newer version is fetched into its place;
// never a plugin of its own.
const PREVIOUS = '.flow-assist-previous';
const REGISTRY_SOURCE = 'registry';

// A plugin name is letters, digits, `.`, `_` and `-`, starting with a letter or digit
// (./trust.ts, `PLUGIN_NAME`): a single path segment that can never traverse out of the
// plugin dirs, and a word a shell reads as it is when the host shows a command naming
// it. Returns the trimmed name when valid, else null.
function validPluginName(name: string): string | null {
  const s = String(name ?? '').trim();
  return isPluginName(s) ? s : null;
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
// plugin in a repository of its own). `remote` — a plugin in another language, run as
// a process (docs/plugins.md); what a manifest IS matters more than how it got here,
// so a remote plugin says `remote` even when it is also `linked`.
export type PluginSource = 'git' | 'registry' | 'archive' | 'linked' | 'remote';

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

// Whether there is an entry at `p`, a link to nothing included.
const entryAt = (p: string): boolean => {
  try { lstatSync(p); return true; } catch { return false; }
};

// `plugins-enabled/.disabled/` is a directory of the host's own, never a link: through a
// link a disable would move a plugin's link wherever it leads, and a listing would read
// another directory as the disabled plugins.
function disabledDirOk(enabledDir: string): boolean {
  try { return !lstatSync(join(enabledDir, DISABLED_DIR)).isSymbolicLink(); } catch { return true; }
}

// Moves a link from `from` to `to`, keeping where it leads: a relative link (an
// installer's `../plugins-available/<name>`) would lead elsewhere from another directory,
// so the new link names the target as the old one resolved it.
function moveLink(from: string, to: string): void {
  const target = resolve(dirname(from), readlinkSync(from));
  mkdirSync(dirname(to), { recursive: true });
  symlinkSync(target, to);
  unlinkSync(from);
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

export function createPluginRepo({ availableDir, enabledDir, projectRoot, fetchPlugin, trust }: PluginRepoOptions): PluginRepo {
  const notLink = `${join(enabledDir, DISABLED_DIR)} is a link, not a directory — remove it`;
  // Registry-managed plugin names: every available plugin whose `.flow-assist-source` says
  // 'registry'. Used by `update(name?)` with no name to re-fetch them all.
  const registryManagedNames = (): string[] => {
    if (!existsSync(availableDir)) return [];
    return readdirSync(availableDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.endsWith(PREVIOUS))
      .filter((d) => sourceFor(join(availableDir, d.name)) === REGISTRY_SOURCE)
      .map((d) => d.name);
  };

  // Downloads a registry plugin into its available dir (marking it 'registry'),
  // then symlinks it into `enabled`. `fetchPlugin` materializes `plugins-available/<name>/`.
  const fetchAndLink = async (name: string): Promise<InstallResult> => {
    const n = validPluginName(name);
    if (!n) return { ok: false, error: `plugin '${name}' — invalid name (letters, digits, . _ - only, starting with a letter or digit)` };
    if (!fetchPlugin) {
      return {
        ok: false,
        error: `plugin '${n}' not available locally and no registry token (set FLOW_ASSIST_PLUGIN_REGISTRY_TOKEN)`,
      };
    }
    const pluginDir = join(availableDir, n);
    // The version there now is set aside while the new one is fetched into its place,
    // and comes back unless the new one arrived AND this host can run it: an update
    // this host cannot load never replaces one that works, and a failed install leaves
    // nothing behind. The link points at the directory, so it follows either way.
    const kept = existsSync(pluginDir) ? `${pluginDir}${PREVIOUS}` : null;
    if (kept) {
      rmSync(kept, { recursive: true, force: true });
      renameSync(pluginDir, kept);
    }
    const restore = () => {
      rmSync(pluginDir, { recursive: true, force: true });
      if (kept) renameSync(kept, pluginDir);
    };
    try {
      await fetchPlugin(n);
      writeSourceMarker(pluginDir);
      const compat = pluginCompat(readPluginManifest(pluginDir), THIS_HOST);
      if (!compat.ok) {
        restore();
        return { ok: false, error: `plugin '${n}': ${compat.reason}${kept ? ' — the installed version is kept' : ''}` };
      }
      if (kept) rmSync(kept, { recursive: true, force: true });
      const enabledLink = join(enabledDir, n);
      mkdirSync(enabledDir, { recursive: true });
      if (!existsSync(enabledLink)) symlinkSync(pluginDir, enabledLink);
      return { ok: true };
    } catch (e) {
      restore();
      return { ok: false, error: (e as Error).message };
    }
  };

  return {
    // Installs a plugin: if the source is present locally, symlink it; if absent and
    // a fetchPlugin is injected, download-then-symlink; otherwise fail cleanly.
    async install(name: string): Promise<InstallResult> {
      const n = validPluginName(name);
      if (!n) return { ok: false, error: `plugin '${name}' — invalid name (letters, digits, . _ - only, starting with a letter or digit)` };
      const pluginDir = join(availableDir, n);
      const enabledLink = join(enabledDir, n);
      if (existsSync(enabledLink)) {
        return { ok: false, error: `plugin '${n}' is already installed` };
      }
      // Installed and turned off: installing it is turning it on again.
      const off = join(enabledDir, DISABLED_DIR, n);
      if (disabledDirOk(enabledDir) && entryAt(off) && !entryAt(enabledLink)) {
        try { moveLink(off, enabledLink); return { ok: true }; } catch (e) { return { ok: false, error: (e as Error).message }; }
      }
      if (existsSync(join(pluginDir, 'manifest.json'))) {
        const compat = pluginCompat(readPluginManifest(pluginDir), THIS_HOST);
        if (!compat.ok) return { ok: false, error: `plugin '${n}': ${compat.reason}` };
        try {
          // plugins-enabled/ is gitignored: a fresh checkout has none, so the first
          // install creates it (`recursive`) rather than failing with ENOENT.
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

    // Removes a plugin: unlinks it from `enabled` and forgets that it was trusted
    // (./trust.ts), so a link put back later is not trusted by the old word. The
    // available dir (and any `.flow-assist-source` marker) is left in place so
    // re-install is instant.
    async remove(name: string): Promise<InstallResult> {
      const n = validPluginName(name);
      if (!n) return { ok: false, error: `plugin '${name}' — invalid name (letters, digits, . _ - only, starting with a letter or digit)` };
      const off = join(enabledDir, DISABLED_DIR, n);
      const enabledLink = entryAt(join(enabledDir, n)) ? join(enabledDir, n) : disabledDirOk(enabledDir) && entryAt(off) ? off : null;
      if (!enabledLink) {
        return { ok: false, error: `plugin '${n}' is not installed` };
      }
      try {
        unlinkSync(enabledLink);
        untrustPlugin(enabledDir, n, trust);
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
        return { ok: false, error: `plugin '${name}' — invalid name (letters, digits, . _ - only, starting with a letter or digit)` };
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
      // skipped with a hint and does not fail the run. One that fails does not stop
      // the rest: each failure is named.
      const failed: string[] = [];
      for (const n of targets) {
        const pluginDir = join(availableDir, n);
        if (sourceFor(pluginDir) !== REGISTRY_SOURCE) continue;
        const res = await fetchAndLink(n);
        if (!res.ok) failed.push(`update '${n}': ${res.error}`);
      }
      return failed.length ? { ok: false, error: failed.join('; ') } : { ok: true };
    },

    // Lists all plugins from `plugins-available/*/manifest.json`, skipping built-ins.
    async list(): Promise<RepoEntry[]> {
      const entries: RepoEntry[] = [];
      for (const dirEntry of existsSync(availableDir) ? readdirSync(availableDir, { withFileTypes: true }) : []) {
        if (!dirEntry.isDirectory() || dirEntry.name.endsWith(PREVIOUS)) continue;
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
          ...(disabledDirOk(enabledDir) && entryAt(join(enabledDir, DISABLED_DIR, dirEntry.name)) ? { disabled: true } : {}),
          missingDeps: missingDepsFor(pluginDir),
          missingSettings: missingSettingsFor(pluginDir),
          source: isRemoteManifest(manifest) ? 'remote' : sourceFor(pluginDir),
        };
        const compat = pluginCompat(readPluginManifest(pluginDir), THIS_HOST);
        if (!compat.ok) entry.incompatible = compat.reason;
        if (manifest.surfaces && manifest.surfaces.length) entry.surfaces = manifest.surfaces;
        if (manifest.tools && manifest.tools.length) entry.tools = manifest.tools;
        entries.push(entry);
      }
      // A plugin enabled by a link to somewhere else — kept in a repository of its own —
      // is listed too, with whether this host can load it.
      const inAvailable = (() => { try { return realpathSync(availableDir); } catch { return resolve(availableDir); } })();
      // The disabled ones are listed the same way, from where they wait.
      const places: Array<[string, boolean]> = [[enabledDir, false], [join(enabledDir, DISABLED_DIR), true]];
      for (const [dir, disabled] of places) {
        if (!existsSync(dir) || (disabled && !disabledDirOk(enabledDir))) continue;
        for (const name of readdirSync(dir)) {
          const link = join(dir, name);
          if (!lstatSync(link).isSymbolicLink() || entries.some((e) => e.name === name)) continue;
          const off = disabled ? { active: false, disabled: true } : { active: true };
          if (!isPluginName(name)) {
            entries.push({ name, version: '', description: '', ...off, missingDeps: [], source: 'linked', refused: true });
            continue;
          }
          let target: string;
          try {
            target = realpathSync(link);
          } catch {
            // A link to something that is gone is said, not left out.
            entries.push({ name, version: '', description: '', ...off, missingDeps: [], source: 'linked', broken: true });
            continue;
          }
          if (target === inAvailable || target.startsWith(`${inAvailable}/`)) continue;
          const parsed = readPluginManifest(target);
          const manifest = (parsed ?? {}) as Manifest;
          const entry: RepoEntry = {
            name,
            version: typeof manifest.version === 'string' ? manifest.version : '',
            description: typeof manifest.description === 'string' ? manifest.description : '',
            ...off,
            missingDeps: [],
            missingSettings: missingSettingsFor(target),
            source: isRemoteManifest(parsed) ? 'remote' : 'linked',
          };
          const compat = pluginCompat(parsed, THIS_HOST);
          if (!compat.ok) entry.incompatible = compat.reason;
          entries.push(entry);
        }
      }
      return entries;
    },

    async disable(name: string): Promise<InstallResult> {
      const n = validPluginName(name);
      if (!n) return { ok: false, error: `plugin '${name}' — invalid name (letters, digits, . _ - only, starting with a letter or digit)` };
      const link = join(enabledDir, n);
      const off = join(enabledDir, DISABLED_DIR, n);
      if (!disabledDirOk(enabledDir)) return { ok: false, error: notLink };
      if (!entryAt(link)) return { ok: false, error: entryAt(off) ? `plugin '${n}' is disabled already` : `plugin '${n}' is not installed` };
      if (!lstatSync(link).isSymbolicLink()) return { ok: false, error: `plugin '${n}' is not a link in ${enabledDir}` };
      if (entryAt(off)) return { ok: false, error: `${off} is there already — remove it first` };
      try {
        moveLink(link, off);
        // A disable forgets the trust as a removal does, keeping where it led: enabling
        // it again never loads it on the old word (./trust.ts).
        untrustPlugin(enabledDir, n, trust);
        return { ok: true };
      } catch (e) { return { ok: false, error: (e as Error).message }; }
    },

    async enable(name: string): Promise<InstallResult> {
      const n = validPluginName(name);
      if (!n) return { ok: false, error: `plugin '${name}' — invalid name (letters, digits, . _ - only, starting with a letter or digit)` };
      const link = join(enabledDir, n);
      const off = join(enabledDir, DISABLED_DIR, n);
      if (!disabledDirOk(enabledDir)) return { ok: false, error: notLink };
      if (entryAt(link)) return { ok: false, error: `plugin '${n}' is enabled already` };
      if (!entryAt(off)) return { ok: false, error: `plugin '${n}' is not installed` };
      try { moveLink(off, link); return { ok: true }; } catch (e) { return { ok: false, error: (e as Error).message }; }
    },

    async disabledPlugins(): Promise<string[]> {
      const dir = join(enabledDir, DISABLED_DIR);
      if (!existsSync(dir) || !disabledDirOk(enabledDir)) return [];
      return readdirSync(dir).filter((n) => isPluginName(n) && lstatSync(join(dir, n)).isSymbolicLink());
    },

    async untrust(name: string): Promise<void> {
      const n = validPluginName(name);
      if (n) untrustPlugin(enabledDir, n, trust);
    },

    // Active (enabled) plugin names — the symbols/contents of `plugins-enabled/`.
    async enabledPlugins(): Promise<string[]> {
      if (!existsSync(enabledDir)) return [];
      return readdirSync(enabledDir).filter((n) => lstatSync(join(enabledDir, n)).isSymbolicLink());
    },
  };
}