import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KEEP_MESSAGES, SESSION_VERSION, closeSession, listSessions, loadSession, newSessionId,
  normalizeViews, pruneSessions, saveSession, sessionToContinue, sessionsDir, type Session,
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
