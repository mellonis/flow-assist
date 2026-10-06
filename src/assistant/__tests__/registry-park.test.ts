// A session the chat has left is put away in one order: what waits in its inbox lands,
// it is saved, and only then is its lock released — another process that takes the
// session reads a file that has the result — and it is closed; the chat is told last
// (AGENTS.md (a host makes its conversations through one registry)).
import { expect, test } from 'bun:test';
import type { Conversation } from '../conversation.ts';
import { ConversationRegistry, type RegistryInit } from '../registry.ts';

test('park lands the inbox, saves, releases the lock, closes, then tells the chat', () => {
  const calls: string[] = [];
  const registry = new ConversationRegistry({ canAsk: false, notify: () => calls.push('notify') } as unknown as RegistryInit);
  const c = {
    closed: false,
    busy: false, children: new Set(), confirm: null, question: null, queue: [], configAsk: null,
    takeInbox: (mode?: string) => calls.push(`takeInbox:${mode}`),
    save: (opts?: { silent?: boolean }) => calls.push(`save:${opts?.silent ? 'silent' : 'loud'}`),
    releaseLock: () => calls.push('releaseLock'),
    close: (reason: string) => calls.push(`close:${reason}`),
  } as unknown as Conversation;
  registry.park(c);
  expect(calls).toEqual(['takeInbox:rows', 'save:silent', 'releaseLock', 'close:park', 'notify']);
});

test('park refuses a conversation that still has work', () => {
  const calls: string[] = [];
  const registry = new ConversationRegistry({ canAsk: false, notify: () => calls.push('notify') } as unknown as RegistryInit);
  const c = {
    closed: false,
    busy: true, children: new Set(), confirm: null, question: null, queue: [], configAsk: null,
    takeInbox: (mode?: string) => calls.push(`takeInbox:${mode}`),
    save: (opts?: { silent?: boolean }) => calls.push(`save:${opts?.silent ? 'silent' : 'loud'}`),
    releaseLock: () => calls.push('releaseLock'),
    close: (reason: string) => calls.push(`close:${reason}`),
  } as unknown as Conversation;
  expect(() => registry.park(c)).toThrow('registry.park: the conversation still has work of its own');
  // Nothing saved, nothing released, nobody told.
  expect(calls).toEqual([]);
});
