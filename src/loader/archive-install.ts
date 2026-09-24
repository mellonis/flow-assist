// Installing a plugin from an archive: `plugins install ./notes-0.1.0.tar.gz` or
// `plugins install https://…/notes-0.1.0.tar.gz`. The archive is what
// `plugin:publish` packs (`packPlugin`): a gzipped tar with one top-level `<name>/`
// holding the plugin's manifest.json. It lets a plugin travel without a registry —
// attached to a release, handed over as a file.
//
// An archive is code from outside, so it is looked at before anything is written:
// its member list is read first, and an archive with an absolute path, a `..`, a
// link, or more than one top-level directory is refused unread. Only then is it
// extracted — into a temporary directory, never straight into plugins-available/ —
// and the plugin moved into place once its manifest agrees with its directory.
//
// Only the CLI calls this. The model's `host:plugins_install` takes a plugin name:
// a URL in a tool argument may come from any page the model has read.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstallResult } from './repo.js';
import { THIS_HOST, pluginCompat } from './compat.js';

// The provenance marker (repo.ts's `SOURCE_MARKER`): `archive` tells `list` and
// `update` the plugin came from a file, so a newer file is how it is updated.
const SOURCE_MARKER = '.flow-assist-source';
export const ARCHIVE_SOURCE = 'archive';
// tar's stderr is caught, not printed: a refusal is said once, in our words.
const QUIET = { stdio: ['ignore', 'pipe', 'pipe'] as ('ignore' | 'pipe')[] };

export interface ArchiveInstallOptions {
  availableDir: string;
  enabledDir: string;
  // Injectable transport for a URL source (default `globalThis.fetch`).
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface ArchiveInstallResult extends InstallResult {
  name?: string;
  version?: string;
  replaced?: boolean;
  // The version replaced, when it differs from the new one and its manifest
  // still parsed — absent on a fresh install or when the old version is unknown.
  previousVersion?: string;
}

// Is this `plugins install` argument an archive rather than a plugin name? A URL,
// or a path ending in .tar.gz / .tgz. (A plugin name is one path segment without
// such an ending.)
export function isArchiveSource(arg: string): boolean {
  return /^https?:\/\//i.test(arg) || /\.(tar\.gz|tgz)$/i.test(arg);
}

// The archive's member list, checked. Returns the one top-level directory — the
// plugin's name — or throws saying what is wrong. `tar -tvzf` is read for the link
// check (its lines start with the mode: `l` a symlink, `h` or "link to" a hardlink,
// in GNU tar and bsdtar alike); `tar -tzf` gives the bare names.
function checkMembers(archive: string): string {
  const names = execFileSync('tar', ['-tzf', archive], { ...QUIET, encoding: 'utf8' }).split('\n').filter(Boolean);
  const verbose = execFileSync('tar', ['-tvzf', archive], { ...QUIET, encoding: 'utf8' }).split('\n').filter(Boolean);
  if (!names.length) throw new Error('the archive is empty');
  if (verbose.some((line) => /^[lh]/.test(line) || / link to /.test(line))) {
    throw new Error('the archive holds a link — a plugin archive has files and directories only');
  }
  const tops = new Set<string>();
  for (const name of names) {
    const parts = name.replace(/^\.\//, '').split('/').filter(Boolean);
    if (name.startsWith('/') || parts.includes('..')) throw new Error(`the archive has a path outside its directory: ${name}`);
    if (parts.length) tops.add(parts[0]!);
  }
  if (tops.size !== 1) throw new Error(`a plugin archive has one top-level directory, this one has ${tops.size}`);
  const top = [...tops][0]!;
  if (top === '.' || top.includes('\\')) throw new Error(`the archive's directory is not a plugin name: ${top}`);
  return top;
}

// A URL is downloaded to a temporary file first, so a URL and a file are checked
// the same way.
async function localArchive(source: string, work: string, fetchImpl: ArchiveInstallOptions['fetch']): Promise<string> {
  if (!/^https?:\/\//i.test(source)) {
    if (!existsSync(source)) throw new Error(`no such file: ${source}`);
    return source;
  }
  if (!/^https:\/\//i.test(source)) throw new Error('a plugin is downloaded over https only');
  const res = await (fetchImpl ?? globalThis.fetch)(source);
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status}): ${source}`);
  const file = join(work, 'plugin.tar.gz');
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

// The source marker of an existing plugin directory ('' when it has none — a git
// checkout, or a plugin put there by hand).
function sourceOf(pluginDir: string): string {
  const marker = join(pluginDir, SOURCE_MARKER);
  return existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '';
}

// The version an already-installed plugin directory names, for the "replaced"
// note ('' when its manifest is missing or will not parse — never a reason to
// refuse the new install).
function versionOf(pluginDir: string): string {
  try {
    const m = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf8')) as { version?: unknown };
    return typeof m.version === 'string' ? m.version : '';
  } catch {
    return '';
  }
}

export async function installPluginArchive(source: string, opts: ArchiveInstallOptions): Promise<ArchiveInstallResult> {
  const work = mkdtempSync(join(tmpdir(), 'flow-assist-plugin-'));
  try {
    const archive = await localArchive(source, work, opts.fetch);
    let name: string;
    try {
      name = checkMembers(archive);
    } catch (e) {
      const why = (e as Error).message;
      // tar's own complaint (not a gzip, a broken file) is long and says little.
      throw new Error(/^Command failed/.test(why) ? 'not a plugin archive (a .tar.gz)' : why);
    }
    const unpacked = join(work, 'unpacked');
    mkdirSync(unpacked);
    execFileSync('tar', ['-xzf', archive, '-C', unpacked], QUIET);

    const staged = join(unpacked, name);
    const manifestFile = join(staged, 'manifest.json');
    if (!existsSync(manifestFile)) throw new Error(`no manifest.json in ${name}/ — not a plugin archive`);
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    } catch {
      throw new Error(`${name}/manifest.json is not valid JSON`);
    }
    if (manifest.name !== undefined && manifest.name !== name) {
      throw new Error(`the manifest names '${String(manifest.name)}', the archive's directory is '${name}'`);
    }
    const version = typeof manifest.version === 'string' ? manifest.version : '';
    // One this host cannot load is refused here, before anything is moved into place.
    const compat = pluginCompat(manifest, THIS_HOST);
    if (!compat.ok) throw new Error(`plugin '${name}' is ${compat.reason}`);

    // A plugin already there is replaced only when it came from an archive too: a
    // git checkout or a registry download is someone's to update their own way.
    const target = join(opts.availableDir, name);
    let replaced = false;
    let previousVersion = '';
    if (existsSync(target)) {
      const from = sourceOf(target);
      if (from !== ARCHIVE_SOURCE) {
        const what = from === 'registry' ? 'from the registry — use `plugins update`' : 'a checkout — update it with git';
        throw new Error(`plugin '${name}' is already in plugins-available, ${what}`);
      }
      previousVersion = versionOf(target);
      rmSync(target, { recursive: true, force: true });
      replaced = true;
    }
    writeFileSync(join(staged, SOURCE_MARKER), `${ARCHIVE_SOURCE}\n`, 'utf8');
    mkdirSync(opts.availableDir, { recursive: true });
    try {
      renameSync(staged, target);
    } catch {
      // The temporary directory may be on another volume, where a rename fails.
      execFileSync('cp', ['-R', staged, target]);
    }
    const link = join(opts.enabledDir, name);
    mkdirSync(opts.enabledDir, { recursive: true });
    // lstat, not exists: a link left dangling by a removed plugin still occupies the name.
    try { lstatSync(link); } catch { symlinkSync(target, link); }
    return { ok: true, name, version, replaced, ...(replaced && previousVersion && previousVersion !== version ? { previousVersion } : {}) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
