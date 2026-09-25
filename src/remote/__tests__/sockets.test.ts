import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { acquireStartLock, socketPath, socketsDir } from '../sockets';

test('the sockets directory is the host\'s own, 0700, and a name is a name', () => {
  const dir = socketsDir();
  expect(dir.endsWith(path.join('sockets'))).toBe(true);
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  expect(socketPath('tutor.sock')).toBe(path.join(dir, 'tutor.sock'));
  for (const bad of ['', '../x', 'a/b', 'a\\b', 'x'.repeat(65), '.']) expect(() => socketPath(bad)).toThrow('socket name');
});

test('a live lock is waited on, a stale one is taken', () => {
  const p = socketPath('lock-test.sock');
  const first = acquireStartLock(p);
  expect(first.ok).toBe(true);
  const second = acquireStartLock(p);
  expect(second).toEqual({ ok: false, heldBy: process.pid });
  (first as { release(): void }).release();
  fs.writeFileSync(`${p}.lock`, JSON.stringify({ pid: 999999, at: Date.now() }));
  const third = acquireStartLock(p, { pidAlive: () => false });
  expect(third.ok).toBe(true);
  (third as { release(): void }).release();
  expect(fs.existsSync(`${p}.lock`)).toBe(false);
});
