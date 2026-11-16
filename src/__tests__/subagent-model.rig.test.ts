// A conversation runs one model and measures against that model's window; a child runs
// the model its role names. A conversation on the scripted model, no App.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { agentHash } from '../assistant/agent-file.ts';
import { agentTrustPath, recordAgentStart } from '../assistant/agent-trust.ts';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation';
import { ScriptedModel, firstUser } from './helpers/scripted';

afterEach(() => {
  closeRigs();
  fs.rmSync(agentTrustPath(), { force: true });
});

const AI = {
  model: 'default-model',
  contextWindow: 300_000,
  models: { 'default-model': { contextWindow: 262_000 }, 'small-model': { contextWindow: 256_000 }, 'big-model': { contextWindow: 512_000 } },
  roles: { fast: 'small-model', deep: 'big-model' },
};

test('a conversation runs ai.model and measures against that model’s window', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: AI });
  model.script([{ text: 'ok' }]);
  await rig.conv.send('hi');
  expect(model.requests.at(-1)?.model).toBe('default-model');
  expect(rig.conv.contextWindow()).toBe(262_000);
  expect(rig.conv.effectiveModel()).toBe('default-model');
});

test('a model the catalogue does not name falls back to ai.contextWindow', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: { model: 'other-model', contextWindow: 300_000 } });
  expect(rig.conv.effectiveModel()).toBe('other-model');
  expect(rig.conv.contextWindow()).toBe(300_000);
});

// ── a child runs the model its role names
const doc = (header: string, body: string) => `---\ndescription: A test agent\n${header}---\n${body}\n`;
// A project file the person has started before (its content hash recorded as trusted).
function project(rig: Rig, name: string, text: string): void {
  const file = path.join(rig.root, '.flow-assist', 'agents', `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  recordAgentStart({ path: file, source: { kind: 'project' }, hash: agentHash(text) });
}
// What the tool answered the session. The `call` event carries the result.
const toolSaid = (rig: Rig): string => String(rig.journal().filter((e) => e.t === 'call' && !e.task && e.name === 'subagent').at(-1)?.result ?? '');
const over = (rig: Rig) => rig.until(() => rig.registry.children.backgroundCount() === 0);
// The session's own requests, as `mark` tells them from the child's.
const sessionModels = (model: ScriptedModel, mark: string): unknown[] => model.requests.filter((r) => !firstUser(r).includes(mark)).map((r) => r.model);

test('the role an agent file names runs the child on that model; the session keeps its own', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: { ...AI, backgroundFollowUp: false } });
  const child = model.when((req) => firstUser(req).includes('ROLE-A'));
  project(rig, 'job', doc('model: fast\n', 'ROLE-A go'));
  child.script([{ hold: true }, { text: 'ok' }]);
  model.script([{ tool: 'subagent', args: { agent: 'job' } }], [{ text: 'Noted.' }]);
  await rig.conv.send('go');
  await rig.idle();
  await rig.until(() => child.requests.length === 1);
  expect(child.requests[0]!.model).toBe('small-model');
  expect([...rig.conv.children][0]!.contextWindow()).toBe(256_000);
  expect(sessionModels(model, 'ROLE-A')).toEqual(['default-model', 'default-model']);
  // The journal's start line names the file's fields and the model the child runs.
  expect(rig.journal().filter((e) => e.t === 'task-start').at(-1)).toMatchObject({
    label: 'job', by: 'model', agent: 'job', source: 'project', path: expect.any(String), hash: expect.any(String), model: 'small-model',
  });
  child.release();
  await over(rig);
});

test('the tool\'s own model names a ROLE: the child runs what it names', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: { ...AI, backgroundFollowUp: false } });
  const child = model.when((req) => firstUser(req).includes('ROLE-B'));
  child.script([{ hold: true }, { text: 'ok' }]);
  model.script([{ tool: 'subagent', args: { task: 'ROLE-B count', model: 'fast' } }], [{ text: 'Noted.' }]);
  await rig.conv.send('go');
  await rig.idle();
  await rig.until(() => child.requests.length === 1);
  expect(child.requests[0]!.model).toBe('small-model');
  expect([...rig.conv.children][0]!.contextWindow()).toBe(256_000);
  expect(sessionModels(model, 'ROLE-B')).toEqual(['default-model', 'default-model']);
  child.release();
  await over(rig);
});

test('a role nothing defines is said once in the answer; the child runs the conversation\'s model', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: { ...AI, backgroundFollowUp: false } });
  const child = model.when((req) => firstUser(req).includes('ROLE-C'));
  child.script([{ hold: true }, { text: 'ok' }]);
  model.script([{ tool: 'subagent', args: { task: 'ROLE-C count', model: 'nope' } }], [{ text: 'Noted.' }]);
  await rig.conv.send('go');
  await rig.idle();
  await rig.until(() => child.requests.length === 1);
  expect(toolSaid(rig).match(/role "nope" is not defined/g)).toHaveLength(1);
  expect(child.requests[0]!.model).toBe('default-model');
  child.release();
  await over(rig);
});

test('a child with no role of its own runs the conversation\'s model', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: { ...AI, backgroundFollowUp: false } });
  const child = model.when((req) => firstUser(req).includes('ROLE-D'));
  child.script([{ hold: true }, { text: 'ok' }]);
  model.script([{ tool: 'subagent', args: { task: 'ROLE-D count' } }], [{ text: 'Noted.' }]);
  await rig.conv.send('go');
  await rig.idle();
  await rig.until(() => child.requests.length === 1);
  expect(child.requests[0]!.model).toBe('default-model');
  child.release();
  await over(rig);
});

test('a task a child starts runs what that child runs, not the session\'s model', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: { ...AI, backgroundFollowUp: false } });
  const kid = model.when((req) => firstUser(req).includes('ROLE-E kid'));
  const grand = model.when((req) => firstUser(req).includes('ROLE-E grand'));
  kid.script([{ tool: 'subagent', args: { task: 'ROLE-E grand work' } }], [{ text: 'kid done' }]);
  grand.script([{ hold: true }, { text: 'grand done' }]);
  model.script([{ tool: 'subagent', args: { task: 'ROLE-E kid work', model: 'fast' } }], [{ text: 'Noted.' }]);
  await rig.conv.send('go');
  await rig.idle();
  await rig.until(() => grand.requests.length === 1);
  expect(kid.requests[0]!.model).toBe('small-model');
  expect(grand.requests[0]!.model).toBe('small-model');
  grand.release();
  await over(rig);
});

test('a subagent\'s start line in the journal names its file and its model, and its tree node carries it', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: { ...AI, backgroundFollowUp: false } });
  const sub = model.when((req) => firstUser(req).includes('ROLE-F'));
  sub.script([{ hold: true }, { text: 'ok' }]);
  const id = rig.conv.journal({ t: 'row', role: 'user', text: 'q' }, { person: true });
  const agent = { id: 'job', source: 'project' as const, path: '/nowhere/job.md', hash: 'abc' };
  const started = rig.conv.startChild({ kind: 'subagent', label: 'clock', prompt: 'ROLE-F go', by: 'person', agent, model: 'small-model' }, id);
  if ('refused' in started) throw new Error(started.refused);
  const running = started.run();
  await rig.until(() => sub.held);
  expect(rig.journal().filter((e) => e.t === 'subagent' && e.event === 'start').at(-1)).toMatchObject({
    label: 'clock', by: 'person', agent: 'job', source: 'project', path: '/nowhere/job.md', hash: 'abc', model: 'small-model',
  });
  expect(rig.conv.tree().find((n) => n.label === 'clock')?.model).toBe('small-model');
  sub.release();
  await running;
  started.child.stopSubtree('');
});
