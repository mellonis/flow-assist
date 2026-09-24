import { expect, test } from 'bun:test';
import { chatLanguage } from '../agent';
import { agentChat, apiHistory, transcriptSoFar } from '../agent';
import { assembleToolRegistry } from '../../loader/tools';
import { makeFactory } from '../../loader/plugin';
import { VIEW_CAPS } from '../views';
import { TOOL_RESULT_MAX_CHARS_CEILING, TOOL_RESULT_MAX_CHARS_DEFAULT } from '../tool-result-cap';

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

// Runs a two-round turn (one tool call, then a final answer) against a tool
// returning `result`, with `opts` merged into agentChat's own options. Returns the
// content of the `role: 'tool'` message the SECOND round was actually sent — the
// model's next request — and the finished AgentResult (for `toolRuns`). Named
// differently from the OTHER `runOneToolTurn` below (a `(run, extra)` helper the
// view tests share) — same-named top-level function declarations in one module
// silently shadow each other, and the later one wins for every caller.
async function runToolTurnWithResult(toolDef: Record<string, unknown>, result: unknown, opts: Record<string, unknown> = {}) {
  const make = makeFactory({});
  const plugins = [make('t', { aiTools: [{ ...toolDef, run: async () => result }] })];
  assembleToolRegistry({ plugins, config: {}, repo: { list: async () => [] } as any });
  let sent = '';
  let n = 0;
  const fakeRound = async (messages: any[]) => {
    if (n === 1) sent = messages.find((m: any) => m.role === 'tool')?.content ?? '';
    const calls: Record<number, any> = {
      0: { content: '', finishReason: 'tool_calls', toolCalls: [{ id: '1', name: (toolDef as any).function.name, arguments: '{}' }] },
      1: { content: 'done', finishReason: 'stop', toolCalls: [] },
    };
    return calls[n++];
  };
  const res = await agentChat([{ role: 'user', content: 'hi' }], {
    baseUrl: 'http://x', model: 'm', token: 't', onLiveCommit: () => {}, onLive: () => {}, chatRound: fakeRound, ...opts,
  });
  return { sent, res };
}

test('a tool returning 400k characters is cut to at most the cap plus the note before it joins the model\'s history', async () => {
  const big = 'A'.repeat(390_000) + 'Z'.repeat(10_000); // 400,000 characters, as in the issue
  const def = { type: 'function', function: { name: 't:big', description: 'big', parameters: { type: 'object', properties: {} } } };
  const { sent, res } = await runToolTurnWithResult(def, big);

  const rawSent = `OK: ${big}`; // what the tool result becomes before capping
  expect(rawSent.length).toBe(400_004);
  const note = `\n… [cut: ${rawSent.length} characters in all — ask the tool for less: filters, a limit, one item]\n`;
  // At most the DEFAULT cap plus the note.
  expect(sent.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS_DEFAULT + note.length);
  expect(sent).toContain(note);
  expect(sent.startsWith('OK: ')).toBe(true);

  // The view / trail is UNCHANGED — the tool run keeps the whole, uncapped result.
  const run = res.toolRuns.find((r) => r.name === 't:big')!;
  expect(run.detail).toBe(big);
  expect((run.detail as string).length).toBe(400_000);
});

test('a per-tool maxResultChars overrides the conversation default, clamped to the hard ceiling', async () => {
  // 250,004 chars ("OK: " + 250,000) — over the hard ceiling (200,000), so a tool
  // that asks for more than the ceiling is still capped AT the ceiling, not at what
  // it asked for.
  const huge = 'B'.repeat(250_000);
  const def = { type: 'function', function: { name: 't:wide', description: 'wide', parameters: { type: 'object', properties: {} } }, maxResultChars: 500_000 };
  // The conversation's own default is tiny (100) — proof the per-tool cap wins.
  const { sent } = await runToolTurnWithResult(def, huge, { toolResultMaxChars: 100 });

  const rawLen = `OK: ${huge}`.length;
  expect(rawLen).toBe(250_004);
  const note = `\n… [cut: ${rawLen} characters in all — ask the tool for less: filters, a limit, one item]\n`;
  expect(sent.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS_CEILING + note.length);
  expect(sent.length).toBeGreaterThan(100); // NOT capped at the conversation's tiny default
  expect(sent).toContain(note);
});

test('a tool result under the per-tool cap (even over the ceiling) is not cut at all', async () => {
  const small = 'C'.repeat(1000);
  const def = { type: 'function', function: { name: 't:tiny', description: 'tiny', parameters: { type: 'object', properties: {} } }, maxResultChars: 500_000 };
  const { sent } = await runToolTurnWithResult(def, small);
  expect(sent).toBe(`OK: ${small}`);
});

test('the conversation\'s toolResultMaxChars (from ai.toolResultMaxChars) caps a small result too', async () => {
  const text = 'D'.repeat(500);
  const def = { type: 'function', function: { name: 't:small', description: 'small', parameters: { type: 'object', properties: {} } } };
  const { sent } = await runToolTurnWithResult(def, text, { toolResultMaxChars: 100 });
  const rawLen = `OK: ${text}`.length;
  expect(sent).toContain(`cut: ${rawLen} characters in all`);
  expect(sent.length).toBeLessThan(rawLen);
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

// A turn that throws — Esc, a provider error — has still done what it did before. The
// error that comes out is the one thrown (an AbortError stays an AbortError), carrying
// the transcript so far for the caller's history.
test('agentChat rethrows the same error with the turn so far on it', async () => {
  assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const stop = new DOMException('The operation was aborted.', 'AbortError');
  let n = 0;
  const fakeRound = async () => {
    if (n++ === 0) return { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'memory', arguments: '{"action":"list"}' }] };
    throw stop;
  };
  const thrown = await agentChat([{ role: 'user', content: 'hi' }], { onLiveCommit: () => {}, chatRound: fakeRound }).catch((e) => e);
  expect(thrown).toBe(stop);
  expect(thrown.name).toBe('AbortError');
  expect(transcriptSoFar(thrown).map((m) => m.role)).toEqual(['assistant', 'tool']);
  expect(transcriptSoFar(thrown)[1]!.tool_call_id).toBe('c1');
  // The question the caller passed in is its own, not part of the turn.
  expect(transcriptSoFar(thrown).some((m) => m.role === 'user')).toBe(false);
  expect(transcriptSoFar(new Error('no turn'))).toEqual([]);
});

// One round that calls the tool `demo:show` (whose `run` is given), then an answer.
async function runOneToolTurn(run: (args: unknown, ctx: any) => unknown, extra: Record<string, unknown> = {}) {
  assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const extraTools = [{ type: 'function', function: { name: 'demo:show', description: 'd', parameters: { type: 'object', properties: {} } }, run }] as any;
  let round = 0;
  const chatRound = async (_m: any[], opts: any) => {
    round++;
    if (round === 1) return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'demo__show', arguments: '{}' }] };
    opts.onDelta?.('ok');
    return { content: 'ok', finishReason: 'stop', toolCalls: [] };
  };
  return agentChat([{ role: 'user', content: 'go' }], { baseUrl: 'http://x', model: 'm', token: 't', onLive: () => {}, onLiveCommit: () => {}, extraTools, chatRound, ...extra } as any);
}

test('a live view reports every change, then its final phase, and nothing after', async () => {
  const seen: { phase: string; data: unknown; callId?: string; seq?: number }[] = [];
  let later: (() => void) | undefined;
  const r = await runOneToolTurn(async (_a, ctx) => {
    const v = ctx.liveView('console', { command: 'x', cwd: '~', text: '' });
    v.update({ command: 'x', cwd: '~', text: 'a' });
    later = () => v.update({ command: 'x', cwd: '~', text: 'late' });
    return 'ok';
  }, { onToolLive: (rec: any) => seen.push({ phase: rec.phase, data: rec.data, callId: rec.callId, seq: rec.seq }) });
  later!();
  expect(seen.map((s) => s.phase)).toEqual(['live', 'live', 'done']);
  expect(seen.at(-1)!.data).toEqual({ command: 'x', cwd: '~', text: 'a' });
  // The shape, not the provider's own tool-call id verbatim: `callId` is
  // `${turnKey}.${callSeq}#${n}`, random per turn, so two turns never share one —
  // this call is the turn's first (`callSeq` 0) and this view is its first (`n` 0).
  expect(seen.every((s) => /\.0#0$/.test(s.callId ?? '') && s.seq === 0)).toBe(true);
  expect(r.toolRuns[0]!.views).toEqual([expect.objectContaining({ kind: 'console', phase: 'done' })]);
});

test('two calls in one turn never collide, even when the provider\'s own ids do', async () => {
  // A test double (ScriptedModel) restarts its tool-call ids at `call_0` every
  // round, and some real servers send '' or reuse ids too — `callId` must not
  // depend on that id being unique across the turn.
  assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const extraTools = [{ type: 'function', function: { name: 'demo:show', description: 'd', parameters: { type: 'object', properties: {} } }, run: async (_a: unknown, ctx: any) => { ctx.liveView('console', { command: 'x' }); return 'ok'; } }] as any;
  let round = 0;
  const chatRound = async () => {
    round++;
    if (round <= 2) return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'call_0', name: 'demo__show', arguments: '{}' }] };
    return { content: 'ok', finishReason: 'stop', toolCalls: [] };
  };
  const ids: string[] = [];
  await agentChat([{ role: 'user', content: 'go' }], { baseUrl: 'http://x', model: 'm', token: 't', onLive: () => {}, onLiveCommit: () => {}, extraTools, chatRound, onToolLive: (rec: any) => ids.push(rec.callId) } as any);
  // Each call reports live then done — same id both times, the two calls' own ids differ.
  expect(ids).toHaveLength(4);
  expect(ids[0]).toBe(ids[1]);
  expect(ids[2]).toBe(ids[3]);
  expect(ids[0]).not.toBe(ids[2]);
  expect(ids[0]).toMatch(/\.0#0$/);
  expect(ids[2]).toMatch(/\.1#0$/);
  // Same turn key on both — only the call's own sequence tells them apart.
  expect(ids[0]!.split('.')[0]).toBe(ids[2]!.split('.')[0]);
});

test('a tool that throws keeps its view, marked failed', async () => {
  const phases: string[] = [];
  const r = await runOneToolTurn(async (_a, ctx) => { ctx.liveView('console', { command: 'x' }); throw new Error('boom'); }, { onToolLive: (rec: any) => phases.push(rec.phase) });
  expect(phases).toEqual(['live', 'failed']);
  expect(r.toolRuns[0]!.views?.[0]?.phase).toBe('failed');
});

test('a discarded view goes, and a one-off reportView — old form included — lands as done', async () => {
  const seen: string[] = [];
  const r = await runOneToolTurn(async (_a, ctx) => {
    ctx.liveView('console', { command: 'gone' }).discard();
    ctx.reportView({ kind: 'console', command: 'old', text: 't', exitCode: 0, ms: 1, cwd: '~' });
    return 'ok';
  }, { onToolLive: (rec: any) => seen.push(`${rec.data.command}:${rec.phase}`) });
  expect(seen).toEqual(['gone:live', 'old:live', 'gone:discarded', 'old:done']);
  expect(r.toolRuns[0]!.views?.map((v) => (v.data as { command: string }).command)).toEqual(['old']);
});

test('data that is not JSON or too big is dropped and the previous state stays', async () => {
  const datas: unknown[] = [];
  await runOneToolTurn(async (_a, ctx) => {
    const v = ctx.liveView('card', { n: 1 });
    v.update({ big: 'x'.repeat(70_000) });
    return 'ok';
  }, { onToolLive: (rec: any) => datas.push(rec.data) });
  expect(datas).toEqual([{ n: 1 }, { n: 1 }]);
});

// A console view's data is capped where it is collected, so a session file stays
// bounded whichever path handed the data over — including the legacy one-argument form.
test('a legacy console reportView is capped like any other console view', async () => {
  let captured: { command: string } | undefined;
  const r = await runOneToolTurn(async (_a, ctx) => {
    ctx.reportView({ kind: 'console', command: 'c'.repeat(VIEW_CAPS.command + 50), text: 'x', exitCode: 0, ms: 1, cwd: '~' });
    return 'ok';
  }, { onToolLive: (rec: any) => { captured = rec.data; } });
  expect(captured!.command).toHaveLength(VIEW_CAPS.command + 1);
  expect((r.toolRuns[0]!.views?.[0]!.data as { command: string }).command).toHaveLength(VIEW_CAPS.command + 1);
});

// A model can send a tool call whose function.arguments is not valid JSON (seen in
// practice: a stream that ended mid-arguments). Stored as it arrived, that poisons
// every later request with a 400 from the provider — forever. So a call that does not
// parse to a JSON object must not run, and must leave the history syntactically valid.
test('a tool call with truncated (invalid) JSON arguments is refused, not run, and the history stays valid', async () => {
  assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  let ran = 0;
  const extraTools = [{ type: 'function', function: { name: 'demo:show', description: 'd', parameters: { type: 'object', properties: {} } }, run: async () => { ran++; return 'shown'; } }] as any;
  let round = 0;
  let nextRoundMessages: any[] = [];
  const chatRound = async (messages: any[], opts: any) => {
    round++;
    if (round === 1) return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'demo__show', arguments: '{"a": "x' }] };
    nextRoundMessages = messages;
    opts.onDelta?.('ok');
    return { content: 'ok', finishReason: 'stop', toolCalls: [] };
  };
  const res = await agentChat([{ role: 'user', content: 'go' }], { baseUrl: 'http://x', model: 'm', token: 't', onLive: () => {}, onLiveCommit: () => {}, extraTools, chatRound });

  expect(ran).toBe(0);
  const toolMsg = nextRoundMessages.find((m) => m.role === 'tool');
  expect(toolMsg.content).toContain('not valid JSON');
  const asstMsg = nextRoundMessages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length);
  expect(asstMsg.tool_calls[0].function.arguments).toBe('{}');
  expect(res.toolRuns[0]!.outcome).toBe('error');
});

// Valid JSON that is not an object (an array here) is just as unusable to a tool as
// invalid JSON — same refusal.
test('a tool call whose arguments parse to a JSON array (not an object) is refused the same way', async () => {
  let ran = 0;
  const r = await runOneToolTurnWithArgs('[1,2]', async () => { ran++; return 'shown'; });
  expect(ran).toBe(0);
  expect(r.toolRuns[0]!.outcome).toBe('error');
  expect(String(r.toolRuns[0]!.detail)).toContain('not valid JSON');
});

// Empty arguments keep today's meaning: {} and the tool runs — some providers send ''
// for a tool with no parameters. But '' itself is not valid JSON (apiHistory would
// rewrite it on the NEXT turn) — so the call stored in history must already carry
// "{}", or a strict provider could reject THIS turn's own history on a later round.
test('empty arguments still mean {} and the tool still runs, and history gets "{}" too', async () => {
  let receivedArgs: unknown;
  const r = await runOneToolTurnWithArgs('', async (args) => { receivedArgs = args; return 'shown'; });
  expect(receivedArgs).toEqual({});
  expect(r.toolRuns[0]!.outcome).toBe('ok');
  const asstMsg = r.transcript.find((m) => m.role === 'assistant' && Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length) as any;
  expect(asstMsg.tool_calls[0].function.arguments).toBe('{}');
});

// Same one-tool-call-then-answer shape as runOneToolTurn, but with the call's raw
// arguments string under the test's control.
async function runOneToolTurnWithArgs(rawArguments: string, run: (args: unknown, ctx: any) => unknown) {
  assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const extraTools = [{ type: 'function', function: { name: 'demo:show', description: 'd', parameters: { type: 'object', properties: {} } }, run }] as any;
  let round = 0;
  const chatRound = async (_m: any[], opts: any) => {
    round++;
    if (round === 1) return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'demo__show', arguments: rawArguments }] };
    opts.onDelta?.('ok');
    return { content: 'ok', finishReason: 'stop', toolCalls: [] };
  };
  return agentChat([{ role: 'user', content: 'go' }], { baseUrl: 'http://x', model: 'm', token: 't', onLive: () => {}, onLiveCommit: () => {}, extraTools, chatRound } as any);
}

// apiHistory repairs a session saved BEFORE this fix existed (or hand-edited): any
// stored tool_calls[].function.arguments that is not a string parsing to JSON becomes
// "{}", a good call is untouched, and the input array/messages are never mutated.
test('apiHistory repairs a stored tool call whose arguments are not valid JSON', () => {
  const badCall = { id: 'bad', type: 'function', function: { name: 'x', arguments: '{"path": "a", "ref": "f' } };
  const goodCall = { id: 'good', type: 'function', function: { name: 'y', arguments: '{"ok":true}' } };
  const input = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [badCall, goodCall] } as any,
    { role: 'tool', tool_call_id: 'bad', content: 'ERROR: …' } as any,
    { role: 'tool', tool_call_id: 'good', content: 'OK: …' } as any,
  ];
  const before = JSON.parse(JSON.stringify(input));

  const history = apiHistory(input);

  const asst = history.find((m) => m.role === 'assistant' && Array.isArray((m as any).tool_calls)) as any;
  expect(asst.tool_calls.find((c: any) => c.id === 'bad').function.arguments).toBe('{}');
  expect(asst.tool_calls.find((c: any) => c.id === 'good').function.arguments).toBe('{"ok":true}');
  expect(input).toEqual(before); // never mutated
});
