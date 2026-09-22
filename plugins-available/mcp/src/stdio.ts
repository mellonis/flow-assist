// The stdio transport: an MCP server started as a command (`safaridriver --mcp`), spoken
// to over its stdin and stdout. The protocol is `client.ts`'s; this file moves messages
// and owns the process.
//
// Framing is the MCP stdio one: one JSON-RPC message per line. A line on stdout that is
// not JSON-RPC (a banner, a stray log line) is skipped, never fatal. stderr is the
// server's log: its last few KB are kept for error messages and never read as protocol.
//
// The process is started without a shell — the command and its arguments go to the
// kernel as written in the person's config, so nothing in them is ever re-parsed by
// `sh -c` — with the assistant's environment plus the server's `env` on top.
//
// Its life:
// - It is started when the plugin is built and lives for the whole run: one process per
//   server, shared by every conversation. That is process-level state on purpose (the
//   set of live servers below is module-level for that reason), unlike a conversation's
//   tool state.
// - A server that does not answer the handshake in time is stopped by the caller
//   (`close`), as an unreachable HTTP server is skipped.
// - A server that dies is not restarted: every call after that, and every call that was
//   waiting, fails naming the server and what it last wrote to stderr.
// - It never keeps the assistant running. The process and its pipes are unref'd, so a
//   short-lived command that built the plugin (`config set plugins.…`, a one-shot prompt)
//   exits once its own work is done. A request in flight holds the program through its
//   timeout timer, which stays ref'd: without it a one-shot prompt could exit in the
//   middle of a tool call whose answer was still coming.
// - It ends with the assistant. `process.on('exit')` stops every live server — that
//   covers `:quit`, Ctrl+C in the app (a key, then `process.exit`) and a short-lived
//   command running out of work. A signal (SIGTERM, SIGHUP, SIGINT from outside) ends a
//   program WITHOUT the exit event, so those are heard too — see `hookExit` for how that
//   stays out of flowtty's way.
// - SIGTERM first, then SIGKILL when `close` is given the time to wait. At exit there is
//   no time: SIGTERM, and the stdin pipe closing with us, which an MCP stdio server takes
//   as the end of the session.

import { spawn, type ChildProcess } from 'node:child_process';
import { McpError, createProtocol, type McpTransport, type ProtocolOptions } from './client.ts';

export interface StdioClientOptions extends ProtocolOptions {
  // The server's name in the config: every error says which server it is about.
  name: string;
  command: string;
  args?: string[];
  // Added to the assistant's environment (already expanded by the caller).
  env?: Record<string, string>;
  // How long `close` waits after SIGTERM before SIGKILL.
  killGraceMs?: number;
}

const STDERR_KEPT = 4096;
const STDERR_SHOWN = 600;
// One message on one line can be large (a screenshot is base64 in the line), but not
// without limit: a server that never writes a newline must not eat the memory.
const MAX_LINE = 64 * 1024 * 1024;

const live = new Set<ChildProcess>();
const SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT'] as const;
let hooked = false;

// The pids of the servers running now.
export function liveServerPids(): number[] {
  return [...live].flatMap((c) => (c.pid ? [c.pid] : []));
}

// Stops every server still running: SIGTERM and its stdin closed. Synchronous, so it can
// run inside the process's `exit` event.
export function stopAllServers(): void {
  for (const child of live) {
    try { child.stdin?.destroy(); } catch { /* already gone */ }
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  live.clear();
}

// Installed once, with the first server started.
//
// A termination signal must stop the servers AND still end the program as it would have
// ended. flowtty (the app's renderer) listens for the same signals and decides whether to
// re-raise one by COUNTING listeners: with another listener present it assumes the app
// handles the signal and does not re-raise, and the app would then keep running after
// Ctrl+C. So this handler stops the servers and removes ITSELF before flowtty looks; if
// nobody else is listening any more (no app on screen — a one-shot prompt), it re-raises
// the signal itself, and the program dies by it as if nobody had listened at all. Either
// order of the two listeners ends the same way.
function hookExit(): void {
  if (hooked) return;
  hooked = true;
  process.on('exit', stopAllServers);
  for (const sig of SIGNALS) {
    const onSignal = () => {
      stopAllServers();
      process.removeListener(sig, onSignal);
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    process.on(sig, onSignal);
  }
}

type Pending = { resolve: (m: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export function createStdioClient(opts: StdioClientOptions) {
  const { name } = opts;
  const pending = new Map<number, Pending>();
  let stderr = '';
  let heardFromServer = false;
  let dead: McpError | undefined;
  let exited = false;
  let child: ChildProcess | undefined;

  const stderrTail = () => {
    const t = stderr.replace(/\s+/g, ' ').trim();
    return t.length > STDERR_SHOWN ? `…${t.slice(-STDERR_SHOWN)}` : t;
  };
  const withStderr = (msg: string) => (stderrTail() ? `${msg} — stderr: ${stderrTail()}` : msg);

  // The server is gone (or never came): every waiting request fails now, every later
  // one at once.
  const die = (err: McpError) => {
    if (dead) return;
    dead = err;
    if (child) live.delete(child);
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(err);
    }
  };

  try {
    child = spawn(opts.command, opts.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
      shell: false,
    });
  } catch (e) {
    die(new McpError(`${name}: could not start ${opts.command}: ${(e as Error).message}`));
  }

  if (child) {
    const c = child;
    live.add(c);
    hookExit();
    c.unref();
    for (const s of [c.stdin, c.stdout, c.stderr]) (s as { unref?: () => void } | null)?.unref?.();

    c.on('error', (e) => die(new McpError(`${name}: could not start ${opts.command}: ${e.message}`)));
    // A write to a server that has just died fails with EPIPE; the exit that follows says
    // what happened, in better words.
    c.stdin?.on('error', () => {});

    c.stderr?.setEncoding('utf8');
    c.stderr?.on('data', (d: string) => {
      stderr = (stderr + d).slice(-STDERR_KEPT);
    });

    // Lines are gathered as parts and joined once whole: a large line (a screenshot)
    // arrives in many chunks, and adding each to a growing string would copy it over
    // and over.
    let parts: string[] = [];
    let size = 0;
    let skipping = false;
    c.stdout?.setEncoding('utf8');
    c.stdout?.on('data', (chunk: string) => {
      let from = 0;
      for (let nl = chunk.indexOf('\n'); nl >= 0; nl = chunk.indexOf('\n', from)) {
        const tail = chunk.slice(from, nl);
        const line = skipping ? '' : parts.length ? parts.join('') + tail : tail;
        parts = [];
        size = 0;
        skipping = false;
        from = nl + 1;
        onLine(line);
      }
      if (from < chunk.length && !skipping) {
        parts.push(chunk.slice(from));
        size += chunk.length - from;
        if (size > MAX_LINE) { parts = []; size = 0; skipping = true; }
      }
    });

    // The exit is final once stderr has been read to its end ('close'); a grandchild that
    // holds the pipes open must not keep the failure from being said, hence the short
    // fallback after 'exit'.
    let how = '';
    const finish = () => die(new McpError(withStderr(`${name}: the server process exited (${how})`)));
    c.on('exit', (code, signal) => {
      exited = true;
      how = code !== null ? `code ${code}` : `signal ${signal}`;
      live.delete(c);
      setTimeout(finish, 100).unref();
    });
    c.on('close', () => { if (exited) finish(); });
  }

  function onLine(raw: string) {
    const line = raw.trim();
    if (!line.startsWith('{')) return;
    let msg: { id?: unknown; method?: unknown; result?: unknown; error?: unknown };
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    heardFromServer = true;
    if (typeof msg.method === 'string') {
      // A request FROM the server. `ping` is answered, as the protocol asks; nothing else
      // a server may ask (sampling, roots, elicitation) is offered in `initialize`, so
      // anything else is "method not found". A notification (no id) needs no answer.
      if (msg.id === undefined || msg.id === null) return;
      write(msg.method === 'ping'
        ? { jsonrpc: '2.0', id: msg.id, result: {} }
        : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      return;
    }
    const p = typeof msg.id === 'number' ? pending.get(msg.id) : undefined;
    if (!p) return; // an answer to a request that already timed out
    pending.delete(msg.id as number);
    clearTimeout(p.timer);
    p.resolve(msg);
  }

  function write(message: unknown) {
    child?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  const transport: McpTransport = {
    send(message, expectResponse, timeoutMs) {
      if (dead) return Promise.reject(dead);
      if (!expectResponse) {
        write(message);
        return Promise.resolve(undefined);
      }
      return new Promise((resolve, reject) => {
        const id = message.id as number;
        // Ref'd on purpose: this timer is what keeps a short-lived program alive while an
        // answer is on its way (the process and its pipes are not).
        const timer = setTimeout(() => {
          pending.delete(id);
          // A server that has said nothing at all yet is most likely stuck starting up —
          // its stderr is the only thing that can say why.
          reject(new McpError(heardFromServer ? `no answer in ${timeoutMs} ms` : withStderr(`no answer in ${timeoutMs} ms`)));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        write(message);
      });
    },
    close() {
      const c = child;
      if (!c || exited) return;
      try { c.stdin?.destroy(); } catch { /* already gone */ }
      try { c.kill('SIGTERM'); } catch { /* already gone */ }
      // Ref'd, and cleared by the exit: a short-lived program waits out the grace only
      // for a server that ignores SIGTERM, and does not leave it running behind.
      const kill = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* already gone */ } }, opts.killGraceMs ?? 2_000);
      c.once('exit', () => clearTimeout(kill));
    },
  };

  const protocol = createProtocol(transport, opts);
  return {
    ...protocol,
    get pid() { return child?.pid; },
  };
}
export type StdioClient = ReturnType<typeof createStdioClient>;
