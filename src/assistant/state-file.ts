// The conversation as an external watcher reads it (contract v1): one JSON value per
// session, a root row for the chat itself and one row per live descendant, so a menu-bar
// watcher can see which agents need the person. `buildStateFile` is pure — a caller holds
// the stamps map and the clock — and `startStateFiles` mirrors the snapshots of the live
// sessions into their session directory, writing a file only when it changed.
//
// Every string goes through `redactSecrets`: a title, a label, the tool a node runs and a
// command's line reach a file outside the host, and none of them may carry a token.
import fs from 'node:fs';
import path from 'node:path';
import type { Conversation } from './conversation.js';
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

// ---- the writer: each live session's snapshot, mirrored beside its session file ----

// The snapshot input of a live conversation: a root row for the chat itself and the tree
// below it. `status` is the registry's own word for the session — the picker's
// `SessionStatus`, where a wait counts only when the person must answer it — `forPid` this
// process, and `now` both the moment of the snapshot and the session's own last change: a
// file is written only when its content changed, so a write IS the change.
//
// `own.answered` is the session's `done` — an answer nobody has read, as the picker and the
// registry read it. Not `unseenAnswer` itself: that lives in `sessions.ts`, which imports
// this module, and a runtime import back would be a cycle; `Conversation.status` applies
// exactly that predicate behind its wait and busy clauses, and those are the two cases in
// which an older answer is no longer what the person is owed.
export function stateInputOf(conv: Conversation, status: StateFileV1['status'], forPid: number, now: number): StateFileInput {
  return {
    id: conv.sessionId,
    project: conv.currentProject(),
    title: conv.title,
    status,
    updatedAt: now,
    pid: forPid,
    own: { status: ownStatus(conv), latest: ownLatest(conv), answered: conv.status === 'done' },
    nodes: conv.tree(),
  };
}

// What the chat itself is doing, from the person's side: a y/n or a question waits for
// them, an `ask_parent` waits for the model, and otherwise it works or it rests.
const ownStatus = (c: Conversation): StateNode['status'] =>
  c.confirm || c.question ? 'waiting' : c.parentAsk ? 'asks' : c.status === 'working' ? 'working' : 'idle';

// What it waits on, in one line: the tool a y/n names, else the question on screen.
const ownLatest = (c: Conversation): string =>
  c.confirm ? `${c.confirm.name} — y/n` : c.question?.state.questions[c.question.state.index]?.question ?? '';

const STATE_SUFFIX = '.state.json';

// The file one session's snapshot lives in, beside its `<id>.json`.
const statePath = (dir: string, id: string): string => path.join(dir, `${id}${STATE_SUFFIX}`);

// What a watcher reads as "this session changed": the whole snapshot but the two moments
// that move with the clock — the tick's own reading and the session's last change, which is
// that same reading. Everything else changing is a change.
const detectionString = (snapshot: StateFileV1): string => JSON.stringify({ ...snapshot, writtenAt: '', updatedAt: '' });

// Best-effort: a state file is a mirror, and a session taken away leaves nothing to
// mirror. A failed unlink is not the host's to report.
export function removeStateFile(dir: string, id: string): void {
  try {
    fs.unlinkSync(statePath(dir, id));
  } catch {
    // Not there, or not ours to remove.
  }
}

// Mirrors every live session's snapshot into `dir` once a tick, writing a session's file
// only when its snapshot changed and removing the file of one that left `sources()`.
// A mirror never breaks the host: a write that fails is swallowed, and the next tick
// tries again. `dir: null` — sessions kept in memory — writes nothing at all.
//
// `dirOf` places one session's file: sessions live under a mirror of their project's path,
// so a session's file belongs beside its `<id>.json`, in the directory the sessions' own
// functions are given when they take it away. `dir` alone when none is said.
export function startStateFiles(opts: {
  dir: string | null;
  sources: () => StateFileInput[];
  dirOf?: (input: StateFileInput) => string | null;
  intervalMs?: number;
  now?: () => number;
}): { stop(): void; flushNow(): void } {
  const { dir, sources, dirOf } = opts;
  const now = opts.now ?? Date.now;
  // Per session: the time each node's status began, and the directory and change-detection
  // string of the snapshot last written. Both live as long as the writer, so a status is
  // timed from its start across ticks, a snapshot that did not change costs no write, and a
  // session that drops out and comes back keeps the times its statuses began.
  const stamps = new Map<string, StateStamps>();
  const last = new Map<string, { dir: string; detect: string }>();

  // A temp file in the same directory, then a rename over the target: a reader never
  // sees half a snapshot, and a temp left by a crash carries this process's pid. The
  // directory is made when it is not there yet — a session that has nothing saved beside
  // it has no project mirror either.
  const write = (base: string, id: string, text: string): void => {
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    const target = statePath(base, id);
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${text}\n`, { mode: 0o600 });
    fs.renameSync(tmp, target);
  };

  const tick = (): void => {
    if (!dir) return;
    const seen = new Set<string>();
    for (const input of sources()) {
      seen.add(input.id);
      try {
        const base = dirOf ? dirOf(input) : dir;
        const was = last.get(input.id);
        // A session with no directory has no file to keep: one written before goes.
        if (!base) {
          if (was) {
            removeStateFile(was.dir, input.id);
            last.delete(input.id);
          }
          continue;
        }
        const forSession = stamps.get(input.id) ?? new Map<string, { status: StateNode['status']; at: number }>();
        stamps.set(input.id, forSession);
        const snapshot = buildStateFile(input, forSession, now());
        const detect = detectionString(snapshot);
        // Unchanged content in the same directory costs no write. A session the picker moved
        // to another project has a new directory, so its file follows it there and the one
        // it left goes, however little the snapshot itself says.
        if (was && was.dir === base && was.detect === detect) continue;
        if (was && was.dir !== base) removeStateFile(was.dir, input.id);
        write(base, input.id, JSON.stringify(snapshot));
        last.set(input.id, { dir: base, detect });
      } catch {
        // One session's file failing — a full disk, a directory gone — says nothing
        // about the others, and must not stop them.
      }
    }
    for (const [id, written] of [...last]) {
      if (seen.has(id)) continue;
      removeStateFile(written.dir, id);
      last.delete(id);
    }
  };

  // One tick, synchronous: a test drives the writer without waiting for the interval.
  const flushNow = (): void => {
    try {
      tick();
    } catch {
      // A mirror is never the host's record: nothing here reaches a redraw or a turn.
    }
  };

  const timer = setInterval(flushNow, opts.intervalMs ?? 1000);
  (timer as { unref?: () => void }).unref?.();

  return { stop: () => clearInterval(timer), flushNow };
}
