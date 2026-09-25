import { expect, test } from 'bun:test';
import { createPeer, PeerError, type PeerIo } from '../peer';

// Two peers wired to each other through in-memory line queues.
function pair(): [PeerIo, PeerIo] {
  const a2b: Array<(l: string) => void> = []; const b2a: Array<(l: string) => void> = [];
  const A: PeerIo = { send: (l) => queueMicrotask(() => a2b.forEach((f) => f(l))), onLine: (f) => { b2a.push(f); } };
  const B: PeerIo = { send: (l) => queueMicrotask(() => b2a.forEach((f) => f(l))), onLine: (f) => { a2b.push(f); } };
  return [A, B];
}

test('a request is answered; a notification is heard; an unknown method is -32601', async () => {
  const [a, b] = pair();
  const host = createPeer(a); const plugin = createPeer(b);
  plugin.onRequest('hello', (params) => ({ hostApi: (params as { hostApi: number }).hostApi, name: 'fake' }));
  const heard: unknown[] = [];
  plugin.onNotify('key', (p) => heard.push(p));
  expect(await host.request('hello', { hostApi: 2 })).toEqual({ hostApi: 2, name: 'fake' });
  host.notify('key', { name: 'a' });
  await new Promise((r) => setTimeout(r, 0));
  expect(heard).toEqual([{ name: 'a' }]);
  await expect(host.request('nope', {})).rejects.toMatchObject({ code: -32601 });
});

test('a handler that throws answers with an error the caller sees', async () => {
  const [a, b] = pair();
  const host = createPeer(a); const plugin = createPeer(b);
  plugin.onRequest('tool.run', () => { throw new Error('path is required. Nothing was changed.'); });
  await expect(host.request('tool.run', { name: 'x' })).rejects.toThrow('path is required');
});

test('a request times out and the peer goes on', async () => {
  const [a, b] = pair();
  const host = createPeer(a); const plugin = createPeer(b);
  plugin.onRequest('slow', () => new Promise(() => {}));
  plugin.onRequest('fast', () => 1);
  await expect(host.request('slow', {}, 20)).rejects.toMatchObject({ code: PeerError.TIMEOUT });
  expect(await host.request('fast', {}, 100)).toBe(1);
});

test('a line that is not JSON-RPC is reported, not fatal; an over-long line is dropped, the peer lives', async () => {
  const [a, b] = pair();
  const host = createPeer(a); const plugin = createPeer(b);
  const odd: string[] = [];
  host.onUnknown((l) => odd.push(l));
  b.send('starting up');
  plugin.onRequest('ping', () => 'pong');
  expect(await host.request('ping')).toBe('pong');
  expect(odd).toEqual(['starting up']);
});

test('close rejects what is pending', async () => {
  const [a, b] = pair();
  const host = createPeer(a); createPeer(b);
  const p = host.request('never', {}, 10_000);
  host.close();
  await expect(p).rejects.toMatchObject({ code: PeerError.CLOSED });
});
