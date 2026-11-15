import { expect, test } from 'bun:test';
import { buildGroup } from '../tools.ts';
import { createStore } from '../store.ts';

const deps = (over: Partial<Parameters<typeof buildGroup>[0]> = {}) => {
  const store = createStore(() => 5_000);
  const notes: string[] = [];
  return { store, notes, group: buildGroup({ store, now: () => 5_000, notify: () => {}, note: (t) => notes.push(t), open: async () => ({ ok: true, text: 'opened' }), ...over }) };
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

test('canvas_focus asks the host to open the screen; a refusal is passed on verbatim', async () => {
  const refusal = { ok: false, text: 'Not opened: screens are not opened from background work.' };
  const { group, notes } = deps({ open: async () => refusal });
  await group.exec('canvas_draw', { canvas: 'a', tree: ['Text', {}, 'x'] }, {});
  const out = await group.exec('canvas_focus', { canvas: 'a' }, {});
  expect(out).toContain('Not opened');
  expect(notes).toHaveLength(1);   // the toast the draw made, and nothing from the refusal
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

test('a draw while the surface is down says one line; a draw while it is up says nothing', async () => {
  const { group, store, notes } = deps();
  await group.exec('canvas_draw', { canvas: 'a', tree: ['Text', {}, 'x'] }, {});
  expect(notes).toEqual(['canvas «a» updated']);
  store.personOpened = true;
  await group.exec('canvas_draw', { canvas: 'a', tree: ['Text', {}, 'y'] }, {});
  expect(notes).toHaveLength(1);
});
