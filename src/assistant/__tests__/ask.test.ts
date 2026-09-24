import { expect, test } from 'bun:test';
import { askKey, askResult, askRows, askStart, parseAskArgs, type AskState } from '../ask';

// Key names are the ones flowtty's decoder really produces — checked against
// `decodeKeys`: the space bar is ' ' (there is no 'space'), Enter is 'return'
// (there is no 'enter'). A helper that invents friendlier names would test a keyboard
// no terminal has, blessing a dead branch.
const SPACE = ' ';
const press = (state: AskState, ...names: string[]) => names.reduce((s, name) => askKey(s, { name: name === 'space' ? SPACE : name }), state);
const type = (state: AskState, text: string) => [...text].reduce((s, c) => askKey(s, { name: c }), state);

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
  expect(s.cursor).toBe(1);
  s = press(s, 'return');
  expect(s.done).toBe(true);
  expect(s.answers).toEqual([{ question: one.questions[0]!.question, labels: ['dayjs'] }]);
  expect(press(askStart(one.questions), '3').answers[0]!.labels).toEqual(['Temporal']);
  // A digit beyond the list is ignored rather than answering something unseen.
  expect(press(askStart(one.questions), '9').done).toBe(false);
  // The cursor stops at the ends instead of wrapping onto another answer.
  expect(press(askStart(one.questions), 'up').cursor).toBe(0);
  expect(press(askStart(one.questions), 'down', 'down', 'down', 'down', 'down').cursor).toBe(3);
});

test('"Other…" takes free text; Esc leaves typing without cancelling the question', () => {
  let s = press(askStart(one.questions), 'down', 'down', 'down', 'return');
  expect(s.typing).toBe(true);
  s = type(s, 'luxon please');
  expect(s.text).toBe('luxon please');
  s = press(s, 'backspace', 'backspace', 'backspace', 'backspace', 'backspace', 'backspace', 'backspace');
  expect(s.text).toBe('luxon');
  // Letters are text while typing — `y`, `n`, digits must not act as shortcuts.
  s = type(s, ' 2');
  expect(s.text).toBe('luxon 2');
  expect(press(s, 'escape').typing).toBe(false);
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
  expect(s.cursor).toBe(0);
  s = press(s, 'down', 'return');
  expect(s.done).toBe(true);
  expect(askResult(s)).toBe('The user answered:\n- First? → a\n- Second? → d');

  const cancelled = press(askStart(qs), 'return', 'escape');
  expect(cancelled.done).toBe(true);
  expect(cancelled.cancelled).toBe(true);
  // A dismissal is told to the model as such — it must not read as consent to anything.
  expect(askResult(cancelled)).toMatch(/dismissed the question without answering/);
  expect(askResult(cancelled)).toMatch(/do not assume/i);
});

test('typing starts the answer: a printable key opens the field with it in, a digit still picks', () => {
  // Walking to the "Other…" row before typing a word is a step nobody guessed at.
  let s = type(askStart(one.questions), 'l');
  expect(s.typing).toBe(true);
  expect(s.text).toBe('l');
  expect(s.caret).toBe(1);
  expect(s.cursor).toBe(3); // the field belongs to the "Other…" row, and the list says so
  expect(askRows(s).at(-1)!.picked).toBe(true);
  s = type(s, 'uxon 2');
  expect(s.text).toBe('luxon 2');
  // A digit is the shortcut the list advertises, not the first letter of an answer.
  expect(press(askStart(one.questions), '2').answers[0]!.labels).toEqual(['dayjs']);
  expect(press(askStart(one.questions), '0').typing).toBe(false);
  // The space bar toggles in a multi-select; it opens no field anywhere.
  const multi = [{ question: 'Which checks?', multiSelect: true, options: [{ label: 'lint' }, { label: 'types' }] }];
  expect(press(askStart(multi), 'space').typing).toBe(false);
  expect(press(askStart(one.questions), 'space').typing).toBe(false);
  // Ctrl+r (the chat's fold key) is not text either.
  expect(askKey(askStart(one.questions), { name: 'r', ctrl: true }).typing).toBe(false);
});

test('the field is an editor: the caret moves, words are killed, and a paste goes in at it', () => {
  // A paste arrives as ONE key; dropping it whole would make it impossible to give a
  // pasted path as an answer at all.
  let s = type(askStart(one.questions), 'see ');
  s = askKey(s, { name: 'paste', text: '/tmp/a b/report.txt' });
  expect(s.text).toBe('see /tmp/a b/report.txt');
  expect(s.caret).toBe(s.text.length);
  // The field is one line: a pasted line break is a space, and nothing in a paste submits.
  s = askKey(s, { name: 'paste', text: '\nline two\nline three\n' });
  expect(s.text).toBe('see /tmp/a b/report.txt line two line three ');
  expect(s.done).toBe(false);
  // Caret motion and the kill bindings are flowtty's, not this file's.
  const home = askKey(s, { name: 'home' });
  expect(home.caret).toBe(0);
  const typedAtCaret = type(home, 'I ');
  expect(typedAtCaret.text).toStartWith('I see ');
  const killedWord = askKey(s, { name: 'w', ctrl: true });
  expect(killedWord.text).toBe('see /tmp/a b/report.txt line two line ');
  // A paste on the LIST starts the answer the same way a typed character does.
  const fromList = askKey(askStart(one.questions), { name: 'paste', text: 'ABC-1\nsecond line' });
  expect(fromList.typing).toBe(true);
  expect(fromList.text).toBe('ABC-1 second line');
  // Esc leaves the field for the list, the text kept; Esc on the list dismisses.
  expect(press(s, 'escape').typing).toBe(false);
  expect(press(s, 'escape').cancelled).toBe(false);
  expect(press(press(s, 'escape'), 'escape').cancelled).toBe(true);
});

test('the result names free text as the person\'s own words', () => {
  const s = press(type(press(askStart(one.questions), '4'), 'use the platform'), 'return');
  expect(askResult(s)).toBe('The user answered:\n- Which library should we use for dates? → (their own words) use the platform');
});
