// The template store: a recipe is the tree and its title, kept in the host's cache
// under one namespace with no expiry, so a layout drawn today is drawn again after a
// restart. Never the values the person typed and never an owner — a recipe is a
// shape, and the canvas it is drawn into carries the current data.
//
// The cache cannot list its keys, so every scope keeps an index of its own
// (`index/<scope>`) with one short entry per recipe, rewritten on each save. A recipe
// saved in a project's scope shadows a global one of the same name: the project's
// `pipeline` is the one that project means. A stored recipe is re-checked against the
// vocabulary on every load, so a recipe saved before the vocabulary changed is refused
// with the reason instead of half-drawn.
import { checkTree } from './tree.ts';
import type { Node } from './tree.ts';

export const TEMPLATES_NS = 'canvas/templates';
export const GLOBAL_SCOPE = 'global';
export const TEMPLATE_LIMIT = 50;

// The slice of the host's cache service a template needs: a namespaced KV with the
// on/off switch. The host's own service fits it whole (src/runtime/services/cache.ts).
export type TCache = { get(ns: string, key: string): unknown; set(ns: string, key: string, value: unknown, ttl?: number): void; enabled(): boolean };
// What a recipe keeps: its name, the title it draws under, the tree, and when it was
// saved. Nothing else — no values the person typed into a field, no owner, no data
// timestamp.
export type TTemplate = { name: string; title: string; tree: Node; savedAt: number };
// A scope is `global` or `project:<path>`; the scope is the first half of every key.
export type TScope = string;
// One index entry: what the index keeps per recipe, and what a listing needs.
export type TTemplateIndexEntry = { name: string; title: string; savedAt: number };
// One recipe as a listing reads it: the entry plus the scope it was found in.
export type TTemplateLine = TTemplateIndexEntry & { where: 'project' | 'global' };

// The one sentence every template call answers while the host's cache is off: the
// feature is the cache, so with no cache there is nothing to keep or read.
export const CACHE_OFF = 'the cache is off (config.cache.enabled) — nothing can be saved';

// A name is half of a cache key, and a person types it on the `:` line: lower-case
// letters, digits and . _ -, at most 40 characters, starting with a letter or a digit.
const NAME_RULE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const NAME_HELP = 'lower-case letters, digits and . _ -, at most 40, starting with a letter or a digit';
// Anything that is not a name is refused with the rule: a name is half of a cache key.
const notAName = (raw: unknown): string => `«${typeof raw === 'string' ? raw : ''}» is not a template name — use ${NAME_HELP}`;

const isPlainRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function slug(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return NAME_RULE.test(trimmed) ? trimmed : null;
}

// The index as the store reads it: entries that carry a name and a saved time. A
// malformed index reads as an empty one — the cache is best effort, never a throw.
const readIndex = (cache: TCache, scope: TScope): TTemplateIndexEntry[] => {
  const raw = cache.get(TEMPLATES_NS, `index/${scope}`);
  if (!Array.isArray(raw)) return [];
  const entries: TTemplateIndexEntry[] = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) continue;
    if (typeof item.name !== 'string' || typeof item.savedAt !== 'number') continue;
    entries.push({ name: item.name, title: typeof item.title === 'string' ? item.title : '', savedAt: item.savedAt });
  }
  return entries;
};

// The index is rewritten whole on every save: it is the only way to list the keys.
const writeIndex = (cache: TCache, scope: TScope, entries: TTemplateIndexEntry[]): void => {
  cache.set(TEMPLATES_NS, `index/${scope}`, entries, 0);
};

export function saveTemplate(cache: TCache, input: { scope: TScope; name: string; title: string; tree: Node; now: number }): { ok: true; key: string } | { ok: false; error: string } {
  if (!cache.enabled()) return { ok: false, error: CACHE_OFF };
  const name = slug(input.name);
  if (name === null) return { ok: false, error: notAName(input.name) };
  const index = readIndex(cache, input.scope);
  const existing = index.findIndex((entry) => entry.name === name);
  if (existing < 0 && index.length >= TEMPLATE_LIMIT) return { ok: false, error: `no room: ${TEMPLATE_LIMIT} templates in this scope` };
  const template: TTemplate = { name, title: input.title, tree: input.tree, savedAt: input.now };
  const key = `${input.scope}/${name}`;
  // `ttl: 0` is the host's "never expires": a recipe stays until the person clears the
  // cache, and the index beside it lives exactly as long.
  cache.set(TEMPLATES_NS, key, template, 0);
  const entry: TTemplateIndexEntry = { name, title: input.title, savedAt: input.now };
  const rewritten = existing < 0 ? [...index, entry] : index.map((kept, position) => position === existing ? entry : kept);
  writeIndex(cache, input.scope, rewritten);
  return { ok: true, key };
}

// A stored recipe as the store reads it, or nothing when the key holds no recipe. The
// tree is left as it was stored: whether it still draws is `checkTree`'s answer.
const readRecipe = (cache: TCache, key: string, name: string): TTemplate | null => {
  const raw = cache.get(TEMPLATES_NS, key);
  if (!isPlainRecord(raw)) return null;
  if (typeof raw.title !== 'string' || typeof raw.savedAt !== 'number') return null;
  return { name, title: raw.title, tree: raw.tree as Node, savedAt: raw.savedAt };
};

// Whether a scope's index names a recipe. An index entry whose value does not read back
// as a recipe is a disagreement, not a miss: refusing it is what keeps a project's
// recipe from being silently replaced by a global one of the same name.
const isNamed = (cache: TCache, scope: TScope, name: string): boolean =>
  readIndex(cache, scope).some((entry) => entry.name === name);

const unreadable = (name: string): string => `template «${name}» is unreadable — save it again under the same name and it replaces the broken one`;

export function loadTemplate(cache: TCache, input: { scope: TScope; name: string }): { ok: true; template: TTemplate; key: string } | { ok: false; error: string } {
  if (!cache.enabled()) return { ok: false, error: CACHE_OFF };
  const name = slug(input.name);
  if (name === null) return { ok: false, error: notAName(input.name) };
  const projectKey = `${input.scope}/${name}`;
  const own = input.scope === GLOBAL_SCOPE ? null : readRecipe(cache, projectKey, name);
  if (own === null && input.scope !== GLOBAL_SCOPE && isNamed(cache, input.scope, name)) return { ok: false, error: unreadable(name) };
  const shared = own === null ? readRecipe(cache, `${GLOBAL_SCOPE}/${name}`, name) : null;
  if (own === null && shared === null && isNamed(cache, GLOBAL_SCOPE, name)) return { ok: false, error: unreadable(name) };
  const found = own ?? shared;
  if (found === null) return { ok: false, error: `no template «${name}» — draw a tree instead` };
  const key = own !== null ? projectKey : `${GLOBAL_SCOPE}/${name}`;
  const checked = checkTree(found.tree);
  if (!checked.ok) return { ok: false, error: `template «${name}» no longer draws: ${checked.error} — draw a tree instead` };
  return { ok: true, template: { ...found, tree: checked.tree }, key };
}

// Both indexes, the project's first: a project entry shadows a global one of the same
// name, so a listing never shows the same recipe twice.
export function listTemplates(cache: TCache, scope: TScope): TTemplateLine[] {
  if (!cache.enabled()) return [];
  const project = scope === GLOBAL_SCOPE ? [] : readIndex(cache, scope);
  const shared = readIndex(cache, GLOBAL_SCOPE);
  const lines: TTemplateLine[] = project.map((entry) => ({ ...entry, where: 'project' }));
  for (const entry of shared) {
    if (!project.some((own) => own.name === entry.name)) lines.push({ ...entry, where: 'global' });
  }
  return lines;
}
