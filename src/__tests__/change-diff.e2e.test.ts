// What a write changed stays in the chat as a diff block. Without it, the y/n would be
// all the person sees of an edit — the model's arguments, cut to one line — and after
// the yes nothing would show what the file became. The diff is for the person only: the model
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

  // The fence's language row is flowtty's label for a block the HOST wrote, under a
  // line that already says this is a change to a file. It is gone; the language stays
  // on the fence, which is what colours the diff green and red.
  expect(ui.backend.lastFrame.split('\n').some((r) => r.trim() === 'diff')).toBe(false);
  // The `@@` row is gone too — the numbers beside each row say where in the file it is.
  expect(shown).not.toContain('@@');
  const rows = ui.backend.lastFrame.split('\n');
  const numbered = (no: number, text: string) => rows.some((r) => new RegExp(`\\s${no} │ ${text.replace(/[+*.$]/g, '\\$&')}`).test(r));
  expect(numbered(1, ' const a = 1;')).toBe(true);
  // The removed line is line 2 of the OLD file, the added one line 2 of the NEW.
  expect(numbered(2, '-const b = 2;')).toBe(true);
  expect(numbered(2, '+const b = 42;')).toBe(true);
  expect(numbered(3, ' const c = 3;')).toBe(true);

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

test('the numbers are chrome: a drag copies the code alone, and the title is text, not code', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'edit_file', args: { path: 'app.ts', old: 'const b = 2;', new: 'const b = 42;' } }],
    [{ text: 'Changed b.' }],
  );
  // A light terminal, where the chat's accent is blue and flowtty's inline code is
  // cyan: the ✎ title is drawn as a title — the path in the chat's own accent — and
  // not as the fragment of code wrapping it in backticks would give.
  const root = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-diff-'))), 'clone');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'app.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  const config = { fs: { roots: [root] } };
  const ui = await bootApp(model, 110, 36, (make) => [buildRepoPlugin({ config, make })], config, { scheme: 'light' });
  await ui.press('F');
  await ui.type('set b to 42');
  await ui.press('return');
  await settle(10);
  await ui.press('y');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);

  const rows = ui.backend.lastFrame.split('\n');
  const titleAt = rows.findIndex((r) => r.includes('✎ clone/app.ts'));
  expect(titleAt).toBeGreaterThan(-1);
  const buf = (ui.backend as unknown as { lastBuffer: { get(x: number, y: number): { style: { fg?: string; dim?: boolean } } } }).lastBuffer;
  const pathX = Array.from(rows[titleAt]!.slice(0, rows[titleAt]!.indexOf('clone/app.ts'))).length;
  expect(buf.get(pathX, titleAt).style.fg).toBe('blue'); // the chat's accent, not code's cyan
  const countsX = Array.from(rows[titleAt]!.slice(0, rows[titleAt]!.indexOf('· +1'))).length;
  expect(buf.get(countsX, titleAt).style.dim).toBe(true);

  // A drag down the block returns the code as it stands in the file — no numbers, no
  // `│ ` bar. They are chrome, like the gutter marker.
  const from = rows.findIndex((r) => r.includes('const a = 1;'));
  const to = rows.findIndex((r) => r.includes('const c = 3;'));
  // From the diff's own first column (the ` `/`-`/`+` is the author's, and a copied
  // diff has to still apply) to past the pane's right edge.
  const fromX = Array.from(rows[from]!.slice(0, rows[from]!.indexOf('const a = 1;'))).length - 1;
  ui.backend.mouse('down', fromX, from);
  for (let y = from; y <= to; y++) ui.backend.mouse('drag', 100, y);
  ui.backend.mouse('up', 100, to);
  await settle(4);
  const [copied] = ui.backend.clipboard;
  expect(copied).toBe(' const a = 1;\n-const b = 2;\n+const b = 42;\n const c = 3;');
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
  // The host counts what a write RETURNS as done; a refusal returned as a plain
  // string ("not found") instead of thrown would mark the turn ✎ as if the file had changed.
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
