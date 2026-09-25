import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { acquireStartLock, socketPath, socketPathProblem, socketsDir } from '../sockets';
import { UNREADABLE_HELD_MS } from '../../assistant/sessions';

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

test('an unreadable lock is held while it is young — a create racing its own write — and stale once old', () => {
  const p = socketPath('lock-unread.sock');
  const lock = `${p}.lock`;
  fs.writeFileSync(lock, ''); // created, not yet written
  try {
    expect(acquireStartLock(p)).toEqual({ ok: false, heldBy: 0 });
    expect(fs.readFileSync(lock, 'utf8')).toBe(''); // left alone
    const old = (Date.now() - UNREADABLE_HELD_MS - 1_000) / 1000;
    fs.utimesSync(lock, old, old);
    const taken = acquireStartLock(p);
    expect(taken.ok).toBe(true);
    (taken as { release(): void }).release();
  } finally {
    fs.rmSync(lock, { force: true });
  }
});

test("release removes only this acquire's own lock, never a successor's", () => {
  const p = socketPath('lock-succ.sock');
  const lock = `${p}.lock`;
  try {
    const mine = acquireStartLock(p);
    expect(mine.ok).toBe(true);
    // Taken over meanwhile (this one judged stale), by a host in the same process
    // or another: same pid, a different lock.
    const successor = JSON.stringify({ pid: process.pid, at: Date.now() + 1 });
    fs.writeFileSync(lock, successor);
    (mine as { release(): void }).release();
    expect(fs.readFileSync(lock, 'utf8')).toBe(successor);
  } finally {
    fs.rmSync(lock, { force: true });
  }
});

test("a socket path longer than the platform's sun_path is refused, naming the part that is too long", () => {
  const dir = `/${'d'.repeat(80)}/sockets`; // 89 bytes
  expect(socketPathProblem(dir, 'x'.repeat(10), 'darwin')).toBeNull(); // 100 bytes: fits in 103
  expect(socketPathProblem(dir, 'x'.repeat(15), 'darwin')).toContain('the name');
  expect(socketPathProblem(dir, 'x'.repeat(15), 'linux')).toBeNull(); // 105: fits in 107
  // Multibyte: bytes are counted, not characters.
  expect(socketPathProblem(dir, 'я'.repeat(8), 'darwin')).toContain('the name');
  const deep = `/${'d'.repeat(100)}/sockets`;
  const why = socketPathProblem(deep, 'a.sock', 'darwin')!;
  expect(why).toContain('the sockets directory');
  expect(why).toContain(deep);
});
