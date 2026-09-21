// The example plugin that docs/plugins.md walks through (examples/notes) works as the
// page says: its tools reach the model, its write pauses for the y/n and leaves its
// diff in the chat, and its `:` command runs. If this test fails, the page is wrong.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import buildNotesPlugin from '../../examples/notes/src/index.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const settleUntil = async (ok: () => boolean, n = 100) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const screen = (frame: string) => frame.split('\n').map((r) => r.replace(/│ /g, '')).join('\n');

async function boot(model: ScriptedModel) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-notes-'));
  const file = path.join(dir, 'notes.md');
  fs.writeFileSync(file, '- water the plants\n');
  const config = { plugins: { notes: { file } } };
  const ui = await bootApp(model, 110, 34, (make) => [buildNotesPlugin({ config, make, z })], config);
  return { ui, file };
}

test('notes_add pauses for the y/n, writes the note and leaves its diff in the chat', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'notes_add', args: { text: 'buy milk' } }],
    [{ text: 'Noted.' }],
  );
  const { ui, file } = await boot(model);
  await ui.press('F');
  await ui.type('remember to buy milk');
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('Confirm write: notes_add');
  expect(fs.readFileSync(file, 'utf8')).not.toContain('buy milk'); // nothing before the yes
  await ui.press('y');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);
  expect(fs.readFileSync(file, 'utf8')).toBe('- water the plants\n- buy milk\n');
  const shown = screen(ui.backend.lastFrame);
  expect(shown).toContain('✎ notes.md · +1 −0');
  expect(shown).toContain('+- buy milk');
  expect(JSON.stringify(model.requests[1]!.messages)).toContain('Added to notes.md.');
  ui.app.unmount();
});

test('notes_read gives the model the notebook', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'notes_read', args: {} }], [{ text: 'One note.' }]);
  const { ui } = await boot(model);
  await ui.press('F');
  await ui.type('what is in my notes?');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 2);
  expect(JSON.stringify(model.requests[1]!.messages)).toContain('water the plants');
  ui.app.unmount();
});

test(':notes counts the notes', async () => {
  const { ui } = await boot(new ScriptedModel());
  await ui.press(':');
  await ui.type('notes');
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('1 note in notes.md');
  ui.app.unmount();
});
