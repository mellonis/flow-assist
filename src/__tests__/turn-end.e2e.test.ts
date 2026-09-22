// What a turn that did not finish leaves in the model's history. A turn stopped with
// Esc used to leave only the question: the next request showed the model two user
// messages in a row, and it answered both — going back to the work the person had
// stopped. The tool calls that ran before Esc were lost with it.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Sent = { role: string; content?: string | null; tool_calls?: { id: string; function: { name: string } }[]; tool_call_id?: string };
const conversation = (model: ScriptedModel) => (model.requests.at(-1)!.messages as Sent[]).filter((m) => m.role !== 'system');

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
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await ui.type('what time is it');
  await ui.press('return');
  await settle(20);
  await ui.press('escape'); // the field is empty: Esc stops the answer
  await settle(20);
  expect(ui.backend.lastFrame).toContain('stopped (Esc)');

  await ui.type('capital of France?');
  await ui.press('return');
  await settle(20);
  expect(ui.backend.lastFrame).toContain('Paris.');

  const sent = conversation(model);
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
  // The closing word is the model's history only: the screen already says it.
  expect(ui.backend.lastFrame).not.toMatch(/not resum/i);
  model.release();
  ui.app.unmount();
});

test('a turn stopped before anything completed still ends in a closing word, not a waiting question', async () => {
  const model = new ScriptedModel();
  model.script([{ hold: true }, { text: 'never' }], [{ text: 'Paris.' }]);
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await ui.type('write me an essay');
  await ui.press('return');
  await settle(20);
  await ui.press('escape');
  await settle(20);
  await ui.type('capital of France?');
  await ui.press('return');
  await settle(20);

  const sent = conversation(model);
  expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  expect(String(sent[1]!.content)).toMatch(/stopped/i);
  noUserPairs(sent);
  model.release();
  ui.app.unmount();
});

test('a turn that failed keeps what it did and says it failed — a retry is the person\'s to ask, and allowed', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'datetime', args: {} }], [{ text: 'Paris.' }]);
  const ui = await bootApp(model, 100, 28);
  // The second request of the first turn fails, as a provider's 500 would.
  const scripted = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls++;
    if (calls === 2) return new Response('upstream is down', { status: 500 });
    return scripted(url as string, init);
  }) as typeof fetch;
  await ui.press('F');
  await ui.type('what time is it');
  await ui.press('return');
  await settle(20);
  expect(ui.backend.lastFrame).toContain('upstream is down');

  await ui.type('capital of France?');
  await ui.press('return');
  await settle(20);

  const sent = conversation(model);
  expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
  expect(sent[1]!.tool_calls?.[0]?.function.name).toBe('datetime');
  expect(String(sent[3]!.content)).toMatch(/failed/i);
  expect(String(sent[3]!.content)).not.toMatch(/not resum/i);
  noUserPairs(sent);
  ui.app.unmount();
});
