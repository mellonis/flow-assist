// The servers over the run, against fake servers and a fake clock: a server that failed
// at start is tried again on the schedule and its group arrives when it answers; a
// 401/403 is not tried again; a server that drops is; disable, enable, restart, add and
// remove act at once and leave no attempt behind them.
import { afterEach, describe, expect, test } from 'bun:test';
import { PROTOCOL_VERSION, type Fetcher } from '../client.ts';
import { authReason, createServerManager, type ServerEvent, type Timers } from '../servers.ts';
import { stopAllServers } from '../stdio.ts';

afterEach(() => stopAllServers());

// A server that answers with `status` (a number) or as MCP ('ok') — switchable while the
// test runs.
function flaky(initial: number | 'ok' = 'ok') {
  const box = { mode: initial as number | 'ok', calls: [] as string[] };
  const fetch: Fetcher = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    box.calls.push(body.method);
    if (box.mode !== 'ok') return new Response('gateway', { status: box.mode });
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result = body.method === 'initialize' ? { protocolVersion: PROTOCOL_VERSION, serverInfo: { name: 'Tracker', version: '1' }, capabilities: { tools: {} } }
      : body.method === 'tools/list' ? { tools: [{ name: 'find', annotations: { readOnlyHint: true } }, { name: 'edit' }] }
      : { content: [{ type: 'text', text: 'ok' }] };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  };
  return { box, fetch };
}

// A clock that moves only when told; `due` runs the timers whose time has come.
function fakeTimers() {
  let now = 1_000_000;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void; ms: number }>();
  const timers: Timers = {
    now: () => now,
    set: (fn, ms) => { const id = ++seq; pending.set(id, { at: now + ms, fn, ms }); return id; },
    clear: (id) => { pending.delete(id as number); },
  };
  return {
    timers,
    delays: () => [...pending.values()].map((p) => p.ms),
    count: () => pending.size,
    async advance(ms: number) {
      now += ms;
      for (const [id, p] of [...pending]) if (p.at <= now) { pending.delete(id); p.fn(); }
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await Bun.sleep(5);
    },
  };
}

const schedule = { delays: [5_000, 15_000, 60_000], every: 300_000 };

describe('a server that is not there', () => {
  test('failed at start, it is tried again after 5 s, 15 s, 60 s, then every 5 minutes; when it answers its group arrives', async () => {
    const s = flaky(502);
    const t = fakeTimers();
    const events: ServerEvent[] = [];
    const m = createServerManager([{ name: 'tracker', spec: { url: 'http://x' } }], { fetch: s.fetch, schedule, timers: t.timers, onChange: (e) => { if (e) events.push(e); } });
    await m.start();
    expect(m.groups()).toEqual([]);
    expect(m.list()[0]).toMatchObject({ state: 'failed', reason: 'HTTP 502: gateway', nextAt: 1_005_000 });
    expect(t.delays()).toEqual([5_000]);
    await t.advance(5_000);
    expect(t.delays()).toEqual([15_000]);
    await t.advance(15_000);
    expect(t.delays()).toEqual([60_000]);
    await t.advance(60_000);
    expect(t.delays()).toEqual([300_000]);
    await t.advance(300_000);
    expect(t.delays()).toEqual([300_000]);
    s.box.mode = 'ok';
    await t.advance(300_000);
    expect(m.groups().map((g) => g.id)).toEqual(['mcp:tracker']);
    expect(m.list()[0]).toMatchObject({ state: 'connected', tools: [{ name: 'find' }, { name: 'edit' }], readOnly: 0 });
    expect(t.count()).toBe(0);
    expect(events.at(-1)).toEqual({ kind: 'connected', name: 'tracker', tools: 2 });
  });

  test('a 401 or a 403 is the token: not tried again, and the reason says so', async () => {
    for (const status of [401, 403]) {
      const s = flaky(status);
      const t = fakeTimers();
      const m = createServerManager([{ name: 'tracker', spec: { url: 'http://x' } }], { fetch: s.fetch, schedule, timers: t.timers });
      await m.start();
      expect(m.list()[0]).toMatchObject({ state: 'failed', auth: true, reason: authReason(status) });
      expect(m.list()[0]!.nextAt).toBeUndefined();
      expect(t.count()).toBe(0);
      await t.advance(1_000_000);
      expect(s.box.calls).toEqual(['initialize']);
      // A restart is the person saying it is fixed.
      s.box.mode = 'ok';
      await m.restart('tracker');
      expect(m.list()[0]!.state).toBe('connected');
    }
  });

  test('a connected server whose call finds the line down loses its group and is tried again', async () => {
    const s = flaky('ok');
    const t = fakeTimers();
    const events: ServerEvent[] = [];
    const m = createServerManager([{ name: 'tracker', spec: { url: 'http://x' } }], { fetch: s.fetch, schedule, timers: t.timers, onChange: (e) => { if (e) events.push(e); } });
    await m.start();
    const group = m.groups()[0]!;
    // The gateway goes down between two calls: the call says so, and the group goes.
    s.box.mode = 502;
    const out = await group.exec('tracker:find', {});
    expect(out.text).toContain('ERROR from tracker:find');
    expect(m.groups()).toEqual([]);
    expect(events[0]).toMatchObject({ kind: 'connected', name: 'tracker', first: true });
    expect(events[1]).toMatchObject({ kind: 'dropped', name: 'tracker' });
    expect(t.delays()).toEqual([5_000]);
    s.box.mode = 'ok';
    await t.advance(5_000);
    expect(m.groups().map((g) => g.id)).toEqual(['mcp:tracker']);
  });
});

describe('what counts as the server dropping', () => {
  // A server whose `tools/call` is answered by `onCall` (a Response, or a promise that
  // never settles), everything else as a healthy MCP server — `ping` included — until
  // `dead` is set, when nothing answers at all.
  function server(onCall: (init: RequestInit) => Promise<Response> | Response) {
    const s = flaky('ok');
    const box = { dead: false, pings: 0 };
    const hang = (init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    const fetch: Fetcher = async (u, init) => {
      if (box.dead) return hang(init);
      const body = JSON.parse(String(init.body));
      if (body.method === 'tools/call') return onCall(init);
      if (body.method === 'ping') { box.pings++; return Response.json({ jsonrpc: '2.0', id: body.id, result: {} }); }
      return s.fetch(u, init);
    };
    return { box, fetch, hang };
  }
  const spec = { url: 'http://x', timeoutMs: 30, connectTimeoutMs: 30 };

  // A broken tool, not a broken line: the model reads the call's error, the server — asked
  // whether it is there, and answering — keeps its tools.
  test('a 500 or a 404 answering one call is that tool\'s error; the server keeps its tools', async () => {
    for (const status of [500, 404]) {
      const srv = server(() => new Response('boom', { status }));
      const t = fakeTimers();
      const m = createServerManager([{ name: 'tracker', spec }], { fetch: srv.fetch, schedule, timers: t.timers });
      await m.start();
      const out = await m.groups()[0]!.exec('tracker:find', {});
      expect(out.text).toContain(`HTTP ${status}`);
      await Bun.sleep(20);
      expect(m.groups().map((g) => g.id)).toEqual(['mcp:tracker']);
      expect(t.count()).toBe(0);
    }
  });

  test('a slow call that times out is that call\'s error: the server answers a ping and keeps its tools', async () => {
    const srv = server((init) => srv.hang(init));
    const t = fakeTimers();
    const m = createServerManager([{ name: 'wiki', spec }], { fetch: srv.fetch, schedule, timers: t.timers });
    await m.start();
    const out = await m.groups()[0]!.exec('wiki:find', {});
    expect(out.text).toContain('no answer in 30 ms');
    await Bun.sleep(20);
    expect(srv.box.pings).toBe(1);
    expect(m.list()[0]!.state).toBe('connected');
    expect(m.groups().map((g) => g.id)).toEqual(['mcp:wiki']);
    expect(t.count()).toBe(0);
  });

  test('a call that times out on a server that is gone drops it: the ping gets no answer either', async () => {
    const srv = server((init) => { srv.box.dead = true; return srv.hang(init); });
    const t = fakeTimers();
    const m = createServerManager([{ name: 'wiki', spec }], { fetch: srv.fetch, schedule, timers: t.timers });
    await m.start();
    await m.groups()[0]!.exec('wiki:find', {});
    for (let i = 0; i < 20 && m.groups().length; i++) await Bun.sleep(10);
    expect(m.groups()).toEqual([]);
    expect(m.list()[0]!.state).toBe('failed');
    expect(t.delays()).toEqual([5_000]);
  });

  test('a transport failure is a drop at once: 502/503/504, a refused connection', async () => {
    const cases: Array<[string, () => Promise<Response>]> = [
      ['503', async () => new Response('down', { status: 503 })],
      ['504', async () => new Response('slow', { status: 504 })],
      ['refused', async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1'); }],
    ];
    for (const [label, broken] of cases) {
      const srv = server(broken);
      const t = fakeTimers();
      const m = createServerManager([{ name: 'tracker', spec }], { fetch: srv.fetch, schedule, timers: t.timers });
      await m.start();
      await m.groups()[0]!.exec('tracker:find', {});
      expect([label, m.groups()]).toEqual([label, []]);
      expect(srv.box.pings).toBe(0);
      expect(t.delays()).toEqual([5_000]);
    }
  });
});

describe('an answer the server gives to a ping, and a session it forgot', () => {
  // A server that has never heard of `ping` answers it with a JSON-RPC error — it is
  // there, and keeps its tools.
  test('a ping answered with a JSON-RPC error counts as an answer', async () => {
    const s = flaky('ok');
    let calls = 0;
    const fetch: Fetcher = async (u, init) => {
      const body = JSON.parse(String(init.body));
      if (body.method === 'ping') return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
      if (body.method === 'tools/call') { calls++; return new Response('boom', { status: 500 }); }
      return s.fetch(u, init);
    };
    const t = fakeTimers();
    const m = createServerManager([{ name: 'ide', spec: { url: 'http://x' } }], { fetch, schedule, timers: t.timers });
    await m.start();
    await m.groups()[0]!.exec('ide:find', {});
    await Bun.sleep(20);
    expect(calls).toBe(1);
    expect(m.list()[0]!.state).toBe('connected');
    expect(t.count()).toBe(0);
  });

  // Streamable HTTP answers 404 to a session id it no longer knows: the call and the
  // ping both get it, a new session is started, and the call is made again — once.
  test('a session the server forgot: a new one is started and the call made again, once', async () => {
    let session = 'S1';
    let forgotten = false;
    const seen: Array<[string, string | null]> = [];
    const fetch: Fetcher = async (_u, init) => {
      const body = JSON.parse(String(init.body));
      const sid = (init.headers as Record<string, string>)['mcp-session-id'] ?? null;
      seen.push([body.method, sid]);
      if (body.method !== 'initialize' && forgotten && sid === 'S1') return new Response('unknown session', { status: 404 });
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (body.method === 'initialize') {
        if (forgotten) session = 'S2';
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: PROTOCOL_VERSION, serverInfo: { name: 'Wiki' }, capabilities: {} } }, { headers: { 'mcp-session-id': session } });
      }
      if (body.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'search' }] } });
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `found in ${sid}` }] } });
    };
    const t = fakeTimers();
    const m = createServerManager([{ name: 'wiki', spec: { url: 'http://x' } }], { fetch, schedule, timers: t.timers });
    await m.start();
    forgotten = true;
    const out = await m.groups()[0]!.exec('wiki:search', {});
    expect(out.text).toContain('found in S2');
    expect(m.list()[0]!.state).toBe('connected');
    expect(seen.filter(([method]) => method === 'tools/call').map(([, sid]) => sid)).toEqual(['S1', 'S2']);
    expect(t.count()).toBe(0);
  });

  // A turn's tool list is fixed at its start: a call to a server that dropped since
  // reaches its group's last dispatch and says where the server stands.
  test('a call to a server that dropped says it is not connected and when it is tried next', async () => {
    const s = flaky('ok');
    const t = fakeTimers();
    const m = createServerManager([{ name: 'tracker', spec: { url: 'http://x' } }], { fetch: s.fetch, schedule, timers: t.timers });
    await m.start();
    const group = m.groups()[0]!;
    s.box.mode = 502;
    await group.exec('tracker:find', {});
    expect(m.groups()).toEqual([]);
    await expect(group.exec('tracker:find', {})).rejects.toThrow('tracker is not connected — retrying in 5 s');
    m.disable('tracker');
    await expect(group.exec('tracker:find', {})).rejects.toThrow('tracker is disabled');
  });

  // `/mcp remove` in the middle of a turn: the turn's call is told the person removed the
  // server — never that it came back and the tool should be called again. The host asks
  // the group the same through `gone` once the group has left the registry.
  // The server came back, without one of its tools: the host asks the old group why the
  // tool left, and must not be told to call it again — it is not coming back. A direct
  // call to the old group still says the server is there again.
  test('a server back without a tool: the old group has nothing to add for the host', async () => {
    let tools: Array<{ name: string }> = [{ name: 'find' }, { name: 'edit' }];
    const fetch: Fetcher = async (_u, init) => {
      const body = JSON.parse(String(init.body));
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result = body.method === 'initialize' ? { protocolVersion: PROTOCOL_VERSION, serverInfo: { name: 'T', version: '1' }, capabilities: { tools: {} } }
        : body.method === 'tools/list' ? { tools } : { content: [{ type: 'text', text: 'ok' }] };
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    };
    const t = fakeTimers();
    const m = createServerManager([{ name: 'tracker', spec: { url: 'http://x' } }], { fetch, schedule, timers: t.timers });
    await m.start();
    const old = m.groups()[0]!;
    tools = [{ name: 'find' }];
    await m.restart('tracker');
    expect(m.groups()[0]).not.toBe(old);
    expect(old.gone()).toBeNull();
    await expect(old.exec('tracker:edit', {})).rejects.toThrow('call the tool again');
  });

  test('a call to a server removed since says the person removed it', async () => {
    const s = flaky('ok');
    const t = fakeTimers();
    const m = createServerManager([{ name: 'tracker', spec: { url: 'http://x' } }], { fetch: s.fetch, schedule, timers: t.timers });
    await m.start();
    const group = m.groups()[0]!;
    expect(group.gone()).toBeNull();
    m.remove('tracker');
    expect(m.groups()).toEqual([]);
    await expect(group.exec('tracker:find', {})).rejects.toThrow('tracker was removed by the person');
    expect(group.gone()).toBe('tracker was removed by the person');
  });
});

describe('the person\'s levers', () => {
  test('a server disabled at start is never connected; enable connects it, disable takes it off and clears its retry', async () => {
    const s = flaky('ok');
    const t = fakeTimers();
    const m = createServerManager([{ name: 'tracker', spec: { url: 'http://x', enabled: false } }], { fetch: s.fetch, schedule, timers: t.timers });
    await m.start();
    expect(s.box.calls).toEqual([]);
    expect(m.list()[0]!.state).toBe('disabled');
    await m.enable('tracker');
    expect(m.groups()).toHaveLength(1);
    m.disable('tracker');
    expect(m.groups()).toEqual([]);
    // Failing, then turned off: no attempt is left behind.
    s.box.mode = 502;
    await m.enable('tracker');
    expect(t.count()).toBe(1);
    m.disable('tracker');
    expect(t.count()).toBe(0);
    s.box.mode = 'ok';
    await t.advance(1_000_000);
    expect(m.list()[0]!.state).toBe('disabled');
  });

  test('restart tries now and starts the backoff over', async () => {
    const s = flaky(502);
    const t = fakeTimers();
    const m = createServerManager([{ name: 'tracker', spec: { url: 'http://x' } }], { fetch: s.fetch, schedule, timers: t.timers });
    await m.start();
    await t.advance(5_000);
    expect(t.delays()).toEqual([15_000]);
    await m.restart('tracker');
    expect(t.delays()).toEqual([5_000]);
  });

  test('an attempt that finishes after the server was turned off brings nothing back', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const s = flaky('ok');
    const slow: Fetcher = async (u, i) => { await gate; return s.fetch(u, i); };
    const m = createServerManager([{ name: 'tracker', spec: { url: 'http://x' } }], { fetch: slow, schedule, timers: fakeTimers().timers });
    const started = m.start();
    m.disable('tracker');
    release();
    await started;
    expect(m.groups()).toEqual([]);
    expect(m.list()[0]!.state).toBe('disabled');
  });

  test('add connects a new server; remove lets it go; stop clears every timer', async () => {
    const s = flaky(502);
    const t = fakeTimers();
    const m = createServerManager([], { fetch: s.fetch, schedule, timers: t.timers });
    await m.add('tracker', { url: 'http://x' });
    expect(m.list().map((v) => [v.name, v.state])).toEqual([['tracker', 'failed']]);
    expect(t.count()).toBe(1);
    m.remove('tracker');
    expect(m.list()).toEqual([]);
    expect(t.count()).toBe(0);
    await m.add('other', { url: 'http://x' });
    m.stop();
    expect(t.count()).toBe(0);
  });
});
