import { expect, test } from 'bun:test';
import { FRAME_MAX_BYTES, FRAME_MAX_DEPTH, normalizeNode, validateFrame } from '../frame';

test('a frame is read whole, missing parts default', () => {
  const r = validateFrame({ surface: ['Text', {}, 'hi'] }, 30);
  expect(r).toEqual({ ok: true, frame: { surface: ['Text', {}, 'hi'], modals: {}, keycaps: [], context: [], keys: { consume: [] } } });
});

test('what is not a frame is refused with a reason, and the size and depth caps hold', () => {
  expect(validateFrame(null, 4)).toMatchObject({ ok: false, why: 'not an object' });
  expect(validateFrame({ surface: 'Text' }, 20)).toMatchObject({ ok: false, why: expect.stringContaining('surface') });
  expect(validateFrame({ surface: ['Text', {}], keys: { consume: 7 } }, 40)).toMatchObject({ ok: false, why: expect.stringContaining('consume') });
  expect(validateFrame({ surface: null }, FRAME_MAX_BYTES + 1)).toMatchObject({ ok: false, why: expect.stringContaining('MiB') });
  let deep: unknown = ['Text', {}, 'x'];
  for (let i = 0; i < FRAME_MAX_DEPTH + 1; i++) deep = ['Box', {}, deep];
  expect(validateFrame({ surface: deep }, 1000)).toMatchObject({ ok: false, why: expect.stringContaining('deep') });
});

test('props may be omitted: the string where props go is the first child', () => {
  expect(normalizeNode(['Text', 'hello'])).toEqual({ type: 'Text', props: {}, children: ['hello'] });
  expect(normalizeNode(['Box', ['Text', {}, 'a']])).toEqual({ type: 'Box', props: {}, children: [['Text', {}, 'a']] });
  expect(normalizeNode(['Text', { bold: true }, 'a', null, false, 'b'])).toEqual({ type: 'Text', props: { bold: true }, children: ['a', 'b'] });
  expect(normalizeNode('just a string')).toBeNull();
  expect(normalizeNode([])).toBeNull();
  expect(normalizeNode([42])).toBeNull();
});

test('keycaps, context and consume are read strictly', () => {
  const r = validateFrame({ keycaps: [{ action: 'open', label: 'open' }, 'plain', { label: 'no action' }], context: [{ label: 'L', text: 'T' }, { label: 1 }], keys: { consume: '*' } }, 200);
  expect(r).toMatchObject({ ok: true, frame: { keycaps: [{ action: 'open', label: 'open' }, 'plain'], context: [{ label: 'L', text: 'T' }], keys: { consume: '*' } } });
});
