// Which enabled plugins the person trusts. A plugin in `plugins-enabled/` runs with the
// host's rights (a JS plugin in its process, a remote one as a child with its
// environment), and a command the model runs can put a link there as well as anyone. So
// the host keeps, in its own state (`plugins.trusted.json`, 0600), what it enabled
// itself — per `plugins-enabled/` directory (by its real path), each plugin's name and
// the real path its link led to then — and at start a plugin it did not record is not
// loaded: not imported, not spawned. The start screen and the log say
// `not trusted — flow-assist plugins trust <name>`.
//
// What records a plugin: the person's `plugins install` (a name or an archive) and
// `plugins trust`. Nothing the model does: its `host:plugins_install` leaves the plugin
// untrusted, and a host process started from a command the model runs
// (`FLOW_ASSIST_MODEL_SHELL=1`, src/config/load.ts) never writes the record.
//
// The name and the link's real target, not a hash of the code: an update in place — a
// `git pull`, a kit that unpacks a newer archive over the same directory — keeps the
// plugin trusted. A link that now leads elsewhere is untrusted again. What this does not
// cover is a command editing the code inside a trusted plugin's directory.
//
// The first check of a directory with no record — the first start after this was added
// — trusts every plugin already there, once, and says which (`bootstrapped`): the
// person's own setup keeps loading. Like the settings guard, it stops the accident, not
// intent: a command that writes or deletes the record makes the next start a first
// start.
import fs from 'node:fs';
import path from 'node:path';
import { hostStateDir, inModelShell } from '../config/load.js';

export const pluginTrustPath = (): string => path.join(hostStateDir(), 'plugins.trusted.json');

// Per `plugins-enabled/` directory (its real path): name → the real path its link led to.
type TrustRecord = { dirs: Record<string, Record<string, string>> };

export interface TrustOptions {
  // The record's file; `pluginTrustPath()` when absent.
  file?: string;
  // Whether this process runs inside a command the model runs; the environment when absent.
  modelShell?: boolean;
}

const fileOf = (opts?: TrustOptions) => opts?.file ?? pluginTrustPath();
const modelShellOf = (opts?: TrustOptions) => opts?.modelShell ?? inModelShell();

// The directory's own real path — a directory that does not exist yet is its resolved
// spelling, and nothing is made.
function dirKey(enabledDir: string): string {
  try { return fs.realpathSync(enabledDir); } catch { return path.resolve(enabledDir); }
}

// Where an entry of `plugins-enabled/` really leads; null for one that leads nowhere.
export function pluginTarget(enabledDir: string, name: string): string | null {
  try { return fs.realpathSync(path.join(enabledDir, name)); } catch { return null; }
}

function readRecord(file: string): TrustRecord {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as { dirs?: unknown };
    const dirs = v && typeof v === 'object' && v.dirs && typeof v.dirs === 'object' && !Array.isArray(v.dirs) ? (v.dirs as TrustRecord['dirs']) : {};
    return { dirs };
  } catch { return { dirs: {} }; }
}

function writeRecord(file: string, rec: TrustRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// What the start screen and `plugins ls` say of a plugin the person has not trusted.
export const untrustedText = (name: string): string => `not trusted — flow-assist plugins trust ${name}`;

export interface Untrusted {
  name: string;
  // Where its link leads now, when it was trusted with another target.
  movedTo?: string;
}

export interface TrustCheck {
  trusted: string[];
  untrusted: Untrusted[];
  // The names trusted by this check, as the first one of the directory; null otherwise.
  bootstrapped: string[] | null;
}

// Splits the enabled names into trusted and not. A directory with no record is recorded
// now, every plugin in it trusted — not from a command the model runs, which records
// nothing, so there nothing is trusted until the person's own start.
export function checkPluginTrust(enabledDir: string, names: string[], opts?: TrustOptions): TrustCheck {
  const file = fileOf(opts);
  const rec = readRecord(file);
  const key = dirKey(enabledDir);
  const known = rec.dirs[key];
  if (!known) {
    if (modelShellOf(opts)) return { trusted: [], untrusted: names.map((name) => ({ name })), bootstrapped: null };
    const plugins: Record<string, string> = {};
    for (const name of names) {
      const target = pluginTarget(enabledDir, name);
      if (target) plugins[name] = target;
    }
    rec.dirs[key] = plugins;
    try { writeRecord(file, rec); } catch { /* unrecorded, it is asked again at the next start */ }
    return { trusted: names.filter((n) => n in plugins), untrusted: names.filter((n) => !(n in plugins)).map((name) => ({ name })), bootstrapped: Object.keys(plugins) };
  }
  const trusted: string[] = [];
  const untrusted: Untrusted[] = [];
  for (const name of names) {
    const target = pluginTarget(enabledDir, name);
    const was = Object.prototype.hasOwnProperty.call(known, name) ? known[name] : undefined;
    if (target && was === target) trusted.push(name);
    else untrusted.push(was && target ? { name, movedTo: target } : { name });
  }
  return { trusted, untrusted, bootstrapped: null };
}

export type TrustResult = { ok: true; target: string } | { ok: false; error: string };

// The person's word that a plugin in `plugins-enabled/` may load: its name and where its
// link leads now. Refused from a command the model runs.
export function trustPlugin(enabledDir: string, name: string, opts?: TrustOptions): TrustResult {
  if (modelShellOf(opts)) return { ok: false, error: `plugins trust: a command the assistant runs cannot trust a plugin — run \`flow-assist plugins trust ${name}\` yourself` };
  const n = String(name ?? '').trim();
  if (!n || n === '.' || n === '..' || /[\\/\0]/.test(n)) return { ok: false, error: `plugin '${name}' — invalid name (must be a single path segment)` };
  let exists = true;
  try { fs.lstatSync(path.join(enabledDir, n)); } catch { exists = false; }
  if (!exists) return { ok: false, error: `plugin '${n}' is not in ${enabledDir}` };
  const target = pluginTarget(enabledDir, n);
  if (!target) return { ok: false, error: `plugin '${n}' is a link to something that is gone` };
  const file = fileOf(opts);
  const rec = readRecord(file);
  const key = dirKey(enabledDir);
  rec.dirs[key] = { ...(rec.dirs[key] ?? {}), [n]: target };
  try { writeRecord(file, rec); } catch (e) { return { ok: false, error: `plugins trust: the record could not be written (${(e as Error).message})` }; }
  return { ok: true, target };
}

// A removed plugin is forgotten: a link put back later is not trusted by the old word.
// A removal from a command the model runs forgets too — the safe direction.
export function untrustPlugin(enabledDir: string, name: string, opts?: TrustOptions): void {
  const file = fileOf(opts);
  const rec = readRecord(file);
  const known = rec.dirs[dirKey(enabledDir)];
  if (!known || !(name in known)) return;
  delete known[name];
  try { writeRecord(file, rec); } catch { /* a stale entry trusts only the same target */ }
}
