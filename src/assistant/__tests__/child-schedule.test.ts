import { expect, test } from 'bun:test';
import { scheduleChild } from '../child-schedule';
import type { ChildResult, ChildSpec, ChildStart } from '../conversation-types';
import type { ChildSlots } from '../registry';

const spec: ChildSpec = { kind: 'task', label: 'count', prompt: 'count the tests', by: 'person' };

// Slots that only record, running an admitted job at once.
function fakeSlots(trace: string[]): ChildSlots {
  return {
    arm: () => { trace.push('arm'); },
    disarm: () => { trace.push('disarm'); },
    cancelArmed: () => {},
    admit: (run) => { trace.push('admit'); void run(); },
    backgroundCount: () => 0,
    running: () => 0,
  } as ChildSlots;
}

function fakeStart(trace: string[], result: Partial<ChildResult> = {}): ChildStart {
  return {
    child: {} as never,
    run: async () => { trace.push('run'); return { outcome: 'answer', text: 'ok', ...result } as ChildResult; },
    armed: () => { trace.push('armed'); },
    fired: () => { trace.push('fired'); },
  };
}

test('a refusal is returned, not thrown, and nothing is armed', () => {
  const trace: string[] = [];
  const out = scheduleChild(spec, 0, { startChild: () => ({ refused: 'too deep' }), slots: fakeSlots(trace) });
  expect(out).toEqual({ refused: 'too deep' });
  expect(trace).toEqual([]);
});

test('a delayed child is armed before the function returns and holds no slot yet', () => {
  const trace: string[] = [];
  const out = scheduleChild(spec, 60_000, { startChild: () => fakeStart(trace), slots: fakeSlots(trace) });
  expect('child' in out && out.label).toBe('count');
  expect(trace).toEqual(['armed', 'arm']);
});

test('when the delay ends the child is disarmed, told it fired, admitted and run in that order', async () => {
  const trace: string[] = [];
  const log: string[] = [];
  scheduleChild(spec, 0, { startChild: () => fakeStart(trace, { landedIn: { title: 'T', onScreen: true } }), slots: fakeSlots(trace), pushLog: (e) => log.push(e) });
  await new Promise((r) => setTimeout(r, 20));
  expect(trace).toEqual(['armed', 'arm', 'disarm', 'fired', 'admit', 'run']);
  expect(log).toEqual(['[bg] count: ok']);
});
