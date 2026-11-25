import { expect, test } from 'bun:test';
import { changeCounts, changeMarkdown, changeView, diffLineNumbers, diffRows, diffRowGroups, fileDiffCounts, unifiedDiff, CHANGE_DIFF_MAX_BYTES, type ChangeView } from '../diff';

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

test('fileDiffCounts says the counts, or why a file is not drawn at all', () => {
  // The two notes that hide a file's hunks say their words in the counts' place.
  expect(fileDiffCounts({ added: 3, removed: 1, note: 'binary' })).toBe('· binary, not shown');
  expect(fileDiffCounts({ added: 3, removed: 1, note: 'too large' })).toBe('· too large, not shown');
  // A cut record keeps its hunks and its counts — what the record dropped is said by
  // its own note row — so it counts like a row with no note at all.
  expect(fileDiffCounts({ added: 3, removed: 0, note: 'cut' })).toBe('· +3 −0');
  expect(fileDiffCounts({ added: 3, removed: 0 })).toBe('· +3 −0');
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

// ─── The hunk groups of a walk ─────────────────────────────────────────────────
// The `/diff` panel's walk rests a cursor on each hunk's first row, so the hunks must
// exist as GROUPS — `diffRows` alone flattens them into one list.

test('diffRowGroups splits hunks at their @@ headers', () => {
  const before = lines(40);
  const after = before.replace('line 5\n', 'five\n').replace('line 30\n', 'thirty\n');
  const diff = unifiedDiff(before, after).diff;
  const groups = diffRowGroups(diff);
  expect(groups).toHaveLength(2);
  // Each group's rows are `diffRows`' rows: the `@@` row is dropped and every row
  // carries the number it has in the file.
  expect(groups.flat()).toEqual(diffRows(diff));
  expect(groups.flat().some((r) => r.text.startsWith('@@'))).toBe(false);
  // The first group's first row is the first line of hunk 1 — where its context starts.
  expect(groups[0]![0]).toEqual({ text: ' line 2', no: '2' });
  expect(groups[1]![0]).toEqual({ text: ' line 27', no: '27' });
  // Every hunk numbers its rows from its own header, not from where the last left off.
  expect(groups.map((g) => g.map((r) => r.no))).toEqual([
    ['2', '3', '4', '5', '5', '6', '7', '8'],
    ['27', '28', '29', '30', '30', '31', '32', '33'],
  ]);
  expect(diffRowGroups('')).toEqual([]);
});

// ─── The record whole, the chat's cut at draw time ─────────────────────────────
// What a session keeps is the change whole up to `CHANGE_DIFF_MAX_BYTES`, so a reader
// can walk all of it; the eighty lines the chat draws are cut where they are drawn.

test('a reported change is recorded whole and counts only what the cap drops', () => {
  const before = lines(100);
  const after = lines(99, (i) => `new ${i}`);
  const v = changeView({ title: 'big.txt', before, after })!;
  // 100 removals + 99 additions under one hunk header: 200 lines, all of them kept.
  expect(v.diff.split('\n')).toHaveLength(200);
  expect(v.hidden).toBe(0);
  expect(v.diff.split('\n').at(-1)).toBe('+new 99');

  // One giant line puts the text over the cap: the cut ends on a line boundary, so the
  // giant line and everything after it are dropped — and only those count as hidden.
  const giant = 'g'.repeat(CHANGE_DIFF_MAX_BYTES + 1024);
  const big = changeView({ title: 'huge.txt', before: '', after: `${lines(100)}${giant}\n${lines(5)}` })!;
  expect(big.hidden).toBe(6); // the giant line and the five lines after it
  expect(big.diff.split('\n')).toHaveLength(101); // the header and the 100 whole lines kept
  expect(big.diff.split('\n').at(-1)).toBe('+line 100');
});

test("changeMarkdown keeps the chat's rows and note unchanged", () => {
  const before = lines(100);
  const after = lines(99, (i) => `new ${i}`);
  const v = changeView({ title: 'big.txt', before, after })!;
  // The first 80 kept lines are drawn — the hunk header is not a row — and the note
  // counts everything past them.
  const drawn = Array.from({ length: 79 }, (_, i) => `-line ${i + 1}`).join('\n');
  expect(changeMarkdown(v)).toBe('```diff\n' + drawn + '\n```\n… 120 more lines');
  // The same note counts what the byte cap dropped into `hidden`.
  const noteOf = (md: string) => md.split('\n').at(-1)!;
  expect(noteOf(changeMarkdown({ ...v, hidden: 7 }))).toBe('… 127 more lines');
  // A record that already holds a cut — 80 lines and the rest counted in `hidden` —
  // draws every line it holds, and its own count.
  const kept = lines(80).replace(/\n$/, '');
  const old: ChangeView = { title: 'old.txt', diff: kept, added: 80, removed: 0, hidden: 7 };
  expect(changeMarkdown(old)).toBe('```diff\n' + kept + '\n```\n… 7 more lines');
});
