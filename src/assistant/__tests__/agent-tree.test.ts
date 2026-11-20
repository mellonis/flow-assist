import { expect, test } from 'bun:test';
import { agentsPanelRows, stopQuestion } from '../agent-tree.js';
import type { TreeNode } from '../conversation-types.js';

const node = (key: string, over: Partial<TreeNode> = {}): TreeNode => ({
  key, label: key, kind: 'subagent', depth: 1, status: 'working', latest: '', startedAt: 0, until: null, below: 0, ...over,
});

test('an idle subagent reads idle, and answered once a later answer is unread', () => {
  const panel = agentsPanelRows([node('a', { status: 'idle', startedAt: null }), node('b', { status: 'idle', answered: true, startedAt: null })], [], 0);
  expect(panel.map((r) => [r.text, r.detail, r.tone])).toEqual([['◦ a', 'idle', undefined], ['◦ b', 'answered', 'warn']]);
});

test('the stop question names the node and what is below it', () => {
  expect(stopQuestion({ label: 'a', below: 0 })).toBe('stop a? y yes · n no');
  expect(stopQuestion({ label: 'a', below: 2 })).toBe('stop a and 2 below it? y yes · n no');
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

test('/agents names the model a live node runs when it is not the chat\'s, and the ended rows keep their words', () => {
  const live = [
    node('a', { status: 'idle', startedAt: null, model: 'small-model' }),
    node('b', { status: 'idle', startedAt: null, model: 'default-model' }),
    node('c', { status: 'idle', startedAt: null }),
  ];
  const ended = [{ label: 'old', kind: 'subagent' as const, outcome: 'answer' as const, ms: 1000, tokens: 0 }];
  expect(agentsPanelRows(live, ended, 0, null, [], 'default-model').map((r) => r.detail)).toEqual([
    'idle · small-model',
    'idle',
    'idle',
    'done · 1s',
  ]);
  // A chat with no model of its own leaves a child's model the only one there is: it is shown.
  expect(agentsPanelRows(live, [], 0, null, [], undefined).map((r) => r.detail)).toEqual([
    'idle · small-model',
    'idle · default-model',
    'idle',
  ]);
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
