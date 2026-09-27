// A tool call the model wrote as TEXT (src/assistant/tool-markup.ts): asked again once
// as a real call, never shown as the answer, never kept.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const DSML = 'Let me check the time.\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="clock">\n</｜DSML｜invoke>\n</｜DSML｜function_calls>';
const settleUntil = async (ok: () => boolean, n = 200) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };

test('an answer holding a call written as text is asked again, and the screen shows a note instead of the markup', async () => {
  const model = new ScriptedModel();
  model.script([{ text: DSML }], [{ tool: 'datetime', args: {} }], [{ text: 'It is noon.' }], [{ text: 'ok' }]);
  const ui = await bootApp(model, 110, 30);
  await ui.press('F');
  await ui.type('what time is it?');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('It is noon.'));
  expect(model.requests).toHaveLength(3);
  const corrective = JSON.stringify(model.requests[1]);
  expect(corrective).toContain('written as text in your answer');
  expect(corrective).toContain('no tool named clock');
  expect(corrective).not.toContain('DSML');
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('tool call written as text — asked again');
  expect(frame).not.toContain('DSML');
  expect(frame).toContain('It is noon.');
  await ui.type('thanks');
  await ui.press('return');
  await settle(20);
  expect(JSON.stringify(model.requests.at(-1))).not.toContain('DSML');
});
