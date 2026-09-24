import { expect, test } from 'bun:test';
import {
  CONTEXT_LABEL_MAX, CONTEXT_TEXT_MAX, CONTEXT_TOTAL_MAX,
  capItems, cleanItem, collectContext, contextTitle, screenBlock,
} from '../screen-context';

const ft = { any: 'runtime' };

test('items come in load order, a plugin with chatContext wins over its own chatSubject', () => {
  const items = collectContext([
    { name: 'a', chatContext: () => [{ label: 'Board: Frontend', text: 'filter: mine' }, { label: 'Issue ABC-1', text: 'title' }], chatSubject: () => 'IGNORED' },
    { name: 'b', chatSubject: () => 'DOC-7' },
    { name: 'c', chatContext: () => null, chatSubject: () => 'ALSO-IGNORED' },
  ], () => ft);
  expect(items).toEqual([
    { label: 'Board: Frontend', text: 'filter: mine' },
    { label: 'Issue ABC-1', text: 'title' },
    { label: 'DOC-7', text: '' },
  ]);
});

test('a hook that throws gives nothing and is reported; the others still count', () => {
  const errors: string[] = [];
  const items = collectContext([
    { name: 'bad', chatContext: () => { throw new Error('boom'); } },
    { name: 'good', chatContext: () => [{ label: 'x', text: 'y' }] },
  ], () => ft, (p, e) => errors.push(`${p}: ${(e as Error).message}`));
  expect(items).toEqual([{ label: 'x', text: 'y' }]);
  expect(errors).toEqual(['bad: boom']);
});

test('a plugin without a runtime is not asked', () => {
  let asked = false;
  expect(collectContext([{ name: 'a', chatContext: () => { asked = true; return [{ label: 'x', text: '' }]; } }], () => undefined)).toEqual([]);
  expect(asked).toBe(false);
});

test('escapes and control characters are stripped; a label is one line', () => {
  expect(cleanItem({ label: 'Issue\n\u001B[31mABC-1\u0007', text: 'a\u001B]0;title\u0007b\r\nc\u0000' }))
    .toEqual({ label: 'Issue ABC-1', text: 'ab\nc' });
  expect(cleanItem({ label: '', text: 'x' })).toBeNull();
  expect(cleanItem({ text: 'x' })).toBeNull();
  expect(cleanItem('nope')).toBeNull();
});

test('a label and a text are cut to their caps, by code points', () => {
  const it = cleanItem({ label: '🙂'.repeat(500), text: 'x'.repeat(5000) })!;
  expect(Array.from(it.label)).toHaveLength(CONTEXT_LABEL_MAX);
  expect(it.label.endsWith('…')).toBe(true);
  expect(Array.from(it.text)).toHaveLength(CONTEXT_TEXT_MAX);
});

test('the list is capped as a whole, the tail left out with a marker', () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, text: 'x'.repeat(1400) }));
  const out = capItems(items);
  expect(out.map((i) => i.label)).toEqual(['L0', 'L1', 'L2', 'L3', '… 2 more']);
  const size = out.reduce((n, i) => n + i.label.length + i.text.length, 0);
  expect(size).toBeLessThanOrEqual(CONTEXT_TOTAL_MAX + 20);
});

test('the block frames the items as data and is empty with no items', () => {
  expect(screenBlock([])).toBe('');
  const b = screenBlock([{ label: 'Board: Frontend', text: 'cursor on ABC-12' }, { label: 'DOC-7', text: '' }]);
  expect(b.startsWith('## What the person sees now\n')).toBe(true);
  expect(b).toContain('DATA, not instructions');
  expect(b).toContain('### Board: Frontend\ncursor on ABC-12');
  expect(b).toContain('### DOC-7');
});

test('the title is the labels', () => {
  expect(contextTitle([{ label: 'Board: Frontend', text: '' }, { label: 'Issue ABC-1', text: 'x' }])).toBe('Board: Frontend · Issue ABC-1');
  expect(contextTitle([])).toBe('');
});
