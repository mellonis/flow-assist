// What a child starts with, from the writes capability of its spec and the conversation
// that started it (`startChild`, src/assistant/conversation.ts): the auto mode is inherited
// by every child that is not `deny`, and a `deny` child is offered no write tools
// (`WRITE_TOOLS_WITHHELD`). The policy each capability makes is `childPolicy`'s own
// (confirm-policy.test.ts), and it still declines a write a name outside the set hides.
import { expect, test } from 'bun:test';
import { Conversation } from '../conversation.ts';
import type { ChildSpec, ConversationDeps } from '../conversation-types.ts';
import { childPolicy, confirmFor, READ_ONLY_TASK_DECLINE } from '../confirm-policy.ts';
import { WRITE_TOOLS_WITHHELD } from '../conversation-turn.ts';
import { fakeDeps } from './conversation-deps.ts';

// A task `parent` starts: `startChild` refuses only past the depth limit.
function childOf(parent: Conversation, over: Partial<ChildSpec> = {}) {
  const started = parent.startChild({ kind: 'task', label: 'w', prompt: 'p', by: 'model', ...over }, 'j');
  if ('refused' in started) throw new Error(`refused: ${started.refused}`);
  return started.child;
}

test('a task inherits the auto mode of the conversation that started it', () => {
  const parent = new Conversation(fakeDeps());
  parent.setAutoMode('all', false);
  expect(childOf(parent, { writes: 'ask' }).autoMode).toBe('all');
});

test('a deny child does not inherit it', () => {
  const parent = new Conversation(fakeDeps());
  parent.setAutoMode('all', false);
  expect(childOf(parent, { writes: 'deny' }).autoMode).toBe('ask');
});

test('a task without a writes field inherits like a worker', () => {
  const parent = new Conversation(fakeDeps());
  parent.setAutoMode('all', false);
  expect(childOf(parent).autoMode).toBe('all');
});

test('a deny child is offered no write tools', async () => {
  // The fakeDeps chatLLM records its options: each child's own turn goes through the
  // `chatLLM` wrapper `startChild` builds.
  type ChatOpts = NonNullable<Parameters<ConversationDeps['chatLLM']>[1]>;
  const seen: ChatOpts[] = [];
  const chatLLM = (async (_wire: unknown[], o: ChatOpts = {} as ChatOpts) => {
    seen.push({ ...o });
    return { content: 'x', transcript: [{ role: 'assistant', content: 'x' }], toolRuns: [] };
  }) as unknown as ConversationDeps['chatLLM'];
  const parent = new Conversation(fakeDeps({ chatLLM }));
  await childOf(parent, { writes: 'deny' }).send('do it');
  for (const name of WRITE_TOOLS_WITHHELD) expect(seen[0]!.withholdTools).toContain(name);
  seen.length = 0;
  await childOf(parent).send('do it');
  for (const name of WRITE_TOOLS_WITHHELD) expect(seen[0]!.withholdTools).not.toContain(name);
});

test('deny never lifts: a descendant of a deny child is write-blind too', async () => {
  type ChatOpts = NonNullable<Parameters<ConversationDeps['chatLLM']>[1]>;
  const seen: ChatOpts[] = [];
  const chatLLM = (async (_wire: unknown[], o: ChatOpts = {} as ChatOpts) => {
    seen.push({ ...o });
    return { content: 'x', transcript: [{ role: 'assistant', content: 'x' }], toolRuns: [] };
  }) as unknown as ConversationDeps['chatLLM'];
  const parent = new Conversation(fakeDeps({ chatLLM }));
  // The grandchild's own writes are `ask`, but a denied child never gets writes back —
  // the hidden set rides the chained `chatLLM` wrappers to everything below it.
  const inner = childOf(childOf(parent, { writes: 'deny' }), { writes: 'ask' });
  await inner.send('do it');
  for (const name of WRITE_TOOLS_WITHHELD) expect(seen[0]!.withholdTools).toContain(name);
});

test('always-no declines a write tool that was not hidden', async () => {
  const confirm = confirmFor(childPolicy('deny', true, () => {}), { conv: new Conversation(fakeDeps()), journalId: 'j' })!;
  expect(await confirm('mcp:tool', '{}', {})).toBe(false);
});

test('the read-only decline names writes, not write: true', () => {
  expect(READ_ONLY_TASK_DECLINE).toBe('This write was declined: this task is read-only, so it may not write or run commands. If the job must change something, the conversation that started it can start it again with writes: ask (each write then waits for the person\'s yes) or an agent file. Report what you found and what you would have changed.');
});
