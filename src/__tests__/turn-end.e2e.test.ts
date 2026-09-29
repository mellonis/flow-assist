// What a turn that did not finish shows: a turn stopped with Esc says so, and its closing
// word — the model's history only — stays off the screen; a failed one says the
// provider's error; a refusal is read, not pasted. What the next request carries is
// turn-end.rig.test.ts.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('a turn stopped with Esc says so on screen, and the closing word the model reads stays off it', async () => {
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

  // The closing word is the model's history only: the screen already says it.
  expect(ui.backend.lastFrame).not.toMatch(/not resum/i);
  model.release();
  ui.app.unmount();
});

test('a turn that failed says the provider\'s error on screen', async () => {
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
  ui.app.unmount();
});

test('a provider\'s refusal is read, not pasted: the line names the model, the reason and the request', async () => {
  const model = new ScriptedModel();
  const ui = await bootApp(model, 120, 28);
  globalThis.fetch = (async () => new Response('{ "message":"model_access_denied", "request_id":"2395f0a1-77aa-4b" }', { status: 403 })) as unknown as typeof fetch;
  await ui.press('F');
  await ui.type('hello');
  await ui.press('return');
  await settle(20);
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('LLM 403 · scripted: model_access_denied (request 2395f0a1)');
  expect(frame).not.toContain('"message"');
  ui.app.unmount();
});
