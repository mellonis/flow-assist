import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostStateDir } from '../../config/load.ts';
import { diffFileKey, ensureSnapshot, workingTreeDiff, type FileDiff } from '../working-tree.ts';

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
// The store the module keeps for one root: `<hostStateDir()>/snapshot/<id>/`.
const storeDir = (root: string) =>
  path.join(hostStateDir(), 'snapshot', crypto.createHash('sha256').update(real(root)).digest('hex').slice(0, 16));
// The capture's ceiling is a module constant; its test-only seam lowers it so the
// cap is exercised without twenty thousand files on disk. Read through an optional
// member so the test file itself loads against an older module.
const capSeam = async (): Promise<{ setSnapshotMaxFilesForTests?: (n: number) => void }> =>
  (await import('../working-tree.ts')) as unknown as { setSnapshotMaxFilesForTests?: (n: number) => void };

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
  // The first look captures the root's snapshot baseline; nothing outside the
  // repository changed before it, so only the nested repository's section is here.
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

test('the first look at a plain root captures its baseline and draws nothing', async () => {
  const root = tmpRoot();
  write(root, 'x.txt', 'plain\n');
  write(root, 'sub/y.txt', 'plain\n');
  // A directory outside git gets a `vs snapshot` section only once something
  // differs from the baseline, and the first look is what takes that baseline.
  expect(await workingTreeDiff([root])).toEqual([]);
});

test('a plain root diffs against its first snapshot: edits, new, deleted', async () => {
  const root = tmpRoot();
  write(root, 'x.txt', 'one\n');
  write(root, 'y.txt', 'gone\n');
  write(root, 'node_modules/z.txt', 'junk\n');
  write(root, 'big.bin', Buffer.alloc(2 * 1024 * 1024 + 1, 'a'));

  const snap = await ensureSnapshot(root);
  expect(snap).not.toBeNull();
  expect(typeof snap!.taken).toBe('number');

  write(root, 'x.txt', 'one\nTWO\n');
  write(root, 'n.txt', 'new\n');
  fs.rmSync(path.join(root, 'y.txt'));

  const sections = await workingTreeDiff([root]);
  expect(sections).toHaveLength(1);
  const s = sections[0]!;
  expect(s.baseline).toBe('snapshot');
  expect(s.root).toBe(real(root));
  expect(s.label).toMatch(/^vs snapshot \(taken \d{4}-\d{2}-\d{2}\)$/);
  const by = byPath(s.files);
  expect(by['x.txt']!.status).toBe('M');
  expect(by['x.txt']!.hunks).toContain('+TWO');
  expect(by['n.txt']!.status).toBe('A');
  expect(by['n.txt']!.hunks).toContain('+new');
  expect(by['y.txt']!.status).toBe('D');
  expect(by['y.txt']!.hunks).toContain('-gone');
  expect(by['node_modules/z.txt']).toBeUndefined();
  // Over the cap at capture time and never indexed: not a change of the baseline.
  expect(by['big.bin']).toBeUndefined();
  // The section's files are sorted, so a refresh never reorders them.
  expect(s.files.map((f) => f.path)).toEqual([...s.files.map((f) => f.path)].sort());
});

test('the first capture sticks: a file changed before any later diff still reviews from the old baseline', async () => {
  const root = tmpRoot();
  write(root, 'x.txt', 'one\n');
  const first = await ensureSnapshot(root);
  const firstTaken = first!.taken;

  write(root, 'x.txt', 'changed before anyone looked');
  const again = await ensureSnapshot(root);
  expect(again!.taken).toBe(firstTaken);

  // The baseline still holds the text from the first capture, so the edit is shown.
  const s = (await workingTreeDiff([root])).find((v) => v.baseline === 'snapshot')!;
  const f = byPath(s.files)['x.txt']!;
  expect(f.status).toBe('M');
  expect(f.hunks).toContain('-one');
  expect(f.hunks).toContain('+changed before anyone looked');
});

test('a binary file whose bytes changed reads as modified and binary', async () => {
  const root = tmpRoot();
  write(root, 'data.bin', Buffer.from([0, 1, 2, 3]));
  await ensureSnapshot(root);

  write(root, 'data.bin', Buffer.from([0, 9, 9, 9]));
  const s = (await workingTreeDiff([root])).find((v) => v.baseline === 'snapshot')!;
  const f = byPath(s.files)['data.bin']!;
  expect(f.status).toBe('M');
  expect(f.note).toBe('binary');
  expect(f.hunks).toBe('');
  expect(f.added + f.removed).toBe(0);

  // A text file turned into a binary one reads the same way.
  const other = tmpRoot();
  write(other, 't.txt', 'plain\n');
  await ensureSnapshot(other);
  write(other, 't.txt', Buffer.from([0, 7, 7]));
  const s2 = (await workingTreeDiff([other])).find((v) => v.baseline === 'snapshot')!;
  expect(byPath(s2.files)['t.txt']!.status).toBe('M');
  expect(byPath(s2.files)['t.txt']!.note).toBe('binary');
});

test('a file small at capture and grown past 2 MiB reads as modified and too large', async () => {
  const root = tmpRoot();
  write(root, 'grow.txt', 'one\n');
  await ensureSnapshot(root);

  write(root, 'grow.txt', Buffer.alloc(2 * 1024 * 1024 + 1, 'b'));
  const s = (await workingTreeDiff([root])).find((v) => v.baseline === 'snapshot')!;
  const f = byPath(s.files)['grow.txt']!;
  expect(f.status).toBe('M');
  expect(f.note).toBe('too large');
  expect(f.hunks).toBe('');
  expect(f.added + f.removed).toBe(0);
});

test('a symlink is never captured and never diffed, even when it leads out of the root', async () => {
  const root = tmpRoot();
  const outside = tmpRoot();
  write(outside, 'secret.txt', "not the root's\n");
  write(root, 'a.txt', 'one\n');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  await ensureSnapshot(root);

  write(root, 'a.txt', 'two\n');
  const s = (await workingTreeDiff([root])).find((v) => v.baseline === 'snapshot')!;
  const by = byPath(s.files);
  expect(by['a.txt']!.status).toBe('M');
  expect(by['link.txt']).toBeUndefined();
  expect(s.files.map((f) => f.path)).toEqual(['a.txt']);
});

test('a nested repository keeps its paths, and the root snapshot diffs only what is left over', async () => {
  const root = tmpRoot();
  makeRepo(path.join(root, 'repo'), { 'x.txt': 'one\n' });
  write(root, 'notes.txt', 'plain\n');
  await ensureSnapshot(root);

  write(path.join(root, 'repo'), 'x.txt', 'two\n');
  const onlyRepo = await workingTreeDiff([root]);
  expect(onlyRepo.map((s) => s.baseline)).toEqual(['head']);
  expect(onlyRepo[0]!.files.map((f) => f.path)).toEqual(['repo/x.txt']);

  write(root, 'notes.txt', 'changed\n');
  const both = await workingTreeDiff([root]);
  expect(both.map((s) => s.baseline)).toEqual(['head', 'snapshot']);
  const snapshot = both.find((s) => s.baseline === 'snapshot')!;
  const by = byPath(snapshot.files);
  expect(by['notes.txt']!.status).toBe('M');
  // The repository's own paths are the repository's section alone, even though the
  // baseline was captured over them too.
  expect(by['repo/x.txt']).toBeUndefined();
  expect(snapshot.files.map((f) => f.path)).toEqual(['notes.txt']);
});

test('a corrupt index.json is captured again rather than trusted', async () => {
  const root = tmpRoot();
  write(root, 'x.txt', 'one\n');
  await ensureSnapshot(root);
  const indexPath = path.join(storeDir(root), 'index.json');

  // The store's index is rewritten after the file changed: the re-capture swallows
  // the edit, so the baseline is the text on disk now, not the one before it.
  write(root, 'x.txt', 'two\n');
  fs.writeFileSync(indexPath, 'not json at all');

  const again = await ensureSnapshot(root);
  expect(again).not.toBeNull();
  expect(() => JSON.parse(fs.readFileSync(indexPath, 'utf8'))).not.toThrow();
  expect(await workingTreeDiff([root])).toEqual([]);

  write(root, 'x.txt', 'three\n');
  const s = (await workingTreeDiff([root])).find((v) => v.baseline === 'snapshot')!;
  expect(byPath(s.files)['x.txt']!.hunks).toContain('-two');
  expect(byPath(s.files)['x.txt']!.hunks).toContain('+three');
});

test('ensureSnapshot answers null for a root that is not a directory', async () => {
  expect(await ensureSnapshot(path.join(tmpRoot(), 'missing'))).toBeNull();
  const file = path.join(tmpRoot(), 'a-file');
  fs.writeFileSync(file, 'x\n');
  expect(await ensureSnapshot(file)).toBeNull();
});

test('a root that is not there yields nothing and never throws', async () => {
  expect(await workingTreeDiff([path.join(tmpRoot(), 'missing')])).toEqual([]);
});

// ── the cap, the store's integrity, and yielding ────────────────────────────

test('a capture that stops at the cap never draws what it left out as an addition', async () => {
  const root = tmpRoot();
  for (let i = 0; i < 4; i++) write(root, `f${i}.txt`, `one ${i}\n`);
  const seam = await capSeam();
  seam.setSnapshotMaxFilesForTests?.(2);
  try {
    await ensureSnapshot(root);
    // Nothing on disk changed, so nothing is a change: the two paths the capture
    // never reached are not additions, and the cap is recorded in the index.
    expect(await workingTreeDiff([root])).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(storeDir(root), 'index.json'), 'utf8')).truncated).toBe(true);

    // An indexed file still reviews against its own bytes, and a dropped one stays out.
    write(root, 'f0.txt', 'one 0, changed\n');
    const s = (await workingTreeDiff([root])).find((v) => v.baseline === 'snapshot')!;
    const by = byPath(s.files);
    expect(by['f0.txt']!.status).toBe('M');
    expect(by['f2.txt']).toBeUndefined();
    expect(by['f3.txt']).toBeUndefined();
  } finally {
    seam.setSnapshotMaxFilesForTests?.(20_000);
  }
});

test('an index that says its capture was truncated draws no addition it cannot vouch for', async () => {
  const root = tmpRoot();
  write(root, 'kept.txt', 'one\n');
  write(root, 'dropped.txt', 'left out of the baseline\n');
  // A baseline whose capture hit the cap: `kept.txt` was indexed, `dropped.txt` was not.
  const dir = storeDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const hash = crypto.createHash('sha256').update('one\n').digest('hex');
  fs.writeFileSync(path.join(dir, hash), 'one\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
    root: real(root), taken: Date.now(), truncated: true, files: { 'kept.txt': hash },
  }));

  // A path the index does not name could be new or could be one the cap left out,
  // and a truncated baseline cannot tell them apart — so it draws neither.
  expect(await workingTreeDiff([root])).toEqual([]);

  write(root, 'kept.txt', 'one, changed\n');
  const s = (await workingTreeDiff([root])).find((v) => v.baseline === 'snapshot')!;
  const by = byPath(s.files);
  expect(by['kept.txt']!.status).toBe('M');
  expect(by['kept.txt']!.hunks).toContain('+one, changed');
  expect(by['dropped.txt']).toBeUndefined();
});

test('an index hash that is not a sha-256 file name is never followed', async () => {
  const root = tmpRoot();
  write(root, 'x.txt', 'one\n');
  await ensureSnapshot(root);
  const outside = tmpRoot();
  write(outside, 'secret.txt', 'TOPSECRET\n');

  // A hand-edited index naming a path outside the store in place of a blob hash.
  const dir = storeDir(root);
  const indexPath = path.join(dir, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  index.files['x.txt'] = path.relative(dir, path.join(outside, 'secret.txt'));
  fs.writeFileSync(indexPath, JSON.stringify(index));
  write(root, 'x.txt', 'two\n');

  // The index is corrupt, so it is not trusted: the root is captured again and the
  // file outside the store is never opened as a blob.
  const sections = await workingTreeDiff([root]);
  expect(sections).toEqual([]);
  expect(JSON.stringify(sections)).not.toContain('TOPSECRET');
});

test('an index of another root, or with a flag that is not a boolean, is captured again', async () => {
  const root = tmpRoot();
  write(root, 'x.txt', 'one\n');
  await ensureSnapshot(root);
  const indexPath = path.join(storeDir(root), 'index.json');
  const readIdx = () => JSON.parse(fs.readFileSync(indexPath, 'utf8'));

  const elsewhere = readIdx();
  elsewhere.root = real(tmpRoot());
  fs.writeFileSync(indexPath, JSON.stringify(elsewhere));
  write(root, 'x.txt', 'two\n');
  expect(await workingTreeDiff([root])).toEqual([]); // re-captured: 'two' is the baseline

  const badFlag = readIdx();
  badFlag.truncated = 'yes';
  fs.writeFileSync(indexPath, JSON.stringify(badFlag));
  write(root, 'x.txt', 'three\n');
  expect(await workingTreeDiff([root])).toEqual([]);

  // The re-captured index is sound again, so the next edit is a change.
  write(root, 'x.txt', 'four\n');
  const s = (await workingTreeDiff([root])).find((v) => v.baseline === 'snapshot')!;
  expect(byPath(s.files)['x.txt']!.hunks).toContain('-three');
  expect(byPath(s.files)['x.txt']!.hunks).toContain('+four');
});

test('files named like object members are tracked by their own entry', async () => {
  const root = tmpRoot();
  for (const name of ['__proto__', 'toString', 'hasOwnProperty', 'constructor']) write(root, name, `body of ${name}\n`);
  await ensureSnapshot(root);
  // Nothing changed: no inherited member stands in for a hash, and a path named
  // `__proto__` is an entry like any other rather than a dropped assignment.
  expect(await workingTreeDiff([root])).toEqual([]);

  // A file that appears after the capture is an addition whatever it is called.
  write(root, 'valueOf', 'new\n');
  const added = byPath((await workingTreeDiff([root])).find((v) => v.baseline === 'snapshot')!.files);
  expect(added['valueOf']!.status).toBe('A');
  expect(added['valueOf']!.hunks).toContain('+new');

  // An edit of a member-named file is a modification against its own baseline.
  write(root, '__proto__', 'changed\n');
  const by = byPath((await workingTreeDiff([root])).find((v) => v.baseline === 'snapshot')!.files);
  expect(by['__proto__']!.status).toBe('M');
  expect(by['__proto__']!.hunks).toContain('-body of __proto__');
  expect(by['__proto__']!.hunks).toContain('+changed');
  expect(by['valueOf']!.status).toBe('A');
});

test('a long capture and a long comparison both yield to the event loop', async () => {
  const root = tmpRoot();
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

  expect(await firstMove(ensureSnapshot(root), 'capture')).toEqual(['loop', 'capture']);
  for (const name of names) write(root, name, 'two\n');
  expect(await firstMove(workingTreeDiff([root]), 'diff')).toEqual(['loop', 'diff']);
});
