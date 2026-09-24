import { expect, test } from 'bun:test';
import { ARM_MS, armHint, armKeyOf, armStep } from '../exit-keys';

test('only Ctrl+C, Ctrl+D and Ctrl+Z are arm keys — not the letters, not with Alt', () => {
  expect(armKeyOf({ name: 'c', ctrl: true })).toBe('c');
  expect(armKeyOf({ name: 'd', ctrl: true })).toBe('d');
  expect(armKeyOf({ name: 'z', ctrl: true })).toBe('z');
  expect(armKeyOf({ name: 'c' })).toBeNull();
  expect(armKeyOf({ name: 'c', ctrl: true, meta: true })).toBeNull();
  expect(armKeyOf({ name: 'c', ctrl: true, shift: true })).toBeNull();
  expect(armKeyOf({ name: 'o', ctrl: true })).toBeNull();
});

test('the first press arms, the same key in time fires; late or another key arms afresh', () => {
  const a = armStep(null, 'c', 1000);
  expect(a).toEqual({ arm: { key: 'c', at: 1000 }, fire: false });
  expect(armStep(a.arm, 'c', 1000 + ARM_MS - 1)).toEqual({ arm: null, fire: true });
  expect(armStep(a.arm, 'c', 1000 + ARM_MS).fire).toBe(false);
  expect(armStep(a.arm, 'z', 1500)).toEqual({ arm: { key: 'z', at: 1500 }, fire: false });
});

test('the hint names the key and what the second press does', () => {
  expect(armHint(null)).toBe('');
  expect(armHint({ key: 'c', at: 0 })).toBe('^c again to exit');
  expect(armHint({ key: 'd', at: 0 })).toBe('^d again to exit');
  expect(armHint({ key: 'z', at: 0 })).toBe('^z again to suspend');
});
