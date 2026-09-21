// What /clear clears, and what it does not — as a person meets it.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('after /clear the assistant still has its memory — and the chat says so, and /memory removes it', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fa-mem-')), 'memory.json');
  const model = new ScriptedModel();
  model.script(
    // The model decides to remember the prompt — nobody sees more than "1 tool: memory".
    [{ tool: 'memory', args: { action: 'add', text: 'Prompt "focus": think of 7 random numbers and plan them' } }],
    [{ text: 'Done.' }],
    [{ text: 'second' }],
    [{ text: 'third' }],
  );
  const ui = await bootApp(model, 110, 30, undefined, { memory: { file } });
  await ui.press('A');
  await ui.type('think of 7 numbers');
  await ui.press('return');
  await settle(24);

  await ui.type('/clear');
  await ui.press('return');
  await settle();
  // The conversation is gone; the memory is not — and that is SAID. Silent, it read
  // as "/clear does not work: the assistant still knows what I asked".
  expect(ui.backend.lastFrame).not.toContain('think of 7 numbers');
  expect(ui.backend.lastFrame).toContain('1 memory is kept');
  expect(ui.backend.lastFrame).toContain('/memory');

  // The next request: no trace of the old turn in the MESSAGES, the fact in the system prompt.
  await ui.type('hello again');
  await ui.press('return');
  await settle(20);
  const sent = model.requests.at(-1)!.messages;
  expect(sent.filter((m) => m.role !== 'system')).toEqual([{ role: 'user', content: 'hello again' }]);
  expect(JSON.stringify(sent.filter((m) => m.role === 'system'))).toContain('7 random numbers');
  // The note itself is for the person only.
  expect(JSON.stringify(sent)).not.toContain('is kept');

  // /memory shows it without asking the model…
  const before = model.requests.length;
  await ui.type('/memory');
  await ui.press('return');
  await settle();
  expect(ui.backend.lastFrame).toContain('1 memory — sent with every request');
  expect(ui.backend.lastFrame).toContain('7 random numbers');
  // …and removes it.
  await ui.type('/memory forget 1');
  await ui.press('return');
  await settle();
  expect(ui.backend.lastFrame).toContain('Forgot:');
  expect(JSON.parse(readFileSync(file, 'utf8')).memories).toEqual([]);
  expect(model.requests.length).toBe(before);

  // From now on the model does not know it either.
  await ui.type('and now');
  await ui.press('return');
  await settle(20);
  expect(JSON.stringify(model.requests.at(-1)!.messages)).not.toContain('7 random numbers');
  ui.app.unmount();
});

test('/clear with an empty memory says nothing extra', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fa-mem-')), 'memory.json');
  const model = new ScriptedModel();
  model.script([{ text: 'hi' }]);
  const ui = await bootApp(model, 110, 26, undefined, { memory: { file } });
  await ui.press('A');
  await ui.type('hello');
  await ui.press('return');
  await settle(16);
  await ui.type('/clear');
  await ui.press('return');
  await settle();
  expect(ui.backend.lastFrame).not.toContain('kept');
  expect(ui.backend.lastFrame).toContain('Ask anything.');
  ui.app.unmount();
});
