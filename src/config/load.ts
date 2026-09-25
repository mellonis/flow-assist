import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostConfigSchema } from './schema.js';
import { llmOpts } from '../assistant/llm-endpoint.js';

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
// log, the settings `config set` saves. Normally that is the config directory. Under
// `bun test` it is a temporary directory of this process instead, the same protection
// the sessions already have (`sessionsDir` → null): a test that names no file of its
// own must never add to the person's memory, empty their cache or rewrite their
// settings. It is made once per process and never reused from a previous run, so
// nothing a run writes is read back by the next one.
//
// Resolve it on every call. An import-time constant is fixed before a test can point
// the directory anywhere, which is how every test that reached the `memory` tool wrote
// into the person's own `memory.json` — 32 copies of one fact.
let TEST_STATE_DIR: string | null = null;
export function hostStateDir(env: Record<string, string | undefined> = process.env): string {
  if (env.NODE_ENV !== 'test') return configDir(env);
  return (TEST_STATE_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'flow-assist-test-state-')));
}

const CONFIG_DIR = configDir();
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const CONFIG_LOCAL_PATH = path.join(CONFIG_DIR, 'config.local.json');

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

// Loads the effective host config: config.json deep-merged with the local
// overrides in config.local.json, and the session's values laid over both. Missing
// files simply fall back to the other side (or an empty object), never throwing.
// `localPath` swaps the local overrides file — tests point it at a temp file.
export function loadConfig(opts?: { localPath?: string }): Record<string, unknown> {
  const base = asConfigObject(readConfigFile(CONFIG_PATH)) ?? {};
  const local = asConfigObject(readConfigFile(opts?.localPath ?? CONFIG_LOCAL_PATH)) ?? {};
  const merged = deepMerge(structuredClone(base), structuredClone(local));
  for (const [key, value] of SESSION) setDeep(merged, key, structuredClone(value));
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

// The layers of a config the caller built itself are started at its first saved
// write: what it held then is its base, and what is saved from then on is `local`.
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

// The part of the running app's config that is not the person's values but derived
// from them at start: `theme` holds the palette resolved for the terminal's scheme,
// and a value laid over it would leave a partial one. It is written (a session value
// into the map, a saved one into the file) and read at the next start.
const DERIVED_AT_START = ['theme'];
const derivedAtStart = (key: string) => DERIVED_AT_START.some((k) => key === k || key.startsWith(`${k}.`));

export type ConfigSetResult = { ok: true; value: unknown } | { ok: false; error: string };

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
  if (opts.scope === 'session') {
    SESSION.set(key, structuredClone(check.value));
  } else {
    if (!saveConfigSetting(key, check.value, opts.filePath)) {
      return { ok: false, error: `config: could not write ${key} — check that the config directory is writable` };
    }
    for (const k of [...SESSION.keys()]) if (k === key || k.startsWith(`${key}.`)) SESSION.delete(k);
    setDeep(layersOf(config).local, key, structuredClone(check.value));
  }
  if (!derivedAtStart(key)) setDeep(config, key, structuredClone(check.value));
  return { ok: true, value: check.value };
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
  const cur = getDeep(loadConfig(), key);
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

// Where a SAVED setting goes when the caller names no file. Through `hostStateDir`,
// so `:config set` and `:cache off` driven from a test write into the run's temporary
// directory and not over the person's own overrides. Reading is left alone: a test
// that builds its own config never reads this file anyway, and changing what the CLI
// reads under test would change what the CLI does.
const configLocalWritePath = (): string => path.join(hostStateDir(), 'config.local.json');

// Saves a whole-object merge into config.local.json, on top of existing
// overrides. Returns the resulting object (or null on a write error).
export function saveConfig(merge: Record<string, unknown>, filePath: string = configLocalWritePath()): Record<string, unknown> | null {
  try {
    const current = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {};
    const next = { ...current, ...merge };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch {
    return null;
  }
}

// Writes a value at a dot path into config.local.json, on top of existing
// overrides. Returns the resulting object or null.
export function saveConfigSetting(key: string, value: unknown, filePath: string = configLocalWritePath()): Record<string, unknown> | null {
  try {
    const current = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {};
    const base: Record<string, unknown> = current && typeof current === 'object' ? current : {};
    const next = setDeep(base, key, value);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch {
    return null;
  }
}

// Removes a key at a dot path from config.local.json (for `config unset <key>`).
// Returns the resulting object (even if the key was absent — a no-op) or null.
export function saveConfigUnset(key: string, filePath: string = configLocalWritePath()): Record<string, unknown> | null {
  try {
    const current = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {};
    const base: Record<string, unknown> = current && typeof current === 'object' ? current : {};
    const next = unsetDeep(base, key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
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