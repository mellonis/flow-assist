import { expect, test } from 'bun:test';
import os from 'node:os';
import { Conversation, NO_FILE } from '../conversation.ts';
import { fakeDeps } from './conversation-deps.ts';

test('a fresh conversation holds nothing and asks', () => {
  const c = new Conversation(fakeDeps());
  expect(c.key).toMatch(/^c\d+$/);
  expect(new Conversation(fakeDeps()).key).not.toBe(c.key);
  expect([c.api, c.queue, c.inbox, c.prompts, c.laterNotes]).toEqual([[], [], [], [], []]);
  expect([c.configAsk, c.memoryMissingSaid]).toEqual([null, false]);
  expect([c.sessionId, c.title, c.summary, c.autoMode]).toEqual(['', '', '', 'ask']);
  expect(c.fingerprint).toBe(NO_FILE);
  expect(c.plan.snapshot()).toEqual([]);
});

test('setting the shell\'s directory calls the conversation\'s hook', () => {
  const c = new Conversation(fakeDeps());
  let heard = 0;
  c.onShellSet = () => { heard++; };
  c.shell.setCwd(os.tmpdir());
  expect(heard).toBe(1);
});
