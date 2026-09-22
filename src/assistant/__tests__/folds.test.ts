// The state a click and the key share. They cannot be allowed to disagree: the key
// opens EVERYTHING and a click opens ONE block, and after either the person must be
// able to say what the screen is showing.
import { expect, test } from 'bun:test';
import { allFolded, flipFolds, foldId, isOpen, toggleFold } from '../folds';

const a = foldId(0, 'tools');
const b = foldId(1, 'tools');

test('a conversation starts with everything folded', () => {
  const s = allFolded();
  expect(isOpen(s, a)).toBe(false);
  expect(isOpen(s, b)).toBe(false);
});

test('a click opens one block and leaves its neighbour folded', () => {
  const s = toggleFold(allFolded(), a);
  expect(isOpen(s, a)).toBe(true);
  expect(isOpen(s, b)).toBe(false);
  // …and a second click on it closes it again.
  expect(isOpen(toggleFold(s, a), a)).toBe(false);
});

test('the key opens everything — the block clicked shut included — and closes everything again', () => {
  // Everything folded but one: anything folded, so the key opens all of it.
  const clicked = toggleFold(allFolded(), a);
  const open = flipFolds(clicked);
  expect(open.open).toBe(true);
  expect(open.except.size).toBe(0);
  expect(isOpen(open, a)).toBe(true);
  expect(isOpen(open, b)).toBe(true);
  // Everything open but one, which was clicked shut: still anything folded, so the
  // key opens all of it rather than closing what is already mostly open.
  const shut = toggleFold(open, b);
  expect(isOpen(shut, b)).toBe(false);
  const again = flipFolds(shut);
  expect(isOpen(again, b)).toBe(true);
  // Nothing folded now: the key closes everything.
  const closed = flipFolds(again);
  expect(closed.open).toBe(false);
  expect(closed.except.size).toBe(0);
  expect(isOpen(closed, a)).toBe(false);
});

test('a block that did not exist yet follows the global state', () => {
  const open = flipFolds(allFolded());
  // A turn that arrives while everything is open arrives open.
  expect(isOpen(open, foldId(7, 'view', 2))).toBe(true);
  expect(isOpen(allFolded(), foldId(7, 'view', 2))).toBe(false);
});

test('the blocks of one message are told apart, and so are two messages', () => {
  const ids = [foldId(0, 'notes'), foldId(0, 'tools'), foldId(0, 'calls'), foldId(0, 'view'), foldId(0, 'view', 1), foldId(1, 'notes')];
  expect(new Set(ids).size).toBe(ids.length);
});

test('the state a click makes is a new object — the chat never mutates what it drew with', () => {
  const s = allFolded();
  const next = toggleFold(s, a);
  expect(next).not.toBe(s);
  expect(isOpen(s, a)).toBe(false);
});
