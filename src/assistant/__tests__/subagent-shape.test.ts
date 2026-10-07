// What a `subagent` conversation's turn is handed (the kind's row of `turnShape`) and the
// two rules the kind adds at the conversation: which root a child's result walks to, and
// whose flag a child's memory note spends.
import { expect, test } from 'bun:test';
import { Conversation, workHome } from '../conversation.ts';
import { SUBAGENT_WITHHELD, subagentPrompt, turnShape } from '../conversation-turn.ts';
import { memoryRecordNotes } from '../memory-trust.ts';
import { languageDirective, summaryBlock } from '../system-prompt.ts';
import { asConversationWork } from '../../runtime/background-work.ts';
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

const subagentOf = (deps: ReturnType<typeof fakeDeps>) => new Conversation(deps, { kind: 'subagent', policy: { kind: 'always-no' } });

test('the subagent row: worker-shaped prompt, a boundary and recall, no screens, no ask_user, no images, no round cap of its own', () => {
  const row = turnShape('subagent');
  expect(row).toEqual({ system: 'subagent', screen: false, boundary: true, recall: true, askUser: false, images: false, withholdTools: SUBAGENT_WITHHELD });
  expect(row).not.toHaveProperty('maxRounds');
  expect(SUBAGENT_WITHHELD).toEqual(['remind']);
});

test('a subagent turn: the framed task, the language directive, no tail, the boundary, recall, nothing to ask, `remind` withheld, a y/n that says no', async () => {
  const m = answering('Done.');
  const c = subagentOf(fakeDeps({ chatLLM: m.chatLLM, screen: () => [{ label: 'board', text: 'ON SCREEN' }] as never }));
  c.label = 'probe';
  expect(await c.send('do it')).toBe(true);
  const o = m.seen[0]!;
  const first = o.wire[0] as { role: string; content: string };
  expect(first.role).toBe('system');
  expect(first.content.startsWith(subagentPrompt('do it'))).toBe(true);
  expect(subagentPrompt('do it')).toContain("The person's task: do it");
  expect(first.content).toContain(languageDirective(c.deps.config()));
  expect(o.systemPrompt()).toBe(first.content);
  expect(o).not.toHaveProperty('maxRounds');
  expect(o.requestTail).toBeUndefined();
  expect(typeof o.beforeRequest).toBe('function');
  expect(o.toolCtx.recall).toBeDefined();
  expect(o.toolCtx.askUser).toBeUndefined();
  expect(o.withholdTools).toEqual(['remind']);
  expect(await o.confirmWrite('run_command', {}, '')).toBe(false);
});

test('a subagent\'s own summary rides every round\'s system prompt, the handed one included, and a later one replaces it', async () => {
  const m = answering('Done.');
  const c = subagentOf(fakeDeps({ chatLLM: m.chatLLM }));
  c.summary = 'HANDED-SUMMARY';
  await c.send('go on');
  const o = m.seen[0]!;
  expect(o.systemPrompt()).toContain(summaryBlock('HANDED-SUMMARY'));
  // An automatic compaction between two rounds replaces it; the next round reads it fresh.
  c.summary = 'FOLDED-SUMMARY';
  const next = o.systemPrompt() as string;
  expect(next).toContain(summaryBlock('FOLDED-SUMMARY'));
  expect(next).not.toContain('HANDED-SUMMARY');
});

test('a subagent turn carries no images', async () => {
  const m = answering('Done.');
  const c = subagentOf(fakeDeps({ chatLLM: m.chatLLM }));
  c.images.set(1, { n: 1, name: 'a.png', path: '/nowhere/a.png', sha256: 'x', mime: 'image/png', bytes: 1 });
  await c.send('look at [Image #1]');
  expect(c.api[0]).not.toHaveProperty('images');
  expect(JSON.stringify(m.seen[0]!.wire)).not.toContain('"images"');
});

test('work in a subagent walks to the session through any depth of children', () => {
  const deps = fakeDeps();
  const session = new Conversation(deps);
  const sub = subagentOf(deps);
  const task = new Conversation(deps, { kind: 'task', policy: { kind: 'always-no' } });
  sub.parent = session;
  task.parent = sub;
  expect(asConversationWork(task, () => workHome())).toBe(session);
  expect(asConversationWork(sub, () => workHome())).toBe(session);
  expect(asConversationWork(session, () => workHome())).toBe(session);
});

test('a child says nothing of a missing memory record and spends nobody\'s once-only flag; the session still says it', () => {
  const said = { memoryMissing: false, configAsking: new Map<string, Conversation>() };
  const deps = fakeDeps({ said });
  const session = new Conversation(deps);
  const child = subagentOf(deps);
  child.parent = session;
  expect(memoryRecordNotes('later').length).toBeGreaterThan(0);
  child.memoryBlock();
  expect(said.memoryMissing).toBe(false);
  expect(child.messages).toEqual([]);
  session.memoryBlock();
  expect(said.memoryMissing).toBe(true);
  expect(session.messages.some((m) => m.role === 'note')).toBe(true);
});

test('a run a subagent\'s tool starts through ctx.chatLLM has no `remind` either; a task is offered what it was', async () => {
  const seen: Record<string, any>[] = [];
  const chatLLM = (async (_wire: unknown[], o: Record<string, any> = {}) => {
    seen.push({ ...o });
    return { content: 'x', transcript: [{ role: 'assistant', content: 'x' }], toolRuns: [] };
  }) as never;
  const session = new Conversation(fakeDeps({ chatLLM }));
  for (const kind of ['subagent', 'task'] as const) {
    seen.length = 0;
    const started = session.startChild({ kind, label: kind, prompt: 'do it', by: 'person' }, 'journal-id');
    if ('refused' in started) throw new Error(started.refused);
    await started.child.send('do it');
    await seen[0]!.toolCtx.chatLLM([{ role: 'user', content: 'nested' }], {});
    expect(seen).toHaveLength(2);
    const expected = kind === 'subagent' ? ['remind'] : undefined;
    expect(seen[1]!.withholdTools).toEqual(expected);
    // The caller's own list is kept, once.
    await seen[0]!.toolCtx.chatLLM([{ role: 'user', content: 'nested' }], { withholdTools: ['x', 'remind'] });
    expect(seen[2]!.withholdTools).toEqual(kind === 'subagent' ? ['remind', 'x'] : ['x', 'remind']);
  }
});
