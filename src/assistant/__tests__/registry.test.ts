import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationRegistry, type RegistryInit } from '../registry.ts';
import { lockPath } from '../sessions.ts';

const made: ConversationRegistry[] = [];
afterEach(() => { for (const r of made.splice(0)) { r.flushAll(); for (const c of r.live()) c.close('exit'); } });

const registry = (over: Partial<RegistryInit> = {}) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-reg-')));
  const config: Record<string, unknown> = { ai: {}, memory: { file: path.join(home, 'memory.json') }, workspace: { dir: path.join(home, 'projects') }, shell: { roots: [home] } };
  const r = new ConversationRegistry({ config: () => config, services: () => ({}), notify: () => {}, sessionsDir: () => path.join(home, 'sessions'), canAsk: true, ...over });
  made.push(r);
  return r;
};

test('registry: every conversation it makes holds its lock token and says whether a person is there', () => {
  const r = registry();
  const a = r.create();
  const b = r.fresh({ kind: 'session', policy: { kind: 'ask' } });
  expect([a.deps.lockToken, b.deps.lockToken]).toEqual([r.lockToken, r.lockToken]);
  expect([a.deps.canAsk, b.deps.canAsk]).toEqual([true, true]);
  expect(r.live()).toEqual([a, b]);
});

test('registry: the missing memory record is said once for all its conversations', () => {
  const r = registry();
  const a = r.create();
  const b = r.create();
  a.memoryMissingSaid = true;
  expect(b.memoryMissingSaid).toBe(true);
  expect(registry().create().memoryMissingSaid).toBe(false);
});

test('registry: where nobody can answer, a conversation that asks cannot be made', () => {
  const r = registry({ canAsk: false });
  expect(() => r.create()).toThrow('nobody to ask');
  expect(r.fresh({ kind: 'oneshot', policy: { kind: 'none' } }).kind).toBe('oneshot');
});

test('registry: a closed conversation leaves it, and the one on screen with it', () => {
  const r = registry();
  const a = r.create();
  r.show(a);
  expect(r.shown()).toBe(a);
  expect(a.deps.current?.()).toBe(a);
  a.close('park');
  expect(r.live()).toEqual([]);
  expect(r.shown()).toBeNull();
});

test('registry: flushing at exit releases every live conversation\'s lock and closes none', () => {
  const r = registry({ exitHook: true });
  const a = r.create();
  const id = a.ensureSessionId();
  const home = a.homes.get(id)!;
  expect(fs.existsSync(lockPath(home, id))).toBe(true);
  r.flushAll();
  expect(fs.existsSync(lockPath(home, id))).toBe(false);
  expect(a.closed).toBe(false);
  expect(r.live()).toEqual([a]);
  expect(() => r.flushAll()).not.toThrow();
});
