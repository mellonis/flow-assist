import { expect, test } from 'bun:test';
import { bar, fit, percentText, taskGlyph, toneToken, type TTaskState } from '../parts.ts';
const w = (s: string) => Array.from(s).reduce((n, ch) => n + (/[\u3000-\u9fff]/u.test(ch) ? 2 : 1), 0);

test('bar rounds and never exceeds its width', () => {
  expect(bar(0, 10)).toBe('░░░░░░░░░░');
  expect(bar(100, 10)).toBe('██████████');
  expect(bar(75, 10)).toBe('███████░░░');
  expect(bar(140, 10)).toBe('██████████');
  expect(bar(-3, 10)).toBe('░░░░░░░░░░');
  expect(bar(50, 0)).toBe('');
});

test('percent is a whole number', () => {
  expect(percentText(75)).toBe('75%');
  expect(percentText(33.4)).toBe('33%');
  expect(percentText(Number.NaN)).toBe('0%');
});

test('task states have one glyph each', () => {
  // Typed as the union, so a state the plugin renames fails to compile here instead of
  // silently drawing the fallback glyph.
  const states: Array<TTaskState> = ['done', 'running', 'queued', 'failed'];
  expect(states.map(taskGlyph)).toEqual(['✓', '●', '○', '✗']);
});

test('tones map to palette tokens and anything else to default', () => {
  expect(toneToken('error')).toBe('error');
  expect(toneToken('#f00')).toBe('default');
  expect(toneToken(undefined)).toBe('default');
});

test('fit truncates in cells, not code units', () => {
  expect(fit('abcdef', 10, w)).toBe('abcdef');
  expect(fit('abcdefghij', 6, w)).toBe('abcde…');
  expect(fit('日本語のテキスト', 5, w)).toBe('日本…');
});
