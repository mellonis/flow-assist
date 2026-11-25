// The OpenAI-compatible wire carries a model's thinking under more than one name: vLLM
// and SGLang stream `delta.reasoning_content`, while DeepSeek, OpenRouter and other
// servers stream `delta.reasoning`. Both are read; neither is dropped, and one that
// somehow sends both is not said twice. The round is the real one — only the network
// is answered by hand.
import { afterEach, expect, test } from 'bun:test';
import { agentChat } from '../agent';

import { nativeFetch } from '../../__tests__/helpers/test-setup.ts';
const realFetch = nativeFetch;
afterEach(() => { globalThis.fetch = realFetch; });

// An SSE answer whose every delta is built by `delta` — one chunk each, then the end.
function serve(delta: () => Record<string, unknown>) {
  const events = [
    ...Array.from({ length: 2 }, () => ({ choices: [{ delta: delta(), finish_reason: null }] })),
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ];
  globalThis.fetch = (async () => new Response(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )) as unknown as typeof fetch;
}

const ask = async () => {
  let thought = '';
  let text = '';
  const res = await agentChat([{ role: 'user', content: 'hi' }], {
    baseUrl: 'http://model.test', model: 'm', token: 't',
    onReasoning: (d: string) => { thought += d; },
    onLive: (d: string) => { text += d; },
    onLiveCommit: () => {},
  } as never);
  return { thought, text, res };
};

test('a thought streamed as delta.reasoning reaches the reasoning callbacks', async () => {
  serve(() => ({ reasoning: 'thinking…' }));
  const { thought, text, res } = await ask();
  expect(thought).toBe('thinking…thinking…');
  expect(text).toBe('');
  expect(res.content).toBe('');
});

test('a thought streamed as delta.reasoning_content still reaches the reasoning callbacks', async () => {
  serve(() => ({ reasoning_content: 'thinking…' }));
  expect((await ask()).thought).toBe('thinking…thinking…');
});

test('a chunk carrying both names says the thought once', async () => {
  serve(() => ({ reasoning_content: 'once', reasoning: 'once' }));
  expect((await ask()).thought).toBe('onceonce');
});
