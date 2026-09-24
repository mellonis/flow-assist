import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hostStateDir } from '../../../config/load';
import { createCacheService } from '../cache';

test('cache namespaces do not collide', () => {
  const c = createCacheService({ cache: { enabled: true } });
  c.set('tracker', 'issues', [1], 0);
  c.set('gitlab', 'issues', [2], 0);
  expect(c.get('tracker', 'issues')).toEqual([1]);
  expect(c.get('gitlab', 'issues')).toEqual([2]);
});

test('under bun test the cache writes no file at all', () => {
  // These two lines would otherwise land in the person's own `cache.json`, and the
  // `x` that flushes the cache would empty it. `createCacheService` takes no path and there is no
  // `cache.file` setting, so a test has nothing of its own to name: under a test run
  // the store stays in memory and answers just the same.
  const c = createCacheService({ cache: { enabled: true } });
  c.set('tracker', 'issues', [1], 0);
  c.clear();
  expect(existsSync(join(hostStateDir(), 'cache.json'))).toBe(false);
});