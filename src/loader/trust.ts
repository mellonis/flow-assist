// Which enabled plugins the person trusts. A plugin in `plugins-enabled/` runs with the
// host's rights (a JS plugin in its process, a remote one as a child with its
// environment), and a command the model runs can put a link there as well as anyone. So
// the host keeps, in its own state (`plugins.trusted.json`, 0600), what it enabled
// itself — per `plugins-enabled/` directory (by its real path), each plugin's name and
// the real path its link led to then — and at start a plugin it did not record is not
// loaded: not imported, not spawned. The start screen and the log say
// `not trusted — flow-assist plugins trust <name>`, and for a link that leads somewhere
// else than it did, both places.
//
// What records a plugin: the person's `plugins install` (a name or an archive) and
// `plugins trust` — which, for a link whose target changed, shows both and asks first.
// Nothing the model does: its `host:plugins_install` forgets any old word for the name
// and leaves the plugin untrusted, and a host process started from a command the model
// runs (`FLOW_ASSIST_MODEL_SHELL=1`, src/config/load.ts) never writes the record.
//
// The name and the link's real target, not a hash of the code: an update in place — a
// `git pull`, an installer that unpacks a newer archive over the same directory — keeps
// the plugin trusted. What this does not cover is a command editing the code inside a
// trusted plugin's directory.
//
// A plugin's name is letters, digits, `.`, `_` and `-`, starting with a letter or digit
// (`PLUGIN_NAME`): an entry named otherwise is refused, never loaded, and never put into
// a command line shown to the person.
//
// A plugin the person disables (its link moved to `plugins-enabled/.disabled/`) is
// forgotten as a removal is, keeping where it led: enabling it again never trusts it —
// the person's `y` in the `:plugins` panel does, silently while it leads where it did.
//
// The first start — the record MISSING, or written by the host before any start — trusts
// every plugin enabled then, once, and says which (`bootstrapped`); the record then says
// the first start is done, and a `plugins-enabled/` directory seen for the first time
// after that starts with nothing trusted. A record that cannot be read trusts nothing,
// and says so. Like the settings guard it stops the accident, not intent: a command that
// deletes the record makes the next start a first start.
import fs from 'node:fs';
import path from 'node:path';
import { hostStateDir, inModelShell } from '../config/load.js';

export const pluginTrustPath = (): string => path.join(hostStateDir(), 'plugins.trusted.json');

export const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const isPluginName = (name: string): boolean => PLUGIN_NAME.test(name);

// A word as a POSIX shell reads it back: bare when it holds nothing a shell would act
// on, else in single quotes.
export const shellWord = (s: string): string => (/^[A-Za-z0-9._\/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
// A name as it may be SHOWN — a refused one may hold control characters.
export const shownName = (s: string): string => (isPluginName(s) ? s : JSON.stringify(s));

// `firstStartDone`: whether the first start's pass ran. Per directory (real path):
// name → the real path its link led to. `forgotten`, per directory: name → the target
// it was trusted at before it was forgotten (a link gone, a removal, the model's
// install) — a tombstone that never grants trust, only says where the name led, so a
// link put back somewhere else shows both places and `plugins trust` asks. Only the
// person clears it: `plugins trust` (with its yes) or `plugins remove` in the CLI.
type TrustRecord = { firstStartDone: boolean; dirs: Record<string, Record<string, string>>; forgotten: Record<string, Record<string, string>> };
type ReadState = { state: 'missing' | 'ok'; rec: TrustRecord } | { state: 'unreadable'; rec: TrustRecord };

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

// Where the person's disabled plugins wait (`plugins-enabled/.disabled/<name>`, a link
// like the enabled ones): not loaded, and not trusted — a disable forgets the trust. A
// name starting with `.` is never a plugin name, so nothing here is ever taken for a
// plugin.
export const DISABLED_DIR = '.disabled';

// Where an entry of `plugins-enabled/` really leads; null for one that leads nowhere.
export function pluginTarget(enabledDir: string, name: string): string | null {
  try { return fs.realpathSync(path.join(enabledDir, name)); } catch { return null; }
}
const exists = (p: string): boolean => {
  try { fs.lstatSync(p); return true; } catch { return false; }
};
const present = (enabledDir: string, name: string): boolean => exists(path.join(enabledDir, name));

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// Only ENOENT is a first start; anything that does not parse to the record's shape is
// unreadable.
function readRecord(file: string): ReadState {
  const empty = (): TrustRecord => ({ firstStartDone: false, dirs: {}, forgotten: {} });
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing', rec: empty() } : { state: 'unreadable', rec: empty() };
  }
  try {
    const v = JSON.parse(raw) as unknown;
    const forgotten = v && isMap(v) && v.forgotten !== undefined ? v.forgotten : {};
    if (!isMap(v) || typeof v.firstStartDone !== 'boolean' || !isMap(v.dirs) || !isMap(forgotten)) return { state: 'unreadable', rec: empty() };
    for (const d of [...Object.values(v.dirs), ...Object.values(forgotten)]) {
      if (!isMap(d) || Object.values(d).some((t) => typeof t !== 'string')) return { state: 'unreadable', rec: empty() };
    }
    const rec = { firstStartDone: v.firstStartDone, dirs: v.dirs as TrustRecord['dirs'], forgotten: forgotten as TrustRecord['forgotten'] };
    return { state: rec.firstStartDone ? 'ok' : 'missing', rec };
  } catch { return { state: 'unreadable', rec: empty() }; }
}

// An unreadable record is kept beside it before a new one is written in its place.
function writeRecord(file: string, rec: TrustRecord, replacingUnreadable = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (replacingUnreadable) {
    try { fs.renameSync(file, `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`); } catch { /* gone meanwhile */ }
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Moves a trusted name to the tombstones of its directory.
function forget(rec: TrustRecord, key: string, name: string): boolean {
  const known = rec.dirs[key];
  if (!known || !(name in known)) return false;
  rec.forgotten[key] = { ...(rec.forgotten[key] ?? {}), [name]: known[name]! };
  delete known[name];
  return true;
}

// The command that trusts a plugin, as the person would type it.
export const trustCommand = (name: string): string => `flow-assist plugins trust ${shellWord(name)}`;
// What the start screen, the log and `plugins ls` say of a plugin not trusted.
export const untrustedText = (u: Untrusted | string): string => {
  const x = typeof u === 'string' ? { name: u } : u;
  if (x.refused) return 'refused — a plugin name is letters, digits, . _ - only';
  return x.was && x.now ? `not trusted — its link led to ${x.was}, now to ${x.now} — ${trustCommand(x.name)}` : `not trusted — ${trustCommand(x.name)}`;
};
// What the start screen says when the record cannot be read.
export const unreadableTrustText = (file: string): string => `${file} cannot be read — no plugin is trusted; trust each with flow-assist plugins trust <name> (the file is then replaced, its old text kept beside it)`;

export interface Untrusted {
  name: string;
  // Where its link led when it was trusted, and where it leads now.
  was?: string;
  now?: string;
  // A name that is not a plugin name: never loaded, no command shown.
  refused?: boolean;
}

export interface TrustCheck {
  trusted: string[];
  untrusted: Untrusted[];
  // The names trusted by this check, as the first start; null otherwise.
  bootstrapped: string[] | null;
  // The record could not be read: nothing is trusted.
  unreadable: string | null;
}

// Splits the enabled names into trusted and not. The first start (no record) trusts
// every plugin enabled now and records that it ran — not from a command the model runs,
// which records nothing and trusts nothing. An entry whose link is gone is forgotten, so
// a link put back later is not trusted by the old word. `readOnly` records nothing at
// all (`plugins ls`): before the first start it trusts what the first start would.
export function checkPluginTrust(enabledDir: string, names: string[], opts?: TrustOptions & { readOnly?: boolean }): TrustCheck {
  const file = fileOf(opts);
  const { state, rec } = readRecord(file);
  const key = dirKey(enabledDir);
  const valid = names.filter(isPluginName);
  const refused: Untrusted[] = names.filter((n) => !isPluginName(n)).map((name) => ({ name, refused: true }));
  if (state === 'unreadable') {
    return { trusted: [], untrusted: [...refused, ...valid.map((name) => ({ name }))], bootstrapped: null, unreadable: file };
  }
  if (state === 'missing') {
    if (modelShellOf(opts)) return { trusted: [], untrusted: [...refused, ...valid.map((name) => ({ name }))], bootstrapped: null, unreadable: null };
    const plugins: Record<string, string> = { ...(rec.dirs[key] ?? {}) };
    for (const name of valid) {
      const target = pluginTarget(enabledDir, name);
      if (target) plugins[name] = target;
    }
    const trusted = valid.filter((n) => n in plugins);
    if (!opts?.readOnly) {
      rec.dirs[key] = plugins;
      rec.firstStartDone = true;
      try { writeRecord(file, rec); } catch { /* unrecorded, the next start is the first again */ }
    }
    return { trusted, untrusted: [...refused, ...valid.filter((n) => !(n in plugins)).map((name) => ({ name }))], bootstrapped: opts?.readOnly ? null : trusted, unreadable: null };
  }
  const known = rec.dirs[key] ?? {};
  // Forget what is no longer there — a link removed by hand, by an installer, by git —
  // keeping where it led as a tombstone.
  const gone = Object.keys(known).filter((n) => !present(enabledDir, n));
  if (gone.length && !opts?.readOnly) {
    rec.dirs[key] = known;
    for (const n of gone) forget(rec, key, n);
    try { writeRecord(file, rec); } catch { /* a stale entry trusts only the same target */ }
  }
  const tomb = rec.forgotten[key] ?? {};
  const own = (m: Record<string, string>, n: string) => (Object.prototype.hasOwnProperty.call(m, n) ? m[n] : undefined);
  const trusted: string[] = [];
  const untrusted: Untrusted[] = [...refused];
  for (const name of valid) {
    const target = pluginTarget(enabledDir, name);
    const trustedAt = own(known, name);
    if (target && trustedAt === target) { trusted.push(name); continue; }
    const was = trustedAt ?? own(tomb, name);
    untrusted.push(was && target && was !== target ? { name, was, now: target } : { name });
  }
  return { trusted, untrusted, bootstrapped: null, unreadable: null };
}

// Where a plugin's link leads now and what the record says of it, read only: `recorded`
// — the target it is trusted at; `forgotten` — its tombstone. It is trusted when
// `target` equals `recorded`. A record that cannot be read, or none, trusts nothing: a
// load while the app runs never runs the first start.
export interface PluginTrustState { name: string; target: string | null; recorded?: string; forgotten?: string }
export function pluginTrustOf(enabledDir: string, name: string, opts?: TrustOptions): PluginTrustState {
  const target = isPluginName(name) ? pluginTarget(enabledDir, name) : null;
  const { state, rec } = readRecord(fileOf(opts));
  if (state !== 'ok') return { name, target };
  const key = dirKey(enabledDir);
  const own = (m: Record<string, string> | undefined) => (m && Object.prototype.hasOwnProperty.call(m, name) ? m[name] : undefined);
  const recorded = own(rec.dirs[key]);
  const forgotten = own(rec.forgotten[key]);
  return { name, target, ...(recorded ? { recorded } : {}), ...(forgotten ? { forgotten } : {}) };
}
export const isTrustedNow = (s: PluginTrustState): boolean => !!s.target && s.recorded === s.target;
// The start screen's word for a plugin that is not trusted now.
export function untrustedOf(s: PluginTrustState): Untrusted {
  const was = s.recorded ?? s.forgotten;
  return was && s.target && was !== s.target ? { name: s.name, was, now: s.target } : { name: s.name };
}

export type TrustResult =
  | { ok: true; target: string; was?: string }
  | { ok: false; error: string; confirm?: { was: string; now: string } };

// The person's word that a plugin in `plugins-enabled/` may load: its name and where its
// link leads now. Refused from a command the model runs. A name trusted before with
// another target is not recorded without `yes`: the answer says both targets and asks.
export function trustPlugin(enabledDir: string, name: string, opts?: TrustOptions & { yes?: boolean }): TrustResult {
  const n = String(name ?? '').trim();
  if (modelShellOf(opts)) return { ok: false, error: `plugins trust: a command the assistant runs cannot trust a plugin — run \`${trustCommand(n)}\` yourself` };
  if (!isPluginName(n)) return { ok: false, error: `plugins trust: ${shownName(n)} is not a plugin name — letters, digits, . _ - only, starting with a letter or digit` };
  if (!present(enabledDir, n)) return { ok: false, error: `plugin '${n}' is not in ${enabledDir}` };
  const target = pluginTarget(enabledDir, n);
  if (!target) return { ok: false, error: `plugin '${n}' is a link to something that is gone` };
  const file = fileOf(opts);
  const { state, rec } = readRecord(file);
  const key = dirKey(enabledDir);
  const was = rec.dirs[key]?.[n] ?? rec.forgotten[key]?.[n];
  if (was && was !== target && !opts?.yes) {
    return { ok: false, error: `plugin '${n}' was trusted at ${was}; its link now leads to ${target}`, confirm: { was, now: target } };
  }
  // An unreadable record is replaced: from now on it holds what the person trusts one by
  // one, and the first start is not run again.
  if (state === 'unreadable') rec.firstStartDone = true;
  rec.dirs[key] = { ...(rec.dirs[key] ?? {}), [n]: target };
  if (rec.forgotten[key]) delete rec.forgotten[key][n];
  try { writeRecord(file, rec, state === 'unreadable'); } catch (e) { return { ok: false, error: `plugins trust: the record could not be written (${(e as Error).message})` }; }
  return { ok: true, target, ...(was && was !== target ? { was } : {}) };
}

// Forgets a plugin: a link put back later is not trusted by the old word, and its old
// target stays as a tombstone (above). From a command the model runs too — the safe
// direction. `clear` — the person's own `plugins remove` — drops the tombstone as well.
export function untrustPlugin(enabledDir: string, name: string, opts?: TrustOptions & { clear?: boolean }): void {
  const file = fileOf(opts);
  const { state, rec } = readRecord(file);
  if (state === 'unreadable') return;
  const key = dirKey(enabledDir);
  let changed = forget(rec, key, name);
  if (opts?.clear && rec.forgotten[key] && name in rec.forgotten[key]) { delete rec.forgotten[key][name]; changed = true; }
  if (!changed) return;
  try { writeRecord(file, rec); } catch { /* a stale entry trusts only the same target */ }
}
