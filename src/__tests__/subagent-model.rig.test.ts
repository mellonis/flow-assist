// A conversation runs one model and measures against that model's window; a child runs
// the model its role names. A conversation on the scripted model, no App.
import { afterEach, expect, test } from 'bun:test';
import { closeRigs, conversationRig } from './helpers/conversation';
import { ScriptedModel } from './helpers/scripted';

afterEach(closeRigs);

const AI = {
  model: 'default-model',
  contextWindow: 300_000,
  models: { 'default-model': { contextWindow: 262_000 }, 'small-model': { contextWindow: 256_000 }, 'big-model': { contextWindow: 512_000 } },
  roles: { fast: 'small-model', deep: 'big-model' },
};

test('a conversation runs ai.model and measures against that model’s window', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: AI });
  model.script([{ text: 'ok' }]);
  await rig.conv.send('hi');
  expect(model.requests.at(-1)?.model).toBe('default-model');
  expect(rig.conv.contextWindow()).toBe(262_000);
  expect(rig.conv.effectiveModel()).toBe('default-model');
});

test('a model the catalogue does not name falls back to ai.contextWindow', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: { model: 'other-model', contextWindow: 300_000 } });
  expect(rig.conv.effectiveModel()).toBe('other-model');
  expect(rig.conv.contextWindow()).toBe(300_000);
});
