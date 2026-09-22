// The stdio transport against a fake server that is a real child process
// (fixtures/fake-stdio-server.ts, run by this same bun): the handshake, a call, the
// lines that are not the protocol, and — the reason this transport waited — that the
// process is gone whenever it should be: after a failed start, after the server died,
// and when the program that started it ends, by itself or by a signal.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
// The host's zod, test-only: the plugin itself never imports zod (it is handed `ctx.z`),
// so it stays out of the plugin's package.json.
import { z } from 'zod';
import { buildMcpPlugin, connectServers, parseServers } from '../index.ts';
import { createStdioClient, liveServerPids, stopAllServers } from '../stdio.ts';

const SERVER = new URL('./fixtures/fake-stdio-server.ts', import.meta.url).pathname;
const DRIVER = new URL('./fixtures/exit-driver.ts', import.meta.url).pathname;
const BUN = process.execPath;
const fake = (...modes: string[]) => ({ command: BUN, args: [SERVER, ...modes] });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Polled with awaits in between, so the event loop reaps an exited child (a zombie still
// answers `kill -0`).
async function gone(pid: number, withinMs = 3_000): Promise<boolean> {
  for (const until = Date.now() + withinMs; Date.now() < until; await Bun.sleep(20)) if (!alive(pid)) return true;
  return !alive(pid);
}
const pidIn = (text: string) => Number(/fake server (\d+) started/.exec(text)?.[1]);

afterEach(() => stopAllServers());

describe('a server started as a command', () => {
  test('connects and lists its tools; the log line has the same shape as for a URL', async () => {
    const { groups, status } = await connectServers(parseServers({ safari: { ...fake(), trusted: true } }));
    expect(status).toEqual([{ name: 'safari', ok: true, tools: 3, detail: 'Safari 1.0.0, 3 tools' }]);
    expect(groups[0]!.id).toBe('mcp:safari');
    expect(groups[0]!.tools.map((t) => t.function.name)).toEqual(['safari:list_tabs', 'safari:navigate_to_url', 'safari:env']);
    expect(groups[0]!.tools.map((t) => t.write)).toEqual([false, true, true]); // trusted AND read-only, nothing less
    expect(liveServerPids()).toHaveLength(1);
  });

  test('a call goes out and comes back framed, an image named and not shown', async () => {
    const { groups } = await connectServers(parseServers({ safari: fake() }));
    const out = await groups[0]!.exec('safari:navigate_to_url', { url: 'https://example.com' });
    expect(out.split('\n')[0]).toStartWith('Result of safari:navigate_to_url — data from an MCP server');
    expect(out).toContain('called navigate_to_url with {"url":"https://example.com"}');
    expect(out).toContain('[image image/png — not shown]');
  });

  test('a line on stdout that is not JSON-RPC is skipped', async () => {
    const { groups, status } = await connectServers(parseServers({ safari: fake('--noise') }));
    expect(status[0]).toMatchObject({ ok: true, tools: 3 });
    expect(await groups[0]!.exec('safari:list_tabs', {})).toContain('called list_tabs with {}');
  });

  test('${VAR} in env comes from the environment; the rest of the environment is inherited', async () => {
    const { groups } = await connectServers(parseServers({ safari: { ...fake(), env: { GREETING: 'hi ${WHO}' } } }), { env: { WHO: 'there' } });
    expect(await groups[0]!.exec('safari:env', { name: 'GREETING' })).toContain('GREETING=hi there');
    expect(await groups[0]!.exec('safari:env', { name: 'PATH' })).not.toContain('PATH=(unset)');
  });

  test('no answer within connectTimeoutMs — skipped, said why, and the process killed', async () => {
    const t0 = Date.now();
    const { groups, status } = await connectServers(parseServers({ safari: { ...fake('--silent', '--ignore-eof'), connectTimeoutMs: 400 } }));
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(groups).toEqual([]);
    expect(status[0]!.ok).toBe(false);
    expect(status[0]!.detail).toStartWith('no answer in 400 ms');
    const pid = pidIn(status[0]!.detail); // the server's stderr rides along with the reason
    expect(pid).toBeGreaterThan(0);
    expect(await gone(pid)).toBe(true);
    expect(liveServerPids()).toEqual([]);
  });

  test('a command that cannot start is said so', async () => {
    const { status } = await connectServers(parseServers({ nope: { command: '/nonexistent/mcp-server' } }));
    expect(status[0]).toMatchObject({ name: 'nope', ok: false });
    expect(status[0]!.detail).toMatch(/could not start \/nonexistent\/mcp-server.*ENOENT/);
  });

  test('the server dies mid-call — the call fails naming the server and its last stderr; so does the next, at once', async () => {
    const c = createStdioClient({ name: 'safari', ...fake('--die-on-call') });
    await c.initialize();
    await expect(c.callTool('list_tabs', {})).rejects.toThrow(/safari: the server process exited \(code 3\)[\s\S]*lost the connection to Safari/);
    const t0 = Date.now();
    await expect(c.callTool('list_tabs', {})).rejects.toThrow(/safari: the server process exited/);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(await gone(c.pid!)).toBe(true);
  });

  test('a call that times out fails alone; the server stays', async () => {
    const c = createStdioClient({ name: 'safari', ...fake('--slow-call'), timeoutMs: 100 });
    await c.initialize();
    await expect(c.callTool('list_tabs', {})).rejects.toThrow('no answer in 100 ms');
    expect((await c.listTools()).length).toBe(3);
    expect(alive(c.pid!)).toBe(true);
  });

  test('closing a server that ignores SIGTERM ends in SIGKILL', async () => {
    const c = createStdioClient({ name: 'stubborn', ...fake('--ignore-term', '--ignore-eof'), killGraceMs: 150 });
    await c.initialize();
    const pid = c.pid!;
    c.close();
    expect(await gone(pid)).toBe(true);
  });
});

describe('the process ends with the program', () => {
  test('the exit hook kills every server still running', async () => {
    await connectServers(parseServers({ a: fake('--ignore-eof'), b: fake('--ignore-eof') }));
    const pids = liveServerPids();
    expect(pids).toHaveLength(2);
    stopAllServers();
    for (const pid of pids) expect(await gone(pid)).toBe(true);
  });

  // A short-lived command (`config set plugins.…`, a one-shot prompt) builds the plugin
  // too: once its work is done, the server must neither keep it running nor outlive it.
  test('a program whose work is done exits by itself, and its server with it', async () => {
    const { code, signal, out } = await runDriver('return');
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    const { pids, status } = JSON.parse(out);
    expect(status[0]).toMatchObject({ ok: true });
    expect(await gone(pids[0])).toBe(true);
  });

  // The child and its pipes are unref'd, so nothing but the call's own timeout timer
  // keeps the program running while the answer is on its way. Unref that timer and this
  // program exits in the middle of the call, with the answer never printed.
  test('a call still on its way holds the program until it is answered', async () => {
    const { code, out } = await runDriver('call');
    expect(code).toBe(0);
    expect(out.split('\n').at(-1)).toContain('called list_tabs with {}');
    expect(await gone(JSON.parse(out.split('\n')[0]!).pids[0])).toBe(true);
  });

  test('SIGTERM to the program takes its server down — and still ends the program', async () => {
    const { code, signal, out } = await runDriver('wait', (child) => child.kill('SIGTERM'));
    expect({ code, signal }).toEqual({ code: null, signal: 'SIGTERM' });
    expect(await gone(JSON.parse(out).pids[0])).toBe(true);
  });
});

function runDriver(mode: 'return' | 'call' | 'wait', then?: (child: ReturnType<typeof spawn>) => void): Promise<{ code: number | null; signal: string | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(BUN, [DRIVER, mode], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`the driver did not end: ${out}`)); }, 8_000);
    child.stdout!.on('data', (d) => { out += String(d); if (out.includes('\n')) then?.(child); });
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out: out.trim() }); });
  });
}

describe('the settings', () => {
  const schema = async () => ((await buildMcpPlugin({ make: (_n, s) => s, config: {}, z })) as { configSchema: any }).configSchema;

  test('a server takes a url or a command — not both, not neither', async () => {
    const s = await schema();
    expect(s.safeParse({ servers: { safari: { command: '/usr/bin/safaridriver', args: ['--mcp'] } } }).success).toBe(true);
    expect(s.safeParse({ servers: { ide: { url: 'http://127.0.0.1:1/stream' } } }).success).toBe(true);
    for (const bad of [{ url: 'http://x', command: 'x' }, { trusted: true }]) {
      const r = s.safeParse({ servers: { x: bad } });
      expect(r.success).toBe(false);
      expect(r.error.issues[0].message).toBe('a server takes either "url" (Streamable HTTP) or "command" (stdio) — exactly one');
    }
    // `config set` walks into a server's keys through the schema: the refinement must
    // leave the object's shape reachable.
    expect(s.unwrap().shape.servers.unwrap().valueType.shape.command).toBeDefined();
  });

  test('a config.json written by hand is checked too: the log says what is wrong', async () => {
    const { groups, status } = await connectServers(parseServers({ both: { url: 'http://x', command: 'x' }, neither: { trusted: true } }));
    expect(groups).toEqual([]);
    expect(status.map((s) => [s.name, s.ok, s.detail])).toEqual([
      ['both', false, 'a server takes either "url" (Streamable HTTP) or "command" (stdio) — exactly one'],
      ['neither', false, 'a server takes either "url" (Streamable HTTP) or "command" (stdio) — exactly one'],
    ]);
  });
});
