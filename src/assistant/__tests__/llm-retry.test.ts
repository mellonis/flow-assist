// A model request that fails for a reason that passes is made again — on both wires, in
// both compaction paths — and never once the round has shown anything. Time goes through
// `retryClock`, so no test waits.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { agentChat, compactConversation, type ChatMessage } from '../agent';
import { ANTHROPIC_CONTENT, anthropicChatRound } from '../anthropic';
import { llmOpts } from '../llm-endpoint';
import { LlmRequestError, RETRIES_DEFAULT, RETRY_STATUSES, parseRetryAfter, readChunk, retryClock, sleepFor, retryLabel, withRetry, type RetryInfo } from '../llm-retry';
import { isImageRefusal } from '../images';

const realFetch = globalThis.fetch;
const realClock = { ...retryClock };
const NOW = Date.parse('2026-10-20T12:00:00Z');

// The clock: a wait is recorded, not waited; it ends at once unless the signal aborts.
let slept: number[] = [];
let calls: { url: string; body: Record<string, any> }[] = [];
beforeEach(() => {
  slept = [];
  calls = [];
  retryClock.now = () => NOW;
  retryClock.sleep = async (ms, signal) => {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    slept.push(ms);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(retryClock, realClock);
});

type Answer = Response | Error | (() => Response | Promise<Response>);
// A fetch that answers the requests in turn and records them.
function serve(...answers: Answer[]) {
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const a = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a() : a.clone();
  }) as typeof fetch;
}
const failing = (status: number, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { message: `status ${status}` } }), { status, headers: extra });
const sse = (...events: unknown[]) => new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const openAiAnswer = (text: string) => sse({ choices: [{ delta: { content: text }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]');
const anthropicAnswer = (text: string) => sse(
  { type: 'message_start', message: { usage: { input_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
);

// A connection failure as Bun reports it: a `TypeError` carrying a code.
const withCode = (message: string, code: string, where: 'error' | 'cause' = 'error'): TypeError => {
  if (where === 'cause') return new TypeError(message, { cause: Object.assign(new Error(message), { code }) });
  return Object.assign(new TypeError(message), { code });
};
const refused = () => withCode('Unable to connect', 'ConnectionRefused');

const Q: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const OPENAI = { baseUrl: 'http://model.test', model: 'm', token: 't' };
const ANTHROPIC = { baseUrl: 'http://model.test', model: 'm', token: 't' };
// A whole turn on the OpenAI wire, with the retry settings the config gives.
const chat = (opts: Record<string, unknown> = {}) => agentChat(Q, { ...OPENAI, retries: 10, retryDelay: 3, ...opts });
const round = (opts: Record<string, unknown> = {}) => anthropicChatRound(Q, { ...ANTHROPIC, retries: 10, retryDelay: 3, ...opts } as never);
const fails = async (p: Promise<unknown>): Promise<Error> => { try { await p; } catch (e) { return e as Error; } throw new Error('expected a failure'); };

// ─── what is repeated ─────────────────────────────────────────────────────────

for (const status of [429, 500, 502, 503, 504, 529]) {
  test(`a ${status} is repeated on the OpenAI wire`, async () => {
    serve(failing(status), openAiAnswer('done'));
    expect((await chat()).content).toBe('done');
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([3000]);
  });

  test(`a ${status} is repeated on the Anthropic wire`, async () => {
    serve(failing(status), anthropicAnswer('done'));
    expect((await round()).content).toBe('done');
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([3000]);
  });
}

for (const status of [400, 401, 402, 403, 404, 413, 418]) {
  test(`a ${status} fails at once on both wires, with the text it always had`, async () => {
    serve(failing(status));
    const a = await fails(chat());
    const b = await fails(round());
    expect(a.message).toStartWith(`LLM ${status} · m: status ${status}`);
    expect(b.message).toBe(a.message);
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([]);
  });
}

test('a refusal naming an image still reads as one', async () => {
  serve(new Response('{"error":{"message":"this model does not support image input"}}', { status: 400 }));
  expect(isImageRefusal((await fails(chat())).message)).toBe(true);
});

test('the statuses that are repeated are exactly the six', () => {
  expect([...RETRY_STATUSES].sort()).toEqual([429, 500, 502, 503, 504, 529]);
});

test('a network failure of the request is repeated; a plain error, and the person stopping, are not', async () => {
  serve(refused(), openAiAnswer('back'));
  expect((await chat()).content).toBe('back');
  expect(calls).toHaveLength(2);

  calls = []; slept = [];
  serve(new Error('boom'));
  expect((await fails(chat())).message).toBe('boom');
  expect(calls).toHaveLength(1);
  expect(slept).toEqual([]);

  calls = [];
  const stop = new AbortController();
  stop.abort();
  serve(openAiAnswer('never'));
  expect((await fails(chat({ signal: stop.signal }))).name).toBe('AbortError');
  expect(calls).toHaveLength(1);
  expect(slept).toEqual([]);
});

test('an unreachable provider on the Anthropic wire is repeated, and the give-up names the count', async () => {
  serve(refused());
  const e = await fails(round({ retries: 2 }));
  expect(e.message).toBe('Unable to connect — gave up after 2 retries');
  expect(calls).toHaveLength(3);
  expect(slept).toEqual([3000, 3000]);
});

// ─── an abort ─────────────────────────────────────────────────────────────────

test('an abort during the wait ends the round at once, as an abort', async () => {
  const stop = new AbortController();
  retryClock.sleep = (ms, signal) => new Promise<void>((_, reject) => {
    slept.push(ms);
    signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
    queueMicrotask(() => stop.abort());
  });
  serve(failing(503), openAiAnswer('never'));
  const e = await fails(chat({ signal: stop.signal }));
  expect(e.name).toBe('AbortError');
  expect(calls).toHaveLength(1);
  expect(slept).toEqual([3000]);
});

test('the real wait ends the moment the signal aborts', async () => {
  retryClock.sleep = sleepFor;
  const stop = new AbortController();
  const waiting = retryClock.sleep(3_600_000, stop.signal);
  stop.abort();
  expect(((await fails(waiting)) as Error).name).toBe('AbortError');
  const already = new AbortController();
  already.abort();
  expect(((await fails(retryClock.sleep(1, already.signal))) as Error).name).toBe('AbortError');
  await retryClock.sleep(1);
});

test('a failure that lands because the person stopped is the stop, not a failure to repeat', async () => {
  // Some runtimes surface an abort mid-request as a plain network TypeError.
  const stop = new AbortController();
  globalThis.fetch = (async () => { stop.abort(); throw new TypeError('terminated'); }) as typeof fetch;
  const stopped = await fails(chat({ signal: stop.signal }));
  expect(stopped.message).toBe('terminated');
  expect(stopped).toBeInstanceOf(TypeError); // passed through, not made a request error
  expect(slept).toEqual([]);

  const again = new AbortController();
  let attempts = 0;
  const e = await fails(withRetry({ retries: 5, signal: again.signal }, async () => {
    attempts++;
    again.abort();
    throw new LlmRequestError('LLM 503: x', { status: 503 });
  }));
  expect(e.message).toBe('LLM 503: x');
  expect(attempts).toBe(1);
  expect(slept).toEqual([]);
});

// ─── when: only while nothing was shown ───────────────────────────────────────

const streamError = (type: string) => ({ type: 'error', error: { type, message: 'try later' } });

test('an error event before any delta is repeated', async () => {
  serve(sse({ type: 'message_start', message: {} }, streamError('overloaded_error')), anthropicAnswer('ok'));
  const seen: RetryInfo[] = [];
  expect((await round({ onRetry: (i: RetryInfo) => { seen.push(i); } })).content).toBe('ok');
  expect(seen.map((i) => i.status)).toEqual([529]);
  expect(calls).toHaveLength(2);
});

test('an error event maps to the status of its type: rate limit, api, timeout, overloaded', async () => {
  const seen: (number | undefined)[] = [];
  const types = ['rate_limit_error', 'api_error', 'timeout_error', 'overloaded_error'];
  serve(...types.map((t) => sse(streamError(t))), anthropicAnswer('ok'));
  await round({ onRetry: (i: RetryInfo) => { seen.push(i.status); } });
  expect(seen).toEqual([429, 500, 504, 529]);
});

test('an error event in the last line of the stream, with no newline after it, is repeated like any other', async () => {
  const last = new Response(`data: ${JSON.stringify(streamError('overloaded_error'))}`, { headers: { 'content-type': 'text/event-stream' } });
  serve(last, anthropicAnswer('ok'));
  const seen: (number | undefined)[] = [];
  expect((await round({ onRetry: (i: RetryInfo) => { seen.push(i.status); } })).content).toBe('ok');
  expect(seen).toEqual([529]);
  expect(calls).toHaveLength(2);
});

test('an error event after a delta fails the round, and the delta was shown once', async () => {
  const shown: string[] = [];
  serve(sse(
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
    streamError('overloaded_error'),
  ), anthropicAnswer('Hello again'));
  const e = await fails(round({ onDelta: (d: string) => shown.push(d) }));
  expect(e.message).toStartWith('LLM 529');
  expect(shown).toEqual(['Hello']);
  expect(calls).toHaveLength(1);
  expect(slept).toEqual([]);
});

test('an error event after reasoning, or after a tool call began, is not repeated either', async () => {
  const thought: string[] = [];
  serve(sse(
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } },
    streamError('api_error'),
  ), anthropicAnswer('x'));
  await fails(round({ onReasoning: (d: string) => thought.push(d) }));
  expect(thought).toEqual(['hm']);
  expect(calls).toHaveLength(1);

  calls = [];
  let signalled = 0;
  serve(sse(
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'datetime' } },
    streamError('api_error'),
  ), anthropicAnswer('x'));
  await fails(round({ onToolCalls: () => { signalled++; } }));
  expect(signalled).toBe(1);
  expect(calls).toHaveLength(1);
  expect(slept).toEqual([]);
});

test('on the OpenAI wire a stream that breaks after its first word is not made again', async () => {
  const shown: string[] = [];
  let pulled = 0;
  const broken = () => new Response(new ReadableStream({
    pull(c) {
      if (pulled++ === 0) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}\n\n`));
      else c.error(new TypeError('socket closed'));
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
  serve(broken, openAiAnswer('Hello again'));
  await fails(chat({ onLive: (d: string) => shown.push(d) }));
  expect(shown).toEqual(['Hello']);
  expect(calls).toHaveLength(1);
});

test('the helper wraps the callbacks: a failure after any of them fired is final', async () => {
  for (const fire of ['onDelta', 'onReasoning', 'onToolCalls'] as const) {
    let attempts = 0;
    const heard: string[] = [];
    const e = await fails(withRetry({ [fire]: () => { heard.push(fire); }, retries: 5 }, async (cb) => {
      attempts++;
      if (attempts === 1) throw new LlmRequestError('LLM 503: x', { status: 503 });
      (cb[fire] as (d: string) => void)('x');
      throw new LlmRequestError('LLM 503: x', { status: 503 });
    }));
    expect(e.message).toBe('LLM 503: x');
    expect(attempts).toBe(2);
    expect(heard).toEqual([fire]);
  }
});

// ─── how many, how long ───────────────────────────────────────────────────────

test('ten failures and then success is a success; eleven is a failure naming ten', async () => {
  serve(...Array.from({ length: 10 }, () => failing(503)), openAiAnswer('finally'));
  expect((await chat({ retries: RETRIES_DEFAULT })).content).toBe('finally');
  expect(calls).toHaveLength(11);
  expect(slept).toEqual(Array(10).fill(3000));

  calls = []; slept = [];
  serve(failing(503));
  const e = await fails(chat());
  expect(e.message).toBe('LLM 503 · m: status 503 — gave up after 10 retries');
  expect((e as LlmRequestError).retries).toBe(10);
  expect(calls).toHaveLength(11);
});

test('one repeat reads "1 retry"; ai.retries 0 makes exactly one request and keeps the plain text', async () => {
  serve(failing(500));
  expect((await fails(round({ retries: 1 }))).message).toBe('LLM 500 · m: status 500 — gave up after 1 retry');
  expect(calls).toHaveLength(2);

  calls = []; slept = [];
  expect((await fails(round({ retries: 0 }))).message).toBe('LLM 500 · m: status 500');
  expect((await fails(chat({ retries: 0 }))).message).toBe('LLM 500 · m: status 500');
  expect(calls).toHaveLength(2);
  expect(slept).toEqual([]);
});

test('a failure that does not pass after some repeats keeps its own text', async () => {
  serve(failing(503), failing(401));
  expect((await fails(chat())).message).toBe('LLM 401 · m: status 401 — the token or the model is not allowed; config set ai.model <model> or check the token');
  expect(calls).toHaveLength(2);
});

test('ai.retryDelay is the wait, in seconds', async () => {
  serve(failing(503), failing(503), openAiAnswer('x'));
  await chat({ retryDelay: 0.5 });
  expect(slept).toEqual([500, 500]);
});

test('Retry-After in seconds replaces the delay; a date in the past or unreadable does not', async () => {
  serve(failing(429, { 'retry-after': '7' }), failing(429, { 'retry-after': 'soon' }), failing(429, { 'retry-after': 'Mon, 19 Oct 2026 12:00:00 GMT' }), openAiAnswer('x'));
  await chat();
  expect(slept).toEqual([7000, 3000, 3000]);
});

test('Retry-After as an HTTP date is the time until it', async () => {
  serve(failing(429, { 'retry-after': new Date(NOW + 20_000).toUTCString() }), anthropicAnswer('x'));
  await round();
  expect(slept).toEqual([20_000]);
});

test('Retry-After is obeyed up to a minute', async () => {
  serve(failing(429, { 'retry-after': '600' }), failing(529, { 'retry-after': new Date(NOW + 3_600_000).toUTCString() }), openAiAnswer('x'));
  await chat();
  expect(slept).toEqual([60_000, 60_000]);
});

test('parseRetryAfter reads seconds, fractions and dates', () => {
  expect(parseRetryAfter('3', NOW)).toBe(3000);
  expect(parseRetryAfter('1.5', NOW)).toBe(1500);
  expect(parseRetryAfter(new Date(NOW + 5000).toUTCString(), NOW)).toBe(5000);
  expect(parseRetryAfter('', NOW)).toBeUndefined();
  expect(parseRetryAfter(null, NOW)).toBeUndefined();
  expect(parseRetryAfter('-4', NOW)).toBeUndefined();
});

test('parseRetryAfter takes a date only as an HTTP date in the future', () => {
  expect(parseRetryAfter('Mon, 19 Oct 2026 12:00:00 GMT', NOW)).toBeUndefined();
  expect(parseRetryAfter(new Date(NOW).toUTCString(), NOW)).toBeUndefined();
  for (const garbage of ['1 2', 'Mon 3', '2026-10-21T12:00:00Z', 'Oct 21 2026', 'soon', '12 seconds', 'Tue, 20 Oct 2026 12:00:00']) {
    expect(parseRetryAfter(garbage, NOW)).toBeUndefined();
  }
  expect(parseRetryAfter('Tue, 20 Oct 2026 12:00:09 GMT', NOW)).toBe(9000);
});

test('each wait is reported before it, and its end is told to what the report returned', async () => {
  const log: string[] = [];
  retryClock.sleep = async (ms) => { log.push(`sleep ${ms}`); };
  serve(failing(429), failing(503), openAiAnswer('x'));
  await chat({
    retries: 4,
    onRetry: (i: RetryInfo) => { log.push(`retry ${i.attempt}/${i.of} ${i.status} ${i.waitMs}`); return () => { log.push('end'); }; },
  });
  expect(log).toEqual(['retry 1/4 429 3000', 'sleep 3000', 'end', 'retry 2/4 503 3000', 'sleep 3000', 'end']);
});

test('the label counts the wait', () => {
  expect(retryLabel({ attempt: 2, of: 10, status: 429 }, 3)).toBe('LLM 429 · retry 2/10 in 3 s');
  expect(retryLabel({ attempt: 1, of: 10 }, 0)).toBe('LLM unreachable · retry 1/10 in 0 s');
});

// ─── the one-shot fallbacks stay, and are not repeats ─────────────────────────

test('a refused stream_options is resent once without it, and that is not a retry', async () => {
  serve(new Response('{"error":{"message":"unknown field stream_options"}}', { status: 400 }), failing(503), openAiAnswer('ok'));
  const seen: RetryInfo[] = [];
  await chat({ baseUrl: 'http://fallback.test', retries: 1, onRetry: (i: RetryInfo) => { seen.push(i); } });
  expect(calls.map((c) => 'stream_options' in c.body)).toEqual([true, false, false]);
  expect(seen).toHaveLength(1);
  expect(slept).toEqual([3000]);
});

test('a refused thinking block is resent once without it, and that is not a retry', async () => {
  serve(new Response('{"type":"error","error":{"type":"invalid_request_error","message":"thinking block signature invalid"}}', { status: 400 }), anthropicAnswer('ok'));
  const history: ChatMessage[] = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } }], [ANTHROPIC_CONTENT]: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'tool_use', id: 'a', name: 'x', input: {} }] },
    { role: 'tool', tool_call_id: 'a', content: 'OK: 1' },
  ];
  const seen: RetryInfo[] = [];
  const r = await anthropicChatRound(history, { ...ANTHROPIC, retries: 3, onRetry: (i: RetryInfo) => { seen.push(i); } } as never);
  expect(r.thinkingDropped).toBe(true);
  expect(calls).toHaveLength(2);
  expect(seen).toEqual([]);
  expect(slept).toEqual([]);
});

// ─── compaction ───────────────────────────────────────────────────────────────

const HANDOFF = '## Goal\ng\n## Done\nd\n## In progress\np\n## Open decisions\nnone\n## Facts learned\nf';
const history: ChatMessage[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];

test('compaction repeats a failed request on the OpenAI wire', async () => {
  serve(failing(503), refused(), Response.json({ choices: [{ message: { content: HANDOFF } }] }));
  const seen: number[] = [];
  const r = await compactConversation(history, { ...OPENAI, retries: 5, retryDelay: 2, onRetry: (i) => { seen.push(i.attempt); } });
  expect(r.summary).toBe(HANDOFF);
  expect(calls).toHaveLength(3);
  expect(seen).toEqual([1, 2]);
  expect(slept).toEqual([2000, 2000]);
});

test('compaction repeats a failed request on the Anthropic wire, and gives up with the count', async () => {
  serve(failing(529), Response.json({ content: [{ type: 'text', text: HANDOFF }] }));
  const r = await compactConversation(history, { ...ANTHROPIC, provider: 'anthropic', retries: 5 });
  expect(r.summary).toBe(HANDOFF);
  expect(calls).toHaveLength(2);

  calls = []; slept = [];
  serve(failing(529));
  const e = await fails(compactConversation(history, { ...ANTHROPIC, provider: 'anthropic', retries: 2 }));
  expect(e.message).toBe('LLM 529 · m: status 529 — gave up after 2 retries');
  expect(calls).toHaveLength(3);
});

test('compaction does not repeat a refusal, nor an abort', async () => {
  serve(failing(401));
  await fails(compactConversation(history, { ...OPENAI }));
  expect(calls).toHaveLength(1);
});

// ─── the settings ─────────────────────────────────────────────────────────────

test('ai.retries and ai.retryDelay reach the requests, 10 and 3 when unset or unusable', () => {
  expect(llmOpts({}, {})).toMatchObject({ retries: 10, retryDelay: 3 });
  expect(llmOpts({ retries: 0, retryDelay: 0 }, {})).toMatchObject({ retries: 0, retryDelay: 0 });
  expect(llmOpts({ retries: 4, retryDelay: 1.5 }, {})).toMatchObject({ retries: 4, retryDelay: 1.5 });
  expect(llmOpts({ retries: -1, retryDelay: -2 }, {})).toMatchObject({ retries: 10, retryDelay: 3 });
  expect(llmOpts({ retries: 2.5, retryDelay: 'x' }, {})).toMatchObject({ retries: 10, retryDelay: 3 });
});

// ─── what counts as the network ───────────────────────────────────────────────

test('an invalid URL or an invalid header fails at once, on every wire, with no repeat', async () => {
  // As Bun's `fetch` rejects them before any connection: the invalid URL with its own
  // code, the invalid header with none.
  const bad = [withCode('fetch() URL is invalid', 'ERR_INVALID_URL'), new TypeError("Header 'x' has invalid value: 'a\nb'")];
  for (const error of bad) {
    calls = [];
    serve(error);
    const failures = [
      await fails(chat()),
      await fails(round()),
      await fails(compactConversation(history, { ...OPENAI, retries: 5 })),
      await fails(compactConversation(history, { ...ANTHROPIC, provider: 'anthropic', retries: 5 })),
    ];
    for (const e of failures) {
      expect(e).toBe(error);
      expect(e).not.toBeInstanceOf(LlmRequestError);
    }
    expect(calls).toHaveLength(4);
  }
  expect(slept).toEqual([]);
});

test('a configuration error from fetch is not repeated, even with the code it carries', async () => {
  serve(withCode('fetch() URL is invalid', 'ERR_INVALID_URL'));
  expect((await fails(chat())).message).toBe('fetch() URL is invalid');
  expect((await fails(round())).message).toBe('fetch() URL is invalid');
  expect(calls).toHaveLength(2);
  expect(slept).toEqual([]);
});

test('a TypeError without a connection code is not the network', async () => {
  serve(new TypeError('Header \'x\' has invalid value'));
  await fails(chat());
  await fails(round());
  expect(calls).toHaveLength(2);
  expect(slept).toEqual([]);
});

const CONNECTION_CODES = ['ConnectionRefused', 'ConnectionClosed', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE'];

for (const code of CONNECTION_CODES) {
  test(`a connection failure with the code ${code} is repeated, on the error or on its cause`, async () => {
    serve(withCode('down', code), withCode('down', code, 'cause'), openAiAnswer('back'));
    expect((await chat()).content).toBe('back');
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([3000, 3000]);
  });
}

// ─── a notice that throws ─────────────────────────────────────────────────────

test('an onRetry that throws changes nothing: the wait goes on and the round succeeds', async () => {
  serve(failing(503), openAiAnswer('fine'));
  expect((await chat({ onRetry: () => { throw new Error('the status line broke'); } })).content).toBe('fine');
  expect(slept).toEqual([3000]);
});

// ─── a failure while the body is read ─────────────────────────────────────────

// A streamed body that gives `chunks` and then fails the way a dropped connection does.
const dropping = (chunks: string[], code = 'ECONNRESET') => () => {
  let n = 0;
  return new Response(new ReadableStream({
    pull(c) {
      if (n < chunks.length) c.enqueue(new TextEncoder().encode(chunks[n++]!));
      else c.error(withCode('The socket connection was closed unexpectedly', code));
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
};
const openAiDelta = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const anthropicDelta = (text: string) => [
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

test('on the OpenAI wire a connection lost before the first delta is repeated; after one it is not', async () => {
  serve(dropping([]), openAiAnswer('whole'));
  expect((await chat()).content).toBe('whole');
  expect(calls).toHaveLength(2);
  expect(slept).toEqual([3000]);

  calls = []; slept = [];
  const shown: string[] = [];
  serve(dropping([openAiDelta('Hel')]), openAiAnswer('again'));
  const e = await fails(chat({ onLive: (d: string) => shown.push(d) }));
  expect(e.message).toStartWith('The socket connection was closed');
  expect(shown).toEqual(['Hel']);
  expect(calls).toHaveLength(1);
  expect(slept).toEqual([]);
});

test('on the Anthropic wire a connection lost before the first delta is repeated; after one it is not', async () => {
  serve(dropping([]), anthropicAnswer('whole'));
  expect((await round()).content).toBe('whole');
  expect(calls).toHaveLength(2);
  expect(slept).toEqual([3000]);

  calls = []; slept = [];
  const shown: string[] = [];
  serve(dropping([anthropicDelta('Hel')]), anthropicAnswer('again'));
  const e = await fails(round({ onDelta: (d: string) => shown.push(d) }));
  expect(e.message).toStartWith('The socket connection was closed');
  expect(shown).toEqual(['Hel']);
  expect(calls).toHaveLength(1);
  expect(slept).toEqual([]);
});

test('a read that fails without a connection code is not repeated', async () => {
  const noCode = () => new Response(new ReadableStream({ pull(c) { c.error(new TypeError('bad')); } }), { headers: { 'content-type': 'text/event-stream' } });
  serve(noCode, openAiAnswer('x'));
  expect((await fails(chat())).message).toBe('bad');
  serve(noCode, anthropicAnswer('x'));
  expect((await fails(round())).message).toBe('bad');
  expect(slept).toEqual([]);
});

test('a stop during a read is the stop on both wires, even when the stream fails with a connection code', async () => {
  for (const run of [(signal: AbortSignal) => chat({ signal }), (signal: AbortSignal) => round({ signal })]) {
    const stop = new AbortController();
    calls = [];
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(new ReadableStream({
        start(c) { init.signal?.addEventListener('abort', () => c.error(withCode('terminated', 'ECONNRESET')), { once: true }); },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const running = run(stop.signal);
    setTimeout(() => stop.abort(), 5);
    const e = await fails(running);
    expect(e).not.toBeInstanceOf(LlmRequestError);
    expect(calls).toHaveLength(1);
  }
  expect(slept).toEqual([]);
});

test('readChunk cancels the reader before it reports the network failure, and leaves other failures alone', async () => {
  let cancelled = 0;
  const reader = (error: unknown) => ({ read: async () => { throw error; }, cancel: async () => { cancelled++; } }) as never;
  const e = await fails(readChunk(reader(withCode('reset', 'ECONNRESET'))));
  expect(e).toBeInstanceOf(LlmRequestError);
  expect((e as LlmRequestError).network).toBe(true);
  expect(cancelled).toBe(1);
  expect(await fails(readChunk(reader(new TypeError('x'))))).toBeInstanceOf(TypeError);
  expect(cancelled).toBe(1);
  const stop = new AbortController();
  stop.abort();
  expect(await fails(readChunk(reader(withCode('reset', 'ECONNRESET')), stop.signal))).not.toBeInstanceOf(LlmRequestError);
  expect(cancelled).toBe(1);
});
