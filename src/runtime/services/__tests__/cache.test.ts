import { expect, test } from 'bun:test';
import { createCacheService } from '../cache';

test('cache namespaces do not collide', () => {
  const c = createCacheService({ cache: { enabled: true } });
  c.set('tracker', 'issues', [1], 0);
  c.set('gitlab', 'issues', [2], 0);
  expect(c.get('tracker', 'issues')).toEqual([1]);
  expect(c.get('gitlab', 'issues')).toEqual([2]);
});