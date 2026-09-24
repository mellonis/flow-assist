import { expect, test } from 'bun:test';
import { NAMED_KEYS } from '@flowtty/core';
import { parseKeypress } from '@flowtty/tty-backend';
import { bindingGlyph, canonicalBinding, canonicalKey, firstGlyph, isKey, keyGlyph, keyId, resolveKeys, writtenKey } from '../keys';
import { buildKeys } from '../../loader/registry';

test('Ctrl with ] \\ ^ _ is a chord as the decoder names it, and a binding meets it', () => {
  // The decoder names the control bytes 0x1c–0x1f as the key held with Ctrl.
  expect(keyId({ name: ']', ctrl: true })).toBe('ctrl+]');
  expect(canonicalKey('ctrl+]')).toBe('ctrl+]');
  expect(canonicalKey('^]')).toBe('ctrl+]');
  expect(isKey(canonicalBinding('ctrl+]'), { name: ']', ctrl: true })).toBe(true);
  expect(isKey(canonicalBinding('ctrl+\\'), { name: '\\', ctrl: true })).toBe(true);
  expect(keyGlyph({ name: ']', ctrl: true })).toBe('^]');
  expect(bindingGlyph('ctrl+\\')).toBe('^\\');
  // A bare ] is still a ].
  expect(keyId({ name: ']' })).toBe(']');
  // What the TTY backend's own decoder makes of the bytes a terminal sends.
  const [focus] = parseKeypress('\x1d');
  const [collapse] = parseKeypress('\x1c');
  expect(isKey(canonicalBinding('ctrl+]'), focus!)).toBe(true);
  expect(isKey(canonicalBinding('ctrl+\\'), collapse!)).toBe(true);
});

test('config.keys moves the chat\'s focus and collapse keys', () => {
  const assistant = { name: 'assistant', keys: { chatFocus: 'ctrl+]', chatCollapse: 'ctrl+\\' } };
  const keys = buildKeys([assistant] as never, { keys: { chatFocus: 'ctrl+t' } });
  expect(keys.chatFocus).toEqual(['ctrl+t']);
  expect(keys.chatCollapse).toEqual(['ctrl+\\']);
});

test('resolveKeys folds string to array and defaults to [] when missing', () => {
  const k = resolveKeys({});
  // Unbound by default — quitting is the `:quit` command — but still an action a
  // config can bind.
  expect(k.quit).toEqual([]);
  expect(resolveKeys({ quit: 'q' }).quit).toEqual(['q']);
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

test('drawn, a key is its cap — and the modifiers are part of what was pressed', () => {
  expect(keyGlyph('return')).toBe('⏎');
  expect(keyGlyph(' ')).toBe('␣'); // the terminal's name for it is invisible
  expect(keyGlyph('tab')).toBe('⇥');
  expect(keyGlyph('backspace')).toBe('⌫');
  expect(keyGlyph('escape')).toBe('Esc');
  expect(keyGlyph('up')).toBe('↑');
  expect(keyGlyph('f5')).toBe('F5');
  expect(keyGlyph('q')).toBe('q');
  expect(keyGlyph({ name: 'r', ctrl: true })).toBe('^r');
  expect(keyGlyph({ name: 'return', meta: true })).toBe('⌥⏎');
  expect(keyGlyph({ name: 'tab', shift: true })).toBe('⇧⇥');
  // For a character Shift is already in the character: the decoder says 'A'.
  expect(keyGlyph({ name: 'A', shift: true })).toBe('A');
  // Every named key the decoder can produce has a cap that is not its raw name
  // spelled in lower case — except the two that are words anyway.
  for (const name of NAMED_KEYS) expect(keyGlyph(name)).not.toBe('');
  // A cap goes on a one-row key: nothing in the table is wider than a short word.
  for (const name of NAMED_KEYS) expect(Array.from(keyGlyph(name)).length).toBeLessThanOrEqual(6);
  // The three vocabularies agree about which key they mean.
  expect(keyGlyph(canonicalKey('enter'))).toBe('⏎');
  expect(keyGlyph(canonicalKey('space'))).toBe('␣');
});

// ─── A modifier is part of the key, and so part of a binding ───────────────────
// `details` lives on ^o. Before this, a binding could only name a bare key and an
// action on a modified one had to be written into its handler — which is what `^r`
// was: `key.name === 'r' && key.ctrl`, unremappable and invisible to every hint.

test('a modifier can be written into a binding, however a person spells it', () => {
  expect(canonicalKey('ctrl+o')).toBe('ctrl+o');
  expect(canonicalKey('^o')).toBe('ctrl+o');
  expect(canonicalKey('Ctrl+O')).toBe('ctrl+O'); // the character keeps its case
  expect(canonicalKey('alt+enter')).toBe('alt+return');
  expect(canonicalKey('shift+tab')).toBe('shift+tab');
  expect(canonicalKey('ctrl+shift+pgup')).toBe('ctrl+shift+pageup');
  // A lone glyph is a key in its own right, not a modifier with nothing after it.
  expect(canonicalKey('^')).toBe('^');
  // A binding of several spellings is one set, canonical and without duplicates.
  expect(canonicalBinding(['ctrl+o', '^o', 'ctrl+r'])).toEqual(['ctrl+o', 'ctrl+r']);
});

test('a key is compared as it was PRESSED — modifiers and all', () => {
  const binding = canonicalBinding(['ctrl+o', 'ctrl+r']);
  expect(isKey(binding, { name: 'o', ctrl: true })).toBe(true);
  expect(isKey(binding, { name: 'r', ctrl: true })).toBe(true);
  // A bare `o` is not `^o`: the chat's field must still take the letter.
  expect(isKey(binding, { name: 'o' })).toBe(false);
  expect(isKey(binding, 'o')).toBe(false);
  // Shift on a character is already in the character — the decoder says 'A'.
  expect(keyId({ name: 'A', shift: true })).toBe('A');
  expect(keyId({ name: 'tab', shift: true })).toBe('shift+tab');
  // Where every binding is a bare key, the name alone still matches as it always did.
  expect(isKey(['escape'], 'escape')).toBe(true);
});

test('a modified binding is drawn as its cap, and a hint names ONE key', () => {
  expect(keyGlyph('ctrl+o')).toBe('^o');
  expect(keyGlyph(canonicalKey('^o'))).toBe('^o');
  const binding = canonicalBinding(['ctrl+o', 'ctrl+r']);
  // The help lists every key that answers; a hint in a line of hints teaches the first.
  expect(bindingGlyph(binding)).toBe('^o/^r');
  expect(firstGlyph(binding)).toBe('^o');
  expect(firstGlyph([])).toBe('');
});
