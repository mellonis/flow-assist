// `ai.maxRounds` and `ai.maxTurnTokens` through the host's own `chatLLM`: the turn stops
// at the one reached first, the conversation offers to continue, and the model's
// history says where it stopped, so a "continue" reads as picking up there. The line on
// screen and the key are round-cap.e2e.test.ts.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel } from './helpers/scripted';
import { conversationRig, type Sent } from './helpers/conversation';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('a turn stopped at ai.maxRounds closes in the model\'s history with where it stopped, and continue carries it on', async () => {
  const model = new ScriptedModel();
  model.script(...Array.from({ length: 3 }, () => [{ tool: 'datetime', args: {} }]), [{ text: 'Done now.' }]);
  const rig = conversationRig(model, { ai: { maxRounds: 3 } });
  await rig.conv.send('work for a while');
  expect(model.requests).toHaveLength(3);
  expect(rig.conv.lastEnd).toMatchObject({ outcome: 'limit', limit: { rounds: 3, lastStep: 'datetime {}' } });
  expect(rig.conv.continueOffer).toBe(true);
  await rig.conv.send('continue');
  const sent = rig.messages(3) as Sent[];
  expect(sent.at(-1)).toEqual({ role: 'user', content: 'continue' });
  // Before it, the host's line in the model's history: where the turn stopped.
  expect(String(sent.at(-2)!.content)).toMatch(/stopped this turn after 3 rounds.*datetime/);
  expect(rig.conv.lastAnswer()).toBe('Done now.');
  expect(rig.conv.continueOffer).toBe(false);
});

test('a turn past ai.maxTurnTokens closes the same way, and continue carries it on', async () => {
  const model = new ScriptedModel();
  // A cache figure of 0: every prompt token is new.
  model.usage = { prompt_tokens: 600, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } };
  model.script(...Array.from({ length: 4 }, () => [{ tool: 'datetime', args: {} }]), [{ text: 'Done now.' }]);
  const rig = conversationRig(model, { ai: { maxTurnTokens: 1000 } });
  await rig.conv.send('work for a while');
  // 610 a request: past 1000 after the second, so no third.
  expect(model.requests).toHaveLength(2);
  expect(rig.conv.lastEnd).toMatchObject({ outcome: 'limit', limit: { by: 'tokens', turnTokens: 1220 } });
  await rig.conv.send('continue');
  const sent = rig.messages(2) as Sent[];
  expect(sent.at(-1)).toEqual({ role: 'user', content: 'continue' });
  expect(String(sent.at(-2)!.content)).toMatch(/stopped this turn after 1220 tokens.*ai\.maxTurnTokens/);
});
