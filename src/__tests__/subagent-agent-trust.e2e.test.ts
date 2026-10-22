// Trust for agent files: a project agent's first start of new or changed content asks the
// person, the person's own files are recorded at their start, a plugin's follow the
// plugin; and an agent's children keep its tool groups. The real app on the scripted model.
import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Conversation } from '../assistant/conversation.ts';
import { scheduleChild } from '../assistant/child-schedule.ts';
import { agentHash, parseAgentFile, type Agent } from '../assistant/agent-file.ts';
import { agentChanged, agentTrusted, agentTrustPath, recordAgentStart } from '../assistant/agent-trust.ts';
import { ScriptedModel, bootApp, firstUser, settle } from './helpers/scripted';

const made: string[] = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.FLOW_ASSIST_MODEL_SHELL;
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const doc = (header: string, body: string, description = 'A test agent') => `---\ndescription: ${description}\n${header}---\n${body}\n`;
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const toolNames = (req: { tools?: unknown }): string[] => ((req.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name);

const BAND = { type: 'function' as const, function: { name: 'band_look', description: 'Looks at the band.', parameters: { type: 'object', properties: {} } } };
const OTHER = { type: 'function' as const, function: { name: 'other_look', description: 'Looks elsewhere.', parameters: { type: 'object', properties: {} } } };

const agentAt = (file: string, source: Agent['source'] = { kind: 'project' }): Agent => {
  const r = parseAgentFile(file, fs.readFileSync(file), source);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.agent;
};

async function chat(opts: { guests?: (make: any) => unknown[] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ag-trust-')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ag-trust-sessions-'));
  made.push(root, dir);
  fs.mkdirSync(path.join(root, '.git'));
  const model = new ScriptedModel();
  const groups = [
    { id: 'wb-band', tools: [BAND], exec: async () => 'band seen' },
    { id: 'other', tools: [OTHER], exec: async () => 'elsewhere' },
  ];
  const extra = { sessions: { dir }, shell: { roots: [root] }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false, subagentDepth: 4 } };
  const ui = await bootApp(model, 140, 40, (make) => (opts.guests ? opts.guests(make) : [make('guest', { tools: groups })]) as never[], extra, { toastMs: 10_000, startDir: root });
  await ui.press('F');
  return { root, model, ui, agents: path.join(root, '.flow-assist', 'agents') };
}

// ── project files
test('a project agent\'s first start asks with what it will be allowed; yes records and starts; the same content asks nothing', async () => {
  const { agents, model, ui } = await chat();
  const child = model.when((req) => firstUser(req).includes('TRUST-A'));
  const file = path.join(agents, 'job.md');
  write(file, doc('params: ticket\ntools: wb-band\nauto: all\n', 'TRUST-A {{ticket}}', 'Does the job'));
  child.script([{ text: 'one' }], [{ text: 'two' }]);
  await ask(ui, '/subagent @job T-1');
  await settleUntil(() => frameOf(ui).includes('(y/n)'));
  const f = frameOf(ui);
  expect(f).toContain('@job is a project file you have not started');
  expect(f).toContain('Does the job');
  expect(f).toContain(file);
  expect(f).toContain('tool groups: core, wb-band');
  expect(f).toContain('auto mode: reads');
  expect(f).toContain('<ticket>');
  expect(child.requests.length).toBe(0);
  expect(agentTrusted(agentAt(file))).toBe(false);
  await ui.press('y');
  await settleUntil(() => child.requests.length === 1);
  expect(firstUser(child.requests[0]!)).toBe('TRUST-A T-1');
  expect(agentTrusted(agentAt(file))).toBe(true);
  await settleUntil(() => frameOf(ui).includes('one'));
  await ask(ui, '/subagent @job T-2');
  await settleUntil(() => child.requests.length === 2);
  expect(frameOf(ui)).not.toContain('(y/n)');
  ui.app.unmount();
});

test('no starts nothing and says so; the file stays untrusted', async () => {
  const { agents, model, ui } = await chat();
  const child = model.when((req) => firstUser(req).includes('TRUST-B'));
  const file = path.join(agents, 'job.md');
  write(file, doc('', 'TRUST-B go'));
  child.script([{ text: 'x' }]);
  await ask(ui, '/subagent @job');
  await settleUntil(() => frameOf(ui).includes('(y/n)'));
  await ui.press('n');
  await settleUntil(() => frameOf(ui).includes('@job was not started'));
  expect(frameOf(ui)).toContain('@job was not started: its file is not trusted.');
  await settle(20);
  expect(child.requests.length).toBe(0);
  expect(agentTrusted(agentAt(file))).toBe(false);
  ui.app.unmount();
});

test('an edited file asks again and says it changed', async () => {
  const { agents, model, ui } = await chat();
  const child = model.when((req) => firstUser(req).includes('TRUST-C'));
  const file = path.join(agents, 'job.md');
  write(file, doc('', 'TRUST-C one'));
  child.script([{ text: 'a' }], [{ text: 'b' }]);
  await ask(ui, '/subagent @job');
  await settleUntil(() => frameOf(ui).includes('(y/n)'));
  await ui.press('y');
  await settleUntil(() => child.requests.length === 1);
  await settleUntil(() => frameOf(ui).includes('a'));
  write(file, doc('', 'TRUST-C two'));
  expect(agentChanged(agentAt(file))).toBe(true);
  await ask(ui, '/subagent @job');
  await settleUntil(() => frameOf(ui).includes('changed since you last started it'));
  expect(frameOf(ui)).toContain('@job changed since you last started it');
  expect(child.requests.length).toBe(1);
  await ui.press('y');
  await settleUntil(() => child.requests.length === 2);
  expect(agentTrusted(agentAt(file))).toBe(true);
  ui.app.unmount();
});

// ── the person's and a plugin's files
test('a person\'s file is recorded at its start without a question; an edit is untrusted until started again', async () => {
  const { model, ui } = await chat();
  const child = model.when((req) => firstUser(req).includes('TRUST-D'));
  const { hostStateDir } = await import('../config/load.ts');
  const file = path.join(hostStateDir(), 'agents', 'mine.md');
  write(file, doc('', 'TRUST-D one'));
  made.push(file);
  const mine = () => agentAt(file, { kind: 'person' });
  child.script([{ text: 'a' }], [{ text: 'b' }]);
  expect(agentTrusted(mine())).toBe(false);
  await ask(ui, '/subagent @mine');
  await settleUntil(() => child.requests.length === 1);
  expect(frameOf(ui)).not.toContain('(y/n)');
  expect(agentTrusted(mine())).toBe(true);
  write(file, doc('', 'TRUST-D two'));
  expect(agentTrusted(mine())).toBe(false);
  await settleUntil(() => frameOf(ui).includes('a'));
  await ask(ui, '/subagent @mine');
  await settleUntil(() => child.requests.length === 2);
  expect(frameOf(ui)).not.toContain('(y/n)');
  expect(agentTrusted(mine())).toBe(true);
  ui.app.unmount();
});

test('a plugin\'s file starts with no question and no record, and is trusted', async () => {
  const plug = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ag-trust-plug-')));
  made.push(plug);
  write(path.join(plug, 'manifest.json'), JSON.stringify({ agents: ['a.md'] }));
  write(path.join(plug, 'a.md'), doc('', 'TRUST-E go'));
  const { model, ui } = await chat({ guests: (make) => [Object.assign(make('agentplug', { name: 'agentplug' }), { dir: plug })] });
  const child = model.when((req) => firstUser(req).includes('TRUST-E'));
  child.script([{ text: 'x' }]);
  const before = fs.existsSync(agentTrustPath()) ? fs.readFileSync(agentTrustPath(), 'utf8') : null;
  await ask(ui, '/subagent @agentplug/a');
  await settleUntil(() => child.requests.length === 1);
  expect(frameOf(ui)).not.toContain('(y/n)');
  expect(agentTrusted(agentAt(path.join(plug, 'a.md'), { kind: 'plugin', plugin: 'agentplug' }))).toBe(true);
  expect(fs.existsSync(agentTrustPath()) ? fs.readFileSync(agentTrustPath(), 'utf8') : null).toBe(before);
  ui.app.unmount();
});

// ── the record
test('the record is written only by the person: a model-shell process writes none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ag-rec-'));
  made.push(dir);
  const file = path.join(dir, 'x.md');
  write(file, doc('', 'body'));
  const agent = agentAt(file);
  process.env.FLOW_ASSIST_MODEL_SHELL = '1';
  expect(recordAgentStart(agent)).toBe(false);
  delete process.env.FLOW_ASSIST_MODEL_SHELL;
  expect(agentTrusted(agent)).toBe(false);
  expect(recordAgentStart(agent)).toBe(true);
  expect(agentTrusted(agent)).toBe(true);
  expect(fs.statSync(agentTrustPath()).mode & 0o777).toBe(0o600);
  expect(agent.hash).toBe(agentHash(fs.readFileSync(file)));
});

test('an unreadable record trusts nothing and is kept beside the new one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ag-rec-'));
  made.push(dir);
  const file = path.join(dir, 'y.md');
  write(file, doc('', 'body'));
  const agent = agentAt(file);
  recordAgentStart(agent);
  fs.writeFileSync(agentTrustPath(), '{ not json');
  expect(agentTrusted(agent)).toBe(false);
  expect(recordAgentStart(agent)).toBe(true);
  expect(agentTrusted(agent)).toBe(true);
  expect(fs.readdirSync(path.dirname(agentTrustPath())).some((n) => n.startsWith('agents.accepted.json.unreadable-'))).toBe(true);
});

// ── the children keep the tool groups
test('a task an agent starts through the subagent tool, and a grandchild, get the agent\'s tool groups', async () => {
  const { agents, model, ui } = await chat();
  const file = path.join(agents, 'job.md');
  write(file, doc('tools: wb-band\n', 'KIDS-A go'));
  recordAgentStart(agentAt(file));
  const top = model.when((req) => firstUser(req).includes('KIDS-A'));
  const task = model.when((req) => firstUser(req).includes('KIDS-TASK'));
  const grand = model.when((req) => firstUser(req).includes('KIDS-GRAND'));
  top.script([{ tool: 'subagent', args: { task: 'KIDS-TASK do', label: 'kid' } }], [{ hold: true }, { text: 'done' }]);
  task.script([{ tool: 'subagent', args: { task: 'KIDS-GRAND do', label: 'grandkid' } }], [{ hold: true }, { text: 'task done' }]);
  grand.script([{ text: 'grand done' }]);
  await ask(ui, '/subagent @job');
  await settleUntil(() => task.requests.length >= 1 && grand.requests.length >= 1);
  for (const r of [task.requests[0]!, grand.requests[0]!]) {
    const names = toolNames(r);
    expect(names).toContain('band_look');
    expect(names).toContain('datetime');
    expect(names).not.toContain('other_look');
    expect(names).not.toContain('run_command');
  }
  ui.app.unmount();
});

test('a child that names its own tool groups gets the intersection with its starter\'s', async () => {
  const { agents, model, ui } = await chat();
  const file = path.join(agents, 'job.md');
  write(file, doc('tools: wb-band, other\n', 'KIDS-B go'));
  recordAgentStart(agentAt(file));
  const top = model.when((req) => firstUser(req).includes('KIDS-B'));
  const inner = model.when((req) => firstUser(req).includes('KIDS-INNER'));
  top.script([{ hold: true }, { text: 'idle' }]);
  inner.script([{ text: 'ok' }]);
  const spy = spyOn(Conversation.prototype, 'startChild');
  await ask(ui, '/subagent @job');
  await settleUntil(() => top.requests.length === 1);
  const parent = spy.mock.results.map((r) => r.value as { child?: Conversation }).find((r) => r.child)!.child!;
  const out = scheduleChild(
    { kind: 'subagent', label: 'inner', prompt: 'KIDS-INNER go', by: 'person', toolGroups: ['wb-band', 'third'] },
    0,
    { startChild: (s) => parent.startChild(s, 'j'), slots: parent.deps.children!, showMessage() {}, pushLog() {}, notify() {} },
  );
  expect('child' in out && out.child.toolGroups).toEqual(['wb-band']);
  await settleUntil(() => inner.requests.length === 1);
  const names = toolNames(inner.requests[0]!);
  expect(names).toContain('band_look');
  expect(names).not.toContain('other_look');
  ui.app.unmount();
});
