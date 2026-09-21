import { expect, test } from 'bun:test';
import { changeMarkdown, changeView, unifiedDiff } from '../diff';

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
  expect(changeMarkdown(v)).toBe('✎ `img.png` · binary, not shown');
});

test('the markdown fence outlasts any backtick run in the diff', () => {
  const v = changeView({ title: 'README.md', before: '', after: '```ts\nx\n```\n' })!;
  const md = changeMarkdown(v);
  expect(md.split('\n')[0]).toBe('✎ `README.md` · +3 −0');
  expect(md.split('\n')[1]).toBe('````diff');
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
