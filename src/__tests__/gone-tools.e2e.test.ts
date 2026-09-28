// A tool a plugin took away stays out for the rest of the run. A turn in flight fixed its
// list before, and a model that saw a name may call it later: the call never runs, and
// the model is told why the tool is gone — the plugin that removed it, or that the person
// disabled it — an error, never a "call again".
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { refreshToolRegistry } from '../loader/tools';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const PING = { type: 'function' as const, function: { name: 'guest_ping', description: 'Ping.', parameters: { type: 'object', properties: {} } } };
const ECHO = { type: 'function' as const, function: { name: 'guest_echo', description: 'Echo.', parameters: { type: 'object', properties: {} } } };

// What the model was sent as the result of the call with `id` in request `i`.
const resultOf = (model: ScriptedModel, i: number, name: string): string => {
  const msgs = model.requests[i]!.messages as Array<{ role: string; content?: unknown; tool_call_id?: string }>;
  const tool = msgs.filter((m) => m.role === 'tool').at(-1);
  expect(tool, `a result of ${name}`).toBeTruthy();
  return String(tool!.content);
};

test('a group tool the plugin dropped mid-turn answers that it is gone, and never runs', async () => {
  const model = new ScriptedModel();
  model.script([{ hold: true }, { tool: 'guest_ping', args: {} }], [{ text: 'done' }]);
  let ran = 0;
  const group = { id: 'guest', tools: [PING], exec: async () => { ran++; return 'pong'; } };
  let plugin: { tools?: unknown[] } | null = null;
  const ui = await bootApp(model, 100, 28, (make) => [(plugin = make('guest', { tools: [group] })) as never]);
  await ui.press('F');
  await ui.type('ping it');
  await ui.press('return');
  for (let i = 0; i < 50 && model.requests.length < 1; i++) await settle(1);
  plugin!.tools = [];
  refreshToolRegistry();
  model.release();
  for (let i = 0; i < 100 && model.requests.length < 2; i++) await settle(1);
  expect(resultOf(model, 1, 'guest_ping')).toContain('guest_ping is gone — guest removed it');
  expect(ran).toBe(0);
  ui.app.unmount();
});

test('an ai-tool whose plugin the person took out answers that it is gone, and never runs', async () => {
  const model = new ScriptedModel();
  model.script([{ hold: true }, { tool: 'guest_echo', args: {} }], [{ text: 'done' }]);
  let ran = 0;
  const ui = await bootApp(model, 100, 28, (make) => [make('guest', { aiTools: [{ ...ECHO, run: () => { ran++; return 'echo'; } }] }) as never]);
  await ui.press('F');
  await ui.type('echo it');
  await ui.press('return');
  for (let i = 0; i < 50 && model.requests.length < 1; i++) await settle(1);
  ui.tools.withhold!('guest', true);
  model.release();
  for (let i = 0; i < 100 && model.requests.length < 2; i++) await settle(1);
  expect(resultOf(model, 1, 'guest_echo')).toContain('guest_echo is gone — guest was disabled');
  expect(ran).toBe(0);
  ui.app.unmount();
});
