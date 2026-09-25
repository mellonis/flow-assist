import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from '../agent';
import { bulkyItems } from '../recall';
import { findToolResult, RAW_RESULT } from '../tool-results';

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
});
