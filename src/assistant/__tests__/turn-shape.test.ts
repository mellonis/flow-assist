// What a turn is handed, by kind: the table's three rows, and a `task` conversation's
// turn — the worker prompt, its round cap, nothing of the person's.
import { expect, test } from 'bun:test';
import { Conversation } from '../conversation.ts';
import { ONESHOT_WITHHELD, turnShape, workerPrompt } from '../conversation-turn.ts';
import { fakeDeps } from './conversation-deps.ts';

function answering(text: string) {
  const seen: Record<string, any>[] = [];
  const chatLLM = (async (wire: unknown[], o: Record<string, any>) => {
    seen.push({ ...o, wire });
    o.onLiveCommit?.(text, true);
    return { content: text, transcript: [{ role: 'assistant', content: text }], toolRuns: [] };
  }) as never;
  return { seen, chatLLM };
}

test('the table: a row per kind', () => {
  expect(turnShape('session')).toEqual({ system: 'chat', screen: true, boundary: true, recall: true, askUser: true, images: true, withholdTools: [] });
  expect(turnShape('task')).toEqual({ system: 'worker', screen: false, boundary: false, recall: false, askUser: false, images: false, maxRounds: 12, withholdTools: [] });
  expect(turnShape('oneshot')).toEqual({ system: 'chat', screen: false, boundary: false, recall: false, askUser: false, images: true, withholdTools: ONESHOT_WITHHELD });
});

test('a task turn: the worker prompt, twelve rounds, no tail, no boundary, no recall, no ask_user, nothing withheld, a y/n that says no', async () => {
  const m = answering('Done.');
  const c = new Conversation(fakeDeps({ chatLLM: m.chatLLM, screen: () => [{ label: 'board', text: 'ON SCREEN' }] as never }), { kind: 'task', policy: { kind: 'always-no' } });
  c.label = 'probe';
  expect(await c.send('do it')).toBe(true);
  const o = m.seen[0]!;
  const first = o.wire[0] as { role: string; content: string };
  expect(first.role).toBe('system');
  expect(first.content.startsWith(workerPrompt('do it'))).toBe(true);
  expect(o.systemPrompt()).toBe(workerPrompt('do it'));
  expect(o.maxRounds).toBe(12);
  expect(o.requestTail).toBeUndefined();
  expect(o.beforeRequest).toBeUndefined();
  expect(o.toolCtx.recall).toBeUndefined();
  expect(o.toolCtx.askUser).toBeUndefined();
  expect(o.withholdTools).toEqual([]);
  expect(await o.confirmWrite('run_command', {}, '')).toBe(false);
});

test('a task turn carries no images', async () => {
  const m = answering('Done.');
  const c = new Conversation(fakeDeps({ chatLLM: m.chatLLM }), { kind: 'task', policy: { kind: 'always-no' } });
  c.images.set(1, { n: 1, name: 'a.png', path: '/nowhere/a.png', sha256: 'x', mime: 'image/png', bytes: 1 });
  await c.send('look at [Image #1]');
  expect(c.api[0]).not.toHaveProperty('images');
  expect(JSON.stringify(m.seen[0]!.wire)).not.toContain('"images"');
});
