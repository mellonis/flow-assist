import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from '../agent';
import { bulkyItems } from '../recall';
import { findToolResult, keptRaw, RAW_MAX, RAW_OMITTED, RAW_RESULT, toolReturn } from '../tool-results';

const call = (id: string, name: string, args: unknown = {}): ChatMessage => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const result = (id: string, content: string, extra: Record<string, unknown> = {}): ChatMessage => ({ role: 'tool', tool_call_id: id, content, ...extra });

describe('findToolResult', () => {
  test('the text after the OK tag, and the tool that returned it', () => {
    const h = [call('c1', 'get_poem'), result('c1', 'OK: a b')];
    expect(findToolResult(h, 'c1')).toEqual({ ok: true, id: 'c1', tool: 'get_poem', text: 'a b' });
  });

  test('the whole result kept beside a cut one wins over the cut content', () => {
    const h = [call('c1', 'get_poem'), result('c1', 'OK: head\n… [cut: 9000 characters in all — ask the tool for less: filters, a limit, one item]\ntail', { [RAW_RESULT]: 'the whole text' })];
    expect(findToolResult(h, 'c1')).toMatchObject({ ok: true, text: 'the whole text' });
  });

  test('a cut result with nothing whole beside it is refused, not piped cut', () => {
    const h = [call('c1', 'get_poem'), result('c1', 'OK: head\n… [cut: 9000 characters in all — ask the tool for less: filters, a limit, one item]\ntail')];
    const r = findToolResult(h, 'c1');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('c1');
  });

  test('an id that names no call of the conversation is an error naming it', () => {
    const r = findToolResult([call('c1', 'x'), result('c1', 'OK: y')], 'call_9');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('"call_9"');
  });

  test('an empty id is an error', () => {
    expect(findToolResult([call('', 'x'), result('', 'OK: y')], '  ').ok).toBe(false);
  });

  test('a failed or declined call is an error naming the id and the tool', () => {
    const h = [call('c1', 'get_poem'), result('c1', 'ERROR: not found'), call('c2', 'run_command'), result('c2', 'DECLINED: no')];
    for (const id of ['c1', 'c2']) {
      const r = findToolResult(h, id);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain(`"${id}"`);
    }
    expect((findToolResult(h, 'c1') as { error: string }).error).toContain('get_poem');
  });

  test('a result that is images and no text is not text', () => {
    const h = [call('c1', 'get_shots'), result('c1', 'OK: ', { images: [{ sha256: 'ab', name: 'a.png' }] })];
    const r = findToolResult(h, 'c1');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('not text');
  });

  test('a reused id reads the latest result', () => {
    const h = [call('call_0', 'first'), result('call_0', 'OK: one'), call('call_0', 'second'), result('call_0', 'OK: two')];
    expect(findToolResult(h, 'call_0')).toMatchObject({ ok: true, tool: 'second', text: 'two' });
  });

  test('the tool is named as the host names it, not by its wire name', () => {
    const h = [call('c1', 'mcp__get'), result('c1', 'OK: x')];
    expect(findToolResult(h, 'c1', { nameOf: (w) => w.replace('__', ':') })).toMatchObject({ tool: 'mcp:get' });
  });

  test('a recall item id is an alias for the call it stubs', () => {
    const big = `OK: ${'x'.repeat(5000)}`;
    const h = [call('c1', 'get_poem'), result('c1', big)];
    const items = bulkyItems(h, 4096);
    const id = items[0]!.id;
    expect(id.startsWith('res:')).toBe(true);
    expect(findToolResult(h, id, { items })).toMatchObject({ ok: true, id: 'c1', tool: 'get_poem' });
    expect(findToolResult(h, id.slice(0, 7), { items })).toMatchObject({ ok: true, id: 'c1' });
  });

  test('a recall alias reads the result whose content is the item\'s, not the latest with its id', () => {
    const big = `OK: ${'x'.repeat(5000)}`;
    const h = [call('call_0', 'get_text'), result('call_0', big), call('call_0', 'git_status'), result('call_0', 'OK: clean')];
    const items = bulkyItems(h, 4096);
    expect(findToolResult(h, items[0]!.id, { items })).toMatchObject({ ok: true, tool: 'get_text', text: 'x'.repeat(5000) });
  });

  test('a result the tool said has no data is refused, naming the id', () => {
    const h = [call('c1', 'mcp_get'), result('c1', 'OK: ERROR from s:get — data from an MCP server…', { [RAW_RESULT]: null })];
    const r = findToolResult(h, 'c1');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('"c1"');
    expect(!r.ok && r.error).toContain('no data to pipe');
  });

  test('a result too large to have been kept is refused as too large, never "call again"', () => {
    const h = [call('c1', 'dump'), result('c1', 'OK: head\n… [cut: 2000000 characters in all — ask the tool for less: filters, a limit, one item]\ntail', { [RAW_OMITTED]: 2_000_000 })];
    const r = findToolResult(h, 'c1');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('too large to pipe');
    expect(!r.ok && r.error).not.toContain('again');
  });

  test('content that is not a tagged result and has nothing kept beside it is refused (a stub)', () => {
    const h = [call('c1', 'get_text'), result('c1', '[get_text — 120 lines — recall("res:1234abcd")]')];
    expect(findToolResult(h, 'c1').ok).toBe(false);
  });
});

describe('toolReturn and keptRaw', () => {
  test('a string is the data; { text, raw } is the text read and the data behind it', () => {
    expect(toolReturn('plain')).toEqual({ detail: 'plain', whole: undefined });
    expect(toolReturn({ text: 'framed', raw: 'bare' })).toEqual({ detail: 'framed', whole: 'bare' });
    expect(toolReturn({ text: 'failed', raw: null })).toEqual({ detail: 'failed', whole: null });
    // An object without a `raw` key is left as it is — JSON, as before.
    expect(toolReturn({ text: 'x', other: 1 })).toEqual({ detail: { text: 'x', other: 1 }, whole: undefined });
    // With images: the image path gets it without `raw`; the text is the data unless `raw` says.
    expect(toolReturn({ text: 't', images: [] })).toEqual({ detail: { text: 't', images: [] }, whole: 't' });
    expect(toolReturn({ text: 't', images: [], raw: 'r' })).toEqual({ detail: { text: 't', images: [] }, whole: 'r' });
  });

  test('kept only when the content is not the data plus the tag, and only up to the ceiling', () => {
    expect(keptRaw('OK: abc', 'abc')).toEqual({});
    expect(keptRaw('OK: framed', 'abc')).toEqual({ [RAW_RESULT]: 'abc' });
    expect(keptRaw('OK: framed', null)).toEqual({ [RAW_RESULT]: null });
    expect(keptRaw('OK: cut', 'y'.repeat(RAW_MAX + 1))).toEqual({ [RAW_OMITTED]: RAW_MAX + 1 });
  });
});
