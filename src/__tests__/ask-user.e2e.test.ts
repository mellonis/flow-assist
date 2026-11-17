// `ask_user` end to end through the real TUI: the model calls the tool → the
// question block takes the input's place → key presses answer it → the answer
// reaches the model as the tool result. Only the network is faked.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

// The style of the cell where `text` starts (plus `offset` cells) — the caret cell is
// drawn inverse, so this is how a test tells where the field's caret rests.
function styleAt(backend: { lastBuffer: { get(x: number, y: number): { style: { inverse?: boolean } } } | null; lastFrame: string }, text: string, offset = 0) {
  const rows = backend.lastFrame.split('\n');
  const y = rows.findIndex((r) => r.includes(text));
  if (y < 0) throw new Error(`"${text}" is not on screen:\n${backend.lastFrame}`);
  return backend.lastBuffer!.get(rows[y]!.indexOf(text) + offset, y).style;
}

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
    expect(backend.lastFrame).toContain('▸ plan · ☐ one');
    expect(backend.lastFrame).toContain('Esc Esc collapse');
  }
  expect(backend.lastFrame).not.toContain('ask_user');
  // The question the person answered stays where it was asked — its own block, not a
  // trail line that does not even name the question. The model already has the answer
  // as the tool's result. A 12-row docked panel has room for the turn's tail alone.
  if (mode !== 'panel') {
    expect(backend.lastFrame).toContain('? Strategy — Rebase or merge?');
    expect(backend.lastFrame).toContain('→ merge');
  }
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
  // Kept as it was answered, in the person's own words.
  expect(ui.backend.lastFrame).toContain('? Which branch?');
  expect(ui.backend.lastFrame).toContain('→ use feature/ABC-1 please now');
  ui.app.unmount();
});

test('the arrows move the caret inside the free-text answer', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'ask_user', args: { questions: [{ question: 'Which branch?', options: [{ label: 'master' }, { label: 'develop' }] }] } }],
    [{ text: 'Fine.' }],
  );
  const ui = await bootApp(model, 110, 30);
  const fieldRow = () => ui.backend.lastFrame.split('\n').filter((r) => r.includes('› ')).at(-1) ?? '';
  await ui.press('F');
  await ui.type('which branch should I use?');
  await ui.press('return');
  await settleUi(15);

  // The first printable key opens the field with itself in it.
  await ui.type('abc');
  expect(fieldRow()).toContain('› abc');
  await ui.press('left');
  await ui.type('X');
  // The letter went in at the caret, not at the end.
  expect(fieldRow()).toContain('› abXc');
  // The caret is the cell it rests on: the character AFTER `X`, drawn inverse.
  expect(styleAt(ui.backend, '› abXc', 5).inverse).toBe(true);
  expect(styleAt(ui.backend, '› abXc', 4).inverse).toBeFalsy();

  // And what the field answers with is the edited text.
  await ui.press('return');
  await settleUi(20);
  expect(model.requests).toHaveLength(2);
  const result = (model.requests[1]!.messages as { role: string; content?: string }[]).find((m) => m.role === 'tool');
  expect(String(result?.content)).toContain('abXc');
  ui.app.unmount();
});

test('an answered question is saved with the session and drawn again when it is continued', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ask-sessions-'));
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'ask_user', args: { questions: [{ question: 'Which branch?', header: 'Branch', options: [{ label: 'master' }, { label: 'develop' }] }] } }],
    [{ text: 'Using it.' }],
  );
  const ui = await bootApp(model, 110, 30, undefined, { sessions: { dir } });
  await ui.press('F');
  await ui.type('which branch should I use?');
  await ui.press('return');
  await settleUi(15);
  await ui.press('return');
  await settleUi(20);
  await new Promise((r) => setTimeout(r, 400)); // the save is 250 ms after the turn
  ui.app.unmount();

  // A restart continues the session: what the person answered is still there.
  const next = new ScriptedModel();
  next.script([{ text: 'Ready.' }]);
  const ui2 = await bootApp(next, 110, 30, undefined, { sessions: { dir } });
  await settleUi(10);
  await ui2.press('F');
  await settleUi(10);
  expect(ui2.backend.lastFrame).toContain('? Branch — Which branch?');
  expect(ui2.backend.lastFrame).toContain('→ master');
  ui2.app.unmount();
});

test('each question keeps its own block: what was picked, and what was dismissed', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'ask_user', args: { questions: [
      { question: 'Which branch?', header: 'Branch', options: [{ label: 'master' }, { label: 'develop' }] },
      { question: 'Which checks?', options: [{ label: 'lint' }, { label: 'tests' }] },
    ] } }],
    [{ text: 'Fine.' }],
  );
  const ui = await bootApp(model, 110, 40);
  await ui.press('F');
  await ui.type('set this up');
  await ui.press('return');
  await settleUi(15);
  await ui.press('return'); // the first question: master
  await settleUi(4);
  await ui.press('escape'); // the second: dismissed
  await settleUi(20);

  expect(ui.backend.lastFrame).toContain('? Branch — Which branch?');
  expect(ui.backend.lastFrame).toContain('→ master');
  expect(ui.backend.lastFrame).toContain('? Which checks?');
  expect(ui.backend.lastFrame).toContain('→ dismissed');
  expect(ui.backend.lastFrame).not.toContain('ask_user');
  // The model is told the dismissal as one, and is sent no copy of the blocks: the
  // result it already has IS its record of the answer.
  expect(model.requests).toHaveLength(2);
  const sent = model.requests[1]!.messages as { role: string; content?: string }[];
  expect(sent.some((m) => m.role === 'ask')).toBe(false);
  expect(String(sent.find((m) => m.role === 'tool')?.content)).toContain('dismissed the question');
  ui.app.unmount();
});
