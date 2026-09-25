import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createPeer, serveConnections } from '@flow-assist/remote';
import { socketPath } from '../sockets';
import { socketTransport } from '../transport-socket';

const FAKE = ['bun', path.resolve(import.meta.dir, '../../__tests__/helpers/remote-fake-plugin.ts')];
const cwd = path.resolve(import.meta.dir, '../../..');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, label: string, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await wait(10);
  if (!ok()) throw new Error(`timed out waiting for ${label}`);
};
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

test('a line of over a megabyte of non-ASCII text crosses the socket whole, both ways', async () => {
  const sock = socketPath('t6.sock');
  // Cyrillic, two bytes a character: well past the socket's own buffer, and a chunk
  // boundary falls inside a character somewhere along it.
  const big = 'проверка '.repeat(70_000);
  expect(Buffer.byteLength(big)).toBeGreaterThan(1_000_000);
  const serverGot: string[] = [];
  const listening = new Promise<void>((r) => {
    void serveConnections(async (io) => {
      await new Promise<void>((leave) => {
        io.onLine((l) => { serverGot.push(l); io.send(`back:${l}`); io.send('after'); });
        io.onClose?.(leave);
      });
    }, sock, { onListening: r, defaultIdleMs: 50 });
  });
  await listening;
  const t = socketTransport({ name: 'big', socketPath: sock, cwd, log: () => {} });
  const got: string[] = [];
  t.onLine((l) => got.push(l));
  await t.start();
  t.send(big);
  t.send('next');
  await until(() => serverGot.length >= 2, 'both lines at the server', 5_000);
  await until(() => got.length >= 4, 'both lines back', 5_000);
  expect(serverGot).toEqual([big, 'next']);
  expect(got[0] === `back:${big}`).toBe(true);
  expect(got.slice(1)).toEqual(['after', 'back:next', 'after']);
  await t.close(0);
  await until(() => !fs.existsSync(sock), 'the server to go on its idle');
}, 15_000);

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const forget = (sock: string) => { for (const f of [sock, `${sock}.lock`, `${sock}.log`, `${sock}.pid`]) fs.rmSync(f, { force: true }); };

test("a server's stderr goes to its log file beside the socket, so it outlives the host that started it", async () => {
  const sock = socketPath('t7.sock'); const pidfile = `${sock}.pid`;
  forget(sock);
  // The starting host is a process of its own, gone before the server writes anything.
  const starter = Bun.spawn(['bun', path.resolve(import.meta.dir, '../../__tests__/helpers/remote-start-and-leave.ts'), sock, ...FAKE], { cwd, env: { ...process.env, FAKE_PIDFILE: pidfile, FAKE_STDERR_ON_KEY: 'x' }, stdout: 'pipe', stderr: 'inherit' });
  expect(await starter.exited).toBe(0);
  const pid = Number(fs.readFileSync(pidfile, 'utf8'));
  try {
    const b = host(sock, pidfile);
    await b.t.start();
    await b.peer.request('hello', { hostApi: 2, config: {}, idleMs: 100 }, 5_000);
    b.peer.notify('key', { name: 'x', id: 'x' });
    await until(() => fs.existsSync(`${sock}.log`) && fs.readFileSync(`${sock}.log`, 'utf8').includes('stderr on key x'), 'the line in the log file');
    expect(fs.statSync(`${sock}.log`).mode & 0o777).toBe(0o600);
    // Still answering after its stderr write: the write went to a file, not a pipe to
    // a process that is gone.
    expect(await b.peer.request('tool.run', { name: 'shared', args: {}, call: { id: '1' } }, 2_000)).toEqual({ result: 'shared=1' });
    expect(alive(pid)).toBe(true);
    await b.t.close(0);
  } finally {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    await until(() => !alive(pid), 'the server to exit');
    forget(sock);
  }
});

test("a server's log file over 1 MiB is emptied before the next start", async () => {
  const sock = socketPath('t8.sock'); const pidfile = `${sock}.pid`;
  forget(sock);
  fs.writeFileSync(`${sock}.log`, 'x'.repeat(1_100_000));
  const a = host(sock, pidfile);
  try {
    await a.t.start();
    await a.t.close(0);
    expect(fs.statSync(`${sock}.log`).size).toBeLessThan(1_000);
  } finally {
    const pid = Number(fs.readFileSync(pidfile, 'utf8'));
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    await until(() => !alive(pid), 'the server to exit');
    forget(sock);
  }
});
