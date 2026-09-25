// A remote plugin for the transport tests, run as a real process. It speaks the
// protocol by hand because it stands in for a plugin written in any language.
import fs from 'node:fs';
import { createPeer, LineSplitter, type Frame, type KeyEvent, type ToolRunParams } from '@flow-assist/remote';

if (process.env.FAKE_STDERR) process.stderr.write(`${process.env.FAKE_STDERR}\n`);
if (process.env.FAKE_STDOUT_NOISE) process.stdout.write('starting up\n');
if (process.env.FAKE_PIDFILE) fs.writeFileSync(process.env.FAKE_PIDFILE, String(process.pid));

if (process.env.FAKE_NO_HELLO) {
  setInterval(() => {}, 1_000); // stays up, says nothing
} else {
  let feed: (line: string) => void = () => {};
  const splitter = new LineSplitter((line) => feed(line));
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => splitter.feed(chunk));
  const peer = createPeer({ send: (line) => process.stdout.write(`${line}\n`), onLine: (fn) => { feed = fn; } });

  let shared = 0; // one per PROCESS: what a shared server's clients all see
  let self: { n: number; client: number } | undefined;
  const frame = (m: { n: number; client: number }): Frame => ({
    surface: ['Text', {}, `client ${m.client} · n=${m.n} · shared=${shared}`],
    keycaps: ['b bump'],
    keys: { consume: ['b'] },
  });

  peer.onRequest('hello', () => {
    if (process.env.FAKE_CRASH_AFTER_HELLO) setTimeout(() => process.exit(3), 10);
    self = { n: 0, client: ++shared };
    const m = self;
    setTimeout(() => peer.notify('frame', frame(m)), 0);
    return { hostApi: 2, name: 'fake', keys: { bump: 'b' } };
  });
  peer.onRequest('shutdown', () => { setTimeout(() => process.exit(0), 10); return {}; });
  peer.onRequest('tool.run', (p) => ({ result: (p as ToolRunParams).name === 'shared' ? `shared=${shared}` : null }));
  peer.onNotify('key', (e) => {
    const key = e as KeyEvent;
    if (key.name === process.env.FAKE_CRASH_ON_KEY) process.exit(3);
    if (!self || key.action !== 'bump') return;
    shared++; self.n++;
    peer.notify('frame', frame(self));
  });
}
