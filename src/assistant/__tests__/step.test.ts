// The step line's rules, with the clock passed in: what counts as a finished
// sentence, what a `Next:` line means, and the one-change-a-second floor.
import { expect, test } from 'bun:test';
import {
  cutStep,
  dueStep,
  emptyStep,
  joinNarration,
  lastStep,
  notesCommand,
  notesMode,
  notesSaid,
  offerStep,
  STEP_FLOOR_MS,
  stepWaitMs,
} from '../step.ts';

test('only a finished sentence reaches the line', () => {
  expect(lastStep('Let me see how many there are.')).toBe('Let me see how many there are.');
  // Still being written: the line keeps what it had, so nothing comes back here.
  expect(lastStep('Let me see how many')).toBe('');
  expect(lastStep('')).toBe('');
  expect(lastStep('   \n\n  ')).toBe('');
});

test('a sentence growing behind a finished one does not move the line', () => {
  const text = 'I will read the file first. Now I am count';
  expect(lastStep(text)).toBe('I will read the file first.');
  // …and once it finishes, it is the one shown.
  expect(lastStep(`${text}ing the lines.`)).toBe('Now I am counting the lines.');
});

test('a question or an exclamation ends a sentence too', () => {
  expect(lastStep('First: how many are there?')).toBe('First: how many are there?');
  expect(lastStep('Done!')).toBe('Done!');
  expect(lastStep('She said "go now."')).toBe('She said "go now."');
});

test('a Next: line is a step as soon as its line ends, and the prefix is not shown', () => {
  // No full stop, but the newline after it closed the line.
  expect(lastStep('Next: read the tracker\n')).toBe('read the tracker');
  expect(lastStep('Next: read the tracker.')).toBe('read the tracker.');
  // The last line is still being written — the one before it stands.
  expect(lastStep('Next: read the tracker\nNext: count the iss')).toBe('read the tracker');
});

test('a line is read as a person reads it, not as markdown', () => {
  expect(lastStep('- Reading `src/cli.ts` now.')).toBe('Reading src/cli.ts now.');
  expect(lastStep('**Next:** open the board\n')).toBe('open the board');
  // An underscore is part of a name, never emphasis.
  expect(lastStep('Calling read_file now.')).toBe('Calling read_file now.');
});

test('the last finished line wins, whatever came before it', () => {
  expect(lastStep('First I will look.\n\nThen I will count them.')).toBe('Then I will count them.');
});

test('the line changes at most once a second', () => {
  const t0 = 10_000;
  // Nothing has been shown yet, so the first sentence lands at once.
  let s = offerStep(emptyStep(), 'I will look at the tracker.', t0);
  expect(s.shown).toBe('I will look at the tracker.');
  expect(stepWaitMs(s, t0)).toBe(0);

  // A second sentence 300 ms later waits instead of replacing it.
  s = offerStep(s, 'I will look at the tracker.\n\nNow I will count them.', t0 + 300);
  expect(s.shown).toBe('I will look at the tracker.');
  expect(s.pending).toBe('Now I will count them.');
  expect(stepWaitMs(s, t0 + 300)).toBe(STEP_FLOOR_MS - 300);

  // Too early still.
  expect(dueStep(s, t0 + 900).shown).toBe('I will look at the tracker.');
  // The second is up: what waited is what the line says.
  const due = dueStep(s, t0 + STEP_FLOOR_MS);
  expect(due.shown).toBe('Now I will count them.');
  expect(due.pending).toBe('');
  expect(stepWaitMs(due, t0 + STEP_FLOOR_MS)).toBe(0);
});

test('the same sentence again is not a change', () => {
  const t0 = 10_000;
  const s = offerStep(emptyStep(), 'Reading the file.', t0);
  const again = offerStep(s, 'Reading the file.', t0 + 50);
  expect(again).toBe(s);
  expect(again.pending).toBe('');
});

test('narration with nothing finished in it leaves the line alone', () => {
  const t0 = 10_000;
  const s = offerStep(emptyStep(), 'Reading the file.', t0);
  expect(offerStep(s, 'Reading the file.\n\nNow I am', t0 + 5000).shown).toBe('Reading the file.');
});

test('two chunks of narration do not run together', () => {
  // Appended with nothing between them they read as one broken sentence:
  // "…how many there are.Now I will count them."
  const joined = joinNarration('Let me see how many there are.', 'Now I will count them.');
  expect(joined).not.toContain('are.Now');
  expect(joined).toBe('Let me see how many there are.\n\nNow I will count them.');
  expect(joinNarration('', 'First.')).toBe('First.');
  expect(joinNarration(undefined, 'First.')).toBe('First.');
});

test('the line is cut to one row', () => {
  expect(cutStep('short', 20)).toBe('short');
  expect(cutStep('a very long sentence indeed', 10)).toBe('a very lo…');
  expect(Array.from(cutStep('a very long sentence indeed', 10)).length).toBe(10);
  expect(cutStep('anything', 0)).toBe('');
});

test('a mode is read defensively and a command says what it did', () => {
  expect(notesMode(undefined)).toBe('step');
  expect(notesMode('FOLD')).toBe('fold');
  expect(notesMode('nonsense')).toBe('step');
  expect(notesCommand('')).toBe('say');
  expect(notesCommand('hidden')).toBe('hidden');
  expect(notesCommand('louder')).toBe(null);
  expect(notesSaid('step')).toContain('one dim line');
  expect(notesSaid('hidden')).toContain('not drawn');
});
