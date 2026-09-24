// `ask_user` end to end through the real TUI: the model calls the tool → the
// question block takes the input's place → key presses answer it → the answer
// reaches the model as the tool result. Only the network is faked.
import { afterEach, expect, test } from 'bun:test';
import { TestBackend, flush } from '@flowtty/core/testing';
import { loadPlugins } from '../loader/build';
import { assembleToolRegistry } from '../loader/tools';
import { renderApp } from '../runtime/app';
import { renderChatModal, renderHelp, renderLogModal, renderReminder } from '../views/modals';
import { ScriptedModel, bootApp, settle as settleUi } from './helpers/scripted';

const realFetch = globalThis.fetch;
// The plan is module-level state: leave none behind for the suites that follow.
afterEach(() => { globalThis.fetch = realFetch; });

const sse = (...chunks: unknown[]) =>
  new Response([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'].join(''), { headers: { 'content-type': 'text/event-stream' } });
const settle = async () => { for (let i = 0; i < 8; i++) { await flush(); await new Promise((r) => setTimeout(r, 5)); } };

test.each([[110, 40, 'window'], [100, 22, 'window'], [100, 22, 'panel']] as const)('the model asks, the person picks with the keyboard, the model gets the answer (%ix%i, %s)', async (cols, rows, mode) => {
  // The short screen carries a plan too: the question block must still show its
  // last row and its key hints — budgeting it as a one-line input field instead
  // would lose "Other…" and the hint line below the frame. Docked at the bottom of 22
  // rows, the panel's 12 cannot hold it and growing it would leave the plugin less
  // than its least: the chat is a window until the question is answered.
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

  const config: Record<string, unknown> = { ai: { baseUrl: 'http://llm.test', model: 'm' }, plugins: { assistant: { mode } } };
  const repo = { enabledPlugins: async () => [], list: async () => [] } as any;
  const renders = { chat: renderChatModal, help: renderHelp, log: renderLogModal, reminder: renderReminder };
  const plugins = await loadPlugins({ config, repo, renders: renders as any });
  const tools = assembleToolRegistry({ plugins, config, repo });
  const backend = new TestBackend(cols, rows);
  const handle = await renderApp(backend, { plugins, config, tools, onExit: () => {} });
  await settle();

  backend.press({ name: 'F', shift: true });
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
  // Whole: the question's frame closes below its hint, inside the chat's own frame.
  const lines = backend.lastFrame.split('\n');
  const hintAt = lines.findIndex((l) => l.includes('Esc dismiss'));
  expect(lines[hintAt + 1]).toMatch(/╰─+╯/);
  expect(lines.slice(hintAt + 2).some((l) => /╰─+╯/.test(l))).toBe(true);

  backend.press({ name: 'down' });
  backend.press({ name: 'return' });
  await settle();

  expect(bodies).toHaveLength(2);
  const toolResult = bodies[1].messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'call_ask');
  expect(toolResult).toMatchObject({ tool_call_id: 'call_ask' });
  expect(toolResult.content).toContain('Rebase or merge? → merge');
  // Answered, the panel is docked again at its own 12 rows: the three-item plan gives
  // way to one row, so the field and the answer are on screen as in a window.
  expect(backend.lastFrame).toContain('Merging then.');
  if (mode === 'panel') {
    expect(backend.lastFrame.split('\n')[rows - 12]).toContain('╭─ ƒ Flow Assist');
    expect(backend.lastFrame).toContain('▸ plan 1/3 · one');
    expect(backend.lastFrame).toContain('Esc Esc collapse');
  }
  expect(backend.lastFrame).not.toContain('Rebase or merge?');
  handle.unmount();
});

test('typing starts the answer, the field takes a paste, and the model is sent the whole text', async () => {
  // Answering in one's own words meant walking to the "Other…" row first, and the
  // field there dropped a paste entirely — so a pasted path could not be an answer.
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'ask_user', args: { questions: [{ question: 'Which branch?', options: [{ label: 'master' }, { label: 'develop' }] }] } }],
    [{ text: 'Using it.' }],
  );
  const ui = await bootApp(model, 110, 30);
  await ui.press('F');
  await ui.type('which branch should I use?');
  await ui.press('return');
  await settleUi(15);
  expect(ui.backend.lastFrame).toContain('Which branch?');
  expect(ui.backend.lastFrame).toContain('type your own words');

  await ui.type('use ');
  expect(ui.backend.lastFrame).toContain('› use'); // the field opened on the first letter
  ui.backend.paste('feature/ABC-1\nplease');
  await settleUi(4);
  await ui.type(' now');
  await ui.press('return');
  await settleUi(20);

  expect(model.requests).toHaveLength(2);
  const result = (model.requests[1]!.messages as { role: string; content?: string }[]).find((m) => m.role === 'tool');
  // The paste went in whole — its line break a space, since the field is one line —
  // and it neither answered the question by itself nor fired a binding.
  expect(String(result?.content)).toContain('use feature/ABC-1 please now');
  ui.app.unmount();
});
