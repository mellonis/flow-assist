// What a write changed stays in the chat as a diff block. The y/n used to be all the
// person saw of an edit — the model's arguments, cut to one line — and after the yes
// nothing showed what the file became. The diff is for the person only: the model
// wrote the text itself, and its history must not grow by a copy of every edit.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { buildRepoPlugin } from '../../plugins-available/repo/src/index.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const settleUntil = async (ok: () => boolean, n = 100) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
// A fenced block is drawn as rows behind a dim `│ `; strip the bar to read the lines.
const screen = (frame: string) => frame.split('\n').map((r) => r.replace(/│ /g, '')).join('\n');

async function boot(model: ScriptedModel, sessions?: { dir: string }, existing?: string) {
  const root = existing ?? path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-diff-'))), 'clone');
  if (!existing) {
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'app.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  }
  const config = { fs: { roots: [root] }, ...(sessions ? { sessions } : {}) };
  const ui = await bootApp(model, 110, 36, (make) => [buildRepoPlugin({ config, make })], config);
  await ui.press('F');
  return { ui, root };
}

test('a confirmed edit leaves its diff in the chat, and the model is never sent it', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'edit_file', args: { path: 'app.ts', old: 'const b = 2;', new: 'const b = 42;' } }],
    [{ text: 'Changed b.' }],
    [{ text: 'Fine.' }],
  );
  const { ui, root } = await boot(model);
  await ui.type('set b to 42');
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('Confirm write: edit_file');
  await ui.press('y');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);
  expect(fs.readFileSync(path.join(root, 'app.ts'), 'utf8')).toContain('const b = 42;');

  const shown = screen(ui.backend.lastFrame);
  expect(shown).toContain('✎ clone/app.ts · +1 −1');
  expect(shown).toContain('-const b = 2;');
  expect(shown).toContain('+const b = 42;');
  expect(shown).toContain(' const a = 1;');
  expect(shown).toContain('Changed b.');

  // The next turn: what the model is SENT holds the tool's short result, not the diff.
  await ui.type('ok');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 3);
  const sent = JSON.stringify(model.requests[2]!.messages);
  expect(sent).toContain('edit_file: replaced in');
  expect(sent).not.toContain('+const b = 42;');
  expect(sent).not.toContain('@@ -');
  expect(sent).not.toContain('✎');
  ui.app.unmount();
});

test('a declined edit changes nothing and shows no diff', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'edit_file', args: { path: 'app.ts', old: 'const b = 2;', new: 'const b = 42;' } }],
    [{ text: 'Left it.' }],
  );
  const { ui, root } = await boot(model);
  await ui.type('set b to 42');
  await ui.press('return');
  await settle(10);
  await ui.press('n');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);
  expect(fs.readFileSync(path.join(root, 'app.ts'), 'utf8')).toContain('const b = 2;');
  expect(ui.backend.lastFrame).toContain('Left it.');
  expect(ui.backend.lastFrame).not.toContain('✎ clone/app.ts');
  ui.app.unmount();
});

test('a confirmed edit that fails is an error, not a change made', async () => {
  // The host counts what a write RETURNS as done; `edit_file` used to return its
  // refusal ("not found"), so the chat marked the turn ✎ as if the file had changed.
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'edit_file', args: { path: 'app.ts', old: 'const z = 9;', new: 'const z = 10;' } }],
    [{ text: 'It is not there.' }],
  );
  const { ui, root } = await boot(model);
  await ui.type('set z to 10');
  await ui.press('return');
  await settle(10);
  await ui.press('y');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);
  expect(fs.readFileSync(path.join(root, 'app.ts'), 'utf8')).toBe('const a = 1;\nconst b = 2;\nconst c = 3;\n');
  // What the model is told: an error, in the tool's words.
  const result = (model.requests[1]!.messages as { role: string; content?: string }[]).find((m) => m.role === 'tool');
  expect(result?.content).toStartWith('ERROR: edit_file:');
  expect(result?.content).toContain('not found in');
  expect(result?.content).toContain('Nothing was changed.');
  // What the person sees: no ✎, and under ^r the run is an error.
  expect(ui.backend.lastFrame).toContain('1 tool: ');
  expect(ui.backend.lastFrame).not.toContain('✎');
  ui.backend.press({ name: 'r', ctrl: true });
  await settle(5);
  expect(ui.backend.lastFrame).toMatch(/▸ edit_file.*→ error/);
  expect(ui.backend.lastFrame).not.toContain('→ applied');
  ui.app.unmount();
});

test('after a restart the diff is still in the chat, and still not in what the model is sent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-diff-sess-'));
  const first = new ScriptedModel();
  first.script(
    [{ tool: 'edit_file', args: { path: 'app.ts', old: 'const b = 2;', new: 'const b = 42;' } }],
    [{ text: 'Changed b.' }],
  );
  const one = await boot(first, { dir });
  await one.ui.type('set b to 42');
  await one.ui.press('return');
  await settle(10);
  await one.ui.press('y');
  await settleUntil(() => first.requests.length === 2);
  await settle(10);
  await one.ui.press('escape', 'escape'); // closing the chat saves at once
  one.ui.app.unmount();

  const model = new ScriptedModel();
  model.script([{ text: 'Fine.' }]);
  const two = await boot(model, { dir }, one.root);
  const shown = screen(two.ui.backend.lastFrame);
  expect(shown).toContain('✎ clone/app.ts · +1 −1');
  expect(shown).toContain('+const b = 42;');
  await two.ui.type('ok');
  await two.ui.press('return');
  await settleUntil(() => model.requests.length === 1);
  const sent = JSON.stringify(model.requests[0]!.messages);
  expect(sent).toContain('edit_file: replaced in');
  expect(sent).not.toContain('+const b = 42;');
  two.ui.app.unmount();
});
