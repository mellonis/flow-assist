// A message queued during a running turn reaches the model at the next request
// boundary — after the current tool results — as the person's message; ↑ takes it back
// until then, and ⇥ on the empty field holds it for the turn's end instead.
// What reaches the model, and when, is queue-mid-turn.rig.test.ts; this file is what the
// queue line, the field and the list show.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { png } from './helpers/image-fixtures';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const settleUntil = async (ok: () => boolean, n = 300) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
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

test('a queued message stands on screen where it reached the model: after the current step, before the answer it led to', async () => {
  const { model, ui } = await heldTurn();
  expect(ui.backend.lastFrame).toContain('reaches the model after this step');
  model.release();
  await settleUntil(() => ui.backend.lastFrame.includes('Adjusted.'));
  await settle(10);
  const frame = ui.backend.lastFrame;
  expect(frame).not.toMatch(/queued/);
  // On screen it stands where it reached the model: before the answer it led to.
  expect(frame.indexOf('not there, the other file')).toBeLessThan(frame.indexOf('Adjusted.'));
});

test('↑ puts a queued message back into the field before it is delivered', async () => {
  const { model, ui } = await heldTurn();
  await ui.press('up');
  expect(fieldRow(ui.backend.lastFrame)).toContain('not there, the other file');
  expect(ui.backend.lastFrame).not.toContain('reaches the model after this step');
  model.release();
  await settleUntil(() => ui.backend.lastFrame.includes('Adjusted.'));
});

test('⇥ on the empty field says the queued message is held to the turn\'s end', async () => {
  const { model, ui } = await heldTurn();
  expect(ui.backend.lastFrame).toContain('⇥ hold to end');
  await ui.press('tab');
  expect(ui.backend.lastFrame).toContain('held to the turn\'s end');
  model.script([{ text: 'Now the other file.' }]);
  model.release();
  await settleUntil(() => ui.backend.lastFrame.includes('Now the other file.'));
});

test('the queue line describes the last message: a correction typed after a held one goes after this step', async () => {
  const { model, ui } = await heldTurn();
  await ui.press('tab'); // this note, and only it, goes at the turn's end
  await ui.type('and a correction');
  await ui.press('return');
  // The line describes the last message: it goes after this step.
  expect(ui.backend.lastFrame).toMatch(/queued \(2\): … and a correction · reaches the model after this step/);
  model.script([{ text: 'Now the note.' }]);
  model.release();
  await settleUntil(() => ui.backend.lastFrame.includes('Now the note.'));
});

test('the queue line says a message naming an image, and the ones behind it, wait for the turn\'s end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-queue-img-'));
  const shot = path.join(dir, 'shot.png');
  fs.writeFileSync(shot, png(40, 30));
  const model = new ScriptedModel();
  model.script([{ tool: 'datetime', args: {} }, { hold: true }], [{ text: 'Adjusted.' }], [{ text: 'Saw the image.' }], [{ text: 'And the rest.' }]);
  const ui = await bootApp(model, 140, 30, undefined, {}, { clipboardImage: () => ({ ok: true, path: shot }) });
  await ui.press('F');
  await ui.type('do the long thing');
  await ui.press('return');
  await settle(6);
  ui.backend.press({ name: 'v', ctrl: true });
  await settle();
  await ui.type(' look at this');
  await ui.press('return');
  expect(ui.backend.lastFrame).toContain('at the end of the turn (it names an image)');
  await ui.type('and then this');
  await ui.press('return');
  expect(ui.backend.lastFrame).toContain('at the end of the turn (behind an image)');
  model.release();
  await settleUntil(() => ui.backend.lastFrame.includes('And the rest.'));
});
