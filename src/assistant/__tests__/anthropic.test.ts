// The Anthropic wire: the host's OpenAI-shaped history converted on the way out, and a
// streamed round folded back into what the loop reads.
import { expect, test } from 'bun:test';
import {
  ANTHROPIC_CONTENT, REQUEST_TAIL, anthropicRequest, errorStatus, finishReason, imageBlock, roundReader, summaryHistory, thinkingParams,
  toAnthropicMessages, toAnthropicTools, usageOf, withoutThinking,
} from '../anthropic.ts';
import { llmConfigNotes, llmOpts } from '../llm-endpoint.ts';
import { llmErrorMessage } from '../llm-error.ts';
import { isImageRefusal } from '../images.ts';
import { anthropicRefusal } from '../../__tests__/helpers/scripted.ts';
import { openAiMessages, type ChatMessage } from '../agent.ts';
import type { ToolDef } from '../../loader/tools.ts';

const tool = (name: string): ToolDef => ({ type: 'function', function: { name, description: `${name} does it`, parameters: { type: 'object', properties: { p: { type: 'string' } } } } });
const call = (id: string, name: string, args: string) => ({ id, type: 'function', function: { name, arguments: args } });

const history: ChatMessage[] = [
  { role: 'system', content: 'You are the assistant.' },
  { role: 'system', content: 'Summary: earlier work.' },
  { role: 'user', content: 'read two files' },
  { role: 'assistant', content: 'Next: read them.', tool_calls: [call('t1', 'read_file', '{"path":"a"}'), call('t2', 'read_file', '{"path":"b"}')] },
  { role: 'tool', tool_call_id: 't1', content: 'OK: aaa' },
  { role: 'tool', tool_call_id: 't2', content: 'ERROR: no such file' },
  { role: 'user', content: 'and a third' },
];

test('system messages become the top-level system; a call becomes tool_use with its arguments as an object', () => {
  const { system, messages } = toAnthropicMessages(history);
  expect(system).toEqual([{ type: 'text', text: 'You are the assistant.' }, { type: 'text', text: 'Summary: earlier work.' }]);
  expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'read two files' }] });
  expect(messages[1]).toEqual({
    role: 'assistant',
    content: [
      { type: 'text', text: 'Next: read them.' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
      { type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'b' } },
    ],
  });
});

test('a round\'s tool results are ONE user message, and the person\'s next words join it after them', () => {
  const { messages } = toAnthropicMessages(history);
  expect(messages).toHaveLength(3);
  expect(messages[2]).toEqual({
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'OK: aaa' },
      { type: 'tool_result', tool_use_id: 't2', content: 'ERROR: no such file', is_error: true },
      { type: 'text', text: 'and a third' },
    ],
  });
  // What the real API would refuse, the double refuses too — and it takes this.
  expect(anthropicRefusal(anthropicRequest(history, { model: 'm', maxTokens: 100, stream: true, tools: [tool('read_file')] }) as never, { 'x-api-key': 'k', 'anthropic-version': 'v' })).toBeNull();
});

test('turns of one role in a row merge, an empty turn is dropped, arguments that do not parse go as an empty object', () => {
  const { messages } = toAnthropicMessages([
    { role: 'user', content: 'one' },
    { role: 'user', content: '' },
    { role: 'bg', content: 'a background result' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: null, tool_calls: [call('x', 'datetime', '{"cut')] },
    { role: 'tool', tool_call_id: 'x', content: '' },
  ]);
  expect(messages).toEqual([
    { role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'a background result' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'datetime', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] },
  ]);
});

test('an image part goes as a base64 image block; a URL that is not data: as a url source', () => {
  const { messages } = toAnthropicMessages([{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }]);
  expect(messages[0]!.content).toEqual([{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }]);
  expect(imageBlock('https://example.com/a.png')).toEqual({ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } });
});

test('a round\'s kept blocks go back exactly as they came — thinking, signature and order', () => {
  const kept = [
    { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
    { type: 'text', text: 'Next: look.' },
    { type: 'tool_use', id: 't1', name: 'datetime', input: {} },
  ];
  const { messages } = toAnthropicMessages([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'Next: look.', tool_calls: [call('t1', 'datetime', '{}')], [ANTHROPIC_CONTENT]: kept },
    { role: 'tool', tool_call_id: 't1', content: 'OK: now' },
  ]);
  expect(messages[1]!.content).toEqual(kept);
  // The API's own recovery for a block it will not take back: send none.
  const body = anthropicRequest([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'x', tool_calls: [call('t1', 'datetime', '{}')], [ANTHROPIC_CONTENT]: kept }, { role: 'tool', tool_call_id: 't1', content: 'OK' }], { maxTokens: 10, stream: true });
  expect(withoutThinking(body).messages[1]!.content.map((b) => b.type)).toEqual(['text', 'tool_use']);
});

test('the cache breakpoints sit on the last system block and the last message block; no thinking is asked for unless configured', () => {
  const body = anthropicRequest(history, { model: 'claude-sonnet-5', maxTokens: 8192, stream: true, tools: [tool('a'), tool('b')] });
  expect(body.system!.map((b) => b.cache_control)).toEqual([undefined, { type: 'ephemeral' }]);
  // The tools come before the system in the prefix: its breakpoint covers them.
  expect(body.tools!.every((t) => !t.cache_control)).toBe(true);
  expect(body.messages.flatMap((m) => m.content).map((b) => b.cache_control ?? null)).toEqual([null, null, null, null, null, null, { type: 'ephemeral' }]);
  // With no system, the last tool takes it.
  const noSystem = anthropicRequest([{ role: 'user', content: 'hi' }], { maxTokens: 5, stream: true, tools: [tool('a'), tool('b')] });
  expect(noSystem.tools!.map((t) => t.cache_control ?? null)).toEqual([null, { type: 'ephemeral' }]);
  // The kept blocks are never marked in place.
  const kept = [{ type: 'tool_use', id: 't1', name: 'datetime', input: {} }];
  const msgs: ChatMessage[] = [{ role: 'user', content: 'q' }, { role: 'assistant', content: null, tool_calls: [call('t1', 'datetime', '{}')], [ANTHROPIC_CONTENT]: kept }];
  anthropicRequest([...msgs, { role: 'user', content: 'more' }], { maxTokens: 5, stream: true });
  expect(kept[0]).toEqual({ type: 'tool_use', id: 't1', name: 'datetime', input: {} });
  expect(body).toMatchObject({ model: 'claude-sonnet-5', max_tokens: 8192, stream: true });
  expect('thinking' in body).toBe(false);
  // No system, no tools: neither field is sent.
  const bare = anthropicRequest([{ role: 'user', content: 'hi' }], { maxTokens: 5, stream: false });
  expect(Object.keys(bare).sort()).toEqual(['max_tokens', 'messages', 'model']);
  expect(bare.messages[0]!.content[0]!.cache_control).toEqual({ type: 'ephemeral' });
});

test('thinking: adaptive shows a summary; a fixed budget keeps under max_tokens, at least 1024', () => {
  expect(thinkingParams({ adaptive: true }, 8192)).toEqual({ thinking: { type: 'adaptive', display: 'summarized' }, max_tokens: 8192 });
  expect(thinkingParams({ budgetTokens: 4000 }, 8192)).toEqual({ thinking: { type: 'enabled', budget_tokens: 4000 }, max_tokens: 8192 });
  // The person's ceiling stays: a budget that does not fit is lowered, leaving the answer 1024.
  expect(thinkingParams({ budgetTokens: 10000 }, 8192)).toEqual({ thinking: { type: 'enabled', budget_tokens: 7168 }, max_tokens: 8192 });
  expect(thinkingParams({ budgetTokens: 100 }, 8192).thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  // Only a ceiling too small for any budget is raised — to 2048.
  expect(thinkingParams({ budgetTokens: 4096 }, 1000)).toEqual({ thinking: { type: 'enabled', budget_tokens: 1024 }, max_tokens: 2048 });
  expect(thinkingParams(undefined, 8192)).toEqual({ max_tokens: 8192 });
});

test('a streamed round: text, a call assembled from pieces, thinking with its signature, usage with the cache counted in', () => {
  const live: string[] = [];
  const thought: string[] = [];
  let kinds = 0;
  const r = roundReader({ onDelta: (d) => live.push(d), onReasoning: (d) => thought.push(d), onToolCalls: () => kinds++ });
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 20, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000, output_tokens: 1 } } },
    { type: 'ping' },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'check.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Next: ' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'the time.' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'datetime', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"tz":' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"UTC"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_2', name: 'memory', input: {} } },
    { type: 'content_block_stop', index: 3 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 57 } },
    { type: 'message_stop' },
  ];
  for (const e of events) r.event(e);
  const out = r.result();
  expect(live.join('')).toBe('Next: the time.');
  expect(thought.join('')).toBe('Let me check.');
  expect(kinds).toBe(1);
  expect(out).toEqual({
    content: 'Next: the time.',
    reasoning: 'Let me check.',
    finishReason: 'tool_calls',
    toolCalls: [{ id: 'toolu_1', name: 'datetime', arguments: '{"tz":"UTC"}' }, { id: 'toolu_2', name: 'memory', arguments: '' }],
    usage: { promptTokens: 4320, completionTokens: 57 },
    blocks: [
      { type: 'thinking', thinking: 'Let me check.', signature: 'SIG' },
      { type: 'text', text: 'Next: the time.' },
      { type: 'tool_use', id: 'toolu_1', name: 'datetime', input: { tz: 'UTC' } },
      { type: 'tool_use', id: 'toolu_2', name: 'memory', input: {} },
    ],
  });
});

test('thinking that is not shown still keeps its block — and says nothing to the fold', () => {
  const thought: string[] = [];
  const r = roundReader({ onReasoning: (d) => thought.push(d) });
  r.event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  r.event({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'S' } });
  r.event({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'a', name: 'datetime', input: {} } });
  r.event({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  expect(thought).toEqual([]);
  expect(r.result().blocks).toEqual([{ type: 'thinking', thinking: '', signature: 'S' }, { type: 'tool_use', id: 'a', name: 'datetime', input: {} }]);
  // An answer round keeps none: nothing will be sent back for it.
  const answer = roundReader({});
  answer.event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  answer.event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'hi' } });
  answer.event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
  expect(answer.result()).toMatchObject({ content: 'hi', finishReason: 'stop' });
  expect(answer.result().blocks).toBeUndefined();
});

test('an error event is read as the provider\'s refusal, with the status its type stands for', () => {
  const r = roundReader({});
  r.event({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
  const err = r.error()!;
  expect(err.status).toBe(529);
  expect(llmErrorMessage(err.status, err.body, { model: 'claude-opus-5-5', requestId: 'req_011CSabcdef' })).toBe('LLM 529 · claude-opus-5-5: Overloaded (request req_011C)');
  expect(errorStatus('invalid_request_error')).toBe(400);
  expect(errorStatus('something new')).toBe(500);
  // The Anthropic body read for its words, and an image refusal still recognised.
  const body = '{"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.1.image.source.base64: image exceeds 5 MB maximum"}}';
  const line = llmErrorMessage(400, body, { model: 'm' });
  expect(line).toBe('LLM 400 · m: messages.0.content.1.image.source.base64: image exceeds 5 MB maximum');
  expect(isImageRefusal(line)).toBe(true);
});

test('stop reasons and usage in the loop\'s words', () => {
  expect(finishReason('tool_use')).toBe('tool_calls');
  expect(finishReason('end_turn')).toBe('stop');
  expect(finishReason('max_tokens')).toBe('length');
  expect(finishReason('refusal')).toBe('refusal');
  expect(usageOf({ input_tokens: 5, output_tokens: 2 })).toEqual({ promptTokens: 5, completionTokens: 2 });
  expect(usageOf(undefined)).toBeUndefined();
});

test('what /compact sends: the instruction, and the conversation as ONE user message that ends asking for the summary', () => {
  const out = summaryHistory([
    { role: 'system', content: 'Compress.' },
    { role: 'tool', tool_call_id: 'gone', content: 'OK: orphan' },
    { role: 'user', content: 'read a' },
    { role: 'assistant', content: 'Next: look.', tool_calls: [call('t1', 'read_file', '{"path":"a"}')], [ANTHROPIC_CONTENT]: [{ type: 'thinking', thinking: 'x', signature: 's' }] },
    { role: 'tool', tool_call_id: 't1', content: 'OK: aaa' },
    { role: 'assistant', content: 'Done.' },
  ]);
  expect(out).toEqual([
    { role: 'system', content: 'Compress.' },
    { role: 'user', content: 'The conversation:\n\ntool result: OK: orphan\n\nuser: read a\n\nassistant: Next: look.\n[called read_file {"path":"a"}]\n\ntool result: OK: aaa\n\nassistant: Done.\n\nCompress it now, as instructed.' },
  ]);
  // The API takes it: no tools needed, no prefill.
  expect(anthropicRefusal(anthropicRequest(out, { maxTokens: 100, stream: false, thinking: { budgetTokens: 1024 } }) as never, { 'x-api-key': 'k', 'anthropic-version': 'v' })).toBeNull();
});

test('the double refuses a prefill, a fifth breakpoint, and a thinking-on tool loop whose turn does not start with thinking', () => {
  const h = { 'x-api-key': 'k', 'anthropic-version': 'v' };
  const base = { model: 'm', max_tokens: 4096, tools: [{ name: 't', input_schema: {} }] };
  expect(anthropicRefusal({ ...base, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'Sure' }] }, h)).toMatch(/prefill/);
  const five = Array.from({ length: 5 }, (_, i) => ({ type: 'text', text: `s${i}`, cache_control: { type: 'ephemeral' } }));
  expect(anthropicRefusal({ ...base, system: five, messages: [{ role: 'user', content: 'q' }] }, h)).toMatch(/maximum of 4/);
  const loop = [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 't', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a' }] },
  ];
  expect(anthropicRefusal({ ...base, thinking: { type: 'enabled', budget_tokens: 1024 }, messages: loop }, h)).toMatch(/must start with a thinking block/);
  expect(anthropicRefusal({ ...base, messages: loop }, h)).toBeNull();
});

test('the provider is read as written by a person; a value this host does not know is said, not refused', () => {
  expect(llmOpts({ provider: ' Anthropic ' }, {}).provider).toBe('anthropic');
  expect(llmConfigNotes({ provider: 'Anthropic' })).toEqual([]);
  expect(llmConfigNotes({ provider: 'openai' })).toEqual([]);
  expect(llmConfigNotes({})).toEqual([]);
  expect(llmConfigNotes({ provider: 'openrouter' })).toEqual(['ai.provider "openrouter" is not one this host knows — read as an OpenAI-compatible API; the other one is "anthropic"']);
  expect(llmConfigNotes({ provider: 'anthropic', thinking: { budgetTokens: 10000 } })[0]).toMatch(/^ai\.thinking\.budgetTokens 10000 does not fit under ai\.maxTokens 8192 .* sent as 7168; raise ai\.maxTokens/);
  expect(llmConfigNotes({ provider: 'anthropic', thinking: { budgetTokens: 4000 } })).toEqual([]);
});

test('tools are name, description and input_schema only', () => {
  expect(toAnthropicTools([tool('x')])).toEqual([{ name: 'x', description: 'x does it', input_schema: { type: 'object', properties: { p: { type: 'string' } } } }]);
});

test('the endpoint: an OpenAI-compatible API unless the provider says anthropic, which brings its own defaults', () => {
  const env = { LLM_TOKEN: 'l', ANTHROPIC_API_KEY: 'a', MINE: 'm' };
  expect(llmOpts({ baseUrl: 'http://x/v1', model: 'gpt' }, env)).toEqual({ provider: 'openai', baseUrl: 'http://x/v1', model: 'gpt', token: 'l', tokenEnv: 'LLM_TOKEN', maxTokens: 8192 });
  expect(llmOpts({ provider: 'openai-ish', model: 'gpt' }, env).provider).toBe('openai');
  expect(llmOpts({ provider: 'anthropic', model: 'claude-sonnet-5' }, env)).toEqual({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5', token: 'a', tokenEnv: 'ANTHROPIC_API_KEY', maxTokens: 8192 });
  expect(llmOpts({ provider: 'anthropic', tokenEnv: 'MINE', baseUrl: 'http://proxy/v1', maxTokens: 2000, thinking: { adaptive: true } }, env))
    .toMatchObject({ baseUrl: 'http://proxy/v1', token: 'm', tokenEnv: 'MINE', maxTokens: 2000, thinking: { adaptive: true } });
  expect(llmOpts({ provider: 'anthropic', thinking: { budgetTokens: 2048 } }, env).thinking).toEqual({ budgetTokens: 2048 });
  expect(llmOpts(undefined, {})).toEqual({ provider: 'openai', tokenEnv: 'LLM_TOKEN', maxTokens: 8192 });
});

test("a round's tail goes after the cache breakpoint — a text block of the last user turn, or a user turn of its own", () => {
  const tail: ChatMessage = { role: 'user', content: 'ON SCREEN', [REQUEST_TAIL]: true };
  const q: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
  const a = anthropicRequest([...q, tail], { model: 'm', maxTokens: 1024, stream: true });
  expect(a.messages).toHaveLength(1);
  expect(a.messages[0]!.content).toEqual([{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'ON SCREEN' }]);
  expect(anthropicRefusal(a as never, { 'x-api-key': 'k', 'anthropic-version': 'v' })).toBeNull();
  // The same history without a tail is marked exactly as before.
  expect(anthropicRequest(q, { maxTokens: 1024, stream: true }).messages[0]!.content).toEqual([{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }]);
  // A tail alone (no conversation) is one user turn with no breakpoint.
  expect(anthropicRequest([tail], { maxTokens: 1024, stream: true }).messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'ON SCREEN' }] }]);
});

test('on the OpenAI wire the tail joins the end of the last user message, or follows tool results', () => {
  const tail: ChatMessage = { role: 'user', content: 'ON SCREEN', [REQUEST_TAIL]: true };
  expect(openAiMessages([{ role: 'user', content: 'hi' }, tail])).toEqual([{ role: 'user', content: 'hi\n\nON SCREEN' }]);
  expect(openAiMessages([{ role: 'user', content: [{ type: 'text', text: 'look' }] }, tail]))
    .toEqual([{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'text', text: 'ON SCREEN' }] }]);
  const afterTool = openAiMessages([{ role: 'assistant', content: null, tool_calls: [] }, { role: 'tool', content: 'OK', tool_call_id: 'c' }, tail]);
  expect(afterTool.at(-1)).toEqual({ role: 'user', content: 'ON SCREEN' });
  expect(afterTool.some((m) => REQUEST_TAIL in m)).toBe(false);
});
