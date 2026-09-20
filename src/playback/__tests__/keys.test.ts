import { expect, test } from 'bun:test';
import { NAMED_KEYS } from '@flowtty/core';
import { canonicalBinding, canonicalKey, isKey, resolveKeys, writtenKey } from '../keys';
import { buildKeys } from '../../loader/registry';

test('resolveKeys folds string to array and defaults to [] when missing', () => {
  const k = resolveKeys({});
  expect(Array.isArray(k.quit)).toBe(true);
  expect(k.quit).toEqual(['q']);
  // Written as ['enter', 'return']; both are the one key the terminal calls 'return'.
  expect(k.open).toEqual(['return']);
});

test('isKey matches array binding and exact name', () => {
  expect(isKey(['return', 'x'], 'return')).toBe(true);
  expect(isKey(['return'], 'x')).toBe(false);
  expect(isKey([], 'q')).toBe(false);
});

test('a binding is written in a person\'s words and compared in the terminal\'s', () => {
  expect(canonicalKey('enter')).toBe('return');
  expect(canonicalKey('Enter')).toBe('return');
  expect(canonicalKey('space')).toBe(' ');
  expect(canonicalKey('colon')).toBe(':');
  expect(canonicalKey('esc')).toBe('escape');
  expect(canonicalKey('PgUp')).toBe('pageup');
  // A single character is itself, and its case is the key: 'A' is Shift+a.
  expect(canonicalKey('A')).toBe('A');
  expect(canonicalKey('a')).toBe('a');
  expect(canonicalKey(' ')).toBe(' ');
  // The decoder's own names pass through.
  for (const name of NAMED_KEYS) expect(canonicalKey(name)).toBe(name);
  expect(canonicalBinding(['enter', 'return'])).toEqual(['return']);
  expect(canonicalBinding(undefined)).toEqual([]);
});

test('every spelling resolves to a name the decoder can produce', () => {
  // The map is only useful if its right-hand side is real. flowtty publishes the
  // list; a single character is always real.
  for (const spelled of ['enter', 'space', 'spacebar', 'colon', 'esc', 'del', 'ins', 'pgup', 'pgdn', 'pgdown', 'bs']) {
    const name = canonicalKey(spelled);
    expect(name.length === 1 || (NAMED_KEYS as readonly string[]).includes(name)).toBe(true);
  }
});

test('a plugin that writes "enter" and "space" gets Enter and the space bar', () => {
  // The tracker's table, as it is written. It REPLACES the host's `open`; spelled
  // 'enter' and compared as it stood, Enter never opened a card and Space never folded.
  const keys = buildKeys([{ name: 'acme-tracker', keys: { open: 'enter', foldSwimlane: 'space' } } as never], {});
  expect(isKey(keys.open!, 'return')).toBe(true);
  expect(isKey(keys.foldSwimlane!, ' ')).toBe(true);
  // The person's config is written the same way, and wins.
  const mine = buildKeys([{ name: 'acme-tracker', keys: { foldSwimlane: 'space' } } as never], { keys: { foldSwimlane: ['z', 'Space'] } });
  expect(mine.foldSwimlane).toEqual(['z', ' ']);
});

test('shown in words, a key reads as a person would write it', () => {
  expect(writtenKey('return')).toBe('enter');
  expect(writtenKey(' ')).toBe('space');
  expect(writtenKey('q')).toBe('q');
  // Round trip: what is shown can be typed back into the config.
  for (const name of ['return', ' ', 'escape', 'q', ':']) expect(canonicalKey(writtenKey(name))).toBe(name);
});
