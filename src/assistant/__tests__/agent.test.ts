import { expect, test } from 'bun:test';
import { chatLanguage } from '../agent';
import { agentChat } from '../agent';
import { assembleToolRegistry } from '../../loader/tools';
import { makeFactory } from '../../loader/plugin';

test('assistant language fallback: assistantLanguage ?? language ?? en', () => {
  expect(chatLanguage({})).toBe('en');
  expect(chatLanguage({ language: 'ru' })).toBe('ru');
  expect(chatLanguage({ assistantLanguage: 'de', language: 'ru' })).toBe('de');
});

test('agentChat runs a tool round and falls back to final content', async () => {
  // Assemble the registry so agentChat's dispatch to the real `memory` tool via
  // execChatTool works (the registry's current singleton is set here).
  assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });

  // Fake LLM that returns one tool call (memory list) then a final answer.
  const calls: string[] = [];
  const fakeRound = async (messages: any[], opts: any) => {
    calls.push('round');
    if (calls.length === 1) {
      opts.onDelta?.('thinking');
      return { content: 'thinking', finishReason: 'tool_calls', toolCalls: [{ id: '1', name: 'memory', arguments: '{"action":"list"}' }] };
    }
    opts.onDelta?.('done');
    return { content: 'done', finishReason: 'stop', toolCalls: [] };
  };

  const res = await agentChat([{ role: 'user', content: 'hi' }], {
    baseUrl: 'http://x', model: 'm', token: 't',
    onLiveCommit: () => {}, onLive: () => {},
    // stub chatRound via opts.chatRound — real impl reads opts.chatRound if present
    chatRound: fakeRound,
  });

  expect(res.content).toBe('done');
  expect(calls.length).toBe(2);
});

test('agentChat confirms a write-flagged tool and skips confirmation for a read-only one', async () => {
  // Two ai-tools: `t:save` (write: true) and `t:read` (no write). Both carry a
  // stub `run` so no real file/system side effect happens.
  const make = makeFactory({});
  const plugins = [
    make('t', {
      aiTools: [
        { type: 'function', function: { name: 't:save', description: 'save', parameters: { type: 'object', properties: {} } }, write: true, run: async () => 'ok' },
        { type: 'function', function: { name: 't:read', description: 'read', parameters: { type: 'object', properties: {} } }, run: async () => 'ok' },
      ],
    }),
  ];
  assembleToolRegistry({ plugins, config: {}, repo: { list: async () => [] } as any });

  const confirmed: { name: string }[] = [];
  let n = 0;
  const fakeRound = async (messages: any[], opts: any) => {
    if (n++ === 0) { opts.onDelta?.('a'); return { content: 'a', finishReason: 'tool_calls', toolCalls: [{ id: '1', name: 't:save', arguments: '{}' }] }; }
    if (n === 2) { opts.onDelta?.('b'); return { content: 'b', finishReason: 'tool_calls', toolCalls: [{ id: '2', name: 't:read', arguments: '{}' }] }; }
    opts.onDelta?.('done');
    return { content: 'done', finishReason: 'stop', toolCalls: [] };
  };

  const res = await agentChat([{ role: 'user', content: 'hi' }], {
    baseUrl: 'http://x', model: 'm', token: 't',
    onLiveCommit: () => {}, onLive: () => {},
    confirmWrite: (name: string) => { confirmed.push({ name }); return true; },
    chatRound: fakeRound,
  });

  // Only the write tool paused for confirmation; the read-only one ran without.
  expect(confirmed.map((c) => c.name)).toEqual(['t:save']);
  expect(res.content).toBe('done');
  const writes = res.toolRuns.filter((r) => r.write).map((r) => r.name);
  expect(writes).toContain('t:save');
  expect(writes).not.toContain('t:read');
});

test('agentChat tags the model-facing tool result with OK / ERROR / DECLINED', async () => {
  const make = makeFactory({});
  const plugins = [
    make('t', {
      aiTools: [
        { type: 'function', function: { name: 't:ok', description: 'ok', parameters: { type: 'object', properties: {} } }, run: async () => 'saved' },
        { type: 'function', function: { name: 't:fail', description: 'fail', parameters: { type: 'object', properties: {} } }, run: async () => { throw new Error('boom'); } },
        { type: 'function', function: { name: 't:write', description: 'write', parameters: { type: 'object', properties: {} } }, write: true, run: async () => 'wrote' },
      ],
    }),
  ];
  assembleToolRegistry({ plugins, config: {}, repo: { list: async () => [] } as any });

  // The model sees a tool result only by reading the messages of the NEXT round, so
  // collect every `role: 'tool'` content as the rounds advance.
  const seen: string[] = [];
  let n = 0;
  const fakeRound = async (messages: any[]) => {
    for (const m of messages) if (m.role === 'tool') seen.push(m.content);
    const calls: Record<number, any> = {
      0: { content: '', finishReason: 'tool_calls', toolCalls: [{ id: '1', name: 't:ok', arguments: '{}' }] },
      1: { content: '', finishReason: 'tool_calls', toolCalls: [{ id: '2', name: 't:fail', arguments: '{}' }] },
      2: { content: '', finishReason: 'tool_calls', toolCalls: [{ id: '3', name: 't:write', arguments: '{}' }] },
      3: { content: 'done', finishReason: 'stop', toolCalls: [] },
    };
    return calls[n++];
  };

  await agentChat([{ role: 'user', content: 'hi' }], {
    baseUrl: 'http://x', model: 'm', token: 't',
    onLiveCommit: () => {}, onLive: () => {},
    confirmWrite: () => false, // declines `t:write` → DECLINED
    chatRound: fakeRound,
  });

  expect(seen).toContain('OK: saved');
  expect(seen).toContain('ERROR: boom');
  expect(seen.some((s) => s.startsWith('DECLINED:'))).toBe(true);
});
