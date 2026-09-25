import { expect, test } from 'bun:test';
import { LineSplitter, MAX_LINE, formatMessage, parseLine } from '../codec';

test('a JSON-RPC line parses; anything else is null', () => {
  expect(parseLine('{"jsonrpc":"2.0","id":1,"method":"hello","params":{}}')).toEqual({ jsonrpc: '2.0', id: 1, method: 'hello', params: {} });
  expect(parseLine('{"jsonrpc":"2.0","method":"frame","params":{"surface":null}}')).toEqual({ jsonrpc: '2.0', method: 'frame', params: { surface: null } });
  expect(parseLine('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  expect(parseLine('starting up...')).toBeNull(); // a banner
  expect(parseLine('{"id":1,"method":"x"}')).toBeNull(); // no jsonrpc field
  expect(parseLine('[1,2]')).toBeNull();
  expect(parseLine('')).toBeNull();
});

test('formatMessage is one line, and round-trips', () => {
  const line = formatMessage({ jsonrpc: '2.0', id: 2, method: 'tool.run', params: { name: 'x', args: { s: 'a\nb' } } });
  expect(line).not.toContain('\n');
  expect(parseLine(line)).toEqual({ jsonrpc: '2.0', id: 2, method: 'tool.run', params: { name: 'x', args: { s: 'a\nb' } } });
});

test('the splitter emits whole lines across chunks and drops a line past MAX_LINE', () => {
  const got: string[] = [];
  const dropped: number[] = [];
  const s = new LineSplitter((l) => got.push(l), (n) => dropped.push(n));
  s.feed('{"a":1}\n{"b":');
  s.feed('2}\n');
  expect(got).toEqual(['{"a":1}', '{"b":2}']);
  s.feed('x'.repeat(MAX_LINE + 1) + '\n{"c":3}\n');
  expect(got).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  expect(dropped).toEqual([MAX_LINE + 1]);
});
