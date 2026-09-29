import { expect, test } from 'bun:test';
import { formatDuration } from '../duration.ts';

test('formatDuration: whole seconds, no fraction, one band per magnitude', () => {
  expect(formatDuration(0)).toBe('<1s');
  expect(formatDuration(999)).toBe('<1s');
  expect(formatDuration(1000)).toBe('1s');
  expect(formatDuration(59_999)).toBe('59s');
  expect(formatDuration(60_000)).toBe('1m 0s');
  expect(formatDuration(61_000)).toBe('1m 1s');
  expect(formatDuration(3_599_999)).toBe('59m 59s');
  expect(formatDuration(3_600_000)).toBe('1h 0m');
  expect(formatDuration(3_720_000)).toBe('1h 2m');
});
