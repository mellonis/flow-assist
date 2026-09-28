import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JOURNAL_LINE_MAX, appendJournal, exportMarkdown, outputJournal, journalLine, readJournal, rowOf, viewText } from '../journal.ts';
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

test('the journal sweep reaches a journal under a project directory as well', () => {
  const root = tmp();
  const home = path.join(root, 'Users', 'me', 'app');
  const id = '2026-01-01T00-00-00-0009';
  const now = Date.now();
  appendJournal(journalPath(home, id), { t: 'row', role: 'user', text: 'x' });
  fs.utimesSync(journalPath(home, id), new Date(now - 40 * 86_400_000), new Date(now - 40 * 86_400_000));
  saveSession(home, session({ id }));
  expect(sweepJournals(root, 30, now)).toBe(1);
  expect(fs.existsSync(journalPath(home, id))).toBe(false);
  expect(loadSession(home, id)!.messages.at(-1)!.role).toBe('note');
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
    { t: 'shell-out', text: 'a.md\n', at: '2026-09-27T10:06:00.500Z' },
    { t: 'shell-end', command: 'ls', status: 'exit 0', ms: 5, at: '2026-09-27T10:06:01.000Z' },
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
  expect(md).toContain('! ls');
  expect(md).toContain('a.md\n```');
  expect(md).toContain('exit 0');
  expect(md).toContain('stopped (Esc)');
  expect(md).toContain('Я начал');
  expect(md).not.toContain('beginning may be missing');
  expect(exportMarkdown([{ t: 'start', id: 'x', continued: true }], { title: '', id: 'x' })).toContain('beginning may be missing');
  expect(exportMarkdown([], { title: '', id: 'x', noJournal: true })).toContain('beginning may be missing');
  expect(exportMarkdown([{ t: 'start', id: 'x', parent: '2026-09-27T09-00-00-aaaa' }], { title: '', id: 'x' })).toContain('2026-09-27T09-00-00-aaaa');
});

test('the export pairs a call\'s start with its end, says when one never ended, shows the data behind a frame and a cut output', () => {
  const md = exportMarkdown([
    { t: 'start', id: 'x' },
    { t: 'call-start', id: 'c1', name: 'get', args: { q: 1 }, confirm: false },
    { t: 'call', id: 'c1', name: 'get', args: { q: 1 }, outcome: 'ok', result: 'frame', raw: 'THE DATA' },
    { t: 'call-start', id: 'c2', name: 'run_command', args: { command: 'make' }, confirm: true },
    { t: 'confirm', id: 'c2', name: 'run_command', answer: 'yes', by: 'person' },
    { t: 'call-start', id: 'c3', name: 'datetime', args: {}, task: 'часы' },
    { t: 'shell', command: 'seq 1 9' },
    { t: 'shell-out', text: '1\n2\n' },
    { t: 'shell-out', text: '3\n' },
    { t: 'shell-out', capped: true, total: 18 },
    { t: 'shell-end', command: 'seq 1 9', status: 'exit 0', ms: 3 },
  ], { title: 't', id: 'x' });
  expect(md.match(/<details>/g)).toHaveLength(3);
  expect(md).toContain('Data:');
  expect(md).toContain('THE DATA');
  expect(md).toContain('<summary>run_command · did not finish</summary>');
  expect(md).toContain('answered yes by the person');
  expect(md).toContain('background task «часы»');
  expect(md).toContain('```console\n1\n2\n3\n```');
  expect(md).toContain('the journal keeps the first');
  expect(md).toContain('18 bytes in all');
});

test('a command\'s output goes to the journal in chunks as it arrives, capped with a note of the total', () => {
  const lines: Record<string, unknown>[] = [];
  const timers: (() => void)[] = [];
  const j = outputJournal((ev) => lines.push(ev), { chunkBytes: 10, capBytes: 25, schedule: (fn) => { timers.push(fn); } });
  j.push('abc');
  expect(lines).toHaveLength(0); // held until the chunk fills or the timer fires
  timers.shift()!();
  expect(lines).toEqual([{ t: 'shell-out', text: 'abc' }]);
  j.push('0123456789xyz'); // fills a chunk: written at once
  j.push('ÿÿÿÿÿÿÿÿÿÿÿÿ'); // past the cap: cut at it
  j.push('more');
  j.end();
  const text = lines.filter((e) => typeof e.text === 'string').map((e) => e.text).join('');
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(25);
  expect(text.startsWith('abc0123456789xyz')).toBe(true);
  expect(lines.at(-1)).toEqual({ t: 'shell-out', capped: true, total: 3 + 13 + 24 + 4 });
  // Under the cap, no note.
  const quiet: Record<string, unknown>[] = [];
  const q = outputJournal((ev) => quiet.push(ev), { schedule: () => {} });
  q.push('ok\n');
  q.end();
  expect(quiet).toEqual([{ t: 'shell-out', text: 'ok\n' }]);
});

test('a command that never ended is drawn in its place, said not to have finished; a background y/n reads as it was answered', () => {
  const md = exportMarkdown([
    { t: 'start', id: 'x' },
    { t: 'shell', command: 'make' },
    { t: 'shell-out', text: 'building…\n' },
    { t: 'row', role: 'user', text: 'после рестарта' },
    { t: 'call-start', id: 'b1', name: 'write_file', args: {}, confirm: true, task: 'фон' },
    { t: 'confirm', id: 'b1', name: 'write_file', answer: 'yes', by: 'background', task: 'фон' },
    { t: 'call', id: 'b1', name: 'write_file', args: {}, outcome: 'applied', result: 'ok', task: 'фон' },
    { t: 'call-start', id: 'c1', name: 'run_command', args: { command: 'x' }, confirm: true },
    { t: 'confirm', id: 'c1', name: 'run_command', answer: 'no', by: 'reset' },
    { t: 'call', id: 'c1', name: 'run_command', args: { command: 'x' }, outcome: 'declined', result: 'declined' },
  ], { title: 't', id: 'x' });
  expect(md.indexOf('building…')).toBeLessThan(md.indexOf('после рестарта'));
  expect(md.indexOf('did not finish')).toBeLessThan(md.indexOf('после рестарта'));
  expect(md).toContain('answered yes by the background task');
  expect(md).not.toContain('declines every write');
  expect(md).toContain('answered no by a reset of the conversation');
});

test('no journal line keeps a known secret, whatever event carries it', async () => {
  const { buildSecretSet, setActiveSecrets } = await import('../secrets.ts');
  const token = 'journal-secret-value-000123';
  setActiveSecrets(buildSecretSet({}, { WIKI_TOKEN: token }));
  try {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-journal-')), 'j.log.jsonl');
    appendJournal(file, { t: 'call-start', id: 'c1', name: 'run_command', args: { command: `curl -H "Bearer ${token}"` }, confirm: true } as never);
    appendJournal(file, { t: 'step', text: `Next: use ${token}` } as never);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain(token);
    expect(text.match(/‹secret WIKI_TOKEN›/g)).toHaveLength(2);
  } finally {
    setActiveSecrets(null);
  }
});
