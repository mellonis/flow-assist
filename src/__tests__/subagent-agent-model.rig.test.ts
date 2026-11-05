// The model starts an agent file by name with its `subagent` tool (`agent`, `args`): the
// filled prompt, the label, the tool groups, the auto mode, the refusals it reads, the list
// in the system prompt and the journal. A conversation on the scripted model, no App.
import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Conversation } from '../assistant/conversation.ts';
import { exportMarkdown } from '../assistant/journal.ts';
import { agentHash } from '../assistant/agent-file.ts';
import { agentTrustPath, recordAgentStart } from '../assistant/agent-trust.ts';
import { hostStateDir } from '../config/load.ts';
import { ScriptedModel, firstUser } from './helpers/scripted';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation';

const made: string[] = [];
afterEach(() => {
  closeRigs();
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(path.join(hostStateDir(), 'agents'), { recursive: true, force: true });
  fs.rmSync(agentTrustPath(), { force: true });
});

const doc = (header: string, body: string, description = 'A test agent') => `---\ndescription: ${description}\n${header}---\n${body}\n`;
// A project file the person has started before (its trust recorded), or not.
function project(rig: Rig, name: string, text: string, trusted = true): string {
  const file = path.join(rig.root, '.flow-assist', 'agents', `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (trusted) recordAgentStart({ path: file, source: { kind: 'project' }, hash: agentHash(text) });
  return file;
}
const BAND = { type: 'function' as const, function: { name: 'band_look', description: 'Looks at the band.', parameters: { type: 'object', properties: {} } } };
const OTHER = { type: 'function' as const, function: { name: 'other_look', description: 'Looks elsewhere.', parameters: { type: 'object', properties: {} } } };
const toolNames = (req: { tools?: unknown }): string[] => ((req.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name);
const systemOf = (req: { messages: { role: string; content?: unknown }[] }): string => String(req.messages.find((m) => m.role === 'system')?.content ?? '');
const BLOCK = 'Agents you can start by name with the subagent tool (agent, args):';

function rigFor(mark: string, opts: { agents?: Record<string, unknown> } = {}) {
  const model = new ScriptedModel();
  const child = model.when((req) => firstUser(req).includes(mark));
  const rig = conversationRig(model, {
    ai: { backgroundFollowUp: false },
    guests: (make) => [make('guest', { tools: [
      { id: 'notes', tools: [BAND], exec: async () => 'band seen' },
      { id: 'other', tools: [OTHER], exec: async () => 'elsewhere' },
    ] }) as never],
    ...(opts.agents ? { extra: { agents: opts.agents } } : {}),
  });
  return { model, child, rig };
}
// The session calls `subagent` with `args`; returns what the tool answered.
async function call(rig: Rig, model: ScriptedModel, args: Record<string, unknown>): Promise<string> {
  model.script([{ tool: 'subagent', args }], [{ text: 'Noted.' }]);
  await rig.conv.send('go');
  await rig.idle();
  const ev = rig.journal().filter((e) => e.t === 'call' && !e.task && e.name === 'subagent').at(-1);
  return String(ev?.result ?? '');
}
const childDone = (rig: Rig) => rig.until(() => rig.registry.children.backgroundCount() === 0);

test('the model starts an agent by name: the filled prompt, the id as label, the named tool groups, the capped auto mode', async () => {
  const modes: string[] = [];
  const spy = spyOn(Conversation.prototype, 'setAutoMode').mockImplementation(function (this: Conversation, mode: string) { if (this.parent) modes.push(mode); });
  try {
    const { model, child, rig } = rigFor('GO-A');
    project(rig, 'job', doc('params: ticket\ntools: notes\nauto: all\n', 'GO-A ticket={{ticket}}'));
    child.script([{ text: 'child done' }]);
    const answer = await call(rig, model, { agent: '@job', args: { ticket: 'T-1' } });
    expect(answer).toContain('Background task started (job)');
    await rig.until(() => child.requests.length === 1);
    await childDone(rig);
    expect(firstUser(child.requests[0]!)).toBe('GO-A ticket=T-1');
    const names = toolNames(child.requests[0]!);
    expect(names).toContain('band_look');
    expect(names).toContain('datetime');
    expect(names).not.toContain('other_look');
    expect(names).not.toContain('run_command');
    expect(modes).toEqual(['reads']);
  } finally { spy.mockRestore(); }
});

test('the id works without @, and agents.maxAuto raises the cap', async () => {
  const modes: string[] = [];
  const spy = spyOn(Conversation.prototype, 'setAutoMode').mockImplementation(function (this: Conversation, mode: string) { if (this.parent) modes.push(mode); });
  try {
    const { model, child, rig } = rigFor('GO-B', { agents: { maxAuto: 'all' } });
    project(rig, 'job', doc('auto: all\n', 'GO-B go'));
    child.script([{ text: 'ok' }]);
    await call(rig, model, { agent: 'job' });
    await rig.until(() => child.requests.length === 1);
    await childDone(rig);
    expect(modes).toEqual(['all']);
  } finally { spy.mockRestore(); }
});

test('an agent task may write under the person\'s y/n, as a task started with write: true does', async () => {
  const { model, child, rig } = rigFor('GO-W');
  project(rig, 'job', doc('', 'GO-W go'));
  child.script([{ tool: 'run_command', args: { command: 'echo x > made.txt' } }], [{ text: 'done' }]);
  expect(await call(rig, model, { agent: 'job' })).toContain('may ask the person');
  await rig.until(() => rig.conv.offered() !== null);
  expect(rig.conv.offered()).toMatchObject({ path: ['job'] });
  rig.conv.offered()!.owner.answerConfirm(false);
  await childDone(rig);
});

test('a second start while the first runs is labeled job-2', async () => {
  const { model, child, rig } = rigFor('GO-C');
  project(rig, 'job', doc('', 'GO-C go'));
  child.script([{ hold: true }, { text: 'ok' }], [{ text: 'ok' }]);
  await call(rig, model, { agent: 'job' });
  await rig.until(() => child.held);
  model.script([{ tool: 'subagent', args: { agent: 'job' } }], [{ text: 'Noted.' }]);
  await rig.conv.send('again');
  await rig.idle();
  const starts = rig.journal().filter((e) => e.t === 'task-start').map((e) => e.label);
  expect(starts).toEqual(['job', 'job-2']);
  child.release();
  await childDone(rig);
});

test('prompt (task) is appended after the filled body under its line', async () => {
  const { model, child, rig } = rigFor('GO-D');
  project(rig, 'job', doc('params: ticket\n', 'GO-D {{ticket}}'));
  child.script([{ text: 'ok' }]);
  await call(rig, model, { agent: 'job', args: { ticket: 'T-2' }, task: 'Be brief.' });
  await rig.until(() => child.requests.length === 1);
  await childDone(rig);
  expect(firstUser(child.requests[0]!)).toBe('GO-D T-2\n\nAdditional instructions from the conversation that started you:\nBe brief.');
});

test('refusals are the tool\'s answer, worded for the model, and nothing starts', async () => {
  const { model, child, rig } = rigFor('GO-E');
  project(rig, 'job', doc('params: ticket, branch\n', 'GO-E {{ticket}} {{branch}}'));
  project(rig, 'bad', doc('tool: x\n', 'GO-E bad'));
  project(rig, 'loose', doc('params: ticket\n', 'GO-E loose {{ticket}}'), false);
  const plugs = ['p1', 'p2'].map((n) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `fa-ag-${n}-`)));
    made.push(dir);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ agents: ['same.md'] }));
    fs.writeFileSync(path.join(dir, 'same.md'), doc('', 'GO-E same'));
    return { name: n, dir };
  });
  (rig.services as unknown as { agentPlugins: () => unknown }).agentPlugins = () => plugs;
  const said = async (args: Record<string, unknown>) => {
    const before = rig.journal().filter((e) => e.t === 'call' && !e.task && e.name === 'subagent').length;
    model.script([{ tool: 'subagent', args }], [{ text: 'Noted.' }]);
    await rig.conv.send('go');
    await rig.idle();
    return String(rig.journal().filter((e) => e.t === 'call' && !e.task && e.name === 'subagent')[before]?.result ?? '');
  };
  expect(await said({ agent: 'nope' })).toBe('subagent: no agent named @nope — /subagent @ lists them');
  expect(await said({ agent: 'same' })).toContain('subagent: @same names more than one agent — use @p1/same or @p2/same');
  expect(await said({ agent: 'bad' })).toBe('subagent: @bad has errors in its file — /subagent @ shows them');
  expect(await said({ agent: 'job', args: { ticket: 'T-1' } })).toBe('subagent: @job needs branch');
  expect(await said({ agent: 'job' })).toBe('subagent: @job needs ticket, branch');
  expect(await said({ agent: 'job', args: { ticket: 'a', branch: 'b', nope: 'x' } })).toContain('@job has no parameter «nope»');
  expect(await said({ agent: 'loose', args: { ticket: 'a' } })).toBe('subagent: @loose is not trusted here — ask the person to start @loose once');
  expect(child.requests).toHaveLength(0);
  expect(rig.journal().filter((e) => e.t === 'task-start')).toHaveLength(0);
});

test('a parameter named like an Object.prototype member is asked for, and filled from the given value', async () => {
  const { model, child, rig } = rigFor('GO-P');
  project(rig, 'job', doc('params: toString\n', 'GO-P {{toString}}'));
  child.script([{ text: 'ok' }]);
  const first = await call(rig, model, { agent: 'job' });
  expect(first).toBe('subagent: @job needs toString');
  expect(child.requests).toHaveLength(0);
  await call(rig, model, { agent: 'job', args: { toString: 'x' } });
  await rig.until(() => child.requests.length === 1);
  await childDone(rig);
  expect(firstUser(child.requests[0]!)).toBe('GO-P x');
});

test('a person\'s agent the person never started is untrusted; once started by the person it starts', async () => {
  const { model, child, rig } = rigFor('GO-F');
  const file = path.join(hostStateDir(), 'agents', 'mine.md');
  const text = doc('', 'GO-F mine');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  expect(await call(rig, model, { agent: 'mine' })).toBe('subagent: @mine is not trusted here — ask the person to start @mine once');
  expect(child.requests).toHaveLength(0);
  recordAgentStart({ path: file, source: { kind: 'person' }, hash: agentHash(text) });
  child.script([{ text: 'ok' }]);
  model.script([{ tool: 'subagent', args: { agent: 'mine' } }], [{ text: 'Noted.' }]);
  await rig.conv.send('again');
  await rig.idle();
  await rig.until(() => child.requests.length === 1);
  await childDone(rig);
  expect(firstUser(child.requests[0]!)).toBe('GO-F mine');
});

test('a changed project file is untrusted again', async () => {
  const { model, child, rig } = rigFor('GO-G');
  const file = project(rig, 'job', doc('', 'GO-G one'));
  fs.writeFileSync(file, doc('', 'GO-G two'));
  expect(await call(rig, model, { agent: 'job' })).toContain('is not trusted here');
  expect(child.requests).toHaveLength(0);
});

test('a plugin\'s agent starts with no record', async () => {
  const { model, child, rig } = rigFor('GO-H');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ag-plug-')));
  made.push(dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ agents: ['a.md'] }));
  fs.writeFileSync(path.join(dir, 'a.md'), doc('', 'GO-H plugin'));
  (rig.services as unknown as { agentPlugins: () => unknown }).agentPlugins = () => [{ name: 'plug', dir }];
  child.script([{ text: 'ok' }]);
  const answer = await call(rig, model, { agent: 'plug/a' });
  expect(answer).toContain('Background task started (plug/a)');
  await rig.until(() => child.requests.length === 1);
  await childDone(rig);
  expect(fs.existsSync(agentTrustPath())).toBe(false);
});

test('the start line of the task carries the agent, source, path and hash; /export shows @id', async () => {
  const { model, child, rig } = rigFor('GO-I');
  const text = doc('', 'GO-I go');
  const file = project(rig, 'job', text);
  child.script([{ text: 'ok' }]);
  await call(rig, model, { agent: 'job' });
  await rig.until(() => child.requests.length === 1);
  await childDone(rig);
  const events = rig.journal();
  const start = events.find((e) => e.t === 'task-start');
  expect(start).toMatchObject({ task: 'job', label: 'job', by: 'model', agent: 'job', source: 'project', path: file, hash: agentHash(text) });
  const md = exportMarkdown(events, { title: 't', id: 'x' });
  expect(md).toContain('Task «job» started from @job (by the model)');
});

test('without agent the tool is as it was: the task is the label, no start line', async () => {
  const { model, child, rig } = rigFor('GO-J');
  child.script([{ text: 'ok' }]);
  const answer = await call(rig, model, { task: 'GO-J count things', label: 'plain' });
  expect(answer).toContain('Background task started (plain)');
  await rig.until(() => child.requests.length === 1);
  await childDone(rig);
  expect(firstUser(child.requests[0]!)).toBe('GO-J count things');
  expect(rig.journal().filter((e) => e.t === 'task-start')).toHaveLength(0);
  expect(await call(rig, model, {})).toBe('task is required — the work to do in the background.');
});

// ── the list in the system prompt
test('the session\'s and a task\'s system prompt list the trusted agents, one line each with parameters', async () => {
  const { model, child, rig } = rigFor('GO-K');
  project(rig, 'job', doc('params: ticket, branch?\n', 'GO-K {{ticket}} {{branch}}', 'Does the job'));
  project(rig, 'plain', doc('', 'GO-K y', 'No parameters'));
  project(rig, 'loose', doc('', 'GO-K z', 'Never started'), false);
  child.script([{ text: 'ok' }]);
  model.script([{ tool: 'subagent', args: { agent: 'plain' } }], [{ text: 'Noted.' }]);
  await rig.conv.send('go');
  await rig.idle();
  await rig.until(() => child.requests.length === 1);
  await childDone(rig);
  const sys = systemOf(model.requests[0]!);
  expect(sys).toContain(`${BLOCK}\n@job — Does the job (<ticket> [branch])\n@plain — No parameters`);
  expect(sys).not.toContain('@loose —');
  expect(sys).not.toContain('Never started');
  expect(sys).toContain('Agents found that you cannot start yet: @loose (unrecorded). If you need one, ask the person to start it once with /subagent @name.');
  expect(systemOf(child.requests[0]!)).toContain(`${BLOCK}\n@job — Does the job`);
});

test('at most twenty lines; no block when no agent is trusted', async () => {
  const { model, rig } = rigFor('GO-L');
  for (let i = 0; i < 25; i++) project(rig, `a${String(i).padStart(2, '0')}`, doc('', 'GO-L x', `agent ${i}`));
  model.script([{ text: 'hi' }]);
  await rig.conv.send('hello');
  await rig.idle();
  const lines = systemOf(model.requests[0]!).split('\n').filter((l) => l.startsWith('@a'));
  expect(lines).toHaveLength(20);

  const other = rigFor('GO-M');
  project(other.rig, 'loose', doc('', 'GO-M x'), false);
  other.model.script([{ text: 'hi' }]);
  await other.rig.conv.send('hello');
  await other.rig.idle();
  expect(systemOf(other.model.requests[0]!)).not.toContain(BLOCK);
});

test('a kind that is not offered the subagent tool gets no block', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { kind: 'oneshot', ai: { backgroundFollowUp: false } });
  project(rig, 'job', doc('', 'x'));
  model.script([{ text: 'hi' }]);
  await rig.conv.send('hello');
  await rig.idle();
  expect(systemOf(model.requests[0]!)).not.toContain(BLOCK);
  expect(toolNames(model.requests[0]!)).not.toContain('subagent');
});

// ── an agent never starts itself
const toolAnswer = (req: { messages: { role: string; content?: unknown }[] }): string => String(req.messages.filter((m) => m.role === 'tool').at(-1)?.content ?? '');

test('a conversation running an agent does not list it, and its subagent call for it is refused for the model', async () => {
  const { model, child, rig } = rigFor('GO-X');
  project(rig, 'x', doc('', 'GO-X go', 'The X agent'));
  project(rig, 'other', doc('', 'GO-O go', 'The other agent'));
  child.script([{ tool: 'subagent', args: { agent: '@x' } }], [{ text: 'ok' }]);
  await call(rig, model, { agent: '@x' });
  await rig.until(() => child.requests.length === 2);
  await childDone(rig);
  expect(systemOf(child.requests[0]!)).not.toContain('@x — ');
  expect(systemOf(child.requests[0]!)).toContain('@other — The other agent');
  expect(toolAnswer(child.requests[1]!)).toContain('you are already running @x');
  expect(rig.journal().filter((e) => e.t === 'task-start').map((e) => e.label)).toEqual(['x']);
  // The session still lists and starts it.
  expect(systemOf(model.requests[0]!)).toContain('@x — The X agent');
});

test('a child of X running Y may start neither X nor Y', async () => {
  const model = new ScriptedModel();
  const x = model.when((req) => firstUser(req).includes('GO-X'));
  const y = model.when((req) => firstUser(req).includes('GO-Y'));
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false, subagentDepth: 3 } });
  project(rig, 'x', doc('', 'GO-X go', 'The X agent'));
  project(rig, 'y', doc('', 'GO-Y go', 'The Y agent'));
  project(rig, 'z', doc('', 'GO-Z go', 'The Z agent'));
  x.script([{ tool: 'subagent', args: { agent: '@y' } }], [{ hold: true }, { text: 'x done' }]);
  y.script([{ tool: 'subagent', args: { agent: '@x' } }, { tool: 'subagent', args: { agent: '@y' } }], [{ text: 'y done' }]);
  model.script([{ tool: 'subagent', args: { agent: '@x' } }], [{ text: 'Noted.' }]);
  await rig.conv.send('go');
  await rig.idle();
  await rig.until(() => y.requests.length === 2);
  const sys = systemOf(y.requests[0]!);
  expect(sys).not.toContain('@x — ');
  expect(sys).not.toContain('@y — ');
  expect(sys).toContain('@z — The Z agent');
  const answers = y.requests[1]!.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
  expect(answers[0]).toContain('you are already running @x');
  expect(answers[1]).toContain('you are already running @y');
  x.release();
  await childDone(rig);
});
