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

test('a nested run is journaled in the session that started it', async () => {
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
  await c.journaledChatLLM(id)([], { confirmWrite: () => false });
  expect(calls).toEqual(['false']);
  const lines = readJournal(journalPath(c.homes.get(id)!, id))!;
  expect(lines.filter((l) => l.t !== 'start' && l.t !== 'row').map((l) => l.t)).toEqual(['call-start', 'confirm', 'call']);
  expect(lines.find((l) => l.t === 'confirm')).toMatchObject({ answer: 'no', by: 'plugin' });
});

test('a nested run reports its waits as log lines, unless the caller answers them', async () => {
  const dir = tmp();
  const info = { attempt: 1, of: 10, status: 503, waitMs: 3000, message: 'LLM 503 · m: busy' };
  const answered: number[] = [];
  const deps = fakeDeps({
    sessionsDir: () => dir,
    chatLLM: (async (_m: unknown, o: Record<string, any>) => {
      o.onRetry(info);
      return { content: '' };
    }) as never,
  });
  const c = new Conversation(deps);
  const id = c.journal({ t: 'row', role: 'user', text: 'go' }, { person: true });
  await c.journaledChatLLM(id)([], {});
  expect(deps.log).toEqual(['[chat] LLM 503 · m: busy — retry 1/10 in 3 s']);
  expect(c.toolLabel).toBe('');

  const own = fakeDeps({
    sessionsDir: () => dir,
    chatLLM: (async (_m: unknown, o: Record<string, any>) => { o.onRetry(info); return { content: '' }; }) as never,
  });
  const d = new Conversation(own);
  const did = d.journal({ t: 'row', role: 'user', text: 'go' }, { person: true });
  await d.journaledChatLLM(did)([], { onRetry: (i: { attempt: number }) => { answered.push(i.attempt); } });
  expect(answered).toEqual([1]);
  expect(own.log).toEqual([]);
});

// ─── the auto mode is saved with its session ──────────────────────────────────

// The session as a later process opens it: read from the file, into a conversation of
// its own, with `shell.autoRun` as the config then says.
const reopen = (dir: string, home: string, id: string, autoRun = false) => {
  const deps = fakeDeps({ sessionsDir: () => dir });
  (deps.config() as { shell: Record<string, unknown> }).shell.autoRun = autoRun;
  const s = loadSession(home, id)!;
  const c = Conversation.restore(deps, s, sessionFingerprint(home, id), home);
  return { c, notes: c.rows().filter((m) => m.role === 'note').map((m) => String(m.content)) };
};

test('a mode set on a session is written by the save and comes back with a note that names it', () => {
  const dir = tmp();
  const { c, home } = opened(dir, session());
  c.setAutoMode('all');
  c.save();
  expect(loadSession(home, c.sessionId)!.autoMode).toBe('all');
  const withRun = reopen(dir, home, c.sessionId, true);
  expect(withRun.c.autoMode).toBe('all');
  expect(withRun.notes).toEqual(['auto: writes + commands — restored with this session']);
  const without = reopen(dir, home, c.sessionId, false);
  expect(without.c.autoMode).toBe('all');
  expect(without.notes).toEqual(['auto: writes — restored with this session']);
});

test('reads comes back as reads, with its note', () => {
  const dir = tmp();
  const { c, home } = opened(dir, session());
  c.setAutoMode('reads');
  c.save();
  const back = reopen(dir, home, c.sessionId, true);
  expect(back.c.autoMode).toBe('reads');
  expect(back.notes).toEqual(['auto: reads — restored with this session']);
});

test('the note is a row of the conversation and a line of its journal, like the other notes', () => {
  const dir = tmp();
  const { c, home } = opened(dir, session());
  c.setAutoMode('all');
  c.save();
  const back = reopen(dir, home, c.sessionId);
  const lines = readJournal(journalPath(home, back.c.sessionId))!;
  expect(lines.some((l) => l.t === 'row' && l.role === 'note' && l.text === 'auto: writes — restored with this session')).toBe(true);
});

test('a session saved in ask has no field and opens without a note', () => {
  const dir = tmp();
  const { c, home } = opened(dir, session());
  c.setAutoMode('all');
  c.save();
  c.setAutoMode('ask');
  c.save();
  expect(loadSession(home, c.sessionId)!.autoMode).toBeUndefined();
  expect(fs.readFileSync(path.join(home, `${c.sessionId}.json`), 'utf8')).not.toContain('autoMode');
  const back = reopen(dir, home, c.sessionId);
  expect(back.c.autoMode).toBe('ask');
  expect(back.notes).toEqual([]);
});

test('an older file without the field opens in ask, no note', () => {
  const dir = tmp();
  const { c, home } = opened(dir, session());
  const back = reopen(dir, home, c.sessionId);
  expect(back.c.autoMode).toBe('ask');
  expect(back.notes).toEqual([]);
});

test('a value that is not a mode opens in ask, no note', () => {
  const dir = tmp();
  for (const junk of ['everything', 7, null, ['all'], 'ask', 'ALL']) {
    const s = session();
    const home = projectHome(dir, null);
    saveSession(home, { ...s, autoMode: junk } as unknown as Session);
    const back = reopen(dir, home, s.id);
    expect(back.c.autoMode).toBe('ask');
    expect(back.notes).toEqual([]);
  }
});

test('a session opened again in the mode it ends with does not say it twice', () => {
  const dir = tmp();
  const { c, home } = opened(dir, session());
  c.setAutoMode('all');
  c.save();
  const once = reopen(dir, home, c.sessionId);
  once.c.save();
  const twice = reopen(dir, home, c.sessionId);
  expect(twice.notes).toEqual(['auto: writes — restored with this session']);
});

test('opening a session saves nothing of its own', () => {
  const dir = tmp();
  const { c, home } = opened(dir, session());
  c.setAutoMode('all');
  c.save();
  const back = reopen(dir, home, c.sessionId);
  expect(back.c.saveTimer).toBeNull();
});

test('a change of mode is written without a turn or a save call, as other edits are', async () => {
  const dir = tmp();
  const { c, home } = opened(dir, session());
  c.setAutoMode('all');
  expect(c.saveTimer).not.toBeNull();
  await new Promise((r) => setTimeout(r, 400));
  expect(loadSession(home, c.sessionId)!.autoMode).toBe('all');
  // Setting what is already set marks nothing.
  c.setAutoMode('all');
  expect(c.saveTimer).toBeNull();
});

test('a conversation that opens no session starts in ask and says nothing', () => {
  const dir = tmp();
  const { c, home } = opened(dir, session());
  c.setAutoMode('all');
  c.save();
  const fresh = new Conversation(fakeDeps({ sessionsDir: () => dir }));
  expect(fresh.autoMode).toBe('ask');
  fresh.setAutoMode('ask');
  expect(fresh.rows().filter((m) => m.role === 'note')).toEqual([]);
  expect(loadSession(home, c.sessionId)!.autoMode).toBe('all');
});

test('a child has no state file: its mode is not written anywhere', async () => {
  const dir = tmp();
  const { c, home } = opened(dir, session());
  const files = () => fs.readdirSync(home).filter((n) => n.endsWith('.json')).sort();
  const before = files();
  const started = c.startChild({ kind: 'subagent', label: 'sub', prompt: 'p', by: 'person' } as never, 'j1');
  expect('refused' in started).toBe(false);
  const child = (started as { child: Conversation }).child;
  child.setAutoMode('all');
  expect(child.deps.sessionsDir()).toBeNull();
  await new Promise((r) => setTimeout(r, 400));
  expect(files()).toEqual(before);
  expect(loadSession(home, c.sessionId)!.autoMode).toBeUndefined();
  expect(c.autoMode).toBe('ask');
});
