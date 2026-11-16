// `/diff` through the real chat: the working tree in a panel of the chat's own — beside
// the conversation on a wide terminal, under the field on a narrow one — kept current as
// the tree changes, with keys of its own while the field is empty.
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settleUntil = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { await settle(2); if (cond()) return; await wait(20); }
};

// ─── a working tree of the test's own ────────────────────────────────────────
// Nothing here reaches a repository of the person's: every root is a fresh directory
// under the system temp directory.
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
};
// One commit, then one file changed since it: a tree with exactly one file to show.
const scratchTree = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-diff-panel-')));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  // The person's own git config may sign commits; a scratch repository never reaches a
  // key, and a test needs no signing.
  git(root, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\nchanged\n');
  return root;
};
const openDiff = async (ui: Awaited<ReturnType<typeof bootApp>>) => {
  await ui.press('F');
  await ui.type('/diff');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('diff · 1 files'));
};

test('/diff opens the split panel on the tree\'s changes, folds a file and closes', async () => {
  const root = scratchTree();
  const model = new ScriptedModel();
  const ui = await bootApp(model, 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui);
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('diff · 1 files');
  expect(frame).toContain('vs HEAD');
  expect(frame).not.toContain('no changes');
  // Every file is expanded by default: the hunks are rows of their own.
  expect(frame).toContain('+changed');
  // ⏎ folds the file the cursor is on: its hunks go, the list and the chat stay.
  await ui.press('return');
  expect(ui.backend.lastFrame).not.toContain('+changed');
  expect(ui.backend.lastFrame).toContain('diff · 1 files');
  // The command toggles it too: `/diff` on an open panel closes it, as Esc does.
  await ui.type('/diff');
  await ui.press('return');
  expect(ui.backend.lastFrame).not.toContain('diff ·');
  expect(ui.backend.lastFrame).toContain('⏎ send');
  // Reopened, Esc is the other way out and the panel is gone again.
  await ui.type('/diff');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('diff · 1 files'));
  await ui.press('escape');
  expect(ui.backend.lastFrame).not.toContain('diff ·');
  expect(ui.backend.lastFrame).toContain('⏎ send');
  ui.app.unmount();
});

test('/clear and the sessions key each close the panel with the conversation', async () => {
  const root = scratchTree();
  const model = new ScriptedModel();
  const ui = await bootApp(model, 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  // A session of its own closes it with the conversation it showed.
  await openDiff(ui);
  await ui.type('/clear');
  await ui.press('return');
  await settle(4);
  expect(ui.backend.lastFrame).not.toContain('diff ·');
  // The picker takes the conversation's place, and the panel with it.
  await ui.type('/diff');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('diff · 1 files'));
  ui.backend.press({ name: 's', ctrl: true });
  await settle(4);
  expect(ui.backend.lastFrame).not.toContain('diff ·');
  ui.app.unmount();
});

test('a y/n arriving while the panel is open wins the keys and does not close it', async () => {
  const root = scratchTree();
  const model = new ScriptedModel();
  // The call the y/n asks about writes the tree the panel draws: one file changed, one
  // added. `cwd` is the root, so the write lands where the panel looks.
  model.script(
    [{ tool: 'run_command', args: { command: 'echo two >> a.txt; echo new > b.txt', cwd: root } }],
    [{ text: 'ran it' }],
  );
  const ui = await bootApp(model, 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui);
  expect(ui.backend.lastFrame).toContain('diff · 1 files');
  await ui.type('run the command');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
  // The panel is still drawn under the y/n: answering is what the person does first, and
  // the panel is not what they are answering.
  expect(ui.backend.lastFrame).toContain('diff · 1 files');
  await ui.press('y');
  await settleUntil(() => !ui.backend.lastFrame.includes('Confirm write: run_command'));
  await settleUntil(() => ui.backend.lastFrame.includes('ran it'));
  // The write reaches the panel with no key of its own: the walk after the command's
  // round finds the file it appended to and the one it added.
  await settleUntil(() => ui.backend.lastFrame.includes('diff · 2 files'));
  // The panel's keys act again: ↓ moves to the second file and ⏎ folds it, leaving the
  // first open — and a refresh of its own keeps the fold where the person put it.
  await ui.press('down');
  await ui.press('return');
  expect(ui.backend.lastFrame).not.toContain('+new');
  expect(ui.backend.lastFrame).toContain('+changed');
  await wait(1200);
  await settle(4);
  expect(ui.backend.lastFrame).toContain('diff · 2 files');
  expect(ui.backend.lastFrame).not.toContain('+new');
  expect(ui.backend.lastFrame).toContain('+changed');
  // ↑ walks back: folding the first too leaves no hunk of either file.
  await ui.press('up');
  await ui.press('return');
  expect(ui.backend.lastFrame).not.toContain('+changed');
  expect(ui.backend.lastFrame).not.toContain('+new');
  expect(ui.backend.lastFrame).toContain('diff · 2 files');
  // Nothing of the panel reaches the model: it is a display, not a message.
  for (const req of model.requests) expect(JSON.stringify(req.messages)).not.toContain('diff ·');
  await ui.press('escape');
  expect(ui.backend.lastFrame).not.toContain('diff ·');
  ui.app.unmount();
});

test('Esc with a turn running stops it and leaves the panel open', async () => {
  const root = scratchTree();
  const model = new ScriptedModel();
  model.script([{ text: 'Looking at it… ' }, { hold: true }, { text: 'done' }]);
  const ui = await bootApp(model, 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui);
  await ui.type('think about it');
  await ui.press('return');
  await settleUntil(() => model.held);
  // Esc belongs to the run, not to the panel: the first press stops the turn.
  await ui.press('escape');
  await settleUntil(() => ui.backend.lastFrame.includes('stopped'));
  expect(ui.backend.lastFrame).toContain('diff · 1 files');
  // The panel is still open and takes its own Esc once nothing runs.
  await ui.press('escape');
  expect(ui.backend.lastFrame).not.toContain('diff ·');
  ui.app.unmount();
});

test('a narrow terminal stacks the panel below the field', async () => {
  const root = scratchTree();
  const model = new ScriptedModel();
  const ui = await bootApp(model, 80, 24, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui);
  const lines = ui.backend.lastFrame.split('\n');
  const header = lines.findIndex((l) => l.includes('diff · 1 files'));
  const field = lines.findIndex((l) => l.includes('⏎ send'));
  expect(field).toBeGreaterThanOrEqual(0);
  // Below the field, never beside the conversation.
  expect(header).toBeGreaterThan(field);
  expect(lines[header]!).not.toContain('›');
  ui.app.unmount();
});
