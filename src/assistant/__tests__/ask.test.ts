import { expect, test } from 'bun:test';
import { askKey, askPageCount, askResult, askRows, askShown, askStart, askSubmitRows, askTabs, parseAskArgs, type AskDraft, type AskState } from '../ask';

// Key names are the ones flowtty's decoder really produces — checked against
// `decodeKeys`: the space bar is ' ' (there is no 'space'), Enter is 'return'
// (there is no 'enter'). A helper that invents friendlier names would test a keyboard
// no terminal has, blessing a dead branch.
const SPACE = ' ';
const press = (state: AskState, ...names: string[]) => names.reduce((s, name) => askKey(s, { name: name === 'space' ? SPACE : name }), state);
const type = (state: AskState, text: string) => [...text].reduce((s, c) => askKey(s, { name: c }), state);
// The working state of the page on screen (`AskState` holds one `AskDraft` per question).
const draft = (state: AskState): AskDraft => state.drafts[state.index]!;

const one = {
  questions: [{
    question: 'Which library should we use for dates?',
    header: 'Library',
    options: [{ label: 'date-fns', description: 'Tree-shakeable functions' }, { label: 'dayjs', description: 'Small, moment-like API' }, { label: 'Temporal' }],
  }],
};

test('the arguments are validated before anything is shown to the person', () => {
  expect('error' in parseAskArgs({})).toBe(true);
  expect('error' in parseAskArgs({ questions: [] })).toBe(true);
  expect('error' in parseAskArgs({ questions: [{ question: 'q', options: [{ label: 'only one' }] }] })).toBe(true);
  expect('error' in parseAskArgs({ questions: [{ question: 'q', options: [1, 2, 3, 4, 5].map((n) => ({ label: `o${n}` })) }] })).toBe(true);
  expect('error' in parseAskArgs({ questions: [{ question: '', options: [{ label: 'a' }, { label: 'b' }] }] })).toBe(true);
  expect('error' in parseAskArgs({ questions: [{ question: 'q', options: [{ label: 'a' }, { label: 'a' }] }] })).toBe(true);
  expect('error' in parseAskArgs({ questions: Array(5).fill({ question: 'q', options: [{ label: 'a' }, { label: 'b' }] }) })).toBe(true);
  // "Other" is always offered by the UI, so the model may not spend an option on it.
  expect('error' in parseAskArgs({ questions: [{ question: 'q', options: [{ label: 'a' }, { label: 'Other' }] }] })).toBe(true);
  const ok = parseAskArgs(one);
  expect('questions' in ok && ok.questions[0]!.options.map((o) => o.label)).toEqual(['date-fns', 'dayjs', 'Temporal']);
});

test('single choice: arrows move, Enter answers, a digit answers at once', () => {
  let s = askStart(one.questions);
  expect(askRows(s).map((r) => r.label)).toEqual(['date-fns', 'dayjs', 'Temporal', 'Other…']);
  s = press(s, 'down', 'down', 'up');
  expect(draft(s).cursor).toBe(1);
  s = press(s, 'return');
  expect(s.done).toBe(true);
  expect(s.answers).toEqual([{ question: one.questions[0]!.question, labels: ['dayjs'] }]);
  expect(press(askStart(one.questions), '3').answers[0]!.labels).toEqual(['Temporal']);
  // A digit beyond the list is ignored rather than answering something unseen.
  expect(press(askStart(one.questions), '9').done).toBe(false);
  // The cursor stops at the ends instead of wrapping onto another answer.
  expect(draft(press(askStart(one.questions), 'up')).cursor).toBe(0);
  expect(draft(press(askStart(one.questions), 'down', 'down', 'down', 'down', 'down')).cursor).toBe(3);
});

test('"Other…" takes free text; Esc leaves typing without cancelling the question', () => {
  let s = press(askStart(one.questions), 'down', 'down', 'down', 'return');
  expect(draft(s).typing).toBe(true);
  s = type(s, 'luxon please');
  expect(draft(s).text).toBe('luxon please');
  s = press(s, 'backspace', 'backspace', 'backspace', 'backspace', 'backspace', 'backspace', 'backspace');
  expect(draft(s).text).toBe('luxon');
  // Letters are text while typing — `y`, `n`, digits must not act as shortcuts.
  s = type(s, ' 2');
  expect(draft(s).text).toBe('luxon 2');
  expect(draft(press(s, 'escape')).typing).toBe(false);
  expect(press(s, 'escape').cancelled).toBe(false);
  // An empty answer is not an answer.
  expect(press(askStart(one.questions), 'down', 'down', 'down', 'return', 'return').done).toBe(false);
  s = press(s, 'return');
  expect(s.done).toBe(true);
  expect(s.answers[0]).toEqual({ question: one.questions[0]!.question, labels: [], other: 'luxon 2' });
});

test('multi-select: Space toggles, Enter confirms, and nothing picked is not an answer', () => {
  const q = [{ question: 'Which checks to run?', multiSelect: true, options: [{ label: 'lint' }, { label: 'types' }, { label: 'tests' }] }];
  let s = askStart(q);
  expect(press(s, 'return').done).toBe(false);
  s = press(s, 'space', 'down', 'down', 'space');
  expect(askRows(s).filter((r) => r.picked).map((r) => r.label)).toEqual(['lint', 'tests']);
  s = press(s, 'space'); // untoggle
  expect(askRows(s).filter((r) => r.picked).map((r) => r.label)).toEqual(['lint']);
  s = press(s, '2'); // a digit toggles in multi mode, it does not answer
  expect(s.done).toBe(false);
  s = press(s, 'return');
  expect(s.answers[0]!.labels).toEqual(['lint', 'types']);
  // Free text rides along with the picked options.
  const withOther = press(type(press(askStart(q), 'space', 'down', 'down', 'down', 'return'), 'e2e'), 'return');
  expect(withOther.answers[0]).toEqual({ question: q[0]!.question, labels: ['lint'], other: 'e2e' });
});

test('several questions are asked in turn; Esc cancels the whole ask', () => {
  const qs = [
    { question: 'First?', options: [{ label: 'a' }, { label: 'b' }] },
    { question: 'Second?', options: [{ label: 'c' }, { label: 'd' }] },
  ];
  let s = press(askStart(qs), 'return');
  expect(s.done).toBe(false);
  expect(s.index).toBe(1);
  expect(draft(s).cursor).toBe(0);
  s = press(s, 'down', 'return');
  // The last question lands on the submit page, which is the only one that answers.
  expect(s.done).toBe(false);
  expect(s.index).toBe(2);
  s = press(s, 'return');
  expect(s.done).toBe(true);
  expect(askResult(s)).toBe('The user answered:\n- First? → a\n- Second? → d');

  const cancelled = press(askStart(qs), 'return', 'escape');
  expect(cancelled.done).toBe(true);
  expect(cancelled.cancelled).toBe(true);
  // A dismissal is told to the model as such — it must not read as consent to anything.
  expect(askResult(cancelled)).toMatch(/dismissed the question without answering/);
  expect(askResult(cancelled)).toMatch(/do not assume/i);
});

test('what the chat keeps of an answered question: the title it was shown under, and the answer', () => {
  // The model gets the answer as the tool's result; the person keeps the block they
  // answered, so the question does not vanish the moment it is answered.
  expect(askShown(press(askStart(one.questions), 'down', 'return'))).toEqual([
    { title: 'Library — Which library should we use for dates?', answer: 'dayjs' },
  ]);
  // Their own words, in a multi-select that also picked a label.
  const multi = [{ question: 'Which checks?', options: [{ label: 'lint' }, { label: 'tests' }], multiSelect: true }];
  const both = press(type(press(press(askStart(multi), ' ', 'down', ' '), 'down', 'return'), 'docs'), 'return');
  expect(askShown(both)).toEqual([{ title: 'Which checks?', answer: 'lint, tests, docs' }]);
  // A dismissal is its own word, and a question never reached is dismissed too.
  expect(askShown(press(askStart(one.questions), 'escape'))).toEqual([{ title: 'Library — Which library should we use for dates?', answer: 'dismissed', dismissed: true }]);
  const qs = [
    { question: 'First?', options: [{ label: 'a' }, { label: 'b' }] },
    { question: 'Second?', options: [{ label: 'c' }, { label: 'd' }] },
  ];
  expect(askShown(press(askStart(qs), 'return', 'escape'))).toEqual([
    { title: 'First?', answer: 'a' },
    { title: 'Second?', answer: 'dismissed', dismissed: true },
  ]);
});

test('typing starts the answer: a printable key opens the field with it in, a digit still picks', () => {
  // Walking to the "Other…" row before typing a word is a step nobody guessed at.
  let s = type(askStart(one.questions), 'l');
  expect(draft(s).typing).toBe(true);
  expect(draft(s).text).toBe('l');
  expect(draft(s).caret).toBe(1);
  expect(draft(s).cursor).toBe(3); // the field belongs to the "Other…" row, and the list says so
  expect(askRows(s).at(-1)!.picked).toBe(true);
  s = type(s, 'uxon 2');
  expect(draft(s).text).toBe('luxon 2');
  // A digit is the shortcut the list advertises, not the first letter of an answer.
  expect(press(askStart(one.questions), '2').answers[0]!.labels).toEqual(['dayjs']);
  expect(draft(press(askStart(one.questions), '0')).typing).toBe(false);
  // The space bar toggles in a multi-select; it opens no field anywhere.
  const multi = [{ question: 'Which checks?', multiSelect: true, options: [{ label: 'lint' }, { label: 'types' }] }];
  expect(draft(press(askStart(multi), 'space')).typing).toBe(false);
  expect(draft(press(askStart(one.questions), 'space')).typing).toBe(false);
  // Ctrl+r (the chat's fold key) is not text either.
  expect(draft(askKey(askStart(one.questions), { name: 'r', ctrl: true })).typing).toBe(false);
});

test('the field is an editor: the caret moves, words are killed, and a paste goes in at it', () => {
  // A paste arrives as ONE key; dropping it whole would make it impossible to give a
  // pasted path as an answer at all.
  let s = type(askStart(one.questions), 'see ');
  s = askKey(s, { name: 'paste', text: '/tmp/a b/report.txt' });
  expect(draft(s).text).toBe('see /tmp/a b/report.txt');
  expect(draft(s).caret).toBe(draft(s).text.length);
  // The field is one line: a pasted line break is a space, and nothing in a paste submits.
  s = askKey(s, { name: 'paste', text: '\nline two\nline three\n' });
  expect(draft(s).text).toBe('see /tmp/a b/report.txt line two line three ');
  expect(s.done).toBe(false);
  // Caret motion and the kill bindings are flowtty's, not this file's.
  const home = askKey(s, { name: 'home' });
  expect(draft(home).caret).toBe(0);
  const typedAtCaret = type(home, 'I ');
  expect(draft(typedAtCaret).text).toStartWith('I see ');
  const killedWord = askKey(s, { name: 'w', ctrl: true });
  expect(draft(killedWord).text).toBe('see /tmp/a b/report.txt line two line ');
  // A paste on the LIST starts the answer the same way a typed character does.
  const fromList = askKey(askStart(one.questions), { name: 'paste', text: 'ABC-1\nsecond line' });
  expect(draft(fromList).typing).toBe(true);
  expect(draft(fromList).text).toBe('ABC-1 second line');
  // Esc leaves the field for the list, the text kept; Esc on the list dismisses.
  expect(draft(press(s, 'escape')).typing).toBe(false);
  expect(press(s, 'escape').cancelled).toBe(false);
  expect(press(press(s, 'escape'), 'escape').cancelled).toBe(true);
});

test('the result names free text as the person\'s own words', () => {
  const s = press(type(press(askStart(one.questions), '4'), 'use the platform'), 'return');
  expect(askResult(s)).toBe('The user answered:\n- Which library should we use for dates? → (their own words) use the platform');
});

test('a question with no options opens its field: digits and spaces are text, and Esc dismisses', () => {
  const free = askStart([{ question: 'How many?', options: [] }]);
  expect(draft(free).typing).toBe(true);
  const done = press(type(free, '42'), 'return');
  expect(done.done).toBe(true);
  expect(done.answers[0]).toMatchObject({ labels: [], other: '42' });
  expect(draft(type(free, ' 3 files')).text).toBe(' 3 files');
  const typed = type(free, 'a');
  expect(draft(typed).text).toBe('a');
  const gone = press(typed, 'escape');
  expect(gone).toMatchObject({ done: true, cancelled: true });
  expect(press(free, 'escape')).toMatchObject({ done: true, cancelled: true });
});

test('a question with options still returns from its field to the list on Esc', () => {
  const s = press(type(askStart(one.questions), 'a'), 'escape');
  expect(s).toMatchObject({ done: false });
  expect(draft(s)).toMatchObject({ typing: false });
});

// ── the wizard: per-page drafts, one submit ─────────────────────────────────

const two = [
  { question: 'First?', options: [{ label: 'one' }, { label: 'two' }, { label: 'three' }] },
  { question: 'Second?', options: [{ label: 'alpha' }, { label: 'beta' }] },
];

test('a single-question call answers in one key', () => {
  const s = askKey(askStart([two[0]!]), { name: '1' });
  expect(s.done).toBe(true);
  expect(s.answers[0]!.labels).toEqual(['one']);
  // An empty free-text answer is not an answer, as today.
  const free = askKey(askStart([{ question: 'How many?', options: [] }]), { name: 'return' });
  expect(free.done).toBe(false);
});

test('a two-question call keeps each page\'s draft', () => {
  // q1 answered with a digit (its pick commits and the wizard moves on)…
  let s = press(askStart(two), '2');
  expect(s.index).toBe(1);
  // …q2: open "Other…", type `abc`, then `left` inside the field moves the CARET only.
  s = press(type(press(s, '3'), 'abc'), 'left');
  expect(draft(s).text).toBe('abc');
  expect(draft(s).caret).toBe(2);
  // To change the page, leave typing with Esc first, then `left`.
  s = press(s, 'escape', 'left');
  expect(s.index).toBe(0);
  // q1's pick stands.
  expect(s.drafts[0]!.picked).toEqual([1]);
  // Back on q2 the text is where it was left, caret included.
  s = press(s, 'right');
  expect(s.index).toBe(1);
  expect(draft(s).text).toBe('abc');
  expect(draft(s).caret).toBe(2);
});

test('a content key on a page with a draft inserts, never replaces', () => {
  let s = press(askStart(two), '2');
  s = press(type(press(s, '3'), 'abc'), 'left', 'escape', 'left', 'right');
  // `X` resumes typing and goes in AT the caret — the draft is never overwritten.
  s = press(s, 'X');
  expect(draft(s).typing).toBe(true);
  expect(draft(s).text).toBe('abXc');
});

test('the submit page sends the last state of every draft', () => {
  let s = press(askStart(two), '1'); // q1: pick `one`, straight on
  s = press(type(press(s, '3'), 'abc'), 'escape'); // q2: their own words, then back to the list
  s = press(s, 'right'); // page 2 of 2 lands on the submit page
  expect(s.index).toBe(askPageCount(s) - 1);
  // The second visit replaces the text with `rst` (the field keeps the draft to edit).
  s = press(type(press(s, 'left', 'return', 'backspace', 'backspace', 'backspace'), 'rst'), 'escape');
  expect(draft(s).text).toBe('rst');
  s = press(s, 'right');
  expect(askSubmitRows(s)).toEqual([
    { title: 'First?', answer: 'one' },
    { title: 'Second?', answer: 'rst' },
  ]);
  // Enter on the submit page answers the whole call, once.
  s = press(s, 'return');
  expect(s.done).toBe(true);
  expect(askResult(s)).toContain('rst');
  expect(askResult(s)).not.toContain('abc');
});

test('an unanswered question reads no answer given', () => {
  let s = press(askStart(two), '2'); // q1 answered; q2 never touched
  expect(s.index).toBe(1);
  s = press(s, 'right', 'return'); // the submit page
  expect(s.done).toBe(true);
  expect(askResult(s)).toContain('- Second? → no answer given');
  expect(askShown(s)[1]).toEqual({ title: 'Second?', answer: '(not answered)' });
});

test('page keys do not fight the field', () => {
  let s = press(askStart(two), '2');
  s = press(type(press(s, '3'), 'abc'), 'left');
  // While typing, the arrows are the caret's, never the pages'.
  s = press(s, 'left', 'right');
  expect(s.index).toBe(1);
  expect(draft(s).caret).toBe(2);
  // On the list: the ends clamp, no wrap.
  s = press(s, 'escape', 'left');
  expect(press(s, 'left').index).toBe(0);
  expect(press(s, 'left', 'left').index).toBe(0);
  const end = press(s, 'right', 'right', 'right');
  expect(end.index).toBe(askPageCount(end) - 1);
  expect(press(end, 'right').index).toBe(askPageCount(end) - 1);
});

test('the page strip reads the drafts and the page on screen', () => {
  // One question answers with no strip at all.
  expect(askTabs(askStart(one.questions))).toEqual([]);
  const s = press(askStart(two), '2');
  expect(askTabs(s)).toEqual([
    { label: 'question 1', answered: true, current: false },
    { label: 'question 2', answered: false, current: true },
    { label: 'Submit', answered: false, current: false },
  ]);
  // A header is what its page goes by; text in a draft marks the page answered too.
  const headed = askStart([{ ...two[0]!, header: 'Branch' }, two[1]!]);
  const t = press(type(press(headed, 'right', '3'), 'own words'));
  expect(askTabs(t)[1]).toEqual({ label: 'question 2', answered: true, current: true });
  expect(askTabs(t)[0]).toEqual({ label: 'Branch', answered: false, current: false });
});
