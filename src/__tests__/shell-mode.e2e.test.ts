// Shell MODE — `!` on an empty field switching the prompt, not being typed (Claude
// Code's bash mode). shell.e2e.test.ts covers the shell command itself (timeout,
// directory, session persistence, run_command's own y/n path); this file covers only
// the mode: entering, leaving, and that it changes nothing about what already ran.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rootDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-shell-mode-')));
// A real process finishes on its own clock, not the test backend's (see shell.e2e.test.ts).
const settleUntil = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { await settle(2); if (cond()) return; await wait(20); }
};

// The style of the cell where `text` starts (plus `offset` cells) — see chat.e2e.test.ts.
function styleAt(backend: { lastBuffer: any; lastFrame: string }, text: string, offset = 0) {
  const rows = backend.lastFrame.split('\n');
  const y = rows.findIndex((r) => r.includes(text));
  if (y < 0) throw new Error(`"${text}" is not on screen:\n${backend.lastFrame}`);
  return backend.lastBuffer.get(rows[y]!.indexOf(text) + offset, y).style as { fg?: string; bg?: string; bold?: boolean; dim?: boolean };
}

async function boot(model: ScriptedModel, root: string) {
  const ui = await bootApp(model, 110, 32, undefined, { fs: { roots: [root] } });
  await ui.press('F');
  return ui;
}

test('`!` on an empty field enters shell mode — `! ` in the shell colour, no `!` inside the text — running it spends no model turn, then the prompt is `› ` again', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  const ui = await boot(model, root);

  await ui.type('!');
  // The glyph switched and the `!` itself never landed in the field's text.
  expect(ui.backend.lastFrame).toContain('! ');
  expect(ui.backend.lastFrame).not.toMatch(/›\s*!/);
  expect(styleAt(ui.backend, '! ').fg).toBe('magentaBright');

  await ui.type('echo hi');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('✓'));
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('$ echo hi');
  expect(frame).toContain('hi');
  expect(frame).toContain('✓');
  expect(model.requests).toHaveLength(0); // no turn spent — same as the legacy `!command`
  // The result's `$ ` gutter marker (the live block's first row) shares the
  // shell-mode prompt's colour — a command reads as one thing end to end.
  expect(styleAt(ui.backend, '$ echo hi').fg).toBe('magentaBright');

  // Back to the normal prompt: one command per `!`.
  expect(ui.backend.lastFrame).toContain('› ');
  expect(ui.backend.lastFrame).not.toContain('! ');
  ui.app.unmount();
});

test('Backspace on an empty shell-mode field leaves the mode; with text typed, Backspace deletes a character and stays in the mode', async () => {
  const root = rootDir();
  const ui = await boot(new ScriptedModel(), root);

  await ui.type('!');
  expect(ui.backend.lastFrame).toContain('! ');
  await ui.press('backspace'); // nothing to delete — leaves the mode instead
  expect(ui.backend.lastFrame).toContain('› ');
  expect(ui.backend.lastFrame).not.toContain('! ');

  await ui.type('!ec');
  expect(ui.backend.lastFrame).toContain('! ec');
  await ui.press('backspace'); // now there IS something to delete
  expect(ui.backend.lastFrame).toContain('! e');
  expect(ui.backend.lastFrame).not.toContain('! ec');
  expect(ui.backend.lastFrame).not.toContain('› '); // still in shell mode
  ui.app.unmount();
});

test('Esc on an empty shell-mode field leaves the mode before the usual double-Esc exit arms', async () => {
  const root = rootDir();
  const ui = await boot(new ScriptedModel(), root);

  await ui.type('!');
  expect(ui.backend.lastFrame).toContain('! ');
  await ui.press('escape');
  // Left the mode, not armed for exit — the chat is still open and unarmed.
  expect(ui.backend.lastFrame).toContain('› ');
  expect(ui.backend.lastFrame).not.toContain('Esc again to exit');
  ui.app.unmount();
});

test('`!` typed after other text is just a character — the message still goes to the model as plain text', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Sure.' }]);
  const ui = await boot(model, rootDir());

  await ui.type('hi! there');
  expect(ui.backend.lastFrame).toContain('› hi! there'); // normal prompt the whole time
  await ui.press('return');
  await settle(14);
  expect(model.requests).toHaveLength(1);
  const sent = model.requests[0]!.messages as { role: string; content: unknown }[];
  expect(sent.find((m) => m.role === 'user' && m.content === 'hi! there')).toBeDefined();
  expect(ui.backend.lastFrame).toContain('Sure.');
  ui.app.unmount();
});

test('↑ recalling a previous `!` command shows it in shell mode', async () => {
  const root = rootDir();
  const ui = await boot(new ScriptedModel(), root);

  await ui.type('!echo hi');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('✓'));
  await ui.press('up');
  // Shown the way it was typed: shell mode on, `!` stripped from the text.
  expect(ui.backend.lastFrame).toContain('! echo hi');
  expect(ui.backend.lastFrame).not.toContain('!!echo hi');
  expect(ui.backend.lastFrame).not.toContain('› !echo hi');
  ui.app.unmount();
});

test('a shell-mode command refused while an answer is running stays refused, not queued — the mode holds so a retry hits the same refusal', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  model.script([{ text: 'Thinking' }, { hold: true }, { text: ' done.' }]);
  const ui = await boot(model, root);

  await ui.type('a question');
  await ui.press('return');
  await settle(10); // the model is mid-answer, held

  await ui.type('!touch made.txt');
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('still running');
  expect(ui.backend.lastFrame).not.toContain('queued');
  // Refused, not submitted — shell mode holds, exactly as the old `!command` in the
  // field held its `!` through a refusal.
  expect(ui.backend.lastFrame).toContain('! touch made.txt');

  // A retry hits the same refusal — the command was never handed to the model as a
  // plain queued message.
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('still running');
  expect(ui.backend.lastFrame).not.toContain('queued');

  model.release();
  await settle(20);
  await wait(100);
  expect(fs.existsSync(path.join(root, 'made.txt'))).toBe(false);
  expect(model.requests).toHaveLength(1); // the question only — the command never reached the model
  ui.app.unmount();
});
