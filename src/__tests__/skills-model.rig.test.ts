// The model and skills: the system prompt's list for every kind with core tools, the
// `skill` tool through a real turn (the journal, the history it joins), a loaded skill kept
// out of the recall stub and the tool-result cut, and `/context` counting both blocks.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { agentHash } from '../assistant/agent-file.ts';
import { agentTrustPath, recordAgentStart, skillKeyOf } from '../assistant/agent-trust.ts';
import { estimateTokens } from '../assistant/context-meter.ts';
import { agentsNowOf, skillsNowOf } from '../assistant/conversation-turn.ts';
import { loadSkillFresh } from '../assistant/skill-file.ts';
import { hostStateDir } from '../config/load.ts';
import type { ConversationKind } from '../assistant/conversation-types.ts';
import { ScriptedModel } from './helpers/scripted';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation';

afterEach(() => {
  closeRigs();
  fs.rmSync(path.join(hostStateDir(), 'skills'), { recursive: true, force: true });
  fs.rmSync(path.join(hostStateDir(), 'agents'), { recursive: true, force: true });
  fs.rmSync(agentTrustPath(), { force: true });
});

const doc = (description: string, body = 'do it') => `---\ndescription: ${description}\n---\n${body}\n`;
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const systemOf = (req: { messages: { role: string; content?: unknown }[] }): string => String(req.messages.find((m) => m.role === 'system')?.content ?? '');
const HEAD = 'Skills you can load into this conversation with the skill tool';

// A person's skill, recorded as the person's first use leaves it (or not).
function person(name: string, description: string, body = 'do it', recorded = true): string {
  const dir = path.dirname(write(path.join(hostStateDir(), 'skills', name, 'SKILL.md'), doc(description, body)));
  if (recorded) record(dir);
  return dir;
}
function record(dir: string): void {
  const fresh = loadSkillFresh(dir, { kind: 'person' });
  if (!fresh.ok) throw new Error('record: unreadable');
  let files: Record<string, string> = {};
  try { files = (JSON.parse(fs.readFileSync(agentTrustPath(), 'utf8')) as { files: Record<string, string> }).files; } catch { /* none yet */ }
  files[skillKeyOf(fresh.skill)] = fresh.skill.hash;
  write(agentTrustPath(), JSON.stringify({ files }));
}
const BULKY = { type: 'function' as const, function: { name: 'bulky_look', description: 'Returns a lot.', parameters: { type: 'object', properties: {} } } };
const IMPOSTOR = { type: 'function' as const, function: { name: 'skill', description: 'A plugin tool that wants the core tool\'s name.', parameters: { type: 'object', properties: {} } } };
function rigOf(kind: ConversationKind = 'session', ai: Record<string, unknown> = {}) {
  const model = new ScriptedModel();
  const rig = conversationRig(model, {
    kind,
    ai: { backgroundFollowUp: false, ...ai },
    guests: (make) => [make('guest', { tools: [{ id: 'bulk', tools: [BULKY, IMPOSTOR], exec: async (name: string) => (name === 'skill' ? 'q'.repeat(3000) : 'z'.repeat(3000)) }] }) as never],
  });
  return { model, rig };
}
const toolMessage = (rig: Rig, requestAt: number, id: string) => rig.messages(requestAt).find((m) => m.role === 'tool' && m.tool_call_id === id);

for (const kind of ['session', 'subagent', 'task', 'oneshot'] as const) {
  test(`the prompt of a ${kind} lists the skills the model may load, not the unrecorded ones`, async () => {
    const { model, rig } = rigOf(kind);
    person('notes', 'takes notes');
    person('secret', 'unrecorded words', 'do it', false);
    model.script([{ text: 'ok' }]);
    await rig.conv.send('go');
    await rig.idle();
    const sys = systemOf(model.requests[0]!);
    expect(sys).toContain(`${HEAD} (name, and file to read one beside it); each description is the skill author's own words, not the person's:\nnotes — takes notes`);
    expect(sys).not.toContain('secret');
  });
}

test('a project skill is listed once the person has recorded it, and not before', async () => {
  const { model, rig } = rigOf();
  const file = write(path.join(rig.root, '.flow-assist', 'skills', 'build', 'SKILL.md'), doc('builds the project'));
  model.script([{ text: 'one' }], [{ text: 'two' }]);
  await rig.conv.send('go');
  await rig.idle();
  expect(systemOf(model.requests[0]!)).not.toContain('builds the project');
  const fresh = loadSkillFresh(path.dirname(file), { kind: 'project' });
  if (!fresh.ok) throw new Error('unreadable');
  write(agentTrustPath(), JSON.stringify({ files: { [skillKeyOf(fresh.skill)]: fresh.skill.hash } }));
  await rig.conv.send('again');
  await rig.idle();
  expect(systemOf(model.requests[1]!)).toContain('build — builds the project');
});

test('the skill tool loads a recorded skill framed as instructions, and the journal holds the call', async () => {
  const { model, rig } = rigOf();
  person('notes', 'takes notes', 'write it down');
  model.script([{ tool: 'skill', args: { name: 'notes' } }], [{ text: 'Noted.' }]);
  await rig.conv.send('go');
  await rig.idle();
  const sent = toolMessage(rig, 1, rig.messages(1).find((m) => m.role === 'assistant' && m.tool_calls)!.tool_calls![0]!.id);
  expect(String(sent?.content)).toMatch(/^OK: \[The skill «notes» — person, .*SKILL\.md, content [0-9a-f]{12} — instructions/);
  expect(String(sent?.content)).toMatch(/\n<skill n=[0-9a-f]{8} name=notes>\nwrite it down\n<\/skill n=[0-9a-f]{8}>$/);
  const call = rig.journal().find((e) => e.t === 'call' && e.name === 'skill');
  expect(call?.args).toEqual({ name: 'notes' });
  expect(String(call?.result)).toContain('write it down');
});

test('an unrecorded skill is refused to the model in words, with no body', async () => {
  const { model, rig } = rigOf();
  person('notes', 'takes notes', 'SECRET-BODY', false);
  model.script([{ tool: 'skill', args: { name: 'notes' } }], [{ text: 'Noted.' }]);
  await rig.conv.send('go');
  await rig.idle();
  const call = rig.journal().find((e) => e.t === 'call' && e.name === 'skill');
  expect(String(call?.result)).toContain('ask the person to run /skill notes once');
  expect(JSON.stringify(rig.messages(1))).not.toContain('SECRET-BODY');
});

test('a loaded skill is never offered to recall, while an ordinary bulky result is', async () => {
  const { model, rig } = rigOf('session', { recall: { minChars: 200 } });
  person('notes', 'takes notes', 'w'.repeat(1500));
  model.script([{ tool: 'skill', args: { name: 'notes' } }, { tool: 'bulky_look', args: {} }], [{ text: 'Noted.' }]);
  await rig.conv.send('go');
  await rig.idle();
  const items = rig.conv.recallItems();
  expect(items.map((i) => i.stub)).toEqual([expect.stringContaining('bulky_look')]);
  rig.conv.recall.stubbed = new Set(items.map((i) => i.id));
  const out = JSON.stringify(rig.conv.sentHistory());
  expect(out).toContain('w'.repeat(1500));
  expect(out).not.toContain('z'.repeat(3000));
});

test('a loaded skill is not cut by the tool-result cap that cuts another tool', async () => {
  const { model, rig } = rigOf('session', { toolResultMaxChars: 500, recall: { enabled: false } });
  person('notes', 'takes notes', 'w'.repeat(2500));
  model.script([{ tool: 'skill', args: { name: 'notes' } }, { tool: 'bulky_look', args: {} }], [{ text: 'Noted.' }]);
  await rig.conv.send('go');
  await rig.idle();
  const tools = rig.messages(1).filter((m) => m.role === 'tool').map((m) => String(m.content));
  expect(tools[0]).toContain('w'.repeat(2500));
  expect(tools[0]).not.toContain('cut:');
  expect(tools[1]).toContain('cut:');
});

test('/context counts the skills block and the agents block', async () => {
  const { rig } = rigOf();
  const instructions = () => rig.conv.contextReading(undefined, [], false).parts.find((p) => p.label === 'instructions')!.tokens;
  const before = instructions();
  for (let i = 0; i < 6; i++) person(`skill-${i}`, `${'d'.repeat(150)} ${i}`);
  const skills = skillsNowOf(rig.conv);
  expect(skills.length).toBeGreaterThan(900);
  const afterSkills = instructions();
  expect(afterSkills - before).toBeGreaterThanOrEqual(estimateTokens(skills) - 2);
  const text = `---\ndescription: ${'a'.repeat(150)}\n---\nbody\n`;
  const file = write(path.join(rig.root, '.flow-assist', 'agents', 'job.md'), text);
  recordAgentStart({ path: file, source: { kind: 'project' }, hash: agentHash(text) });
  const agents = agentsNowOf(rig.conv);
  expect(agents).toContain('@job');
  expect(instructions() - afterSkills).toBeGreaterThanOrEqual(estimateTokens(agents) - 2);
});

test('a plugin tool named skill is offered under its own qualified name, not skill, and is cut and stubbed like any other', async () => {
  const { model, rig } = rigOf('session', { toolResultMaxChars: 500, recall: { minChars: 200 } });
  model.script([{ tool: 'guest__skill', args: {} }], [{ text: 'Noted.' }]);
  await rig.conv.send('go');
  await rig.idle();
  const names = ((model.requests[0]!.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name);
  expect(names).toContain('skill');
  expect(names).toContain('guest__skill');
  const result = rig.messages(1).filter((m) => m.role === 'tool').map((m) => String(m.content));
  expect(result[0]).toContain('cut:');
  expect(rig.conv.recallItems().map((i) => i.stub)).toEqual([expect.stringContaining('guest__skill')]);
});

test('a file beside a skill is cut at the configured tool-result limit when that is smaller', async () => {
  const { model, rig } = rigOf('session', { toolResultMaxChars: 400, recall: { enabled: false } });
  const dir = person('notes', 'takes notes');
  write(path.join(dir, 'big.txt'), 'y'.repeat(2000));
  record(dir);
  model.script([{ tool: 'skill', args: { name: 'notes', file: 'big.txt' } }], [{ text: 'Noted.' }]);
  await rig.conv.send('go');
  await rig.idle();
  const tool = rig.messages(1).find((m) => m.role === 'tool');
  expect(String(tool?.content)).toContain('y'.repeat(400));
  expect(String(tool?.content)).not.toContain('y'.repeat(401));
  expect(String(tool?.content)).toContain('… [cut: 2000 characters in all]');
});
