import { expect, test } from 'bun:test';
import { VERBS, pickVerb, verbList } from '../verbs.ts';

test('the built-in list is ~30 gerunds, each one word', () => {
  expect(VERBS.length).toBeGreaterThanOrEqual(25);
  for (const v of VERBS) expect(v).toMatch(/^[A-Z][a-z]+ing$/);
  expect(new Set(VERBS).size).toBe(VERBS.length);
});

test('ui.verbs replaces the list when it holds a word', () => {
  expect(verbList({ ui: { verbs: ['Baking', ' ', 7] } })).toEqual(['Baking']);
  expect(verbList({ ui: { verbs: [] } })).toBe(VERBS);
  expect(verbList(undefined)).toBe(VERBS);
});

test('a pick is from the list and never the word just shown, when there is another', () => {
  const list = ['A', 'B', 'C'];
  expect(pickVerb(list, '', () => 0)).toBe('A');
  expect(pickVerb(list, 'A', () => 0)).toBe('B');
  expect(pickVerb(list, 'A', () => 0.999)).toBe('C');
  expect(pickVerb(['Only'], 'Only', () => 0.5)).toBe('Only');
  for (let i = 0; i < 50; i++) expect(list).toContain(pickVerb(list));
});
