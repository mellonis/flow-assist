import { expect, test } from 'bun:test';
import { checkTree, LIMITS, VOCABULARY } from '../tree.ts';

test('a valid tree passes and its stats are counted', () => {
  const r = checkTree(['Box', { flexDirection: 'column' }, ['Text', {}, 'hi'], ['button', { label: 'go', action: 'go' }]]);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.stats).toEqual({ nodes: 3, deepest: 2, interactive: 1 });
});

test('an unknown type is refused, naming it and the allowed types', () => {
  const r = checkTree(['Pipeline', {}, 'x']);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.error).toContain('Pipeline');
    expect(r.error).toContain('progress');
    expect(r.error).toContain('not drawn');
  }
});

test('an unknown prop on a known type is refused', () => {
  const r = checkTree(['Text', { colour: 'red' }, 'x']);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain('colour');
});

test('a literal colour is refused — palette tokens only', () => {
  const r = checkTree(['Text', { color: '#ff0000' }, 'x']);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain('palette');
});

test('caps hold: nodes, depth, children, text, interactive count, bytes', () => {
  const many = ['Box', {}, ...Array.from({ length: LIMITS.children + 1 }, () => ['Text', {}, 'x'] as const)];
  expect(checkTree(many).ok).toBe(false);
  let deep: unknown = ['Text', {}, 'x'];
  for (let i = 0; i < LIMITS.depth; i++) deep = ['Box', {}, deep];
  expect(checkTree(deep).ok).toBe(false);
  expect(checkTree(['Text', {}, 'x'.repeat(LIMITS.text + 1)]).ok).toBe(false);
  expect(checkTree(['button', { label: 'x'.repeat(LIMITS.value + 1), action: 'a' }]).ok).toBe(false);
  const buttons = ['Box', {}, ...Array.from({ length: LIMITS.interactive + 1 }, () => ['button', { label: 'b', action: 'a' }] as const)];
  expect(checkTree(buttons).ok).toBe(false);
  // 40 × 2 000 chars: under the node cap, over the byte cap
  const fat = ['Box', {}, ...Array.from({ length: 40 }, () => ['Text', {}, 'y'.repeat(LIMITS.text)] as const)];
  const fatCheck = checkTree(fat);
  expect(fatCheck.ok).toBe(false);
  if (!fatCheck.ok) expect(fatCheck.error).toContain('too big');
});

test('the error is one short message, not a wall: three problems are cut with a count', () => {
  const r = checkTree(['Box', {}, ['Nope', {}], ['Nope2', {}], ['Nope3', {}], ['Nope4', {}]]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.split('\n').length).toBeLessThanOrEqual(6);
});

test('the vocabulary text names every type', () => {
  for (const t of ['Box', 'Text', 'Markdown', 'Table', 'ScrollBox', 'Link', 'progress', 'badge', 'rows', 'tasks', 'rule', 'input', 'check', 'select', 'button']) {
    expect(VOCABULARY).toContain(t);
  }
});

test('a type drawn from its props alone refuses children it would never draw', () => {
  const s = checkTree(['progress', { label: 'p', value: 1 }, 'x']);
  expect(s.ok).toBe(false);
  if (!s.ok) {
    expect(s.error).toContain('progress');
    expect(s.error).toContain('no children');
  }
  const n = checkTree(['button', { label: 'go', action: 'go' }, ['Text', {}, 'x']]);
  expect(n.ok).toBe(false);
  if (!n.ok) {
    expect(n.error).toContain('button');
    expect(n.error).toContain('no children');
  }
});

test('Markdown takes one string child, under the text cap', () => {
  expect(checkTree(['Markdown', {}, '# hi']).ok).toBe(true);
  const over = checkTree(['Markdown', {}, 'x'.repeat(LIMITS.text + 1)]);
  expect(over.ok).toBe(false);
  if (!over.ok) expect(over.error).toContain(`chars — the limit is ${LIMITS.text}`);
  expect(checkTree(['Markdown', {}, 'a', 'b']).ok).toBe(false);
});

test('Table cells and column labels stay under the text cap', () => {
  const cell = checkTree(['Table', { columns: [{ key: 'a', label: 'A' }], rows: [['x'.repeat(LIMITS.text + 1), 'b']] }]);
  expect(cell.ok).toBe(false);
  if (!cell.ok) expect(cell.error).toContain(`chars — the limit is ${LIMITS.text}`);
  const col = checkTree(['Table', { columns: [{ key: 'a', label: 'L'.repeat(LIMITS.text + 1) }], rows: [['x']] }]);
  expect(col.ok).toBe(false);
  if (!col.ok) expect(col.error).toContain(`chars — the limit is ${LIMITS.text}`);
});

test('the node cap bites: 401 nodes refuse, 400 pass', () => {
  // 100 inner Boxes of three Texts each: 1 + 100 + 300 = 401 nodes, depth 3,
  // 100 children on the root — only the node cap is broken.
  const dense = (inner: number[]) => ['Box', {}, ...inner.map((n: number) => ['Box', {}, ...Array.from({ length: n }, () => ['Text', {}, 'x'])])];
  const over = checkTree(dense(Array.from({ length: 100 }, () => 3)));
  expect(over.ok).toBe(false);
  if (!over.ok) expect(over.error).toContain(`the limit is ${LIMITS.nodes}`);
  // The same shape with one fewer Text: exactly 400 nodes.
  expect(checkTree(dense([2, ...Array.from({ length: 99 }, () => 3)])).ok).toBe(true);
});
