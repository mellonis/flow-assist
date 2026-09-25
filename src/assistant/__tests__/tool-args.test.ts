import { expect, test } from 'bun:test';
import { toolArgsError } from '../tool-args';
import { TOOLS_LOAD_PARAMETERS } from '../tool-loading';

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

test('an explicit additionalProperties: false still reports a key matching no patternProperties pattern', () => {
  const patterned = { type: 'object', properties: { a: { type: 'string' } }, patternProperties: { '^x_': { type: 'string' } }, additionalProperties: false };
  expect(toolArgsError('t', patterned, { a: '1', x_1: 'ok' })).toBeNull();
  expect(toolArgsError('t', patterned, { a: '1', x_1: 'ok', bogus: 'no' })).toBe('wrong arguments for t — unknown parameter `bogus`. Nothing was run.');
});

test('a nested additionalProperties: false is enforced, not swallowed by the top-level check', () => {
  const nested = {
    type: 'object',
    properties: { a: { type: 'string' }, obj: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: false } },
  };
  expect(toolArgsError('t', nested, { a: 'ok', obj: { x: '1' } })).toBeNull();
  const msg = toolArgsError('t', nested, { a: 'ok', obj: { x: '1', y: 'bad' } });
  expect(msg).toContain('`obj`');
  expect(msg).toContain('"y"');
});

test('null on a declared optional parameter is read as omitted, the way a tool\'s own `?? default` already reads an absent one', () => {
  const withOptional = { type: 'object', properties: { issueCode: { type: 'string' }, path: { type: 'string' } }, required: ['issueCode'] };
  expect(toolArgsError('t', withOptional, { issueCode: 'ABC-1', path: null })).toBeNull();
});

test('null on a required parameter still fails, as any other wrong type would', () => {
  expect(toolArgsError('get_issue', schema, { issueCode: null })).toBe('wrong arguments for get_issue — `issueCode` must be string. Nothing was run.');
});

test('null on an optional key inside an object parameter is read as omitted too, at any depth', () => {
  const nested = {
    type: 'object',
    properties: {
      filter: {
        type: 'object',
        properties: { status: { type: 'string' }, sort: { type: 'object', properties: { by: { type: 'string' }, desc: { type: 'boolean' } }, required: ['by'] } },
        required: ['sort'],
      },
    },
    required: ['filter'],
  };
  expect(toolArgsError('t', nested, { filter: { status: null, sort: { by: 'date' } } })).toBeNull();
  expect(toolArgsError('t', nested, { filter: { sort: { by: 'date', desc: null } } })).toBeNull();
});

test('null on a required key inside an object parameter still fails, naming its path', () => {
  const nested = {
    type: 'object',
    properties: { filter: { type: 'object', properties: { status: { type: 'string' }, sort: { type: 'object', properties: { by: { type: 'string' } }, required: ['by'] } }, required: ['sort'] } },
  };
  const deep = toolArgsError('t', nested, { filter: { sort: { by: null } } });
  expect(deep).toContain('`filter.sort.by`');
  expect(deep).toContain('Nothing was run.');
  expect(toolArgsError('t', nested, { filter: { sort: null } })).toContain('`filter.sort`');
});

test('null on a key matched only by patternProperties is read as omitted, at the top and nested', () => {
  const top = { type: 'object', properties: { a: { type: 'string' } }, patternProperties: { '^x-': { type: 'string' } }, additionalProperties: false };
  expect(toolArgsError('t', top, { a: 'ok', 'x-trace': null })).toBeNull();
  const nested = { type: 'object', properties: { headers: { type: 'object', patternProperties: { '^x-': { type: 'string' } }, additionalProperties: false } } };
  expect(toolArgsError('t', nested, { headers: { 'x-trace': null, 'x-id': 'abc' } })).toBeNull();
  expect(toolArgsError('t', nested, { headers: { 'x-id': 1 } })).toContain('`headers.x-id`');
});

test('an array item has no optional notion: null there is whatever the item schema says', () => {
  const list = { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } };
  expect(toolArgsError('t', list, { tags: ['a', null] })).toContain('`tags[1]`');
  const objs = { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id'] } } } };
  expect(toolArgsError('t', objs, { rows: [{ id: '1', note: null }] })).toBeNull();
  expect(toolArgsError('t', objs, { rows: [{ id: null }] })).toContain('`rows[0].id`');
});

test('null handling never mutates the arguments the tool will receive', () => {
  const nested = { type: 'object', properties: { filter: { type: 'object', properties: { status: { type: 'string' } } } } };
  const args = { filter: { status: null } };
  expect(toolArgsError('t', nested, args)).toBeNull();
  expect(args).toEqual({ filter: { status: null } });
});

test('values are never coerced: a number sent as a string is a wrong type', () => {
  expect(toolArgsError('get_issue', schema, { issueCode: 'ABC-1', count: '3' })).toBe('wrong arguments for get_issue — `count` must be number. Nothing was run.');
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

test('tools_load\'s own names takes an array or a single bare name, as runToolsLoad always has', () => {
  expect(toolArgsError('tools_load', TOOLS_LOAD_PARAMETERS, { names: ['get_issue'] })).toBeNull();
  expect(toolArgsError('tools_load', TOOLS_LOAD_PARAMETERS, { names: 'get_issue' })).toBeNull();
  expect(toolArgsError('tools_load', TOOLS_LOAD_PARAMETERS, { group: 'repo' })).toBeNull();
});

test('args are never mutated', () => {
  const args = { issueCode: 1 };
  toolArgsError('get_issue', schema, args);
  expect(args).toEqual({ issueCode: 1 });
});
