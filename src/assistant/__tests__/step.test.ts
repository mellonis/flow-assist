// A turn in time order: what of a round's text is drawn, how steps gather into runs,
// what a folded run's one row says, and how the notes mode is read.
import { expect, test } from 'bun:test';
import {
  cutStep,
  notesCommand,
  notesMode,
  notesSaid,
  readParts,
  runRowText,
  shownText,
  stepSummary,
  turnSegments,
  type TurnPart,
} from '../step.ts';

const change = (title: string) => ({ kind: 'change' as const, change: { title, diff: '@@ -1 +1 @@\n-a\n+b', added: 1, removed: 1, hidden: 0 } });
const text = (t: string): TurnPart => ({ kind: 'text', text: t });

// ─── What of a text is drawn ──────────────────────────────────────────────────
test('a Next: line is never drawn, wherever it stands and however it is marked up', () => {
  expect(shownText('Next: read the notebook.')).toBe('');
  expect(shownText('next : counting')).toBe('');
  expect(shownText('**Next:** open the board')).toBe('');
  expect(shownText('I looked at it.\nNext: count the entries')).toBe('I looked at it.');
  expect(shownText('Next: look\n\nThe file is short.')).toBe('The file is short.');
});

test('a last line that could still become Next: is held back until it says what it is', () => {
  expect(shownText('N')).toBe('');
  expect(shownText('Nex')).toBe('');
  expect(shownText('I looked.\nNext')).toBe('I looked.');
  // `No` is not on the way to `Next:`, and a line that is not the last is closed.
  expect(shownText('No')).toBe('No');
  expect(shownText('N\nmore')).toBe('N\nmore');
  // Everything else is drawn as written.
  expect(shownText('There are three entries.')).toBe('There are three entries.');
});

// ─── Runs ─────────────────────────────────────────────────────────────────────
test('consecutive steps are one run, and a change ends it', () => {
  const segs = turnSegments([text('One.'), text('Two.'), change('a.ts'), text('Three.'), change('b.ts')]);
  expect(segs.map((s) => s.kind)).toEqual(['run', 'change', 'run', 'change']);
  expect(segs[0]).toEqual({ kind: 'run', n: 0, steps: ['One.', 'Two.'] });
  expect(segs[2]).toEqual({ kind: 'run', n: 1, steps: ['Three.'] });
});

test('a step that is all Next: draws nothing and breaks no run', () => {
  const segs = turnSegments([text('One.'), text('Next: look'), text('Two.')]);
  expect(segs).toEqual([{ kind: 'run', n: 0, steps: ['One.', 'Two.'] }]);
  expect(turnSegments([text('Next: look')])).toEqual([]);
});

test('a run keeps its number as the turn grows — its fold id never moves', () => {
  const before = turnSegments([text('One.'), change('a.ts'), text('Two.')]);
  const after = turnSegments([text('One.'), change('a.ts'), text('Two.'), text('Three.'), change('b.ts'), text('Four.')]);
  expect(before.filter((s) => s.kind === 'run').map((s) => (s as { n: number }).n)).toEqual([0, 1]);
  expect(after.filter((s) => s.kind === 'run').map((s) => (s as { n: number }).n)).toEqual([0, 1, 2]);
});

// ─── The row a folded run is ──────────────────────────────────────────────────
test('the row says the newest step, by its last finished sentence or its first line', () => {
  expect(stepSummary('I will read the file first. Now I am counting the lines.')).toBe('Now I am counting the lines.');
  expect(stepSummary('Looking at the notebook')).toBe('Looking at the notebook');
  expect(stepSummary('- Reading `src/cli.ts` now.')).toBe('Reading src/cli.ts now.');
  expect(stepSummary('First I will look.\n\nThen I will count them.')).toBe('Then I will count them.');
});

test('a run of one has no count; a longer run says how many steps it holds', () => {
  expect(runRowText(['I will look.'], 60)).toBe('▸ I will look.');
  expect(runRowText(['I will look.', 'Now the tests.'], 60)).toBe('▸ Now the tests.  (2 steps)');
});

test('the row is one terminal row, and the count always fits', () => {
  const row = runRowText(['a', 'a very long sentence about everything that was looked at.'], 30);
  expect(Array.from(row).length).toBeLessThanOrEqual(30);
  expect(row.endsWith('(2 steps)')).toBe(true);
  expect(row).toContain('…');
});

test('a line of chrome is cut to one row', () => {
  expect(cutStep('short', 20)).toBe('short');
  expect(cutStep('a very long sentence indeed', 10)).toBe('a very lo…');
  expect(Array.from(cutStep('a very long sentence indeed', 10)).length).toBe(10);
  expect(cutStep('anything', 0)).toBe('');
});

// ─── Parts as a session gave them ─────────────────────────────────────────────
test('a malformed part is dropped, never drawn and never thrown on', () => {
  expect(readParts('garbage')).toEqual([]);
  expect(readParts(null)).toEqual([]);
  expect(readParts([null, 7, 'x', { kind: 'text' }, { kind: 'text', text: 3 }, { kind: 'change', change: { title: 'a' } }, { kind: 'odd' }])).toEqual([]);
  expect(readParts([{ kind: 'text', text: 'Kept.' }, { kind: 'change', change: { title: 'a.ts', diff: '', added: 'x' } }])).toEqual([
    { kind: 'text', text: 'Kept.' },
    { kind: 'change', change: { title: 'a.ts', diff: '', added: 0, removed: 0, hidden: 0 } },
  ]);
});

// ─── The mode ─────────────────────────────────────────────────────────────────
test('a mode is read defensively — the dropped fold and hidden read as step', () => {
  expect(notesMode(undefined)).toBe('step');
  expect(notesMode('OPEN')).toBe('open');
  expect(notesMode('fold')).toBe('step');
  expect(notesMode('hidden')).toBe('step');
  expect(notesMode('nonsense')).toBe('step');
});

test('/notes takes step or open, and says what it did', () => {
  expect(notesCommand('')).toBe('say');
  expect(notesCommand('open')).toBe('open');
  expect(notesCommand('fold')).toBe(null);
  expect(notesCommand('hidden')).toBe(null);
  expect(notesSaid('step')).toContain('one dim line');
  expect(notesSaid('open')).toContain('in full');
});
