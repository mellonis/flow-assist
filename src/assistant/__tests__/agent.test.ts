import { expect, test } from 'bun:test';
import { chatLanguage } from '../agent';
import { agentChat, apiHistory } from '../agent';
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

test('a turn hands back its full transcript, so the next turn replays the tool calls and their results', async () => {
  // The regression this guards: the chat kept only the final TEXT of each
  // assistant turn. By the third turn the model had two in-context examples of
  // "the user asked for a change → I said done" with no tool call and no tool
  // result in sight, so it imitated them: it narrated the change and guessed at
  // state instead of calling the tool. No prompt overrides examples in history.
  assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  let n = 0;
  const turnOne = async (_m: any[], opts: any) => {
    n++;
    if (n === 1) return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'call_1', name: 'memory', arguments: '{"action":"list"}' }] };
    opts.onDelta?.('listed');
    return { content: 'listed', finishReason: 'stop', toolCalls: [] };
  };
  const first = await agentChat([{ role: 'user', content: 'list memory' }], { baseUrl: 'http://x', model: 'm', token: 't', onLive: () => {}, onLiveCommit: () => {}, chatRound: turnOne });

  expect(first.transcript.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
  expect((first.transcript[0] as any).tool_calls[0]).toEqual({ id: 'call_1', type: 'function', function: { name: 'memory', arguments: '{"action":"list"}' } });
  expect(first.transcript[1]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
  expect(first.transcript[2]).toEqual({ role: 'assistant', content: 'listed' });

  // The caller's API-side history is: what it sent + the transcript. Display-only
  // fields never travel, and a background result speaks to the model as the user.
  const history = apiHistory([
    { role: 'system', content: 'old system' },
    { role: 'user', content: 'list memory' },
    ...first.transcript,
    { role: 'assistant', content: 'shown', process: 'narration', toolRuns: [{}], live: 'x', reasoning: 'y' } as any,
    { role: 'bg', content: 'job finished' },
  ]);
  expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'assistant', 'user']);
  expect(Object.keys(history[4]!).sort()).toEqual(['content', 'role']);
  expect((history[1] as any).tool_calls).toHaveLength(1);

  // Turn two sees turn one's call and result verbatim.
  let seen: any[] = [];
  const turnTwo = async (messages: any[], opts: any) => { seen = messages; opts.onDelta?.('ok'); return { content: 'ok', finishReason: 'stop', toolCalls: [] }; };
  await agentChat([...history, { role: 'user', content: 'again' }], { baseUrl: 'http://x', model: 'm', token: 't', onLive: () => {}, onLiveCommit: () => {}, chatRound: turnTwo });
  expect(seen.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1')).toBe(true);
  expect(seen.some((m) => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'call_1')).toBe(true);
});

test('apiHistory never leaves a tool result without the call that asked for it', () => {
  // Providers reject an orphaned `tool` message (and a tool_calls message with a
  // missing result). A history cut mid-pair — by compaction or a cancelled turn —
  // must drop the broken pair rather than poison every later request.
  const cut = apiHistory([
    { role: 'tool', tool_call_id: 'gone', content: 'orphan' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } }] } as any,
    { role: 'user', content: 'interrupted before the result' },
  ]);
  expect(cut.map((m) => m.role)).toEqual(['user', 'user']);
});

test('a qualified tool name travels to the provider in a form it accepts, and comes back as itself', async () => {
  // Providers validate tool names against ^[a-zA-Z0-9_-]{1,128}$ — a plugin's
  // `name:tool` is rejected with a 400 before the model ever runs. The colon is
  // the host's own convention, so it is translated at the wire and nowhere else.
  assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const ran: unknown[] = [];
  const extraTools = [{ type: 'function', function: { name: 'demo:get_thing', description: 'd', parameters: { type: 'object', properties: {} } }, run: async (args: unknown) => { ran.push(args); return 'thing'; } }] as any;
  let sent: any[] = [];
  let round = 0;
  const chatRound = async (_m: any[], opts: any) => {
    round++;
    sent = opts.tools;
    if (round === 1) return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'demo__get_thing', arguments: '{"id":7}' }] };
    opts.onDelta?.('ok');
    return { content: 'ok', finishReason: 'stop', toolCalls: [] };
  };
  const res = await agentChat([{ role: 'user', content: 'go' }], { baseUrl: 'http://x', model: 'm', token: 't', onLive: () => {}, onLiveCommit: () => {}, extraTools, chatRound });

  const names = sent.map((t) => t.function.name);
  expect(names).toContain('demo__get_thing');
  expect(names.every((n: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(n))).toBe(true);
  expect(ran).toEqual([{ id: 7 }]);
  // Inside the host the tool keeps its real name — in the trail the person sees…
  expect(res.toolRuns.map((r) => r.name)).toEqual(['demo:get_thing']);
  // …while the transcript replays what the provider saw, so the next turn is consistent.
  expect((res.transcript[0] as any).tool_calls[0].function.name).toBe('demo__get_thing');
});

test('a plugin ai-tool is sent to the provider ONCE, though it reaches agentChat twice', async () => {
  // Exactly what the app does: the registry holds the plugin's aiTools as a group
  // (so they are among the base tools), and the chat passes the same tools again as
  // `extraTools`, for their `run`. The provider rejects a duplicate name with 400
  // before the model runs — with a real plugin enabled, every message failed.
  const make = makeFactory({});
  const plugin = make('acme-tracker', {
    aiTools: [{
      type: 'function',
      function: { name: 'open_issue', description: 'open', parameters: { type: 'object', properties: {} } },
      run: () => 'opened',
    }],
  });
  const reg = assembleToolRegistry({ plugins: [plugin], config: {}, repo: { list: async () => [] } as any });
  const pluginAiTools = reg.groups.filter((g) => g.id.endsWith(':aiTools')).flatMap((g) => g.tools);
  expect(pluginAiTools).toHaveLength(1);

  let sent: Array<{ function: { name: string } }> = [];
  await agentChat([{ role: 'user', content: 'hi' }], {
    baseUrl: 'http://x', model: 'm', token: 't',
    extraTools: pluginAiTools as never,
    chatRound: async (_messages, o) => {
      sent = (o as { tools: typeof sent }).tools;
      return { content: 'hello', reasoning: '', finishReason: 'stop', toolCalls: [] };
    },
  });
  const names = sent.map((t) => t.function.name);
  // …under the name the plugin gave it: the model sees `open_issue`, not
  // `acme-tracker__open_issue`.
  expect(names.filter((n) => n.endsWith('open_issue'))).toEqual(['open_issue']);
  // …and no name at all is declared twice.
  expect(new Set(names).size).toBe(names.length);
});

test('on demand, a write tool that is not loaded is refused before any y/n, and runs once loaded', async () => {
  const make = makeFactory({});
  let ran = 0;
  const plugins = [
    make('t', {
      aiTools: [
        { type: 'function', function: { name: 'save_it', description: 'Save it.', parameters: { type: 'object', properties: {} } }, write: true, run: async () => { ran++; return 'saved'; } },
      ],
    }),
  ];
  assembleToolRegistry({ plugins, config: {}, repo: { list: async () => [] } as any });
  const asked: string[] = [];
  const sentTools: string[][] = [];
  const script = [
    { id: '1', name: 'save_it', arguments: '{}' },
    { id: '2', name: 'tools_load', arguments: '{"names":["save_it"]}' },
    { id: '3', name: 'save_it', arguments: '{}' },
  ];
  const fakeRound = async (_messages: any[], opts: any) => {
    sentTools.push(opts.tools.map((t: any) => t.function.name));
    const call = script.shift();
    return call ? { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [call] } : { content: 'done', reasoning: '', finishReason: 'stop', toolCalls: [] };
  };
  const res = await agentChat([{ role: 'user', content: 'save' }], {
    baseUrl: 'http://x', model: 'm', token: 't', onLiveCommit: () => {}, onLive: () => {},
    chatRound: fakeRound, toolLoading: 'onDemand', confirmWrite: (name) => { asked.push(name); return true; },
  });
  expect(res.toolRuns.map((r) => r.outcome)).toEqual(['error', 'ok', 'applied']);
  expect(asked).toEqual(['save_it']); // once — for the call that ran
  expect(ran).toBe(1);
  expect(sentTools[0]).not.toContain('save_it');
  expect(sentTools[2]).toContain('save_it');
});
