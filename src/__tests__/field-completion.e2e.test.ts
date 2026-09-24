// Completion in the chat's field and the `:` line beyond a command's NAME: the shell's
// directory on the hint row in `!` mode, a path completed there, a command's argument
// from its declared values. chat.e2e.test.ts covers the `/command` name itself,
// commandline.e2e.test.ts the `:` line's own inline drawing.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rootDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-field-complete-')));
// A real process finishes on its own clock, not the test backend's (see shell.e2e.test.ts).
const settleUntil = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { await settle(2); if (cond()) return; await wait(20); }
};
type Ui = Awaited<ReturnType<typeof bootApp>>;
const rows = (ui: Ui) => ui.backend.lastFrame.split('\n');
// The field's row: the last row carrying the prompt glyph of the mode.
const fieldRow = (ui: Ui, glyph = '› ') => rows(ui).filter((r) => r.includes(glyph)).at(-1) ?? '';
const short = (p: string) => p.replace(os.homedir(), '~');

async function bang(ui: Ui, cmd: string) {
  await ui.type(`!${cmd}`);
  await ui.press('return');
  await settleUntil(() => !ui.backend.lastFrame.includes('Esc stops'));
}
// Out of a shell-mode field with text: one Esc clears it, the next leaves the mode.
const leaveShell = (ui: Ui) => ui.press('escape', 'escape');

test('shell mode shows the directory on the hint row and follows !cd', async () => {
  const root = rootDir();
  fs.mkdirSync(path.join(root, 'sub'));
  const ui = await bootApp(new ScriptedModel(), root.length + 80, 32, undefined, { shell: { roots: [root] } });
  await ui.press('F');
  // The normal field says nothing about the shell.
  expect(ui.backend.lastFrame).not.toContain(`${short(root)} · `);
  await ui.type('!');
  expect(ui.backend.lastFrame).toContain(`${short(root)} · ⇥ path`);
  // It stays while a command is typed — that is the point.
  await ui.type('ls -la');
  expect(ui.backend.lastFrame).toContain(`${short(root)} · ⇥ path`);
  await ui.press('escape'); // clears the field, keeps the mode
  await ui.press('escape'); // leaves the mode
  expect(ui.backend.lastFrame).not.toContain(`${short(root)} · `);
  // `!cd` moves it, and `!!` mode reads the same directory.
  await bang(ui, 'cd sub');
  await ui.type('!!');
  expect(ui.backend.lastFrame).toContain(`${short(path.join(root, 'sub'))} · ⇥ path`);
  ui.app.unmount();
}, 15_000);

test('a long directory is cut from the left, keeping its tail', async () => {
  const root = rootDir();
  const deep = path.join(root, 'a-rather-long-directory-name', 'and-another-one-under-it', 'leaf');
  fs.mkdirSync(deep, { recursive: true });
  const ui = await bootApp(new ScriptedModel(), 60, 24, undefined, { shell: { roots: [root] } });
  await ui.press('F');
  await bang(ui, 'cd a-rather-long-directory-name/and-another-one-under-it/leaf');
  await ui.type('!');
  const row = rows(ui).find((r) => r.includes('⇥ path'))!;
  expect(row).toMatch(/…[^ ]*\/leaf · ⇥ path/);
  ui.app.unmount();
}, 15_000);

test('Tab completes a path in shell mode: a unique match whole, a directory with a slash, several in turn — never one outside the roots', async () => {
  const root = rootDir();
  const elsewhere = rootDir();
  for (const d of ['sub', 'alpha', 'apple', '.hidden']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'a.txt'), '');
  fs.symlinkSync(elsewhere, path.join(root, 'out')); // a link that leads out of the root
  const ui = await bootApp(new ScriptedModel(), root.length + 80, 32, undefined, { shell: { roots: [root] } });
  await ui.press('F');
  const field = () => fieldRow(ui, '! ');

  // A unique match: the rest is offered inline, Tab fills it in, a directory ends in `/`.
  await ui.type('!cd su');
  expect(field()).toContain('! cd sub/');
  await ui.press('tab');
  expect(field()).toContain('! cd sub/');
  expect(field()).not.toContain('⇥');
  await leaveShell(ui);

  // Several: the first is offered, the others named, Tab walks them and comes round.
  await ui.type('!ls a');
  expect(field()).toContain('! ls a.txt');
  expect(field()).toContain('⇥ alpha/ · apple/');
  await ui.press('tab');
  expect(field()).toContain('! ls a.txt');
  await ui.press('tab');
  expect(field()).toContain('! ls alpha/');
  await ui.press('tab');
  expect(field()).toContain('! ls apple/');
  await ui.press('tab');
  expect(field()).toContain('! ls a.txt');
  await leaveShell(ui);

  // Hidden entries only when the word starts with a dot.
  await ui.type('!ls ');
  expect(field()).not.toContain('.hidden');
  await ui.type('.');
  expect(field()).toContain('! ls .hidden/');
  await leaveShell(ui);

  // A link out of the roots is not offered, nor is the parent directory.
  await ui.type('!ls o');
  expect(field()).toContain('! ls o');
  expect(field()).not.toContain('out');
  await ui.press('tab');
  expect(field()).toContain('! ls o');
  expect(field()).not.toContain('out');
  await leaveShell(ui);
  await ui.type('!ls ../');
  await ui.press('tab');
  expect(field()).toContain('! ls ../');
  expect(field()).not.toContain('⇥');
  await leaveShell(ui);

  // The completed `cd` runs as any command does, and the directory follows.
  await ui.type('!cd su');
  await ui.press('tab');
  await ui.press('return');
  await settleUntil(() => !ui.backend.lastFrame.includes('Esc stops'));
  await ui.type('!');
  expect(ui.backend.lastFrame).toContain(`${short(path.join(root, 'sub'))} · ⇥ path`);
  ui.app.unmount();
  fs.rmSync(elsewhere, { recursive: true, force: true });
}, 20_000);

test('/notes and /mode complete their argument: `/notes ` offers step, `/notes o` open, `/mode ` walks the three', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 24);
  await ui.press('F');
  const field = () => fieldRow(ui);

  await ui.type('/notes ');
  expect(field()).toContain('› /notes step');
  expect(field()).toContain('⇥ open');
  await ui.press('tab');
  expect(field()).toContain('› /notes step');
  await ui.press('return');
  // The command ran with the completed word: no error, the mode said.
  expect(ui.backend.lastFrame).not.toContain('⚠');
  expect(field()).not.toContain('/notes');

  await ui.type('/notes o');
  expect(field()).toContain('› /notes open');
  await ui.press('tab');
  expect(field()).toContain('› /notes open');
  expect(field()).not.toContain('⇥');
  await ui.press('escape');

  await ui.type('/mode ');
  expect(field()).toContain('› /mode panel');
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) { await ui.press('tab'); seen.push(field().match(/› \/mode (\S+)/)![1]!); }
  expect(seen).toEqual(['panel', 'window', 'full', 'panel']);
  // A typed prefix narrows the walk.
  await ui.press('escape');
  await ui.type('/mode f');
  expect(field()).toContain('› /mode full');
  ui.app.unmount();
});

test('/resume completes to the saved sessions, their titles said beside the number', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'hi back' }], [{ text: 'sure' }]);
  const ui = await bootApp(model, 100, 24);
  await ui.press('F');
  await ui.type('hello there');
  await ui.press('return');
  await settle(20);
  await ui.type('/clear');
  await ui.press('return');
  await settle(4);
  await ui.type('tell me more');
  await ui.press('return');
  await settle(20);
  await ui.type('/clear');
  await ui.press('return');
  await settle(4);

  const field = () => fieldRow(ui);
  await ui.type('/resume ');
  // Newest first: the number is the word, the title is said beside it.
  expect(field()).toContain('› /resume 1 tell me more');
  expect(field()).toContain('⇥ 2 hello there');
  await ui.press('tab');
  await ui.press('tab');
  // Walking, the field holds the whole word and the caret sits after it; the title
  // follows the caret cell.
  expect(field()).toMatch(/› \/resume 2 {1,2}hello there/);
  await ui.press('return');
  await settle(4);
  expect(ui.backend.lastFrame).toContain('hello there');
  expect(ui.backend.lastFrame).toContain('hi back');
  ui.app.unmount();
});

test('a plugin command declares the values of its argument and the `:` line completes them', async () => {
  const got: string[] = [];
  const guests = (make: any) => [make('boards', {
    name: 'boards',
    commands: [{ name: 'open', usage: 'open <what>', minArgs: 1, maxArgs: 1, description: 'Open a thing', values: ['board', 'card'], run: (_ctx: unknown, arg: string) => { got.push(arg); } }],
  })];
  const ui = await bootApp(new ScriptedModel(), 100, 24, guests);
  const line = () => rows(ui).findLast((r) => /^\s*:(\s|$)/.test(r)) ?? '';
  await ui.press(':');
  await ui.type('open ');
  expect(line()).toContain(': open board');
  expect(line()).toContain('⇥ card');
  await ui.type('c');
  expect(line()).toContain(': open card');
  await ui.press('tab');
  expect(line()).toContain(': open card');
  await ui.press('return');
  await settle();
  expect(got).toEqual(['card']);
  ui.app.unmount();
});
