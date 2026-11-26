import { expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultBaseRef, diffFileKey, diffScopeOf, listBaseRefs, workingTreeDiff, type FileDiff } from '../working-tree.ts';

// ── scratch repositories, made by the test itself ───────────────────────────
// Nothing here reaches a repository of the person's: every root is a fresh
// directory under the system temp directory.
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
// The root the module reports is the REAL path (a temp directory on macOS is
// reached through a link), so the tests compare against this.
const real = (p: string) => fs.realpathSync(p);
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const write = (dir: string, name: string, body: string | Buffer) => {
  const abs = path.join(dir, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};
// The branch is named, never read from the machine's `init.defaultBranch`: a test's
// `vs <ref>` strings and its base resolution must not answer for the person's git
// config.
const makeRepo = (dir: string, files: Record<string, string> = { 'a.txt': 'one\ntwo\n' }, branch = 'main') => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  // The person's own git config may sign commits; a scratch repository never
  // reaches a key, and a test needs no signing.
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const [name, body] of Object.entries(files)) write(dir, name, body);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
};
const byPath = (files: FileDiff[]) => Object.fromEntries(files.map((f) => [f.path, f]));

// The batch's own git call refused while every other git call runs for real — the
// shape a batch failure takes in the wild (`git: output too large`, a stuck resource):
// `oneFile` falls back to per-file diffs and recovers what they carry. The batch is
// the one call the module makes with `--src-prefix`; a per-file diff declares no
// prefix of its own.
const failBatchDiff = <T>(fn: () => Promise<T>): Promise<T> => {
  const realSpawn = childProcess.spawn;
  const spy = spyOn(childProcess, 'spawn').mockImplementation(((cmd: string, args?: readonly string[], opts?: object) =>
    Array.isArray(args) && args.includes('--src-prefix=a/')
      ? realSpawn('sh', ['-c', 'echo "injected: the batch diff refused" >&2; exit 1'], opts)
      : realSpawn(cmd, args as string[], opts)) as typeof childProcess.spawn);
  return fn().finally(() => spy.mockRestore());
};

// A repository whose BRANCH holds a second commit and whose worktree holds an edit,
// made without ever switching branches: the starting branch keeps the second commit
// and `main` is branched at the first one (the base these tests compare against).
// `a.txt` carries each change as its own marked line, so a mode's hunks say which of
// the two it shows; `committed.txt` is added and `gone.txt` is deleted BY THE COMMIT,
// so their rows exist only where commits show.
const makeFeatureRepo = () => {
  const root = tmpRoot();
  git(root, 'init', '-q', '-b', 'feature');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, 'a.txt', 'one\ntwo\nthree\nfour\nfive\n');
  write(root, 'gone.txt', 'bye\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  git(root, 'branch', 'main');
  write(root, 'a.txt', 'one\nTWO\nthree\nfour\nfive\n'); // the branch commit's line
  write(root, 'committed.txt', 'kept\n');
  fs.rmSync(path.join(root, 'gone.txt'));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'branch commit');
  write(root, 'a.txt', 'one\nTWO\nthree\nFOUR\nfive\n'); // the uncommitted edit's line
  return root;
};

// A fixture ref name by its commit — a test plants `refs/remotes/...` as plain files,
// never with a write of git's own.
const shaOf = (cwd: string, ref: string): string => git(cwd, 'for-each-ref', '--format=%(objectname)', ref).trim();

test('diffFileKey names a file by its root and path, since one path repeats across roots', () => {
  expect(diffFileKey('/w/a', 'src/x.ts')).toBe('/w/a\u0000src/x.ts');
  expect(diffFileKey('/w/a', 'src/x.ts')).not.toBe(diffFileKey('/w/b', 'src/x.ts'));
  expect(diffFileKey('/w/a', 'src/x.ts')).not.toBe(diffFileKey('/w/a', 'src/y.ts'));
  expect(new Set([diffFileKey('/w/a', 'x'), diffFileKey('/w/b', 'x'), diffFileKey('/w/a', 'y')]).size).toBe(3);
});

// The one directory the panel reads is where the shell stands: the repository at or
// above it — so a subdirectory still shows the whole working tree, as `git status`
// does there — or the directory itself when no repository is above it.
test('diffScopeOf resolves the repository at or above the shell\'s directory', () => {
  const root = tmpRoot();
  makeRepo(root);
  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  expect(diffScopeOf(sub)).toBe(real(root));
  expect(diffScopeOf(root)).toBe(real(root));
  // A linked worktree's `.git` is a file naming its store; its own directory is the
  // scope all the same.
  const wt = path.join(root, 'wt');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ../.git/worktrees/wt\n');
  expect(diffScopeOf(wt)).toBe(real(wt));
});

test('diffScopeOf falls back to the directory itself outside any repository', () => {
  const root = tmpRoot();
  const plain = path.join(root, 'plain', 'deep');
  fs.mkdirSync(plain, { recursive: true });
  expect(diffScopeOf(plain)).toBe(real(plain));
});

// Outside git there is no baseline that would mean anything, so the walk finds no
// repository and shows no section: the panel says it is not a git repository rather
// than invent a comparison for the pile of files a plain directory holds.
test('without git the walk answers gitless and holds no section', async () => {
  const root = tmpRoot();
  write(root, 'a.txt', 'one\n');
  const res = await workingTreeDiff([root]);
  expect(res.gitless).toBe(true);
  expect(res.sections).toEqual([]);
});

// A folder that merely HOLDS repositories is not a repository itself. `git status`
// says "not a git repository" there and so does the panel: the nested tops are
// sections of their own only where the scope already stands in a repository.
test('a plain folder holding repositories is gitless, whatever is nested under it', async () => {
  const root = tmpRoot();
  const repo = path.join(root, 'repoA');
  makeRepo(repo, { 'a.txt': 'one\n' });
  write(repo, 'a.txt', 'two\n');
  const res = await workingTreeDiff([root]);
  expect(res.gitless).toBe(true);
  expect(res.failed).toBe(false);
  expect(res.sections).toEqual([]);
});

test('a repository with nothing changed is not gitless and holds no section', async () => {
  const root = tmpRoot();
  makeRepo(root);
  const res = await workingTreeDiff([root]);
  expect(res.gitless).toBe(false);
  expect(res.failed).toBe(false);
  expect(res.sections).toEqual([]);
});

// git is missing, or a top it is asked about is broken — a `.git` that is no
// repository, `index.lock` left behind, a corrupt index. That is neither a clean tree
// nor a missing repository: the walk answers `failed`, and the panel says git could
// not read it rather than claim there is nothing to show.
test('a top git cannot read answers failed, never a clean tree', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.git'));
  write(root, 'a.txt', 'one\n');
  const res = await workingTreeDiff([root]);
  expect(res.gitless).toBe(false);
  expect(res.failed).toBe(true);
  expect(res.sections).toEqual([]);
});

// The batch is one call per tree, and it alone carries the commits' own files: a clean
// file the status cannot see and no per-file call names. When git refuses the batch the
// per-file fallback recovers what it can — but a base mode then compares against a read
// it did not get, so the walk answers `failed` over the recovered rows: a partial tree
// is never drawn as the whole one. `worktree` holds exactly what the status lists, so
// there the fallback is the whole source and the walk is its own honest answer.
test('a refused batch is a failed walk in a base mode, whatever the per-file diffs recover', async () => {
  const root = makeFeatureRepo();
  write(root, 'fresh.txt', 'new\n');

  const under = await failBatchDiff(() => workingTreeDiff([root], { base: 'main', mode: 'branch-local' }));
  // The per-file fallback recovered the rows it can reach on its own.
  const recovered = byPath(under.sections[0]!.files);
  expect(recovered['a.txt']!.hunks).toContain('+TWO');
  expect(recovered['a.txt']!.hunks).toContain('+FOUR');
  expect(recovered['fresh.txt']!.status).toBe('A');
  // The batch's own rows are gone from the read — the commits' clean and deleted files.
  expect(recovered['committed.txt']).toBeUndefined();
  expect(recovered['gone.txt']).toBeUndefined();
  // and the walk says so rather than draw the rest as the whole tree.
  expect(under.failed).toBe(true);

  const committed = await failBatchDiff(() => workingTreeDiff([root], { base: 'main', mode: 'committed' }));
  expect(committed.failed).toBe(true);

  const worktree = await failBatchDiff(() => workingTreeDiff([root], { mode: 'worktree' }));
  const byWorktree = byPath(worktree.sections[0]!.files);
  expect(byWorktree['a.txt']!.hunks).toContain('+FOUR');
  expect(worktree.failed).toBe(false);
});

test('a git root diffs against its base: modified, untracked, deleted, ignored', async () => {
  const root = tmpRoot();
  makeRepo(root, { 'a.txt': 'one\ntwo\n', 'c.txt': 'gone\n', '.gitignore': 'ignored.log\n' });
  write(root, 'a.txt', 'one\nTWO\n');
  write(root, 'b.txt', 'bee\n');
  fs.rmSync(path.join(root, 'c.txt'));
  write(root, 'ignored.log', 'never listed\n');

  const { sections } = await workingTreeDiff([root]);
  expect(sections).toHaveLength(1);
  expect(sections[0]!.root).toBe(real(root));

  const by = byPath(sections[0]!.files);
  expect(by['a.txt']!.status).toBe('M');
  expect(by['a.txt']!.added).toBe(1);
  expect(by['a.txt']!.removed).toBe(1);
  expect(by['a.txt']!.added + by['a.txt']!.removed).toBeGreaterThan(0);
  // The hunks are the unified diff text, without git's own file headers.
  expect(by['a.txt']!.hunks).toContain('@@ -1,2 +1,2 @@');
  expect(by['a.txt']!.hunks).toContain('-two');
  expect(by['a.txt']!.hunks).toContain('+TWO');
  expect(by['a.txt']!.hunks).not.toContain('diff --git');

  // An untracked file reads as added, diffed from empty text.
  expect(by['b.txt']!.status).toBe('A');
  expect(by['b.txt']!.added).toBe(1);
  expect(by['b.txt']!.removed).toBe(0);
  expect(by['b.txt']!.hunks).toContain('+bee');

  // A deleted tracked file keeps the removed lines of what it held.
  expect(by['c.txt']!.status).toBe('D');
  expect(by['c.txt']!.added).toBe(0);
  expect(by['c.txt']!.removed).toBe(1);
  expect(by['c.txt']!.hunks).toContain('-gone');

  expect(by['ignored.log']).toBeUndefined();
});

test('an untracked directory is listed file by file', async () => {
  const root = tmpRoot();
  makeRepo(root);
  write(root, 'fresh/one.txt', 'one\n');
  write(root, 'fresh/inner/two.txt', 'two\n');

  const { sections } = await workingTreeDiff([root]);
  expect(sections[0]!.files.map((f) => f.path).sort()).toEqual(['fresh/inner/two.txt', 'fresh/one.txt']);
  expect(sections[0]!.files.every((f) => f.status === 'A' && f.added === 1)).toBe(true);
});

test('a renamed file is one modified entry under its new path', async () => {
  const root = tmpRoot();
  makeRepo(root, { 'a.txt': 'one\ntwo\n' });
  git(root, 'mv', 'a.txt', 'moved.txt');

  const { sections } = await workingTreeDiff([root]);
  const by = byPath(sections[0]!.files);
  expect(by['a.txt']).toBeUndefined();
  expect(by['moved.txt']!.status).toBe('M');
  expect(by['moved.txt']!.added + by['moved.txt']!.removed).toBe(0); // a pure rename changes no line
});

test('a binary file is noted, never diffed', async () => {
  const root = tmpRoot();
  makeRepo(root, { 'a.bin': 'text\n' });
  write(root, 'a.bin', Buffer.from([0, 1, 2, 3, 4]));
  write(root, 'new.bin', Buffer.from([0, 9, 0, 9]));
  write(root, 'latin1.txt', Buffer.from([0xff, 0xfe, 0x61])); // not UTF-8, and no NUL

  const { sections } = await workingTreeDiff([root]);
  const by = byPath(sections[0]!.files);
  expect(by['a.bin']!.status).toBe('M');
  expect(by['a.bin']!.note).toBe('binary');
  expect(by['a.bin']!.hunks).toBe('');
  expect(by['a.bin']!.added + by['a.bin']!.removed).toBe(0);
  expect(by['new.bin']!.status).toBe('A');
  expect(by['new.bin']!.note).toBe('binary');
  expect(by['latin1.txt']!.note).toBe('binary');
});

test('a file over 2 MiB is noted as too large, never read', async () => {
  const root = tmpRoot();
  makeRepo(root);
  write(root, 'big.txt', Buffer.alloc(2 * 1024 * 1024 + 1, 'a'));

  const { sections } = await workingTreeDiff([root]);
  const by = byPath(sections[0]!.files);
  expect(by['big.txt']!.status).toBe('A');
  expect(by['big.txt']!.note).toBe('too large');
  expect(by['big.txt']!.hunks).toBe('');
  expect(by['big.txt']!.added + by['big.txt']!.removed).toBe(0);
});

test('a tracked file grown past 2 MiB is noted as too large instead of diffed', async () => {
  const root = tmpRoot();
  makeRepo(root, { 'dump.txt': 'one\n' });
  write(root, 'dump.txt', Buffer.alloc(2 * 1024 * 1024 + 1, 'b'));

  const { sections } = await workingTreeDiff([root]);
  const f = byPath(sections[0]!.files)['dump.txt']!;
  expect(f.status).toBe('M');
  expect(f.note).toBe('too large');
  expect(f.hunks).toBe('');
  expect(f.added + f.removed).toBe(0);
});

test('a repository with no commit yet still lists what is not tracked', async () => {
  const root = tmpRoot();
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  write(root, 'first.txt', 'hello\n');

  // The working-tree source compares against the last commit and needs no base: an
  // unborn HEAD is honest there, and the untracked pile is what it draws.
  const { sections } = await workingTreeDiff([root], { mode: 'worktree' });
  expect(sections).toHaveLength(1);
  expect(sections[0]!.base).toBe('HEAD');
  expect(byPath(sections[0]!.files)['first.txt']!.status).toBe('A');
});

// A source that names a base cannot run on a repository that names no default branch
// — and it never pretends HEAD is the base. The section is answered with an empty base
// and no files, and the panel words it (`pick a base to compare against`).
test('a top with no resolvable base answers an empty section, never a silent HEAD', async () => {
  const root = tmpRoot();
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  write(root, 'first.txt', 'hello\n');

  const res = await workingTreeDiff([root]);
  expect(res.gitless).toBe(false);
  expect(res.failed).toBe(false);
  expect(res.sections).toHaveLength(1);
  expect(res.sections[0]!.base).toBe('');
  expect(res.sections[0]!.files).toEqual([]);
});

test('a repo holding a nested repo: the folder is never an added file of the outer one', async () => {
  const root = tmpRoot();
  makeRepo(root, { 'a.txt': 'one\n' });
  makeRepo(path.join(root, 'nested'), { 'n.txt': 'one\n' });
  write(root, 'a.txt', 'two\n');
  write(path.join(root, 'nested'), 'n.txt', 'two\n');

  const { sections } = await workingTreeDiff([root]);
  // The outer repository first (it is the root's own top), then the nested one.
  expect(sections.map((s) => s.files.map((f) => f.path))).toEqual([['a.txt'], ['nested/n.txt']]);
  expect(sections.every((s) => s.root === real(root))).toBe(true);
  // `git status` reports the nested repository as `?? nested/`; a directory is never
  // an entry of the parent's section — the nested top shows its files itself.
  const outer = byPath(sections[0]!.files);
  expect(outer['nested']).toBeUndefined();
  expect(Object.keys(outer).some((p) => p.startsWith('nested/'))).toBe(false);

  // Staged as a gitlink (`A  nested`) it is still a folder, not an added file.
  git(root, 'add', 'nested');
  const { sections: afterStage } = await workingTreeDiff([root]);
  expect(afterStage[0]!.files.map((f) => f.path)).toEqual(['a.txt']);
});

test('a nested repository is a section of its own, and its paths are relative to the root', async () => {
  const root = tmpRoot();
  makeRepo(root, { 'notes.txt': 'kept by the outer repository\n' });
  makeRepo(path.join(root, 'sub', 'app'), { 'x.txt': 'one\n' });
  write(path.join(root, 'sub', 'app'), 'x.txt', 'two\n');

  const { sections } = await workingTreeDiff([root]);
  // The outer repository changed nothing of its own, so only the nested repository's
  // section is here; its paths are relative to the root the panel was given.
  expect(sections).toHaveLength(1);
  expect(sections[0]!.root).toBe(real(root));
  expect(sections[0]!.files.map((f) => f.path)).toEqual(['sub/app/x.txt']);
  expect(byPath(sections[0]!.files)['sub/app/x.txt']!.status).toBe('M');
});

test('two repositories under one root come in walk order, each in its own section', async () => {
  const root = tmpRoot();
  // The root is a repository itself — outside git nothing is walked at all (the rule
  // the plain-folder test above pins). It changes nothing of its own.
  makeRepo(root, { 'r.txt': 'one\n' });
  makeRepo(path.join(root, 'b-repo'), { 'b.txt': 'one\n' });
  makeRepo(path.join(root, 'a-repo'), { 'a.txt': 'one\n' });
  write(path.join(root, 'a-repo'), 'a.txt', 'two\n');
  write(path.join(root, 'b-repo'), 'b.txt', 'two\n');

  const { sections } = await workingTreeDiff([root]);
  expect(sections).toHaveLength(2);
  expect(sections.map((s) => s.files.map((f) => f.path))).toEqual([['a-repo/a.txt'], ['b-repo/b.txt']]);
  expect(sections.every((s) => s.root === real(root))).toBe(true);
});

test('a root inside a repository belongs to that repository, and shows only its own paths', async () => {
  const repo = tmpRoot();
  makeRepo(repo, { 'a.txt': 'one\n', 'deep/b.txt': 'one\n' });
  const root = path.join(repo, 'deep');
  write(repo, 'a.txt', 'two\n'); // changed outside the root: not this section's
  write(root, 'b.txt', 'two\n');

  const { sections } = await workingTreeDiff([root]);
  expect(sections).toHaveLength(1);
  expect(sections[0]!.root).toBe(real(root));
  expect(sections[0]!.files.map((f) => f.path)).toEqual(['b.txt']);
  expect(byPath(sections[0]!.files)['b.txt']!.status).toBe('M');
});

test('a root that is not there yields nothing and never throws', async () => {
  const res = await workingTreeDiff([path.join(tmpRoot(), 'missing')]);
  expect(res.sections).toEqual([]);
  // A directory that is not there is no repository either: nothing was read and
  // nothing failed.
  expect(res.gitless).toBe(true);
  expect(res.failed).toBe(false);
});

// ── yielding ────────────────────────────────────────────────────────────────

test('a long walk yields to the event loop', async () => {
  const root = tmpRoot();
  // Outside git nothing is walked, so the work under test needs a repository to walk.
  makeRepo(root, { 'seed.txt': 'seed\n' });
  const names = Array.from({ length: 250 }, (_, i) => `f${String(i).padStart(3, '0')}.txt`);
  for (const name of names) write(root, name, 'one\n');

  // A macrotask registered before the work resumes only after the work yields: with
  // the loop held for the whole walk, a frame could never be painted meanwhile.
  const firstMove = async (work: Promise<unknown>, tag: string): Promise<string[]> => {
    const order: string[] = [];
    const loopTurn = new Promise<void>((resolve) => setImmediate(() => { order.push('loop'); resolve(); }));
    await Promise.all([work.then(() => { order.push(tag); }), loopTurn]);
    return order;
  };

  expect(await firstMove(workingTreeDiff([root]), 'walk')).toEqual(['loop', 'walk']);
});

// ── a base and three modes ──────────────────────────────────────────────────

test('each mode is one walk against its own base', async () => {
  const root = makeFeatureRepo();

  // `branch-local`: the local changes AND the commits since the base — the branch
  // commit's two rows and both of `a.txt`'s change pairs.
  const all = await workingTreeDiff([root], { base: 'main', mode: 'branch-local' });
  expect(all.sections).toHaveLength(1);
  expect(all.sections[0]!.base).toBe('main');
  expect(all.sections[0]!.kind).toBeUndefined();
  const byAll = byPath(all.sections[0]!.files);
  expect(Object.keys(byAll).sort()).toEqual(['a.txt', 'committed.txt', 'gone.txt']);
  expect(byAll['a.txt']!.hunks).toContain('+TWO');
  expect(byAll['a.txt']!.hunks).toContain('+FOUR');
  expect(byAll['committed.txt']!.status).toBe('A');
  expect(byAll['committed.txt']!.hunks).toContain('+kept');
  expect(byAll['gone.txt']!.status).toBe('D');
  expect(byAll['gone.txt']!.hunks).toContain('-bye');

  // `committed`: only the branch commit — the uncommitted edit's line is hidden.
  const committedOnly = await workingTreeDiff([root], { base: 'main', mode: 'committed' });
  expect(committedOnly.sections).toHaveLength(1);
  expect(committedOnly.sections[0]!.base).toBe('main');
  const byCommitted = byPath(committedOnly.sections[0]!.files);
  expect(Object.keys(byCommitted).sort()).toEqual(['a.txt', 'committed.txt', 'gone.txt']);
  expect(byCommitted['a.txt']!.hunks).toContain('+TWO');
  expect(byCommitted['a.txt']!.hunks).not.toContain('+FOUR');
  expect(byCommitted['committed.txt']!.status).toBe('A');
  expect(byCommitted['gone.txt']!.status).toBe('D');

  // `worktree`: only the uncommitted edit — the branch commit's lines are hidden.
  const worktreeOnly = await workingTreeDiff([root], { mode: 'worktree' });
  expect(worktreeOnly.sections).toHaveLength(1);
  expect(worktreeOnly.sections[0]!.base).toBe('HEAD');
  const byWorktree = byPath(worktreeOnly.sections[0]!.files);
  expect(Object.keys(byWorktree)).toEqual(['a.txt']);
  expect(byWorktree['a.txt']!.hunks).toContain('+FOUR');
  expect(byWorktree['a.txt']!.hunks).not.toContain('+TWO');
});

test('untracked files stay added where local changes show and are absent from committed', async () => {
  const root = makeFeatureRepo();
  write(root, 'fresh.txt', 'new\n');

  // The default source is `branch-local`; untracked files ride along as added.
  const all = await workingTreeDiff([root], { base: 'main' });
  expect(byPath(all.sections[0]!.files)['fresh.txt']).toMatchObject({ status: 'A', added: 1 });
  const worktreeOnly = await workingTreeDiff([root], { mode: 'worktree' });
  expect(byPath(worktreeOnly.sections[0]!.files)['fresh.txt']!.status).toBe('A');
  // The committed source never lists one: it is not part of any commit.
  const committedOnly = await workingTreeDiff([root], { base: 'main', mode: 'committed' });
  expect(byPath(committedOnly.sections[0]!.files)['fresh.txt']).toBeUndefined();
});

test('a nested repository is its own top with its own base', async () => {
  const root = tmpRoot();
  makeRepo(root, { 'notes.txt': 'kept by the outer repository\n' });
  makeRepo(path.join(root, 'sub', 'app'), { 'x.txt': 'one\n' }, 'appmain');
  write(path.join(root, 'sub', 'app'), 'x.txt', 'two\n');
  write(root, 'notes.txt', 'changed\n');

  // The lookup is asked once per top — a nested repository resolves its own base —
  // and each walk compares against only the ref its top answered.
  const asked: string[] = [];
  const { sections } = await workingTreeDiff([root], {
    base: (top) => {
      asked.push(top);
      return path.basename(top) === 'app' ? 'appmain' : 'main';
    },
  });
  expect(asked).toEqual([real(root), real(path.join(root, 'sub', 'app'))]);
  expect(sections.map((s) => s.files.map((f) => f.path))).toEqual([['notes.txt'], ['sub/app/x.txt']]);
  expect(sections.map((s) => s.base)).toEqual(['main', 'appmain']);
});

test('defaultBaseRef resolves the default branch and admits when it cannot', async () => {
  // A clone's `origin/HEAD` naming `origin/main` answers its tail.
  const cloned = tmpRoot();
  makeRepo(cloned);
  write(cloned, '.git/refs/remotes/origin/main', `${shaOf(cloned, 'refs/heads/main')}\n`);
  write(cloned, '.git/refs/remotes/origin/HEAD', 'ref: refs/remotes/origin/main\n');
  expect(await defaultBaseRef(real(cloned))).toBe('main');

  // No `origin/HEAD`: `main` when it exists, else `master` when it exists.
  const oldStyle = tmpRoot();
  makeRepo(oldStyle, { 'a.txt': 'one\n' }, 'master');
  expect(await defaultBaseRef(real(oldStyle))).toBe('master');

  // An unborn `main` (zero commits) is not a ref.
  const unborn = tmpRoot();
  fs.mkdirSync(unborn, { recursive: true });
  git(unborn, 'init', '-q', '-b', 'main');
  expect(await defaultBaseRef(real(unborn))).toBe(null);

  // Neither name exists — it admits that, and never shrugs to HEAD.
  const trunk = tmpRoot();
  makeRepo(trunk, { 'a.txt': 'one\n' }, 'trunk');
  expect(await defaultBaseRef(real(trunk))).toBe(null);
});

test('listBaseRefs lists local and remote branches', async () => {
  const root = tmpRoot();
  makeRepo(root, { 'a.txt': 'one\n' });
  git(root, 'branch', 'feature');
  write(root, '.git/refs/remotes/origin/other', `${shaOf(root, 'refs/heads/main')}\n`);

  expect(await listBaseRefs(real(root))).toEqual({ local: ['feature', 'main'], remote: ['origin/other'] });
});

// `origin/HEAD` is a file a fetch wrote, not a promise it kept: its tail names a ref,
// and a ref that is not there is no base. `git diff` against it would fail on a tree
// git read just fine — the honest answer is the fall-through or no base at all, never
// `failed`.
test('a dangling origin/HEAD never reads as a failed walk', async () => {
  // The tail is gone but a branch survives: that branch is the base.
  const survivor = tmpRoot();
  makeRepo(survivor, { 'a.txt': 'one\n' }, 'master');
  git(survivor, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');
  write(survivor, 'a.txt', 'two\n');
  expect(await defaultBaseRef(real(survivor))).toBe('master');
  const walked = await workingTreeDiff([survivor]);
  expect(walked.failed).toBe(false);
  expect(walked.sections).toHaveLength(1);
  expect(walked.sections[0]!.base).toBe('master');
  expect(byPath(walked.sections[0]!.files)['a.txt']!.status).toBe('M');

  // Nothing survives: the panel gets the picker's section (no base, no files) and the
  // walk answers for the tree it READ — never `failed`.
  const bare = tmpRoot();
  fs.mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '-b', 'main');
  git(bare, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');
  write(bare, 'first.txt', 'hello\n');
  expect(await defaultBaseRef(real(bare))).toBe(null);
  const noBase = await workingTreeDiff([bare]);
  expect(noBase.gitless).toBe(false);
  expect(noBase.failed).toBe(false);
  expect(noBase.sections).toHaveLength(1);
  expect(noBase.sections[0]!.base).toBe('');
  expect(noBase.sections[0]!.files).toEqual([]);
});

// What the mode's diff carries is what that mode shows: a file the commit touched and
// the worktree then deleted is the COMMIT's change under `committed` and the
// base-to-gone deletion under `branch-local` — the worktree's deletion is never the
// committed source's answer, and a deletion always reads against the ref the mode
// names.
test('the mode\'s diff is what a file shows even where the worktree deleted it', async () => {
  const root = tmpRoot();
  git(root, 'init', '-q', '-b', 'feature');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, 'x.txt', 'one\ntwo\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  git(root, 'branch', 'main');
  write(root, 'x.txt', 'one\ntwo\nthree\n'); // the branch commit adds a line
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'branch commit');
  fs.rmSync(path.join(root, 'x.txt')); // the worktree then deletes the file

  // `committed` draws the commit's own hunks — the addition — and calls the file
  // modified, never the deletion the worktree made.
  const committedOnly = await workingTreeDiff([root], { base: 'main', mode: 'committed' });
  const shown = byPath(committedOnly.sections[0]!.files)['x.txt']!;
  expect(shown.status).toBe('M');
  expect(shown.added).toBe(1);
  expect(shown.removed).toBe(0);
  expect(shown.hunks).toContain('+three');

  // `branch-local` removes what the BASE held (two lines) — never what the commit's
  // edit made of the file (its third line).
  const all = await workingTreeDiff([root], { base: 'main', mode: 'branch-local' });
  const gone = byPath(all.sections[0]!.files)['x.txt']!;
  expect(gone.status).toBe('D');
  expect(gone.added).toBe(0);
  expect(gone.removed).toBe(2);
  expect(gone.hunks).toContain('-two');
  expect(gone.hunks).not.toContain('-three');

  // `worktree` draws the deletion it is: HEAD's three lines, gone.
  const worktreeOnly = await workingTreeDiff([root], { mode: 'worktree' });
  const deleted = byPath(worktreeOnly.sections[0]!.files)['x.txt']!;
  expect(deleted.status).toBe('D');
  expect(deleted.removed).toBe(3);
  expect(deleted.hunks).toContain('-three');
});

// The caller's `base` is ONE ref — the name a picker fed — and a ref that is not
// there is not trusted: the walk falls to the top's default branch (and its label
// says so), and where nothing resolves it answers the empty section the panel words —
// never `failed`, never a clean claim over a comparison that never ran.
test('a caller base that is gone falls through to the default, or to the empty section', async () => {
  // A dirty top: the default branch takes the comparison and names itself in `base`.
  const dirty = tmpRoot();
  makeRepo(dirty, { 'a.txt': 'one\n' });
  write(dirty, 'a.txt', 'two\n');
  const walked = await workingTreeDiff([dirty], { base: 'gone' });
  expect(walked.failed).toBe(false);
  expect(walked.sections).toHaveLength(1);
  expect(walked.sections[0]!.base).toBe('main');
  expect(byPath(walked.sections[0]!.files)['a.txt']!.status).toBe('M');

  // A clean top with no default branch at all: the empty section — the change list is
  // honestly empty because NOTHING WAS COMPARED, not because the tree is clean.
  const bare = tmpRoot();
  makeRepo(bare, { 'a.txt': 'one\n' }, 'trunk');
  const noBase = await workingTreeDiff([bare], { base: 'gone' });
  expect(noBase.gitless).toBe(false);
  expect(noBase.failed).toBe(false);
  expect(noBase.sections).toHaveLength(1);
  expect(noBase.sections[0]!.base).toBe('');
  expect(noBase.sections[0]!.files).toEqual([]);
});
