// `ai.maxRounds`: a turn that reaches the cap ends with one line saying where it
// stopped, and one key — Enter on the empty field — carries it on.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const settleUntil = async (ok: () => boolean, n = 300) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
type Msg = { role: string; content: unknown };

test('a turn stopped at ai.maxRounds says its last step, and ⏎ on the empty field sends continue', async () => {
  const model = new ScriptedModel();
  model.script(...Array.from({ length: 3 }, () => [{ tool: 'datetime', args: {} }]), [{ text: 'Done now.' }]);
  const ui = await bootApp(model, 110, 30, undefined, { ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', maxRounds: 3 } });
  await ui.press('F');
  await ui.type('work for a while');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('stopped after'));
  await settle(8);
  expect(model.requests).toHaveLength(3);
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('stopped after 3 rounds (ai.maxRounds) at datetime {} — ⏎ continue');
  expect(frame).toContain('⏎ continue ·');
  // One key: Enter on the empty field.
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Done now.'));
  const sent = (model.requests[3] as { messages: Msg[] }).messages;
  expect(sent.at(-1)).toEqual({ role: 'user', content: 'continue' });
  // Before it, the host's line in the model's history: where the turn stopped.
  expect(String(sent.at(-2)!.content)).toMatch(/stopped this turn after 3 rounds.*datetime/);
  expect(ui.backend.lastFrame).toContain('Done now.');
  expect(ui.backend.lastFrame).not.toContain('⏎ continue ·');
  // With the offer gone, Enter on an empty field sends nothing.
  await ui.press('return');
  await settle(8);
  expect(model.requests).toHaveLength(4);
});
