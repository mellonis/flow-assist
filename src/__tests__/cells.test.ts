// Widths of the host's chrome: cells per grapheme cluster, as the grid draws them.
import { expect, test } from 'bun:test';
import { cellWidth, cutStep, wrapCells } from '../cells.ts';

// A flag and a ZWJ sequence are one grapheme cluster each, two cells wide. Summed per
// code point they read as more.
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
const FLAG = '\u{1F1F7}\u{1F1FA}';

test('a line of chrome is cut to one row', () => {
  expect(cutStep('short', 20)).toBe('short');
  expect(cutStep('a very long sentence indeed', 10)).toBe('a very lo…');
  expect(Array.from(cutStep('a very long sentence indeed', 10)).length).toBe(10);
  expect(cutStep('anything', 0)).toBe('');
});

test('a cut counts the cells a character takes — a wide one two', () => {
  expect(cellWidth('漢字')).toBe(4);
  const cut = cutStep('漢字漢字漢字', 7);
  expect(cellWidth(cut)).toBeLessThanOrEqual(7);
  expect(cut.endsWith('…')).toBe(true);
  expect(cutStep('short', 20)).toBe('short');
});

test('a cut counts cells per grapheme cluster: a flag and a ZWJ sequence are two cells', () => {
  expect(cellWidth(FAMILY)).toBe(2);
  expect(cellWidth(FLAG)).toBe(2);
  expect(cellWidth(`${FAMILY} ok`)).toBe(5);
  // Fits by clusters, so it is not cut.
  expect(cutStep(`${FAMILY} ok`, 5)).toBe(`${FAMILY} ok`);
  // A cut never splits a cluster: half a flag or a dangling joiner is never left.
  expect(cutStep(`ab${FLAG}cd`, 4)).toBe('ab…');
  expect(cutStep(`ab${FAMILY}cd`, 5)).toBe(`ab${FAMILY}…`);
});

test('wrapCells splits into whole rows of clusters, never a flag, a ZWJ sequence or a wide character', () => {
  const CJK = '漢字';
  const text = `ab${FLAG}${FAMILY}${CJK}cd`;
  for (const width of [2, 3, 4, 5, 6, 7]) {
    const rows = wrapCells(text, width);
    // Nothing lost, nothing reordered — the rows are the text, split.
    expect(rows.join('')).toBe(text);
    for (const row of rows) {
      // A row never grows past its width — every cluster here (flag, family, CJK) is
      // 2 cells, so a width this generous never needs to force one past its budget.
      expect(cellWidth(row)).toBeLessThanOrEqual(width);
      // The flag is its two regional-indicator code points together or not at all —
      // a row with only one of them would mean the flag was split.
      expect(row.includes('\u{1F1F7}')).toBe(row.includes('\u{1F1FA}'));
      // A row never starts or ends mid-ZWJ-sequence (the family emoji).
      expect(row.startsWith('‍')).toBe(false);
      expect(row.endsWith('‍')).toBe(false);
    }
  }
  // A width narrower than any cluster here still makes progress rather than
  // hanging or corrupting one — the whole cluster rides its own, overflowing row.
  const tight = wrapCells(FLAG, 1);
  expect(tight).toEqual([FLAG]);
});
