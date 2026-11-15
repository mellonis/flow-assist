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
