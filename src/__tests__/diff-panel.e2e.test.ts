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
  git(root, 'init', '-q', '-b', 'main');
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
const openDiff = async (ui: Awaited<ReturnType<typeof bootApp>>, openOn = 'diff · 1 file') => {
  await ui.press('F');
  await ui.type('/diff');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes(openOn));
};
// The header names what is compared against: the branch the walk resolved as the
// base — `main` in these fixtures — never a `HEAD` hardcoded in the row.
test('the panel header says what it compares against', async () => {
  const root = scratchTree();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui);
  expect(ui.backend.lastFrame).toContain('diff · 1 file +1 −1 · vs main');
  expect(ui.backend.lastFrame).not.toContain('vs HEAD');
  ui.app.unmount();
});
// One commit, then TWO files changed since it: two blocks to fold independently.
const scratchPair = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-diff-pair-')));
  git(root, 'init', '-q', '-b', 'main');
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
  expect(frame).toContain('vs main');
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
  git(dir, 'init', '-q', '-b', 'main');
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

// ─── the viewer's keys ─────────────────────────────────────────────────────────
// The keyboard over ONE walk of the panel's rows: ]/[ the hunks, ↑/↓ the file rows,
// j/k free scroll, Home/End the ends. One fixture for it — a file edited at two
// places (two hunks) and a second file with one change, a walk tall enough that
// scrolling has rows to move and a cursor move can rest on a row out of view.
const scratchWalk = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-diff-walk-')));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  const lines = Array.from({ length: 40 }, (_, i) => `a${String(i + 1).padStart(2, '0')}`);
  fs.writeFileSync(path.join(root, 'a.txt'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'b.txt'), 'b01\nb02\nb03\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  // The file is edited at two places: a line added at the top, a block rewritten
  // near the end. The two hunks are the walk's two stops on this file.
  const out = ['alpha-head', ...lines.slice(0, 21), ...Array.from({ length: 12 }, (_, i) => `tail${String(i + 1).padStart(2, '0')}`), ...lines.slice(33)];
  fs.writeFileSync(path.join(root, 'a.txt'), `${out.join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'b.txt'), 'b01\nbeta\nb03\n');
  return root;
};
// What the panel's box draws is read off the frame as a person sees it: the body's
// first visible row is under the panel's top border (the frame's last `╭`), and the
// cursor's row is the one cell drawn inverse. The grid — not the text — is what says
// which row is lit: a row's words alone cannot.
const frameLines = (ui: Awaited<ReturnType<typeof bootApp>>) => ui.backend.lastFrame.split('\n');
const cell = (ui: Awaited<ReturnType<typeof bootApp>>, x: number, y: number) =>
  (ui.backend as unknown as { lastBuffer: { get(x: number, y: number): { style: { inverse?: boolean } } } }).lastBuffer.get(x, y);
const bodyTop = (ui: Awaited<ReturnType<typeof bootApp>>) => {
  const lines = frameLines(ui);
  // The scrollbar mounts on the first scroll and paints a thumb cell of its own: for a
  // row to be "the same row" that cell is not part of the claim.
  return lines[lines.findLastIndex((l) => l.includes('╭')) + 1]!.replace(/[█░]/g, ' ');
};
const inverseAt = (ui: Awaited<ReturnType<typeof bootApp>>, text: string) => {
  const lines = frameLines(ui);
  for (let y = 0; y < lines.length; y++) {
    const x = lines[y]!.indexOf(text);
    if (x >= 0 && cell(ui, x, y)?.style?.inverse) return true;
  }
  return false;
};
// The lit row inside the panel's box, or '' when no row is lit — the cursor's own
// mark, and nothing else on the screen wears it.
const litInPanel = (ui: Awaited<ReturnType<typeof bootApp>>) => {
  const lines = frameLines(ui);
  const top = lines.findLastIndex((l) => l.includes('╭'));
  for (let y = top + 1; y < lines.length; y++) {
    if (lines[y]!.includes('╰')) return '';
    for (let x = 0; x < lines[y]!.length; x++) if (cell(ui, x, y)?.style?.inverse) return lines[y]!;
  }
  return '';
};

test('] and [ walk hunks across files', async () => {
  const root = scratchWalk();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 2 files');
  // The panel opens on the walk's first cursor position: the first file's own row.
  expect(inverseAt(ui, 'a.txt')).toBe(true);
  // Each `]` lights the next hunk's first row — across the file's two hunks and on
  // into the second file — and the drawn frame shows the lit row each time.
  await ui.press(']');
  expect(inverseAt(ui, '+alpha-head')).toBe(true);
  expect(inverseAt(ui, 'a.txt')).toBe(false);
  await ui.press(']');
  expect(inverseAt(ui, 'a19')).toBe(true);
  await ui.press(']');
  expect(inverseAt(ui, 'b01')).toBe(true);
  expect(litInPanel(ui)).toContain('b01');
  // `[` walks the same walk back.
  await ui.press('[');
  expect(inverseAt(ui, 'a19')).toBe(true);
  await ui.press('[');
  expect(inverseAt(ui, '+alpha-head')).toBe(true);
  ui.app.unmount();
}, 15_000);

test('up and down walk the file rows', async () => {
  const root = scratchWalk();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 2 files');
  // Clamped at the first file's row: ↑ has nowhere before it.
  await ui.press('up');
  expect(inverseAt(ui, 'a.txt')).toBe(true);
  await ui.press('down');
  expect(inverseAt(ui, 'b.txt')).toBe(true);
  expect(inverseAt(ui, 'a.txt')).toBe(false);
  // Clamped at the last file's row.
  await ui.press('down');
  expect(inverseAt(ui, 'b.txt')).toBe(true);
  ui.app.unmount();
}, 15_000);

test('j and k scroll without moving the cursor', async () => {
  const root = scratchWalk();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 2 files');
  const top = bodyTop(ui);
  const field = frameLines(ui).find((l) => l.includes('⏎ send · ⇧⏎'))!;
  await ui.press('j');
  // The rows moved — and the cursor's row is the same one, still lit.
  expect(bodyTop(ui)).not.toBe(top);
  expect(litInPanel(ui)).toContain('a.txt');
  await ui.press('k');
  expect(bodyTop(ui)).toBe(top);
  expect(litInPanel(ui)).toContain('a.txt');
  // The letters are the panel's: nothing of them is typed into the field.
  expect(frameLines(ui).find((l) => l.includes('⏎ send · ⇧⏎'))).toBe(field);
  ui.app.unmount();
}, 15_000);

test('home and end go to the ends of the diff', async () => {
  const root = scratchWalk();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 2 files');
  await ui.press('end');
  expect(litInPanel(ui)).toContain('b01');
  await ui.press('home');
  expect(inverseAt(ui, 'a.txt')).toBe(true);
  expect(inverseAt(ui, 'b01')).toBe(false);
  ui.app.unmount();
}, 15_000);

test('the panel takes its keys only from an empty field', async () => {
  const root = scratchWalk();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 2 files');
  const top = bodyTop(ui);
  // With an empty field the panel's keys act: `j` scrolls the rows, and nothing of it
  // is typed — the field still shows the `⏎ send` row it draws empty.
  await ui.press('j');
  expect(bodyTop(ui)).not.toBe(top);
  expect(ui.backend.lastFrame).toContain('⏎ send · ');
  expect(ui.backend.lastFrame).not.toContain('› j');
  // A draft is the field's: the same keystroke types into it and nothing scrolls.
  await ui.type('a');
  const top2 = bodyTop(ui);
  await ui.press('j');
  expect(ui.backend.lastFrame).toContain('› aj');
  expect(bodyTop(ui)).toBe(top2);
  ui.app.unmount();
}, 15_000);

test('ctrl+d pages the panel and never arms the exit', async () => {
  const root = scratchWalk();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 2 files');
  const top = bodyTop(ui);
  const consumed = ui.backend.press({ name: 'd', ctrl: true });
  await settle();
  // The half page moved the rows, and the arm never came up: this ^d is the
  // panel's, while the panel takes the keyboard.
  expect(consumed).toBe(true);
  expect(bodyTop(ui)).not.toBe(top);
  expect(ui.backend.lastFrame).not.toContain('again to exit');
  ui.app.unmount();
}, 15_000);

test('a refresh that takes the cursor\'s file leaves the panel where the person reads', async () => {
  const root = scratchWalk();
  // The file that goes away under the cursor is a NEW one — untracked, so the walk
  // lists it only while it is on disk and a deletion takes its rows with it. It sits
  // between the two changed files (`git status` orders by path), so the walk keeps
  // rows below it and the viewport has a place to stay.
  fs.writeFileSync(path.join(root, 'a2.txt'), 'x01\nx02\n');
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 3 files');
  // The cursor on that file's row: the view follows it there, and it is what the
  // person is reading when it goes away.
  await ui.press('down');
  await settleUntil(() => ui.backend.lastFrame.includes('a2.txt'));
  expect(litInPanel(ui)).toContain('a2.txt');
  const top = bodyTop(ui);
  fs.rmSync(path.join(root, 'a2.txt'));
  await settleUntil(() => !ui.backend.lastFrame.includes('a2.txt'), 8000);
  // The cursor is cleared — the row it rested on is gone — and the person's place in
  // the walk is exactly where it was: the refresh scrolled nothing.
  expect(litInPanel(ui)).toBe('');
  expect(bodyTop(ui)).toBe(top);
  ui.app.unmount();
}, 15_000);

// The first file's working-tree text with `tails` lines rewritten at its second change:
// `scratchWalk` writes 12 of them, so a test can grow and shrink that diff on disk and
// re-index every row below it while the walk re-lays them.
const walkA = (tails: number) => {
  const lines = Array.from({ length: 40 }, (_, i) => `a${String(i + 1).padStart(2, '0')}`);
  return ['alpha-head', ...lines.slice(0, 21), ...Array.from({ length: tails }, (_, i) => `tail${String(i + 1).padStart(2, '0')}`), ...lines.slice(21 + tails)].join('\n') + '\n';
};

test('a refresh that keeps the cursor leaves the panel where the person reads', async () => {
  const root = scratchWalk();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff \u00b7 2 files');
  // The cursor rests on the second file's row and the view follows it there…
  await ui.press('down');
  await settleUntil(() => ui.backend.lastFrame.includes('b.txt'));
  // …then the person scrolls away from it: the rows they read are up in the first
  // file's changes (`-a27` at their top) and the cursor's own row is off screen.
  await ui.press('k');
  expect(litInPanel(ui)).toBe('');
  const top = bodyTop(ui);
  expect(top).toContain('-a27');
  // The file ABOVE the cursor grows under the live walk — its rewritten block now
  // covers `a34`…`a36` too, three rows that only this growth draws — and every row
  // below it moves down, the cursor's row among them, while the cursor itself is the
  // same `fileKey` + hunk. The rows the person reads keep their places.
  fs.writeFileSync(path.join(root, 'a.txt'), walkA(15));
  await settleUntil(() => ui.backend.lastFrame.includes('-a34'), 8000);
  expect(bodyTop(ui)).toBe(top);
  // …and shrinks back: the same rule, the other way.
  fs.writeFileSync(path.join(root, 'a.txt'), walkA(12));
  await settleUntil(() => !ui.backend.lastFrame.includes('-a34'), 8000);
  expect(bodyTop(ui)).toBe(top);
  ui.app.unmount();
}, 20_000);

// ─── the review marks: `m` and the fold ──────────────────────────────────────
// `m` marks the file the cursor rests in REVIEWED: a `✓` on its row, its hunks out
// of the rows (marking folds) and the cursor stepped to the next file row. The
// mark is what was reviewed and the fold is display — ⏎ reopens a marked file and
// keeps its `✓`. The lead is drawn exactly: the fold glyph, the mark, the status
// and the path (`▸ ✓ M a.txt`), the counts after it.
const rowWith = (ui: Awaited<ReturnType<typeof bootApp>>, text: string) =>
  frameLines(ui).find((l) => l.includes(text)) ?? '';

test('m marks a file reviewed, folds it and steps on', async () => {
  const root = scratchPair();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 2 files');
  expect(inverseAt(ui, 'a.txt')).toBe(true);
  await ui.press('m');
  // The lead says reviewed and folded, exactly — and the file's hunks are gone from
  // the rows while the neighbour's stay.
  expect(rowWith(ui, 'a.txt')).toContain('▸ ✓ M a.txt · +1 −1');
  expect(ui.backend.lastFrame).not.toContain('+alpha-change');
  expect(ui.backend.lastFrame).toContain('+beta-change');
  // The cursor steps on: the next file row is lit.
  expect(inverseAt(ui, 'b.txt')).toBe(true);
  expect(inverseAt(ui, 'a.txt')).toBe(false);
  // The key is the panel's: none of it is typed into the field.
  expect(ui.backend.lastFrame).not.toContain('› m');
  ui.app.unmount();
}, 15_000);

test('m again reopens the file and clears the mark', async () => {
  const root = scratchPair();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 2 files');
  await ui.press('m');
  // The mark is on before it is taken off — without this the test passes on a panel
  // nothing was ever marked in.
  expect(rowWith(ui, 'a.txt')).toContain('▸ ✓ M a.txt');
  await ui.press('up');
  await ui.press('m');
  // The fold reopens and the mark goes: the row draws as it did before the review.
  expect(ui.backend.lastFrame).toContain('+alpha-change');
  expect(rowWith(ui, 'a.txt')).toContain('▾ M a.txt · +1 −1');
  expect(rowWith(ui, 'a.txt')).not.toContain('✓');
  // The person is on that file: the cursor stays where it rests.
  expect(inverseAt(ui, 'a.txt')).toBe(true);
  ui.app.unmount();
}, 15_000);

test('the mark survives a refresh', async () => {
  const root = scratchPair();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 2 files');
  await ui.press('m');
  expect(rowWith(ui, 'a.txt')).toContain('▸ ✓ M a.txt');
  // The neighbour changes under the live walk: the panel re-reads the tree and the
  // mark stays — it is keyed by the file and no walk rebuilds it.
  fs.writeFileSync(path.join(root, 'b.txt'), 'one\nbeta-change\nmore\n');
  await settleUntil(() => ui.backend.lastFrame.includes('+more'), 8000);
  expect(rowWith(ui, 'a.txt')).toContain('▸ ✓ M a.txt · +1 −1');
  expect(ui.backend.lastFrame).not.toContain('+alpha-change');
  ui.app.unmount();
}, 15_000);

test('return folds without touching the mark', async () => {
  const root = scratchPair();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 2 files');
  await ui.press('m');
  await ui.press('up');
  await ui.press('return');
  // ⏎ is the fold alone: the hunks come back and the `✓` stays — the mark is what
  // was reviewed, the fold is display.
  expect(ui.backend.lastFrame).toContain('+alpha-change');
  expect(rowWith(ui, 'a.txt')).toContain('▾ ✓ M a.txt · +1 −1');
  ui.app.unmount();
}, 15_000);

test('m marks the file the cursor rests in, and clamps at the end', async () => {
  // `scratchWalk`'s hunks start on rows the cursor lights by name (`+alpha-head`
  // for the first file, `b01` for the second), so the cursor is KNOWN to rest inside
  // a file's hunks when `m` marks that file.
  const root = scratchWalk();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 2 files');
  await ui.press(']');
  expect(inverseAt(ui, '+alpha-head')).toBe(true);
  await ui.press('m');
  expect(rowWith(ui, 'a.txt')).toContain('▸ ✓ M a.txt');
  expect(inverseAt(ui, 'b.txt')).toBe(true);
  // The last file, marked from its own hunk: the step to the next file row is
  // clamped at the end and the cursor rests on that file's own row.
  await ui.press(']');
  expect(inverseAt(ui, 'b01')).toBe(true);
  await ui.press('m');
  expect(rowWith(ui, 'b.txt')).toContain('▸ ✓ M b.txt');
  expect(ui.backend.lastFrame).not.toContain('+beta');
  expect(inverseAt(ui, 'b.txt')).toBe(true);
  ui.app.unmount();
}, 15_000);

// ─── the one-file view: `s` ──────────────────────────────────────────────────
// `s` swaps the whole list for the cursor's file alone and counts its place over
// the files (`diff · 2 of 2`). The mode follows the cursor: ↑/↓ step the file
// rows, `]` may land on the next file's hunk and `m` steps to the next file —
// the shown file is whichever file the cursor rests in. The toggle is a cursor
// move for the scroll-into-view carry: the cursor takes its file's row and the
// view follows it either way.

test('s shows one file and counts its place', async () => {
  const root = scratchPair();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 2 files');
  // The second file's row, then `s`: the header counts that file's place over the
  // two, and only that file's rows are drawn.
  await ui.press('down');
  await ui.press('s');
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('diff · 2 of 2 · vs main');
  expect(frame).toContain('b.txt');
  expect(frame).toContain('+beta-change');
  expect(frame).not.toContain('a.txt');
  expect(frame).not.toContain('+alpha-change');
  // The single header stands for the section header — never a doubled count.
  expect(frame).not.toContain('diff · 2 files');
  // The key is the panel's: none of it is typed into the field.
  expect(frame).not.toContain('› s');
  ui.app.unmount();
}, 15_000);

test('s again gives the whole list back', async () => {
  const root = scratchPair();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 2 files');
  await ui.press('down');
  await ui.press('s');
  // The mode must be SEEN before the second `s` gives anything back — a panel that
  // never took the list away passes every after-state assertion here.
  expect(ui.backend.lastFrame).toContain('diff · 2 of 2 · vs main');
  expect(ui.backend.lastFrame).not.toContain('a.txt');
  await ui.press('s');
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('diff · 2 files');
  expect(frame).toContain('a.txt');
  expect(frame).toContain('+alpha-change');
  expect(frame).toContain('b.txt');
  expect(frame).toContain('+beta-change');
  // The cursor is on the file the one-file view showed: its row, still lit.
  expect(inverseAt(ui, 'b.txt')).toBe(true);
  expect(inverseAt(ui, 'a.txt')).toBe(false);
  ui.app.unmount();
}, 15_000);

test('down keeps stepping through the files in single mode', async () => {
  const root = scratchPair();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 2 files');
  await ui.press('s');
  expect(ui.backend.lastFrame).toContain('diff · 1 of 2 · vs main');
  // ↓ steps to the next file row and the one-file view shows THAT file.
  await ui.press('down');
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('diff · 2 of 2 · vs main');
  expect(frame).toContain('b.txt');
  expect(frame).toContain('+beta-change');
  expect(frame).not.toContain('a.txt');
  expect(frame).not.toContain('+alpha-change');
  ui.app.unmount();
}, 15_000);

test('a hunk move off the shown file lands on the next file\'s hunk and the view follows', async () => {
  const root = scratchPair();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 2 files');
  await ui.press('s');
  expect(ui.backend.lastFrame).toContain('diff · 1 of 2 · vs main');
  // The first `]` takes the shown file's own hunk; the next lands on the
  // neighbour's hunk — same walk as across files, and the view follows.
  await ui.press(']');
  expect(ui.backend.lastFrame).toContain('diff · 1 of 2 · vs main');
  await ui.press(']');
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('diff · 2 of 2 · vs main');
  expect(frame).toContain('b.txt');
  expect(frame).toContain('+beta-change');
  expect(frame).not.toContain('a.txt');
  ui.app.unmount();
}, 15_000);

test('m in single mode marks the shown file and its advance shows the next', async () => {
  const root = scratchPair();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 2 files');
  await ui.press('s');
  expect(ui.backend.lastFrame).toContain('diff · 1 of 2 · vs main');
  // `m` marks the shown file reviewed: it folds and the cursor steps to the next
  // file row — which is the file the one-file view now shows.
  await ui.press('m');
  expect(ui.backend.lastFrame).toContain('diff · 2 of 2 · vs main');
  expect(ui.backend.lastFrame).toContain('+beta-change');
  expect(ui.backend.lastFrame).not.toContain('+alpha-change');
  // The last file, marked from its own row: the step is clamped and the view stays.
  await ui.press('m');
  expect(rowWith(ui, 'b.txt')).toContain('▸ ✓ M b.txt · +1 −1');
  expect(ui.backend.lastFrame).toContain('diff · 2 of 2 · vs main');
  ui.app.unmount();
}, 15_000);

test('a mode toggle takes the cursor to its file\'s row and the view follows it', async () => {
  const root = scratchWalk();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 2 files');
  // Deep in the first file: the cursor rests on its second hunk.
  await ui.press(']');
  await ui.press(']');
  expect(inverseAt(ui, 'a19')).toBe(true);
  // `s` enters the one-file view on the cursor's file — and the toggle is a cursor
  // move: the cursor takes the file's row, and the identity-keyed carry scrolls
  // that row into view where it is now drawn.
  await ui.press('s');
  expect(inverseAt(ui, 'a.txt')).toBe(true);
  expect(litInPanel(ui)).toContain('a.txt');
  // Leaving again from a hunk of the shown file is the same move the other way:
  // the whole list is back and the cursor's file row is the one on screen.
  await ui.press(']');
  expect(inverseAt(ui, '+alpha-head')).toBe(true);
  await ui.press('s');
  expect(ui.backend.lastFrame).toContain('diff · 2 files');
  expect(inverseAt(ui, 'a.txt')).toBe(true);
  expect(litInPanel(ui)).toContain('a.txt');
  ui.app.unmount();
}, 15_000);

test('a toggle scrolls the file row into view even when the cursor does not move', async () => {
  const root = scratchWalk();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 2 files');
  // The cursor stays on the first file's row while the person free-scrolls away
  // from it — j/k move the rows and leave the cursor where it is.
  for (let i = 0; i < 10; i++) await ui.press('j');
  expect(bodyTop(ui)).not.toContain('a.txt');
  expect(litInPanel(ui)).toBe('');
  // A toggle is a deliberate move-event: whatever the cursor's identity, the
  // one-file view brings the cursor's file row back under the eye.
  await ui.press('s');
  expect(bodyTop(ui)).toContain('a.txt');
  expect(litInPanel(ui)).toContain('a.txt');
  // One row up it is the one-file view — its own header is its one count. (The
  // carry lands the file row flush at the top; the header stands right above it.)
  await ui.press('k');
  expect(ui.backend.lastFrame).toContain('diff · 1 of 2 · vs main');
  expect(ui.backend.lastFrame).not.toContain('diff · 2 files');
  // The same ask the other way: scrolled away again inside the one-file view, the
  // second toggle restores the whole list AND the file row's place in it.
  for (let i = 0; i < 10; i++) await ui.press('j');
  expect(bodyTop(ui)).not.toContain('a.txt');
  await ui.press('s');
  expect(bodyTop(ui)).toContain('a.txt');
  expect(litInPanel(ui)).toContain('a.txt');
  await ui.press('k');
  expect(ui.backend.lastFrame).toContain('diff · 2 files');
  ui.app.unmount();
}, 15_000);

// ─── the source dialog and the base picker: `d` ──────────────────────────────
// `d` opens what the walk reads — the three git modes over git and the turn's own
// write reports — and, under a git source, what each top compares against. The
// fixtures name their branches on purpose: the walk's default (`main`) and the
// person's own (`master`) must both be real refs, and a remote ref gives the
// picker's `remote` group something to list.
const scratchSources = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-diff-src-')));
  git(root, 'init', '-q', '-b', 'master');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  git(root, 'branch', 'main');
  // One commit past `main` — what `committed only` draws — then one uncommitted
  // edit — what `working tree only` draws. Each source shows its own end and
  // hides the other's.
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ncommitted-change\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'branch commit');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ncommitted-change\nuncommitted-edit\n');
  git(root, 'update-ref', 'refs/remotes/origin/other', 'HEAD');
  return root;
};

test('d switches sources', async () => {
  const root = scratchSources();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui);
  // The dialog names the sources and opens on the one the walk reads now.
  await ui.press('d');
  expect(ui.backend.lastFrame).toContain('Diff source');
  expect(ui.backend.lastFrame).toContain('branch + local');
  expect(ui.backend.lastFrame).toContain('commits and local changes');
  await ui.press('down');
  await ui.press('return');
  // Committed only: the branch's own commit draws, the uncommitted edit does not.
  await settleUntil(() => ui.backend.lastFrame.includes('vs main — committed only') && !ui.backend.lastFrame.includes('uncommitted-edit'));
  const committed = ui.backend.lastFrame;
  expect(committed).toContain('vs main — committed only');
  expect(committed).toContain('+committed-change');
  expect(committed).not.toContain('uncommitted-edit');
  // Working tree only: the same tree against HEAD — the edit alone.
  await ui.press('d');
  await ui.press('down');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('vs HEAD — working tree only') && !ui.backend.lastFrame.includes('+committed-change'));
  const worktree = ui.backend.lastFrame;
  expect(worktree).toContain('vs HEAD — working tree only');
  expect(worktree).toContain('+uncommitted-edit');
  expect(worktree).not.toContain('+committed-change');
  ui.app.unmount();
}, 15_000);

test('the base picker moves the comparison', async () => {
  const root = scratchSources();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui);
  await ui.press('d');
  // Down past the four sources and the `base` group row to the top's own row.
  for (let i = 0; i < 5; i++) await ui.press('down');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Base branch'));
  // The picker lists what git holds: the local branches and the remote refs.
  expect(rowWith(ui, 'master')).toContain('master');
  expect(ui.backend.lastFrame).toContain('origin/other');
  await ui.press('down'); // past the `local` group row
  await ui.press('down'); // `master`
  await ui.press('return');
  // The walk runs against the pick: the committed change is `master`'s own now
  // and goes away with the `vs main` claim.
  await settleUntil(() => ui.backend.lastFrame.includes('· vs master') && !ui.backend.lastFrame.includes('+committed-change'));
  const moved = ui.backend.lastFrame;
  expect(moved).toContain('vs master');
  expect(moved).not.toContain('vs main');
  expect(moved).toContain('+uncommitted-edit');
  // The preference outlives the panel: /diff closed and reopened reads the same
  // base, and the dialog says so.
  await ui.type('/diff');
  await ui.press('return');
  await settle(4);
  await ui.type('/diff');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('vs master'));
  expect(ui.backend.lastFrame).not.toContain('vs main');
  await ui.press('d');
  expect(ui.backend.lastFrame).toContain('base · master');
  ui.app.unmount();
}, 15_000);

test('a repository with no default branch says so and offers the picker', async () => {
  // Zero commits: no ref resolves at all — `branch-local` never falls back to
  // HEAD, the panel words it and the dialog's base row reads `not picked`.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-diff-nobase-')));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'pick a base to compare against');
  // The wording asserted verbatim — and the cap beside it is the `diffSource`
  // binding's own, carried into the row.
  expect(ui.backend.lastFrame).toContain('pick a base to compare against');
  expect(rowWith(ui, 'pick a base to compare against')).toContain('pick a base to compare against · d');
  expect(ui.backend.lastFrame).not.toContain('vs HEAD');
  // The dialog reads the same state, and the picker is one ⏎ away from it.
  await ui.press('d');
  expect(ui.backend.lastFrame).toContain('base · not picked');
  for (let i = 0; i < 5; i++) await ui.press('down');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Base branch'));
  // The picker says what it lists, a group per side — there is no ref at all yet.
  const rows = frameLines(ui).map((l) => l.replace(/[│›]/g, ' ').trim());
  expect(rows).toContain('local');
  expect(rows).toContain('remote');
  ui.app.unmount();
}, 15_000);

test('the base row names the pick or the default in any git source', async () => {
  const root = scratchSources();
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui);
  // `working tree only` compares against HEAD — and the base row still names what
  // would compare: the top's own default where nothing was picked. `not picked`
  // means no base resolved, never "the base is inert here".
  await ui.press('d');
  await ui.press('down');
  await ui.press('down');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('vs HEAD — working tree only'));
  await ui.press('d');
  await settleUntil(() => ui.backend.lastFrame.includes('base · main'));
  expect(rowWith(ui, 'base · main')).toContain('base · main');
  // A pick wins the row in that source too.
  for (let i = 0; i < 3; i++) await ui.press('down');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Base branch'));
  await ui.press('down');
  await ui.press('down');
  await ui.press('return');
  await settle(4);
  await ui.press('d');
  await settleUntil(() => ui.backend.lastFrame.includes('base · master'));
  expect(rowWith(ui, 'base · master')).toContain('base · master');
  ui.app.unmount();
}, 15_000);

test('the base row says not picked wherever no default resolves', async () => {
  // Zero commits and one untracked file: `working tree only` draws the pile against
  // HEAD, and there is no base to name — the row says so, never a ghost default.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-diff-nobase-')));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'fresh.txt'), 'x\n');
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'pick a base to compare against');
  await ui.press('d');
  await ui.press('down');
  await ui.press('down');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('vs HEAD — working tree only'));
  await ui.press('d');
  await settleUntil(() => ui.backend.lastFrame.includes('base · not picked'));
  expect(rowWith(ui, 'base · not picked')).toContain('base · not picked');
  ui.app.unmount();
}, 15_000);

test("a source switch keeps the cursor's file and falls to the first item when it is gone", async () => {
  // Three flat files: two committed past `main` and one edited — so the sources
  // disagree about which files there are, which is what the cursor rule is about.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-diff-switch-')));
  git(root, 'init', '-q', '-b', 'master');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  for (const f of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(root, f), 'one\ntwo\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  git(root, 'branch', 'main');
  fs.writeFileSync(path.join(root, 'b.txt'), 'one\ncommitted-one\n');
  fs.writeFileSync(path.join(root, 'c.txt'), 'one\ncommitted-two\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'branch commit');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\nuncommitted-edit\n');
  const ui = await bootApp(new ScriptedModel(), 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  await openDiff(ui, 'diff · 3 files');
  await ui.press('down');
  await ui.press('down');
  expect(inverseAt(ui, 'c.txt')).toBe(true);
  // `committed only` still has c.txt — and it is the SECOND file there: a fall to
  // the first item would light b.txt instead.
  await ui.press('d');
  await ui.press('down');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('vs main — committed only') && !ui.backend.lastFrame.includes('a.txt'));
  expect(inverseAt(ui, 'c.txt')).toBe(true);
  // `working tree only` has only a.txt: the cursor's file is gone there and the
  // cursor falls on the first item of the new source.
  await ui.press('d');
  await ui.press('down');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('vs HEAD — working tree only') && !ui.backend.lastFrame.includes('+committed-'));
  expect(inverseAt(ui, 'a.txt')).toBe(true);
  ui.app.unmount();
}, 15_000);

test('last turn draws what the write tools reported', async () => {
  const root = scratchTree();
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'workspace_write', args: { path: 'artifacts/note.md', content: '# note\nhello\n' } }],
    [{ text: 'written' }],
  );
  const ui = await bootApp(model, 160, 40, undefined, { shell: { roots: [root] } }, { startDir: root });
  // A scripted write earlier in the run: its report is the source `last turn` reads.
  await ui.press('F');
  await ui.type('write the note');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('written'));
  // The chat already has the keys — `/diff` is typed into it as the command it is.
  await ui.type('/diff');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('diff · 1 file'));
  await ui.press('d');
  for (let i = 0; i < 3; i++) await ui.press('down'); // past the three git sources
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('· last turn') && rowWith(ui, 'note.md').includes('▾ A'));
  const row = rowWith(ui, 'note.md');
  // The panel's own row — the file as the tool spelled it — and its hunks beside
  // it; the working tree the git sources read is not this source's.
  expect(row).toContain('▾ A');
  expect(row).toContain('· +2 −0');
  const lead = row.indexOf('▾');
  expect(frameLines(ui).map((l) => l.slice(lead)).join('\n')).toContain('+hello');
  expect(ui.backend.lastFrame).not.toContain('+changed');
  ui.app.unmount();
}, 15_000);
