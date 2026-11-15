import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { agentsBlock, AGENT_DESCRIPTION_MAX, planAgentStart } from '../agent-model.ts';
import { agentKey, agentTrustPath, agentTrustRequest } from '../agent-trust.ts';
import type { FoundAgent } from '../agent-find.ts';

afterEach(() => { fs.rmSync(agentTrustPath(), { force: true }); });

const agent = (name: string, description: string, kind: 'project' | 'plugin' = 'plugin', model?: string): FoundAgent => ({
  id: name, name, description, params: [], tools: null, skills: [], auto: 'ask', body: 'b', path: path.join('/x', `${name}.md`),
  source: kind === 'plugin' ? { kind: 'plugin', plugin: 'p' } : { kind: 'project' }, hash: 'h', ...(model ? { model } : {}),
});

test('a long description is clipped to one line of at most 200 characters with an ellipsis', () => {
  const block = agentsBlock({ agents: [agent('a', `first line\n${'x'.repeat(500)}`)] });
  const line = block.split('\n')[1]!;
  expect(line.startsWith('@a — first line xxx')).toBe(true);
  expect(line.endsWith('…')).toBe(true);
  expect(line.length).toBe('@a — '.length + AGENT_DESCRIPTION_MAX);
  expect(agentsBlock({ agents: [agent('b', 'short')] })).toContain('@b — short');
});

test('the trust record is read once for the whole block, not once per agent', () => {
  const real = fs.readFileSync;
  let reads = 0;
  const spy = spyOn(fs, 'readFileSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
    if (String(p) === agentTrustPath()) reads++;
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readFileSync);
  try {
    agentsBlock({ agents: [agent('a', 'd', 'project'), agent('b', 'd', 'project'), agent('c', 'd', 'project')] });
  } finally { spy.mockRestore(); }
  expect(reads).toBe(1);
});

test('agents that are not recorded are named in one line, by name only, capped at twenty; a running one is left out', () => {
  const many = Array.from({ length: 25 }, (_, i) => agent(`p${String(i).padStart(2, '0')}`, 'SECRET description', 'project'));
  const block = agentsBlock({ agents: [agent('ok', 'fine'), ...many] }, (a) => (a.id === 'ok' ? 'recorded' : a.id === 'p01' ? 'changed' : 'unrecorded'));
  const [listed, held] = block.split('\n').slice(-2) as [string, string];
  expect(block).toContain('@ok — fine');
  expect(listed).toBe('@ok — fine');
  expect(held.startsWith('Agents found that you cannot start yet: @p00 (unrecorded), @p01 (changed since recorded), @p02 (unrecorded)')).toBe(true);
  expect(held).toContain('@p19 (unrecorded). If you need one, ask the person to start it once with /subagent @name.');
  expect(held).not.toContain('@p20');
  expect(block).not.toContain('SECRET');
  const running = new Set([agentKey(many[0]!)]);
  expect(agentsBlock({ agents: [many[0]!] }, () => 'unrecorded', running)).toBe('');
  expect(agentsBlock({ agents: [many[0]!] }, () => 'unrecorded')).toContain('@p00 (unrecorded)');
});

// ── a start resolves the role
const AI = {
  model: 'default-model',
  models: { 'small-model': { contextWindow: 256_000 }, 'big-model': { contextWindow: 512_000 } },
  roles: { fast: 'small-model', deep: 'big-model' },
};

// The plan a start makes for one agent file; `call.model` is the role the tool call named.
const okPlan = (a: FoundAgent, call: { model?: string } = {}) => {
  const plan = planAgentStart({
    found: () => ({ agents: [a], shadowed: [], failed: [], errors: [], projectRead: true, projectDir: null, personDir: '/x' }),
    cap: () => 'all',
    loaded: () => new Set<string>(),
    labels: () => [],
    ai: () => AI,
  }, { agent: a.id, args: undefined, prompt: '', ...call });
  if (!plan.ok) throw new Error(`plan refused: ${plan.message}`);
  return plan;
};

test('the role the agent file names is the model the child runs', () => {
  const plan = okPlan(agent('a', 'd', 'plugin', 'fast'));
  expect(plan.model).toBe('small-model');
  expect(plan.roleNote).toBe('');
});

test('the role the call names wins over the file\'s', () => {
  const plan = okPlan(agent('a', 'd', 'plugin', 'fast'), { model: 'deep' });
  expect(plan.model).toBe('big-model');
  expect(plan.roleNote).toBe('');
});

test('a role nothing defines is one note and no model', () => {
  const plan = okPlan(agent('a', 'd', 'plugin', 'nope'));
  expect(plan.model).toBeUndefined();
  expect(plan.roleNote).toBe('role "nope" is not defined (ai.roles) — using the conversation\'s model');
});

test('a model id in the file is not a role: the same one note', () => {
  const plan = okPlan(agent('a', 'd', 'plugin', 'small-model'));
  expect(plan.model).toBeUndefined();
  expect(plan.roleNote).toContain('role "small-model" is not defined');
});

test('no role anywhere: no model and no note', () => {
  const plan = okPlan(agent('a', 'd'));
  expect('model' in plan).toBe(false);
  expect(plan.roleNote).toBe('');
});

test('the trust question names the role the file gives the work, and nothing when it names none', () => {
  expect(agentTrustRequest(agent('a', 'd', 'project', 'fast'), 'a', 'reads', false).line).toContain('model: fast (a role from ai.roles)');
  expect(agentTrustRequest(agent('b', 'd', 'project'), 'b', 'reads', false).line).not.toContain('model: ');
});
