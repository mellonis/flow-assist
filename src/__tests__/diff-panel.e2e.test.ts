// `/diff` through the real chat: the working tree in a panel of the chat's own — beside
// the conversation on a wide terminal, under the field on a narrow one — kept current as
// the tree changes, with keys of its own while the field is empty.
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle, settleUntil as settleUntilShared } from './helpers/scripted';

import { nativeFetch } from './helpers/test-setup.ts';
const realFetch = nativeFetch;
afterEach(() => { globalThis.fetch = realFetch; });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settleUntil = async (cond: () => boolean, ms = 4000) => settleUntilShared(cond, { ms });

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
  await settleUntil(() => ui.backend.lastFrame.includes('diff · 1 file'));
};
// One commit, then TWO files changed since it: two blocks to fold independently.
const scratchPair = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-diff-pair-')));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'one\ntwo\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\nalpha-change\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'one\nbeta-change\n');
  return root;
};

test('/diff opens the split panel on the tree\'s changes, folds a file and closes', async () => {
  const root = scratchTree();
  const model = new ScriptedModel();
  const ui = await bootApp(model, 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui);
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('diff · 1 file');
  expect(frame).toContain('vs HEAD');
  expect(frame).not.toContain('no changes');
  // Every file is expanded by default: the hunks are rows of their own.
  expect(frame).toContain('+changed');
  // ⏎ folds the file the cursor is on: its hunks go, the list and the chat stay.
  await ui.press('return');
  expect(ui.backend.lastFrame).not.toContain('+changed');
  expect(ui.backend.lastFrame).toContain('diff · 1 file');
  // The command toggles it too: `/diff` on an open panel closes it, as Esc does.
  await ui.type('/diff');
  await ui.press('return');
  expect(ui.backend.lastFrame).not.toContain('diff ·');
  expect(ui.backend.lastFrame).toContain('⏎ send');
  // Reopened, Esc is the other way out and the panel is gone again.
  await ui.type('/diff');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('diff · 1 file'));
  await ui.press('escape');
  expect(ui.backend.lastFrame).not.toContain('diff ·');
  expect(ui.backend.lastFrame).toContain('⏎ send');
  ui.app.unmount();
});

// A click folds the file under it — the affordance a person reaches for when a hint
// row is not enough — as a click folds a block in the conversation. The drag that
// starts on a hunk is flowtty's selection and never this: only press+release on one
// cell is a click.
test('a click on a file folds it and unfolds it, and the cursor follows the click', async () => {
  const root = scratchPair();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await ui.press('F');
  await ui.type('/diff');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('diff · 2 files'));
  // The hint row names the click beside the key: a fold nobody guesses is a fold
  // nobody uses.
  expect(ui.backend.lastFrame).toContain('click');
  const clickRow = async (name: string) => {
    const lines = ui.backend.lastFrame.split('\n');
    const y = lines.findIndex((l) => l.includes(name));
    expect(y).toBeGreaterThanOrEqual(0);
    const x = lines[y]!.indexOf(name);
    ui.backend.mouse('down', x, y);
    ui.backend.mouse('up', x, y);
    await settle(6);
  };
  // A click on the SECOND file folds it which ⏎ would not: it folds the cursor's file,
  // and the cursor follows the click.
  await clickRow('b.txt');
  expect(ui.backend.lastFrame).not.toContain('+beta-change');
  expect(ui.backend.lastFrame).toContain('+alpha-change');
  // ⏎ now works on the file the click left the cursor on: it unfolds b, not a.
  await ui.press('return');
  await settle(6);
  expect(ui.backend.lastFrame).toContain('+beta-change');
  expect(ui.backend.lastFrame).toContain('+alpha-change');
  // And a click on a hunk row is the block's too: anywhere on the file, one fold.
  await clickRow('+alpha-change');
  expect(ui.backend.lastFrame).not.toContain('+alpha-change');
  expect(ui.backend.lastFrame).toContain('+beta-change');
  ui.app.unmount();
}, 15_000);

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
  // The picker takes the conversation's place, and the panel with it. The picker draws over
  // the whole column, so the panel being absent says nothing while it is up: it is closed
  // with the picker gone that the key is seen to have closed the panel too.
  await ui.type('/diff');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('diff · 1 file'));
  ui.backend.press({ name: 's', ctrl: true });
  await settle(4);
  await ui.press('escape');
  await settle(4);
  expect(ui.backend.lastFrame).toContain('⏎ send');
  expect(ui.backend.lastFrame).not.toContain('diff ·');
  ui.app.unmount();
});

test('⏎ with the field offering continue sends it, and the panel keeps its files', async () => {
  const root = scratchTree();
  const model = new ScriptedModel();
  // A turn at the round cap: the field's own row offers `⏎ continue`, which a display must
  // not eat for a fold.
  model.script(...Array.from({ length: 2 }, () => [{ tool: 'datetime', args: {} }]), [{ text: 'Done now.' }]);
  const ui = await bootApp(model, 160, 40, undefined, { shell: { roots: [root] }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', maxRounds: 2 } }, { startDir: root });
  await openDiff(ui);
  await ui.type('work for a while');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('stopped after'));
  await settle(8);
  expect(ui.backend.lastFrame).toContain('diff · 1 file');
  expect(ui.backend.lastFrame).toMatch(/⏎ continue · \S+ new line/);
  // The hint names what ⏎ does here, and it is not a fold.
  expect(ui.backend.lastFrame).not.toContain('⏎ fold');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Done now.'));
  const sent = (model.requests.at(-1) as { messages: { role: string; content: unknown }[] }).messages;
  expect(sent.at(-1)).toEqual({ role: 'user', content: 'continue' });
  // The panel was not folded away by it: its file is still open.
  expect(ui.backend.lastFrame).toContain('diff · 1 file');
  expect(ui.backend.lastFrame).toContain('+changed');
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
  expect(ui.backend.lastFrame).toContain('diff · 1 file');
  await ui.type('run the command');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
  // The panel is still drawn under the y/n: answering is what the person does first, and
  // the panel is not what they are answering.
  expect(ui.backend.lastFrame).toContain('diff · 1 file');
  // The hint does not offer the panel's keys: the y/n has them.
  expect(ui.backend.lastFrame).not.toContain('⏎ fold');
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
  expect(ui.backend.lastFrame).toContain('diff · 1 file');
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
  const header = lines.findIndex((l) => l.includes('diff · 1 file'));
  const field = lines.findIndex((l) => l.includes('⏎ send'));
  expect(field).toBeGreaterThanOrEqual(0);
  // Below the field, never beside the conversation.
  expect(header).toBeGreaterThan(field);
  expect(lines[header]!).not.toContain('›');
  ui.app.unmount();
});

test('a click on a trail row beside the panel opens it: the rows are measured at the half', async () => {
  const root = scratchTree();
  const model = new ScriptedModel();
  // A first answer long enough to take one row at the chat's whole width and two at its
  // half, then a later turn whose call folds to a trail row under it. A click's row
  // arithmetic measures with the same wrap the screen was drawn at; with the chat's full
  // width it is a row short and the click lands past the trail.
  const long = 'A sentence long enough that the conversation half has to wrap it in two.';
  model.script(
    [{ text: long }],
    [{ tool: 'datetime', args: {} }],
    [{ text: 'Done.' }],
  );
  const ui = await bootApp(model, 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui);
  await ui.type('what day is it?');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes(long.slice(0, 40)));
  await ui.type('and now?');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Done.'));
  await settle(6);
  const at = ui.backend.lastFrame.split('\n').findIndex((l) => l.includes('+ 1 tool'));
  expect(at).toBeGreaterThanOrEqual(0);
  ui.backend.mouse('down', 12, at);
  ui.backend.mouse('up', 12, at);
  await settle(6);
  // The stretch opens under it, one record line for the call it holds, as a key would.
  expect(ui.backend.lastFrame).toMatch(/▾ \+ 1 tool/);
  expect(ui.backend.lastFrame).toMatch(/▸ ⌁ datetime · ok/);
  ui.app.unmount();
});

test('the hint offers no fold while /context takes the field', async () => {
  const root = scratchTree();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui);
  expect(ui.backend.lastFrame).toContain('⏎ fold');
  await ui.type('/context');
  await ui.press('return');
  await settle(4);
  // The panel is still beside the conversation, and the hint names the keys that have it:
  // `/context` closes on Esc or ⏎, and ⏎ folds nothing while it is up.
  expect(ui.backend.lastFrame).toContain('diff · 1 file');
  expect(ui.backend.lastFrame).not.toContain('⏎ fold');
  ui.app.unmount();
});

test('a terminal too small for either shape says so, not /mode window', async () => {
  const root = scratchTree();
  // Twelve rows of a chat in a window: the field's strip leaves the split fewer rows than
  // the conversation's least, in the one mode `/mode window` already is.
  const ui = await bootApp(new ScriptedModel(), 80, 12, undefined, { shell: { roots: [root] } }, { startDir: root });
  await ui.press('F');
  await ui.type('/diff');
  await ui.press('return');
  await settle(6);
  expect(ui.backend.lastFrame).toContain('the terminal is too small for the diff panel');
  expect(ui.backend.lastFrame).not.toContain('/mode window');
  ui.app.unmount();
});

test('a docked chat with no rows for the panel says where it can be shown', async () => {
  const root = scratchTree();
  const model = new ScriptedModel();
  // A bottom-docked chat is a dozen rows: the field's strip takes them and the split is
  // given nothing, so the panel would be open and invisible.
  const ui = await bootApp(model, 80, 24, undefined, { shell: { roots: [root] } }, { chatMode: 'panel', startDir: root });
  await ui.press('F');
  await ui.type('/diff');
  await ui.press('return');
  await settle(6);
  expect(ui.backend.lastFrame).toContain('no room for the diff panel here — /mode window');
  expect(ui.backend.lastFrame).not.toContain('diff ·');
  ui.app.unmount();
});

// ─── where the diff is looked for ─────────────────────────────────────────────
// The panel reads the repository the shell stands in, never the neighbours along the
// roots: an umbrella of repositories is what `shell.roots` is for, and a person who
// cd'd into one project asks about that project.
const scratchRepo = (dir: string, file: string, marker: string) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, file), 'one\ntwo\n');
  git(dir, 'add', file);
  git(dir, 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, file), `one\n${marker}\n`);
};
// The workspace layout: an umbrella repository with one changed file of its own and a
// repository under it, each with one changed file. Three working trees, one root.
const workspaceTree = () => {
  const umbrella = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-diff-scope-')));
  scratchRepo(umbrella, 'outer.txt', 'outer-change');
  scratchRepo(path.join(umbrella, 'projA'), 'alpha.txt', 'alpha-change');
  scratchRepo(path.join(umbrella, 'projB'), 'beta.txt', 'beta-change');
  return umbrella;
};

test('/diff outside git says there is no repository', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-diff-plain-')));
  fs.writeFileSync(path.join(root, 'note.txt'), 'hello\n');
  // A repository nested under the folder does not make the folder one: `git status`
  // says "not a git repository" here, and so does the panel — the nested tree is not
  // answered for.
  scratchRepo(path.join(root, 'repoA'), 'alpha.txt', 'alpha-change');
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await ui.press('F');
  await ui.type('/diff');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('not a git repository'));
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('not a git repository');
  // Nothing is invented for the files the directory holds: no section, no baseline.
  expect(frame).not.toContain('no changes in the working tree');
  expect(frame).not.toContain('vs snapshot');
  expect(frame).not.toContain('diff ·');
  expect(frame).not.toContain('+alpha-change');
  ui.app.unmount();
});

test('/diff shows the repository the shell is in, not its neighbours', async () => {
  const umbrella = workspaceTree();
  const model = new ScriptedModel();
  const ui = await bootApp(model, 160, 40, undefined, { shell: { roots: [umbrella] } }, { startDir: umbrella });
  await ui.press('F');
  await ui.type('/cd projA');
  await ui.press('return');
  await settle(4);
  await ui.type('/diff');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('diff ·'));
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('diff · 1 file');
  expect(frame).toContain('+alpha-change');
  // The umbrella's own change and the sibling's are not this working tree's.
  expect(frame).not.toContain('+outer-change');
  expect(frame).not.toContain('+beta-change');
  ui.app.unmount();
}, 15_000);

test('an open panel follows a cd', async () => {
  const umbrella = workspaceTree();
  const model = new ScriptedModel();
  const ui = await bootApp(model, 160, 40, undefined, { shell: { roots: [umbrella] } }, { startDir: umbrella });
  await ui.press('F');
  await ui.type('/diff');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('+beta-change'));
  // At the umbrella the panel is the umbrella's: all three trees stand beside the chat.
  expect(ui.backend.lastFrame).toContain('+outer-change');
  expect(ui.backend.lastFrame).toContain('+alpha-change');
  await ui.type('/cd projB');
  await ui.press('return');
  // The walk after the move is the new one: B's tree alone, with no key of its own. The
  // refresh is the poll's (a second, debounced), so the window is wide on purpose.
  await settleUntil(
    () => ui.backend.lastFrame.includes('+beta-change')
      && !ui.backend.lastFrame.includes('+alpha-change')
      && !ui.backend.lastFrame.includes('+outer-change'),
    8000,
  );
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('diff · 1 file');
  expect(frame).toContain('+beta-change');
  expect(frame).not.toContain('+alpha-change');
  expect(frame).not.toContain('+outer-change');
  ui.app.unmount();
}, 15_000);
