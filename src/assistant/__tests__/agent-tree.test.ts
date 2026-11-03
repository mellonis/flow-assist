import { expect, test } from 'bun:test';
import { cellWidth } from '../../cells.js';
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

test('an idle subagent reads idle, and answered once a later answer is unread; with rows short the unread answer is kept before the plain idle ones', () => {
  const { rows } = treeRows([node('a', { status: 'idle' }), node('b', { status: 'idle', answered: true })], 8, 80, 0);
  expect(rows.map((r) => r.text)).toEqual(['◦ a · idle', '◦ b · answered']);
  expect(rows.map((r) => r.tone)).toEqual(['dim', 'warn']);
  const short = treeRows([node('a', { status: 'idle' }), node('b', { status: 'idle', answered: true }), node('c', { status: 'queued' })], 2, 80, 0);
  expect(short.rows.map((r) => r.key)).toEqual(['b', '']);
  const panel = agentsPanelRows([node('a', { status: 'idle', startedAt: null }), node('b', { status: 'idle', answered: true, startedAt: null })], [], 0);
  expect(panel.map((r) => [r.text, r.detail, r.tone])).toEqual([['◦ a', 'idle', undefined], ['◦ b', 'answered', 'warn']]);
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

const shell = (id: string, over: Partial<NonNullable<TreeNode['shell']>> = {}, node_: Partial<TreeNode> = {}): TreeNode => ({
  key: `job:${id}`, label: id, kind: 'shell', depth: 1, status: 'working', latest: '', startedAt: 0, until: null, below: 0,
  shell: { id, command: 'bun run dev', state: 'running', running: true, ms: 4 * 60_000 + 20_000, lines: 312, ...over }, ...node_,
});

test('a background shell row reads id, command, how it runs to the minute, and its line count', () => {
  const { rows } = treeRows([
    shell('sh-3'),
    shell('sh-4', { ms: 20_000, lines: 1 }),
    shell('sh-5', { state: 'exited 0', running: false, lines: 7 }, { status: 'idle', answered: true }),
    shell('sh-6', { state: 'exited 2', running: false, lines: 0 }, { status: 'idle', answered: true }),
    shell('sh-7', { state: 'killed (person)', running: false, lines: 2 }, { status: 'idle', answered: true, depth: 2 }),
  ], 8, 100, 0);
  expect(rows.map((r) => r.text)).toEqual([
    '○ sh-3 · bun run dev · running 4m · 312 lines',
    '○ sh-4 · bun run dev · running <1m · 1 line',
    '○ sh-5 · bun run dev · exited 0 · 7 lines',
    '○ sh-6 · bun run dev · exited 2 · 0 lines',
    '  ○ sh-7 · bun run dev · killed · 2 lines',
  ]);
  expect(rows.map((r) => r.tone)).toEqual(['work', 'work', 'warn', 'warn', 'warn']);
});

test('a shell row that does not fit gives up the command, not its state and count', () => {
  const { rows } = treeRows([shell('sh-3', {}, {}), { ...shell('sh-9'), shell: { ...shell('sh-9').shell!, command: 'cargo watch -x "test --workspace" --why --ignore-nothing' } }], 8, 44, 0);
  for (const r of rows) {
    expect(r.text.endsWith(' · running 4m · 312 lines')).toBe(true);
    expect(cellWidth(r.text)).toBeLessThanOrEqual(44);
  }
  expect(rows[1]!.text).toContain('…');
});

test('with rows short a running shell ranks like a working child and an unread ended one like an answered idle subagent', () => {
  const nodes = [
    node('idle', { status: 'idle' }),
    shell('sh-1', { state: 'exited 0', running: false }, { status: 'idle', answered: true }),
    shell('sh-2'),
    node('queued', { status: 'queued' }),
    node('asks', { status: 'waiting' }),
  ];
  expect(treeRows(nodes, 4, 80, 0).rows.map((r) => r.key)).toEqual(['job:sh-1', 'job:sh-2', 'asks', '']);
  expect(treeRows(nodes, 3, 80, 0).rows.map((r) => r.key)).toEqual(['job:sh-2', 'asks', '']);
});

test('killing a shell asks to kill it, and /agents lists it with its state in the detail', () => {
  expect(stopQuestion(shell('sh-3'))).toBe('kill sh-3? y yes · n no');
  expect(stopQuestion({ label: 'a', below: 2 })).toBe('stop a and 2 below it? y yes · n no');
  const panel = agentsPanelRows([shell('sh-3'), shell('sh-5', { state: 'exited 0', running: false }, { status: 'idle', answered: true })], [], 0, 'job:sh-3');
  expect(panel.map((r) => [r.id, r.text, r.detail, r.tone])).toEqual([
    ['job:sh-3', 'kill sh-3? y yes · n no', undefined, 'warn'],
    ['job:sh-5', '○ sh-5 · bun run dev', 'exited 0 · 312 lines', 'warn'],
  ]);
  expect(agentsPanelRows([shell('sh-3')], [], 0)[0]).toMatchObject({ text: '○ sh-3 · bun run dev', detail: 'running 4m · 312 lines' });
});

test('/agents lists the ended shells after the ended children, with the job\'s words, time and lines', () => {
  const ended = [{ label: 'a', kind: 'subagent' as const, outcome: 'answer' as const, ms: 1000, tokens: 0 }];
  const rows = agentsPanelRows([], ended, 0, null, [
    { id: 'sh-1', command: 'bun   run dev', state: 'killed (person)', ms: 65_000, lines: 12 },
    { id: 'sh-2', command: 'make', state: 'exited 2', ms: 3000, lines: 1 },
  ]);
  expect(rows.map((r) => [r.id, r.text, r.detail])).toEqual([
    ['ended:0', 'a', 'done · 1s'],
    ['endedjob:sh-1', '○ sh-1 · bun run dev', 'killed · 1m 5s · 12 lines'],
    ['endedjob:sh-2', '○ sh-2 · make', 'exited 2 · 3s · 1 line'],
  ]);
});
