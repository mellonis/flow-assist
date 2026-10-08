import { expect, test } from 'bun:test';
import { agentRowsOf, agentsPanelRows, stopQuestion, treeCursor, treeRows } from '../agent-tree.js';
import type { TreeNode } from '../conversation-types.js';

const node = (key: string, over: Partial<TreeNode> = {}): TreeNode => ({
  key, label: key, kind: 'subagent', depth: 1, status: 'working', latest: '', startedAt: 0, until: null, below: 0, ...over,
});

test('a row is a mark, the label and the state, indented two cells per level', () => {
  const { rows, more } = treeRows([
    node('a', { latest: '⚙ read_file(src/a.ts)' }),
    node('b', { depth: 2, status: 'waiting' }),
    node('c', { status: 'queued', kind: 'task' }),
    node('d', { status: 'delayed', kind: 'task', until: 4 * 60_000 }),
    node('e'),
  ], 8, 80, 0);
  expect(more).toBe(0);
  expect(rows.map((r) => r.text)).toEqual([
    '⚙ a · ⚙ read_file(src/a.ts)',
    '  ⏸ b · waiting for a y/n',
    '○ c (task) · queued',
    '○ d (task) · in 4m',
    '⚙ e · working',
  ]);
  expect(rows.map((r) => r.tone)).toEqual(['work', 'warn', 'dim', 'dim', 'work']);
});

test('with more nodes than rows the waiting ones are kept, in tree order, and the last row counts the rest', () => {
  const nodes = [
    node('w1'), node('q1', { status: 'queued' }), node('p1', { status: 'waiting' }),
    node('w2'), node('p2', { status: 'waiting', depth: 2 }), node('w3'),
  ];
  const { rows, more } = treeRows(nodes, 4, 80, 0);
  expect(more).toBe(3);
  expect(rows.map((r) => r.key)).toEqual(['w1', 'p1', 'p2', '']);
  expect(rows[2]!.text.startsWith('  ⏸')).toBe(true);
  expect(rows[3]!.text).toBe('+3 more — /agents');
});

test('max 0 gives no rows, and a row is cut to the width', () => {
  expect(treeRows([node('a')], 0, 80)).toEqual({ rows: [], more: 0 });
  expect(treeRows([], 4, 80)).toEqual({ rows: [], more: 0 });
  const [row] = treeRows([node('a', { latest: 'x'.repeat(50) })], 4, 20).rows;
  expect(row!.text.length).toBe(20);
  expect(row!.text.endsWith('…')).toBe(true);
});

test('the cursor stays on its node when rows reorder, moves to the nearest row when it ends, and leaves with no rows', () => {
  const rows = (...keys: string[]) => keys.map((key) => ({ key, text: key, tone: 'dim' as const }));
  expect(treeCursor('b', 1, rows('c', 'b', 'a'))).toBe('b');
  expect(treeCursor('b', 1, rows('c', 'a'))).toBe('a');
  expect(treeCursor('z', 5, rows('c', 'a', ''))).toBe('a');
  expect(treeCursor('z', 0, rows('c', 'a'))).toBe('c');
  expect(treeCursor('b', 0, rows(''))).toBeNull();
  expect(treeCursor('b', 0, [])).toBeNull();
  expect(treeCursor(null, 0, rows('a'))).toBeNull();
});

test('the stop question names the node and what is below it', () => {
  expect(stopQuestion({ label: 'a', below: 0 })).toBe('stop a? y yes · n no');
  expect(stopQuestion({ label: 'a', below: 2 })).toBe('stop a and 2 below it? y yes · n no');
});

test('ui.agentRows defaults to four and is read within 0 to 8', () => {
  expect(agentRowsOf({})).toBe(4);
  expect(agentRowsOf({ ui: { agentRows: 0 } })).toBe(0);
  expect(agentRowsOf({ ui: { agentRows: 8 } })).toBe(8);
  expect(agentRowsOf({ ui: { agentRows: 9 } })).toBe(4);
  expect(agentRowsOf({ ui: { agentRows: 'x' } })).toBe(4);
});

test('the /agents rows: live nodes in tree order with their time, then the ended ones as the listing words them', () => {
  const rows = agentsPanelRows([
    node('a', { startedAt: 1_000, latest: '⚙ read_file(src/a.ts)', below: 1 }),
    node('g', { depth: 2, kind: 'task', status: 'waiting', startedAt: 61_000 }),
    node('q', { status: 'queued', startedAt: null }),
  ], [
    { label: 'old', kind: 'subagent', outcome: 'answer', ms: 65_000, tokens: 1500 },
    { label: 'cut', kind: 'task', outcome: 'stopped', ms: 900, tokens: 0 },
  ], 121_000);
  expect(rows.map((r) => r.id)).toEqual(['a', 'g', 'q', 'ended:0', 'ended:1']);
  expect(rows.map((r) => r.text)).toEqual(['⚙ a', '  ⏸ g (task)', '○ q', 'old', 'cut (task)']);
  expect(rows.map((r) => r.detail)).toEqual([
    '⚙ read_file(src/a.ts) · 2m 0s',
    'waiting for a y/n · 1m 0s',
    'queued',
    'done · 1m 5s · 2k tokens',
    'stopped · <1s',
  ]);
  expect(rows[1]!.tone).toBe('warn');
});

test('a node whose stop question is up shows the question in place of its text', () => {
  const rows = agentsPanelRows([node('a', { below: 2 }), node('b')], [], 0, 'a');
  expect(rows[0]).toEqual({ id: 'a', text: 'stop a and 2 below it? y yes · n no', tone: 'warn' });
  expect(rows[1]!.text).toBe('⚙ b');
});

test('no nodes, no ended ones: no rows', () => {
  expect(agentsPanelRows([], [])).toEqual([]);
});
