// What one answer may take, on the OpenAI-compatible wire: the request carries the
// ceiling `answerCeiling` resolved (ai.maxTokens, else the model's catalogue entry, else
// the room its window leaves), and a provider that refuses the field by name is asked
// once without it — then never with it again in this process.
import { afterEach, expect, test } from 'bun:test';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation';
import { ScriptedModel } from './helpers/scripted';

afterEach(closeRigs);

type Body = { max_tokens?: number; stream?: boolean };

// The body request `i` sent, as the provider read it.
const body = (rig: Rig, i: number): Body => rig.model.requests[i] as unknown as Body;
const answered = (rig: Rig, text: string): boolean =>
  rig.conv.messages.some((m) => m.role === 'assistant' && String(m.content) === text);

test('the request carries the resolved ceiling', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'hi' }]);
  const rig = conversationRig(model);
  await rig.conv.send('hello');
  // No config set: the derived default — the room a 200k window leaves, over the cap.
  expect(body(rig, 0).max_tokens).toBe(32_000);
  expect(answered(rig, 'hi')).toBe(true);

  // A model with an entry of its own: the catalogue's ceiling, not the derived one.
  const other = new ScriptedModel();
  other.script([{ text: 'hi' }]);
  const second = conversationRig(other, { ai: { models: { m: { contextWindow: 262_144, maxTokens: 12_345 } } } });
  second.conv.model = 'm';
  await second.conv.send('hello');
  expect(body(second, 0).max_tokens).toBe(12_345);
});

test('a provider refusing max_tokens by name is retried once without it', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'the first answer' }], [{ text: 'the second answer' }]);
  // A host of its own: the fallback is remembered per process, and another test's
  // refusal must not decide this one.
  const rig = conversationRig(model, { ai: { baseUrl: 'http://refuses-max-tokens.test' } });
  const scripted = globalThis.fetch;
  const sent: Body[] = [];
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as Body;
    sent.push(req);
    if ('max_tokens' in req) {
      return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }), { status: 400 });
    }
    return scripted(url as string, init);
  }) as typeof fetch;
  try {
    await rig.conv.send('hello');
    // The refusal is answered by one request without the field — not a repeated request.
    expect(sent.map((b) => 'max_tokens' in b)).toEqual([true, false]);
    expect(answered(rig, 'the first answer')).toBe(true);

    // Remembered for the process: the next turn does not ask again.
    await rig.conv.send('again');
    expect(sent.map((b) => 'max_tokens' in b)).toEqual([true, false, false]);
    expect(answered(rig, 'the second answer')).toBe(true);
  } finally {
    globalThis.fetch = scripted;
  }
});
