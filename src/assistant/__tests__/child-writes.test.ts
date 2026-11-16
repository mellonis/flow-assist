// What a child starts with, from the writes capability of its spec and the conversation
// that started it (`startChild`, src/assistant/conversation.ts): the auto mode is inherited
// by every child that is not `deny`. The policy each capability makes is `childPolicy`'s own
// (confirm-policy.test.ts).
import { expect, test } from 'bun:test';
import { Conversation } from '../conversation.ts';
import type { ChildSpec } from '../conversation-types.ts';
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
