// An agent file's `skills:` key on the model's path (`subagent` with `agent`): each named
// skill resolved at the start by the model's trust rule, the bodies framed after the filled
// prompt in the file's order, the start answer and the journal naming them, the child's
// first message marked for its compaction line, the child keeping the `skill` tool. A
// conversation on the scripted model, no App.
import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Conversation } from '../assistant/conversation.ts';
import { foldIntoHandoff } from '../assistant/conversation-turn.ts';
import { agentHash } from '../assistant/agent-file.ts';
import { agentTrustPath, recordAgentStart, skillKeyOf } from '../assistant/agent-trust.ts';
import { loadSkillFresh } from '../assistant/skill-file.ts';
import { SKILLS_LINE } from '../assistant/skill-model.ts';
import { hostStateDir } from '../config/load.ts';
import { ScriptedModel, firstUser, handoff } from './helpers/scripted';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation';

afterEach(() => {
  closeRigs();
  fs.rmSync(path.join(hostStateDir(), 'skills'), { recursive: true, force: true });
  fs.rmSync(path.join(hostStateDir(), 'agents'), { recursive: true, force: true });
  fs.rmSync(agentTrustPath(), { force: true });
});

const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const skillDoc = (name: string, body: string) => `---\ndescription: ${name} words\n---\n${body}\n`;
const toolNames = (req: { tools?: unknown }): string[] => ((req.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name);

function record(dir: string, source: { kind: 'person' } | { kind: 'project' }): void {
  const fresh = loadSkillFresh(dir, source);
  if (!fresh.ok) throw new Error('record: unreadable');
  let files: Record<string, string> = {};
  try { files = (JSON.parse(fs.readFileSync(agentTrustPath(), 'utf8')) as { files: Record<string, string> }).files; } catch { /* none yet */ }
  files[skillKeyOf(fresh.skill)] = fresh.skill.hash;
  write(agentTrustPath(), JSON.stringify({ files }));
}
// A person's skill, recorded (or not).
function person(name: string, body: string, recorded = true): string {
  const dir = path.dirname(write(path.join(hostStateDir(), 'skills', name, 'SKILL.md'), skillDoc(name, body)));
  if (recorded) record(dir, { kind: 'person' });
  return dir;
}
function project(rig: Rig, name: string, body: string, recorded = true): string {
  const dir = path.dirname(write(path.join(rig.root, '.flow-assist', 'skills', name, 'SKILL.md'), skillDoc(name, body)));
  if (recorded) record(dir, { kind: 'project' });
  return dir;
}
// A project agent file the person has started before.
function agent(rig: Rig, name: string, header: string, body: string): void {
  const text = `---\ndescription: A test agent\n${header}---\n${body}\n`;
  const file = write(path.join(rig.root, '.flow-assist', 'agents', `${name}.md`), text);
  recordAgentStart({ path: file, source: { kind: 'project' }, hash: agentHash(text) });
}

function rigFor(mark: string) {
  const model = new ScriptedModel();
  const child = model.when((req) => firstUser(req).includes(mark));
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  return { model, child, rig };
}
async function call(rig: Rig, model: ScriptedModel, args: Record<string, unknown>): Promise<string> {
  model.script([{ tool: 'subagent', args }], [{ text: 'Noted.' }]);
  await rig.conv.send('go');
  await rig.idle();
  const ev = rig.journal().filter((e) => e.t === 'call' && !e.task && e.name === 'subagent').at(-1);
  return String(ev?.result ?? '');
}
const systemOf = (req: { messages: { role: string; content?: unknown }[] }): string => String(req.messages.find((m) => m.role === 'system')?.content ?? '');
const childDone = (rig: Rig) => rig.until(() => rig.registry.children.backgroundCount() === 0);

test('the named skills are framed after the filled prompt in the file\'s order, before the follow-up; the answer, the journal and the first message name them; the child keeps the skill tool', async () => {
  const sent: Array<{ self: Conversation; options: { preloaded?: string[] } | undefined }> = [];
  const real = Conversation.prototype.send;
  const spy = spyOn(Conversation.prototype, 'send').mockImplementation(function (this: Conversation, ...a: Parameters<Conversation['send']>) {
    if (this.parent) sent.push({ self: this, options: a[1] as { preloaded?: string[] } | undefined });
    return real.apply(this, a);
  });
  try {
    const { model, child, rig } = rigFor('GO-S');
    const alpha = person('alpha', 'ALPHA-BODY');
    const beta = project(rig, 'beta', 'BETA-BODY');
    agent(rig, 'job', 'params: ticket\nskills: beta, alpha\n', 'GO-S ticket={{ticket}}');
    child.script([{ text: 'child done' }]);
    const answer = await call(rig, model, { agent: 'job', args: { ticket: 'T-1' }, task: 'FOLLOW-UP' });
    expect(answer).toContain('Background task started (job)');
    expect(answer).toContain('@job: skills preloaded — beta, alpha');
    await rig.until(() => child.requests.length === 1);
    await childDone(rig);
    const first = firstUser(child.requests[0]!);
    expect(first.startsWith('GO-S ticket=T-1\n\n[The skill «beta» — project, ')).toBe(true);
    const at = (s: string) => first.indexOf(s);
    expect(at('GO-S ticket=T-1')).toBeLessThan(at('BETA-BODY'));
    expect(at('BETA-BODY')).toBeLessThan(at('«alpha»'));
    expect(at('«alpha»')).toBeLessThan(at('ALPHA-BODY'));
    expect(at('ALPHA-BODY')).toBeLessThan(at('FOLLOW-UP'));
    expect(first).toContain('<skill n=');
    // The skill tool is not narrowed away from the child.
    expect(toolNames(child.requests[0]!)).toContain('skill');
    // One journal line per skill, by the agent, with the hash that was read.
    const loads = rig.journal().filter((e) => e.t === 'skill-load');
    expect(loads).toHaveLength(2);
    const hashOf = (dir: string, source: { kind: 'person' } | { kind: 'project' }): string => {
      const r = loadSkillFresh(dir, source);
      if (!r.ok) throw new Error('unreadable');
      return r.skill.hash;
    };
    expect(loads[0]).toMatchObject({ name: 'beta', source: 'project', path: path.join(fs.realpathSync(beta), 'SKILL.md'), hash: hashOf(beta, { kind: 'project' }), by: 'agent', agent: 'job', task: 'job' });
    expect(loads[1]).toMatchObject({ name: 'alpha', source: 'person', path: path.join(fs.realpathSync(alpha), 'SKILL.md'), hash: hashOf(alpha, { kind: 'person' }), by: 'agent' });
    // The first message carries the ids as a host mark; nothing else of the child is marked.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.options).toEqual({ preloaded: ['beta', 'alpha'] });
    expect(sent[0]!.self.api[0]).toMatchObject({ role: 'user', skills: ['beta', 'alpha'] });
  } finally { spy.mockRestore(); }
});

test('the child\'s compaction line counts the preloaded skills by the host mark', async () => {
  const caught: Conversation[] = [];
  const real = Conversation.prototype.send;
  const spy = spyOn(Conversation.prototype, 'send').mockImplementation(function (this: Conversation, ...a: Parameters<Conversation['send']>) {
    if (this.parent) caught.push(this);
    return real.apply(this, a);
  });
  try {
    const { model, child, rig } = rigFor('GO-C');
    person('alpha', 'ALPHA-BODY');
    person('beta', 'BETA-BODY');
    agent(rig, 'job', 'skills: alpha, beta\n', 'GO-C go');
    child.script([{ text: 'child done' }]);
    await call(rig, model, { agent: 'job' });
    await rig.until(() => child.requests.length === 1);
    await childDone(rig);
    const c = caught[0]!;
    model.script([{ text: handoff('CH') }]);
    const folded = await foldIntoHandoff(c, [{ role: 'user', content: 'the model\'s view carries no mark' }], new AbortController().signal);
    expect(folded.summary).toBe(`${handoff('CH')}\n\n${SKILLS_LINE} alpha, beta`);
  } finally { spy.mockRestore(); }
});

test('an agent without skills sends a plain first message: no mark, no skill-load, no note', async () => {
  const { model, child, rig } = rigFor('GO-P');
  agent(rig, 'job', '', 'GO-P go');
  child.script([{ text: 'ok' }]);
  const answer = await call(rig, model, { agent: 'job' });
  await rig.until(() => child.requests.length === 1);
  await childDone(rig);
  expect(firstUser(child.requests[0]!)).toBe('GO-P go');
  expect(answer).not.toContain('preloaded');
  expect(rig.journal().filter((e) => e.t === 'skill-load')).toEqual([]);
});

test('a skill is read fresh at each start: an edit the person recorded is what the next start loads', async () => {
  const { model, child, rig } = rigFor('GO-F');
  const dir = person('alpha', 'FIRST-BODY');
  agent(rig, 'job', 'skills: alpha\n', 'GO-F go');
  child.script([{ text: 'one' }], [{ text: 'two' }]);
  await call(rig, model, { agent: 'job' });
  await childDone(rig);
  write(path.join(dir, 'SKILL.md'), skillDoc('alpha', 'SECOND-BODY'));
  record(dir, { kind: 'person' });
  await call(rig, model, { agent: 'job' });
  await childDone(rig);
  expect(firstUser(child.requests[0]!)).toContain('FIRST-BODY');
  expect(firstUser(child.requests[1]!)).toContain('SECOND-BODY');
  expect(firstUser(child.requests[1]!)).not.toContain('FIRST-BODY');
});

test('a skill that is not trusted fails the start, naming it and the person\'s command; nothing starts, nothing is journaled', async () => {
  const { model, child, rig } = rigFor('GO-N');
  agent(rig, 'job', 'skills: good, secret\n', 'GO-N go');
  person('good', 'G');
  // unrecorded person skill
  person('secret', 'S', false);
  let answer = await call(rig, model, { agent: 'job' });
  expect(answer).toContain('@job: the skill «secret» is not trusted');
  expect(answer).toContain('ask the person to run /skill secret once');
  expect(answer).not.toContain('Background task started');
  // an unrecorded project skill
  project(rig, 'secret', 'P', false);
  answer = await call(rig, model, { agent: 'job' });
  expect(answer).toContain('ask the person to run /skill secret once');
  // a recorded one that changed since
  const dir = project(rig, 'secret', 'P2');
  write(path.join(dir, 'SKILL.md'), skillDoc('secret', 'P3'));
  answer = await call(rig, model, { agent: 'job' });
  expect(answer).toContain('ask the person to run /skill secret once');
  expect(answer).not.toContain('P3');
  expect(child.requests).toHaveLength(0);
  expect(rig.registry.children.backgroundCount()).toBe(0);
  expect(rig.journal().filter((e) => e.t === 'skill-load')).toEqual([]);
});

test('a missing skill and a broken one fail the start too, by name', async () => {
  const { model, child, rig } = rigFor('GO-M');
  agent(rig, 'job', 'skills: ghost\n', 'GO-M go');
  let answer = await call(rig, model, { agent: 'job' });
  expect(answer).toContain('subagent: @job names the skill «ghost»: no skill named ghost');
  write(path.join(hostStateDir(), 'skills', 'ghost', 'SKILL.md'), 'no header at all\n');
  answer = await call(rig, model, { agent: 'job' });
  expect(answer).toContain('@job names the skill «ghost»: skill ghost has errors');
  expect(child.requests).toHaveLength(0);
  expect(rig.registry.children.backgroundCount()).toBe(0);
});

test('a trusted plugin\'s skill in the list is preloaded without a record', async () => {
  const { model, child, rig } = rigFor('GO-PL');
  const plug = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-sk-plug-')));
  try {
    write(path.join(plug, 'manifest.json'), JSON.stringify({ name: 'tk', skills: ['skills/ticket'] }));
    write(path.join(plug, 'skills', 'ticket', 'SKILL.md'), skillDoc('ticket', 'PLUGIN-BODY'));
    (rig.services as unknown as { agentPlugins: () => unknown }).agentPlugins = () => [{ name: 'tk', dir: plug }];
    agent(rig, 'job', 'skills: tk/ticket\n', 'GO-PL go');
    child.script([{ text: 'ok' }]);
    const answer = await call(rig, model, { agent: 'job' });
    expect(answer).toContain('@job: skills preloaded — tk/ticket');
    await rig.until(() => child.requests.length === 1);
    await childDone(rig);
    expect(firstUser(child.requests[0]!)).toContain('PLUGIN-BODY');
    expect(rig.journal().filter((e) => e.t === 'skill-load')[0]).toMatchObject({ name: 'tk/ticket', source: 'plugin', by: 'agent' });
  } finally { fs.rmSync(plug, { recursive: true, force: true }); }
});

test('the bodies are sent once: the first message carries them, the child\'s system prompt only the prompt without them', async () => {
  const { model, child, rig } = rigFor('GO-ONCE');
  person('alpha', 'ALPHA-BODY');
  agent(rig, 'job', 'skills: alpha\n', 'GO-ONCE go');
  child.script([{ text: 'ok' }]);
  await call(rig, model, { agent: 'job', task: 'FOLLOW' });
  await rig.until(() => child.requests.length === 1);
  await childDone(rig);
  const req = child.requests[0]!;
  expect(firstUser(req)).toContain('ALPHA-BODY');
  expect(systemOf(req)).toContain('GO-ONCE go');
  expect(systemOf(req)).toContain('FOLLOW');
  expect(systemOf(req)).not.toContain('ALPHA-BODY');
  expect(systemOf(req)).not.toContain('«alpha»');
});

test('the preload is capped at 64 KiB in all: the start fails naming the skill that crosses it', async () => {
  const { model, child, rig } = rigFor('GO-BIG');
  for (const n of ['a', 'b', 'c']) person(n, `${n.toUpperCase()}${'x'.repeat(25_000)}`);
  agent(rig, 'two', 'skills: a, b\n', 'GO-BIG two');
  agent(rig, 'three', 'skills: a, b, c\n', 'GO-BIG three');
  child.script([{ text: 'ok' }]);
  expect(await call(rig, model, { agent: 'two' })).toContain('Background task started');
  await childDone(rig);
  const answer = await call(rig, model, { agent: 'three' });
  expect(answer).toContain('the skill «c» takes the preload past 64 KiB');
  expect(answer).not.toContain('Background task started');
  expect(child.requests).toHaveLength(1);
});
