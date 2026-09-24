// A turn in time order: what of a round's text is drawn, how steps gather into runs,
// what a folded run's one row says, and how the notes mode is read.
import { expect, test } from 'bun:test';
import {
  addCalls,
  answerText,
  callRun,
  cellWidth,
  cutStep,
  runMarks,
  startsWithNext,
  summarizeArgs,
  endRound,
  isPlanOnly,
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
test('a Next: line is drawn as its sentence — the token never', () => {
  expect(shownText('Next: read the notebook.')).toBe('read the notebook.');
  expect(shownText('next : counting')).toBe('counting');
  expect(shownText('**Next:** open the board')).toBe('open the board');
  expect(shownText('I looked at it.\nNext: count the entries')).toBe('I looked at it.\ncount the entries');
  expect(shownText('Next:')).toBe('');
});

test('a last line that could still become Next: is held back until it says what it is', () => {
  expect(shownText('N')).toBe('');
  expect(shownText('Nex')).toBe('');
  expect(shownText('I looked.\nNext')).toBe('I looked.');
  // `No` is not on the way to `Next:`, and a line that is not the last is closed.
  expect(shownText('No')).toBe('No');
  expect(shownText('N\nmore')).toBe('N\nmore');
  expect(shownText('There are three entries.')).toBe('There are three entries.');
});

test('the answer is drawn exactly as written', () => {
  expect(answerText('Fixed.\n\nNext: restart the server.\n')).toBe('Fixed.\n\nNext: restart the server.');
});

test('a plan is a step that is nothing but its Next: line', () => {
  expect(isPlanOnly('Next: lint')).toBe(true);
  expect(isPlanOnly('**Next:** lint\n')).toBe(true);
  expect(isPlanOnly('I looked.\nNext: lint')).toBe(false);
  expect(isPlanOnly('')).toBe(false);
});

// ─── Runs ─────────────────────────────────────────────────────────────────────
const calls = (...names: string[]): TurnPart => ({ kind: 'tools', runs: names.map((name) => ({ name, outcome: 'ok' })) });

test('consecutive steps are one run — each with the calls it made; a change ends it', () => {
  const segs = turnSegments([text('One.'), calls('read'), text('Two.'), calls('edit'), change('a.ts'), text('Three.'), change('b.ts')]);
  expect(segs.map((s) => s.kind)).toEqual(['run', 'change', 'run', 'change']);
  expect(segs[0]).toEqual({ kind: 'run', n: 0, steps: ['One.', 'Two.'], calls: [{ n: 0, runs: [{ name: 'read', outcome: 'ok' }] }, { n: 1, runs: [{ name: 'edit', outcome: 'ok' }] }] });
  expect(segs[2]).toEqual({ kind: 'run', n: 1, steps: ['Three.'], calls: [null] });
});

test('calls no step made are a block of their own, and end a run', () => {
  const segs = turnSegments([calls('a'), text('One.'), calls('b'), text(''), calls('c'), text('Two.')]);
  expect(segs.map((s) => s.kind)).toEqual(['tools', 'run', 'tools', 'run']);
  expect(segs[0]).toMatchObject({ kind: 'tools', n: 0 });
  expect(segs[1]).toMatchObject({ kind: 'run', n: 0, calls: [{ n: 1 }] });
  expect(segs[2]).toMatchObject({ kind: 'tools', n: 2 });
  expect(segs[3]).toMatchObject({ kind: 'run', n: 1 });
});

test('a round that wrote nothing after a step leaves an empty step, so its calls are not the step\'s', () => {
  const after = endRound([text('One.'), calls('a')], '');
  expect(after.at(-1)).toEqual({ kind: 'text', text: '' });
  expect(addCalls(after, [{ name: 'b', outcome: 'ok' }]).at(-1)).toEqual(calls('b'));
  // Two silent rounds in a row share one line.
  const two = addCalls(endRound(addCalls(after, [{ name: 'b', outcome: 'ok' }]), ''), [{ name: 'c', outcome: 'ok' }]);
  expect(two.at(-1)).toEqual(calls('b', 'c'));
  expect(endRound([text('One.')], 'Two.').at(-1)).toEqual(text('Two.'));
});

test('a call is kept as the trail draws it — never its whole result', () => {
  expect(callRun({ name: 'read_file', args: { p: 1 }, outcome: 'ok', detail: 'x'.repeat(1000), changes: [1], views: [2] })).toEqual({ name: 'read_file', args: { p: 1 }, outcome: 'ok', detail: 'x'.repeat(300) });
  expect(callRun({ outcome: 'ok' })).toBe(null);
  expect(callRun('junk')).toBe(null);
  // The images a call returned are kept as marks — a name and a size — and a mark
  // that is not one (a session file hand-edited) is dropped.
  expect(callRun({ name: 'get_shots', outcome: 'ok', images: [{ name: 'a.png', width: 400, height: 300, path: '/x', sha256: 'f' }, { name: 'b.gif' }, 'junk', { width: 1 }] }))
    .toEqual({ name: 'get_shots', outcome: 'ok', images: [{ name: 'a.png', width: 400, height: 300 }, { name: 'b.gif' }] });
  expect(callRun({ name: 'get_shots', outcome: 'ok', images: [] })).toEqual({ name: 'get_shots', outcome: 'ok' });
});

test('a step with nothing to draw breaks no run', () => {
  expect(turnSegments([text('One.'), text('   '), text('Two.')])).toEqual([{ kind: 'run', n: 0, steps: ['One.', 'Two.'], calls: [null, null] }]);
  expect(turnSegments([text('Next:')])).toEqual([]);
});

test('a run and a stretch of calls keep their numbers as the turn grows — their fold ids never move', () => {
  const before = turnSegments([text('One.'), change('a.ts'), calls('x'), text('Two.')]);
  const after = turnSegments([text('One.'), change('a.ts'), calls('x'), text('Two.'), calls('y'), change('b.ts'), calls('z'), text('Four.')]);
  const ids = (segs: ReturnType<typeof turnSegments>) => segs.filter((s) => s.kind !== 'change').map((s) => `${s.kind}:${(s as { n: number }).n}`);
  expect(ids(after).slice(0, ids(before).length)).toEqual(ids(before));
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

test('a call keeps only what its trail line draws of its arguments', () => {
  const args = summarizeArgs({ path: 'a.ts', content: 'x'.repeat(200_000), n: 3, list: [1, 2, 3], obj: { a: 'y'.repeat(100) }, one: ['z'] })!;
  expect(String(args.content).length).toBeLessThanOrEqual(80);
  expect(args.path).toBe('a.ts');
  expect(args.n).toBe(3);
  expect(args.list).toBe('[3 items]');
  expect(args.one).toBe('[1 item]');
  expect(String(args.obj).length).toBeLessThanOrEqual(40);
  expect(summarizeArgs('junk')).toBe(undefined);
  expect(callRun({ name: 'write_file', args: { content: 'x'.repeat(5000) }, outcome: 'applied' })!.args).toEqual({ content: `${'x'.repeat(79)}…` });
});

test('a round that began with its plan is a step even when cut off before its call', () => {
  expect(startsWithNext('Next: read the file.')).toBe(true);
  expect(startsWithNext('\n**Next:** read')).toBe(true);
  expect(startsWithNext('There are three.\nNext: more')).toBe(false);
  expect(startsWithNext('')).toBe(false);
});

test('a folded run is marked when a call failed, or a write showed no diff', () => {
  const c = (n: number, ...runs: { name: string; outcome: string; write?: boolean }[]) => ({ n, runs });
  expect(runMarks([c(0, { name: 'a', outcome: 'ok' })], false)).toEqual({ failed: false, wrote: false });
  expect(runMarks([null, c(0, { name: 'a', outcome: 'declined' })], false).failed).toBe(true);
  expect(runMarks([c(0, { name: 'a', outcome: 'error' })], false).failed).toBe(true);
  // The last step's write followed by its diff: no mark. Without one, or an earlier
  // step's (its diff would have ended the run): marked.
  expect(runMarks([c(0, { name: 'w', outcome: 'applied', write: true })], true).wrote).toBe(false);
  expect(runMarks([c(0, { name: 'w', outcome: 'applied', write: true })], false).wrote).toBe(true);
  expect(runMarks([c(0, { name: 'w', outcome: 'applied', write: true }), c(1, { name: 'a', outcome: 'ok' })], true).wrote).toBe(true);
});

test('a cut counts the cells a character takes — a wide one two', () => {
  expect(cellWidth('漢字')).toBe(4);
  const cut = cutStep('漢字漢字漢字', 7);
  expect(cellWidth(cut)).toBeLessThanOrEqual(7);
  expect(cut.endsWith('…')).toBe(true);
  expect(cutStep('short', 20)).toBe('short');
});
