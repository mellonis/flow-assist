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

export interface SocketOpts { name: string; socketPath: string; run?: string[]; cwd: string; env?: Record<string, string>; log: (line: string) => void; waitMs?: number }
const POLL_MS = 50;

// Bun's unix-connect API — the one call this file needs; its full type definitions
// are not part of the typecheck (the same convention as `src/loader/compat.ts`'s
// `Bun.semver` declaration).
declare const Bun: {
  connect(opts: {
    unix: string;
    socket: { data(socket: unknown, data: Uint8Array): void; open(): void; close(): void; error(socket: unknown, error: Error): void };
  }): Promise<{ write(chunk: string): void; end(): void }>;
};

export function socketTransport(opts: SocketOpts): Transport & { start(): Promise<void> } {
  const lines: Array<(l: string) => void> = [];
  const closes: Array<(w: TransportClose) => void> = [];
  let conn: Awaited<ReturnType<typeof Bun.connect>> | null = null;
  let closedWith: TransportClose | undefined;
  const closeOnce = (why: TransportClose) => { if (closedWith) return; closedWith = why; for (const f of closes) f(why); };
  const splitter = new LineSplitter((l) => lines.forEach((f) => f(l)), (n) => opts.log(`[${opts.name}] a line of ${n} bytes was dropped`));

  const connect = () => Bun.connect({ unix: opts.socketPath, socket: {
    data: (_s, d) => splitter.feed(new TextDecoder().decode(d)),
    open() {},
    close: () => closeOnce({ error: 'connection closed' }),
    error: (_s, e) => closeOnce({ error: e.message }),
  } });

  const startServer = () => {
    const [cmd, ...args] = opts.run!;
    const c = spawn(cmd!.includes('/') ? path.resolve(opts.cwd, cmd!) : cmd!, [...args, '--serve', opts.socketPath], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    c.stderr!.setEncoding('utf8');
    let err = '';
    c.stderr!.on('data', (chunk: string) => { err += chunk; let nl; while ((nl = err.indexOf('\n')) !== -1) { const line = err.slice(0, nl).trimEnd(); err = err.slice(nl + 1); if (line) opts.log(`[${opts.name}] ${line}`); } });
    (c.stderr as { unref?: () => void } | null)?.unref?.();
    c.unref();
    opts.log(`[${opts.name}] started ${opts.run!.join(' ')} --serve (pid ${c.pid})`);
  };

  return {
    async start() {
      const waitMs = opts.waitMs ?? 10_000;
      const deadline = Date.now() + waitMs;
      for (;;) {
        if (!(await isSocketDead(opts.socketPath))) { conn = await connect(); return; }
        if (!opts.run) throw new Error(`${opts.name}: nothing listens on ${opts.socketPath} and the manifest has no run`);
        const lock = acquireStartLock(opts.socketPath);
        if (lock.ok) {
          try { fs.unlinkSync(opts.socketPath); } catch { /* nothing stale to remove */ }
          startServer();
          try {
            while (Date.now() < deadline) { if (fs.existsSync(opts.socketPath) && !(await isSocketDead(opts.socketPath))) break; await new Promise((r) => setTimeout(r, POLL_MS)); }
          } finally { lock.release(); }
        } else {
          // Another host is starting it: wait for the socket rather than start a second.
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
        if (Date.now() >= deadline) throw new Error(`${opts.name}: no server answered on ${opts.socketPath} within ${waitMs} ms`);
      }
    },
    send: (line) => { if (!closedWith) conn?.write(`${line}\n`); },
    onLine: (f) => { lines.push(f); },
    onClose: (f) => { closes.push(f); },
    close: async () => { if (conn && !closedWith) { closedWith = {}; conn.end(); conn = null; } },
  };
}
