import { expect, test } from 'bun:test';
import { actionOf, focusKeys, nextKey } from '../focus.ts';

const tree = ['Box', {}, ['input', { bind: 'branch' }], ['Box', {}, ['check', { bind: 'watch' }], ['button', { label: 'go', action: 'check it' }]]] as never;

test('focus keys come in tree order: binds for fields, btn:<n> for buttons', () => {
  expect(focusKeys(tree)).toEqual(['branch', 'watch', 'btn:0']);
});

test('a button index counts buttons alone, not the fields between them', () => {
  const two = ['Box', {}, ['button', { label: 'a', action: 'a' }], ['select', { bind: 'env', options: [] }], ['button', { label: 'b', action: 'b' }]] as never;
  expect(focusKeys(two)).toEqual(['btn:0', 'env', 'btn:1']);
});

test('Tab wraps forward and backward; empty stays null', () => {
  expect(nextKey(['a', 'b'], null, 1)).toBe('a');
  expect(nextKey(['a', 'b'], null, -1)).toBe('b');
  expect(nextKey(['a', 'b'], 'a', 1)).toBe('b');
  expect(nextKey(['a', 'b'], 'b', 1)).toBe('a');
  expect(nextKey(['a', 'b'], 'a', -1)).toBe('b');
  expect(nextKey([], null, 1)).toBeNull();
});

test('a current key the tree no longer has enters at the near end', () => {
  expect(nextKey(['a', 'b'], 'gone', 1)).toBe('a');
  expect(nextKey(['a', 'b'], 'gone', -1)).toBe('b');
  expect(nextKey(['a'], null, -1)).toBe('a');
});

test('a button resolves by its focus key; a field does not press', () => {
  expect(actionOf(tree, 'btn:0')).toEqual({ label: 'go', action: 'check it' });
  expect(actionOf(tree, 'branch')).toBeNull();
  expect(actionOf(tree, 'btn:9')).toBeNull();
});

test('a string root and an empty tree carry no keys', () => {
  expect(focusKeys('just text' as never)).toEqual([]);
  expect(focusKeys(['Box', {}] as never)).toEqual([]);
});
