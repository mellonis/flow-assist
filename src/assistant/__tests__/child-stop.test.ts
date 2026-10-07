// The pieces a stop of a child rests on: how a result reads, and how a queued run is given
// up again.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scheduleChild } from '../child-schedule.ts';
import { STOPPED_EMPTY, childResultBody, childResultText } from '../conversation-types.ts';
import { ConversationRegistry } from '../registry.ts';

const made: ConversationRegistry[] = [];
afterEach(() => { for (const r of made.splice(0)) { r.flushAll(); for (const c of r.live()) c.close('exit'); } });

test('a stopped result reads `<label> stopped:` and the text it had, or that it said nothing; finished and failed keep their heads', () => {
  expect(childResultText('w', { outcome: 'stopped', text: 'half an answer' })).toBe('w stopped:\nhalf an answer');
  expect(childResultText('w', { outcome: 'stopped', text: '' })).toBe(`w stopped:\n${STOPPED_EMPTY}`);
  expect(childResultBody({ outcome: 'stopped', text: '' })).toBe('stopped before it said anything');
  expect(childResultText('w', { outcome: 'answer', text: 'ok' })).toBe('w finished:\nok');
  expect(childResultText('w', { outcome: 'failed', text: '', error: 'boom' })).toBe('w failed:\nboom');
});

test('`admit` hands back what gives the place up: true while queued, false once it started', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-dequeue-')));
  const config: Record<string, unknown> = { ai: {}, memory: { file: path.join(home, 'm.json') }, workspace: { dir: path.join(home, 'p') }, shell: { roots: [home] }, sessions: { maxRunning: 2 } };
  const r = new ConversationRegistry({ config: () => config, services: () => ({}), notify: () => {}, sessionsDir: () => path.join(home, 's'), canAsk: true });
  made.push(r);
  let release!: () => void;
  const ran: string[] = [];
  const first = r.children.admit(async () => { ran.push('first'); await new Promise<void>((res) => { release = res; }); });
  const second = r.children.admit(async () => { ran.push('second'); });
  expect(r.children.backgroundCount()).toBe(2);
  expect(second()).toBe(true);
  expect(second()).toBe(false);
  expect(first()).toBe(false);
  expect(r.children.backgroundCount()).toBe(1);
  release();
  await new Promise((res) => setTimeout(res, 10));
  expect(ran).toEqual(['first']);
  expect(r.children.backgroundCount()).toBe(0);
});

test('a stop before the delay ends takes the child out of the schedule and settles it once; after it began there is nothing to take out', async () => {
  const trace: string[] = [];
  const slots = {
    arm: () => { trace.push('arm'); }, disarm: () => { trace.push('disarm'); }, cancelArmed: () => {},
    admit: (run: () => Promise<void>) => { trace.push('admit'); void run(); return () => false; },
    backgroundCount: () => 0, running: () => 0,
  };
  const child = {} as { leaveSchedule?: () => boolean; delayedUntil?: number | null };
  const toasts: string[] = [];
  scheduleChild({ kind: 'subagent', label: 'z', prompt: 'p', by: 'person' }, 60_000, {
    startChild: () => ({
      child: child as never,
      run: async () => { trace.push('run'); return { outcome: 'stopped', text: '' }; },
      armed: () => { trace.push('armed'); }, fired: () => { trace.push('fired'); },
    }),
    slots: slots as never, showMessage: (m) => toasts.push(m),
  });
  expect(child.delayedUntil).toBeGreaterThan(Date.now() + 50_000);
  expect(child.leaveSchedule!()).toBe(true);
  await new Promise((res) => setTimeout(res, 10));
  expect(trace).toEqual(['armed', 'arm', 'disarm', 'fired', 'run']);
  expect(toasts).toEqual(['■ z stopped']);
  expect(child.leaveSchedule!()).toBe(false);
});
