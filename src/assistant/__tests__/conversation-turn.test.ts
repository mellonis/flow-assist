import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Conversation } from '../conversation.ts';
import { STOPPED_TURN } from '../system-prompt.ts';
import { readJournal } from '../journal.ts';
import { journalPath } from '../sessions.ts';
import { firstStart } from '../memory-trust.ts';
import { workspaceRoot } from '../workspace.ts';
import type { ConversationEvent } from '../conversation-types.ts';
import { fakeDeps } from './conversation-deps.ts';

const answering = (text: string) => (async (_wire: unknown, o: Record<string, any>) => {
  o.onLive?.(text);
  o.onLiveCommit?.(text, true);
  return { content: text, transcript: [{ role: 'assistant', content: text }], toolRuns: [] };
}) as never;
const events = (c: Conversation) => {
  const seen: string[] = [];
  for (const t of ['turn-start', 'turn-end', 'confirm', 'notice', 'inbox'] as const) c.on(t, (ev: ConversationEvent) => seen.push(ev.type === 'turn-end' ? `turn-end:${ev.end.outcome}` : ev.type));
  return seen;
};

test('a turn: the question and the answer in the history, the rows stamped, the journal closed', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ct-')));
  const c = new Conversation(fakeDeps({ sessionsDir: () => dir, chatLLM: answering('Hi.') }));
  // The start's pass over the memory, as the app runs it: without it the turn says the
  // memory record is missing, in a note of its own.
  firstStart(workspaceRoot(c.deps.config()));
  const seen = events(c);
  expect(await c.send('hello')).toBe(true);
  expect(c.api.map((m) => [m.role, m.content])).toEqual([['user', 'hello'], ['assistant', 'Hi.']]);
  const answer = c.rows().findLast((m) => m.role === 'assistant')!;
  expect(answer.content).toBe('Hi.');
  expect(typeof answer.duration).toBe('number');
  expect(c.busy).toBe(false);
  expect(c.lastEnd).toMatchObject({ kind: 'turn', outcome: 'answer' });
  expect(seen).toEqual(['turn-start', 'turn-end:answer']);
  expect(c.prompts).toEqual(['hello']);
  const lines = readJournal(journalPath(c.homes.get(c.sessionId)!, c.sessionId))!;
  expect(lines.map((l) => l.t)).toEqual(['start', 'row', 'answer', 'end']);
});

test('while busy a send is refused; a queued message goes out after the turn, from a zero-delay timer', async () => {
  let release!: () => void;
  const asked: string[] = [];
  const c = new Conversation(fakeDeps({
    chatLLM: (async (wire: { content: unknown }[], o: Record<string, any>) => {
      asked.push(String(wire.at(-1)!.content));
      if (asked.length === 1) await new Promise<void>((r) => { release = r; });
      o.onLiveCommit?.('ok', true);
      return { content: 'ok', transcript: [{ role: 'assistant', content: 'ok' }] };
    }) as never,
  }));
  const first = c.send('one');
  expect(await c.send('two')).toBe(false);
  c.enqueue('two');
  release();
  await first;
  expect(asked).toEqual(['one']);
  await new Promise((r) => setTimeout(r, 5));
  expect(asked).toEqual(['one', 'two']);
});

test('a stopped turn closes in the model\'s voice and tells the chat to take the queue back', async () => {
  const c = new Conversation(fakeDeps({
    chatLLM: ((_: unknown, o: { signal: AbortSignal }) => new Promise((_r, reject) => o.signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError'))))) as never,
  }));
  const seen = events(c);
  const turn = c.send('long job');
  c.enqueue('later');
  expect(c.stop('^c')).toBe(true);
  await turn;
  expect(c.api.at(-1)!.content).toBe(STOPPED_TURN);
  expect(c.lastEnd).toMatchObject({ outcome: 'stopped', stoppedBy: '^c' });
  expect(seen.at(-1)).toBe('turn-end:stopped');
  expect(c.queue).toHaveLength(1); // the chat's handler restores it; no chat here
  expect(c.canStop()).toBe(false);
});

test('a write asks: the y/n parks, the answer is journaled, and the auto mode answers first', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ct-')));
  const answers: boolean[] = [];
  const c = new Conversation(fakeDeps({
    sessionsDir: () => dir,
    chatLLM: (async (_: unknown, o: Record<string, any>) => {
      answers.push(await o.confirmWrite('write_file', '{"path":"a"}', { id: 'k1' }));
      o.onLiveCommit?.('done', true);
      return { content: 'done', transcript: [{ role: 'assistant', content: 'done' }] };
    }) as never,
  }));
  const seen = events(c);
  const turn = c.send('write it');
  await new Promise((r) => setTimeout(r, 0));
  expect(c.confirm?.name).toBe('write_file');
  expect(seen).toContain('confirm');
  c.answerConfirm(true);
  await turn;
  expect(answers).toEqual([true]);
  const confirmLine = readJournal(journalPath(c.homes.get(c.sessionId)!, c.sessionId))!.find((l) => l.t === 'confirm');
  expect(confirmLine).toMatchObject({ answer: 'yes', by: 'person', id: 'k1' });
});

const asking = (asked: string[]) => (async (wire: { content: unknown }[], o: Record<string, any>) => {
  asked.push(String(wire.at(-1)!.content));
  o.onLiveCommit?.('ok', true);
  return { content: 'ok', transcript: [{ role: 'assistant', content: 'ok' }] };
}) as never;

test('a background result never enters a running turn; after it, ONE follow-up turn answers it', async () => {
  const asked: string[] = [];
  const c = new Conversation(fakeDeps({ chatLLM: asking(asked) }));
  const landed: Array<{ n: number; shown: boolean }> = [];
  c.on('inbox', (ev) => landed.push({ n: ev.items.length, shown: ev.shown }));
  const turn = c.send('go');
  c.deliver('task finished:\nall good');
  expect(c.inbox).toHaveLength(1); // held: a turn runs
  await turn;
  await new Promise((r) => setTimeout(r, 20));
  expect(asked).toEqual(['go', 'task finished:\nall good']);
  expect(c.api.find((m) => m.content === 'task finished:\nall good')).toMatchObject({ role: 'bg' });
  expect(c.prompts).toEqual(['go']); // the follow-up is not the person's
  expect(landed).toEqual([{ n: 1, shown: false }]); // no chat: counted unread by the chat's handler
  c.clearInbox();
});

test('a queued message carries the inbox: its rows land just ahead of it, and no follow-up turn runs', async () => {
  let release!: () => void;
  const asked: string[] = [];
  const held = asking(asked) as unknown as (w: unknown, o: unknown) => Promise<unknown>;
  const c = new Conversation(fakeDeps({
    chatLLM: (async (w: unknown, o: unknown) => {
      if (!asked.length) await new Promise<void>((r) => { release = r; });
      return held(w, o);
    }) as never,
  }));
  const turn = c.send('go');
  c.deliver('task finished:\nall good');
  c.enqueue('next');
  release();
  await turn;
  await new Promise((r) => setTimeout(r, 20));
  expect(asked).toEqual(['go', 'next']);
  const roles = c.rows().map((m) => m.role);
  expect(roles.indexOf('bg')).toBe(roles.lastIndexOf('user') - 1);
  c.clearInbox();
});

test('with follow-ups off, results land as rows, together, when nothing holds them', () => {
  const c = new Conversation(fakeDeps({ chatLLM: answering('ok') }));
  (c.deps.config().ai as Record<string, unknown>).backgroundFollowUp = false;
  c.deliver('one');
  c.deliver('two');
  expect(c.rows().map((m) => [m.role, m.content])).toEqual([['bg', 'one'], ['bg', 'two']]);
  expect(c.api.map((m) => m.role)).toEqual(['bg', 'bg']);
  c.clearInbox();
});
