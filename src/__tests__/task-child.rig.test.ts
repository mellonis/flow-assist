// A conversation starts a child of its own (`startChild`, AGENTS.md "registry"): a `task`
// conversation whose tool calls are journaled in its parent's turn, tagged with its
// label, in its parent's project, from its parent's directory — and no file of its own.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Conversation } from '../assistant/conversation.ts';
import type { ChildSpec } from '../assistant/conversation-types.ts';
import { ScriptedModel } from './helpers/scripted';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation';
import { listTree } from './helpers/session-files';

// The children a test made and never ran: `closeRigs` knows only the rig's own.
const children: Conversation[] = [];
afterEach(() => { for (const c of children.splice(0)) c.close('exit'); closeRigs(); });

const spec = (label: string, prompt: string): ChildSpec => ({ kind: 'task', label, prompt, by: 'model' });

// A child of the rig's conversation, started from a question the person asked in it.
function startFrom(rig: Rig, s: ChildSpec) {
  const from = rig.conv.journal({ t: 'row', role: 'user', text: 'q' }, { person: true });
  const started = rig.conv.startChild(s, from);
  if ('refused' in started) throw new Error(`refused: ${started.refused}`);
  children.push(started.child);
  return started;
}

test('a child sends the worker prompt with its task, answers with its text, and is closed when its run ends', async () => {
  const model = new ScriptedModel();
  model.script([{ text: '  Сейчас полдень.  ' }]);
  const rig = conversationRig(model);
  const { child, run } = startFrom(rig, spec('часы', 'узнать время'));
  expect(child.kind).toBe('task');
  expect(child.label).toBe('часы');
  expect(child.parent).toBe(rig.conv);
  expect(child.depth).toBe(1);
  const result = await run();
  expect(result).toEqual({ outcome: 'answer', text: 'Сейчас полдень.' });
  const sys = rig.messages(0)[0]!;
  expect(sys.role).toBe('system');
  expect(String(sys.content)).toContain('You are a background worker');
  expect(String(sys.content)).toContain('Task: узнать время');
  expect(rig.sent(0)).toEqual([{ role: 'user', content: 'узнать время' }]);
  expect(child.closed).toBe(true);
});

test('a child\'s calls land in the parent\'s journal tagged `task`, and it writes no file of its own', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'datetime', args: {} }], [{ text: 'noon' }]);
  const rig = conversationRig(model);
  const { run } = startFrom(rig, spec('часы', 'узнать время'));
  await new Promise((r) => setTimeout(r, 300)); // the parent's own files settle first
  const journals = rig.journals();
  const states = rig.stateFiles();
  const tree = listTree(rig.sessionsDir!); // a lock included
  expect(journals.length).toBe(1);
  await run();
  await new Promise((r) => setTimeout(r, 300)); // past any 250 ms save
  expect(rig.journals()).toEqual(journals);
  expect(rig.stateFiles()).toEqual(states);
  expect(listTree(rig.sessionsDir!)).toEqual(tree);
  const tagged = rig.journal().filter((e) => e.task);
  expect(tagged.map((e) => [e.t, e.task])).toEqual([['call-start', 'часы'], ['call', 'часы']]);
  expect(tagged.map((e) => e.name)).toEqual(['datetime', 'datetime']);
});

test('a grandchild\'s line keeps its own label when it passes through its parent\'s route', () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model);
  const { child } = startFrom(rig, spec('outer', 'x'));
  child.journalRoute!({ t: 'call', task: 'inner', name: 'datetime', result: 'r' });
  const call = rig.journal().find((e) => e.t === 'call');
  expect(call).toMatchObject({ task: 'inner', name: 'datetime' });
});

test('a write the child attempts is declined, journaled `confirm` by background with its task', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'run_command', args: { command: 'echo x > made.txt' } }], [{ text: 'could not' }]);
  const rig = conversationRig(model);
  const { run } = startFrom(rig, spec('w', 'make a file'));
  await run();
  expect(fs.existsSync(path.join(rig.root, 'made.txt'))).toBe(false);
  const tagged = rig.journal().filter((e) => e.task === 'w');
  expect(tagged.map((e) => e.t)).toEqual(['call-start', 'confirm', 'call']);
  expect(tagged[1]).toMatchObject({ answer: 'no', by: 'background', task: 'w' });
  expect(rig.conv.confirm).toBeNull();
});

test('a child\'s shell starts at its parent\'s directory, and its `cd` does not move the parent\'s', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'cd', args: { path: '../b' } }], [{ text: 'moved' }]);
  const rig = conversationRig(model);
  const a = path.join(rig.root, 'a');
  const b = path.join(rig.root, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  rig.conv.shell.setCwd(a);
  const { child, run } = startFrom(rig, spec('d', 'go to b'));
  expect(child.shell.cwd()).toBe(a);
  await run();
  expect(child.shell.cwd()).toBe(b);
  expect(rig.conv.shell.cwd()).toBe(a);
});

const OTHER = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-other-')));
test('a child writes memory in its parent\'s project, whatever root its shell moves to', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'cd', args: { path: OTHER } }],
    [{ tool: 'memory', args: { action: 'add', text: 'Found by the background task.' } }],
    [{ text: 'saved' }],
  );
  const rig = conversationRig(model);
  (rig.config.shell as { roots: string[] }).roots.push(OTHER);
  const { run } = startFrom(rig, spec('m', 'remember'));
  await run();
  const project = rig.conv.currentProject();
  expect(project).not.toBeNull();
  expect(project).not.toBe(OTHER);
  expect(rig.conv.memoryLists().project.map((f) => f.text)).toContain('Found by the background task.');
  const cdCall = rig.journal().find((e) => e.t === 'call' && e.task === 'm' && e.name === 'cd');
  expect(String(cdCall?.result)).toContain(OTHER);
});

test('a child\'s system prompt follows its own `cd` into a directory with its own AGENTS.md', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'cd', args: { path: 'proj' } }], [{ text: 'seen' }]);
  const rig = conversationRig(model);
  fs.mkdirSync(path.join(rig.root, 'proj'));
  fs.writeFileSync(path.join(rig.root, 'proj', 'AGENTS.md'), 'BG RULE');
  fs.writeFileSync(path.join(rig.root, 'AGENTS.md'), 'CHAT RULE');
  rig.conv.shell.setCwd(rig.root); // the parent reads its root's instructions
  const { run } = startFrom(rig, spec('p', 'look at proj'));
  await run();
  const first = String(rig.messages(0)[0]!.content);
  const second = String(rig.messages(1)[0]!.content);
  expect(first).toContain('CHAT RULE'); // started where the parent's shell is
  expect(first).not.toContain('BG RULE');
  expect(second).toContain('BG RULE');
  expect(rig.conv.shell.cwd()).toBe(rig.root);
});

test('at the configured depth a child is refused at once, naming the number', () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: { subagentDepth: 1 } });
  const { child } = startFrom(rig, spec('a', 'one'));
  const started = child.startChild(spec('b', 'two'), '');
  expect(started).toEqual({ refused: 'Background chaining depth exceeded (max 1) — finish this task; do not spawn further background tasks.' });
});

test('a child stopped at its twelve rounds returns `limit` with its last step', async () => {
  const model = new ScriptedModel();
  model.script(...Array.from({ length: 20 }, () => [{ tool: 'datetime', args: {} }]));
  const rig = conversationRig(model);
  const { child, run } = startFrom(rig, spec('L', 'loop'));
  const result = await run();
  expect(model.requests.length).toBe(12);
  expect(result.outcome).toBe('limit');
  expect(result.text).toBe('');
  expect(result.limit?.rounds).toBe(12);
  expect(result.limit?.lastStep).toContain('datetime');
  expect(child.closed).toBe(true);
});

test('`deliver` on a closed conversation lands nothing', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  rig.conv.journal({ t: 'row', role: 'user', text: 'q' }, { person: true });
  const rows = rig.conv.messages.length;
  const lines = rig.journal().length;
  rig.conv.close('park');
  rig.conv.deliver('late finished:\nanswer');
  await new Promise((r) => setTimeout(r, 450));
  expect(rig.conv.messages.length).toBe(rows);
  expect(rig.journal().length).toBe(lines);
});
