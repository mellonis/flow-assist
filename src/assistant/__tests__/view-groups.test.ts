import { expect, test } from 'bun:test';
import { groupHeadText, groupOpen, toggleGroup, viewGroups } from '../view-groups';
import { allFolded, foldId, isClicked, toggleFold, type FoldState } from '../folds';
import type { ViewRecord } from '../views';

const v = (seq: number, turn = 1) => ({ role: 'view', content: '', views: [{ kind: 'console', data: { command: `c${seq}`, exitCode: 0, ms: 1000 }, phase: 'done', startedAt: 0, seq, turn, callId: `t${seq}#0` }] });
// A round whose only text was its `Next:` line: it draws nothing, so a group takes it in.
const narration = { role: 'assistant', content: '', parts: [{ kind: 'text', text: 'Next: lint' }] };
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

test('a between-message that draws anything breaks the group', () => {
  // A step with text of its own, a change, reasoning: what has been shown is never
  // folded away.
  expect(viewGroups([v(0), { role: 'assistant', content: '', parts: [{ kind: 'text', text: 'Now the tests.' }] }, v(1)], 'step')).toEqual([]);
  expect(viewGroups([v(0), { role: 'assistant', content: '', parts: [{ kind: 'change', change: { title: 'a.ts', diff: '', added: 1, removed: 0, hidden: 0 } }] }, v(1)], 'step')).toEqual([]);
  expect(viewGroups([v(0), { role: 'assistant', content: '', reasoning: 'thinking about it' }, v(1)], 'step')).toEqual([]);
  // A call a block does not show is drawn where it was made — not folded away.
  expect(viewGroups([v(0), { role: 'assistant', content: '', parts: [{ kind: 'tools', runs: [{ name: 'read_file', outcome: 'ok' }] }] }, v(1)], 'step')).toEqual([]);
  // …while a step that was nothing but its `Next:` line is taken in, whatever the
  // markdown around it.
  expect(viewGroups([v(0), { role: 'assistant', content: '', parts: [{ kind: 'text', text: '**Next:** lint\n' }] }, v(1)], 'step')).toEqual([{ head: 0, members: [0, 2], hidden: [1] }]);
});

test('groups form only in the step notes mode', () => {
  const msgs = [narration, v(0), narration, v(1), narration, v(2)];
  expect(viewGroups(msgs, 'step')).toEqual([{ head: 1, members: [1, 3, 5], hidden: [0, 2, 4] }]);
  expect(viewGroups(msgs, 'open')).toEqual([]);
});

test('the head says what runs now, then what ran', () => {
  const live: ViewRecord = { kind: 'console', data: { command: 'bun run lint' }, phase: 'live', startedAt: 10_000, seq: 1 };
  const done = (code: number): ViewRecord => ({ kind: 'console', data: { command: 'x', exitCode: code, ms: 17_000 }, phase: 'done', startedAt: 0 });
  expect(groupHeadText([done(0), live], 14_500).map((s) => s.text).join('')).toBe('Running 2 commands · $ bun run lint · 4 s');
  const ok = groupHeadText([done(0), done(0)], 0);
  expect(ok.map((s) => s.text).join('')).toBe('Ran 2 commands · ✓ 34.0 s');
  // The success mark is in the `ok` colour (spec), same as a single block's own tail.
  expect(ok.some((s) => s.text === '✓' && s.color === 'ok')).toBe(true);
  const failed = groupHeadText([done(0), done(2)], 0);
  expect(failed.map((s) => s.text).join('')).toBe('Ran 2 commands · ✗ 1 failed · 34.0 s');
  expect(failed.some((s) => s.color === 'warn')).toBe(true);
});

test('the head text is sanitized — an escape sequence or control character in the command never reaches the row', () => {
  const done = (): ViewRecord => ({ kind: 'console', data: { command: 'y', exitCode: 0, ms: 0 }, phase: 'done', startedAt: 0 });
  const live: ViewRecord = { kind: 'console', data: { command: 'echo \u001B[31mhi\u001B[0m\u0007' }, phase: 'live', startedAt: 0, seq: 1 };
  const text = groupHeadText([done(), live], 0).map((s) => s.text).join('');
  expect(text).not.toMatch(/\u001B|\u0007/);
  expect(text).toBe('Running 2 commands · $ echo hi · 0 s');
});

test('a group that forms around a block the person opened is open', () => {
  const g = { head: 2, members: [2, 4], hidden: [1, 3] };
  expect(groupOpen(allFolded(), g)).toBe(false);
  expect(groupOpen(toggleFold(allFolded(), foldId(2, 'view', 0)), g)).toBe(true);
  expect(groupOpen(toggleFold(allFolded(), foldId(2, 'group')), g)).toBe(true);
});

test('toggleGroup: a member clicked open first — the head click closes the group and clears that exception', () => {
  const g = { head: 2, members: [2, 4], hidden: [1, 3] };
  const memberOpen = toggleFold(allFolded(), foldId(2, 'view', 0));
  expect(groupOpen(memberOpen, g)).toBe(true);
  const closed = toggleGroup(memberOpen, g);
  expect(groupOpen(closed, g)).toBe(false);
  expect(isClicked(closed, foldId(2, 'view', 0))).toBe(false);
});

test('toggleGroup again reopens it', () => {
  const g = { head: 2, members: [2, 4], hidden: [1, 3] };
  const closed = toggleGroup(toggleFold(allFolded(), foldId(2, 'view', 0)), g);
  const reopened = toggleGroup(closed, g);
  expect(groupOpen(reopened, g)).toBe(true);
});

test('toggleGroup opens a closed group with no exceptions', () => {
  const g = { head: 2, members: [2, 4], hidden: [1, 3] };
  expect(groupOpen(allFolded(), g)).toBe(false);
  expect(groupOpen(toggleGroup(allFolded(), g), g)).toBe(true);
});

test('toggleGroup closes a group that reads open only via the global ^o state', () => {
  const g = { head: 2, members: [2, 4], hidden: [1, 3] };
  const globalOpen: FoldState = { open: true, except: new Set<string>() };
  expect(groupOpen(globalOpen, g)).toBe(true);
  expect(groupOpen(toggleGroup(globalOpen, g), g)).toBe(false);
});

test('toggleGroup never touches another block\'s exception', () => {
  const g = { head: 2, members: [2, 4], hidden: [1, 3] };
  const withOther = toggleFold(toggleFold(allFolded(), foldId(2, 'view', 0)), foldId(9, 'steps', 0));
  const closed = toggleGroup(withOther, g);
  expect(isClicked(closed, foldId(9, 'steps', 0))).toBe(true);
});
