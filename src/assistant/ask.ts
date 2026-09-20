// `ask_user`: the model puts a structured question to the person and waits.
//
// Everything here is pure — argument validation, the key-by-key state of the
// picker, and the model-facing result — so it is tested without a terminal. The
// chat owns only the pause (a promise it resolves when `done`) and the render.
//
// The shape: 1–4 questions, each with 2–4 options (label + optional
// description), optionally multi-select. The UI always adds an "Other…" row that
// takes free text, so the person is never boxed into the model's framing — which
// is also why the model may not spend one of its own options on "Other".

export interface AskOption { label: string; description?: string }
export interface AskQuestion { question: string; header?: string; options: AskOption[]; multiSelect?: boolean }
export interface AskAnswer { question: string; labels: string[]; other?: string }

export const ASK_LIMITS = { minQuestions: 1, maxQuestions: 4, minOptions: 2, maxOptions: 4 } as const;
const OTHER_LABEL = 'Other…';

export function parseAskArgs(args: unknown): { questions: AskQuestion[] } | { error: string } {
  const raw = (args as { questions?: unknown })?.questions;
  if (!Array.isArray(raw) || raw.length < ASK_LIMITS.minQuestions || raw.length > ASK_LIMITS.maxQuestions) {
    return { error: `questions must be an array of ${ASK_LIMITS.minQuestions}–${ASK_LIMITS.maxQuestions} items.` };
  }
  const questions: AskQuestion[] = [];
  for (const [i, q] of raw.entries()) {
    const at = `questions[${i}]`;
    const question = typeof q?.question === 'string' ? q.question.trim() : '';
    if (!question) return { error: `${at}.question is required.` };
    if (!Array.isArray(q.options) || q.options.length < ASK_LIMITS.minOptions || q.options.length > ASK_LIMITS.maxOptions) {
      return { error: `${at}.options must hold ${ASK_LIMITS.minOptions}–${ASK_LIMITS.maxOptions} options.` };
    }
    const options: AskOption[] = [];
    for (const [j, o] of (q.options as unknown[]).entries()) {
      const label = typeof (o as AskOption)?.label === 'string' ? (o as AskOption).label.trim() : '';
      if (!label) return { error: `${at}.options[${j}].label is required.` };
      if (/^other\b/i.test(label)) return { error: `${at}.options[${j}]: do not add an "Other" option — the person can always answer in their own words.` };
      if (options.some((x) => x.label.toLowerCase() === label.toLowerCase())) return { error: `${at}.options: "${label}" is listed twice.` };
      const description = typeof (o as AskOption).description === 'string' ? (o as AskOption).description!.trim() : '';
      options.push(description ? { label, description } : { label });
    }
    const header = typeof q.header === 'string' ? q.header.trim() : '';
    questions.push({ question, options, ...(header ? { header } : {}), ...(q.multiSelect === true ? { multiSelect: true } : {}) });
  }
  return { questions };
}

export interface AskState {
  questions: AskQuestion[];
  index: number; // the question on screen
  cursor: number; // row under the cursor; the last row is "Other…"
  picked: number[]; // multi-select: option indices toggled on
  typing: boolean; // the "Other…" free-text field is open
  text: string;
  answers: AskAnswer[];
  done: boolean;
  cancelled: boolean;
}

export const askStart = (questions: AskQuestion[]): AskState =>
  ({ questions, index: 0, cursor: 0, picked: [], typing: false, text: '', answers: [], done: false, cancelled: false });

export interface AskRow { label: string; description?: string; picked: boolean; active: boolean; other: boolean }
export function askRows(state: AskState): AskRow[] {
  const q = state.questions[state.index];
  if (!q) return [];
  return [
    ...q.options.map((o, i) => ({ label: o.label, description: o.description, picked: state.picked.includes(i), active: state.cursor === i, other: false })),
    { label: OTHER_LABEL, picked: state.typing || !!state.text, active: state.cursor === q.options.length, other: true },
  ];
}

// Records the current question's answer and moves on (or finishes).
function answer(state: AskState, labels: string[], other?: string): AskState {
  const q = state.questions[state.index]!;
  const answers = [...state.answers, { question: q.question, labels, ...(other ? { other } : {}) }];
  const last = state.index + 1 >= state.questions.length;
  return { ...state, answers, index: last ? state.index : state.index + 1, cursor: 0, picked: [], typing: false, text: '', done: last };
}

export function askKey(state: AskState, key: { name?: string; ctrl?: boolean; meta?: boolean }): AskState {
  if (state.done) return state;
  const q = state.questions[state.index]!;
  // Key names as flowtty's decoder produces them: Enter is 'return' and the space
  // bar is ' ' — there is no 'enter' and no 'space'. (This file first matched on
  // 'space', with a test helper that invented the same name, so Space toggled
  // nothing in a real terminal.)
  const name = key.name ?? '';
  const enter = name === 'return';
  const otherRow = q.options.length;

  // While typing, every printable key is text: `y`, `n` and digits are not shortcuts.
  if (state.typing) {
    if (name === 'escape') return { ...state, typing: false };
    if (name === 'backspace' || name === 'delete') return { ...state, text: state.text.slice(0, -1) };
    if (enter) {
      const other = state.text.trim();
      if (!other) return state;
      return answer(state, q.multiSelect ? state.picked.map((i) => q.options[i]!.label) : [], other);
    }
    if (name.length === 1 && !key.ctrl && !key.meta) return { ...state, text: state.text + name };
    return state;
  }

  if (name === 'escape') return { ...state, done: true, cancelled: true };
  if (name === 'up') return { ...state, cursor: Math.max(0, state.cursor - 1) };
  if (name === 'down') return { ...state, cursor: Math.min(otherRow, state.cursor + 1) };

  const toggle = (i: number): AskState =>
    ({ ...state, cursor: i, picked: state.picked.includes(i) ? state.picked.filter((x) => x !== i) : [...state.picked, i].sort((a, b) => a - b) });

  if (/^[1-9]$/.test(name)) {
    const i = Number(name) - 1;
    if (i > otherRow) return state; // a digit beyond the list answers nothing
    if (i === otherRow) return { ...state, cursor: otherRow, typing: true };
    return q.multiSelect ? toggle(i) : answer(state, [q.options[i]!.label]);
  }
  if (name === ' ' && q.multiSelect && state.cursor < otherRow) return toggle(state.cursor);
  if (enter) {
    if (state.cursor === otherRow) return { ...state, typing: true };
    if (!q.multiSelect) return answer(state, [q.options[state.cursor]!.label]);
    if (!state.picked.length) return state; // nothing picked is not an answer
    return answer(state, state.picked.map((i) => q.options[i]!.label));
  }
  return state;
}

// What the model reads back. A dismissal is spelled out as one: it is not consent,
// and the model must not quietly fill in the answer it wanted.
export function askResult(state: AskState): string {
  if (state.cancelled) {
    return 'The user dismissed the question without answering. Do not assume an answer: either proceed without it and say which assumption you made, or stop and explain what you need.';
  }
  const lines = state.answers.map((a) => {
    const parts = [...a.labels, ...(a.other ? [`(their own words) ${a.other}`] : [])];
    return `- ${a.question} → ${parts.join(', ')}`;
  });
  return `The user answered:\n${lines.join('\n')}`;
}
