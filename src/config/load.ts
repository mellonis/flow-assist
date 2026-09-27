import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appliesOnRestart, hostConfigSchema, isLeashKey, modelMaySave, modelMaySet } from './schema.js';
import { llmOpts } from '../assistant/llm-endpoint.js';
import { redactSecrets, refreshSecrets } from '../assistant/secrets.js';

// Config files live outside the repo, under the user's home config dir (or the
// XDG override). config.json is the committed/default base; config.local.json
// holds machine-specific overrides and is the only file the write helpers touch.
// One place decides where flow-assist keeps its files: a `flow-assist` folder
// under XDG_CONFIG_HOME (or ~/.config). Never XDG_CONFIG_HOME itself — that is
// everybody's directory.
export function configDir(env: Record<string, string | undefined> = process.env, home: string = os.homedir()): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'flow-assist');
}

// Where the host keeps what it writes FOR ITSELF — the memory, the cache, the tool
// log, the settings `config set` saves — and where the settings are read from.
// Normally that is the config directory. Under `bun test` it is a temporary
// directory of this process instead, the same protection the sessions already have
// (`sessionsDir` → null): a test that names no file of its own must never add to the
// person's memory, empty their cache, rewrite their settings or run with them. It is
// made once per process and never reused from a previous run, so nothing a run
// writes is read back by the next one.
//
// Resolve it on every call. An import-time constant is fixed before a test can point
// the directory anywhere, which is how every test that reached the `memory` tool wrote
// into the person's own `memory.json` — 32 copies of one fact.
let TEST_STATE_DIR: string | null = null;
export function hostStateDir(env: Record<string, string | undefined> = process.env): string {
  if (env.NODE_ENV !== 'test') return configDir(env);
  return (TEST_STATE_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'flow-assist-test-state-')));
}

// The two settings files, resolved on every call through `hostStateDir`, as every
// other file the host keeps: a read and a write of the same setting reach the same
// file, and under `bun test` neither reaches the person's.
const configPath = (): string => path.join(hostStateDir(), 'config.json');
const configLocalPath = (): string => path.join(hostStateDir(), 'config.local.json');

type WriteResult = { ok: true; value: unknown } | { ok: false; error: string };

// Recursively merges `local` into `base`. Plain objects merge deep; arrays and
// scalars from `local` replace the base value. Both sides are treated as
// records; null/undefined `local` is a no-op.
function deepMerge(base: Record<string, unknown>, local: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(local ?? {})) {
    if (
      v && typeof v === 'object' && !Array.isArray(v)
      && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Reads and parses a JSON config file. Returns null on a missing/unreadable
// file (ENOENT/ENOTDIR) or invalid JSON — the config layer never throws, so
// `loadConfig` always returns a usable default.
function readConfigFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// A host config file must be a JSON object. Coerce any other parsed shape (a
// bare string/array, or a null from a parse failure) to null so `loadConfig`
// never spreads garbage (arrays/strings iterate per-index) into the base.
function asConfigObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

// ─── The session scope ───────────────────────────────────────────────────────
// `config set --session <key> <value>` changes a setting for this run only: the value
// goes into this map, never into a file, and a new run starts without it. The map is
// laid over what `loadConfig()` merges — one point every reader passes through — and
// over the config object the running app holds (`setConfigValue`), so the commands,
// a plugin's `host.config` and the model's tools all see the same value.
//
// It is the process's: `renderApp` resets it as an app starts, which is what gives
// every app the scripted rig boots in one process an empty session of its own (two
// apps alive in one process at once share it). A test that sets a session value
// outside an app resets it itself.
let SESSION = new Map<string, unknown>();

// Forgets every session value — an app starting.
export function resetSessionConfig(): void {
  SESSION = new Map();
}

// Where a value comes from, for `config get`: the session, config.local.json,
// config.json, or neither (the consumer's own default).
export type ConfigSource = 'session' | 'local' | 'config' | 'default';

// The two files as `loadConfig()` read them, kept per loaded object, so `config get`
// names a value's source without reading the files a second time. Clones: nothing
// laid over the merged result may reach them.
type ConfigLayers = { base: Record<string, unknown>; local: Record<string, unknown> };
const LAYERS = new WeakMap<object, ConfigLayers>();

// ─── The guard ───────────────────────────────────────────────────────────────
// Config is the person's, and a command the model runs can write a file as well as
// anyone. So the host keeps, in its own state (`config.accepted.json`, 0600), the text
// hash and the content of each settings file as it last ACCEPTED it — its own writes,
// the CLI's `config set` among them, and a change the person said yes to — and in
// memory what it last read or wrote (`SEEN`: mtime, size, hash, content).
// - At a start (`loadConfig`, unarmed) a file whose hash is the accepted one is read as
//   it is. One that differs is NOT applied: the accepted content is served instead —
//   the app then asks about it (the guard, below); the CLI and the one-shot prompt say
//   why (`configStartupNotes`). With no record yet (a first start) the files are
//   accepted as they are.
// - Once the running app arms the guard (`guardConfigFiles`, in `runInteractive`),
//   `loadConfig` serves `SEEN` only, and `checkConfigFiles` — a stat per file, the file
//   read only when the stat moved — reports a change the host did not make, with the
//   keys it changes; the chat asks the person. Yes applies it and accepts it
//   (`applyConfigChange`); no puts the accepted content back into the file and keeps the
//   rejected text beside it, `<file>.rejected-<time>`, 0600 (`declineConfigChange`), so
//   a restart — a `kill` included — starts on the accepted config.
// - A write of the host's is made on top of the accepted content; a file that held
//   something else has that text kept beside it first, never lost.
type Seen = { mtimeMs: number; size: number; hash: string; content: Record<string, unknown> | null };
const SEEN = new Map<string, Seen>();
const PENDING = new Map<string, ConfigChange>();
const DECLINED = new Map<string, { mtimeMs: number; size: number; hash: string }>();
let GUARDED = false;

// The accepted record: per file name, the hash of its text and the object it held.
type Accepted = { hash: string; content: Record<string, unknown> | null };
export const acceptedConfigPath = (): string => path.join(hostStateDir(), 'config.accepted.json');
function readAccepted(): Record<string, Accepted> {
  try {
    const v = JSON.parse(fs.readFileSync(acceptedConfigPath(), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function recordAccepted(p: string, a: Accepted): void {
  try {
    const all = readAccepted();
    all[path.basename(p)] = a;
    const file = acceptedConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* the record is best-effort; the file itself was written */ }
}
// Keeps a settings file's text beside it before the host puts other content there.
function keepRejected(p: string, raw: string): string | null {
  try {
    const kept = `${p}.rejected-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.writeFileSync(kept, raw, { mode: 0o600, flag: 'wx' });
    return kept;
  } catch { return null; }
}

// A change to a settings file the host did not make: which file, the keys it changes
// and a line per key saying how (`key: old → new`, a value at a secret-looking key
// masked).
export interface ConfigChange {
  file: 'config.json' | 'config.local.json';
  path: string;
  keys: string[];
  lines: string[];
  hash: string;
  mtimeMs: number;
  size: number;
  content: Record<string, unknown> | null;
  raw: string | null;
}

const hashOf = (text: string | null): string => (text === null ? 'missing' : crypto.createHash('sha256').update(text).digest('hex'));
const statOf = (p: string): { mtimeMs: number; size: number } => {
  try { const s = fs.statSync(p); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return { mtimeMs: -1, size: -1 }; }
};
const readRaw = (p: string): string | null => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const parseObject = (raw: string | null): Record<string, unknown> | null => {
  if (raw === null) return null;
  try { return asConfigObject(JSON.parse(raw)); } catch { return null; }
};
// The stat is taken BEFORE the read: a write landing between them is then a state the
// host never saw, and the next check reports it.
function observe(p: string): Seen {
  const st = statOf(p);
  const raw = readRaw(p);
  return { ...st, hash: hashOf(raw), content: parseObject(raw) };
}
const guardedPaths = (): string[] => [configPath(), configLocalPath()];
const isGuardedPath = (p: string): boolean => guardedPaths().includes(p);

// Arms the guard: from now on the settings files are served as the host last read or
// wrote them. The running app arms it after its start has read the config.
export function guardConfigFiles(): void {
  GUARDED = true;
  for (const p of guardedPaths()) if (!SEEN.has(p)) SEEN.set(p, observe(p));
}
// Disarms it and forgets what was seen — a test's cleanup.
export function unguardConfigFiles(): void {
  GUARDED = false;
  SEEN.clear();
  PENDING.clear();
  DECLINED.clear();
}

// A value as the change's line shows it: masked at a secret-looking key, a known
// secret redacted, cut short.
const MASK_KEY = /TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|API_?KEY|_KEY$|^authorization$|^headers$|^env$/i;
function shownValue(key: string, v: unknown): string {
  if (v === undefined) return '(unset)';
  if (key.split('.').some((seg) => MASK_KEY.test(seg))) return '‹masked›';
  const s = redactSecrets(JSON.stringify(v) ?? String(v));
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// The leaf keys whose values differ between two objects, sorted.
function changedKeys(a: unknown, b: unknown, prefix = ''): string[] {
  if (isPlain(a) || isPlain(b)) {
    const x = isPlain(a) ? a : {};
    const y = isPlain(b) ? b : {};
    if (!isPlain(a) && a !== undefined) return [prefix];
    if (!isPlain(b) && b !== undefined) return [prefix];
    return [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()
      .flatMap((k) => changedKeys(x[k], y[k], prefix ? `${prefix}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix];
}

// Whether the file at `p` holds something the host did not accept: the change, or null.
function checkFile(p: string): ConfigChange | null {
  const seen = SEEN.get(p) ?? observe(p);
  if (!SEEN.has(p)) SEEN.set(p, seen);
  const st = statOf(p);
  if (st.mtimeMs === seen.mtimeMs && st.size === seen.size) { PENDING.delete(p); return null; }
  const pending = PENDING.get(p);
  if (pending && pending.mtimeMs === st.mtimeMs && pending.size === st.size) return pending;
  const declined = DECLINED.get(p);
  if (declined && declined.mtimeMs === st.mtimeMs && declined.size === st.size) return null;
  const raw = readRaw(p);
  const hash = hashOf(raw);
  if (hash === seen.hash) {
    // Touched, not changed: the same text under a new stat.
    SEEN.set(p, { ...seen, ...st });
    PENDING.delete(p);
    return null;
  }
  if (declined?.hash === hash) { DECLINED.set(p, { ...st, hash }); return null; }
  const content = parseObject(raw);
  const keys = changedKeys(seen.content ?? {}, content ?? {});
  const lines = keys.map((k) => `${k}: ${shownValue(k, getDeep(seen.content ?? {}, k))} → ${shownValue(k, getDeep(content ?? {}, k))}`);
  if (raw !== null && content === null) lines.push('the file does not hold a JSON object — applied, it reads as empty');
  if (!keys.length && !lines.length) { SEEN.set(p, { ...st, hash, content }); PENDING.delete(p); return null; }
  const change: ConfigChange = { file: path.basename(p) as ConfigChange['file'], path: p, keys, lines, hash, ...st, content, raw };
  PENDING.set(p, change);
  return change;
}

// Every settings file that holds a change the host did not make and the person has not
// answered — a stat per file when nothing changed. Empty while the guard is not armed.
export function checkConfigFiles(): ConfigChange[] {
  if (!GUARDED) return [];
  return guardedPaths().map(checkFile).filter((c): c is ConfigChange => c !== null);
}

// Yes: the change is accepted and laid on `config` — the running app's — key by key,
// but a key read at start (`appliesOnRestart`) waits for the restart. Returns which.
export function applyConfigChange(
  config: Record<string, unknown>,
  change: ConfigChange,
  opts: { rootSchema?: unknown; pluginConfigs?: Record<string, unknown> } = {},
): { applied: string[]; restart: string[] } {
  SEEN.set(change.path, { mtimeMs: change.mtimeMs, size: change.size, hash: change.hash, content: change.content });
  recordAccepted(change.path, { hash: change.hash, content: change.content });
  PENDING.delete(change.path);
  DECLINED.delete(change.path);
  const layers = LAYERS.get(config);
  if (layers) {
    if (change.file === 'config.json') layers.base = structuredClone(change.content ?? {});
    else layers.local = structuredClone(change.content ?? {});
  }
  const merged = deepMerge(structuredClone(SEEN.get(configPath())?.content ?? {}), structuredClone(SEEN.get(configLocalPath())?.content ?? {}));
  for (const [k, v] of SESSION) setDeep(merged, k, structuredClone(v));
  const applied: string[] = [];
  const restart: string[] = [];
  for (const key of change.keys) {
    if (configMarks(opts.rootSchema ?? hostConfigSchema, key, opts.pluginConfigs).restart) { restart.push(key); continue; }
    const v = getDeep(merged, key);
    if (v === undefined) unsetDeep(config, key);
    else setDeep(config, key, structuredClone(v));
    applied.push(key);
  }
  refreshSecrets(configValueView(config));
  return { applied, restart };
}

// No: the accepted content goes back into the file — the host's own write — and the
// rejected text is kept beside it; returns where. Should the file not be writable, the
// running config still stays as it is and this content is not asked about again.
export function declineConfigChange(change: ConfigChange): string | null {
  PENDING.delete(change.path);
  const accepted = SEEN.get(change.path);
  const kept = change.raw !== null ? keepRejected(change.path, change.raw) : null;
  try {
    if (!accepted || accepted.hash === 'missing') {
      fs.rmSync(change.path, { force: true });
      SEEN.set(change.path, observe(change.path));
      recordAccepted(change.path, { hash: 'missing', content: null });
    } else {
      writeSettings(change.path, accepted.content ?? {}, { rejectedKept: true });
    }
  } catch {
    DECLINED.set(change.path, { mtimeMs: change.mtimeMs, size: change.size, hash: change.hash });
  }
  return kept;
}

// The start's own word on a settings file that changed since it was last accepted,
// for a caller with no chat to ask in (the CLI, the one-shot prompt): the file is not
// used, and this says why. Empty when nothing changed.
export function configStartupNotes(): string[] {
  const out: string[] = [];
  for (const p of guardedPaths()) {
    const seen = SEEN.get(p);
    if (!seen || !Number.isNaN(seen.mtimeMs)) continue;
    const change = checkFile(p);
    if (change) out.push(`flow-assist: ${change.file} changed outside flow-assist since it was last accepted (${change.keys.join(', ') || 'unreadable'}) — not used; start flow-assist to review it`);
  }
  return out;
}

// A settings file as the host reads it: armed, the accepted content (and a check that
// reports a change); otherwise the file as it is, recorded.
function readSettings(p: string): Record<string, unknown> | null {
  if (!isGuardedPath(p)) return asConfigObject(readConfigFile(p));
  if (GUARDED) {
    checkFile(p);
    const c = SEEN.get(p)?.content;
    return c ? structuredClone(c) : null;
  }
  const seen = observe(p);
  const accepted = readAccepted()[path.basename(p)];
  if (!accepted || accepted.hash === seen.hash) {
    if (!accepted) recordAccepted(p, { hash: seen.hash, content: seen.content });
    SEEN.set(p, seen);
    return seen.content ? structuredClone(seen.content) : null;
  }
  // Changed since it was accepted: the accepted content is what is served, and a stat
  // that can match no file (NaN) makes the next check report the change.
  SEEN.set(p, { mtimeMs: Number.NaN, size: -1, hash: accepted.hash, content: accepted.content });
  return accepted.content ? structuredClone(accepted.content) : null;
}

// What a save starts from: for a settings file, the accepted content — a write of the
// host's must never carry in a change it did not accept — else the file.
function settingsBase(filePath: string): Record<string, unknown> {
  if (isGuardedPath(filePath)) {
    if (!SEEN.has(filePath)) readSettings(filePath);
    return structuredClone(SEEN.get(filePath)?.content ?? {});
  }
  const current = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {};
  return current && typeof current === 'object' ? current : {};
}
// Writes a settings file and records it as seen and accepted: the host's own write. A
// file that held text other than the accepted has it kept beside it first.
function writeSettings(filePath: string, next: Record<string, unknown>, opts: { rejectedKept?: boolean } = {}): void {
  const text = JSON.stringify(next, null, 2);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (isGuardedPath(filePath) && !opts.rejectedKept) {
    const raw = readRaw(filePath);
    if (raw !== null && hashOf(raw) !== SEEN.get(filePath)?.hash) keepRejected(filePath, raw);
  }
  fs.writeFileSync(filePath, text, 'utf8');
  if (isGuardedPath(filePath)) {
    SEEN.set(filePath, { ...statOf(filePath), hash: hashOf(text), content: structuredClone(next) });
    recordAccepted(filePath, { hash: hashOf(text), content: structuredClone(next) });
    PENDING.delete(filePath);
    DECLINED.delete(filePath);
  }
}

// Loads the effective host config: config.json deep-merged with the local
// overrides in config.local.json, and the session's values laid over both. Missing
// files simply fall back to the other side (or an empty object), never throwing.
// `localPath` swaps the local overrides file — tests point it at a temp file.
// `session: false` reads the files alone — for a caller that writes the result back to
// a file, which must never carry a session value into it. With the guard armed each
// file is what the host last accepted (above).
export function loadConfig(opts?: { localPath?: string; session?: boolean }): Record<string, unknown> {
  const base = readSettings(configPath()) ?? {};
  const local = readSettings(opts?.localPath ?? configLocalPath()) ?? {};
  const merged = deepMerge(structuredClone(base), structuredClone(local));
  if (opts?.session !== false) for (const [key, value] of SESSION) setDeep(merged, key, structuredClone(value));
  LAYERS.set(merged, { base, local });
  return merged;
}

// Whether the session holds `key`, a key above it or one under it — then the value
// read at `key` is the session's, in part or whole.
function sessionHolds(key: string): boolean {
  for (const k of SESSION.keys()) {
    if (k === key || key.startsWith(`${k}.`) || k.startsWith(`${key}.`)) return true;
  }
  return false;
}

// The layers of a config the caller built itself are started at its first write:
// what it held then is its base, and what is saved from then on is `local`.
function layersOf(config: Record<string, unknown>): ConfigLayers {
  let layers = LAYERS.get(config);
  if (!layers) {
    let base: Record<string, unknown> = {};
    try { base = JSON.parse(JSON.stringify(config)) as Record<string, unknown>; } catch { /* not plain data — no base */ }
    layers = { base, local: {} };
    LAYERS.set(config, layers);
  }
  return layers;
}

// The config as the files and the session have it now, whatever of it waits for a
// restart — what names the secrets: a key read at start (`ai.tokenEnv`) already names
// the variable it will read.
function configValueView(config: Record<string, unknown>): Record<string, unknown> {
  const layers = LAYERS.get(config);
  if (!layers) return config;
  const root = deepMerge(deepMerge(structuredClone(config), structuredClone(layers.base)), structuredClone(layers.local));
  for (const [k, v] of SESSION) setDeep(root, k, structuredClone(v));
  return root;
}

// The value `key` has now, as `config get` answers it: the files' layers with the
// session laid over them. It differs from the running app's config only for a key read
// at start, which is never laid on it — the answer is then the value the next start
// reads. A config built by hand with no layers yet answers from itself.
export function configValue(config: Record<string, unknown>, key: string): unknown {
  const layers = LAYERS.get(config);
  const root: Record<string, unknown> = layers ? deepMerge(structuredClone(layers.base), structuredClone(layers.local)) : {};
  if (!layers) {
    const own = getDeep(config, key);
    if (own !== undefined) setDeep(root, key, structuredClone(own));
  }
  for (const [k, v] of SESSION) if (k === key || key.startsWith(`${k}.`) || k.startsWith(`${key}.`)) setDeep(root, k, structuredClone(v));
  return getDeep(root, key);
}

// Where the value at `key` of `config` comes from. A config the caller built itself
// (a test's, never read from the files) has no layers: what it holds is `config`.
export function configSource(config: Record<string, unknown>, key: string): ConfigSource {
  if (sessionHolds(key)) return 'session';
  const layers = LAYERS.get(config);
  if (!layers) return getDeep(config, key) === undefined ? 'default' : 'config';
  if (getDeep(layers.local, key) !== undefined) return 'local';
  if (getDeep(layers.base, key) !== undefined) return 'config';
  return 'default';
}

export type ConfigSetResult = { ok: true; value: unknown; restart: boolean } | { ok: false; error: string };

// The words a caller adds after a value whose key is read at start.
export const RESTART_NOTE = 'takes effect on restart';

// The one way a value is set — `config set` in the CLI, `:config set` in the app and
// the model's `config_set` alike: checked against the schema (a plugin's key against
// the plugin's), then either laid over the session (`session`) or written to
// config.local.json (`saved`), and laid on `config` — the object the caller reads —
// so it is live at once wherever the consumer reads it when it acts. A saved value
// takes over from a session value on the same key: it is what the key is now.
export function setConfigValue(
  config: Record<string, unknown>,
  key: string,
  value: unknown,
  opts: { scope: 'session' | 'saved'; rootSchema?: unknown; pluginConfigs?: Record<string, unknown>; filePath?: string },
): ConfigSetResult {
  const check = validateConfigWriteValue(opts.rootSchema ?? hostConfigSchema, key, value, opts.pluginConfigs);
  if (!check.ok) return check;
  // The layers before anything is laid on `config`: a config built by hand gets them now,
  // so an `unset` later knows what the key falls back to.
  layersOf(config);
  if (opts.scope === 'session') {
    SESSION.set(key, structuredClone(check.value));
  } else {
    if (!saveConfigSetting(key, check.value, opts.filePath)) {
      return { ok: false, error: `config: could not write ${key} — check that the config directory is writable` };
    }
    for (const k of [...SESSION.keys()]) if (k === key || k.startsWith(`${key}.`)) SESSION.delete(k);
    setDeep(layersOf(config).local, key, structuredClone(check.value));
  }
  const restart = configMarks(opts.rootSchema ?? hostConfigSchema, key, opts.pluginConfigs).restart;
  if (!restart) setDeep(config, key, structuredClone(check.value));
  // A value may name another variable (`${VAR}`, `ai.tokenEnv`): the secrets follow.
  refreshSecrets(configValueView(config));
  return { ok: true, value: check.value, restart };
}

// `config unset`, the reverse of `setConfigValue`. `session` drops only the session's
// value at or under the key — the saved one is back. `saved` also removes the key from
// config.local.json. Either way the value the key falls back to (config.json's, or
// none) is laid on `config` at once, unless the key is read at start; `value` is that
// fallback.
export function unsetConfigValue(
  config: Record<string, unknown>,
  key: string,
  opts: { scope: 'session' | 'saved'; rootSchema?: unknown; pluginConfigs?: Record<string, unknown>; filePath?: string },
): ConfigSetResult {
  if (opts.scope === 'saved') {
    if (!saveConfigUnset(key, opts.filePath)) {
      return { ok: false, error: `config: could not unset ${key} — check that the config directory is writable` };
    }
    unsetDeep(layersOf(config).local, key);
  }
  for (const k of [...SESSION.keys()]) if (k === key || k.startsWith(`${key}.`)) SESSION.delete(k);
  const value = configValue(config, key);
  const restart = configMarks(opts.rootSchema ?? hostConfigSchema, key, opts.pluginConfigs).restart;
  if (!restart) {
    if (value === undefined) unsetDeep(config, key);
    else setDeep(config, key, structuredClone(value));
  }
  refreshSecrets(configValueView(config));
  return { ok: true, value, restart };
}

// Strips zod wrappers (optional/nullable/default) off a node: in v4 they hide
// the inner schema, and `.shape`/`.type` are only reachable after `.unwrap()`.
export function unwrapNode(schema: unknown): any {
  let cur = schema as any;
  while (cur && (cur.type === 'optional' || cur.type === 'nullable' || cur.type === 'default')) {
    cur = cur.unwrap();
  }
  return cur;
}

// Resolves the zod schema of a node by dot path (cache.enabled → ZodBoolean).
// An empty path returns the schema itself; an unknown/unresolvable path returns
// null. For object nodes we descend via `.shape`, for record nodes via
// `.valueType`; a primitive cannot be descended further.
export function getSchemaAtPath(schema: any, path: string): any {
  if (!path) return schema;
  const parts = String(path).split('.');
  let cur = schema;
  for (const part of parts) {
    cur = unwrapNode(cur);
    const shape = cur?.shape;
    if (shape) {
      cur = shape[part];
      if (!cur) return null;
    } else if (cur?.type === 'record') {
      cur = unwrapNode(cur.valueType);
    } else {
      return null; // primitive — cannot go deeper
    }
  }
  return cur;
}

// Human-readable type name for a validation error message.
export function describeSchema(node: any): string {
  const t = unwrapNode(node)?.type ?? '';
  switch (t) {
    case 'boolean': return 'true|false';
    case 'string': return 'string';
    case 'number': return 'number';
    case 'array': return 'array';
    case 'object': return 'object';
    case 'record': return 'object';
    default: return 'a valid value';
  }
}

// Validates a value for writing under a dot key. Returns { ok: true, value }
// (the value coerced by the schema if needed) or { ok: false, error } with a
// human-readable message. An unknown key is also an error.
// The zod node for a key — the host's own schema first, then, for `plugins.<name>.*`, the
// plugin's `configSchema`. The host sees `plugins` as an opaque record, so a plugin's
// flag (plugins.keycaps.enabled, plugins.acme-tracker.storyPointsField) is known only to
// the plugin: without this every `config set plugins.<name>.<key>` was "unknown key" —
// while the assistant, whose config tool did look into the plugins, kept telling people
// to run exactly that command.
export function configSchemaAt(rootSchema: any, key: string, pluginConfigs?: Record<string, unknown>): any {
  const hostNode = getSchemaAtPath(rootSchema, key);
  const m = /^plugins\.([^.]+)(?:\.(.*))?$/.exec(key);
  if (hostNode && !(m && m[2])) return hostNode;
  const pluginSchema = m?.[1] && pluginConfigs?.[m[1]];
  if (pluginSchema) return m?.[2] ? getSchemaAtPath(pluginSchema, m[2]) : pluginSchema;
  return hostNode ?? null;
}

// A node and each wrapper it sits in (optional, nullable, default — `.partial()`
// wraps every field anew): a mark may be on any layer.
function layersOfNode(node: unknown): any[] {
  const out: any[] = [];
  let cur = node as any;
  while (cur) {
    out.push(cur);
    if (cur.type === 'optional' || cur.type === 'nullable' || cur.type === 'default') cur = cur.unwrap();
    else break;
  }
  return out;
}

// The nodes a key passes through, root first and the key's own node last, resolved as
// `configSchemaAt` resolves it (a plugin's key through the plugin's schema); null when
// the key does not resolve.
function nodesAlong(rootSchema: any, key: string, pluginConfigs?: Record<string, unknown>): any[] | null {
  const walk = (schema: any, path: string): any[] | null => {
    const out = [schema];
    if (!path) return out;
    let cur = schema;
    for (const part of path.split('.')) {
      cur = unwrapNode(cur);
      if (cur?.shape) cur = cur.shape[part];
      else if (cur?.type === 'record') cur = cur.valueType;
      else return null;
      if (!cur) return null;
      out.push(cur);
    }
    return out;
  };
  const m = /^plugins\.([^.]+)(?:\.(.*))?$/.exec(key);
  const pluginSchema = m?.[1] && pluginConfigs?.[m[1]];
  if (m && pluginSchema) {
    const host = walk(rootSchema, 'plugins');
    const own = walk(pluginSchema, m[2] ?? '');
    return host && own ? [...host, ...own] : null;
  }
  return walk(rootSchema, key);
}

export type ConfigMarks = {
  // The model may set the key for the session / also save it; null — it may not.
  maySet: { reason: string } | null;
  maySave: { reason: string } | null;
  // The key's consumer reads it when the app starts.
  restart: boolean;
};

// What the model may do with a key (src/config/schema.ts): the marks on the key's own
// node, seen through every wrapper, honoured only when no part of the key is the
// model's leash; `maySave` only beside `maySet`. `restart` — a node on the way to the
// key carries `appliesOnRestart`.
export function configMarks(rootSchema: any, key: string, pluginConfigs?: Record<string, unknown>): ConfigMarks {
  const along = nodesAlong(rootSchema, key, pluginConfigs);
  if (!along) return { maySet: null, maySave: null, restart: false };
  const restart = along.some((n) => layersOfNode(n).some((l) => appliesOnRestart.has(l)));
  const own = layersOfNode(along.at(-1));
  const find = (reg: typeof modelMaySet) => {
    const hit = own.find((l) => reg.has(l));
    return hit ? { reason: String(reg.get(hit)?.reason ?? '') } : null;
  };
  const maySet = isLeashKey(key) ? null : find(modelMaySet);
  const maySave = maySet ? find(modelMaySave) : null;
  return { maySet, maySave, restart };
}

export function validateConfigWriteValue(rootSchema: any, key: string, value: unknown, pluginConfigs?: Record<string, unknown>): WriteResult {
  const node = configSchemaAt(rootSchema, key, pluginConfigs);
  if (!node) {
    const plugin = /^plugins\.([^.]+)\./.exec(key)?.[1];
    return { ok: false, error: plugin && !pluginConfigs?.[plugin]
      ? `config: unknown key ${key} — the plugin «${plugin}» is not loaded or declares no settings`
      : `config: unknown key ${key}` };
  }
  const res = node.safeParse(value);
  if (!res.success) {
    const want = describeSchema(node);
    return { ok: false, error: `config: ${key} — expected ${want}, got ${JSON.stringify(value)}` };
  }
  return { ok: true, value: res.data };
}

// Sets a value at a dot path (cache.enabled → obj.cache.enabled). Intermediate
// non-object branches are replaced with `{}` so the path is created on demand.
export function setDeep(obj: any, pathStr: string, value: unknown): any {
  const parts = pathStr.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

// Gets a value at a dot path: undefined if the branch dies before the key.
export function getDeep(obj: any, pathStr: string): unknown {
  let cur = obj;
  for (const k of String(pathStr ?? '').split('.')) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

// Deletes a value at a dot path (cache.enabled → delete obj.cache.enabled).
// A missing intermediate branch is a no-op.
export function unsetDeep(obj: any, pathStr: string): any {
  const parts = String(pathStr ?? '').split('.').filter(Boolean);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur?.[parts[i]] !== 'object' || cur[parts[i]] === null) return obj;
    cur = cur[parts[i]];
  }
  delete cur[parts[parts.length - 1]];
  return obj;
}

// Coerces a string setting to its native type: 'true'/'false' → boolean, a
// numeric string → number, otherwise a string. JSON arrays/objects parse whole;
// a comma-separated list maps each element through parseValue.
export function parseValue(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (s !== '' && !Number.isNaN(Number(s))) return Number(s);
  // JSON array/object (e.g. ["a","b"] or {"k":1}) — parsed whole.
  if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('{') && s.endsWith('}'))) {
    try { return JSON.parse(s); } catch { /* fall through to the comma list below */ }
  }
  // Comma-separated list: ai.tools = tracker,gitlab → ["tracker","gitlab"].
  if (s.includes(',')) return s.split(',').map(x => parseValue(x.trim()));
  return s;
}

// Edits an array in the config: push/insert/remove (incremental edits) plus a
// full overwrite via set. `key` is a dot path to the array; `op` is
// 'push'|'insert'|'remove'; push/insert take a value (insert also an index),
// remove takes a value (all occurrences) or an index. The resulting array is
// validated against the schema and written to config.local.json.
export function editConfigArray(
  key: string,
  op: string,
  { value, index }: { value?: unknown; index?: number } = {},
  schema: any = hostConfigSchema,
  filePath?: string,
): WriteResult {
  const cur = getDeep(loadConfig({ session: false }), key);
  const arr: any[] | null = Array.isArray(cur) ? (cur as any[]).slice() : (cur == null ? [] : null);
  if (arr === null) return { ok: false, error: `config: ${key} — not an array (${typeof cur}); push/insert/remove need an array (use set to replace the whole value).` };
  if (op === 'push') arr.push(value);
  else if (op === 'insert') arr.splice(Number.isInteger(index) ? Math.max(0, Math.min(arr.length, index as number)) : arr.length, 0, value);
  else if (op === 'remove') {
    if (Number.isInteger(index)) arr.splice(Math.max(0, Math.min(arr.length, index as number)), 1);
    else for (let i = arr.length - 1; i >= 0; i--) if (arr[i] === value) arr.splice(i, 1);
  } else return { ok: false, error: 'config: unknown array op — push|insert|remove.' };
  const check = validateConfigWriteValue(schema, key, arr);
  if (!check.ok) return check;
  const written = saveConfigSetting(key, check.value, filePath);
  return written ? { ok: true, value: check.value } : { ok: false, error: 'config: failed to write config.local.json.' };
}

// Where a SAVED setting goes when the caller names no file: the file `loadConfig`
// reads, so `:config set` and `:cache off` driven from a test write into the run's
// temporary directory and not over the person's own overrides.
const configLocalWritePath = configLocalPath;

// Saves a whole-object merge into config.local.json, on top of existing
// overrides. Returns the resulting object (or null on a write error).
export function saveConfig(merge: Record<string, unknown>, filePath: string = configLocalWritePath()): Record<string, unknown> | null {
  try {
    const next = { ...settingsBase(filePath), ...merge };
    writeSettings(filePath, next);
    return next;
  } catch {
    return null;
  }
}

// Writes a value at a dot path into config.local.json, on top of existing
// overrides. Returns the resulting object or null.
export function saveConfigSetting(key: string, value: unknown, filePath: string = configLocalWritePath()): Record<string, unknown> | null {
  try {
    const next = setDeep(settingsBase(filePath), key, value);
    writeSettings(filePath, next);
    return next;
  } catch {
    return null;
  }
}

// Removes a key at a dot path from config.local.json (for `config unset <key>`).
// Returns the resulting object (even if the key was absent — a no-op) or null.
export function saveConfigUnset(key: string, filePath: string = configLocalWritePath()): Record<string, unknown> | null {
  try {
    const next = unsetDeep(settingsBase(filePath), key);
    writeSettings(filePath, next);
    return next;
  } catch {
    return null;
  }
}

// Startup config warnings (human-readable, non-fatal). Two layers: (1) the loaded
// config fails the host schema (all base fields are optional, so this only catches a
// malformed value — e.g. ai.baseUrl set to a number or an unexpected shape); (2) the
// LLM endpoint precondition — baseUrl + model + a token are required for chat/prompt,
// but NOT for the `config`/`plugins` subcommands. The host is tracker-agnostic, so a
// partial config still lets the non-LLM subcommands work; the caller prints these to
// stderr and continues. Returns an empty array when the config looks usable.
export function configWarnings(config: Record<string, unknown>): string[] {
  const out: string[] = [];
  const check = hostConfigSchema.safeParse(config);
  if (!check.success) {
    for (const issue of check.error.issues) {
      out.push(`config: ${issue.path.join('.')} — ${issue.message}`);
    }
  }
  // Resolved as every caller resolves it (`llmOpts`): with ai.provider "anthropic"
  // the base URL and the token variable have defaults of their own.
  const llm = llmOpts(config.ai);
  if (!llm.baseUrl || !llm.model || !llm.token) {
    out.push(
      'config: LLM not fully configured — set ai.baseUrl, ai.model and the token env ' +
      `(ai.tokenEnv, default ${llm.tokenEnv}); chat/prompt need all three, config/plugins do not.`,
    );
  }
  return out;
}