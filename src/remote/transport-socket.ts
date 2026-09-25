// A remote plugin as a shared server on a local socket. The host tries the socket;
// nothing listens and the manifest has `run` → it starts the server with
// `--serve <socket>` — detached and unref'd, since the server is not this host's to
// keep or kill: other hosts may be on it, and it exits on its own idle — waits for the
// socket, connects. A second host finds the socket and connects without starting
// anything. A dead socket (a file nobody answers on) is unlinked and the server
// started by whoever found it dead; two hosts at once are serialised by the lock
// beside the socket (./sockets.ts). `close` disconnects and nothing more.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LineSplitter } from '@flow-assist/remote';
import { acquireStartLock, isSocketDead } from './sockets.js';
import type { Transport, TransportClose } from './transport.js';

// `isSocketDead` is ./sockets.ts's own probe unless a test times the race itself.
export interface SocketOpts { name: string; socketPath: string; run?: string[]; cwd: string; env?: Record<string, string>; log: (line: string) => void; waitMs?: number; isSocketDead?: (socketPath: string) => Promise<boolean> }
const POLL_MS = 50;
const LOG_MAX_BYTES = 1024 * 1024;

// Bun's unix-connect API — the one call this file needs; its full type definitions
// are not part of the typecheck (the same convention as `src/loader/compat.ts`'s
// `Bun.semver` declaration).
declare const Bun: {
  connect(opts: {
    unix: string;
    socket: { data(socket: unknown, data: Uint8Array): void; open(): void; close(): void; error(socket: unknown, error: Error): void; drain(): void };
  }): Promise<{ write(chunk: Uint8Array): number; end(): void; unref(): void }>;
};

export function socketTransport(opts: SocketOpts): Transport & { start(): Promise<void> } {
  const lines: Array<(l: string) => void> = [];
  const closes: Array<(w: TransportClose) => void> = [];
  let conn: Awaited<ReturnType<typeof Bun.connect>> | null = null;
  let closedWith: TransportClose | undefined;
  const queue: Uint8Array[] = []; // bytes still to write — see `flush`
  const closeOnce = (why: TransportClose) => { if (closedWith) return; closedWith = why; queue.length = 0; for (const f of closes) f(why); };
  const splitter = new LineSplitter((l) => lines.forEach((f) => f(l)), (n) => opts.log(`[${opts.name}] a line of ${n} bytes was dropped`));
  // One decoder for the connection's whole life, streaming: a character split across
  // two chunks is completed by the next one rather than read as two broken halves.
  const decoder = new TextDecoder();
  // Bun's socket `write` takes only what fits in the kernel's buffer and returns how
  // many bytes that was — the rest is not kept anywhere. So lines go out through a
  // queue of bytes: whatever does not fit waits for `drain`, and a line sent while
  // anything waits joins the back of the queue, so lines never overtake each other.
  const flush = () => {
    while (conn && queue.length) {
      const head = queue[0]!;
      const n = conn.write(head);
      if (n >= head.length) { queue.shift(); continue; }
      if (n > 0) queue[0] = head.subarray(n);
      return;
    }
  };

  const connect = async () => {
    const c = await Bun.connect({ unix: opts.socketPath, socket: {
      data: (_s, d) => splitter.feed(decoder.decode(d, { stream: true })),
      drain: () => flush(),
      open() {},
      close: () => closeOnce({ error: 'connection closed' }),
      error: (_s, e) => closeOnce({ error: e.message }),
    } });
    // A short-lived one-shot process (`config get`, a one-shot prompt) still exits
    // when its own work is done — the same rule every long-lived child follows
    // (AGENTS.md, "A plugin that starts a process owns its life").
    c.unref();
    return c;
  };

  // The server's stderr goes to `<socket>.log`, never a pipe to this host: the server
  // outlives the host that started it, and a write to a pipe whose reader is gone
  // kills the writer (EPIPE). The file is opened for appending, 0600 — kept across
  // starts, so what a server said before it died is still there to read — and emptied
  // first when it has grown past `LOG_MAX_BYTES`, so it never grows without bound.
  const startServer = () => {
    const [cmd, ...args] = opts.run!;
    const logFile = `${opts.socketPath}.log`;
    const fd = fs.openSync(logFile, 'a', 0o600);
    try {
      try { fs.fchmodSync(fd, 0o600); } catch { /* platform without chmod semantics */ }
      if (fs.fstatSync(fd).size > LOG_MAX_BYTES) fs.ftruncateSync(fd, 0);
      const c = spawn(cmd!.includes('/') ? path.resolve(opts.cwd, cmd!) : cmd!, [...args, '--serve', opts.socketPath], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, detached: true, stdio: ['ignore', 'ignore', fd] });
      // A command that cannot even start (a typo in `run`, no shell to report it) fires
      // `error`, never `exit` — an unhandled one would take the whole host down; the
      // wait loop below times out on its own once nothing ever answers the socket.
      c.on('error', (e) => opts.log(`[${opts.name}] failed to start: ${e.message}`));
      c.unref();
      opts.log(`[${opts.name}] started ${opts.run!.join(' ')} --serve (pid ${c.pid}), its stderr to ${logFile}`);
    } finally {
      fs.closeSync(fd); // the child has its own copy
    }
  };

  return {
    async start() {
      const waitMs = opts.waitMs ?? 10_000;
      const probe = opts.isSocketDead ?? isSocketDead;
      const deadline = Date.now() + waitMs;
      for (;;) {
        if (!(await probe(opts.socketPath))) { conn = await connect(); return; }
        if (!opts.run) throw new Error(`${opts.name}: nothing listens on ${opts.socketPath} and the manifest has no run`);
        const lock = acquireStartLock(opts.socketPath);
        if (lock.ok) {
          // Probed again under the lock: another host may have started the server
          // between this host's first probe and its taking the lock (released by that
          // host the moment its server answered). Unlinking then would orphan a live
          // server and split its clients across two.
          if (!(await probe(opts.socketPath))) { lock.release(); conn = await connect(); return; }
          try { fs.unlinkSync(opts.socketPath); } catch { /* nothing stale to remove */ }
          startServer();
          try {
            while (Date.now() < deadline) { if (fs.existsSync(opts.socketPath) && !(await probe(opts.socketPath))) break; await new Promise((r) => setTimeout(r, POLL_MS)); }
          } finally { lock.release(); }
        } else {
          // Another host is starting it: wait for the socket rather than start a second.
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
        if (Date.now() >= deadline) throw new Error(`${opts.name}: no server answered on ${opts.socketPath} within ${waitMs} ms`);
      }
    },
    send: (line) => { if (closedWith || !conn) return; queue.push(Buffer.from(`${line}\n`)); flush(); },
    onLine: (f) => { lines.push(f); },
    onClose: (f) => { closes.push(f); },
    // Reported BEFORE `end()`: ending the connection can run its own `close` handler
    // synchronously, inside the `end()` call itself, and that would otherwise report
    // `{ error: 'connection closed' }` for a close the host asked for. The shared
    // once-guard then makes that later call, and a second `close()`, no-ops.
    //
    // `graceMs` is taken, for the one `Transport` interface every transport shares,
    // and ignored: a disconnect needs no grace period, and the server behind it is
    // never this transport's to stop — another host may still be on it.
    close: async (_graceMs) => { closeOnce({}); if (conn) { conn.end(); conn = null; } },
  };
}
