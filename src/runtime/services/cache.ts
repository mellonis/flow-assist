import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Host cache lives outside the repo, under the user's config dir (same dir the
// config layer uses, honoring the XDG override). The cache is a generic
// namespaced KV + TTL store; plugins (tracker, gitlab, …) each get their own
// namespace so keys never collide.
const CONFIG_DIR =
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config', 'flow-assist');
const DEFAULT_CACHE_PATH = path.join(CONFIG_DIR, 'cache.json');

// Default TTL for an entry when `set` is called without an explicit ttl.
// Mirrors the source tracker cache's 24-hour freshness window.
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Cache is on/off via config.cache.enabled (default true). A consumer reads the
// flag and decides whether to go through the cache; the service exposes it so
// the whole host (and plugins) can honor it consistently.
export function cacheEnabled(config: Record<string, unknown> | undefined): boolean {
  const cache = config?.cache as { enabled?: boolean } | undefined;
  return cache?.enabled !== false;
}

// The persisted on-disk shape: { [ns]: { [key]: { value, expiresAt? } } }.
// An entry with only a `value` (no expiresAt) never expires.
interface Entry {
  value: unknown;
  expiresAt?: number;
}
type Store = Record<string, Record<string, Entry>>;

// Drops expired entries (and the now-empty namespaces) in place. An entry
// expires once its stored `expiresAt` is in the past.
function prune(store: Store): Store {
  const now = Date.now();
  for (const ns of Object.keys(store)) {
    const nsEntries = store[ns];
    for (const key of Object.keys(nsEntries)) {
      const entry = nsEntries[key];
      if (typeof entry.expiresAt === 'number' && entry.expiresAt < now) {
        delete nsEntries[key];
      }
    }
    if (Object.keys(nsEntries).length === 0) delete store[ns];
  }
  return store;
}

// Reads and prunes the cache file. A missing or malformed file yields an empty
// store — the cache is a best-effort luxury and never throws.
function loadStore(filePath: string): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Store;
    return prune(parsed ?? {});
  } catch {
    return {};
  }
}

// Persists the store, swallowing write errors (cache is optional).
function persist(filePath: string, store: Store): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf8');
  } catch {
    // Cache is a nice-to-have; a failed write must not break the host.
  }
}

export interface CacheService {
  // Return the value for [ns][key], or undefined if empty/expired.
  get<Ns extends string, K extends string>(ns: Ns, key: K): unknown;
  // Store a value under [ns][key] with a TTL (ms; default CACHE_TTL_MS). A ttl
  // of 0/negative means "never expires" (an entry with no expiry timestamp).
  set(ns: string, key: string, value: unknown, ttl?: number): void;
  // Clear one namespace's data, or all namespaces when `ns` is omitted.
  clear(ns?: string): void;
  // Report whether the cache is enabled (config.cache.enabled !== false).
  enabled(): boolean;
}

// Creates a generic, plugin-namespaced KV cache backed by a JSON file. The
// internal `path` resolves through the config dir. Keys under different
// namespaces are independent, so `tracker/issues` and `gitlab/issues` do not
// collide.
export function createCacheService(config: Record<string, unknown> | undefined): CacheService {
  const filePath = DEFAULT_CACHE_PATH;
  const enabled = cacheEnabled(config);
  let store = loadStore(filePath);

  return {
    get<Ns extends string, K extends string>(ns: Ns, key: K): unknown {
      prune(store);
      return store[ns]?.[key]?.value;
    },

    set(ns: string, key: string, value: unknown, ttl?: number): void {
      // A provided ttl of 0/negative disables expiry; omit ttl to use the
      // default window. Store the per-key expiry timestamp alongside the value.
      const expiresAt =
        ttl == null ? Date.now() + CACHE_TTL_MS : ttl > 0 ? Date.now() + ttl : undefined;
      prune(store);
      store[ns] = store[ns] ?? {};
      store[ns][key] = { value, expiresAt };
      persist(filePath, store);
    },

    clear(ns?: string): void {
      prune(store);
      if (ns == null) store = {};
      else delete store[ns];
      persist(filePath, store);
    },

    enabled(): boolean {
      return enabled;
    },
  };
}