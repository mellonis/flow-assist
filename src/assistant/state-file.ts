// The conversation as an external watcher reads it (contract v1): one JSON value per
// session, a root row for the chat itself and one row per live descendant, so a menu-bar
// watcher can see which agents need the person. Pure — a caller holds the stamps map and
// the clock, writes the file and offers it to the watcher.
//
// Every string goes through `redactSecrets`: a title, a label, the tool a node runs and a
// command's line reach a file outside the host, and none of them may carry a token.
import type { TreeNode } from './conversation-types.js';
import { redactSecrets } from './secrets.js';

// The chat's own row: the conversation itself rather than a descendant of it.
const ROOT_KEY = 'root';
const ROOT_LABEL = 'you';

interface StateShell {
  command: string;
  lines: number;
  running: boolean;
  state: string;
}

export interface StateNode {
  // 'root' for the chat itself.
  key: string;
  label: string;
  // `kind` passes through from `TreeNode` — a child's own kind, or `shell` for a job —
  // beside `chat` for the chat's own row.
  kind: 'chat' | 'task' | 'subagent' | 'shell';
  status: 'waiting' | 'asks' | 'working' | 'queued' | 'delayed' | 'idle';
  depth: number;
  answered: boolean;
  latest: string;
  // ISO-8601: when this status began, kept across snapshots by `stateStamp`.
  at: string;
  // ms epoch, from `TreeNode.until`.
  until: number | null;
  shell: StateShell | null;
}

export interface StateFileV1 {
  version: 1;
  id: string;
  project: string | null;
  title: string;
  pid: number;
  // ISO-8601, the moment of the snapshot.
  writtenAt: string;
  // ISO-8601, the session's own last change.
  updatedAt: string;
  status: 'working' | 'waiting' | 'held' | 'done' | 'idle';
  // [0] is the chat itself, then `conv.tree()` order.
  tree: StateNode[];
}

// One `{status, at}` per node key: what each node's status was at the last snapshot and
// when it became that. The caller keeps it for the session's life, so a status a watcher
// reads is timed from its start and not from the last write.
export type StateStamps = Map<string, { status: StateNode['status']; at: number }>;

export interface StateFileInput {
  id: string;
  project: string | null;
  title: string;
  status: StateFileV1['status'];
  // ms epoch, the session's own last change.
  updatedAt: number;
  pid: number;
  // The chat itself: its status, what it runs now, and whether an answer waits unread.
  own: { status: StateNode['status']; latest: string; answered: boolean };
  nodes: TreeNode[];
}

// The ISO time `key`'s status began: a status that differs from the last snapshot (or a
// key seen for the first time) is stamped with `now`, and one that did not change keeps
// the moment it began.
export function stateStamp(stamps: StateStamps, key: string, status: StateNode['status'], now: number): string {
  const prev = stamps.get(key);
  if (!prev || prev.status !== status) stamps.set(key, { status, at: now });
  return new Date(stamps.get(key)!.at).toISOString();
}

function shellOf(n: TreeNode): StateShell | null {
  if (!n.shell) return null;
  return {
    command: redactSecrets(n.shell.command),
    lines: n.shell.lines,
    running: n.shell.running,
    state: redactSecrets(n.shell.state),
  };
}

function nodeOf(n: TreeNode, stamps: StateStamps, now: number): StateNode {
  return {
    key: n.key,
    label: redactSecrets(n.label),
    kind: n.kind,
    status: n.status,
    depth: n.depth,
    answered: n.answered === true,
    latest: redactSecrets(n.latest),
    at: stateStamp(stamps, n.key, n.status, now),
    until: n.until ?? null,
    shell: shellOf(n),
  };
}

// The snapshot a watcher reads for one conversation at `now`.
export function buildStateFile(input: StateFileInput, stamps: StateStamps, now: number): StateFileV1 {
  const root: StateNode = {
    key: ROOT_KEY,
    label: ROOT_LABEL,
    kind: 'chat',
    status: input.own.status,
    depth: 0,
    answered: input.own.answered === true,
    latest: redactSecrets(input.own.latest),
    at: stateStamp(stamps, ROOT_KEY, input.own.status, now),
    until: null,
    shell: null,
  };
  return {
    version: 1,
    id: input.id,
    project: input.project,
    title: redactSecrets(input.title),
    pid: input.pid,
    writtenAt: new Date(now).toISOString(),
    updatedAt: new Date(input.updatedAt).toISOString(),
    status: input.status,
    tree: [root, ...input.nodes.map((n) => nodeOf(n, stamps, now))],
  };
}
