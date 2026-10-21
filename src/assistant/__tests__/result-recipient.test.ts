import { expect, test } from 'bun:test';
import { resultRecipient } from '../conversation.ts';

interface Hop { name: string; parent: Hop | null; closed: boolean; staying: boolean }
const hop = (name: string, parent: Hop | null, over: Partial<Hop> = {}): Hop => ({ name, parent, closed: false, staying: false, ...over });

test('a task is passed over: a task of a task reaches the session', () => {
  const session = hop('session', null);
  const outer = hop('outer', session);
  const inner = hop('inner', outer);
  expect(resultRecipient(outer)?.name).toBe('session');
  expect(resultRecipient(inner)?.name).toBe('session');
});

test('a subagent that stays takes the result of the task below it', () => {
  const session = hop('session', null);
  const sub = hop('sub', session, { staying: true });
  const task = hop('task', sub);
  expect(resultRecipient(sub)?.name).toBe('sub');
  expect(resultRecipient(task)?.name).toBe('sub');
  expect(resultRecipient(sub.parent)?.name).toBe('session');
});

test('a closed subagent is passed over, and so is a subagent that does not stay', () => {
  const session = hop('session', null);
  const gone = hop('gone', session, { staying: true, closed: true });
  const byModel = hop('byModel', session);
  expect(resultRecipient(gone)?.name).toBe('session');
  expect(resultRecipient(byModel)?.name).toBe('session');
});

test('none is left when every one is closed', () => {
  const session = hop('session', null, { closed: true });
  const sub = hop('sub', session, { staying: true, closed: true });
  expect(resultRecipient(sub)).toBeNull();
  expect(resultRecipient(null)).toBeNull();
});
