import { expect, test } from 'bun:test';
import { endedWord, watchPath, watchState } from '../watch.js';
import type { TreeNode } from '../conversation-types.js';

const node = (key: string, over: Partial<TreeNode> = {}): TreeNode => ({
  key, label: key, kind: 'subagent', depth: 1, status: 'working', latest: '', startedAt: 0, until: null, below: 0, ...over,
});
const conv = (label: string, parent: ReturnType<typeof conv> | null): { label: string; parent: any } => ({ label, parent });

test('watchPath lists the labels from the session\'s child down to the node, the session itself left out', () => {
  const session = conv('', null);
  const outer = conv('outer', session);
  const inner = conv('inner', outer);
  expect(watchPath(outer)).toEqual(['outer']);
  expect(watchPath(inner)).toEqual(['outer', 'inner']);
  expect(watchPath(session)).toEqual([]);
});

test('watchState says what the tree row says of a live node, and `ended: <verdict>` once it ended', () => {
  expect(watchState(node('a', { latest: 'read_file(a.ts)' }), null, 0)).toBe('⚙ read_file(a.ts)');
  expect(watchState(node('a', { status: 'waiting' }), null, 0)).toBe('⏸ waiting for a y/n');
  expect(watchState(node('a', { status: 'queued' }), null, 0)).toBe('○ queued');
  expect(watchState(node('a', { status: 'delayed', until: 4 * 60_000 }), null, 0)).toBe('○ in 4m');
  expect(watchState(node('a'), 'done', 0)).toBe('ended: done');
  expect(watchState(undefined, 'stopped', 0)).toBe('ended: stopped');
  expect(watchState(undefined, null, 0)).toBe('');
});

test('endedWord words an end as the listing does: an answer is done, a node closed with its holder is stopped, none is failed', () => {
  expect(endedWord({ outcome: 'answer' }, 'park')).toBe('done');
  expect(endedWord({ outcome: 'limit' }, 'park')).toBe('limit');
  expect(endedWord({ outcome: 'stopped' }, 'park')).toBe('stopped');
  expect(endedWord({ outcome: 'answer' }, 'parent')).toBe('stopped');
  expect(endedWord(null, 'exit')).toBe('stopped');
  expect(endedWord(null, 'park')).toBe('failed');
});
