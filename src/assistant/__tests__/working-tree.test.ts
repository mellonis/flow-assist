import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffFileKey, workingTreeDiff, type FileDiff } from '../working-tree.ts';

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
const makeRepo = (dir: string, files: Record<string, string> = { 'a.txt': 'one\ntwo\n' }) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
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

test('diffFileKey names a file by its root and path, since one path repeats across roots', () => {
  expect(diffFileKey('/w/a', 'src/x.ts')).toBe('/w/a\u0000src/x.ts');
  expect(diffFileKey('/w/a', 'src/x.ts')).not.toBe(diffFileKey('/w/b', 'src/x.ts'));
  expect(diffFileKey('/w/a', 'src/x.ts')).not.toBe(diffFileKey('/w/a', 'src/y.ts'));
  expect(new Set([diffFileKey('/w/a', 'x'), diffFileKey('/w/b', 'x'), diffFileKey('/w/a', 'y')]).size).toBe(3);
});

test('a git root diffs against HEAD: modified, untracked, deleted, ignored', async () => {
  const root = tmpRoot();
  makeRepo(root, { 'a.txt': 'one\ntwo\n', 'c.txt': 'gone\n', '.gitignore': 'ignored.log\n' });
  write(root, 'a.txt', 'one\nTWO\n');
  write(root, 'b.txt', 'bee\n');
  fs.rmSync(path.join(root, 'c.txt'));
  write(root, 'ignored.log', 'never listed\n');

  const sections = await workingTreeDiff([root]);
  expect(sections).toHaveLength(1);
  expect(sections[0]!.baseline).toBe('head');
  expect(sections[0]!.label).toBe('vs HEAD');
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

  const sections = await workingTreeDiff([root]);
  expect(sections[0]!.files.map((f) => f.path).sort()).toEqual(['fresh/inner/two.txt', 'fresh/one.txt']);
  expect(sections[0]!.files.every((f) => f.status === 'A' && f.added === 1)).toBe(true);
});

test('a renamed file is one modified entry under its new path', async () => {
  const root = tmpRoot();
  makeRepo(root, { 'a.txt': 'one\ntwo\n' });
  git(root, 'mv', 'a.txt', 'moved.txt');

  const sections = await workingTreeDiff([root]);
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

  const sections = await workingTreeDiff([root]);
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

  const sections = await workingTreeDiff([root]);
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

  const sections = await workingTreeDiff([root]);
  const f = byPath(sections[0]!.files)['dump.txt']!;
  expect(f.status).toBe('M');
  expect(f.note).toBe('too large');
  expect(f.hunks).toBe('');
  expect(f.added + f.removed).toBe(0);
});

test('a repository with no commit yet still lists what is not tracked', async () => {
  const root = tmpRoot();
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  write(root, 'first.txt', 'hello\n');

  const sections = await workingTreeDiff([root]);
  expect(sections).toHaveLength(1);
  expect(sections[0]!.label).toBe('vs HEAD');
  expect(byPath(sections[0]!.files)['first.txt']!.status).toBe('A');
});

test('a repo holding a nested repo: the folder is never an added file of the outer one', async () => {
  const root = tmpRoot();
  makeRepo(root, { 'a.txt': 'one\n' });
  makeRepo(path.join(root, 'nested'), { 'n.txt': 'one\n' });
  write(root, 'a.txt', 'two\n');
  write(path.join(root, 'nested'), 'n.txt', 'two\n');

  const sections = await workingTreeDiff([root]);
  // The outer repository first (it is the root's own top), then the nested one.
  expect(sections.map((s) => s.files.map((f) => f.path))).toEqual([['a.txt'], ['nested/n.txt']]);
  expect(sections.every((s) => s.root === real(root) && s.baseline === 'head')).toBe(true);
  // `git status` reports the nested repository as `?? nested/`; a directory is never
  // an entry of the parent's section — the nested top shows its files itself.
  const outer = byPath(sections[0]!.files);
  expect(outer['nested']).toBeUndefined();
  expect(Object.keys(outer).some((p) => p.startsWith('nested/'))).toBe(false);

  // Staged as a gitlink (`A  nested`) it is still a folder, not an added file.
  git(root, 'add', 'nested');
  const afterStage = await workingTreeDiff([root]);
  expect(afterStage[0]!.files.map((f) => f.path)).toEqual(['a.txt']);
});

test('a nested repository is a section of its own, and its paths are relative to the root', async () => {
  const root = tmpRoot();
  makeRepo(path.join(root, 'sub', 'app'), { 'x.txt': 'one\n' });
  write(path.join(root, 'sub', 'app'), 'x.txt', 'two\n');
  write(root, 'notes.txt', 'a plain file outside any repository\n');

  const sections = await workingTreeDiff([root]);
  // The root has no snapshot section yet (Task 3 fills the seam), so only the
  // nested repository's section is here.
  expect(sections).toHaveLength(1);
  expect(sections[0]!.root).toBe(real(root));
  expect(sections[0]!.baseline).toBe('head');
  expect(sections[0]!.files.map((f) => f.path)).toEqual(['sub/app/x.txt']);
  expect(byPath(sections[0]!.files)['sub/app/x.txt']!.status).toBe('M');
});

test('two repositories under one root come in walk order, each in its own section', async () => {
  const root = tmpRoot();
  makeRepo(path.join(root, 'b-repo'), { 'b.txt': 'one\n' });
  makeRepo(path.join(root, 'a-repo'), { 'a.txt': 'one\n' });
  write(path.join(root, 'a-repo'), 'a.txt', 'two\n');
  write(path.join(root, 'b-repo'), 'b.txt', 'two\n');

  const sections = await workingTreeDiff([root]);
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

  const sections = await workingTreeDiff([root]);
  expect(sections).toHaveLength(1);
  expect(sections[0]!.root).toBe(real(root));
  expect(sections[0]!.files.map((f) => f.path)).toEqual(['b.txt']);
  expect(byPath(sections[0]!.files)['b.txt']!.status).toBe('M');
});

test('a root with no git top under it yields no section yet — the snapshot seam is Task 3', async () => {
  const root = tmpRoot();
  write(root, 'x.txt', 'plain\n');
  write(root, 'sub/y.txt', 'plain\n');
  // `snapshotSection` returns null until Task 3 fills it, so a directory outside
  // git contributes nothing; Task 3 turns this into a `vs snapshot` section.
  expect(await workingTreeDiff([root])).toEqual([]);
});

test('a root that is not there yields nothing and never throws', async () => {
  expect(await workingTreeDiff([path.join(tmpRoot(), 'missing')])).toEqual([]);
});
