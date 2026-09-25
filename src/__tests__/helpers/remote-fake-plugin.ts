// A remote plugin for the transport tests, run as a real process. It speaks the
// protocol by hand because it stands in for a plugin written in any language. Without
// `--serve <path>` it runs once over stdin/stdout, as a plugin the host starts on
// demand does; with `--serve <path>` it is a shared server (`serveConnections`) and
// each connection gets its own `handle()` call.
import fs from 'node:fs';
import { createPeer, LineSplitter, serveConnections, type Frame, type KeyEvent, type PeerIo, type ToolRunParams } from '@flow-assist/remote';

if (process.env.FAKE_STDERR) process.stderr.write(`${process.env.FAKE_STDERR}\n`);
if (process.env.FAKE_STDOUT_NOISE) process.stdout.write('starting up\n');
if (process.env.FAKE_PIDFILE) fs.writeFileSync(process.env.FAKE_PIDFILE, String(process.pid));
if (process.env.FAKE_IGNORE_SIGTERM) process.on('SIGTERM', () => {}); // only SIGKILL ends it
if (process.env.FAKE_KEEPALIVE) setInterval(() => {}, 1_000); // stdin EOF alone does not end it

const serveIdx = process.argv.indexOf('--serve');
const servePath = serveIdx !== -1 ? process.argv[serveIdx + 1] : undefined;

if (process.env.FAKE_NO_HELLO) {
  setInterval(() => {}, 1_000); // stays up, says nothing
} else {
  let shared = 0; // one per PROCESS: what a shared server's clients all see

  // One connection's whole protocol: `hello`/`shutdown`/`tool.run`/`key`. `self` is
  // scoped to this call, so a shared server's clients never see each other's `self`;
  // `shared` above is not, so every client of one server sees it advance. Resolves
  // once `shutdown` is answered — the caller decides what that means: exit the
  // process (stdio, no server around it to end the connection instead) or, under
  // `serveConnections`, just end this one connection.
  function handle(io: PeerIo): Promise<void> {
    const peer = createPeer(io);
    let self: { n: number; client: number } | undefined;
    const frame = (m: { n: number; client: number }): Frame => ({
      surface: ['Text', {}, `client ${m.client} · n=${m.n} · shared=${shared}`],
      keycaps: ['b bump'],
      keys: { consume: ['b'] },
    });
    return new Promise<void>((resolveShutdown) => {
      peer.onRequest('hello', () => {
        if (process.env.FAKE_CRASH_AFTER_HELLO) setTimeout(() => process.exit(3), 10);
        self = { n: 0, client: ++shared };
        const m = self;
        setTimeout(() => peer.notify('frame', frame(m)), 0);
        return { hostApi: 2, name: 'fake', keys: { bump: 'b' } };
      });
      // A deferred resolve: `peer`'s own answer to this request is itself queued as a
      // microtask right after this handler returns, and resolving synchronously here
      // would let the connection close (or, over stdio, the process exit) ahead of it.
      peer.onRequest('shutdown', () => { setTimeout(() => resolveShutdown(), 0); return {}; });
      peer.onRequest('tool.run', (p) => ({ result: (p as ToolRunParams).name === 'shared' ? `shared=${shared}` : null }));
      peer.onNotify('key', (e) => {
        const key = e as KeyEvent;
        if (key.name === process.env.FAKE_CRASH_ON_KEY) process.exit(3);
        if (key.name === process.env.FAKE_STDERR_ON_KEY) process.stderr.write(`stderr on key ${key.name}\n`);
        if (!self || key.action !== 'bump') return;
        shared++; self.n++;
        peer.notify('frame', frame(self));
      });
    });
  }

  if (servePath) {
    // Ends the process once the server is done, as `runPlugin` does: `FAKE_KEEPALIVE`
    // would otherwise hold it open past its own idle.
    void serveConnections((io) => handle(io), servePath).then(() => process.exit(0));
  } else {
    let feed: (line: string) => void = () => {};
    const splitter = new LineSplitter((line) => feed(line));
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => splitter.feed(chunk));
    const io: PeerIo = { send: (line) => { process.stdout.write(`${line}\n`); }, onLine: (fn) => { feed = fn; } };
    void handle(io).then(() => setTimeout(() => process.exit(0), 10));
  }
}
