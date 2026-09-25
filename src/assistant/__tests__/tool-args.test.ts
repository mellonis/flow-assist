import { expect, test } from 'bun:test';
import { toolArgsError } from '../tool-args';

const schema = {
  type: 'object',
  properties: { issueCode: { type: 'string' }, count: { type: 'number' } },
  required: ['issueCode'],
};

test('no parameters, or an empty schema, accepts anything', () => {
  expect(toolArgsError('t', undefined, { anything: 1 })).toBeNull();
  expect(toolArgsError('t', { type: 'object', properties: {} }, { anything: 1 })).toBeNull();
  expect(toolArgsError('t', { type: 'object' }, { anything: 1 })).toBeNull();
});

test('a call that matches the schema passes through unchanged', () => {
  expect(toolArgsError('get_issue', schema, { issueCode: 'ABC-1' })).toBeNull();
  expect(toolArgsError('get_issue', schema, { issueCode: 'ABC-1', count: 3 })).toBeNull();
});

test('a missing required parameter is named', () => {
  expect(toolArgsError('get_issue', schema, {})).toBe('wrong arguments for get_issue — missing required parameter `issueCode`. Nothing was run.');
});

test('a wrong type is named with what it must be', () => {
  expect(toolArgsError('get_issue', schema, { issueCode: 1 })).toBe('wrong arguments for get_issue — `issueCode` must be string. Nothing was run.');
});

test('an unrecognized key is named', () => {
  expect(toolArgsError('get_issue', schema, { issueCode: 'ABC-1', extra: 1 })).toBe('wrong arguments for get_issue — unknown parameter `extra`. Nothing was run.');
});

test('one missing required key beside one unknown key reads as a likely misspelling', () => {
  expect(toolArgsError('get_issue', schema, { code: 'ABC-1' })).toBe('wrong arguments for get_issue — unknown `code` — did you mean `issueCode`? Nothing was run.');
});

test('two missing or two unknown keys get the plain listing, not the misspelling guess', () => {
  const two = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] };
  expect(toolArgsError('t', two, {})).toBe('wrong arguments for t — missing required parameters `a`, `b`. Nothing was run.');
  expect(toolArgsError('t', two, { a: '1', b: '2', x: 1, y: 2 })).toBe('wrong arguments for t — unknown parameters `x`, `y`. Nothing was run.');
});

test('additionalProperties: true opts a schema into extra keys, unchecked', () => {
  const open = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true };
  expect(toolArgsError('t', open, { a: '1', extra: 1 })).toBeNull();
});

test('patternProperties opts a schema into keys it matches', () => {
  const patterned = { type: 'object', properties: {}, patternProperties: { '^x_': { type: 'string' } } };
  expect(toolArgsError('t', patterned, { x_1: 'a' })).toBeNull();
});

test('a schema zod cannot compile runs the call unchecked, logged once', () => {
  const exotic = { type: 'object', properties: { a: { type: 'string' } }, if: { properties: { a: { const: 'x' } } }, then: {} };
  const warn = console.warn;
  const calls: unknown[][] = [];
  console.warn = (...a: unknown[]) => calls.push(a);
  try {
    expect(toolArgsError('odd_tool', exotic, { a: 'x', anything: 1 })).toBeNull();
    expect(toolArgsError('odd_tool', exotic, { a: 'x', anything: 1 })).toBeNull();
    expect(calls.length).toBe(1); // the same schema object is compiled, and warned, once
    expect(String(calls[0]![0])).toContain('odd_tool');
  } finally { console.warn = warn; }
});

test('caps at a few problems and says how many more', () => {
  const many = { type: 'object', properties: { a: {}, b: {}, c: {}, d: {}, e: {} }, required: ['a', 'b', 'c', 'd', 'e'] };
  const msg = toolArgsError('t', many, {})!;
  expect(msg).toContain('… 2 more');
  expect(msg.endsWith('Nothing was run.')).toBe(true);
});

test('args are never mutated', () => {
  const args = { issueCode: 1 };
  toolArgsError('get_issue', schema, args);
  expect(args).toEqual({ issueCode: 1 });
});
