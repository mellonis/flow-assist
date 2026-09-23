import { expect, test } from 'bun:test';
import { groupHeadText, groupOpen, viewGroups } from '../view-groups';
import { allFolded, foldId, toggleFold } from '../folds';
import type { ViewRecord } from '../views';

const v = (seq: number, turn = 1) => ({ role: 'view', content: '', views: [{ kind: 'console', data: { command: `c${seq}`, exitCode: 0, ms: 1000 }, phase: 'done', startedAt: 0, seq, turn, callId: `t${seq}#0` }] });
const narration = { role: 'assistant', content: '', process: 'Next: lint', step: 'lint.' };
const user = { role: 'user', content: 'go' };

test('consecutive commands of one turn group — the narration before and between them folds in', () => {
  const msgs = [user, narration, v(0), narration, v(1), narration, v(2), { role: 'assistant', content: 'Done.' }];
  expect(viewGroups(msgs, 'step')).toEqual([{ head: 2, members: [2, 4, 6], hidden: [1, 3, 5] }]);
});

test('another tool between them, a new turn, an answer or a lone command is not a group', () => {
  expect(viewGroups([v(0), narration, v(2)], 'step')).toEqual([]); // seq 1 was another tool
  expect(viewGroups([v(0, 1), user, v(1, 2)], 'step')).toEqual([]);
  expect(viewGroups([v(0), { role: 'assistant', content: 'Here is why.' }, v(1)], 'step')).toEqual([]);
  expect(viewGroups([narration, v(0)], 'step')).toEqual([]);
});

test('a !command and a discarded view are never members', () => {
  expect(viewGroups([v(0), { role: 'shell', content: '', views: v(1).views }], 'step')).toEqual([]);
  expect(viewGroups([v(0), { role: 'view', content: '', views: [] }, v(2)], 'step')).toEqual([]);
});

test('a between-message whose narration was already shown breaks the group', () => {
  expect(viewGroups([v(0), { role: 'assistant', content: '', shown: 'already drawn' }, v(1)], 'step')).toEqual([]);
  expect(viewGroups([v(0), { role: 'assistant', content: '', reasoning: 'thinking about it' }, v(1)], 'step')).toEqual([]);
});

test('groups form only in the step and hidden notes modes', () => {
  const msgs = [narration, v(0), narration, v(1), narration, v(2)];
  expect(viewGroups(msgs, 'step')).toEqual([{ head: 1, members: [1, 3, 5], hidden: [0, 2, 4] }]);
  expect(viewGroups(msgs, 'hidden')).toEqual([{ head: 1, members: [1, 3, 5], hidden: [0, 2, 4] }]);
  expect(viewGroups(msgs, 'fold')).toEqual([]);
  expect(viewGroups(msgs, 'open')).toEqual([]);
});

test('the head says what runs now, then what ran', () => {
  const live: ViewRecord = { kind: 'console', data: { command: 'bun run lint' }, phase: 'live', startedAt: 10_000, seq: 1 };
  const done = (code: number): ViewRecord => ({ kind: 'console', data: { command: 'x', exitCode: code, ms: 17_000 }, phase: 'done', startedAt: 0 });
  expect(groupHeadText([done(0), live], 14_500).map((s) => s.text).join('')).toBe('Running 2 commands · $ bun run lint · 4 s');
  expect(groupHeadText([done(0), done(0)], 0).map((s) => s.text).join('')).toBe('Ran 2 commands · ✓ 34.0 s');
  const failed = groupHeadText([done(0), done(2)], 0);
  expect(failed.map((s) => s.text).join('')).toBe('Ran 2 commands · ✗ 1 failed · 34.0 s');
  expect(failed.some((s) => s.color === 'warn')).toBe(true);
});

test('a group that forms around a block the person opened is open', () => {
  const g = { head: 2, members: [2, 4], hidden: [1, 3] };
  expect(groupOpen(allFolded(), g)).toBe(false);
  expect(groupOpen(toggleFold(allFolded(), foldId(2, 'view', 0)), g)).toBe(true);
  expect(groupOpen(toggleFold(allFolded(), foldId(2, 'group')), g)).toBe(true);
});
