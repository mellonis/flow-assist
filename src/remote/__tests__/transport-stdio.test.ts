import { expect, test } from 'bun:test';
import path from 'node:path';
import { createPeer } from '@flow-assist/remote';
import { stdioTransport } from '../transport-stdio';

const FAKE = ['bun', path.resolve(import.meta.dir, '../../__tests__/helpers/remote-fake-plugin.ts')];
const cwd = path.resolve(import.meta.dir, '../../..');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const boot = (env: Record<string, string> = {}) => {
  const log: string[] = [];
  const t = stdioTransport({ name: 'fake', command: FAKE, cwd, env, log: (l) => log.push(l) });
  const peer = createPeer({ send: (l) => t.send(l), onLine: (f) => t.onLine(f) });
  return { t, peer, log };
};

test('start, talk, shutdown: hello is answered, a frame arrives, the child ends cleanly', async () => {
  const { t, peer } = boot();
  const frames: unknown[] = [];
  peer.onNotify('frame', (f) => frames.push(f));
  let closed: unknown = null; t.onClose((w) => { closed = w; });
  await t.start();
  expect(t.pid()).toBeGreaterThan(0);
  expect(await peer.request('hello', { hostApi: 2, config: {} }, 5_000)).toMatchObject({ name: 'fake' });
  await wait(50);
  expect(frames.length).toBe(1);
  await peer.request('shutdown', {}, 2_000);
  await t.close(2_000);
  await wait(50);
  expect(closed).toEqual({ code: 0 });
});

test('a crash closes with its exit code; stderr goes to the log line by line; stdout noise is not fatal', async () => {
  const { t, peer, log } = boot({ FAKE_CRASH_AFTER_HELLO: '1', FAKE_STDERR: 'warming up', FAKE_STDOUT_NOISE: '1' });
  const closed = new Promise((r) => t.onClose(r));
  await t.start();
  expect(await peer.request('hello', { hostApi: 2, config: {} }, 5_000)).toMatchObject({ name: 'fake' });
  expect(await closed).toEqual({ code: 3 });
  expect(log).toContain('[fake] warming up');
});

test('a command that cannot start is a rejection, not a crash', async () => {
  const t = stdioTransport({ name: 'fake', command: ['./no-such-binary'], cwd, log: () => {} });
  await expect(t.start()).rejects.toThrow('./no-such-binary');
});

test('close kills a child that ignores shutdown', async () => {
  const { t } = boot({ FAKE_NO_HELLO: '1' });
  const closed = new Promise<{ signal?: string }>((r) => t.onClose(r));
  await t.start();
  await t.close(100);
  expect((await closed).signal).toMatch(/SIGTERM|SIGKILL/);
});
