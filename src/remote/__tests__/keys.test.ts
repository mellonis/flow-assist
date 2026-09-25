import { expect, test } from 'bun:test';
import { canonicalConsume, consumes, keyEventFor } from '../keys';

test('consume is written as a person writes a binding and matched against the terminal key', () => {
  const spec = canonicalConsume(['tab', 'enter', 'esc', 'ctrl+r', 'up']);
  expect(consumes(spec, { name: 'tab' })).toBe(true);
  expect(consumes(spec, { name: 'return' })).toBe(true);
  expect(consumes(spec, { name: 'escape' })).toBe(true);
  expect(consumes(spec, { name: 'r', ctrl: true })).toBe(true);
  expect(consumes(spec, { name: 'r' })).toBe(false);
  expect(consumes(spec, { name: 'a' })).toBe(false);
});

test('printable takes what types a character; * takes everything but the mouse', () => {
  expect(consumes(canonicalConsume(['printable']), { name: 'a' })).toBe(true);
  expect(consumes(canonicalConsume(['printable']), { name: 'return' })).toBe(false);
  expect(consumes(canonicalConsume('*'), { name: 'return' })).toBe(true);
  expect(consumes(canonicalConsume('*'), { name: 'mousedown' })).toBe(false);
  expect(consumes(canonicalConsume([]), { name: 'return' })).toBe(false);
});

test('the key event carries the terminal name, the canonical id and the action the binding resolves to', () => {
  expect(keyEventFor({ name: 'return' }, { open: ['return'], next: ['ctrl+n'] })).toEqual({ name: 'return', id: 'return', action: 'open' });
  expect(keyEventFor({ name: 'n', ctrl: true }, { open: ['return'], next: ['ctrl+n'] })).toEqual({ name: 'n', id: 'ctrl+n', ctrl: true, action: 'next' });
  expect(keyEventFor({ name: 'x' }, { open: ['return'] })).toEqual({ name: 'x', id: 'x' });
});
