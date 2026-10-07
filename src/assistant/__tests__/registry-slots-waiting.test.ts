import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationRegistry } from '../registry.ts';

const made: ConversationRegistry[] = [];
afterEach(() => { for (const r of made.splice(0)) { r.flushAll(); for (const c of r.live()) c.close('exit'); } });

const registry = (sessions?: Record<string, unknown>) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-slots-wait-')));
  const config: Record<string, unknown> = { ai: {}, memory: { file: path.join(home, 'memory.json') }, workspace: { dir: path.join(home, 'projects') }, shell: { roots: [home] }, ...(sessions ? { sessions } : {}) };
  const r = new ConversationRegistry({ config: () => config, services: () => ({}), notify: () => {}, sessionsDir: () => path.join(home, 'sessions'), canAsk: true });
  made.push(r);
  return r;
};
// A run that ends when its gate opens.
const gated = () => {
  let open!: () => void;
  const started = { value: false };
  const run = async () => { started.value = true; await new Promise<void>((res) => { open = res; }); };
  return { run, started, release: () => open() };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

test('slots: a run that begins to wait frees its slot at once, so a queued run starts', async () => {
  const r = registry();
  const runs = [gated(), gated(), gated(), gated()];
  for (const g of runs) r.children.admit(g.run);
  expect(runs.map((g) => g.started.value)).toEqual([true, true, true, false]);
  r.children.markWaiting(1);
  expect(runs[3]!.started.value).toBe(true);
  expect(r.children.running()).toBe(3);
  expect(r.children.waitingCount()).toBe(1);
  expect(r.children.backgroundCount()).toBe(4);
});

test('slots: an ended wait takes the slot back without asking, over the limit, and nothing queued starts', async () => {
  const r = registry();
  const runs = [gated(), gated(), gated(), gated(), gated()];
  for (const g of runs.slice(0, 3)) r.children.admit(g.run);
  r.children.markWaiting(1);
  r.children.admit(runs[3]!.run);
  r.children.admit(runs[4]!.run);
  expect(runs[3]!.started.value).toBe(true);
  expect(runs[4]!.started.value).toBe(false);
  r.children.markWaiting(-1);
  expect(r.children.running()).toBe(4);
  expect(r.children.waitingCount()).toBe(0);
  runs[0]!.release();
  await tick();
  // 3 held against a limit of 3: the queue stays shut until another ends.
  expect(runs[4]!.started.value).toBe(false);
  runs[1]!.release();
  await tick();
  expect(runs[4]!.started.value).toBe(true);
});

test('slots: several waits begin together and the queue drains up to the free count', () => {
  const r = registry();
  const runs = [gated(), gated(), gated(), gated(), gated(), gated()];
  for (const g of runs.slice(0, 3)) r.children.admit(g.run);
  for (const g of runs.slice(3)) r.children.admit(g.run);
  r.children.markWaiting(1);
  r.children.markWaiting(1);
  expect(runs.map((g) => g.started.value)).toEqual([true, true, true, true, true, false]);
  expect(r.children.running()).toBe(3);
  expect(r.children.waitingCount()).toBe(2);
});

test('slots: markWaiting(-1) with nothing waiting changes nothing', () => {
  const r = registry();
  r.children.markWaiting(-1);
  expect(r.children.waitingCount()).toBe(0);
  expect(r.children.running()).toBe(0);
});
