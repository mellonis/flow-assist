import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Conversation } from '../conversation.ts';
import { readJournal } from '../journal.ts';
import { SESSION_VERSION, journalPath, loadSession, newSessionId, projectHome, saveSession, sessionFingerprint, type Session } from '../sessions.ts';
import type { ViewPort } from '../conversation-types.ts';
import { fakeDeps } from './conversation-deps.ts';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-cs-')));
const port = (over: Partial<ViewPort> = {}): ViewPort => ({ showsEnd: () => false, open: () => false, input: () => '', draft: () => 'half a thought', ...over });
const session = (over: Partial<Session> = {}): Session => {
  const now = new Date().toISOString();
  return { version: SESSION_VERSION, id: newSessionId(), title: 'kept', createdAt: now, updatedAt: now,
    messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi', duration: 5 }],
    api: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }],
    summary: '', plan: [], usage: null, prompts: ['hello'], draft: '', ...over };
};
const opened = (dir: string, s: Session, p = port()) => {
  const home = projectHome(dir, null);
  saveSession(home, s);
  const c = new Conversation(fakeDeps({ sessionsDir: () => dir }));
  c.attach(p);
  c.applySession(s, sessionFingerprint(home, s.id), home);
  return { c, home };
};

test('nothing said: no id, no file, and journal lines wait for the first thing kept', () => {
  const dir = tmp();
  const c = new Conversation(fakeDeps({ sessionsDir: () => dir }));
  c.save();
  expect(c.sessionId).toBe('');
  expect(c.journal({ t: 'row', role: 'note', text: 'held' })).toBe('');
  expect(c.journalBuf).toHaveLength(1);
  const id = c.journal({ t: 'row', role: 'user', text: 'first' }, { person: true });
  expect(id).toBe(c.sessionId);
  const lines = readJournal(journalPath(c.homes.get(id)!, id))!;
  expect(lines.map((l) => l.t)).toEqual(['start', 'row', 'row']);
  expect(lines[1]!.text).toBe('held');
});

test('an opened session saves with the field\'s draft and its prompts, and keeps its id', () => {
  const dir = tmp();
  const { c, home } = opened(dir, session());
  c.prompts.push('again');
  c.save();
  const back = loadSession(home, c.sessionId)!;
  expect(back.draft).toBe('half a thought');
  expect(back.prompts).toEqual(['hello', 'again']);
  expect(back.api).toHaveLength(2);
  expect(c.rows()).toHaveLength(2);
});

test('a file changed elsewhere forks: a new id, a note, and the fork\'s journal names its parent', () => {
  const dir = tmp();
  const s = session();
  const { c, home } = opened(dir, s);
  saveSession(home, { ...s, title: 'someone else' }); // the disk moves under us
  c.save();
  expect(c.sessionId).not.toBe(s.id);
  expect(c.forkedTo.get(s.id)).toBe(c.sessionId);
  expect(c.rows().at(-1)!.content).toContain('was changed elsewhere');
  const lines = readJournal(journalPath(home, c.sessionId))!;
  expect(lines[0]).toMatchObject({ t: 'start', parent: s.id });
  c.journalTo(s.id, { t: 'row', role: 'note', text: 'in flight' });
  expect(readJournal(journalPath(home, c.sessionId))!.at(-1)!.text).toBe('in flight');
});

test('with no sessions directory the project is still decided, and nothing is written', () => {
  const c = new Conversation(fakeDeps());
  c.ensureSessionId();
  expect(c.sessionId).not.toBe('');
  expect(c.homes.size).toBe(0);
  expect(c.currentProject()).toBe(c.sessionProject);
});

test('opening a session forgets which secret variables the last one was told of', () => {
  const dir = tmp();
  const home = projectHome(dir, null);
  const s = session();
  saveSession(home, s);
  const c = new Conversation(fakeDeps({ sessionsDir: () => dir }));
  c.shell.told.add('SOME_TOKEN');
  c.applySession(s, sessionFingerprint(home, s.id), home);
  expect(c.shell.told.size).toBe(0);
});

test('opened where the end shows, an unseen answer is seen', () => {
  const dir = tmp();
  const { c } = opened(dir, session({ answeredAt: '2026-09-27T10:00:00.000Z', seenAt: '2026-09-27T09:00:00.000Z' }), port({ showsEnd: () => true }));
  expect(c.seenAt > '2026-09-27T10:00:00.000Z').toBe(true);
  expect(c.autoMode).toBe('ask');
});

test('a nested run is journaled in the session that started it, a task\'s lines tagged', async () => {
  const dir = tmp();
  const calls: string[] = [];
  const deps = fakeDeps({
    sessionsDir: () => dir,
    chatLLM: (async (_m: unknown, o: Record<string, any>) => {
      o.onToolStart({ id: 'k1', name: 'write_file', args: {}, confirm: true });
      calls.push(String(await o.confirmWrite('write_file', '{}', { id: 'k1' })));
      o.onToolRun({ id: 'k1', name: 'write_file', args: {}, outcome: 'declined', detail: null });
      return { content: '' };
    }) as never,
  });
  const c = new Conversation(deps);
  const id = c.journal({ t: 'row', role: 'user', text: 'go' }, { person: true });
  await c.journaledChatLLM(id)([], { taskLabel: 'scan', confirmWrite: () => false });
  expect(calls).toEqual(['false']);
  const lines = readJournal(journalPath(c.homes.get(id)!, id))!;
  expect(lines.filter((l) => l.task === 'scan').map((l) => l.t)).toEqual(['call-start', 'confirm', 'call']);
  expect(lines.find((l) => l.t === 'confirm')).toMatchObject({ answer: 'no', by: 'background' });
});
