// The last turn's write reports as the `/diff` panel's one non-git source
// (../turn-diff.ts). Plain `ChatMsg[]` fixtures: no app, and no git — a path's root
// comes from a scratch directory holding a `.git` entry.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMsg } from '../conversation-types.ts';
import { changeView, CHANGE_DIFF_MAX_BYTES } from '../diff.ts';
import type { TurnPart } from '../step.ts';
import { lastTurnChanges } from '../turn-diff.ts';
import { diffFileKey } from '../working-tree.ts';

// ── fixture helpers ─────────────────────────────────────────────────────────
// A scratch tree under the system temp directory. Nothing here reaches a directory
// of the person's: a root is a fresh directory per test.
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'turn-diff-'));
// The root the module reports is the REAL path (a temp directory on macOS is reached
// through a link), so the tests compare against this.
const real = (p: string) => fs.realpathSync(p);
// A repository's root to `gitRootOf`: the entry's presence is all it reads.
const repoRoot = (dir: string): string => {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
};
const person = (content: string): ChatMsg => ({ role: 'user', content });
const queued = (content: string): ChatMsg => ({ role: 'user', content, midTurn: true });
const assistant = (parts: TurnPart[]): ChatMsg => ({ role: 'assistant', content: '', parts });
// A change as the record keeps it: made from the two texts a tool reported.
const change = (title: string, before: string, after: string): TurnPart => {
  const record = changeView({ title, before, after });
  if (!record) throw new Error(`fixture change ${title} changed nothing`);
  return { kind: 'change', change: record };
};
const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';

test("the last turn's reports become sections", () => {
  const tmp = tmpRoot();
  const repo = repoRoot(path.join(tmp, 'repo'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const other = repoRoot(path.join(tmp, 'other'));
  const sections = lastTurnChanges([
    person('change the files'),
    assistant([
      change(`${repo}/a.ts`, '', 'a\n'),
      change(`${repo}/src/b.ts`, '', 'b\n'),
      change(`${other}/c.ts`, '', 'c\n'),
    ]),
  ]);
  // One section per root, each holding its reports oldest first; `kind` stays absent —
  // a tree section — and `base` is empty: the header says `last turn`, not a ref.
  expect(sections.map((s) => ({ root: s.root, base: s.base, paths: s.files.map((f) => f.path) }))).toEqual([
    { root: real(repo), base: '', paths: [`${repo}/a.ts`, `${repo}/src/b.ts`] },
    { root: real(other), base: '', paths: [`${other}/c.ts`] },
  ]);
  expect(sections.map((s) => s.kind ?? 'tree')).toEqual(['tree', 'tree']);
  // The path is the title as given, never rewritten to the real path, and the hunks
  // are the record's own diff.
  expect(sections[0]!.files[0]!.path).toBe(`${repo}/a.ts`);
  expect(sections[0]!.files[0]!.hunks).toBe('@@ -0,0 +1,1 @@\n+a');
});

test('a title that is not a path is drawn, not dropped', () => {
  const sections = lastTurnChanges([
    person('update the ticket'),
    assistant([change('ABC-1 · description', 'a\n', 'b\n')]),
  ]);
  // One `reported` section for everything that is not a file, keyed by its place in
  // the turn — and carrying its hunks like any file's.
  expect(sections).toHaveLength(1);
  expect(sections[0]!.root).toBe('');
  expect(sections[0]!.base).toBe('');
  expect(sections[0]!.kind).toBe('reported');
  expect(sections[0]!.files).toEqual([{
    status: 'M',
    path: 'ABC-1 · description',
    key: '\u00000',
    added: 1,
    removed: 1,
    hunks: '@@ -1,1 +1,1 @@\n-a\n+b',
  }]);
});

test('a reported title that repeats keeps each report its own key', () => {
  const tmp = tmpRoot();
  const repo = repoRoot(path.join(tmp, 'repo'));
  const sections = lastTurnChanges([
    person('twice'),
    assistant([
      change(`${repo}/a.ts`, '', 'a\n'),
      change('ABC-1 · description', 'one\n', 'two\n'),
      change('ABC-1 · description', 'two\n', 'three\n'),
    ]),
  ]);
  // The reported group goes after the tree sections, and its rows are keyed by their
  // place among the turn's reported changes — a title may repeat.
  expect(sections.map((s) => s.kind ?? 'tree')).toEqual(['tree', 'reported']);
  expect(sections[1]!.files.map((f) => ({ path: f.path, key: f.key }))).toEqual([
    { path: 'ABC-1 · description', key: '\u00000' },
    { path: 'ABC-1 · description', key: '\u00001' },
  ]);
});

test('a path the turn reports twice keeps each report its own row and key', () => {
  const tmp = tmpRoot();
  const repo = repoRoot(path.join(tmp, 'repo'));
  const sections = lastTurnChanges([
    person('edit the file twice'),
    assistant([
      change(`${repo}/a.ts`, 'a\n', 'b\n'),
      change('ABC-1 · description', 'one\n', 'two\n'),
      change(`${repo}/a.ts`, 'b\n', 'c\n'),
    ]),
  ]);
  const root = sections.find((s) => s.kind === undefined)!.root;
  const [first, second, ...rest] = sections.find((s) => s.kind === undefined)!.files;
  expect(rest).toEqual([]);
  // The first keeps its path-derived key — the walk keys the same file by its path
  // too, so a mark carries across sources. A repeat is keyed by its place among the
  // turn's reports (the third of three), while the reported row between them keys by
  // its own place among the turn's reported changes; the root separates the two
  // namespaces. Either way, no two rows of one file share a key.
  expect(first!.key).toBeUndefined();
  expect(second!.key).toBe('\u00002');
  expect(diffFileKey(root, first!.key ?? first!.path)).not.toBe(diffFileKey(root, second!.key ?? second!.path));
  // Two writes, two hunks — reports are never merged.
  expect(first!.hunks).toBe('@@ -1,1 +1,1 @@\n-a\n+b');
  expect(second!.hunks).toBe('@@ -1,1 +1,1 @@\n-b\n+c');
  const reportedFiles = sections.find((s) => s.kind === 'reported')!.files;
  expect(reportedFiles.map((f) => f.key)).toEqual(['\u00000']);
});

test('a queued message mid-turn is not a boundary', () => {
  const sections = lastTurnChanges([
    person('first turn'),
    assistant([change('one', 'a\n', 'b\n')]),
    person('second turn'),
    assistant([change('two', 'a\n', 'b\n')]),
    queued('and while you are in there'),
    assistant([change('three', 'a\n', 'b\n')]),
  ]);
  // The first turn's report is gone; the queued row keeps the second turn open, so its
  // earlier reports stay in the same list.
  expect(sections).toHaveLength(1);
  expect(sections[0]!.files.map((f) => f.path)).toEqual(['two', 'three']);
  expect(sections[0]!.files.map((f) => f.key)).toEqual(['\u00000', '\u00001']);
});

test('a turn with no person row yet is read from the first message', () => {
  // The boundary is the person's own row; a conversation that has none yet is one
  // turn from its first message (a follow-up the inbox started has no row of its own).
  const sections = lastTurnChanges([assistant([change('notes', 'a\n', 'b\n')])]);
  expect(sections).toHaveLength(1);
  expect(sections[0]!.files.map((f) => f.path)).toEqual(['notes']);
});

test('status comes from the texts', () => {
  const tmp = tmpRoot();
  const repo = repoRoot(path.join(tmp, 'repo'));
  const sections = lastTurnChanges([
    person('write'),
    assistant([
      change(`${repo}/add.txt`, '', 'new\n'),
      change(`${repo}/gone.txt`, 'old\n', ''),
      change(`${repo}/edit.txt`, 'old\n', 'new\n'),
    ]),
  ]);
  expect(sections[0]!.files.map((f) => f.status)).toEqual(['A', 'D', 'M']);
});

test('a record the chat cut carries note "cut" and the lines it did not keep', () => {
  // One giant line puts the change over the record's byte cap: the record keeps the
  // lines up to it and counts what it dropped (`hidden`).
  const giant = 'g'.repeat(CHANGE_DIFF_MAX_BYTES + 1024);
  const sections = lastTurnChanges([
    person('write'),
    assistant([change('notes', '', `${lines(100)}${giant}\n${lines(5)}`)]),
  ]);
  const file = sections[0]!.files[0]!;
  expect(file.hidden).toBe(6);
  expect(file.note).toBe('cut');
  // Its hunks are what the record kept.
  expect(file.hunks.split('\n')).toHaveLength(101);
});

test('no reports answers no sections', () => {
  expect(lastTurnChanges([])).toEqual([]);
  expect(lastTurnChanges([person('hello'), assistant([])])).toEqual([]);
  // Never a section that would read as a clean working tree.
  expect(lastTurnChanges([person('hello'), assistant([])])).toHaveLength(0);
});
