import { expect, test } from 'bun:test';
import { buildGroup } from '../tools.ts';
import { createStore } from '../store.ts';
import { TEMPLATES_NS } from '../templates.ts';

// The cache as the host's own behaves: `get` answers undefined for what it does not
// hold, a set without a ttl keeps the entry, and only `enabled` can turn it off.
const fakeCache = (enabled = true) => {
  const map = new Map<string, unknown>();
  return {
    map,
    get: (ns: string, key: string) => map.get(`${ns}/${key}`),
    set: (ns: string, key: string, value: unknown) => { map.set(`${ns}/${key}`, value); },
    enabled: () => enabled,
  };
};

const deps = (over: Partial<Parameters<typeof buildGroup>[0]> = {}) => {
  const store = createStore(() => 5_000);
  const notes: string[] = [];
  const cache = fakeCache();
  return { store, notes, cache, group: buildGroup({ store, now: () => 5_000, notify: () => {}, note: (t) => notes.push(t), open: async () => ({ ok: true, text: 'opened' }), cache, ...over }) };
};

test('canvas_draw validates, stores, and answers with counts and side state', async () => {
  const { group, store } = deps();
  const out = await group.exec('canvas_draw', { canvas: 'ci', title: 'Pipelines', owner: 'reviewer', tree: ['Box', {}, ['Text', {}, 'hello']] }, {});
  expect(out).toContain('«ci»');
  expect(out).toContain('side down');
  expect(store.canvases.get('ci')!.title).toBe('Pipelines');
});

test('a bad tree is refused and the canvas is untouched', async () => {
  const { group, store } = deps();
  const before = await group.exec('canvas_draw', { canvas: 'ci', tree: ['Box', {}, ['Text', {}, 'ok']] }, {});
  expect(before).toContain('«ci»');
  const out = await group.exec('canvas_draw', { canvas: 'ci', tree: ['Pipe', {}] }, {});
  expect(out).toContain('Pipe');
  expect(store.canvases.get('ci')!.tree[2]).toEqual(['Text', {}, 'ok']);
});

test('canvas_list names every canvas with owner and age', async () => {
  const { group } = deps();
  await group.exec('canvas_draw', { canvas: 'a', owner: 'me', tree: ['Text', {}, 'x'] }, {});
  await group.exec('canvas_draw', { canvas: 'b', owner: 'you', tree: ['Text', {}, 'y'] }, {});
  const out = await group.exec('canvas_list', {}, {});
  expect(out).toContain('«a»');
  expect(out).toContain('«b»');
  expect(out).toContain('you');
});

test('canvas_delete removes and says so; the last one unmounts', async () => {
  const { group, store } = deps();
  await group.exec('canvas_draw', { canvas: 'a', tree: ['Text', {}, 'x'] }, {});
  expect(await group.exec('canvas_delete', { canvas: 'a' }, {})).toContain('deleted');
  expect(store.canvases.size).toBe(0);
  expect(await group.exec('canvas_delete', { canvas: 'a' }, {})).toContain('no canvas');
});

test('after the last canvas is deleted, a draw says one line again', async () => {
  const { group, store, notes } = deps();
  await group.exec('canvas_draw', { canvas: 'a', tree: ['Text', {}, 'x'] }, {});
  store.personOpened = true;
  await group.exec('canvas_delete', { canvas: 'a' }, {});
  expect(store.personOpened).toBe(false);
  await group.exec('canvas_draw', { canvas: 'b', tree: ['Text', {}, 'y'] }, {});
  expect(notes).toEqual(['canvas «a» updated', 'canvas «b» updated']);
});

test('canvas_focus asks the host to open the screen; a refusal is passed on verbatim', async () => {
  const refusal = { ok: false, text: 'Not opened: screens are not opened from background work.' };
  const { group, notes } = deps({ open: async () => refusal });
  await group.exec('canvas_draw', { canvas: 'a', tree: ['Text', {}, 'x'] }, {});
  const out = await group.exec('canvas_focus', { canvas: 'a' }, {});
  expect(out).toContain('Not opened');
  expect(notes).toHaveLength(1);   // the toast the draw made, and nothing from the refusal
});

test('canvas_focus from background work passes the refusal and leaves the person\'s tabs alone', async () => {
  const refusal = { ok: false, text: 'Not opened: screens are not opened from background work.' };
  const { group, store } = deps({ open: async () => refusal });
  const session = { askUser: async () => ({ answers: [], cancelled: true }) };
  await group.exec('canvas_draw', { canvas: 'a', tree: ['Text', {}, 'x'] }, session);
  await group.exec('canvas_draw', { canvas: 'b', tree: ['Text', {}, 'y'] }, session);
  expect(store.selectedId).toBe('b');
  expect(await group.exec('canvas_focus', { canvas: 'a' }, {})).toBe(refusal.text);
  expect(store.selectedId).toBe('b');
});

test('canvas_focus from a session selects first, and a refusal is still passed on verbatim', async () => {
  const refusal = { ok: false, text: 'Not opened: the person is typing.' };
  const { group, store } = deps({ open: async () => refusal });
  const session = { askUser: async () => ({ answers: [], cancelled: true }) };
  await group.exec('canvas_draw', { canvas: 'a', tree: ['Text', {}, 'x'] }, session);
  await group.exec('canvas_draw', { canvas: 'b', tree: ['Text', {}, 'y'] }, session);
  expect(await group.exec('canvas_focus', { canvas: 'a' }, session)).toBe(refusal.text);
  expect(store.selectedId).toBe('a');
});

test('canvas_open asks the host for the same screen; a canvas nobody drew opens nothing', async () => {
  const asked: string[] = [];
  const { group } = deps({ open: async (screen, params) => { asked.push(`${screen}:${String(params.canvas)}`); return { ok: true, text: 'opened' }; } });
  await group.exec('canvas_draw', { canvas: 'a', tree: ['Text', {}, 'x'] }, {});
  expect(await group.exec('canvas_open', { canvas: 'a' }, {})).toBe('opened');
  expect(asked).toEqual(['show:a']);
  expect(await group.exec('canvas_open', { canvas: 'gone' }, {})).toContain('no canvas');
  expect(asked).toHaveLength(1);
});

test('a draw from a session — a ctx with askUser — takes the person\'s screen', async () => {
  const { group, store } = deps();
  await group.exec('canvas_draw', { canvas: 'a', tree: ['Text', {}, 'x'] }, {});
  await group.exec('canvas_draw', { canvas: 'b', tree: ['Text', {}, 'y'] }, { askUser: async () => ({ answers: [], cancelled: true }) });
  expect(store.selectedId).toBe('b');
});

test('a draw with no askUser in its ctx — background work — leaves the person\'s selection alone', async () => {
  const { group, store } = deps();
  const session = { askUser: async () => ({ answers: [], cancelled: true }) };
  await group.exec('canvas_draw', { canvas: 'a', tree: ['Text', {}, 'x'] }, session);
  const out = await group.exec('canvas_draw', { canvas: 'b', tree: ['Text', {}, 'y'] }, {});
  expect(out).toContain('«b»');
  expect(store.selectedId).toBe('a');
  expect(store.canvases.get('b')!.tree[2]).toBe('y');
});

test('a background draw on a registry with nothing selected still selects what it drew', async () => {
  const { group, store } = deps();
  await group.exec('canvas_draw', { canvas: 'a', tree: ['Text', {}, 'x'] }, {});
  expect(store.selectedId).toBe('a');
});

test('canvas_save keeps the drawn layout; canvas_draw from that template draws it again', async () => {
  const { group, store } = deps({ project: () => '/w/a' });
  await group.exec('canvas_draw', { canvas: 'ci', title: 'Pipelines', tree: ['Box', {}, ['Text', {}, 'one']] }, {});
  expect(await group.exec('canvas_save', { canvas: 'ci', template: 'pipeline' }, {})).toContain('project:/w/a/pipeline');
  await group.exec('canvas_delete', { canvas: 'ci' }, {});
  const out = await group.exec('canvas_draw', { canvas: 'ci2', template: 'pipeline' }, {});
  expect(out).toContain('«ci2»');
  expect(JSON.stringify(store.canvases.get('ci2')!.tree)).toContain('one');
  expect(store.canvases.get('ci2')!.title).toBe('Pipelines');
});

test('a missing template is refused; the canvas is not created', async () => {
  const { group, store } = deps();
  const out = await group.exec('canvas_draw', { canvas: 'ci', template: 'nope' }, {});
  expect(out).toContain('no template');
  expect(store.canvases.size).toBe(0);
});

test('a tree sent beside a template is drawn, and the template supplies the title', async () => {
  const { group, store } = deps({ project: () => '/w/a' });
  await group.exec('canvas_draw', { canvas: 'ci', title: 'Pipelines', tree: ['Box', {}, ['Text', {}, 'old']] }, {});
  await group.exec('canvas_save', { canvas: 'ci', template: 'pipeline' }, {});
  const out = await group.exec('canvas_draw', { canvas: 'ci', template: 'pipeline', tree: ['Box', {}, ['Text', {}, 'today']] }, {});
  expect(out).toContain('«ci»');
  expect(JSON.stringify(store.canvases.get('ci')!.tree)).toContain('today');
  expect(store.canvases.get('ci')!.title).toBe('Pipelines');
});

test('canvas_save with scope global keeps a recipe every project reads as global', async () => {
  const here = deps({ project: () => '/w/a' });
  await here.group.exec('canvas_draw', { canvas: 'ci', title: 'Pipelines', tree: ['Box', {}, ['Text', {}, 'shared']] }, {});
  expect(await here.group.exec('canvas_save', { canvas: 'ci', template: 'pipeline', scope: 'global' }, {})).toContain('global/pipeline');
  // Another project draws it and reads where it came from: global, not its own.
  const there = deps({ project: () => '/w/b', cache: here.cache });
  expect(await there.group.exec('canvas_draw', { canvas: 'ci2', template: 'pipeline' }, {})).toContain('«ci2»');
  const listed = await there.group.exec('canvas_templates', {}, {});
  expect(listed).toContain('pipeline');
  expect(listed).toContain('global');
});

test('an unknown scope is refused, naming the two it accepts', async () => {
  const { group } = deps({ project: () => '/w/a' });
  await group.exec('canvas_draw', { canvas: 'ci', tree: ['Box', {}, ['Text', {}, 'x']] }, {});
  const saved = await group.exec('canvas_save', { canvas: 'ci', template: 'pipeline', scope: 'everywhere' }, {});
  expect(saved).toContain('project');
  expect(saved).toContain('global');
  const listed = await group.exec('canvas_templates', { scope: 'everywhere' }, {});
  expect(listed).toContain('project');
  expect(listed).toContain('global');
});

test('canvas_templates with scope global omits the project\'s own recipes', async () => {
  const { group } = deps({ project: () => '/w/a' });
  await group.exec('canvas_draw', { canvas: 'ci', title: 'Mine', tree: ['Box', {}, ['Text', {}, 'x']] }, {});
  await group.exec('canvas_save', { canvas: 'ci', template: 'pipeline' }, {});
  await group.exec('canvas_save', { canvas: 'ci', template: 'shared', scope: 'global' }, {});
  const both = await group.exec('canvas_templates', {}, {});
  expect(both).toContain('«pipeline»');
  expect(both).toContain('«shared»');
  const globals = await group.exec('canvas_templates', { scope: 'global' }, {});
  expect(globals).toContain('«shared»');
  expect(globals).not.toContain('«pipeline»');
});

test('with the cache disabled — the only "off" the app has — every template tool says so', async () => {
  const { group, store } = deps({ cache: fakeCache(false) });
  await group.exec('canvas_draw', { canvas: 'ci', tree: ['Box', {}, ['Text', {}, 'x']] }, {});
  const off = 'the cache is off (config.cache.enabled) — nothing can be saved';
  expect(await group.exec('canvas_templates', {}, {})).toBe(off);
  expect(await group.exec('canvas_save', { canvas: 'ci', template: 'pipeline' }, {})).toBe(off);
  // A draw that names a recipe is refused all the same, and draws nothing.
  expect(await group.exec('canvas_draw', { canvas: 'ci2', template: 'pipeline' }, {})).toContain(off);
  expect(store.canvases.has('ci2')).toBe(false);
});

test('the project comes from the call\'s ctx — the path the app itself uses', async () => {
  const { group } = deps();
  await group.exec('canvas_draw', { canvas: 'ci', title: 'Pipelines', tree: ['Box', {}, ['Text', {}, 'x']] }, {});
  const saved = await group.exec('canvas_save', { canvas: 'ci', template: 'pipeline' }, { workspaceProject: () => '/w/a' });
  expect(saved).toContain('project:/w/a/pipeline');
});

test('a call with no project identity saves to global', async () => {
  const { group } = deps();
  await group.exec('canvas_draw', { canvas: 'ci', tree: ['Box', {}, ['Text', {}, 'x']] }, {});
  expect(await group.exec('canvas_save', { canvas: 'ci', template: 'pipeline' }, { workspaceProject: () => null })).toContain('global/pipeline');
});

test('the project is read per call — a cd mid-session moves the scope', async () => {
  const { group, store } = deps();
  let project = '/w/a';
  const ctx = { workspaceProject: () => project };
  await group.exec('canvas_draw', { canvas: 'a', title: 'A', tree: ['Box', {}, ['Text', {}, 'x']] }, ctx);
  expect(await group.exec('canvas_save', { canvas: 'a', template: 'pipeline' }, ctx)).toContain('project:/w/a/pipeline');
  project = '/w/b';
  // The same group and the same ctx object: the draw reads the new project and finds nothing there.
  expect(await group.exec('canvas_draw', { canvas: 'c2', template: 'pipeline' }, ctx)).toContain('no template');
  expect(store.canvases.has('c2')).toBe(false);
  expect(await group.exec('canvas_save', { canvas: 'a', template: 'second' }, ctx)).toContain('project:/w/b/second');
});

test('a project recipe the index names but cannot read is refused — the global one never stands in', async () => {
  const { group, cache, store } = deps({ project: () => '/w/a' });
  await group.exec('canvas_draw', { canvas: 'ci', title: 'Mine', tree: ['Box', {}, ['Text', {}, 'mine']] }, {});
  await group.exec('canvas_draw', { canvas: 'g', title: 'Global', tree: ['Box', {}, ['Text', {}, 'global']] }, {});
  await group.exec('canvas_save', { canvas: 'ci', template: 'pipeline' }, {});
  await group.exec('canvas_save', { canvas: 'g', template: 'pipeline', scope: 'global' }, {});
  // A hand-edited cache: the index still names the project's recipe, the entry lost its shape.
  cache.map.set(`${TEMPLATES_NS}/project:/w/a/pipeline`, { title: 'Mine' });
  const out = await group.exec('canvas_draw', { canvas: 'ci2', template: 'pipeline' }, {});
  expect(out).toContain('unreadable');
  expect(store.canvases.has('ci2')).toBe(false);
});

test('the group text names recipes — the model learns the reuse path from it', () => {
  const { group } = deps();
  expect(group.description).toContain('canvas_save');
  expect(group.description).toContain('template');
});

test('the group text forbids credentials — a canvas is never a leak path', () => {
  const { group } = deps();
  // The design's one mitigation for its leak anti-goal: the model is told the person
  // sees what it draws. Pinned so a later edit of the vocabulary cannot drop it quietly.
  expect(group.description).toContain('never put a password, token or key in a canvas');
  const drawTool = group.tools.find((tool) => tool.function.name === 'canvas_draw');
  expect(drawTool?.function.description).toContain('Never put a password, token or key');
});

test('a draw while the surface is down says one line; a draw while it is up says nothing', async () => {
  const { group, store, notes } = deps();
  await group.exec('canvas_draw', { canvas: 'a', tree: ['Text', {}, 'x'] }, {});
  expect(notes).toEqual(['canvas «a» updated']);
  store.personOpened = true;
  await group.exec('canvas_draw', { canvas: 'a', tree: ['Text', {}, 'y'] }, {});
  expect(notes).toHaveLength(1);
});
