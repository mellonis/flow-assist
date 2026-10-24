// `/subagent @<name> <arguments>`: the arguments, the questions for what is missing, the
// start as a staying subagent, the cap on its auto mode, its tool groups and what the
// journal keeps. The real app on the scripted model.
import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Conversation } from '../assistant/conversation.ts';
import { exportMarkdown, readJournal, type JournalEvent } from '../assistant/journal.ts';
import { agentHash } from '../assistant/agent-file.ts';
import { recordAgentStart } from '../assistant/agent-trust.ts';
import { refreshToolRegistry } from '../loader/tools.ts';
import { hostStateDir } from '../config/load.ts';
import { ScriptedModel, bootApp, firstUser, handoff, settle } from './helpers/scripted';
import { listTree } from './helpers/session-files';

const made: string[] = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const doc = (header: string, body: string) => `---\ndescription: A test agent\n${header}---\n${body}\n`;
// The files these tests start are project files the person has started before: written
// with their trust recorded, so a start asks nothing (the trust question has its own file).
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  recordAgentStart({ path: file, source: { kind: 'project' }, hash: agentHash(text) });
};
type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const toolNames = (req: { tools?: unknown }): string[] => ((req.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name);

const BAND = { type: 'function' as const, function: { name: 'band_look', description: 'Looks at the band.', parameters: { type: 'object', properties: {} } } };
const OTHER = { type: 'function' as const, function: { name: 'other_look', description: 'Looks elsewhere.', parameters: { type: 'object', properties: {} } } };
const LATE = { type: 'function' as const, function: { name: 'late_look', description: 'Arrives late.', parameters: { type: 'object', properties: {} } } };

// A booted chat in a git project under a shell root. The agent files are written by the
// test; `mark` tells the child's requests from the session's by its first user message.
async function chat(mark: string, opts: { agents?: Record<string, unknown>; guests?: boolean; nested?: ScriptedModel[] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ag-start-')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ag-sessions-'));
  made.push(root, dir);
  fs.mkdirSync(path.join(root, '.git'));
  const model = new ScriptedModel();
  const child = model.when((req) => firstUser(req).includes(mark));
  const groups: { id: string; tools: unknown[]; exec: (name: string, args: unknown, ctx: Record<string, unknown>) => Promise<string> }[] = [
    { id: 'notes', tools: [BAND], exec: async (_n, _a, ctx) => {
      const llm = (ctx as { chatLLM?: (m: unknown[], o: object) => Promise<unknown> }).chatLLM;
      if (llm) await llm([{ role: 'user', content: 'NESTED-Q' }], {});
      return 'band seen';
    } },
    { id: 'other', tools: [OTHER], exec: async () => 'elsewhere' },
  ];
  let plugin: { tools?: unknown[] } | null = null;
  const extra = { sessions: { dir }, shell: { roots: [root] }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false }, ...(opts.agents ? { agents: opts.agents } : {}) };
  const ui = await bootApp(model, 140, 40, (make) => [(plugin = make('guest', { tools: groups })) as never], extra, { toastMs: 10_000, startDir: root });
  await ui.press('F');
  const agents = path.join(root, '.flow-assist', 'agents');
  return { root, dir, model, child, ui, agents, groups, plugin: () => plugin! };
}

// ── arguments
test('positional values fill the parameters in the declared order; an optional one left over is empty', async () => {
  const { agents, child, ui } = await chat('POS-A');
  write(path.join(agents, 'job.md'), doc('params: ticket, branch?\n', 'POS-A ticket={{ticket}} branch=[{{branch}}]'));
  child.script([{ text: 'ok' }], [{ text: 'ok' }]);
  await ask(ui, '/subagent @job T-1');
  await settleUntil(() => child.requests.length === 1);
  expect(firstUser(child.requests[0]!)).toBe('POS-A ticket=T-1 branch=[]');
  await ask(ui, '/subagent @job T-2 feature');
  await settleUntil(() => child.requests.length === 2);
  expect(firstUser(child.requests[1]!)).toBe('POS-A ticket=T-2 branch=[feature]');
  ui.app.unmount();
});

test('the last parameter takes the rest of the line, spaces and line break kept', async () => {
  const { agents, child, ui } = await chat('REST-A');
  write(path.join(agents, 'job.md'), doc('params: ticket, text\n', 'REST-A {{ticket}}|{{text}}'));
  child.script([{ text: 'ok' }]);
  await ui.type('/subagent @job T-1 fix  the export');
  ui.backend.press({ name: 'return', shift: true });
  await ui.type('second line');
  await ui.press('return');
  await settleUntil(() => child.requests.length === 1);
  expect(firstUser(child.requests[0]!)).toBe('REST-A T-1|fix  the export\nsecond line');
  ui.app.unmount();
});

test('name=value pairs come first, a value one word or "quoted", positional values fill what is left', async () => {
  const { agents, child, ui } = await chat('NAMED-A');
  write(path.join(agents, 'job.md'), doc('params: ticket, branch, note?\n', 'NAMED-A {{ticket}}|{{branch}}|{{note}}'));
  child.script([{ text: 'ok' }], [{ text: 'ok' }]);
  await ask(ui, '/subagent @job branch="feat x" T-5');
  await settleUntil(() => child.requests.length === 1);
  expect(firstUser(child.requests[0]!)).toBe('NAMED-A T-5|feat x|');
  await ask(ui, '/subagent @job note=hello ticket=T-6 branch=b');
  await settleUntil(() => child.requests.length === 2);
  expect(firstUser(child.requests[1]!)).toBe('NAMED-A T-6|b|hello');
  ui.app.unmount();
});

test('an unknown name= and a value with no parameter left are refusals: nothing starts, the line stays', async () => {
  const { agents, child, model, ui } = await chat('REFUSE-A');
  write(path.join(agents, 'job.md'), doc('params: a, b\n', 'REFUSE-A {{a}} {{b}}'));
  await ask(ui, '/subagent @job nope=1 x y');
  await settleUntil(() => frameOf(ui).includes('no parameter «nope»'));
  expect(frameOf(ui)).toContain('/subagent @job: no parameter «nope»');
  expect(frameOf(ui)).toContain('/subagent @job nope=1 x y');
  for (let i = 0; i < '/subagent @job nope=1 x y'.length; i++) ui.backend.press({ name: 'backspace' });
  await settle();
  await ask(ui, '/subagent @job b=1 one two');
  await settleUntil(() => frameOf(ui).includes('too many values'));
  expect(frameOf(ui)).toContain('/subagent @job: too many values');
  await settle(10);
  expect(child.requests).toHaveLength(0);
  expect(model.requests).toHaveLength(0);
  ui.app.unmount();
});

// ── missing parameters
test('a missing required parameter is asked in a block titled @name: parameter; its answer fills the prompt and the start happens', async () => {
  const { agents, child, ui } = await chat('ASK-A');
  write(path.join(agents, 'job.md'), doc('params: ticket, branch\n', 'ASK-A {{ticket}}|{{branch}}'));
  child.script([{ text: 'ok' }]);
  await ask(ui, '/subagent @job T-1');
  await settleUntil(() => frameOf(ui).includes('@job: branch'));
  expect(frameOf(ui)).toContain('@job: branch');
  expect(child.requests).toHaveLength(0);
  await ask(ui, 'main');
  await settleUntil(() => child.requests.length === 1);
  expect(firstUser(child.requests[0]!)).toBe('ASK-A T-1|main');
  ui.app.unmount();
});

test('two missing parameters are asked one after the other, in the declared order', async () => {
  const { agents, child, ui } = await chat('ASK-B');
  write(path.join(agents, 'job.md'), doc('params: ticket, branch\n', 'ASK-B {{ticket}}|{{branch}}'));
  child.script([{ text: 'ok' }]);
  await ask(ui, '/subagent @job');
  await settleUntil(() => frameOf(ui).includes('@job: ticket'));
  expect(frameOf(ui)).not.toContain('@job: branch');
  await ask(ui, 'T-9');
  await settleUntil(() => frameOf(ui).includes('@job: branch'));
  expect(frameOf(ui)).not.toContain('@job: ticket');
  await ask(ui, 'dev');
  await settleUntil(() => child.requests.length === 1);
  expect(firstUser(child.requests[0]!)).toBe('ASK-B T-9|dev');
  ui.app.unmount();
});

test('Esc on the block cancels the start and puts the typed line back in the field', async () => {
  const { agents, child, model, ui } = await chat('ASK-C');
  write(path.join(agents, 'job.md'), doc('params: ticket, branch\n', 'ASK-C {{ticket}}|{{branch}}'));
  await ask(ui, '/subagent @job T-1');
  await settleUntil(() => frameOf(ui).includes('@job: branch'));
  await ui.press('escape');
  await settleUntil(() => !frameOf(ui).includes('@job: branch'));
  expect(frameOf(ui)).toContain('/subagent @job T-1');
  await settle(10);
  expect(child.requests).toHaveLength(0);
  expect(model.requests).toHaveLength(0);
  ui.app.unmount();
});

// ── the start
test('the child receives the filled prompt, is labeled by the agent\'s id, and stays after its answer; a second start is deduplicated', async () => {
  const { agents, child, ui } = await chat('START-A');
  write(path.join(agents, 'job.md'), doc('params: ticket\n', 'START-A {{ticket}}'));
  child.script([{ text: 'first answer' }], [{ hold: true }, { text: 'second answer' }]);
  await ask(ui, '/subagent @job T-1');
  await settleUntil(() => frameOf(ui).includes('subagent «job» started'));
  await settleUntil(() => frameOf(ui).includes('first answer'));
  expect(firstUser(child.requests[0]!)).toBe('START-A T-1');
  expect(String((child.requests[0]!.messages as Array<{ role: string; content: string }>)[0]!.content)).toContain("The person's task: START-A T-1");
  await ask(ui, '/subagent');
  await settleUntil(() => /1 · job · idle/.test(frameOf(ui)));
  expect(frameOf(ui)).toMatch(/1 · job · idle/);
  await ask(ui, '/subagent @job T-2');
  await settleUntil(() => child.requests.length === 2);
  await ask(ui, '/subagent');
  await settleUntil(() => /job-2 · working/.test(frameOf(ui)));
  expect(frameOf(ui)).toMatch(/2 · job-2 · working/);
  ui.app.unmount();
});

test('--auto with an agent is refused; --with-context hands the summary over as it does for a prompt', async () => {
  const { agents, child, model, ui } = await chat('FLAG-A');
  write(path.join(agents, 'job.md'), doc('params: ticket\n', 'FLAG-A {{ticket}}'));
  await ask(ui, '/subagent @job --auto T-1');
  await settleUntil(() => frameOf(ui).includes('the agent\'s file says what it may do'));
  expect(frameOf(ui)).toContain('the agent\'s file says what it may do');
  expect(child.requests).toHaveLength(0);
  for (let i = 0; i < '/subagent @job --auto T-1'.length; i++) ui.backend.press({ name: 'backspace' });
  await settle();
  child.script([{ text: 'used it' }]);
  model.script([{ text: 'Sure.' }], [{ text: handoff('SUMMARY-MARK the goal') }]);
  await ask(ui, 'an earlier question');
  await settleUntil(() => frameOf(ui).includes('Sure.'));
  await ask(ui, '/compact');
  await settleUntil(() => frameOf(ui).includes('── compacted'));
  await ask(ui, '/subagent @job --with-context T-1');
  await settleUntil(() => child.requests.length === 1);
  expect(JSON.stringify(child.requests[0])).toContain('SUMMARY-MARK');
  expect(firstUser(child.requests[0]!)).toBe('FLAG-A T-1');
  ui.app.unmount();
});

// ── the cap
async function modeOf(file: string | null, maxAuto: string | null): Promise<string[]> {
  const modes: string[] = [];
  const spy = spyOn(Conversation.prototype, 'setAutoMode').mockImplementation(function (this: Conversation, mode: string) { if (this.parent) modes.push(mode); });
  try {
    const { agents, child, ui } = await chat('CAP-A', maxAuto ? { agents: { maxAuto } } : {});
    write(path.join(agents, 'job.md'), doc(file ? `auto: ${file}\n` : '', 'CAP-A go'));
    child.script([{ text: 'ok' }]);
    await ask(ui, '/subagent @job');
    await settleUntil(() => child.requests.length === 1);
    ui.app.unmount();
  } finally { spy.mockRestore(); }
  return modes;
}

test('the child\'s auto mode is the lower of the file\'s auto and agents.maxAuto (default reads)', async () => {
  expect(await modeOf('all', null)).toEqual(['reads']);
  expect(await modeOf('all', 'all')).toEqual(['all']);
  expect(await modeOf('reads', 'ask')).toEqual([]);
  expect(await modeOf('reads', 'all')).toEqual(['reads']);
  expect(await modeOf(null, 'all')).toEqual([]);
});

// ── the tools
const group = (g: string) => `tools: ${g}\n`;

test('tools: names the groups; the child\'s request lists the core group and those only', async () => {
  const { agents, child, ui } = await chat('TOOLS-A');
  write(path.join(agents, 'job.md'), doc(group('notes'), 'TOOLS-A go'));
  child.script([{ text: 'ok' }]);
  await ask(ui, '/subagent @job');
  await settleUntil(() => child.requests.length === 1);
  const names = toolNames(child.requests[0]!);
  expect(names).toContain('band_look');
  expect(names).toContain('datetime');
  expect(names).not.toContain('other_look');
  expect(names).not.toContain('run_command');
  ui.app.unmount();
});

test('with tools omitted the child gets every group, as a /subagent prompt does', async () => {
  const { agents, child, ui } = await chat('TOOLS-B');
  write(path.join(agents, 'job.md'), doc('', 'TOOLS-B go'));
  child.script([{ text: 'ok' }]);
  await ask(ui, '/subagent @job');
  await settleUntil(() => child.requests.length === 1);
  const names = toolNames(child.requests[0]!);
  expect(names).toEqual(expect.arrayContaining(['band_look', 'other_look', 'run_command', 'datetime']));
  ui.app.unmount();
});

test('a group that joins mid-run is excluded unless named', async () => {
  const { agents, child, groups, plugin, ui } = await chat('TOOLS-C');
  write(path.join(agents, 'job.md'), doc(group('notes'), 'TOOLS-C go'));
  child.script([{ tool: 'band_look', args: {} }, { hold: true }], [{ text: 'ok' }]);
  await ask(ui, '/subagent @job');
  await settleUntil(() => child.requests.length === 1);
  plugin().tools = [...groups, { id: 'late', tools: [LATE], exec: async () => 'late' }];
  refreshToolRegistry();
  child.release();
  await settleUntil(() => child.requests.length === 2);
  const names = toolNames(child.requests[1]!);
  expect(names).toContain('band_look');
  expect(names).not.toContain('late_look');
  expect(names).not.toContain('other_look');
  ui.app.unmount();
});

test('a nested run the child\'s tool starts gets the same restriction', async () => {
  const { agents, child, model, ui } = await chat('TOOLS-D');
  write(path.join(agents, 'job.md'), doc(group('notes'), 'TOOLS-D go'));
  const nested = model.when((req) => firstUser(req).includes('NESTED-Q'));
  nested.script([{ text: 'nested answer' }]);
  child.script([{ tool: 'band_look', args: {} }], [{ text: 'ok' }]);
  await ask(ui, '/subagent @job');
  await settleUntil(() => nested.requests.length === 1);
  const names = toolNames(nested.requests[0]!);
  expect(names).toContain('band_look');
  expect(names).toContain('datetime');
  expect(names).not.toContain('other_look');
  expect(names).not.toContain('run_command');
  ui.app.unmount();
});

test('a named group that is not loaded is reported in a note and the agent starts without it', async () => {
  const { agents, child, ui } = await chat('TOOLS-E');
  write(path.join(agents, 'job.md'), doc('tools: notes, gitlab\n', 'TOOLS-E go'));
  child.script([{ text: 'ok' }]);
  await ask(ui, '/subagent @job');
  await settleUntil(() => child.requests.length === 1);
  await settleUntil(() => frameOf(ui).includes('group "gitlab" is not loaded'));
  expect(frameOf(ui)).toContain('@job: group "gitlab" is not loaded — starting without it');
  expect(toolNames(child.requests[0]!)).toContain('band_look');
  ui.app.unmount();
});

// ── the journal
test('the start lines of the parent\'s journal and the child\'s file carry the agent, its source, path and hash; /export shows @id in the fold', async () => {
  const { agents, dir, child, ui } = await chat('JOURNAL-A');
  const file = path.join(agents, 'job.md');
  const text = doc('', 'JOURNAL-A go');
  write(file, text);
  child.script([{ text: 'ok' }]);
  await ask(ui, '/subagent @job');
  await settleUntil(() => child.requests.length === 1);
  await settleUntil(() => frameOf(ui).includes('ok'));
  const files = listTree(dir).filter((n) => n.endsWith('.log.jsonl'));
  const sub = files.find((n) => n.includes('.sub'))!;
  const parent = files.find((n) => !n.includes('.sub'))!;
  expect(sub).toBeDefined();
  const events = readJournal(path.join(dir, parent)) as JournalEvent[];
  const record = { agent: 'job', source: 'project', path: file, hash: agentHash(text) };
  expect(events.find((e) => e.t === 'subagent' && e.event === 'start')).toMatchObject(record);
  const own = readJournal(path.join(dir, sub)) as JournalEvent[];
  expect(own[0]).toMatchObject({ t: 'start', label: 'job', ...record });
  const md = exportMarkdown(events, { title: 't', id: 'x', child: () => own });
  expect(md).toContain('<summary>@job · job · ');
  void hostStateDir;
  ui.app.unmount();
});
