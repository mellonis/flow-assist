import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { agentsBlock, AGENT_DESCRIPTION_MAX } from '../agent-model.ts';
import { agentTrustPath } from '../agent-trust.ts';
import type { FoundAgent } from '../agent-find.ts';

afterEach(() => { fs.rmSync(agentTrustPath(), { force: true }); });

const agent = (name: string, description: string, kind: 'project' | 'plugin' = 'plugin'): FoundAgent => ({
  id: name, name, description, params: [], tools: null, auto: 'ask', body: 'b', path: path.join('/x', `${name}.md`),
  source: kind === 'plugin' ? { kind: 'plugin', plugin: 'p' } : { kind: 'project' }, hash: 'h',
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
