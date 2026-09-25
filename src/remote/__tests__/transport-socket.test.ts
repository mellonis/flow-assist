import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createPeer, serveConnections } from '@flow-assist/remote';
import { isSocketDead, socketPath } from '../sockets';
import { socketTransport } from '../transport-socket';

const FAKE = ['bun', path.resolve(import.meta.dir, '../../__tests__/helpers/remote-fake-plugin.ts')];
const cwd = path.resolve(import.meta.dir, '../../..');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, label: string, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await wait(10);
  if (!ok()) throw new Error(`timed out waiting for ${label}`);
};
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Everything a test's server leaves beside its socket.
const forget = (sock: string) => { for (const f of [sock, `${sock}.lock`, `${sock}.log`, `${sock}.pid`]) fs.rmSync(f, { force: true }); };
// Waits for the server a test started to be gone — on its own idle, or ended here.
const serverGone = async (pidfile: string, end = false) => {
  if (!fs.existsSync(pidfile)) return;
  const pid = Number(fs.readFileSync(pidfile, 'utf8'));
  if (end) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  await until(() => !alive(pid), 'the server to exit');
};
const host = (sock: string, pidfile: string) => {
  const log: string[] = [];
  const t = socketTransport({ name: 'fake', socketPath: sock, run: FAKE, cwd, env: { FAKE_PIDFILE: pidfile }, log: (l) => log.push(l) });
  const peer = createPeer({ send: (l) => t.send(l), onLine: (f) => t.onLine(f) });
  return { t, peer, log };
};

test('the first host starts the server, the second connects to it; frames do not mix; shared state is seen by both; the server exits after the last client', async () => {
  const sock = socketPath('t1.sock'); const pidfile = `${sock}.pid`;
  forget(sock);
  const a = host(sock, pidfile); const b = host(sock, pidfile);
  try {
    await a.t.start();
    const pid1 = fs.readFileSync(pidfile, 'utf8');
    expect(await a.peer.request('hello', { hostApi: 2, config: {}, idleMs: 100 }, 5_000)).toMatchObject({ name: 'fake' });
    await b.t.start();
    expect(fs.readFileSync(pidfile, 'utf8')).toBe(pid1); // no second process
    expect(await b.peer.request('hello', { hostApi: 2, config: {}, idleMs: 100 }, 5_000)).toMatchObject({ name: 'fake' });
    const af: unknown[] = []; const bf: unknown[] = [];
    a.peer.onNotify('frame', (f) => af.push(f)); b.peer.onNotify('frame', (f) => bf.push(f));
    a.peer.notify('key', { name: 'b', id: 'b', action: 'bump' });
    await until(() => JSON.stringify(af.at(-1) ?? null).includes('n=1'), "a's bump drawn");
    expect(JSON.stringify(af.at(-1))).toContain('client 1');
    expect(JSON.stringify(bf)).not.toContain('client 1');
    expect(await b.peer.request('tool.run', { name: 'shared', args: {}, call: { id: '1' } }, 2_000)).toEqual({ result: 'shared=3' });
    await a.t.close(100); await b.t.close(100);
    await serverGone(pidfile); // on its own idle, by the first hello's 100 ms
    expect(fs.existsSync(sock)).toBe(false);
    expect(a.log.some((l) => l.includes('started'))).toBe(true);
    expect(b.log.some((l) => l.includes('started'))).toBe(false);
  } finally {
    await serverGone(pidfile, true);
    forget(sock);
  }
});

test('a dead socket file is replaced by a fresh server', async () => {
  const sock = socketPath('t2.sock'); const pidfile = `${sock}.pid`;
  forget(sock);
  fs.writeFileSync(sock, '');
  const a = host(sock, pidfile);
  try {
    await a.t.start();
    expect(await a.peer.request('hello', { hostApi: 2, config: {}, idleMs: 50 }, 5_000)).toMatchObject({ name: 'fake' });
    await a.t.close(100);
    await serverGone(pidfile);
  } finally {
    await serverGone(pidfile, true);
    forget(sock);
  }
});

test('connect with no run and nothing listening is a rejection naming the socket', async () => {
  const sock = socketPath('t3.sock');
  const t = socketTransport({ name: 'fake', socketPath: sock, cwd, log: () => {}, waitMs: 50 });
  await expect(t.start()).rejects.toThrow('t3.sock');
});

test('a run command that cannot start logs the failure and start() rejects at once, without an unhandled error', async () => {
  const sock = socketPath('t4.sock');
  const log: string[] = [];
  const t = socketTransport({ name: 'fake', socketPath: sock, run: ['./does-not-exist'], cwd, log: (l) => log.push(l), waitMs: 200 });
  try {
    await expect(t.start()).rejects.toThrow('t4.sock');
    expect(log.some((l) => l.includes('failed to start'))).toBe(true);
  } finally {
    forget(sock);
  }
});

test('close() fires onClose once, host-initiated; a second close() does not fire it again', async () => {
  const sock = socketPath('t5.sock'); const pidfile = `${sock}.pid`;
  forget(sock);
  const a = host(sock, pidfile);
  try {
    await a.t.start();
    await a.peer.request('hello', { hostApi: 2, config: {}, idleMs: 50 }, 5_000);
    const closes: unknown[] = [];
    a.t.onClose((w) => closes.push(w));
    await a.t.close(0);
    expect(closes).toEqual([{}]);
    await a.t.close(0);
    expect(closes).toEqual([{}]);
    await serverGone(pidfile);
  } finally {
    await serverGone(pidfile, true);
    forget(sock);
  }
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

test('a server that starts listening between the probe and the lock is connected to, not replaced', async () => {
  const sock = socketPath('t9.sock'); const pidfile = `${sock}.pid`;
  forget(sock);
  const stop = new AbortController();
  const listening = new Promise<void>((r) => {
    void serveConnections(async (io) => {
      const peer = createPeer(io);
      await new Promise<void>((leave) => {
        peer.onRequest('hello', () => ({ hostApi: 2, name: 'in-process' }));
        io.onClose?.(leave);
      });
    }, sock, { onListening: r, signal: stop.signal });
  });
  await listening;
  // The first probe saw nothing — the other host's server was not up yet — and by the
  // time this host holds the lock it is: the re-probe under the lock must find it.
  let probes = 0;
  const log: string[] = [];
  const t = socketTransport({ name: 'fake', socketPath: sock, run: FAKE, cwd, env: { FAKE_PIDFILE: pidfile }, log: (l) => log.push(l), isSocketDead: async (s) => (probes++ === 0 ? true : isSocketDead(s)) });
  const peer = createPeer({ send: (l) => t.send(l), onLine: (f) => t.onLine(f) });
  try {
    await t.start();
    expect(await peer.request('hello', { hostApi: 2, config: {} }, 2_000)).toMatchObject({ name: 'in-process' });
    expect(log.some((l) => l.includes('started'))).toBe(false);
    expect(fs.existsSync(pidfile)).toBe(false);
    expect(fs.existsSync(`${sock}.lock`)).toBe(false);
  } finally {
    await t.close(0);
    stop.abort();
    if (fs.existsSync(pidfile)) {
      const pid = Number(fs.readFileSync(pidfile, 'utf8'));
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      await until(() => !alive(pid), 'the second server to exit');
    }
    forget(sock);
  }
});

test('a host that finds the start lock held waits for the server the holder starts, and starts none itself', async () => {
  const sock = socketPath('t10.sock'); const pidfile = `${sock}.pid`;
  forget(sock);
  // Another host is starting the server: its lock, a live pid inside.
  fs.writeFileSync(`${sock}.lock`, JSON.stringify({ pid: process.pid, at: 0 }));
  let probes = 0;
  const log: string[] = [];
  const t = socketTransport({ name: 'fake', socketPath: sock, run: FAKE, cwd, env: { FAKE_PIDFILE: pidfile }, log: (l) => log.push(l), isSocketDead: (s) => { probes++; return isSocketDead(s); } });
  const peer = createPeer({ send: (l) => t.send(l), onLine: (f) => t.onLine(f) });
  const stop = new AbortController();
  try {
    const starting = t.start();
    await until(() => probes >= 3, 'the waiting host to poll');
    // The holder's server comes up, and the holder lets go of the lock.
    await new Promise<void>((r) => {
      void serveConnections(async (io) => {
        const p = createPeer(io);
        await new Promise<void>((leave) => { p.onRequest('hello', () => ({ hostApi: 2, name: 'in-process' })); io.onClose?.(leave); });
      }, sock, { onListening: r, signal: stop.signal });
    });
    fs.rmSync(`${sock}.lock`);
    await starting;
    expect(await peer.request('hello', { hostApi: 2, config: {} }, 2_000)).toMatchObject({ name: 'in-process' });
    expect(log.some((l) => l.includes('started'))).toBe(false);
    expect(fs.existsSync(pidfile)).toBe(false);
  } finally {
    await t.close(0);
    stop.abort();
    forget(sock);
  }
});

test('a server that exits before it listens fails start() at once with its exit code, the lock released', async () => {
  const sock = socketPath('t11.sock');
  forget(sock);
  const t = socketTransport({ name: 'fake', socketPath: sock, run: ['bun', '-e', 'process.exit(7)'], cwd, log: () => {}, waitMs: 10_000 });
  const began = Date.now();
  try {
    await expect(t.start()).rejects.toThrow(/t11\.sock.*exit 7|exit 7.*t11\.sock/);
    expect(Date.now() - began).toBeLessThan(3_000);
    expect(fs.existsSync(`${sock}.lock`)).toBe(false);
  } finally {
    forget(sock);
  }
}, 15_000);
