// The contract-v1 snapshot an external watcher reads: the tree with a root row for the
// chat itself, the time each node's status began, and no secret in any string.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TreeNode } from '../conversation-types.ts';
import { buildSecretSet, setActiveSecrets } from '../secrets.ts';
import { buildStateFile, removeStateFile, startStateFiles, stateStamp } from '../state-file.ts';
import type { StateFileInput, StateStamps } from '../state-file.ts';

const dirs: string[] = [];
const writers: Array<{ stop(): void }> = [];
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-state-'))); dirs.push(d); return d; };
const writer = (opts: Parameters<typeof startStateFiles>[0]) => { const w = startStateFiles(opts); writers.push(w); return w; };
const read = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

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

afterEach(() => {
  for (const w of writers.splice(0)) w.stop();
  setActiveSecrets(null);
  for (const d of dirs.splice(0)) { try { fs.chmodSync(d, 0o700); } catch { /* removed already */ } fs.rmSync(d, { recursive: true, force: true }); }
});

test('a snapshot mirrors the tree under a root row for the chat itself', () => {
  const file = buildStateFile(
    input({ own: { status: 'working', latest: 'writing', answered: false }, nodes: [node('a', { label: 'maker', status: 'working', depth: 1 })], pid: 4242 }),
    new Map(),
    9000,
  );
  expect(file.version).toBe(1);
  expect(file.tree[0]).toMatchObject({ key: 'root', kind: 'chat', label: 'you', depth: 0, status: 'working', latest: 'writing' });
  expect(file.tree[1]).toMatchObject({ key: 'a', label: 'maker', status: 'working', depth: 1, until: null });
  expect(file.pid).toBe(4242);
  // The moment of the snapshot is the clock's, never the session's own last change.
  expect(file.writtenAt).toBe(new Date(9000).toISOString());
  expect(file.updatedAt).toBe(new Date(1000).toISOString());
});

test('a delayed node carries its until as a ms epoch', () => {
  const file = buildStateFile(input({ nodes: [node('a', { status: 'delayed', until: 5000 })] }), new Map(), 1000);
  expect(file.tree[1]).toMatchObject({ status: 'delayed', until: 5000 });
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

// ---- the writer: a mirror of each live session, beside its session file ----

test('a state file is written only when the snapshot changes', () => {
  const dir = tmp();
  let source = input({ status: 'working' });
  let clock = 1000;
  const w = writer({ dir, sources: () => [source], now: () => ++clock });
  const file = path.join(dir, 'ses-1.state.json');

  w.flushNow();
  const first = fs.readFileSync(file, 'utf8');
  expect(read(file)).toMatchObject({ version: 1, id: 'ses-1', status: 'working' });

  // The clock moved, the session did not: the file is left as it is.
  w.flushNow();
  expect(fs.readFileSync(file, 'utf8')).toBe(first);

  // A changed session is a new snapshot.
  source = input({ status: 'waiting' });
  w.flushNow();
  const second = fs.readFileSync(file, 'utf8');
  expect(second).not.toBe(first);
  expect(read(file)).toMatchObject({ version: 1, id: 'ses-1', status: 'waiting' });
});

test('a session that leaves is its state file removed', () => {
  const dir = tmp();
  let sources = [input({ id: 'ses-1' }), input({ id: 'ses-2' })];
  const w = writer({ dir, sources: () => sources, now: () => 1000 });
  w.flushNow();
  expect(fs.existsSync(path.join(dir, 'ses-1.state.json'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'ses-2.state.json'))).toBe(true);

  sources = [input({ id: 'ses-1' })];
  w.flushNow();
  expect(fs.existsSync(path.join(dir, 'ses-1.state.json'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'ses-2.state.json'))).toBe(false);
  expect(fs.readdirSync(dir)).toEqual(['ses-1.state.json']);
});

test('the file is written atomically at 0600', () => {
  const dir = tmp();
  const w = writer({ dir, sources: () => [input()], now: () => 1000 });
  w.flushNow();
  const file = path.join(dir, 'ses-1.state.json');
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  // What a reader can see is the finished file: the temporary it was written to is gone.
  expect(fs.readdirSync(dir)).toEqual(['ses-1.state.json']);
  expect(() => read(file)).not.toThrow();
});

test('no sessions dir means no writes', () => {
  const w = writer({ dir: null, sources: () => [input()], now: () => 1000 });
  expect(() => w.flushNow()).not.toThrow();
  // With no directory there is nowhere to write — the working directory is no fallback.
  expect(fs.existsSync(path.join(process.cwd(), 'ses-1.state.json'))).toBe(false);
});

test('a failing write never throws out of the tick', () => {
  const dir = tmp();
  fs.chmodSync(dir, 0o500);
  const w = writer({ dir, sources: () => [input()], now: () => 1000 });
  expect(() => w.flushNow()).not.toThrow();
  expect(fs.readdirSync(dir)).toEqual([]);
  expect(() => removeStateFile(dir, 'ses-1')).not.toThrow();
});
