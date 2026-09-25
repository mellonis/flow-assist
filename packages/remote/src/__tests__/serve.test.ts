import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPeer, LineSplitter, type PeerIo } from '../index';
import { serveConnections } from '../serve';

function sock(): { dir: string; path: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-serve-'));
  return { dir, path: path.join(dir, 's.sock') };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A client over the socket, as a host would connect.
async function client(socketPath: string): Promise<{ peer: ReturnType<typeof createPeer>; end: () => void }> {
  const lines: Array<(l: string) => void> = [];
  const splitter = new LineSplitter((l) => lines.forEach((f) => f(l)));
  const conn = await Bun.connect({ unix: socketPath, socket: { data: (_s, d) => splitter.feed(new TextDecoder().decode(d)), open() {}, close() {}, error() {} } });
  const io: PeerIo = { send: (l) => { conn.write(`${l}\n`); }, onLine: (f) => { lines.push(f); } };
  return { peer: createPeer(io), end: () => conn.end() };
}

let shared = 0; // one per PROCESS: what a shared server's clients all see

// A hand-rolled per-connection handler, the same shape `remote-fake-plugin.ts` uses:
// answers `hello` with its own client number, notifies one frame, shares one counter
// across every connection, answers `tool.run` from it, and resolves once `shutdown`
// is answered.
async function handleConnection(io: PeerIo): Promise<void> {
  const peer = createPeer(io);
  let me = 0;
  await new Promise<void>((resolveShutdown) => {
    peer.onRequest('hello', () => {
      me = ++shared;
      setTimeout(() => peer.notify('frame', ['Text', {}, `client ${me} shared ${shared}`]), 0);
      return { hostApi: 2, name: 'fake' };
    });
    peer.onNotify('key', () => { shared++; });
    peer.onRequest('tool.run', () => ({ result: `shared=${shared}` }));
    peer.onRequest('shutdown', () => { resolveShutdown(); return {}; });
  });
}

test('two clients get their own hello and frames; what the process holds is seen by both; idleMs comes from the first hello and stays', async () => {
  const { dir, path: p } = sock();
  const listening = new Promise<void>((r) => { serveConnections(handleConnection, p, { onListening: r, defaultIdleMs: 60_000 }); });
  await listening;
  const a = await client(p); const b = await client(p);
  const aFrames: unknown[] = []; const bFrames: unknown[] = [];
  a.peer.onNotify('frame', (f) => aFrames.push(f)); b.peer.onNotify('frame', (f) => bFrames.push(f));
  expect(await a.peer.request('hello', { hostApi: 2, config: {}, idleMs: 50 })).toMatchObject({ name: 'fake' });
  expect(await b.peer.request('hello', { hostApi: 2, config: {}, idleMs: 60_000 })).toMatchObject({ name: 'fake' });
  await wait(20);
  expect(JSON.stringify(aFrames.at(-1))).toContain('client 1');
  expect(JSON.stringify(bFrames.at(-1))).toContain('client 2');
  a.peer.notify('key', { name: 'k', id: 'k' });
  await wait(20);
  expect(await b.peer.request('tool.run', { name: 'shared', args: {}, call: { id: '1' } })).toEqual({ result: 'shared=3' });
  // The first hello said 50 ms: after the last client leaves the server is gone by then.
  a.end(); b.end();
  await wait(200);
  await expect(Bun.connect({ unix: p, socket: { data() {}, open() {}, close() {}, error() {} } })).rejects.toThrow();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a stale socket file is replaced, and ending leaves no signal listener behind', async () => {
  const before = { term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') };
  const { dir, path: p } = sock();
  fs.writeFileSync(p, '');
  const listening = new Promise<void>((r) => { serveConnections(handleConnection, p, { onListening: r, defaultIdleMs: 30 }); });
  await listening;
  const c = await client(p);
  expect(await c.peer.request('hello', { hostApi: 2, config: {} })).toMatchObject({ name: 'fake' });
  c.end();
  await wait(100);
  expect(process.listenerCount('SIGTERM')).toBe(before.term);
  expect(process.listenerCount('SIGINT')).toBe(before.int);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a server no client ever reaches still idle-exits, on the default idle armed at listen time', async () => {
  const { dir, path: p } = sock();
  await serveConnections(handleConnection, p, { defaultIdleMs: 50 });
  await expect(Bun.connect({ unix: p, socket: { data() {}, open() {}, close() {}, error() {} } })).rejects.toThrow();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a live server keeps its socket: a second serveConnections on the same path is refused, and the first still answers a client', async () => {
  const { dir, path: p } = sock();
  const listening = new Promise<void>((r) => { serveConnections(handleConnection, p, { onListening: r, defaultIdleMs: 50 }); });
  await listening;
  await expect(serveConnections(handleConnection, p, { defaultIdleMs: 50 })).rejects.toThrow(`${p} is already served`);
  const c = await client(p);
  expect(await c.peer.request('hello', { hostApi: 2, config: {} })).toMatchObject({ name: 'fake' });
  c.end();
  await wait(100);
  await expect(Bun.connect({ unix: p, socket: { data() {}, open() {}, close() {}, error() {} } })).rejects.toThrow();
  fs.rmSync(dir, { recursive: true, force: true });
});
