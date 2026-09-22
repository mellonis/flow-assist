import { expect, test } from 'bun:test';
import { changeCounts, changeMarkdown, changeView, diffLineNumbers, diffRows, unifiedDiff } from '../diff';

const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';

test('one changed line in the middle of a file is one hunk with three lines of context', () => {
  const before = lines(20);
  const after = before.replace('line 10\n', 'line ten\n');
  const d = unifiedDiff(before, after);
  expect(d.added).toBe(1);
  expect(d.removed).toBe(1);
  expect(d.diff.split('\n')).toEqual([
    '@@ -7,7 +7,7 @@',
    ' line 7', ' line 8', ' line 9',
    '-line 10',
    '+line ten',
    ' line 11', ' line 12', ' line 13',
  ]);
});

test('changes far apart are separate hunks; near ones merge', () => {
  const before = lines(40);
  const far = before.replace('line 5\n', 'five\n').replace('line 30\n', 'thirty\n');
  expect(unifiedDiff(before, far).diff.split('\n').filter((l) => l.startsWith('@@'))).toEqual(['@@ -2,7 +2,7 @@', '@@ -27,7 +27,7 @@']);
  const near = before.replace('line 5\n', 'five\n').replace('line 9\n', 'nine\n');
  expect(unifiedDiff(before, near).diff.split('\n').filter((l) => l.startsWith('@@'))).toEqual(['@@ -2,11 +2,11 @@']);
});

test('a new file is all additions; a deleted one all removals', () => {
  const created = unifiedDiff('', 'a\nb\n');
  expect(created.diff.split('\n')).toEqual(['@@ -0,0 +1,2 @@', '+a', '+b']);
  const deleted = unifiedDiff('a\nb\n', '');
  expect(deleted.diff.split('\n')).toEqual(['@@ -1,2 +0,0 @@', '-a', '-b']);
});

test('inserted lines keep the lines around them as context, not as a change', () => {
  const d = unifiedDiff('a\nb\nc\n', 'a\nb\nNEW\nc\n');
  expect(d.added).toBe(1);
  expect(d.removed).toBe(0);
  expect(d.diff.split('\n')).toEqual(['@@ -1,3 +1,4 @@', ' a', ' b', '+NEW', ' c']);
});

test('a big change is cut to maxLines and says how much is hidden', () => {
  const d = unifiedDiff('', lines(500), { maxLines: 40 });
  expect(d.added).toBe(500);
  expect(d.diff.split('\n')).toHaveLength(40);
  expect(d.hidden).toBe(501 - 40); // 500 lines + the hunk header
});

test('nothing changed → no view', () => {
  expect(changeView({ title: 'a.ts', before: 'x\n', after: 'x\n' })).toBeNull();
});

test('a binary text is named, not drawn', () => {
  const v = changeView({ title: 'img.png', before: '', after: 'PNG\u0000\u0001' })!;
  expect(v.diff).toBe('');
  // The title is the chat's own row now — the path is drawn in the accent colour, not
  // as inline code — so the markdown here is the fenced block alone, and a binary has none.
  expect(changeMarkdown(v)).toBe('');
  expect(changeCounts(v)).toBe('· binary, not shown');
});

test('the markdown fence outlasts any backtick run in the diff', () => {
  const v = changeView({ title: 'README.md', before: '', after: '```ts\nx\n```\n' })!;
  const md = changeMarkdown(v);
  expect(changeCounts(v)).toBe('· +3 −0');
  expect(md.split('\n')[0]).toBe('````diff');
  expect(md.trimEnd().endsWith('\n````')).toBe(true);
});

test('a two-thousand-line rewrite stays fast and exact in its counts', () => {
  const before = lines(2000);
  const after = lines(2000, (i) => (i % 2 ? `line ${i}` : `changed ${i}`));
  const t0 = performance.now();
  const d = unifiedDiff(before, after, { maxLines: 10 });
  expect(performance.now() - t0).toBeLessThan(2000);
  expect(d.added).toBe(1000);
  expect(d.removed).toBe(1000);
});

// ─── The file's own line numbers ──────────────────────────────────────────────
// flowtty can number a fenced block's own rows, but on a diff that counts DIFF
// lines — 1, 2, 3 — which is not a number anyone wants to read. They come from the
// hunk header, and once they are there the `@@` row itself has nothing left to say.

test('a context or added row takes its number in the new file, a removed row in the old', () => {
  const before = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
  const after = 'const a = 1;\nconst b = 42;\nconst c = 3;\n';
  const v = changeView({ title: 'app.ts', before, after })!;
  expect(v.diff.split('\n')).toEqual([
    '@@ -1,3 +1,3 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 42;',
    ' const c = 3;',
  ]);
  // The removed line is line 2 of the OLD file, the added one line 2 of the NEW.
  expect(diffLineNumbers(v.diff)).toEqual(['', '1', '2', '2', '3']);
  // Drawn, the header is gone and every row carries its number.
  expect(diffRows(v.diff)).toEqual([
    { text: ' const a = 1;', no: '1' },
    { text: '-const b = 2;', no: '2' },
    { text: '+const b = 42;', no: '2' },
    { text: ' const c = 3;', no: '3' },
  ]);
  // …but the hunks stay whole in what a session keeps: they are the numbers' source.
  expect(changeMarkdown(v)).not.toContain('@@');
  expect(v.diff).toContain('@@');
});

test('a multi-hunk diff keeps counting per hunk', () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const after = before.replace('line 3\n', 'LINE 3\n').replace('line 25\n', 'LINE 25\n');
  const v = changeView({ title: 'long.txt', before, after })!;
  expect(v.diff.split('\n').filter((l) => l.startsWith('@@'))).toHaveLength(2);
  // The second hunk starts again from its own header — not from where the first left off.
  expect(diffRows(v.diff).map((r) => r.no)).toEqual([
    '1', '2', '3', '3', '4', '5', '6',
    '22', '23', '24', '25', '25', '26', '27', '28',
  ]);
});

test('a line number is never invented for a line the diff does not have', () => {
  expect(diffLineNumbers('')).toEqual([]);
  expect(diffRows('')).toEqual([]);
  // A text with a NUL is named and not drawn — no rows, and so no numbers.
  const bin = changeView({ title: 'img.png', before: '', after: 'PNG\u0000' })!;
  expect(diffRows(bin.diff)).toEqual([]);
});
