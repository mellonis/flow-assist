import { expect, test } from 'bun:test';
import { resolveKeys, isKey } from '../keys';

test('resolveKeys folds string to array and defaults to [] when missing', () => {
  const k = resolveKeys({});
  expect(Array.isArray(k.quit)).toBe(true);
  expect(k.quit).toEqual(['q']);
  expect(k.open).toEqual(['enter', 'return']);
});

test('isKey matches array binding and exact name', () => {
  expect(isKey(['enter', 'return'], 'enter')).toBe(true);
  expect(isKey(['enter'], 'return')).toBe(false);
  expect(isKey([], 'q')).toBe(false);
});