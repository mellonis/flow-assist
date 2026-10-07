import { expect, test } from 'bun:test';
import { parseSubagentLine, stopTargetIndex, subagentLabel, subagentListing } from '../subagent-command.ts';

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

test('a stop names a running child by its number or its label', () => {
  const list = [running('a'), running('B')];
  expect(stopTargetIndex(list, '2')).toBe(1);
  expect(stopTargetIndex(list, '3')).toBe(-1);
  expect(stopTargetIndex(list, '0')).toBe(-1);
  expect(stopTargetIndex(list, 'b')).toBe(1);
  expect(stopTargetIndex(list, 'nope')).toBe(-1);
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
