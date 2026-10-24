import { expect, test } from 'bun:test';
import { parseAgentArgs } from '../agent-args.ts';
import { absentGroupsNote, agentAutoMode, agentToolGroups, askBlockedBy, maxAutoOf } from '../agent-start.ts';

const params = (spec: string) => spec.split(',').filter(Boolean).map((p) => ({ name: p.replace('?', ''), optional: p.endsWith('?') }));

test('parseAgentArgs: positional, the last parameter takes the rest verbatim', () => {
  expect(parseAgentArgs(params('a,b'), 'x one  two\nthree')).toEqual({ ok: true, values: { a: 'x', b: 'one  two\nthree' }, missing: [] });
});

test('parseAgentArgs: name=value first, quoted values, positional fill what is left', () => {
  expect(parseAgentArgs(params('a,b,c?'), 'b="two words" one')).toEqual({ ok: true, values: { a: 'one', b: 'two words', c: '' }, missing: [] });
  expect(parseAgentArgs(params('a'), 'a=1')).toMatchObject({ ok: true, values: { a: '1' } });
});

test('parseAgentArgs: a required parameter with nothing is missing, an optional one is empty', () => {
  expect(parseAgentArgs(params('a,b,c?'), 'x')).toEqual({ ok: true, values: { a: 'x', c: '' }, missing: ['b'] });
  expect(parseAgentArgs(params('a,b'), '')).toEqual({ ok: true, values: {}, missing: ['a', 'b'] });
});

test('parseAgentArgs: an unknown name, a name twice, a value with no parameter left are refusals', () => {
  expect(parseAgentArgs(params('a'), 'z=1')).toMatchObject({ ok: false });
  expect(parseAgentArgs(params('a,b'), 'a=1 a=2')).toMatchObject({ ok: false });
  expect(parseAgentArgs(params('a,b'), 'b=1 x y')).toMatchObject({ ok: false });
  expect(parseAgentArgs([], 'x')).toMatchObject({ ok: false });
  expect(parseAgentArgs([], '')).toEqual({ ok: true, values: {}, missing: [] });
});

test('the cap: the lower of the file\'s mode and agents.maxAuto, reads when unset or not a mode', () => {
  expect(agentAutoMode('all', 'reads')).toBe('reads');
  expect(agentAutoMode('reads', 'all')).toBe('reads');
  expect(agentAutoMode('reads', 'ask')).toBe('ask');
  expect(agentAutoMode('ask', 'all')).toBe('ask');
  expect(maxAutoOf({})).toBe('reads');
  expect(maxAutoOf({ agents: { maxAuto: 'all' } })).toBe('all');
  expect(maxAutoOf({ agents: { maxAuto: 'bogus' } })).toBe('reads');
});

test('tool groups: none named is no restriction; a named group the registry lacks is reported', () => {
  expect(agentToolGroups({ tools: null }, new Set(['a']))).toEqual({ groups: null, absent: [] });
  expect(agentToolGroups({ tools: ['a', 'gitlab'] }, new Set(['a']))).toEqual({ groups: ['a', 'gitlab'], absent: ['gitlab'] });
  expect(absentGroupsNote('new-ticket', ['gitlab'])).toBe('@new-ticket: group "gitlab" is not loaded — starting without it');
});

test('a start that must ask is blocked by the session\'s own question, one that need not ask is not', () => {
  expect(askBlockedBy({}, ['a'])).toBe('answer the open question first');
  expect(askBlockedBy(null, ['a'])).toBeNull();
  expect(askBlockedBy({}, [])).toBeNull();
});

test('parseAgentArgs: a parameter named like an Object.prototype member is not given by the prototype', () => {
  const ps = params('toString,constructor?');
  const r = parseAgentArgs(ps, '');
  expect(r).toMatchObject({ ok: true, missing: ['toString'] });
  expect(r.ok && Object.hasOwn(r.values, 'toString')).toBe(false);
  expect(parseAgentArgs(ps, 'toString=x')).toMatchObject({ ok: true, missing: [] });
  expect(parseAgentArgs(ps, 'a b')).toMatchObject({ ok: true, values: { toString: 'a', constructor: 'b' }, missing: [] });
  expect(parseAgentArgs(ps, 'toString=1 toString=2')).toMatchObject({ ok: false });
});
