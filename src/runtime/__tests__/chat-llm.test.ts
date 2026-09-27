// The host's LLM service as a plugin reaches it (`services.chatLLM`): the same agent
// loop the chat runs, offered every tool in the registry. A caller that does not pass
// a `confirmWrite` of its own cannot ask the person, so each write the model calls is
// declined and never runs; a plugin that can ask passes its own and is asked.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel } from '../../__tests__/helpers/scripted';
import { makeFactory } from '../../loader/plugin';
import { assembleToolRegistry } from '../../loader/tools';
import { createServices } from '../services';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function setup() {
  process.env.LLM_TOKEN = 'scripted';
  const ran: string[] = [];
  const make = makeFactory({});
  const plugins = [make('t', { aiTools: [
    { type: 'function', function: { name: 't:save', description: 'save', parameters: { type: 'object', properties: {} } }, write: true, run: async () => { ran.push('save'); return 'saved'; } },
    { type: 'function', function: { name: 't:read', description: 'read', parameters: { type: 'object', properties: {} } }, run: async () => { ran.push('read'); return 'read it'; } },
  ] })];
  const memory = { file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-chatllm-')), 'memory.json') };
  const config: Record<string, unknown> = { ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all' }, memory };
  const tools = assembleToolRegistry({ plugins, config, repo: { list: async () => [] } as never });
  const services = createServices({ config, tools, onExit: () => {} });
  const model = new ScriptedModel();
  model.install();
  model.script([{ tool: 't:save', args: {} }, { tool: 't:read', args: {} }], [{ text: 'done' }]);
  const results = () => (model.requests.at(-1)!.messages as { role: string; content: unknown }[]).filter((m) => m.role === 'tool').map((m) => String(m.content));
  return { ran, services, results };
}

test('a plugin\'s chatLLM declines every write the model calls and runs the reads', async () => {
  const { ran, services, results } = setup();
  const res = await services.chatLLM([{ role: 'user', content: 'save it' }], {});
  expect(ran).toEqual(['read']);
  const [save, read] = results();
  expect(save).toStartWith('DECLINED:');
  expect(save).toContain('cannot ask the person');
  expect(read).toStartWith('OK:');
  expect(res.toolRuns.map((r) => [r.name, r.outcome])).toEqual([['t:save', 'declined'], ['t:read', 'ok']]);
});

test('a plugin that can ask passes its own confirmWrite, and a yes runs the write', async () => {
  const { ran, services } = setup();
  const asked: string[] = [];
  await services.chatLLM([{ role: 'user', content: 'save it' }], { confirmWrite: (name) => { asked.push(name); return true; } });
  expect(asked).toEqual(['t:save']);
  expect(ran).toEqual(['save', 'read']);
});
