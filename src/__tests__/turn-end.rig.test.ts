// What a turn that did not finish leaves in the model's history. A turn stopped with
// Esc, or one that failed, is closed in the model's own voice after the calls that ran:
// without it the next request would show the model two user messages in a row, and it
// would answer both — going back to the work the person had stopped. The screen's side
// is turn-end.e2e.test.ts.
import { afterEach, expect, test } from 'bun:test';
import { keyGlyph } from '../playback/keys';
import { ScriptedModel } from './helpers/scripted';
import { conversationRig, type Sent } from './helpers/conversation';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Two user messages side by side read to the model as a question still waiting.
function noUserPairs(sent: Sent[]) {
  for (let i = 1; i < sent.length; i++) expect(sent[i - 1]!.role === 'user' && sent[i]!.role === 'user').toBe(false);
}

test('a turn stopped with Esc reaches the model as stopped: its finished tool calls, then a closing word — and the next question stands alone', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'datetime', args: {} }],
    [{ text: 'Half an ans' }, { hold: true }, { text: 'wer.' }],
    [{ text: 'Paris.' }],
  );
  const rig = conversationRig(model);
  const turn = rig.conv.send('what time is it');
  await rig.until(() => model.requests.length === 2 && model.held);
  expect(rig.conv.stop('')).toBe(true); // Esc
  await turn;
  expect(rig.conv.lastEnd).toMatchObject({ outcome: 'stopped', stoppedBy: keyGlyph('escape') });

  await rig.conv.send('capital of France?');
  expect(rig.conv.lastAnswer()).toBe('Paris.');

  const sent = rig.sent();
  expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
  expect(sent[0]!.content).toBe('what time is it');
  // The call that completed before Esc, with its result: it happened.
  expect(sent[1]!.tool_calls?.[0]?.function.name).toBe('datetime');
  expect(sent[2]!.tool_call_id).toBe(sent[1]!.tool_calls?.[0]?.id);
  expect(String(sent[2]!.content)).toStartWith('OK:');
  // The turn's end is said in the model's own voice: stopped, and not to be picked up.
  expect(String(sent[3]!.content)).toMatch(/stopped/i);
  expect(String(sent[3]!.content)).toMatch(/not resum/i);
  // The half-written text of the stopped round is not passed off as an answer.
  expect(String(sent[3]!.content)).not.toContain('Half an ans');
  expect(sent[4]!.content).toBe('capital of France?');
  noUserPairs(sent);
});

test('a turn stopped before anything completed still ends in a closing word, not a waiting question', async () => {
  const model = new ScriptedModel();
  model.script([{ hold: true }, { text: 'never' }], [{ text: 'Paris.' }]);
  const rig = conversationRig(model);
  const turn = rig.conv.send('write me an essay');
  await rig.until(() => model.held);
  rig.conv.stop('');
  await turn;
  await rig.conv.send('capital of France?');

  const sent = rig.sent();
  expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  expect(String(sent[1]!.content)).toMatch(/stopped/i);
  noUserPairs(sent);
});

test('a turn that failed keeps what it did and says it failed — a retry is the person\'s to ask, and allowed', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'datetime', args: {} }], [{ text: 'Paris.' }]);
  const rig = conversationRig(model);
  // The second request of the first turn fails, as a provider's 500 would.
  const scripted = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls++;
    if (calls === 2) return new Response('upstream is down', { status: 500 });
    return scripted(url as string, init);
  }) as typeof fetch;
  await rig.conv.send('what time is it');
  expect(rig.conv.lastEnd).toMatchObject({ outcome: 'failed' });

  await rig.conv.send('capital of France?');

  const sent = rig.sent();
  expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
  expect(sent[1]!.tool_calls?.[0]?.function.name).toBe('datetime');
  expect(String(sent[3]!.content)).toMatch(/failed/i);
  expect(String(sent[3]!.content)).not.toMatch(/not resum/i);
  noUserPairs(sent);
});
