import { expect, test } from 'bun:test';
import { listTemplates, loadTemplate, saveTemplate, TEMPLATE_LIMIT, TEMPLATES_NS } from '../templates.ts';

const fakeCache = (enabled = true) => {
  const map = new Map<string, unknown>();
  const ttls: number[] = [];
  return {
    map, ttls,
    get: (ns: string, key: string) => map.get(`${ns}/${key}`) ?? null,
    set: (ns: string, key: string, value: unknown, ttl?: number) => { map.set(`${ns}/${key}`, value); ttls.push(ttl ?? -1); },
    enabled: () => enabled,
  };
};
const tree = ['Box', {}, ['Text', {}, 'jobs']] as never;

test('a save keeps the tree and the title, never the values, and never expires', () => {
  const cache = fakeCache();
  const r = saveTemplate(cache, { scope: 'project:/w/prices', name: 'pipeline', title: 'Pipelines', tree, now: 1000 });
  expect(r).toEqual({ ok: true, key: 'project:/w/prices/pipeline' });
  const stored = cache.map.get(`${TEMPLATES_NS}/project:/w/prices/pipeline`) as Record<string, unknown>;
  expect(stored).toEqual({ name: 'pipeline', title: 'Pipelines', tree, savedAt: 1000 });
  expect(cache.ttls.every((t) => t === 0)).toBe(true);
});

test('a project recipe shadows a global one of the same name', () => {
  const cache = fakeCache();
  saveTemplate(cache, { scope: 'global', name: 'pipeline', title: 'Global', tree, now: 1 });
  saveTemplate(cache, { scope: 'project:/w/a', name: 'pipeline', title: 'Mine', tree, now: 2 });
  const found = loadTemplate(cache, { scope: 'project:/w/a', name: 'pipeline' });
  expect(found.ok && found.template.title).toBe('Mine');
  const other = loadTemplate(cache, { scope: 'project:/w/b', name: 'pipeline' });
  expect(other.ok && other.template.title).toBe('Global');
});

test('a missing recipe, a bad name, and the 51st are refused with words', () => {
  const cache = fakeCache();
  expect(loadTemplate(cache, { scope: 'global', name: 'nope' })).toEqual({ ok: false, error: 'no template «nope» — draw a tree instead' });
  expect(saveTemplate(cache, { scope: 'global', name: 'Bad Name!', title: 'x', tree, now: 1 }).ok).toBe(false);
  for (let i = 0; i < TEMPLATE_LIMIT; i++) saveTemplate(cache, { scope: 'global', name: `t${i}`, title: 'x', tree, now: 1 });
  const over = saveTemplate(cache, { scope: 'global', name: 'one-too-many', title: 'x', tree, now: 1 });
  expect(over).toEqual({ ok: false, error: `no room: ${TEMPLATE_LIMIT} templates in this scope` });
});

test('a recipe the vocabulary no longer accepts is refused with its reason', () => {
  const cache = fakeCache();
  cache.map.set(`${TEMPLATES_NS}/global/old`, { name: 'old', title: 'Old', tree: ['Pipeline', {}], savedAt: 1 });
  const r = loadTemplate(cache, { scope: 'global', name: 'old' });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain('Pipeline');
});

test('saving an existing name at the cap replaces it and does not count twice', () => {
  const cache = fakeCache();
  for (let n = 0; n < TEMPLATE_LIMIT; n++) saveTemplate(cache, { scope: 'global', name: `t${n}`, title: 'x', tree, now: 1 });
  expect(saveTemplate(cache, { scope: 'global', name: 't0', title: 'Renamed', tree, now: 2 })).toEqual({ ok: true, key: 'global/t0' });
  const listed = listTemplates(cache, 'global');
  expect(listed).toHaveLength(TEMPLATE_LIMIT);
  expect(listed[0]).toEqual({ name: 't0', title: 'Renamed', savedAt: 2, where: 'global' });
});

test('a project recipe the index names but cannot read is refused, never replaced by global', () => {
  const cache = fakeCache();
  saveTemplate(cache, { scope: 'global', name: 'pipeline', title: 'Global', tree, now: 1 });
  saveTemplate(cache, { scope: 'project:/w/a', name: 'pipeline', title: 'Mine', tree, now: 2 });
  // A hand-edited cache, or one written by a shape this build no longer reads: the index
  // still names the project's recipe, the entry itself is not a recipe.
  cache.map.set(`${TEMPLATES_NS}/project:/w/a/pipeline`, { title: 'Mine' });
  const r = loadTemplate(cache, { scope: 'project:/w/a', name: 'pipeline' });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.error).toContain('«pipeline» is unreadable');
    expect(r.error).toContain('save it again');
  }
});

test('listing merges the project and the global recipes and says where each came from', () => {
  const cache = fakeCache();
  saveTemplate(cache, { scope: 'global', name: 'servers', title: 'Servers', tree, now: 1 });
  saveTemplate(cache, { scope: 'project:/w/a', name: 'pipeline', title: 'Pipelines', tree, now: 2 });
  expect(listTemplates(cache, 'project:/w/a')).toEqual([
    { name: 'pipeline', title: 'Pipelines', savedAt: 2, where: 'project' },
    { name: 'servers', title: 'Servers', savedAt: 1, where: 'global' },
  ]);
});

test('with the cache off, every template call says so', () => {
  const cache = fakeCache(false);
  expect(saveTemplate(cache, { scope: 'global', name: 'a', title: 'x', tree, now: 1 })).toEqual({ ok: false, error: 'the cache is off (config.cache.enabled) — nothing can be saved' });
  expect(loadTemplate(cache, { scope: 'global', name: 'a' }).ok).toBe(false);
  expect(listTemplates(cache, 'global')).toEqual([]);
});
