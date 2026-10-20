import { expect, test } from 'bun:test';
import { parseSubagentLine, stopTargetIndex, subagentLabel, subagentListing, tellTargetIndex } from '../subagent-command.ts';

test('a bare line lists; stop as the first word is the stop command', () => {
  expect(parseSubagentLine('  ')).toEqual({ kind: 'list' });
  expect(parseSubagentLine('stop 2')).toEqual({ kind: 'stop', target: '2' });
  expect(parseSubagentLine('STOP the-label')).toEqual({ kind: 'stop', target: 'the-label' });
  expect(parseSubagentLine('stop')).toMatchObject({ kind: 'error' });
  // Only the first word: a later `stop` is part of the prompt.
  expect(parseSubagentLine('please stop 2')).toMatchObject({ kind: 'start', prompt: 'please stop 2' });
});

test('the flags count only as leading words, and the prompt keeps its spacing', () => {
  expect(parseSubagentLine('--with-context  --auto a  b\nc')).toEqual({ kind: 'start', prompt: 'a  b\nc', withContext: true, auto: true });
  expect(parseSubagentLine('read --auto the log')).toEqual({ kind: 'start', prompt: 'read --auto the log', withContext: false, auto: false });
  expect(parseSubagentLine('--with-contextual idea')).toMatchObject({ kind: 'start', prompt: '--with-contextual idea', withContext: false });
  expect(parseSubagentLine('--auto')).toMatchObject({ kind: 'error' });
});

test('a label is cut from the first words and made unique among the live ones', () => {
  expect(subagentLabel('Find the failing test in src', [])).toBe('find-the-failing');
  expect(subagentLabel('Find the failing test', ['find-the-failing'])).toBe('find-the-failing-2');
  expect(subagentLabel('Find the failing test', ['find-the-failing', 'find-the-failing-2'])).toBe('find-the-failing-3');
  expect(subagentLabel('   ??? ', [])).toBe('subagent');
  expect(subagentLabel('Проверь последний коммит', [])).toBe('проверь-последний-коммит');
});

const running = (label: string, over = {}) => ({ label, kind: 'subagent' as const, status: 'working' as const, startedAt: 1_000, until: null, ...over });

test('a stop names a running child by its number in the last listing or by its label', () => {
  const list = [running('a'), running('B')];
  expect(stopTargetIndex(list, '2', ['a', 'B'])).toBe(1);
  expect(stopTargetIndex(list, '3', ['a', 'B'])).toBe(-1);
  expect(stopTargetIndex(list, '0', ['a', 'B'])).toBe(-1);
  expect(stopTargetIndex(list, 'b', null)).toBe(1);
  expect(stopTargetIndex(list, 'nope', ['a', 'B'])).toBe(-1);
  // No listing was printed: a number names nothing.
  expect(stopTargetIndex(list, '1', null)).toBe(-1);
  // The listing said 1 a, 2 b, 3 c; a has ended since. Number 2 is still b, number 1 is gone.
  const later = [running('b'), running('c')];
  expect(stopTargetIndex(later, '2', ['a', 'b', 'c'])).toBe(0);
  expect(stopTargetIndex(later, '1', ['a', 'b', 'c'])).toBe(-1);
});

test('the listing numbers the running ones, then the ended ones with duration and tokens', () => {
  expect(subagentListing([], [])).toBe('no subagents here');
  const text = subagentListing(
    [running('w', { startedAt: 0 }), running('q', { status: 'queued', startedAt: null }), running('d', { status: 'delayed', startedAt: null, until: 5 * 60_000 }), running('t', { kind: 'task', startedAt: 60_000 })],
    [{ label: 'x', kind: 'subagent', outcome: 'answer', ms: 123_000, tokens: 14_200 }, { label: 'y', kind: 'subagent', outcome: 'failed', ms: 400, tokens: 0 }, { label: 'z', kind: 'subagent', outcome: 'stopped', ms: 5_000, tokens: 800 }],
    72_000,
  );
  expect(text.split('\n')).toEqual([
    '1 · w · working · 1m 12s',
    '2 · q · queued',
    '3 · d · in 3m 48s',
    '4 · t (task) · working · 12s',
    'x · done · 2m 3s · 14k tokens',
    'y · failed · <1s',
    'z · stopped · 5s · 800 tokens',
  ]);
});

test('the listing numbers an idle subagent with the rest, and says answered once a later answer is unread', () => {
  const text = subagentListing([
    { label: 'worker', kind: 'subagent', status: 'working', startedAt: 0, until: null },
    { label: 'rester', kind: 'subagent', status: 'idle', startedAt: null, until: null },
    { label: 'talker', kind: 'subagent', status: 'idle', startedAt: null, until: null, answered: true },
  ], [], 5_000);
  expect(text.split('\n')).toEqual(['1 · worker · working · 5s', '2 · rester · idle', '3 · talker · answered']);
});

test('`tell` as the first word is the tell command: a target, then the message with its spacing kept; either missing is the usage', () => {
  expect(parseSubagentLine('tell 2  and  more\nlines')).toEqual({ kind: 'tell', target: '2', text: 'and  more\nlines' });
  expect(parseSubagentLine('TELL worker  hi')).toEqual({ kind: 'tell', target: 'worker', text: 'hi' });
  expect(parseSubagentLine('tell worker')).toMatchObject({ kind: 'error' });
  expect(parseSubagentLine('tell')).toMatchObject({ kind: 'error' });
  expect(parseSubagentLine('tell   ')).toMatchObject({ kind: 'error' });
  // After a flag it is a prompt word like any other.
  expect(parseSubagentLine('--auto tell the story')).toMatchObject({ kind: 'start', prompt: 'tell the story' });
  expect(parseSubagentLine('telling the story')).toMatchObject({ kind: 'start' });
});

test('a tell names a child by the number the listing gave it or by its name; a name two children answer to is refused with their numbers', () => {
  const child = (label: string, status: 'working' | 'idle' = 'idle') => ({ label, kind: 'subagent' as const, status, startedAt: null, until: null });
  const running = [child('alpha'), child('beta', 'working'), child('alpha')];
  expect(tellTargetIndex(running, 'beta', null)).toEqual({ at: 1 });
  expect(tellTargetIndex(running, 'BETA', null)).toEqual({ at: 1 });
  expect(tellTargetIndex(running, 'alpha', null)).toEqual({ many: [1, 3] });
  expect(tellTargetIndex(running, 'nobody', null)).toBeNull();
  // A number is read against the listing the person saw, not the live order.
  expect(tellTargetIndex(running, '2', ['gone', 'beta'])).toEqual({ at: 1 });
  expect(tellTargetIndex(running, '1', ['gone', 'beta'])).toBeNull();
  // A number names the row it was printed on, never the name's several rows.
  expect(tellTargetIndex(running, '1', ['alpha'])).toEqual({ at: 0 });
  expect(tellTargetIndex(running, '2', null)).toBeNull();
  expect(tellTargetIndex(running, '9', ['beta'])).toBeNull();
});

test('labels that repeat: a number names exactly the listed row, stop and tell alike', () => {
  const list = [running('dup'), running('dup', { kind: 'task' })];
  const listed = ['dup', 'dup'];
  expect(stopTargetIndex(list, '1', listed)).toBe(0);
  expect(stopTargetIndex(list, '2', listed)).toBe(1);
  expect(tellTargetIndex(list, '1', listed)).toEqual({ at: 0 });
  expect(tellTargetIndex(list, '2', listed)).toEqual({ at: 1 });
  // Case does not matter to a tell's number, and a row between the repeats does not shift them.
  const mixed = [running('Dup'), running('other'), running('dup')];
  expect(tellTargetIndex(mixed, '3', ['Dup', 'other', 'dup'])).toEqual({ at: 2 });
  expect(stopTargetIndex(mixed, '3', ['Dup', 'other', 'dup'])).toBe(2);
  // A repeat that ended since leaves its number unanswered.
  expect(stopTargetIndex([running('dup')], '2', listed)).toBe(-1);
  expect(tellTargetIndex([running('dup')], '2', listed)).toBeNull();
  // A name that several answer to is still refused with their numbers.
  expect(tellTargetIndex(list, 'dup', listed)).toEqual({ many: [1, 2] });
  // A label made of digits is read as a number.
  expect(tellTargetIndex([running('2024')], '2024', ['2024'])).toBeNull();
});
