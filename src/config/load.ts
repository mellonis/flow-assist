import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostConfigSchema } from './schema.js';

// Config files live outside the repo, under the user's home config dir (or the
// XDG override). config.json is the committed/default base; config.local.json
// holds machine-specific overrides and is the only file the write helpers touch.
const CONFIG_DIR = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config', 'flow-assist');
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

// Loads the effective host config: config.json deep-merged with the local
// overrides in config.local.json. Missing files simply fall back to the other
// side (or an empty object), never throwing.
// `localPath` swaps the local overrides file — tests point it at a temp file.
export function loadConfig(opts?: { localPath?: string }): Record<string, unknown> {
  const base = asConfigObject(readConfigFile(CONFIG_PATH)) ?? {};
  const local = asConfigObject(readConfigFile(opts?.localPath ?? CONFIG_LOCAL_PATH));
  if (local == null) return base;
  return deepMerge(base, local);
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
export function validateConfigWriteValue(rootSchema: any, key: string, value: unknown): WriteResult {
  const node = getSchemaAtPath(rootSchema, key);
  if (!node) return { ok: false, error: `config: unknown key ${key}` };
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

// Saves a whole-object merge into config.local.json, on top of existing
// overrides. Returns the resulting object (or null on a write error).
export function saveConfig(merge: Record<string, unknown>, filePath: string = CONFIG_LOCAL_PATH): Record<string, unknown> | null {
  try {
    const current = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {};
    const next = { ...current, ...merge };
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch {
    return null;
  }
}

// Writes a value at a dot path into config.local.json, on top of existing
// overrides. Returns the resulting object or null.
export function saveConfigSetting(key: string, value: unknown, filePath: string = CONFIG_LOCAL_PATH): Record<string, unknown> | null {
  try {
    const current = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : { value: undefined };
    const base: Record<string, unknown> = current && typeof current === 'object' ? current : {};
    const next = setDeep(base, key, value);
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch {
    return null;
  }
}

// Removes a key at a dot path from config.local.json (for `config unset <key>`).
// Returns the resulting object (even if the key was absent — a no-op) or null.
export function saveConfigUnset(key: string, filePath: string = CONFIG_LOCAL_PATH): Record<string, unknown> | null {
  try {
    const current = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {};
    const base: Record<string, unknown> = current && typeof current === 'object' ? current : {};
    const next = unsetDeep(base, key);
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
  const ai = (config.ai ?? {}) as Record<string, unknown>;
  const tokenEnv = (ai.tokenEnv as string | undefined) ?? 'LLM_TOKEN';
  if (!ai.baseUrl || !ai.model || !process.env[tokenEnv]) {
    out.push(
      'config: LLM not fully configured — set ai.baseUrl, ai.model and the token env ' +
      `(ai.tokenEnv, default ${tokenEnv}); chat/prompt need all three, config/plugins do not.`,
    );
  }
  return out;
}