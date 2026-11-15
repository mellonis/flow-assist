// The contract-v1 snapshot an external watcher reads: the tree with a root row for the
// chat itself, the time each node's status began, and no secret in any string.
import { afterEach, expect, test } from 'bun:test';
import type { TreeNode } from '../conversation-types.ts';
import { buildSecretSet, setActiveSecrets } from '../secrets.ts';
import { buildStateFile, stateStamp } from '../state-file.ts';
import type { StateFileInput, StateStamps } from '../state-file.ts';

const node = (key: string, over: Partial<TreeNode> = {}): TreeNode => ({
  key, label: key, kind: 'subagent', depth: 1, status: 'working', latest: '', startedAt: 0, until: null, below: 0, ...over,
});

const input = (over: Partial<StateFileInput> = {}): StateFileInput => ({
  id: 'ses-1',
  project: '/tmp/project',
  title: 'a chat',
  status: 'working',
  updatedAt: 1000,
  pid: 1,
  own: { status: 'idle', latest: '', answered: false },
  nodes: [],
  ...over,
});

afterEach(() => { setActiveSecrets(null); });

test('a snapshot mirrors the tree under a root row for the chat itself', () => {
  const file = buildStateFile(
    input({ own: { status: 'working', latest: 'writing', answered: false }, nodes: [node('a', { label: 'maker', status: 'working', depth: 1 })], pid: 4242 }),
    new Map(),
    1000,
  );
  expect(file.version).toBe(1);
  expect(file.tree[0]).toMatchObject({ key: 'root', kind: 'chat', label: 'you', depth: 0, status: 'working', latest: 'writing' });
  expect(file.tree[1]).toMatchObject({ key: 'a', label: 'maker', status: 'working', depth: 1, until: null });
  expect(file.pid).toBe(4242);
  expect(file.writtenAt).toBe(new Date(1000).toISOString());
  expect(file.updatedAt).toBe(new Date(1000).toISOString());
});

test('a node keeps the time its status began across snapshots', () => {
  const stamps: StateStamps = new Map();
  const first = buildStateFile(input({ nodes: [node('a', { status: 'waiting' })] }), stamps, 1000);
  const second = buildStateFile(input({ nodes: [node('a', { status: 'waiting' })] }), stamps, 5000);
  const changed = buildStateFile(input({ nodes: [node('a', { status: 'working' })] }), stamps, 9000);
  expect(second.tree[1]!.at).toBe(first.tree[1]!.at);
  expect(first.tree[1]!.at).toBe(new Date(1000).toISOString());
  expect(changed.tree[1]!.at).toBe(new Date(9000).toISOString());
});

test('a shell node carries the four fields of its job', () => {
  const file = buildStateFile(
    input({ nodes: [node('job:sh-1', { kind: 'shell', status: 'idle', answered: true, shell: { id: 'sh-1', command: 'bun test', state: 'exited 0', running: false, ms: 1200, lines: 7 } })] }),
    new Map(),
    1000,
  );
  expect(file.tree[1]).toMatchObject({ kind: 'shell', answered: true, shell: { command: 'bun test', lines: 7, running: false, state: 'exited 0' } });
});

test('labels, latest text and commands are redacted', () => {
  const token = 'TESTTOKEN-1234567890';
  setActiveSecrets(buildSecretSet({}, { TEST_TOKEN: token }));
  const file = buildStateFile(
    input({
      title: `chat about ${token}`,
      own: { status: 'working', latest: `running ${token}`, answered: false },
      nodes: [
        node('a', { label: `maker ${token}`, status: 'working', latest: `read ${token}` }),
        node('job:sh-1', {
          kind: 'shell',
          label: 'sh-1',
          shell: { id: 'sh-1', command: `echo ${token}`, state: `killed ${token}`, running: false, ms: 1, lines: 1 },
        }),
      ],
    }),
    new Map(),
    1000,
  );
  const json = JSON.stringify(file);
  expect(json).not.toContain(token);
  expect(json).toContain('‹secret');
});

test('stateStamp re-stamps only when the status changes', () => {
  const stamps: StateStamps = new Map();
  expect(stateStamp(stamps, 'a', 'working', 1000)).toBe(new Date(1000).toISOString());
  expect(stateStamp(stamps, 'a', 'working', 2000)).toBe(new Date(1000).toISOString());
  expect(stateStamp(stamps, 'a', 'waiting', 3000)).toBe(new Date(3000).toISOString());
  expect(stateStamp(stamps, 'b', 'idle', 4000)).toBe(new Date(4000).toISOString());
});
