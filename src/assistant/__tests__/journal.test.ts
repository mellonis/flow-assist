import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JOURNAL_LINE_MAX, appendJournal, exportMarkdown, journalLine, readJournal, rowOf, viewText } from '../journal.ts';
import { renderConsole } from '../console-view.ts';
import {
  JOURNAL_DAYS, KEEP_MESSAGES, SESSION_VERSION, acquireLock, loadSession, deleteSession, journalPath, makeLockToken, newSessionId, pruneSessions, removeSession,
  saveSession, sweepJournals, type Session,
} from '../sessions.ts';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'journal-')), 'sessions');
const session = (over: Partial<Session> = {}): Session => ({
  version: SESSION_VERSION, id: newSessionId(), title: '', createdAt: '2026-09-21T10:00:00.000Z', updatedAt: '2026-09-21T10:00:00.000Z',
  messages: [{ role: 'user', content: 'вопрос' }], api: [{ role: 'user', content: 'вопрос' }],
  summary: '', plan: [], usage: null, prompts: [], draft: '', ...over,
});

test('a journal is appended line by line, the person\'s alone, and read back; a broken line is skipped', () => {
  const dir = tmp();
  const file = journalPath(dir, newSessionId());
  appendJournal(file, { t: 'row', role: 'user', text: 'первый' });
  appendJournal(file, { t: 'row', role: 'assistant', text: 'ответ' });
  fs.appendFileSync(file, '{"t":"row", broken\n');
  appendJournal(file, { t: 'row', role: 'user', text: 'второй' });
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  const back = readJournal(file)!;
  expect(back.map((e) => e.text)).toEqual(['первый', 'ответ', 'второй']);
  expect(typeof back[0]!.at).toBe('string'); // stamped when written
  expect(readJournal(journalPath(dir, newSessionId()))).toBeNull();
});

test('a line over the bound keeps the event and says what it left out, and how big it was', () => {
  const huge = 'x'.repeat(JOURNAL_LINE_MAX + 10);
  const line = journalLine({ t: 'call', name: 'read_file', args: { path: 'a.txt' }, outcome: 'ok', result: huge });
  expect(Buffer.byteLength(line)).toBeLessThanOrEqual(JOURNAL_LINE_MAX + 1);
  const ev = JSON.parse(line);
  expect(ev).toMatchObject({ t: 'call', name: 'read_file', args: { path: 'a.txt' }, outcome: 'ok' });
  expect(ev.result).toContain('not kept');
  expect(ev.result).toContain('4.0 MB');
  expect(ev.omitted).toEqual({ result: JOURNAL_LINE_MAX + 12 });
  // Under the bound, nothing is touched.
  expect(JSON.parse(journalLine({ t: 'call', result: 'short' })).result).toBe('short');
});

test('a row as the screen kept it becomes a journal event — what an older session brings into its first journal', () => {
  const r = { console: renderConsole };
  expect(rowOf({ role: 'user', content: 'вопрос' }, r)).toMatchObject({ t: 'row', role: 'user', text: 'вопрос' });
  expect(rowOf({ role: 'system', content: 'sys' }, r)).toBeNull();
  expect(rowOf({ role: 'note', content: '── compacted ──', summary: 'итог' }, r)).toMatchObject({ t: 'compact', summary: 'итог' });
  expect(rowOf({ role: 'assistant', content: 'готово', parts: [{ kind: 'text', text: 'Next: посмотреть' }, { kind: 'tools', runs: [{ name: 'datetime', outcome: 'ok' }] }] }, r))
    .toMatchObject({ t: 'row', role: 'assistant', text: 'готово', steps: ['Next: посмотреть'], calls: [{ name: 'datetime', outcome: 'ok' }] });
  const view = { kind: 'console', phase: 'done', data: { command: 'ls', cwd: '~', text: 'a.txt\nb.txt', exitCode: 0, ms: 10, status: 'exit 0' } };
  const row = rowOf({ role: 'view', content: '', views: [view] }, r)!;
  expect(row).toMatchObject({ t: 'row', role: 'view' });
  expect((row.views as { text: string }[])[0]!.text).toContain('b.txt');
  expect(viewText(view as never, r)).toContain('a.txt');
  expect(viewText({ kind: 'gone', phase: 'done', data: {} } as never, r)).toBe('');
});

test('saves never trim the journal: a session longer than the cap still has its first line there', () => {
  const dir = tmp();
  const s = session();
  const file = journalPath(dir, s.id);
  const messages: Record<string, unknown>[] = [];
  for (let i = 0; i < KEEP_MESSAGES + 60; i++) {
    const m = { role: i % 2 ? 'assistant' : 'user', content: `m${i}` };
    messages.push(m);
    appendJournal(file, { t: 'row', role: m.role, text: m.content });
    if (i % 10 === 0) saveSession(dir, { ...s, messages: messages.slice(), api: messages.slice() });
  }
  saveSession(dir, { ...s, messages, api: messages });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, `${s.id}.json`), 'utf8'));
  expect(saved.messages.some((m: { content: string }) => m.content === 'm0')).toBe(false);
  const journal = readJournal(file)!;
  expect(journal[0]).toMatchObject({ role: 'user', text: 'm0' });
  expect(journal).toHaveLength(KEEP_MESSAGES + 60);
});

test('deleting a session removes its journal — from the picker, by pruning, or directly', () => {
  const dir = tmp();
  const a = session({ id: '2026-09-20T09-00-00-aaaa', updatedAt: '2026-09-20T09:00:00.000Z' });
  const b = session({ id: '2026-09-21T09-00-00-bbbb', updatedAt: '2026-09-21T09:00:00.000Z' });
  const c = session({ id: '2026-09-22T09-00-00-cccc', updatedAt: '2026-09-22T09:00:00.000Z' });
  for (const s of [a, b, c]) { saveSession(dir, s); appendJournal(journalPath(dir, s.id), { t: 'row', role: 'user', text: s.id }); }
  deleteSession(dir, c.id);
  expect(fs.existsSync(journalPath(dir, c.id))).toBe(false);
  expect(removeSession(dir, b.id, makeLockToken())).toBe('deleted');
  expect(fs.existsSync(journalPath(dir, b.id))).toBe(false);
  saveSession(dir, c); appendJournal(journalPath(dir, c.id), { t: 'row', role: 'user', text: 'c' });
  pruneSessions(dir, 1); // keeps the newest, c
  expect(fs.existsSync(journalPath(dir, a.id))).toBe(false);
  expect(fs.existsSync(journalPath(dir, c.id))).toBe(true);
});

test('a journal lives as long as its session by default; journalDays, when set, removes an old one and says so in the session', () => {
  const dir = tmp();
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const ids = [newSessionId(), '2026-01-01T00-00-00-0001', '2026-01-01T00-00-00-0002', '2026-01-01T00-00-00-0003'];
  const [young, old, held, orphan] = ids;
  for (const id of ids) appendJournal(journalPath(dir, id!), { t: 'row', role: 'user', text: id });
  for (const id of [old, held, orphan]) fs.utimesSync(journalPath(dir, id!), new Date(now - 31 * day), new Date(now - 31 * day));
  saveSession(dir, session({ id: old! }));
  acquireLock(dir, held!, makeLockToken()); // a live chat has it open
  expect(JOURNAL_DAYS).toBe(0);
  expect(sweepJournals(dir, JOURNAL_DAYS, now)).toBe(0); // the default: kept while the session exists
  for (const id of ids) expect(fs.existsSync(journalPath(dir, id!))).toBe(true);
  expect(sweepJournals(dir, 30, now)).toBe(2);
  expect(fs.existsSync(journalPath(dir, young!))).toBe(true);
  expect(fs.existsSync(journalPath(dir, held!))).toBe(true);
  expect(fs.existsSync(journalPath(dir, old!))).toBe(false);
  expect(fs.existsSync(journalPath(dir, orphan!))).toBe(false);
  // The session stays, and says its evidence is gone.
  const back = loadSession(dir, old!)!;
  expect(back.messages.at(-1)).toEqual({ role: 'note', content: 'Journal removed after 30 days without a write (sessions.journalDays) — this session\'s full record is gone.' });
});

test('the export is readable markdown: the conversation, each call folded with its arguments and result, the summaries in place', () => {
  const md = exportMarkdown([
    { t: 'start', id: 'x', at: '2026-09-27T10:00:00.000Z' },
    { t: 'row', role: 'user', text: 'прочитай файл', at: '2026-09-27T10:00:01.000Z' },
    { t: 'step', text: 'Next: читаю', at: '2026-09-27T10:00:02.000Z' },
    { t: 'call', name: 'read_file', args: { path: 'a.md' }, outcome: 'ok', result: 'x\n```\ny', at: '2026-09-27T10:00:03.000Z' },
    { t: 'answer', text: 'В файле **x**.', at: '2026-09-27T10:00:04.000Z' },
    { t: 'end', ms: 3000, at: '2026-09-27T10:00:04.000Z' },
    { t: 'compact', summary: 'Прочитан a.md.', note: '── compacted ──', at: '2026-09-27T10:05:00.000Z' },
    { t: 'shell', command: 'ls', cwd: '~', at: '2026-09-27T10:06:00.000Z' },
    { t: 'shell-end', command: 'ls', output: 'a.md\n', status: 'exit 0', ms: 5, at: '2026-09-27T10:06:01.000Z' },
    { t: 'row', role: 'note', text: 'Project instructions: none', at: '2026-09-27T10:07:00.000Z' },
    { t: 'end', ms: 10, stopped: 'Esc', cut: 'Я начал', at: '2026-09-27T10:08:00.000Z' },
  ], { title: 'Чтение', id: '2026-09-27T10-00-00-abcd' });
  expect(md.startsWith('# Чтение\n')).toBe(true);
  expect(md).toContain('прочитай файл');
  expect(md).toContain('<details>');
  expect(md).toContain('<summary>read_file · ok</summary>');
  expect(md).toContain('"path": "a.md"');
  // A result holding a fence is put in a longer one, so it cannot close it.
  expect(md).toContain('````\nx\n```\ny\n````');
  expect(md).toContain('В файле **x**.');
  expect(md).toContain('Прочитан a.md.');
  expect(md.indexOf('Прочитан a.md.')).toBeGreaterThan(md.indexOf('В файле'));
  expect(md).toContain('$ ls');
  expect(md).toContain('a.md\n```');
  expect(md).toContain('exit 0');
  expect(md).toContain('stopped (Esc)');
  expect(md).toContain('Я начал');
  expect(md).not.toContain('beginning may be missing');
  expect(exportMarkdown([{ t: 'start', id: 'x', continued: true }], { title: '', id: 'x' })).toContain('beginning may be missing');
  expect(exportMarkdown([], { title: '', id: 'x', noJournal: true })).toContain('beginning may be missing');
  expect(exportMarkdown([{ t: 'start', id: 'x', parent: '2026-09-27T09-00-00-aaaa' }], { title: '', id: 'x' })).toContain('2026-09-27T09-00-00-aaaa');
});
