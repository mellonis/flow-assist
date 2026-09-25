// The shared-server mode of a remote plugin transport: one process, several hosts.
// Each connection is a client of its own — its own `hello`, own protocol state, and
// its own line stream — handled by `onConnection`, which resolves once that client
// is done (its `shutdown` answered, the handler's business); what the injected
// handler holds outside a single connection is what every client shares. The server
// listens on the unix socket path the host passes and exits on its own `idleMs` after
// its last client leaves: the value the FIRST hello carried, kept for the process's
// life (a later host's number is not a change of mind, and the server is not one
// host's to reconfigure). The idle timer is armed from the moment the server starts
// listening, at `defaultIdleMs` — a host that starts this process and never manages
// to connect leaves no orphan behind. A path already served by a live process is
// refused outright rather than stolen: only a stale file (nothing answers it) is
// replaced — probed and unlinked here with nothing holding the path in between, so
// two `serveConnections` racing the same fresh path can both pass the probe; closing
// that window is the host's job (a start lock, taken before either ever calls in).
// A server started by hand runs the same code and lives the same way; the socket is
// never the host's to kill — this process ends itself, on its own idle timer or on
// SIGTERM/SIGINT.
import fs from 'node:fs';
import { LineSplitter } from './codec.js';
import type { PeerIo } from './peer.js';

export interface ServeOpts { defaultIdleMs?: number; onListening?: () => void }

interface Client { feed: (chunk: Uint8Array) => void; flush: () => void; leave: () => void }

// Bun's unix socket API — the two calls this file needs; its full type definitions
// are not part of the typecheck (the same convention as `src/loader/compat.ts`'s
// `Bun.semver` declaration).
declare const Bun: {
  listen(opts: {
    unix: string;
    socket: {
      open(socket: BunSocket): void;
      data(socket: BunSocket, data: Uint8Array): void;
      close(socket: BunSocket): void;
      error(socket: BunSocket, error: Error): void;
      drain(socket: BunSocket): void;
    };
  }): { stop(force?: boolean): void };
  connect(opts: {
    unix: string;
    socket: { open(): void; data(): void; close(): void; error(): void };
  }): Promise<{ end(): void }>;
};
interface BunSocket { data: Client | undefined; write(chunk: Uint8Array): number; end(): void }

// Whether some other process already answers `socketPath` — a live server accepts
// the probe connection, a stale file (or no file at all) refuses it.
async function isServed(socketPath: string): Promise<boolean> {
  try {
    const probe = await Bun.connect({ unix: socketPath, socket: { open() {}, data() {}, close() {}, error() {} } });
    probe.end();
    return true;
  } catch {
    return false;
  }
}

export async function serveConnections(onConnection: (io: PeerIo) => Promise<void>, socketPath: string, opts: ServeOpts = {}): Promise<void> {
  if (!socketPath) throw new Error('serveConnections needs the socket path');
  if (await isServed(socketPath)) throw new Error(`${socketPath} is already served`);
  try { fs.unlinkSync(socketPath); } catch { /* nothing stale to remove */ }
  let idleMs: number | null = null;
  let clients = 0;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let finished = false;

  return new Promise<void>((done) => {
    const finish = () => {
      if (finished) return;
      finished = true;
      if (idle) clearTimeout(idle);
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('SIGINT', onSigint);
      try { server.stop(true); } catch { /* already gone */ }
      try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
      done();
    };
    const onSigterm = () => finish();
    const onSigint = () => finish();
    const armIdle = () => {
      // `finish` already ran (a signal, or an earlier idle firing) — closing the
      // remaining sockets it owns must not schedule a fresh timer behind it.
      if (finished) return;
      if (idle) clearTimeout(idle);
      idle = setTimeout(finish, idleMs ?? opts.defaultIdleMs ?? 60_000);
    };
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        open(conn) {
          clients++;
          if (idle) { clearTimeout(idle); idle = null; }
          const lines: Array<(l: string) => void> = [];
          // One streaming decoder per connection: a character split across two chunks
          // is completed by the next one rather than read as two broken halves.
          const decoder = new TextDecoder();
          // Bun's socket `write` takes only what fits in the kernel's buffer and returns
          // how many bytes that was — the rest is not kept anywhere. So lines go out
          // through a queue of bytes: whatever does not fit waits for `drain`, a line
          // sent while anything waits joins the back, and nothing is sent after close.
          const queue: Uint8Array[] = [];
          let gone = false;
          const flush = () => {
            while (!gone && queue.length) {
              const head = queue[0]!;
              const n = conn.write(head);
              if (n >= head.length) { queue.shift(); continue; }
              if (n > 0) queue[0] = head.subarray(n);
              return;
            }
          };
          const splitter = new LineSplitter((raw) => {
            // The first hello's idleMs is the server's, kept for the process's life.
            if (idleMs === null) {
              try {
                const m = JSON.parse(raw) as { method?: string; params?: { idleMs?: unknown } };
                if (m.method === 'hello' && typeof m.params?.idleMs === 'number') idleMs = m.params.idleMs;
              } catch { /* not a hello line */ }
            }
            lines.forEach((f) => f(raw));
          });
          const io: PeerIo = { send: (l) => { if (gone) return; queue.push(Buffer.from(`${l}\n`)); flush(); }, onLine: (f) => { lines.push(f); } };
          conn.data = {
            feed: (d) => splitter.feed(decoder.decode(d, { stream: true })),
            flush,
            leave: () => { gone = true; queue.length = 0; clients--; if (clients === 0) armIdle(); },
          };
          onConnection(io).then(() => conn.end(), () => conn.end());
        },
        data(conn, d) { conn.data?.feed(d); },
        drain(conn) { conn.data?.flush(); },
        close(conn) { conn.data?.leave(); },
        error() {},
      },
    });
    try { fs.chmodSync(socketPath, 0o600); } catch { /* platform without chmod semantics */ }
    process.on('SIGTERM', onSigterm);
    process.on('SIGINT', onSigint);
    armIdle(); // a host that never manages to connect leaves no orphan behind.
    opts.onListening?.();
  });
}
