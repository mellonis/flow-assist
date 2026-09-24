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
//
// Answering by TYPING starts that free-text field, and the field itself is flowtty's
// editor — the same one the chat's own field is (see AGENTS.md, "The field's EDITING
// is flowtty's editorReducer"), so caret motion, the kill bindings and paste are not
// written here and cannot drift from the chat's.

import { editorReducer } from '@flowtty/core';
import { isPrintable } from '@flowtty/core';

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
  // The caret in `text`: a UTF-16 index resting on a code-point boundary, flowtty's
  // unit (`text.slice(0, caret)` is what is before it). Not to be confused with
  // `cursor`, which is the ROW under the cursor in the list above.
  caret: number;
  answers: AskAnswer[];
  done: boolean;
  cancelled: boolean;
}

export const askStart = (questions: AskQuestion[]): AskState =>
  ({ questions, index: 0, cursor: 0, picked: [], typing: false, text: '', caret: 0, answers: [], done: false, cancelled: false });

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
  return { ...state, answers, index: last ? state.index : state.index + 1, cursor: 0, picked: [], typing: false, text: '', caret: 0, done: last };
}

// A key as the chat hands it over — flowtty's, with a paste's text on it.
export type AskKey = { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; text?: string };

// The field is ONE line, so a pasted line break is a space: a path or a ticket's text
// pasted from anywhere else still goes in whole, and nothing in it can submit.
const onePasteLine = (text: string) => String(text ?? '').replace(/\s*\n\s*/g, ' ');

// Opens the free-text field with `text` already in it, the caret after it. The row
// cursor goes to "Other…" too: that is the row the field belongs to, and the list
// shows it as the answer being given.
const startTyping = (state: AskState, otherRow: number, text: string): AskState =>
  ({ ...state, cursor: otherRow, typing: true, text, caret: text.length });

export function askKey(state: AskState, key: AskKey, width = 60): AskState {
  if (state.done) return state;
  const q = state.questions[state.index]!;
  // Key names as flowtty's decoder produces them: Enter is 'return' and the space
  // bar is ' ' — there is no 'enter' and no 'space'. (This file first matched on
  // 'space', with a test helper that invented the same name, so Space toggled
  // nothing in a real terminal.)
  const name = key.name ?? '';
  const enter = name === 'return';
  const otherRow = q.options.length;

  // While typing, the field is the chat's own field: flowtty's `editorReducer`, in its
  // single-line mode. So the caret moves by character and by word, Home/End and the
  // kill bindings work, and a PASTE goes in at the caret — it arrives as one key
  // (`{ name: 'paste', text }`); dropping it whole instead would make a pasted path
  // impossible to give as an answer. Every printable key is text here: `y`, `n` and
  // the digits are not shortcuts while the person is writing.
  if (state.typing) {
    // Esc leaves the field for the list; on the list it dismisses the question. The
    // reducer would answer `cancel` — the closest thing first is this file's rule.
    if (name === 'escape') return { ...state, typing: false };
    const k = name === 'paste' ? { ...key, text: onePasteLine(key.text ?? '') } : key;
    const act = editorReducer({ value: state.text, cursor: state.caret }, k as Parameters<typeof editorReducer>[1], { multiline: false, width });
    if (act.kind === 'submit') {
      const other = state.text.trim();
      if (!other) return state; // an empty answer is not an answer
      return answer(state, q.multiSelect ? state.picked.map((i) => q.options[i]!.label) : [], other);
    }
    if (act.kind === 'edit') return { ...state, text: act.state.value, caret: act.state.cursor };
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
    if (i === otherRow) return startTyping(state, otherRow, '');
    return q.multiSelect ? toggle(i) : answer(state, [q.options[i]!.label]);
  }
  if (name === ' ' && q.multiSelect && state.cursor < otherRow) return toggle(state.cursor);
  if (enter) {
    if (state.cursor === otherRow) return startTyping(state, otherRow, '');
    if (!q.multiSelect) return answer(state, [q.options[state.cursor]!.label]);
    if (!state.picked.length) return state; // nothing picked is not an answer
    return answer(state, state.picked.map((i) => q.options[i]!.label));
  }
  // TYPING starts the answer, as it does in every other field in the app: the
  // character opens the free-text field with itself already in it. Walking to the
  // "Other…" row first was a step nobody guessed at. What does NOT start it: a digit
  // (1–9 are the shortcuts the list advertises — a numeric answer is typed once the
  // field is open) and the space bar (it toggles in a multi-select, and an answer
  // that begins with a space is nobody's intent). Both branches above come first, so
  // neither is stolen from.
  if (name === 'paste') {
    const pasted = onePasteLine(key.text ?? '').trim();
    return pasted ? startTyping(state, otherRow, pasted) : state;
  }
  if (isPrintable({ ...key, name } as never) && !/[0-9 ]/.test(name)) return startTyping(state, otherRow, name);
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
