import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KEEP_MESSAGES, SESSION_VERSION, acquireLock, closeSession, listSessions, loadSession, lockPath, makeLockToken,
  newSessionId, normalizeViews, pruneSessions, releaseLock, saveSession, sessionFingerprint, sessionFingerprintsEqual,
  sessionRev, sessionToContinue, sessionsDir, type Session,
} from '../sessions.ts';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sess-')), 'sessions');
const session = (over: Partial<Session> = {}): Session => ({
  version: SESSION_VERSION, id: newSessionId(), title: '', createdAt: '2026-09-21T10:00:00.000Z', updatedAt: '2026-09-21T10:00:00.000Z',
  messages: [{ role: 'user', content: 'как тренд по ABC-341?' }, { role: 'assistant', content: 'Вверх.', duration: 1200 }],
  api: [{ role: 'user', content: 'как тренд по ABC-341?' }, { role: 'assistant', content: 'Вверх.' }],
  summary: '', plan: [{ id: 1, text: 'посмотреть', status: 'done' }], usage: { promptTokens: 900, completionTokens: 40 },
  prompts: ['как тренд по ABC-341?'], draft: 'а на след', ...over,
});

test('a session is saved whole and read back; only the person can read it', () => {
  const dir = tmp();
  const s = session();
  saveSession(dir, s);
  const back = loadSession(dir, s.id)!;
  expect(back.messages).toEqual(s.messages);
  expect(back.api).toEqual(s.api);
  expect(back.plan).toEqual(s.plan);
  expect(back.usage).toEqual(s.usage);
  expect(back.draft).toBe('а на след');
  expect(back.title).toBe('как тренд по ABC-341?');
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  expect(fs.statSync(path.join(dir, `${s.id}.json`)).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]); // no temp file left
});

test("a session keeps what the chat was about; one saved as `issue` still reads", () => {
  const dir = tmp();
  const s = session({ subject: 'DOC-7' });
  saveSession(dir, s);
  expect(loadSession(dir, s.id)!.subject).toBe('DOC-7');
  // Saved by an older build under its old name — a number, even.
  const old = session({ id: newSessionId() });
  saveSession(dir, { ...old, issue: 42 } as Session);
  expect(loadSession(dir, old.id)!.subject).toBe('42');
  const none = session({ id: newSessionId() });
  saveSession(dir, none);
  expect(loadSession(dir, none.id)!.subject).toBeNull();
});

test('an answer still being written is not saved as a message', () => {
  const dir = tmp();
  const s = session({ messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '', live: 'полови' }] });
  saveSession(dir, s);
  expect(loadSession(dir, s.id)!.messages[1]).toEqual({ role: 'assistant', content: '' });
});

test('a long conversation keeps its latest messages', () => {
  const dir = tmp();
  const many = Array.from({ length: KEEP_MESSAGES + 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) }));
  const s = session({ messages: many, api: many });
  saveSession(dir, s);
  const back = loadSession(dir, s.id)!;
  expect(back.messages).toHaveLength(KEEP_MESSAGES);
  expect(back.messages.at(-1)).toEqual(many.at(-1));
});

test('the list is newest first and skips a file that does not parse; a start continues the newest unless it was cleared', () => {
  const dir = tmp();
  const older = session({ id: '2026-09-20T09-00-00-aaaa', updatedAt: '2026-09-20T09:00:00.000Z' });
  const newer = session({ id: '2026-09-21T09-00-00-bbbb', updatedAt: '2026-09-21T09:00:00.000Z' });
  saveSession(dir, older); saveSession(dir, newer);
  fs.writeFileSync(path.join(dir, '2026-09-21T11-00-00-cccc.json'), '{"version":1,"id":');
  expect(listSessions(dir).map((s) => s.id)).toEqual([newer.id, older.id]);
  expect(sessionToContinue(dir)!.id).toBe(newer.id);
  closeSession(dir, newer.id);
  expect(sessionToContinue(dir)).toBeNull();
  expect(listSessions(dir)[0]).toMatchObject({ id: newer.id, closed: true });
});

test('old sessions beyond the limit are removed', () => {
  const dir = tmp();
  for (let d = 1; d <= 5; d++) saveSession(dir, session({ id: `2026-09-0${d}T09-00-00-000${d}`, updatedAt: `2026-09-0${d}T09:00:00.000Z` }));
  expect(pruneSessions(dir, 3)).toBe(2);
  expect(listSessions(dir).map((s) => s.id)).toEqual(['2026-09-05T09-00-00-0005', '2026-09-04T09-00-00-0004', '2026-09-03T09-00-00-0003']);
});

test('under bun test with no dir named, nothing goes to disk; a named dir is used', () => {
  expect(sessionsDir({}, { NODE_ENV: 'test' })).toBeNull();
  expect(sessionsDir({}, {})).toMatch(/flow-assist[/\\]sessions$/);
  expect(sessionsDir({ sessions: { dir: '/tmp/x' } }, { NODE_ENV: 'test' })).toBe('/tmp/x');
  expect(() => loadSession('/tmp', '../../etc/passwd')).not.toThrow();
  expect(loadSession('/tmp', '../../etc/passwd')).toBeNull();
});

test('a view saved while it ran is read back as failed, and an old console view as a record', () => {
  const live = { role: 'view', content: '', views: [{ kind: 'console', data: { command: 'x' }, phase: 'live', startedAt: 5 }] };
  const old = { role: 'view', content: '', views: [{ kind: 'console', command: 'y', text: 't', exitCode: 0, ms: 1, cwd: '~' }] };
  const [a, b] = normalizeViews([live, old]) as { views: { phase: string }[] }[];
  expect(a!.views[0]!.phase).toBe('failed');
  expect(b!.views[0]).toEqual({ kind: 'console', data: { command: 'y', text: 't', exitCode: 0, ms: 1, cwd: '~' }, phase: 'done', startedAt: 0 });
  expect(normalizeViews([{ role: 'user', content: 'hi' }])).toEqual([{ role: 'user', content: 'hi' }]);
});

test('normalizeViews drops a view that has nothing a renderer could draw', () => {
  const good = { kind: 'console', data: { command: 'x' }, phase: 'done', startedAt: 0 };
  const m = { role: 'view', content: '', views: ['a-string', 42, { phase: 'done' }, good] };
  expect(normalizeViews([m])).toEqual([{ role: 'view', content: '', views: [good] }]);
});

test('a session with a live view, a legacy console view and a malformed entry reads back correct and drops the last', () => {
  const dir = tmp();
  const id = newSessionId();
  const file = path.join(dir, `${id}.json`);
  fs.mkdirSync(dir, { recursive: true });
  const raw = {
    version: SESSION_VERSION, id, title: '', createdAt: '2026-09-21T10:00:00.000Z', updatedAt: '2026-09-21T10:00:00.000Z',
    messages: [
      { role: 'view', content: '', views: [{ kind: 'console', data: { command: 'a' }, phase: 'live', startedAt: 5 }] },
      { role: 'view', content: '', views: [{ kind: 'console', command: 'b', text: 't', exitCode: 0, ms: 1, cwd: '~' }] },
      { role: 'view', content: '', views: [{ phase: 'done' }, 7] },
    ],
    api: [], summary: '', plan: [], usage: null, prompts: [], draft: '',
  };
  fs.writeFileSync(file, JSON.stringify(raw));
  const loaded = loadSession(dir, id)! as unknown as { messages: { views: unknown[] }[] };
  expect((loaded.messages[0]!.views[0] as { phase: string }).phase).toBe('failed');
  expect(loaded.messages[1]!.views[0]).toEqual({ kind: 'console', data: { command: 'b', text: 't', exitCode: 0, ms: 1, cwd: '~' }, phase: 'done', startedAt: 0 });
  expect(loaded.messages[2]!.views).toEqual([]);
});

// ─── rev: a save that checks ───────────────────────────────────────────────────

test('saveSession bumps rev on every write and returns the written fingerprint; sessionRev reads it without loading the file', () => {
  const dir = tmp();
  const s = session();
  expect(saveSession(dir, s)).toMatchObject({ rev: 1 });
  expect(sessionRev(dir, s.id)).toBe(1);
  expect(loadSession(dir, s.id)!.rev).toBe(1);
  expect(saveSession(dir, { ...s, draft: 'x' })).toMatchObject({ rev: 2 });
  expect(sessionRev(dir, s.id)).toBe(2);
  expect(loadSession(dir, s.id)!.rev).toBe(2);
  // A session that was never written reads as rev 0, same as a missing file.
  expect(sessionRev(dir, newSessionId())).toBe(0);
});

test('sessionFingerprint carries mtimeMs/size alongside rev, and a missing file reads as the same all-zero fingerprint saveSession returned nothing for yet', () => {
  const dir = tmp();
  const s = session();
  const written = saveSession(dir, s);
  const fp = sessionFingerprint(dir, s.id);
  expect(fp).toEqual(written);
  expect(fp.size).toBeGreaterThan(0);
  expect(fp.mtimeMs).toBeGreaterThan(0);
  expect(sessionFingerprint(dir, newSessionId())).toEqual({ rev: 0, mtimeMs: 0, size: 0 });
  expect(sessionFingerprintsEqual(fp, { ...fp })).toBe(true);
  expect(sessionFingerprintsEqual(fp, { ...fp, size: fp.size + 1 })).toBe(false);
  expect(sessionFingerprintsEqual(fp, { ...fp, mtimeMs: fp.mtimeMs + 1 })).toBe(false);
  expect(sessionFingerprintsEqual(fp, { ...fp, rev: fp.rev + 1 })).toBe(false);
});

// A caller (applySession, src/plugins/assistant.ts) must take the fingerprint
// BEFORE reading a session's content, never after — otherwise a write landing in
// the gap between the two reads is recorded as "seen" even though the content read
// never saw it, and the next save silently overwrites it. This is not something
// loadSession/sessionFingerprint enforce on their own (both are unchanged, simple
// primitives); it is a calling-convention property. What is deterministically
// testable here is the shape of the guarantee: a fingerprint taken before a write
// differs from the disk's fingerprint afterward — so recording the BEFORE value (as
// applySession now does, per the caller's own comment) means the next save's
// compare against the disk's CURRENT state disagrees and forks, rather than
// matching and silently overwriting. Taking it AFTER the write — the bug — would
// instead record exactly that current state, indistinguishable from "nothing
// changed."
test('a fingerprint taken before a write differs from the disk afterward — recording the before value is what makes the next save fork', () => {
  const dir = tmp();
  const s = session();
  saveSession(dir, s);

  // The safe order applySession now follows: stat/fingerprint first...
  const before = sessionFingerprint(dir, s.id);
  // ...then, before (or during) the content read, a foreign write lands.
  saveSession(dir, { ...s, messages: [...s.messages, { role: 'user', content: 'RACED IN' }] });
  const loaded = loadSession(dir, s.id)!; // reads whatever is on disk now — the raced-in content
  expect(loaded.messages.some((m) => m.content === 'RACED IN')).toBe(true);

  // Recording `before` (taken ahead of the race) leaves the next save's compare
  // against the disk's current fingerprint disagreeing — a fork, not an overwrite.
  const diskNow = sessionFingerprint(dir, s.id);
  expect(sessionFingerprintsEqual(before, diskNow)).toBe(false);
  // Had the fingerprint instead been taken AFTER the content read (the bug this
  // fixes), it would equal `diskNow` exactly — indistinguishable from "unchanged".
  const afterTheBuggyWay = sessionFingerprint(dir, s.id);
  expect(sessionFingerprintsEqual(afterTheBuggyWay, diskNow)).toBe(true);
});

test('a session with no rev field — an older host — reads and peeks as rev 0', () => {
  const dir = tmp();
  const id = newSessionId();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    version: SESSION_VERSION, id, title: '', createdAt: '', updatedAt: '',
    messages: [], api: [], summary: '', plan: [], usage: null, prompts: [], draft: '',
  }));
  expect(sessionRev(dir, id)).toBe(0);
  expect(loadSession(dir, id)!.rev).toBe(0);
});

// ─── ownership lock ────────────────────────────────────────────────────────────

test('acquireLock: free becomes ours, a re-acquire with the same token reads ours', () => {
  const dir = tmp();
  const id = newSessionId();
  expect(acquireLock(dir, id, 'tok-a', { host: 'h1' })).toEqual({ status: 'acquired' });
  expect(acquireLock(dir, id, 'tok-a', { host: 'h1' })).toEqual({ status: 'ours' });
  expect(JSON.parse(fs.readFileSync(path.join(dir, `${id}.lock`), 'utf8'))).toMatchObject({ host: 'h1', token: 'tok-a' });
});

test('acquireLock: a different token on the same host is held while the pid reads alive', () => {
  const dir = tmp();
  const id = newSessionId();
  acquireLock(dir, id, 'tok-a', { host: 'h1', pidAlive: () => true });
  const held = acquireLock(dir, id, 'tok-b', { host: 'h1', pidAlive: () => true });
  expect(held.status).toBe('held');
  expect(held.status === 'held' && held.holder.token).toBe('tok-a');
  // Held is side-effect free: the lock still says tok-a.
  expect(JSON.parse(fs.readFileSync(path.join(dir, `${id}.lock`), 'utf8')).token).toBe('tok-a');
});

test('acquireLock: a dead pid on our own host is stale and is taken over', () => {
  const dir = tmp();
  const id = newSessionId();
  acquireLock(dir, id, 'tok-a', { host: 'h1', pidAlive: () => true });
  const taken = acquireLock(dir, id, 'tok-b', { host: 'h1', pidAlive: () => false });
  expect(taken).toEqual({ status: 'acquired' });
  expect(JSON.parse(fs.readFileSync(path.join(dir, `${id}.lock`), 'utf8')).token).toBe('tok-b');
});

test('acquireLock: a lock from another host is held even if this host would say the pid is dead', () => {
  const dir = tmp();
  const id = newSessionId();
  acquireLock(dir, id, 'tok-a', { host: 'h1' });
  const held = acquireLock(dir, id, 'tok-b', { host: 'h2', pidAlive: () => false });
  expect(held.status).toBe('held');
  expect(held.status === 'held' && held.holder.host).toBe('h1');
});

test('releaseLock only removes a lock this token owns', () => {
  const dir = tmp();
  const id = newSessionId();
  acquireLock(dir, id, 'tok-a', { host: 'h1' });
  releaseLock(dir, id, 'tok-b'); // not ours — no-op
  expect(acquireLock(dir, id, 'tok-c', { host: 'h1', pidAlive: () => true }).status).toBe('held');
  releaseLock(dir, id, 'tok-a');
  expect(acquireLock(dir, id, 'tok-c', { host: 'h1' })).toEqual({ status: 'acquired' });
  releaseLock(dir, id, 'nope'); // an already-gone file — still a no-op, never throws
});

test('makeLockToken makes a distinct token each time', () => {
  expect(makeLockToken()).not.toBe(makeLockToken());
});

test('lockPath names the lock beside the session file', () => {
  const dir = tmp();
  const id = newSessionId();
  expect(lockPath(dir, id)).toBe(path.join(dir, `${id}.lock`));
});

test('acquireLock: an unreadable lock file is held while recent, and taken over once it is stale (older than 5s)', () => {
  const dir = tmp();
  const id = newSessionId();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.lock`);
  fs.writeFileSync(file, 'not json{{{'); // a create racing its write, or corruption

  const recent = acquireLock(dir, id, 'tok-a', { host: 'h1' });
  expect(recent.status).toBe('held');
  // Held is side-effect free: the corrupt bytes are still there, untouched.
  expect(fs.readFileSync(file, 'utf8')).toBe('not json{{{');

  const old = new Date(Date.now() - 6000);
  fs.utimesSync(file, old, old);
  const taken = acquireLock(dir, id, 'tok-a', { host: 'h1' });
  expect(taken).toEqual({ status: 'acquired' });
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).token).toBe('tok-a');
});

test('acquireLock: an unreadable lock right at the 5s edge reads held just inside it and stale just past it', () => {
  const dir = tmp();
  const id = newSessionId();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.lock`);

  fs.writeFileSync(file, 'garbage');
  const justInside = new Date(Date.now() - 4000);
  fs.utimesSync(file, justInside, justInside);
  expect(acquireLock(dir, id, 'tok-a', { host: 'h1' }).status).toBe('held');

  fs.writeFileSync(file, 'garbage');
  const justPast = new Date(Date.now() - 5001);
  fs.utimesSync(file, justPast, justPast);
  expect(acquireLock(dir, id, 'tok-a', { host: 'h1' })).toEqual({ status: 'acquired' });
});

// ─── pruneSessions leaves a held session and its lock alone ────────────────────

test('pruneSessions never deletes a session whose lock is currently held, but does remove it once released', () => {
  const dir = tmp();
  saveSession(dir, session({ id: '2026-09-01T09-00-00-0001', updatedAt: '2026-09-01T09:00:00.000Z' }));
  saveSession(dir, session({ id: '2026-09-02T09-00-00-0002', updatedAt: '2026-09-02T09:00:00.000Z' }));
  // Our own live lock on the older one (a real, definitely-alive pid) — still "held"
  // as far as pruneSessions, which has no token of its own, can tell.
  acquireLock(dir, '2026-09-01T09-00-00-0001', 'tok-a');

  expect(pruneSessions(dir, 0)).toBe(1); // only the unlocked one goes
  expect(listSessions(dir).map((s) => s.id)).toEqual(['2026-09-01T09-00-00-0001']);

  releaseLock(dir, '2026-09-01T09-00-00-0001', 'tok-a');
  expect(pruneSessions(dir, 0)).toBe(1);
  expect(listSessions(dir)).toEqual([]);
});

test('pruneSessions sweeps a .lock file whose session is already gone, but leaves one that is still held', () => {
  const dir = tmp();
  fs.mkdirSync(dir, { recursive: true });
  const orphanId = newSessionId();
  const heldOrphanId = newSessionId();
  // A dead process's lock, session file never existed (or was deleted by hand) — an orphan to sweep.
  const dead = spawnSync('true');
  fs.writeFileSync(lockPath(dir, orphanId), JSON.stringify({ pid: dead.pid, host: os.hostname(), token: 'tok-a', at: new Date().toISOString() }), { mode: 0o600 });
  // A live process's lock, same situation otherwise — left alone.
  acquireLock(dir, heldOrphanId, 'tok-b');

  pruneSessions(dir, 0);
  expect(fs.existsSync(lockPath(dir, orphanId))).toBe(false);
  expect(fs.existsSync(lockPath(dir, heldOrphanId))).toBe(true);
});
