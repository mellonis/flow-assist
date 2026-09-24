// The chat on Anthropic's own Messages API (`ai.provider: 'anthropic'`): the real app,
// the scripted model serving the Anthropic wire — which refuses what the real API
// refuses, so every request below was one the API would take.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { png } from './helpers/image-fixtures';

const realFetch = globalThis.fetch;
const realKey = process.env.ANTHROPIC_API_KEY;
beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'sk-ant-scripted'; });
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = realKey;
});

type Block = Record<string, unknown> & { type: string };
type Sent = { model: string; max_tokens: number; stream?: boolean; system?: Block[]; tools?: Block[]; thinking?: unknown; messages: { role: string; content: Block[] }[] };
const sent = (model: ScriptedModel, i: number) => model.requests[i] as unknown as Sent;
const settleUntil = async (ok: () => boolean, n = 100) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };

// No base URL: the provider brings its own, and the token comes from ANTHROPIC_API_KEY.
const ANTHROPIC = { provider: 'anthropic', model: 'claude-sonnet-5', toolLoading: 'all' };

async function boot(model: ScriptedModel, ai: Record<string, unknown> = {}, cols = 110, rows = 32) {
  model.wire = 'anthropic';
  const ui = await bootApp(model, cols, rows, undefined, { ai: { ...ANTHROPIC, ...ai } });
  await ui.press('F');
  return ui;
}

async function ask(ui: Awaited<ReturnType<typeof boot>>, text: string) {
  await ui.type(text);
  await ui.press('return');
  await settle(20);
}

test('a text answer streams from /messages, with the API\'s headers, a max_tokens and the cache breakpoints', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Paris is the capital of France.' }]);
  const ui = await boot(model);
  await ask(ui, 'capital of France?');
  expect(ui.backend.lastFrame).toContain('Paris is the capital of France.');

  expect(model.urls[0]).toBe('https://api.anthropic.com/v1/messages');
  expect(model.headers[0]).toMatchObject({ 'x-api-key': 'sk-ant-scripted', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
  expect(model.headers[0]!.authorization).toBeUndefined();
  const body = sent(model, 0);
  expect(body).toMatchObject({ model: 'claude-sonnet-5', max_tokens: 8192, stream: true });
  expect('stream_options' in body).toBe(false);
  expect('thinking' in body).toBe(false);
  // The system prompt left the messages for the top-level field. Two breakpoints: the
  // last system block (the tools come before it, so it covers them) and the last block
  // of the last message; nothing else carries one.
  expect(body.messages.map((m) => m.role)).toEqual(['user']);
  expect(body.system!.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
  expect(body.system!.slice(0, -1).every((b) => !b.cache_control)).toBe(true);
  expect(body.messages[0]!.content.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
  expect(body.tools!.length).toBeGreaterThan(1);
  expect(body.tools!.every((t) => !t.cache_control && t.input_schema)).toBe(true);
});

test('in a tool loop the breakpoint moves to the newest block — the turn so far is read from the cache', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'datetime', args: {} }], [{ tool: 'datetime', args: {} }], [{ text: 'Noon.' }]);
  const ui = await boot(model);
  await ask(ui, 'time?');
  await settleUntil(() => model.requests.length === 3);
  await settle(10);
  for (const i of [1, 2]) {
    const marked = sent(model, i).messages.flatMap((m) => m.content).filter((b) => b.cache_control);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toBe(sent(model, i).messages.at(-1)!.content.at(-1)!);
    expect(marked[0]!.type).toBe('tool_result');
  }
  // The kept history itself was never marked: the first request's user message went
  // with a breakpoint, the same message in the next request goes without one.
  expect(sent(model, 1).messages[0]!.content[0]!.cache_control).toBeUndefined();
  expect(ui.backend.lastFrame).toContain('Noon.');
});

test('a tool round runs the tool, and its results go back in ONE user message answering the calls by id', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ text: 'Next: the time, twice.' }, { tool: 'datetime', args: {} }, { tool: 'datetime', args: { tz: 'UTC' } }],
    [{ text: 'It is noon.' }],
    [{ text: 'Still noon.' }],
  );
  const ui = await boot(model);
  await ask(ui, 'what time is it?');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);
  expect(ui.backend.lastFrame).toContain('It is noon.');

  const second = sent(model, 1);
  expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  expect(second.messages[1]!.content).toEqual([
    { type: 'text', text: 'Next: the time, twice.' },
    { type: 'tool_use', id: 'toolu_0', name: 'datetime', input: {} },
    { type: 'tool_use', id: 'toolu_1', name: 'datetime', input: { tz: 'UTC' } },
  ]);
  const results = second.messages[2]!.content;
  expect(results.map((b) => [b.type, b.tool_use_id])).toEqual([['tool_result', 'toolu_0'], ['tool_result', 'toolu_1']]);
  expect(String(results[0]!.content)).toMatch(/^OK: /);

  // The next question follows the answer: the history alternates and is accepted as a whole.
  await ask(ui, 'and now?');
  await settleUntil(() => model.requests.length === 3);
  expect(sent(model, 2).messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
  expect(ui.backend.lastFrame).toContain('Still noon.');
  expect(ui.backend.lastFrame).not.toContain('LLM 400');
});

test('thinking lands in the thinking fold, and its block goes back unchanged — signature and all — within the turn only', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ thinking: 'The clock tool will know.', signature: 'sig-A' }, { tool: 'datetime', args: {} }],
    [{ thinking: 'Now I can answer.', signature: 'sig-B' }, { text: 'It is noon.' }],
    [{ text: 'Bye.' }],
  );
  const ui = await boot(model, { thinking: { adaptive: true } });
  await ask(ui, 'what time is it?');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);
  expect(sent(model, 0).thinking).toEqual({ type: 'adaptive', display: 'summarized' });

  // The second request of the turn carries the first round's thinking block first, as it came.
  expect(sent(model, 1).messages[1]!.content).toEqual([
    { type: 'thinking', thinking: 'The clock tool will know.', signature: 'sig-A' },
    { type: 'tool_use', id: 'toolu_0', name: 'datetime', input: {} },
  ]);
  // The reasoning is folded under the answer, and opens with the details key.
  expect(ui.backend.lastFrame).toContain('It is noon.');
  expect(ui.backend.lastFrame).toMatch(/▸ thinking/);
  expect(ui.backend.lastFrame).not.toContain('The clock tool will know.');
  ui.backend.press({ name: 'o', ctrl: true });
  await settle();
  expect(ui.backend.lastFrame).toContain('Now I can answer.');

  // A turn that is over keeps no thinking: the next request replays none of it.
  await ask(ui, 'thanks');
  await settleUntil(() => model.requests.length === 3);
  expect(JSON.stringify(sent(model, 2).messages)).not.toContain('"thinking"');
  expect(ui.backend.lastFrame).toContain('Bye.');
});

test('thinking that is not shown still goes back within the turn, and draws no empty fold', async () => {
  const model = new ScriptedModel();
  model.script([{ thinking: '', signature: 'sig-hidden' }, { tool: 'datetime', args: {} }], [{ text: 'Noon.' }]);
  const ui = await boot(model);
  await ask(ui, 'time?');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);
  expect(sent(model, 1).messages[1]!.content[0]).toEqual({ type: 'thinking', thinking: '', signature: 'sig-hidden' });
  expect(ui.backend.lastFrame).toContain('Noon.');
  expect(ui.backend.lastFrame).not.toMatch(/▸ thinking/);
});

test('a fixed thinking budget that does not fit under ai.maxTokens is lowered, and the log says so', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'ok' }]);
  const ui = await boot(model, { thinking: { budgetTokens: 10000 }, maxTokens: 4000 });
  await ask(ui, 'hi');
  expect(sent(model, 0)).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 2976 }, max_tokens: 4000 });
  expect(ui.backend.lastFrame).toContain('ok');
  await ui.press('escape', 'escape');
  await ui.press('L');
  expect(ui.backend.lastFrame).toContain('ai.thinking.budgetTokens 10000 does not fit');
});

test('with a fixed budget, a thinking block refused goes with the thinking field — and the rest of the turn asks for none', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ thinking: 'Check the clock.', signature: 'sig-stale' }, { tool: 'datetime', args: {} }],
    [{ tool: 'datetime', args: {} }],
    [{ text: 'Noon.' }],
  );
  const ui = await boot(model, { thinking: { budgetTokens: 2048 } });
  const scripted = globalThis.fetch;
  let refused = 0;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    if (JSON.stringify(JSON.parse(String(init.body)).messages).includes('sig-stale')) {
      refused++;
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.' } }), { status: 400 });
    }
    return scripted(url as string, init);
  }) as typeof fetch;
  await ask(ui, 'time?');
  await settleUntil(() => model.requests.length === 3);
  await settle(10);
  // One refusal only: the retry, and the round after it, carry neither the block nor
  // the field — the double refuses a thinking-on tool loop whose turn starts otherwise.
  expect(refused).toBe(1);
  expect(sent(model, 0).thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  for (const i of [1, 2]) {
    expect('thinking' in sent(model, i)).toBe(false);
    expect(sent(model, i).max_tokens).toBe(8192);
    expect(JSON.stringify(sent(model, i).messages)).not.toContain('"type":"thinking"');
  }
  expect(ui.backend.lastFrame).toContain('Noon.');
  expect(ui.backend.lastFrame).not.toContain('LLM 400');
});

test('usage reaches the context meter with the cache counted in — what was sent, cached or not', async () => {
  const model = new ScriptedModel();
  model.anthropicUsage = { input_tokens: 1_000, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 57_000, output_tokens: 2_000 };
  model.script([{ text: 'hello' }]);
  const ui = await boot(model, { contextWindow: 100_000 });
  expect(ui.backend.lastFrame).toMatch(/ctx ~\d+%/);
  await ask(ui, 'hi');
  expect(ui.backend.lastFrame).toContain('ctx 62%');
});

test('an error event in the stream is the provider\'s refusal, read', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Half' }, { error: { type: 'overloaded_error', message: 'Overloaded' } }]);
  const ui = await boot(model);
  await ask(ui, 'hi');
  expect(ui.backend.lastFrame).toContain('LLM 529 · claude-sonnet-5: Overloaded (request req_scri)');
});

test('an HTTP 4xx is read out of Anthropic\'s error body, with its request-id header', async () => {
  const model = new ScriptedModel();
  const ui = await boot(model);
  globalThis.fetch = (async () => new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401, headers: { 'request-id': 'req_011CSq7x' } })) as unknown as typeof fetch;
  await ask(ui, 'hi');
  expect(ui.backend.lastFrame).toContain('LLM 401 · claude-sonnet-5: invalid x-api-key (request req_011C)');
});

test('/compact asks /messages once, not streamed, and the summary is its text', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'The first answer.' }], [{ text: 'SUMMARY: they greeted each other.' }], [{ text: 'The second answer.' }]);
  const ui = await boot(model);
  await ask(ui, 'the first question');
  await ui.type('/compact');
  await ui.press('return');
  await settle(20);
  expect(model.urls[1]).toBe('https://api.anthropic.com/v1/messages');
  const compact = sent(model, 1);
  expect(compact.stream).toBeUndefined();
  expect(compact.system![0]!.text).toMatch(/^Compress the chat history/);
  // One user message, the conversation as text — never an assistant turn last, which
  // the API would take for the start of its own answer.
  expect(compact.messages.map((m) => m.role)).toEqual(['user']);
  expect(compact.messages[0]!.content[0]!.text).toBe('The conversation:\n\nuser: the first question\n\nassistant: The first answer.\n\nCompress it now, as instructed.');
  expect(ui.backend.lastFrame).toContain('── compacted');

  await ask(ui, 'the second question');
  const last = sent(model, 2);
  expect(JSON.stringify(last.system)).toContain('SUMMARY: they greeted each other.');
  expect(JSON.stringify(last.messages)).not.toContain('the first question');
  expect(ui.backend.lastFrame).toContain('The second answer.');
});

test('/compact after a tool round sends the calls and results as text — the request has no tools to define them', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'datetime', args: {} }], [{ text: 'It is noon.' }], [{ text: 'SUMMARY: asked the time.' }]);
  const ui = await boot(model);
  await ask(ui, 'what time is it?');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);
  await ui.type('/compact');
  await ui.press('return');
  await settle(20);
  const compact = sent(model, 2);
  expect('tools' in compact).toBe(false);
  expect(JSON.stringify(compact.messages)).not.toMatch(/tool_use|tool_result/);
  expect(compact.messages.map((m) => m.role)).toEqual(['user']);
  expect(String(compact.messages[0]!.content[0]!.text)).toMatch(/^The conversation:\n\nuser: what time is it\?\n\nassistant: \[called datetime \{\}\]\n\ntool result: OK: .*\n\nassistant: It is noon\.\n\nCompress it now, as instructed\.$/s);
  expect(ui.backend.lastFrame).toContain('── compacted');
});

test('a thinking block the API will not take back is dropped, once, and the turn goes on', async () => {
  const model = new ScriptedModel();
  model.script([{ thinking: 'Check the clock.', signature: 'sig-stale' }, { tool: 'datetime', args: {} }], [{ text: 'Noon.' }]);
  const ui = await boot(model);
  const scripted = globalThis.fetch;
  let refused = 0;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    if (JSON.stringify(JSON.parse(String(init.body)).messages).includes('"type":"thinking"')) {
      refused++;
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.' } }), { status: 400 });
    }
    return scripted(url as string, init);
  }) as typeof fetch;
  await ask(ui, 'time?');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);
  expect(refused).toBe(1);
  expect(sent(model, 1).messages[1]!.content).toEqual([{ type: 'tool_use', id: 'toolu_0', name: 'datetime', input: {} }]);
  expect(ui.backend.lastFrame).toContain('Noon.');
  expect(ui.backend.lastFrame).not.toContain('LLM 400');
});

test('an attached image goes as a base64 image block', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-anthropic-img-')));
  const file = path.join(dir, 'shot.png');
  fs.writeFileSync(file, png(40, 30));
  const model = new ScriptedModel();
  model.script([{ text: 'A screenshot.' }]);
  const ui = await boot(model);
  ui.backend.paste(file);
  await settle();
  await ask(ui, 'what is this?');
  await settleUntil(() => model.requests.length === 1);
  expect(sent(model, 0).messages[0]!.content).toEqual([
    { type: 'text', text: '[Image #1] what is this?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: fs.readFileSync(file).toString('base64') }, cache_control: { type: 'ephemeral' } },
  ]);
  expect(ui.backend.lastFrame).toContain('A screenshot.');
});
