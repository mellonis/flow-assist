import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createPeer } from '@flow-assist/remote';
import { socketPath } from '../sockets';
import { socketTransport } from '../transport-socket';

const FAKE = ['bun', path.resolve(import.meta.dir, '../../__tests__/helpers/remote-fake-plugin.ts')];
const cwd = path.resolve(import.meta.dir, '../../..');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const host = (sock: string, pidfile: string) => {
  const log: string[] = [];
  const t = socketTransport({ name: 'fake', socketPath: sock, run: FAKE, cwd, env: { FAKE_PIDFILE: pidfile }, log: (l) => log.push(l) });
  const peer = createPeer({ send: (l) => t.send(l), onLine: (f) => t.onLine(f) });
  return { t, peer, log };
};

test('the first host starts the server, the second connects to it; frames do not mix; shared state is seen by both; the server exits after the last client', async () => {
  const sock = socketPath('t1.sock'); const pidfile = `${sock}.pid`;
  const a = host(sock, pidfile); const b = host(sock, pidfile);
  await a.t.start();
  const pid1 = fs.readFileSync(pidfile, 'utf8');
  expect(await a.peer.request('hello', { hostApi: 2, config: {}, idleMs: 100 }, 5_000)).toMatchObject({ name: 'fake' });
  await b.t.start();
  expect(fs.readFileSync(pidfile, 'utf8')).toBe(pid1); // no second process
  expect(await b.peer.request('hello', { hostApi: 2, config: {}, idleMs: 100 }, 5_000)).toMatchObject({ name: 'fake' });
  const af: unknown[] = []; const bf: unknown[] = [];
  a.peer.onNotify('frame', (f) => af.push(f)); b.peer.onNotify('frame', (f) => bf.push(f));
  a.peer.notify('key', { name: 'b', id: 'b', action: 'bump' });
  await wait(50);
  expect(JSON.stringify(af.at(-1))).toContain('client 1');
  expect(JSON.stringify(bf)).not.toContain('client 1');
  expect(await b.peer.request('tool.run', { name: 'shared', args: {}, call: { id: '1' } }, 2_000)).toEqual({ result: 'shared=3' });
  await a.t.close(100); await b.t.close(100);
  await wait(300);
  expect(fs.existsSync(sock)).toBe(false); // gone on its own idle, by the first hello's 100 ms
  expect(a.log.some((l) => l.includes('started'))).toBe(true);
  expect(b.log.some((l) => l.includes('started'))).toBe(false);
});

test('a dead socket file is replaced by a fresh server', async () => {
  const sock = socketPath('t2.sock');
  fs.writeFileSync(sock, '');
  const a = host(sock, `${sock}.pid`);
  await a.t.start();
  expect(await a.peer.request('hello', { hostApi: 2, config: {}, idleMs: 50 }, 5_000)).toMatchObject({ name: 'fake' });
  await a.t.close(100);
  await wait(200);
});

test('connect with no run and nothing listening is a rejection naming the socket', async () => {
  const sock = socketPath('t3.sock');
  const t = socketTransport({ name: 'fake', socketPath: sock, cwd, log: () => {}, waitMs: 50 });
  await expect(t.start()).rejects.toThrow('t3.sock');
});

test('a run command that cannot start logs the failure and start() still rejects by waitMs, without an unhandled error', async () => {
  const sock = socketPath('t4.sock');
  const log: string[] = [];
  const t = socketTransport({ name: 'fake', socketPath: sock, run: ['./does-not-exist'], cwd, log: (l) => log.push(l), waitMs: 200 });
  await expect(t.start()).rejects.toThrow('t4.sock');
  expect(log.some((l) => l.includes('failed to start'))).toBe(true);
});

test('close() fires onClose once, host-initiated; a second close() does not fire it again', async () => {
  const sock = socketPath('t5.sock');
  const a = host(sock, `${sock}.pid`);
  await a.t.start();
  await a.peer.request('hello', { hostApi: 2, config: {}, idleMs: 50 }, 5_000);
  const closes: unknown[] = [];
  a.t.onClose((w) => closes.push(w));
  await a.t.close(0);
  expect(closes).toEqual([{}]);
  await a.t.close(0);
  expect(closes).toEqual([{}]);
});
