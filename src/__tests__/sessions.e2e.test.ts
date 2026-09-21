// A restart continues the conversation: what the MODEL is sent, not only what the
// screen shows — a restored screen over an empty history looks right and is the bug.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-sess-e2e-'));
type Sent = { role: string; content: unknown }[];
const sentTo = (m: ScriptedModel) => m.requests.at(-1)!.messages as Sent;

async function talk(dir: string, question: string, answer: string) {
  const model = new ScriptedModel();
  model.script([{ text: answer }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } });
  await ui.press('F');
  await ui.type(question);
  await ui.press('return');
  await settle(20);
  return { ui, model };
}

test('after a restart the chat is back — on screen and in what the model is sent', async () => {
  const dir = dirOf();
  const first = await talk(dir, 'как тренд по ABC-341?', 'Тренд — вверх, +4% за неделю.');
  await first.ui.type('а на след');
  await wait(350); // the debounced save
  first.ui.app.unmount();

  const model = new ScriptedModel();
  model.script([{ text: 'Держится.' }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } });
  await settle(6);
  await ui.press('F');
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('как тренд по ABC-341?');
  expect(frame).toContain('Тренд — вверх, +4% за неделю.');
  expect(frame).toContain('› а на след'); // the unsent draft too

  await ui.type('ующей неделе?');
  await ui.press('return');
  await settle(20);
  const sent = sentTo(model);
  expect(sent.some((m) => m.role === 'user' && m.content === 'как тренд по ABC-341?')).toBe(true);
  expect(sent.some((m) => m.role === 'assistant' && String(m.content).includes('Тренд — вверх'))).toBe(true);
  expect(sent.at(-1)).toMatchObject({ role: 'user', content: 'а на следующей неделе?' });
  ui.app.unmount();
});

test('closing the chat saves at once; /clear starts anew and a restart does not bring the cleared chat back', async () => {
  const dir = dirOf();
  const first = await talk(dir, 'первый вопрос', 'первый ответ');
  await first.ui.press('escape', 'escape'); // closed — written without waiting
  expect(fs.readdirSync(dir).filter((n) => n.endsWith('.json'))).toHaveLength(1);
  await first.ui.press('F');
  await first.ui.type('/clear');
  await first.ui.press('return');
  await settle(4);
  first.ui.app.unmount();

  const model = new ScriptedModel();
  model.script([{ text: 'снова первый ответ' }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } });
  await settle(6);
  await ui.press('F');
  expect(ui.backend.lastFrame).not.toContain('первый вопрос');

  // …but it is on the list, and /resume brings it back to the model too.
  await ui.type('/resume');
  await ui.press('return');
  await settle(4);
  expect(ui.backend.lastFrame).toMatch(/1\. первый вопрос — /);
  await ui.type('/resume 1');
  await ui.press('return');
  await settle(4);
  expect(ui.backend.lastFrame).toContain('первый ответ');
  await ui.type('и ещё');
  await ui.press('return');
  await settle(20);
  expect(sentTo(model).some((m) => m.role === 'user' && m.content === 'первый вопрос')).toBe(true);
  ui.app.unmount();
});

test('a broken session file does not stop the app from starting', async () => {
  const dir = dirOf();
  fs.writeFileSync(path.join(dir, '2026-09-21T10-00-00-abcd.json'), '{"version":1,"messa');
  const model = new ScriptedModel();
  model.script([{ text: 'ok' }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } });
  await settle(6);
  await ui.press('F');
  await ui.type('привет');
  await ui.press('return');
  await settle(20);
  expect(ui.backend.lastFrame).toContain('ok');
  ui.app.unmount();
});
