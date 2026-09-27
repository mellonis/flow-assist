// `/mcp` and `:mcp` against the plugin as the loader builds it: the list (a panel in the
// chat, a line on the command line), disable/enable saved or for the run, restart, add
// and remove through the host's config service, a server's tools — and the names
// completed. The host's side is a fake that records what it was asked to set.
import { describe, expect, test } from 'bun:test';
import { PROTOCOL_VERSION, type Fetcher } from '../client.ts';
import { buildMcpPlugin } from '../index.ts';
import type { Timers } from '../servers.ts';

function server(mode: { status: number | 'ok' }) {
  const fetch: Fetcher = async (_u, init) => {
    const body = JSON.parse(String(init.body));
    if (mode.status !== 'ok') return new Response('nope', { status: mode.status });
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result = body.method === 'initialize' ? { protocolVersion: PROTOCOL_VERSION, serverInfo: { name: 'IDE', version: '1' }, capabilities: { tools: {} } }
      : { tools: [{ name: 'get_file_text', description: 'Read a file', annotations: { readOnlyHint: true } }, { name: 'replace_text', description: 'Edit a file' }] };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  };
  return fetch;
}

const timers: Timers = { now: () => 1_000_000, set: () => 1, clear: () => {} };

async function boot(servers: Record<string, unknown>, mode = { status: 'ok' as number | 'ok' }) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = server(mode) as unknown as typeof fetch;
  const config = { plugins: { mcp: { servers } } };
  let changed = 0;
  const plugin = await buildMcpPlugin({ make: (_n, s) => s, config, toolsChanged: () => { changed++; }, timers, retry: { delays: [5_000], every: 5_000 } }) as Record<string, any>;
  globalThis.fetch = realFetch;
  const set: Array<[string, unknown, boolean]> = [];
  const unset: Array<[string, boolean]> = [];
  const notes: string[] = [];
  const services = {
    pushLog: () => {},
    chatNote: (t: string) => notes.push(t),
    notify: () => {},
    setConfig: (key: string, value: unknown, o?: { session?: boolean }) => { set.push([key, value, !!o?.session]); return { ok: true, value }; },
    unsetConfig: (key: string, o?: { session?: boolean }) => { unset.push([key, !!o?.session]); return { ok: true, value: undefined }; },
  };
  plugin.setup({ ui: {}, host: { services } });
  const cmd = plugin.commands.find((c: { name: string }) => c.name === 'mcp');
  const said: string[] = [];
  const errors: string[] = [];
  let panel: any = null;
  const chat = { surface: 'chat', say: (t: string) => said.push(t), error: (t: string) => errors.push(t), openPanel: (p: unknown) => { panel = p; } };
  const line = { surface: 'line', showMessage: (t: string) => said.push(t) };
  return { plugin, cmd, set, unset, notes, said, errors, chat, line, panel: () => panel, changed: () => changed };
}

describe('what /mcp says', () => {
  test('the note counts in words: 1 tool, N tools; the start screen\'s count follows a late connect', async () => {
    const mode = { status: 502 as number | 'ok' };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (mode.status !== 'ok') return new Response('nope', { status: mode.status });
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result = body.method === 'initialize' ? { protocolVersion: PROTOCOL_VERSION, serverInfo: { name: 'IDE', version: '1' }, capabilities: { tools: {} } } : { tools: [{ name: 'only' }] };
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    }) as unknown as typeof fetch;
    const due: Array<() => void> = [];
    const later: Timers = { now: () => 0, set: (fn) => { due.push(fn); return due.length; }, clear: () => {} };
    const plugin = await buildMcpPlugin({ make: (_n, s) => s, config: { plugins: { mcp: { servers: { ide: { url: 'http://x' } } } } }, timers: later }) as Record<string, any>;
    globalThis.fetch = realFetch;
    const notes: string[] = [];
    plugin.setup({ ui: {}, host: { services: { pushLog: () => {}, notify: () => {}, chatNote: (t: string) => notes.push(t) } } });
    expect(plugin.description).toBe('MCP — 0 of 1 servers connected');
    mode.status = 'ok';
    due.shift()!();
    await Bun.sleep(20);
    expect(notes).toEqual(['mcp: ide connected — 1 tool']);
    expect(plugin.description).toBe('MCP — 1 of 1 servers connected');
  });

  test(':mcp help says every line — in the chat, as a note', async () => {
    const b = await boot({});
    const opened: string[] = [];
    b.cmd.run({ ...b.line, openChat: () => opened.push('open') }, 'help');
    expect(opened).toEqual(['open']);
    expect(b.notes.at(-1)).toContain('/mcp tools <name>');
    expect(b.notes.at(-1)).toContain('headers and env are never taken here');
  });
});

describe('/mcp remove', () => {
  test('a server config.json sets is refused, and a disable its overrides held is put back', async () => {
    const b = await boot({ ide: { url: 'http://x', enabled: false } });
    // The host's unset answers with what is left: config.json's entry.
    b.plugin.setup({ ui: {}, host: { services: {
      pushLog: () => {}, notify: () => {},
      setConfig: (key: string, value: unknown, o?: { session?: boolean }) => { b.set.push([key, value, !!o?.session]); return { ok: true, value }; },
      unsetConfig: (key: string, o?: { session?: boolean }) => { b.unset.push([key, !!o?.session]); return { ok: true, value: { url: 'http://x' } }; },
    } } });
    b.cmd.run(b.chat, 'remove ide');
    expect(b.errors.at(-1)).toContain('set in config.json');
    expect(b.set).toEqual([['plugins.mcp.servers.ide.enabled', false, false]]);
    b.cmd.run(b.chat, '');
    expect(b.panel().rows().map((r: { id: string }) => r.id)).toEqual(['ide']);
  });
});

describe('/mcp', () => {
  test('bare: a panel in the chat — name, transport, state, read-only count — and one line on the command line', async () => {
    const b = await boot({ ide: { url: 'http://x', trusted: true }, off: { url: 'http://y', enabled: false } });
    expect(b.cmd.chat).toBe(true);
    b.cmd.run(b.chat, '');
    const rows = b.panel().rows();
    expect(rows).toEqual([
      { id: 'ide', text: 'ide', detail: 'http · connected · 2 tools · 1 read-only', tone: 'ok' },
      { id: 'off', text: 'off', detail: 'http · disabled' },
    ]);
    expect(b.panel().keys.map((k: { key: string }) => k.key)).toEqual(['d', 'r', 't']);
    b.cmd.run(b.line, '');
    expect(b.said.at(-1)).toBe('mcp: ide (http) connected · 2 tools · off (http) disabled');
  });

  test('a failed server says why and when it is tried next', async () => {
    const b = await boot({ tracker: { url: 'http://x' } }, { status: 502 });
    b.cmd.run(b.chat, '');
    expect(b.panel().rows()[0].detail).toBe('http · failed — HTTP 502: nope · retrying in 5 s');
    expect(b.panel().rows()[0].tone).toBe('error');
  });

  test('disable and enable act at once and are saved — or kept for the run with --session', async () => {
    const b = await boot({ ide: { url: 'http://x' } });
    const realFetch = globalThis.fetch;
    globalThis.fetch = server({ status: 'ok' }) as unknown as typeof fetch;
    try {
      b.cmd.run(b.chat, 'disable ide');
      expect(b.set).toEqual([['plugins.mcp.servers.ide.enabled', false, false]]);
      expect(b.plugin.tools).toEqual([]);
      expect(b.said.at(-1)).toBe('mcp: ide disabled (saved)');
      b.cmd.run(b.chat, 'enable ide --session');
      expect(b.set.at(-1)).toEqual(['plugins.mcp.servers.ide.enabled', true, true]);
      await Bun.sleep(20);
      expect(b.plugin.tools.map((g: { id: string }) => g.id)).toEqual(['mcp:ide']);
      expect(b.notes).toEqual(['mcp: ide connected — 2 tools']);
      // The panel's key does the same.
      b.cmd.run(b.chat, '');
      expect(b.panel().keys[0].run('ide')).toBe('mcp: ide disabled (saved)');
      expect(b.plugin.tools).toEqual([]);
    } finally { globalThis.fetch = realFetch; }
  });

  test('add writes the server whole and connects it; remove takes it out; headers are never taken', async () => {
    const b = await boot({});
    b.cmd.run(b.chat, 'add tracker https://mcp.example/mcp');
    expect(b.set).toEqual([['plugins.mcp.servers.tracker', { url: 'https://mcp.example/mcp' }, false]]);
    b.cmd.run(b.chat, 'add safari /nonexistent/mcp-server --mcp');
    expect(b.set.at(-1)).toEqual(['plugins.mcp.servers.safari', { command: '/nonexistent/mcp-server', args: ['--mcp'] }, false]);
    b.cmd.run(b.chat, 'add tracker https://again');
    expect(b.errors.at(-1)).toContain('"tracker" is there already');
    b.cmd.run(b.chat, 'add bad.name https://x');
    expect(b.errors.at(-1)).toContain('letters, digits');
    b.cmd.run(b.chat, 'remove tracker');
    expect(b.unset).toEqual([['plugins.mcp.servers.tracker', false]]);
    b.cmd.run(b.chat, 'help');
    expect(b.said.at(-1)).toContain('headers and env are never taken here');
    b.cmd.run(b.chat, 'restart nope');
    expect(b.errors.at(-1)).toContain('no server "nope"');
  });

  test('tools: the server\'s tools, the read-only ones marked', async () => {
    const b = await boot({ ide: { url: 'http://x', readOnly: ['get_file_text'] } });
    b.cmd.run(b.line, 'tools ide');
    expect(b.said.at(-1)).toBe('mcp: ide — get_file_text (read-only), replace_text');
    b.cmd.run(b.chat, 'tools ide');
    expect(b.panel().rows().map((r: { text: string; detail: string }) => [r.text, r.detail])).toEqual([['get_file_text', 'read-only · Read a file'], ['replace_text', 'Edit a file']]);
  });

  test('completion: the actions, then the servers\' names, then --session', async () => {
    const b = await boot({ ide: { url: 'http://x' }, safari: { command: '/x', enabled: false } });
    expect(b.cmd.complete([])).toContain('disable');
    expect(b.cmd.complete(['disable']).map((v: { value: string }) => v.value)).toEqual(['ide', 'safari']);
    expect(b.cmd.complete(['disable', 'ide'])).toEqual(['--session']);
    expect(b.cmd.complete(['add'])).toEqual([]);
  });
});
