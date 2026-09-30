import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationRegistry } from '../registry.ts';
import { acquireLock, lockPath } from '../sessions.ts';
import { hostConfigSchema } from '../../config/schema';
import { validateConfigWriteValue } from '../../config/load';

const made: ConversationRegistry[] = [];
afterEach(() => { for (const r of made.splice(0)) { r.flushAll(); for (const c of r.live()) c.close('exit'); } });

const registry = (sessions?: Record<string, unknown>) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-slots-')));
  const config: Record<string, unknown> = { ai: {}, memory: { file: path.join(home, 'memory.json') }, workspace: { dir: path.join(home, 'projects') }, shell: { roots: [home] }, ...(sessions ? { sessions } : {}) };
  const r = new ConversationRegistry({ config: () => config, services: () => ({}), notify: () => {}, sessionsDir: () => path.join(home, 'sessions'), canAsk: true });
  made.push(r);
  return { r, home };
};

// Five runs, each waiting on its own gate; returns the peak of running().
const drive = async (r: ConversationRegistry) => {
  const gates: Array<() => void> = [];
  let peak = 0;
  for (let i = 0; i < 5; i++) r.children.arm();
  for (let i = 0; i < 5; i++) {
    r.children.disarm();
    r.children.admit(async () => {
      peak = Math.max(peak, r.children.running());
      await new Promise<void>((res) => gates.push(res));
    });
  }
  expect(r.children.backgroundCount()).toBe(5);
  while (r.children.backgroundCount() > 0) {
    await new Promise((res) => setTimeout(res, 0));
    gates.splice(0).forEach((g) => g());
  }
  return peak;
};

test('slots: at the default three tasks run at a time and the rest wait', async () => {
  const { r } = registry();
  expect(await drive(r)).toBe(3);
  expect(r.children.running()).toBe(0);
});

test('slots: sessions.maxRunning 2 leaves one task at a time', async () => {
  const { r } = registry({ maxRunning: 2 });
  expect(await drive(r)).toBe(1);
});

test('slots: a run that throws frees its slot and the queue moves', async () => {
  const { r } = registry({ maxRunning: 2 });
  let second = false;
  r.children.admit(async () => { throw new Error('boom'); });
  r.children.admit(async () => { second = true; });
  for (let i = 0; i < 5 && r.children.backgroundCount() > 0; i++) await new Promise((res) => setTimeout(res, 0));
  expect(second).toBe(true);
  expect(r.children.backgroundCount()).toBe(0);
});

test('slots: cancelArmed stops a delayed task that has not started', async () => {
  const { r } = registry();
  let fired = false;
  r.children.arm(setTimeout(() => { fired = true; }, 20));
  expect(r.children.backgroundCount()).toBe(1);
  r.children.cancelArmed();
  expect(r.children.backgroundCount()).toBe(0);
  await new Promise((res) => setTimeout(res, 50));
  expect(fired).toBe(false);
});

test('slots: every conversation is handed the registry\'s slots', () => {
  const { r } = registry();
  expect(r.create().deps.children).toBe(r.children);
});

test('flushAll: one conversation whose save throws does not keep the others from being written', () => {
  const { r, home } = registry();
  const a = r.create();
  const b = r.create();
  const dir = path.join(home, 'sessions');
  a.sessionId = 'aaa';
  b.sessionId = 'bbb';
  a.homes.set('aaa', dir);
  b.homes.set('bbb', dir);
  acquireLock(dir, 'aaa', r.lockToken);
  acquireLock(dir, 'bbb', r.lockToken);
  expect(fs.existsSync(lockPath(dir, 'bbb'))).toBe(true);
  (a as any).save = () => { throw new Error('disk full'); };
  expect(() => r.flushAll()).not.toThrow();
  expect(fs.existsSync(lockPath(dir, 'bbb'))).toBe(false);
});

test('config: sessions.maxRunning is an integer of at least 2, ai.subagentDepth of at least 1', () => {
  const v = (k: string, x: unknown) => validateConfigWriteValue(hostConfigSchema, k, x).ok;
  expect([v('sessions.maxRunning', 1), v('sessions.maxRunning', 4)]).toEqual([false, true]);
  expect([v('ai.subagentDepth', 0), v('ai.subagentDepth', 2)]).toEqual([false, true]);
});
