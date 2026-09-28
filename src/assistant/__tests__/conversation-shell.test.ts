import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Conversation } from '../conversation.ts';
import { readJournal } from '../journal.ts';
import { journalPath } from '../sessions.ts';
import { fakeDeps } from './conversation-deps.ts';

const rootWithSub = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-sh-')));
  fs.mkdirSync(path.join(root, 'sub'));
  return root;
};
const inRoot = (root: string, sessions?: string) => {
  const deps = fakeDeps(sessions ? { sessionsDir: () => sessions } : {});
  (deps.config() as Record<string, unknown>).shell = { roots: [root] };
  const c = new Conversation(deps);
  c.shell.setCwd(root);
  return c;
};

test('a !command: its block, the model\'s copy, the history line, the journal and a done end', async () => {
  const root = rootWithSub();
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-sh-s-'));
  const c = inRoot(root, sessions);
  await c.runShell('echo marker-7');
  expect(c.rows().at(-1)).toMatchObject({ role: 'shell', command: 'echo marker-7' });
  expect(String(c.api.at(-1)!.content)).toContain('marker-7');
  expect(c.prompts).toEqual(['!echo marker-7']);
  expect(c.lastEnd).toMatchObject({ kind: 'shell', outcome: 'done' });
  expect(c.busy).toBe(false);
  const lines = readJournal(journalPath(c.homes.get(c.sessionId)!, c.sessionId))!;
  expect(lines.map((l) => l.t)).toEqual(['start', 'shell', 'shell-out', 'shell-end']);
});

test('cd sticks inside the roots', async () => {
  const root = rootWithSub();
  const c = inRoot(root);
  await c.runShell('cd sub');
  expect(c.shell.cwd()).toBe(path.join(root, 'sub'));
});

test('a stopped command ends stopped and leaves the queue to the chat', async () => {
  const c = inRoot(rootWithSub());
  const run = c.runShell('sleep 5');
  c.enqueue('after');
  await new Promise((r) => setTimeout(r, 50));
  expect(c.stop('')).toBe(true);
  await run;
  expect(c.lastEnd).toMatchObject({ outcome: 'stopped', stoppedBy: 'Esc' });
  expect(c.queue).toHaveLength(1);
});
