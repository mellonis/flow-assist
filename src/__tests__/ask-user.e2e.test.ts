// `ask_user` end to end through the real TUI: the model calls the tool → the
// question block takes the input's place → key presses answer it → the answer
// reaches the model as the tool result. Only the network is faked.
import { afterEach, expect, test } from 'bun:test';
import { TestBackend, flush } from '@flowtty/core/testing';
import { loadPlugins } from '../loader/build';
import { assembleToolRegistry } from '../loader/tools';
import { renderApp } from '../runtime/app';
import { renderChatModal, renderHelp, renderLogModal, renderReminder } from '../views/modals';

const realFetch = globalThis.fetch;
// The plan is module-level state: leave none behind for the suites that follow.
afterEach(() => { globalThis.fetch = realFetch; });

const sse = (...chunks: unknown[]) =>
  new Response([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'].join(''), { headers: { 'content-type': 'text/event-stream' } });
const settle = async () => { for (let i = 0; i < 8; i++) { await flush(); await new Promise((r) => setTimeout(r, 5)); } };

test.each([[110, 40], [100, 22]])('the model asks, the person picks with the keyboard, the model gets the answer (%ix%i)', async (cols, rows) => {
  // The short screen carries a plan too: the question block must still show its
  // last row and its key hints — it used to be budgeted as a one-line input field
  // and lost "Other…" and the hint line below the frame.
  process.env.LLM_TOKEN = 't';
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    if (bodies.length === 1) {
      const args = JSON.stringify({ questions: [{ question: 'Rebase or merge?', header: 'Strategy', options: [{ label: 'rebase (Recommended)', description: 'Linear history' }, { label: 'merge', description: 'Keeps the branch shape' }] }] });
      return sse(
        // The plan is the chat's own now, so it is the MODEL that puts one there — in
        // the same round, before it asks.
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_plan', function: { name: 'todo', arguments: JSON.stringify({ action: 'set', todos: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] }) } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_ask', function: { name: 'ask_user', arguments: args } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      );
    }
    return sse({ choices: [{ delta: { content: 'Merging then.' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] });
  }) as typeof fetch;

  const config: Record<string, unknown> = { ai: { baseUrl: 'http://llm.test', model: 'm' } };
  const repo = { enabledPlugins: async () => [], list: async () => [] } as any;
  const renders = { chat: renderChatModal, help: renderHelp, log: renderLogModal, reminder: renderReminder };
  const plugins = await loadPlugins({ config, repo, renders: renders as any });
  const tools = assembleToolRegistry({ plugins, config, repo });
  const backend = new TestBackend(cols, rows);
  const handle = await renderApp(backend, { plugins, config, tools, onExit: () => {} });
  await settle();

  backend.press({ name: 'A', shift: true });
  await settle();
  backend.type('how should I integrate this branch');
  backend.press({ name: 'return' });
  await settle();

  // The question replaced the input field; nothing was answered for the person.
  expect(backend.lastFrame).toContain('Strategy — Rebase or merge?');
  expect(backend.lastFrame).toContain('1. rebase (Recommended)');
  expect(backend.lastFrame).toContain('Linear history');
  expect(backend.lastFrame).toContain('3. Other…');
  expect(backend.lastFrame).toContain('Esc dismiss');
  expect(bodies).toHaveLength(1);

  backend.press({ name: 'down' });
  backend.press({ name: 'return' });
  await settle();

  expect(bodies).toHaveLength(2);
  const toolResult = bodies[1].messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'call_ask');
  expect(toolResult).toMatchObject({ tool_call_id: 'call_ask' });
  expect(toolResult.content).toContain('Rebase or merge? → merge');
  expect(backend.lastFrame).toContain('Merging then.');
  expect(backend.lastFrame).not.toContain('Rebase or merge?');
  handle.unmount();
});
