import { expect, test } from 'bun:test';
import { keptInHistory, pushHistory } from '../prompt-history';

const commands = [{ name: 'notes' }, { name: 'login', history: false }];

test('every line is kept but a command that says history: false', () => {
  expect(keptInHistory('how far is my branch', commands)).toBe(true);
  expect(keptInHistory('/notes open', commands)).toBe(true);
  expect(keptInHistory('!pwd', commands)).toBe(true);
  expect(keptInHistory('/nots step', commands)).toBe(true); // unknown: a typo is fixed with ↑
  expect(keptInHistory('/login s3cret', commands)).toBe(false);
  expect(keptInHistory('/LOGIN s3cret', commands)).toBe(false);
  expect(keptInHistory('/login', commands)).toBe(false);
});

test('the same line twice in a row is kept once; an empty line never', () => {
  const h: string[] = [];
  expect(pushHistory(h, '/notes open')).toBe(true);
  expect(pushHistory(h, '/notes open')).toBe(false);
  expect(pushHistory(h, '')).toBe(false);
  expect(pushHistory(h, 'hi')).toBe(true);
  expect(pushHistory(h, '/notes open')).toBe(true);
  expect(h).toEqual(['/notes open', 'hi', '/notes open']);
});
