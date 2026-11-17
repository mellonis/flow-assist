import { expect, test } from 'bun:test';
import { workRows, type WorkJob, type WorkSub } from '../work-panel';

test('rows group subagents and shells', () => {
  const subs: WorkSub[] = [
    { key: 'sub-1', path: ['main', 'review'], state: 'running', asking: false, title: 'reading src/' },
    { key: 'sub-2', path: ['main', 'fix'], state: 'running', asking: false },
  ];
  const jobs: WorkJob[] = [
    { id: 'sh-3', command: 'npm run dev', state: 'running', owner: 'main' },
    { id: 'sh-4', command: 'bun test', state: 'exited 0', owner: 'sub-1' },
  ];
  const rows = workRows(subs, jobs);
  expect(rows).toEqual([
    { id: 'sub:sub-1', group: 'subagents', text: 'main › review', detail: 'running — reading src/' },
    { id: 'sub:sub-2', group: 'subagents', text: 'main › fix', detail: 'running' },
    { id: 'shell:sh-3', group: 'shells', text: 'sh-3 · npm run dev', detail: 'running — main' },
    { id: 'shell:sh-4', group: 'shells', text: 'sh-4 · bun test', detail: 'exited 0 — sub-1' },
  ]);
  // `now` is the caller's clock and the mapping does no clock math with it.
  expect(workRows(subs, jobs, 1_763_400_000_000)).toEqual(rows);
  expect(workRows([], [])).toEqual([]);
});

test('a waiting subagent warns', () => {
  const subs: WorkSub[] = [
    { key: 'sub-1', path: ['main', 'review'], state: 'waiting for you — check the log', asking: true },
    { key: 'sub-2', path: ['main'], state: 'running', asking: false },
  ];
  const rows = workRows(subs, []);
  expect(rows[0]!.id).toBe('sub:sub-1');
  expect(rows[0]!.tone).toBe('warn');
  expect(rows[0]!.detail).toBe('? waiting for you');
  expect(rows[1]!.tone).toBeUndefined();
  expect(rows[1]!.detail).toBe('running');
});

test('ended shells sink below running ones', () => {
  const jobs: WorkJob[] = [
    { id: 'sh-1', command: 'bun test', state: 'exited 0', owner: 'main' },
    { id: 'sh-2', command: 'npm run dev', state: 'running', owner: 'main' },
    { id: 'sh-3', command: 'make build', state: 'killed (person)', owner: 'sub-1' },
  ];
  const rows = workRows([], jobs);
  expect(rows.map((r) => r.id)).toEqual(['shell:sh-2', 'shell:sh-1', 'shell:sh-3']);
  expect(rows[0]!.detail).toBe('running — main');
  expect(rows[1]!.detail).toBe('exited 0 — main');
  expect(rows[2]!.detail).toBe('killed (person) — sub-1');
});

test('an ended subagent sinks below the live ones of its group', () => {
  const subs: WorkSub[] = [
    { key: 'a', path: ['main', 'a'], state: 'ended — done', asking: false },
    { key: 'b', path: ['main', 'b'], state: 'waiting for you — check the log', asking: false },
    { key: 'c', path: ['main', 'c'], state: 'running', asking: false },
  ];
  const rows = workRows(subs, []);
  expect(rows.map((r) => r.id)).toEqual(['sub:b', 'sub:c', 'sub:a']);
});
