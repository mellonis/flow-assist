// A message queued during a running turn reaches the model at the next request
// boundary — after the current tool results — as the person's message; ↑ takes it back
// until then, and ⇥ on the empty field holds it for the turn's end instead.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const settleUntil = async (ok: () => boolean, n = 300) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
type Msg = { role: string; content: unknown };
const messages = (model: ScriptedModel, i: number) => (model.requests[i] as { messages: Msg[] }).messages;
const fieldRow = (frame: string) => frame.split('\n').filter((r) => r.includes('› ')).at(-1) ?? '';

async function heldTurn() {
  const model = new ScriptedModel();
  // The first round calls a tool and then holds: the person types meanwhile.
  model.script([{ tool: 'datetime', args: {} }, { hold: true }], [{ text: 'Adjusted.' }]);
  const ui = await bootApp(model, 120, 30);
  await ui.press('F');
  await ui.type('do the long thing');
  await ui.press('return');
  await settle(6);
  await ui.type('not there, the other file');
  await ui.press('return');
  return { model, ui };
}

test('a queued message reaches the model after the current step, as the person\'s message, and the turn goes on with it', async () => {
  const { model, ui } = await heldTurn();
  expect(ui.backend.lastFrame).toContain('reaches the model after this step');
  expect(model.requests).toHaveLength(1);
  model.release();
  await settleUntil(() => ui.backend.lastFrame.includes('Adjusted.'));
  await settle(10);
  // Delivered at the boundary: after the call and its result, in the same turn.
  const sent = messages(model, 1);
  expect(sent.at(-1)).toEqual({ role: 'user', content: 'not there, the other file' });
  expect(sent.at(-2)!.role).toBe('tool');
  // No second turn was started for it.
  expect(model.requests).toHaveLength(2);
  const frame = ui.backend.lastFrame;
  expect(frame).not.toMatch(/queued/);
  // On screen it stands where it reached the model: before the answer it led to.
  expect(frame.indexOf('not there, the other file')).toBeLessThan(frame.indexOf('Adjusted.'));
  // And it stays in the model's history for the next turn.
  model.script([{ text: 'ok' }]);
  await ui.type('next');
  await ui.press('return');
  await settle(20);
  expect(JSON.stringify(messages(model, 2))).toContain('not there, the other file');
});

test('↑ takes a queued message back before it is delivered', async () => {
  const { model, ui } = await heldTurn();
  await ui.press('up');
  expect(fieldRow(ui.backend.lastFrame)).toContain('not there, the other file');
  expect(ui.backend.lastFrame).not.toContain('reaches the model after this step');
  model.release();
  await settleUntil(() => ui.backend.lastFrame.includes('Adjusted.'));
  expect(JSON.stringify(messages(model, 1))).not.toContain('not there');
});

test('⇥ on the empty field holds the queued message for the turn\'s end', async () => {
  const { model, ui } = await heldTurn();
  expect(ui.backend.lastFrame).toContain('⇥ hold to end');
  await ui.press('tab');
  expect(ui.backend.lastFrame).toContain('held to the turn\'s end');
  model.script([{ text: 'Now the other file.' }]);
  model.release();
  await settleUntil(() => ui.backend.lastFrame.includes('Now the other file.'));
  // Not delivered mid-turn: the turn ended, then it went out as a turn of its own.
  expect(JSON.stringify(messages(model, 1))).not.toContain('not there');
  expect(model.requests).toHaveLength(3);
  expect(messages(model, 2).at(-1)).toEqual({ role: 'user', content: 'not there, the other file' });
});

test('a message queued after a held one waits with it: the person\'s words never overtake each other', async () => {
  const { model, ui } = await heldTurn();
  await ui.press('tab'); // the first is held to the end
  await ui.type('and a second thought');
  await ui.press('return');
  model.script([{ text: 'First handled.' }], [{ text: 'Second handled.' }]);
  model.release();
  await settleUntil(() => ui.backend.lastFrame.includes('Second handled.'));
  expect(JSON.stringify(messages(model, 1))).not.toContain('second thought');
  expect(messages(model, 2).at(-1)).toEqual({ role: 'user', content: 'not there, the other file' });
  expect(messages(model, 3).at(-1)).toEqual({ role: 'user', content: 'and a second thought' });
});
