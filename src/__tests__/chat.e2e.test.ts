// The chat as a person meets it, through the real TUI with a scripted model.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// The style of the cell where `text` starts (plus `offset` cells).
function styleAt(backend: { lastBuffer: any; lastFrame: string }, text: string, offset = 0) {
  const rows = backend.lastFrame.split('\n');
  const y = rows.findIndex((r) => r.includes(text));
  if (y < 0) throw new Error(`"${text}" is not on screen:\n${backend.lastFrame}`);
  return backend.lastBuffer.get(rows[y]!.indexOf(text) + offset, y).style as { fg?: string; bg?: string; bold?: boolean; dim?: boolean };
}

test('messages carry a marker and colour instead of a role label', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Three commits ahead of master.' }]);
  const ui = await bootApp(model, 100, 24);
  await ui.press('A');

  // The input reads as a field: a prompt in the accent colour, on its own ground.
  expect(ui.backend.lastFrame).toContain('› ');
  expect(styleAt(ui.backend, '› ').fg).toBe('cyan');
  expect(styleAt(ui.backend, '› ').bg).toBe('#1f1f2e');

  await ui.type('how far is my branch');
  await ui.press('return');
  await settle(14);
  const frame = ui.backend.lastFrame;

  // No role labels anywhere — the marker and the ground say who is speaking.
  for (const label of ['You', 'Assistant', 'Background', 'Context']) expect(frame).not.toMatch(new RegExp(`│ ${label}\\b`));
  expect(frame).toContain('› how far is my branch');
  expect(frame).toContain('Three commits ahead of master.');

  // The person's message: the same accent prompt as the field, on the user ground.
  const mine = styleAt(ui.backend, '› how far is my branch');
  expect(mine.fg).toBe('cyan');
  expect(mine.bg).toBe('#2b2b40');
  expect(styleAt(ui.backend, '› how far is my branch', 2).bg).toBe('#2b2b40');
  // The answer carries the assistant's own mark — ƒ, in its own colour — on the plain
  // modal ground, its text aligned under the message text.
  expect(frame).toMatch(/│ ƒ Three commits ahead/);
  const its = styleAt(ui.backend, 'ƒ Three commits ahead');
  expect(its.fg).toBe('green');
  expect(its.bg).toBe('black');
  expect(styleAt(ui.backend, 'Three commits ahead').bg).toBe('black');
  // The same mark signs the frame; the title dangles no preposition without a context.
  expect(frame).toContain('ƒ Flow Assist');
  expect(frame).not.toContain('Chat about');
  ui.app.unmount();
});

test('Enter while an answer is streaming queues the message, and it is sent when the turn ends', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Looking, ' }, { hold: true }, { text: 'three ahead.' }], [{ text: 'CI is green.' }]);
  const ui = await bootApp(model, 100, 26);
  await ui.press('A');
  await ui.type('how far is my branch');
  await ui.press('return');

  // The field stays a field while the answer comes — it used to turn into "…".
  await ui.type('and is CI green');
  expect(ui.backend.lastFrame).toContain('› and is CI green');
  await ui.press('return');

  // Queued, said so, and the field is free again. Nothing was sent yet.
  expect(ui.backend.lastFrame).toMatch(/queued.*and is CI green/);
  expect(ui.backend.lastFrame).not.toContain('› and is CI green');
  expect(model.requests).toHaveLength(1);

  model.release();
  await settle(24);

  // The queued message went out on its own, after the first turn — in order.
  expect(model.requests).toHaveLength(2);
  expect(model.requests[1]!.messages.at(-1)).toMatchObject({ role: 'user', content: 'and is CI green' });
  expect(ui.backend.lastFrame).toContain('CI is green.');
  expect(ui.backend.lastFrame).not.toMatch(/queued/);
  ui.app.unmount();
});

test('Esc takes the last queued message back into the field instead of cancelling the answer', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Looking, ' }, { hold: true }, { text: 'done.' }]);
  const ui = await bootApp(model, 100, 26);
  await ui.press('A');
  await ui.type('first');
  await ui.press('return');
  await ui.type('second thoughts');
  await ui.press('return');
  expect(ui.backend.lastFrame).toMatch(/queued/);

  await ui.press('escape');
  // Back in the field for editing; the answer is still coming.
  expect(ui.backend.lastFrame).toContain('› second thoughts');
  expect(ui.backend.lastFrame).not.toMatch(/queued/);

  model.release();
  await settle(24);
  expect(ui.backend.lastFrame).toContain('done.');
  expect(model.requests).toHaveLength(1);
  ui.app.unmount();
});

test('↑/↓ walk the prompt history; the draft in progress is not lost', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'one.' }], [{ text: 'two.' }]);
  const ui = await bootApp(model, 100, 26);
  await ui.press('A');
  await ui.type('first prompt');
  await ui.press('return');
  await settle(14);
  await ui.type('second prompt');
  await ui.press('return');
  await settle(14);

  const field = () => ui.backend.lastFrame.split('\n').filter((r) => r.includes('› ')).at(-1) ?? '';
  await ui.press('up');
  expect(field()).toContain('› second prompt');
  await ui.press('up');
  expect(field()).toContain('› first prompt');
  await ui.press('up'); // already the oldest — stays
  expect(field()).toContain('› first prompt');
  await ui.press('down');
  expect(field()).toContain('› second prompt');
  await ui.press('down'); // past the newest — back to the (empty) draft
  expect(field()).not.toContain('prompt');

  // A draft being typed is never replaced by an arrow key.
  await ui.type('a new draft');
  await ui.press('up');
  expect(field()).toContain('› a new draft');
  ui.app.unmount();
});
