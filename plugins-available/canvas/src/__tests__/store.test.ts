import { expect, test } from 'bun:test';
import { createStore, drawCanvas, deleteCanvas, pressMessage, registryItems, selectCanvas, setValue, selectedCanvas, outline } from '../store.ts';

const stats = { nodes: 2, deepest: 1, interactive: 1 };
const tree = ['Box', {}, ['input', { bind: 'branch', value: 'main' }], ['button', { label: 'go', action: 'check it' }]] as never;

test('draw creates a canvas, selects it and seeds values from the tree', () => {
  const store = createStore(() => 1000);
  const c = drawCanvas(store, { id: 'ci', owner: 'reviewer', tree, stats });
  expect(c.id).toBe('ci');
  expect(c.values).toEqual({ branch: 'main' });
  expect(selectedCanvas(store)?.id).toBe('ci');
  expect(c.updatedAt).toBe(1000);
});

test('redrawing keeps what the person typed, unless the model changes the declared value', () => {
  const store = createStore();
  drawCanvas(store, { id: 'ci', tree, stats });
  setValue(store, 'ci', 'branch', 'feature-x');
  drawCanvas(store, { id: 'ci', tree, stats });
  expect(store.canvases.get('ci')!.values.branch).toBe('feature-x');
  const changed = ['Box', {}, ['input', { bind: 'branch', value: 'develop' }]] as never;
  drawCanvas(store, { id: 'ci', tree: changed, stats });
  expect(store.canvases.get('ci')!.values.branch).toBe('develop');
  drawCanvas(store, { id: 'ci', tree: ['Box', {}, ['Text', {}, 'no fields']] as never, stats });
  expect(store.canvases.get('ci')!.values).toEqual({});
});

test('delete removes one; deleting the last clears the selection', () => {
  const store = createStore();
  drawCanvas(store, { id: 'a', tree, stats });
  drawCanvas(store, { id: 'b', tree, stats });
  expect(deleteCanvas(store, 'a')).toBe(true);
  expect(deleteCanvas(store, 'missing')).toBe(false);
  expect(deleteCanvas(store, 'b')).toBe(true);
  expect(selectedCanvas(store)).toBeUndefined();
});

test('two canvases coexist and select moves between them', () => {
  const store = createStore();
  drawCanvas(store, { id: 'a', tree, stats });
  drawCanvas(store, { id: 'b', tree, stats });
  expect([...store.canvases.keys()]).toEqual(['a', 'b']);
  expect(selectCanvas(store, 'a')).toBe(true);
  expect(selectedCanvas(store)?.id).toBe('a');
  expect(selectCanvas(store, 'nope')).toBe(false);
});

test('a non-selecting draw keeps the selection, and the first canvas still takes it', () => {
  const store = createStore();
  drawCanvas(store, { id: 'a', tree, stats, select: false });
  expect(selectedCanvas(store)?.id).toBe('a');
  drawCanvas(store, { id: 'b', tree, stats, select: false });
  expect(selectedCanvas(store)?.id).toBe('a');
  drawCanvas(store, { id: 'c', tree, stats });
  expect(selectedCanvas(store)?.id).toBe('c');
});

test('a non-selecting draw leaves the person\'s pending press; a selecting draw clears it', () => {
  const store = createStore();
  drawCanvas(store, { id: 'a', tree, stats });
  store.pressed = 'a';
  drawCanvas(store, { id: 'b', tree, stats, select: false });
  expect(store.pressed).toBe('a');
  expect(store.selectedId).toBe('a');
  drawCanvas(store, { id: 'b', tree, stats });
  expect(store.pressed).toBeNull();
  expect(store.selectedId).toBe('b');
});

test('the press message carries the label and every value', () => {
  const store = createStore();
  const c = drawCanvas(store, { id: 'ci', owner: 'reviewer', tree, stats });
  setValue(store, 'ci', 'branch', 'feature-x');
  expect(pressMessage(c, 'go')).toBe('[canvas] «ci» pressed «go» — branch: feature-x');
});

test('registry items are one short line per canvas, with age and side-up', () => {
  const store = createStore(() => 1000);
  drawCanvas(store, { id: 'ci', title: 'Pipelines', owner: 'reviewer', tree, stats });
  const items = registryItems(store, () => 1000 + 120_000);
  expect(items).toHaveLength(1);
  expect(items[0]!.text).toContain('2m');
  expect(items[0]!.text).toContain('reviewer');
});

test('deleting the selected canvas selects a remaining one, and a pending press is cleared only for the deleted canvas', () => {
  const store = createStore();
  drawCanvas(store, { id: 'a', tree, stats });
  drawCanvas(store, { id: 'b', tree, stats });
  store.pressed = 'b';
  expect(deleteCanvas(store, 'b')).toBe(true);
  expect(selectedCanvas(store)?.id).toBe('a');
  expect(store.pressed).toBeNull();
  store.pressed = 'a';
  expect(deleteCanvas(store, 'missing')).toBe(false);
  expect(store.pressed).toBe('a');
  expect(deleteCanvas(store, 'a')).toBe(true);
  expect(store.selectedId).toBeNull();
  expect(store.pressed).toBeNull();
});

test('the registry list stays within ten items, one marker naming the rest', () => {
  const store = createStore(() => 1000);
  for (let id = 0; id < 10; id++) drawCanvas(store, { id: `c${id}`, tree, stats });
  const ten = registryItems(store, () => 1000);
  expect(ten).toHaveLength(10);
  expect(ten[9]!.text).toContain('«c9»');
  drawCanvas(store, { id: 'c10', tree, stats });
  const eleven = registryItems(store, () => 1000);
  expect(eleven).toHaveLength(10);
  expect(eleven[0]!.text).toContain('«c0»');
  expect(eleven[8]!.text).toContain('«c8»');
  expect(eleven[9]!.text).toBe('… 2 more');
});

test('the outline is depth-first, capped, and mentions the bindable fields', () => {
  const store = createStore();
  const c = drawCanvas(store, { id: 'ci', tree, stats });
  const text = outline(c, 30);
  expect(text.split('\n').length).toBeLessThanOrEqual(30);
  expect(text).toContain('input branch=main');
});
