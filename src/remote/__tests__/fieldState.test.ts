import { expect, test } from 'bun:test';
import { ECHO_RING, createFieldState } from '../fieldState';

test('a value the person typed is held; the plugin echoing it back is not a write', () => {
  const s = createFieldState();
  s.set('name', 'h'); s.set('name', 'he'); s.set('name', 'hel'); s.set('name', 'hell'); s.set('name', 'hello');
  // Frames lagging the typing echo what the plugin saw: none of them moves the field.
  s.applyFrame(['TextInput', { id: 'name', value: 'h' }], {});
  expect(s.get('name')).toBe('hello');
  s.applyFrame(['TextInput', { id: 'name', value: 'hel' }], {});
  expect(s.get('name')).toBe('hello');
  // A value the person never typed is a write.
  s.applyFrame(['TextInput', { id: 'name', value: 'goodbye' }], {});
  expect(s.get('name')).toBe('goodbye');
  // The ring was cleared by the write: the old typed values are no longer echoes.
  s.applyFrame(['TextInput', { id: 'name', value: 'hello' }], {});
  expect(s.get('name')).toBe('hello');
});

test('the ring keeps the last 32 sent values', () => {
  const s = createFieldState();
  for (let i = 0; i <= ECHO_RING; i++) s.set('f', `v${i}`);
  s.applyFrame(['TextInput', { id: 'f', value: 'v0' }], {}); // fell off the ring: a write
  expect(s.get('f')).toBe('v0');
  const t = createFieldState();
  for (let i = 0; i <= ECHO_RING; i++) t.set('f', `v${i}`);
  t.applyFrame(['TextInput', { id: 'f', value: 'v1' }], {}); // still in the ring: an echo
  expect(t.get('f')).toBe(`v${ECHO_RING}`);
});

test('a first frame with a value seeds the field; an empty field starts empty', () => {
  const s = createFieldState();
  s.applyFrame(['Box', {}, ['TextInput', { id: 'a', value: 'seed' }], ['TextInput', { id: 'b' }]], {});
  expect(s.get('a')).toBe('seed');
  expect(s.get('b')).toBeUndefined();
  // A JSON `null` where a value prop goes is "no value in the frame", the same as the
  // prop being absent — a plugin in a language whose "nothing" serializes to null.
  s.applyFrame(['Box', {}, ['TextInput', { id: 'a', value: 'seed' }], ['TextInput', { id: 'b' }], ['TextInput', { id: 'c', value: null }]], {});
  expect(s.get('c')).toBeUndefined();
});

test('checked, a list value and an offset follow the same rule, inside modals too', () => {
  const s = createFieldState();
  s.set('ok', true);
  s.applyFrame(null, { confirm: ['Box', {}, ['Checkbox', { id: 'ok', checked: true }], ['ListSelect', { id: 'l', value: 2 }], ['ScrollBox', { id: 'sb', offset: 10 }]] });
  expect(s.get('ok')).toBe(true);   // echo
  expect(s.get('l')).toBe(2);       // a write (never sent)
  expect(s.get('sb')).toBe(10);
  s.applyFrame(null, { confirm: ['Checkbox', { id: 'ok', checked: false }] });
  expect(s.get('ok')).toBe(false);  // a write: false was never sent
});

test('a field that vanished from the frame drops its state; one that returns starts empty', () => {
  const s = createFieldState();
  s.set('code', 'let x');
  s.applyFrame(['TextInput', { id: 'code' }], {});
  expect(s.get('code')).toBe('let x');
  s.applyFrame(['Text', {}, 'lesson done'], {});
  expect(s.get('code')).toBeUndefined();
  s.applyFrame(['TextInput', { id: 'code' }], {});
  expect(s.get('code')).toBeUndefined();
});

test('deep equality: an object value echoed back is an echo', () => {
  const s = createFieldState();
  s.set('multi', [1, 2]);
  s.applyFrame(['ListMultiSelect', { id: 'multi', value: [1, 2] }], {});
  expect(s.get('multi')).toEqual([1, 2]);
  s.applyFrame(['ListMultiSelect', { id: 'multi', value: [3] }], {});
  expect(s.get('multi')).toEqual([3]);
});
