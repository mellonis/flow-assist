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
// With several questions the call is a WIZARD: one page per question, one page
// fronting the answer (the submit page), and one submit at the end. Each page keeps
// a draft of its own that survives going to another page and coming back, so a
// walk through the questions loses nothing. A single question answers in its own
// keys, with no submit page.
//
// Answering by TYPING starts that free-text field, and the field itself is flowtty's
// editor — the same one the chat's own field is (see chat-spec.md, "The field's EDITING
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

// One page's working state, kept for the whole call: the wizard moves between pages
// and a draft goes on being edited wherever its person left it.
export interface AskDraft {
  cursor: number; // row under the cursor; the last row is "Other…"
  picked: number[]; // multi-select: option indices toggled on; what a single-select picked
  typing: boolean; // the "Other…" free-text field is open
  text: string;
  // The caret in `text`: a UTF-16 index resting on a grapheme-cluster boundary,
  // flowtty's unit (`text.slice(0, caret)` is what is before it). Not to be confused
  // with `cursor`, which is the ROW under the cursor in the list above.
  caret: number;
}

export interface AskState {
  questions: AskQuestion[];
  index: number; // the page on screen; with several questions, the page after the last is the submit page
  drafts: AskDraft[]; // one per question
  // What `askResult`/`askShown` read back: written when a page commits its answer,
  // rebuilt for every question (an empty one included) when the submit page answers.
  answers: AskAnswer[];
  done: boolean;
  cancelled: boolean;
}

// A question with no options is a free-text question: its field is open from the start, so
// every printable key (digits and spaces too) is text, and Esc dismisses it.
const freeText = (q: AskQuestion | undefined): boolean => !!q && q.options.length === 0;

const draftOf = (q: AskQuestion): AskDraft => ({ cursor: 0, picked: [], typing: freeText(q), text: '', caret: 0 });

export const askStart = (questions: AskQuestion[]): AskState =>
  ({ questions, index: 0, drafts: questions.map(draftOf), answers: [], done: false, cancelled: false });

// How many pages the wizard has: one per question, and — only when there is more than
// one question — the submit page after them. A single question answers in one key and
// has no submit page to reach.
export const askPageCount = (s: AskState): number => (s.questions.length > 1 ? s.questions.length + 1 : s.questions.length);

// The summing-up of one question's draft, in the words the model reads.
const entryOf = (q: AskQuestion, d: AskDraft): AskAnswer => {
  const labels = d.picked.map((i) => q.options[i]!.label);
  const other = d.text.trim();
  return { question: q.question, labels, ...(other ? { other } : {}) };
};

// Whether a draft holds an answer of its own — a pick or text. An empty draft is a
// question not answered.
const taken = (d: AskDraft): boolean => d.picked.length > 0 || !!d.text.trim();

const titled = (q: AskQuestion): string => (q.header ? `${q.header} — ${q.question}` : q.question);

// One entry as the person is shown it and the model reads it: the picks and the text,
// and the words for a question answered with nothing.
const worded = (a: AskAnswer): string => [...a.labels, ...(a.other ? [a.other] : [])].join(', ') || '(not answered)';

export interface AskTab { label: string; answered: boolean; current: boolean }
// The wizard's page strip (several questions only): one tab per question and "Submit"
// last. A question is `answered` while its draft holds a pick or text — the same
// reading of the draft the submit page makes.
export function askTabs(state: AskState): AskTab[] {
  const n = state.questions.length;
  if (n <= 1) return [];
  return [
    ...state.questions.map((q, i) => ({ label: q.header ?? `question ${i + 1}`, answered: taken(state.drafts[i]!), current: state.index === i })),
    { label: 'Submit', answered: false, current: state.index === n },
  ];
}

export interface AskSubmitRow { title: string; answer: string; answered: boolean }
// The submit page: every question and where its draft stands now, so the person reads
// what their Enter will send before pressing it. `answered` is the same reading of the
// draft the strip makes — said by the draft, never inferred from the answer's words.
export function askSubmitRows(state: AskState): AskSubmitRow[] {
  return state.questions.map((q, i) => {
    const d = state.drafts[i]!;
    return { title: titled(q), answer: worded(entryOf(q, d)), answered: taken(d) };
  });
}

export interface AskRow { label: string; description?: string; picked: boolean; active: boolean; other: boolean }
export function askRows(state: AskState): AskRow[] {
  const q = state.questions[state.index];
  const d = state.drafts[state.index];
  if (!q || !d) return [];
  return [
    ...q.options.map((o, i) => ({ label: o.label, description: o.description, picked: d.picked.includes(i), active: d.cursor === i, other: false })),
    { label: OTHER_LABEL, picked: d.typing || !!d.text, active: d.cursor === q.options.length, other: true },
  ];
}

// The page's draft patched in place of the old one; every other page's draft is the
// same object it was.
const withDraft = (state: AskState, patch: Partial<AskDraft>): AskState => {
  const drafts = [...state.drafts];
  drafts[state.index] = { ...drafts[state.index]!, ...patch };
  return { ...state, drafts };
};

// A page commits what its draft holds and the wizard moves on: to the next question,
// past the last one to the submit page — or, for a single question, the call is
// answered then and there. The field closes behind an answer (a free-text question's
// page IS its field and stays open). An answer the page can be shown and sent is
// written into `answers`; an empty one deletes whatever the page had, so `answers`
// never holds words the draft does not — a question nobody answered stays unanswered
// and is said as such.
function commit(state: AskState, patch: Partial<AskDraft>): AskState {
  const i = state.index;
  const q = state.questions[i]!;
  const many = state.questions.length > 1;
  const d: AskDraft = { ...state.drafts[i]!, typing: freeText(q), ...patch };
  const drafts = [...state.drafts];
  drafts[i] = d;
  const answers: AskAnswer[] = [];
  state.questions.forEach((x, j) => {
    const a = (j === i ? (taken(d) ? entryOf(x, d) : undefined) : state.answers[j]);
    if (a) answers[j] = a;
  });
  return many
    ? { ...state, drafts, answers, index: Math.min(i + 1, state.questions.length) }
    : { ...state, drafts, answers, done: true };
}

// A dismissal answers nothing and is not consent to anything. What was answered
// stands — re-read from its draft, so words the person changed or erased are never
// kept as their answer — and a page that never held one reads as it always did:
// dismissed.
function dismissed(state: AskState): AskState {
  const answers: AskAnswer[] = [];
  state.questions.forEach((q, i) => {
    const d = state.drafts[i]!;
    if (state.answers[i] && taken(d)) answers[i] = entryOf(q, d);
  });
  return { ...state, answers, done: true, cancelled: true };
}

// Picking a row answers the question in its own words and replaces whatever the
// field held: one pick in a single-select, and the pick stands as the answer.
const commitPick = (state: AskState, i: number): AskState =>
  commit(state, { cursor: i, picked: [i], text: '', caret: 0 });

// The field's answer as it stands; in a multi-select the picks ride along with the
// text, in a single-select the person's own words stand alone.
const commitTyped = (state: AskState, multiSelect: boolean): AskState =>
  commit(state, multiSelect ? {} : { picked: [] });

// A key as the chat hands it over — flowtty's, with a paste's text on it.
export type AskKey = { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; text?: string };

// The field is ONE line, so a pasted line break is a space: a path or a ticket's text
// pasted from anywhere else still goes in whole, and nothing in it can submit.
const onePasteLine = (text: string) => String(text ?? '').replace(/\s*\n\s*/g, ' ');

// The field's own key handling — flowtty's `editorReducer`, in its single-line mode.
// So the caret moves by character and by word, Home/End and the kill bindings work,
// and a PASTE goes in at the caret — it arrives as one key (`{ name: 'paste', text }`);
// dropping it whole instead would make a pasted path impossible to give as an answer.
// Every printable key is text here: `y`, `n` and the digits are not shortcuts while
// the person is writing.
function fieldKey(state: AskState, key: AskKey, width: number): AskState {
  const q = state.questions[state.index]!;
  const d = state.drafts[state.index]!;
  const many = state.questions.length > 1;
  // Esc leaves the field for the list; a free-text question has no list, so there it
  // dismisses the question (the whole call, as on any other page). The reducer would
  // answer `cancel` — the closest thing first is this file's rule.
  if (key.name === 'escape') return freeText(q) ? dismissed(state) : withDraft(state, { typing: false });
  const k = key.name === 'paste' ? { ...key, text: onePasteLine(key.text ?? '') } : key;
  const act = editorReducer({ value: d.text, cursor: d.caret }, k as Parameters<typeof editorReducer>[1], { multiline: false, width });
  if (act.kind === 'submit') {
    const other = d.text.trim();
    // An empty answer is not an answer: a single question waits for something to send.
    // A wizard's page is just left behind — Enter moves on to the next page.
    if (!other) return many ? commit(state, {}) : state;
    return commitTyped(state, !!q.multiSelect);
  }
  if (act.kind === 'edit') return withDraft(state, { text: act.state.value, caret: act.state.cursor });
  return state;
}

export function askKey(state: AskState, key: AskKey, width = 60): AskState {
  if (state.done) return state;
  // Key names as flowtty's decoder produces them: Enter is 'return' and the space
  // bar is ' ' — there is no 'enter' and no 'space'.
  const name = key.name ?? '';
  const enter = name === 'return';

  // The submit page (several questions only): Enter answers the whole call from the
  // drafts as they stand, Esc dismisses it, `left` goes back to the questions.
  if (state.index >= state.questions.length) {
    if (enter) {
      const answers = state.questions.map((q, i) => entryOf(q, state.drafts[i]!));
      return { ...state, answers, done: true };
    }
    if (name === 'escape') return dismissed(state);
    if (name === 'left') return { ...state, index: Math.max(0, state.index - 1) };
    return state;
  }

  const q = state.questions[state.index]!;
  const d = state.drafts[state.index]!;
  const many = state.questions.length > 1;
  const otherRow = q.options.length;

  if (d.typing) return fieldKey(state, key, width);

  if (name === 'escape') return dismissed(state);
  if (name === 'up') return withDraft(state, { cursor: Math.max(0, d.cursor - 1) });
  if (name === 'down') return withDraft(state, { cursor: Math.min(otherRow, d.cursor + 1) });
  // `left`/`right` walk the pages (a wizard's pages clamp at both ends — no wrap); a
  // single question has one page and they do nothing. Inside the field they are the
  // caret's keys (above).
  if (name === 'left') return many ? { ...state, index: Math.max(0, state.index - 1) } : state;
  if (name === 'right') return many ? { ...state, index: Math.min(state.questions.length, state.index + 1) } : state;

  const toggle = (i: number): AskState =>
    withDraft(state, { cursor: i, picked: d.picked.includes(i) ? d.picked.filter((x) => x !== i) : [...d.picked, i].sort((a, b) => a - b) });

  // The field opens on the draft as it stands — text and caret kept, so a walk away
  // and back never costs the person their words. With an empty draft this is the
  // field opening on the key that opened it (below).
  const openField = (st: AskState): AskState => withDraft(st, { typing: true, cursor: otherRow });

  if (/^[1-9]$/.test(name)) {
    const i = Number(name) - 1;
    if (i > otherRow) return state; // a digit beyond the list answers nothing
    if (i === otherRow) return openField(state);
    return q.multiSelect ? toggle(i) : commitPick(state, i);
  }
  if (name === ' ' && q.multiSelect && d.cursor < otherRow) return toggle(d.cursor);
  if (enter) {
    if (d.cursor === otherRow) return openField(state);
    if (!q.multiSelect) return commitPick(state, d.cursor);
    // Nothing picked is not an answer on a single page. A wizard's page with nothing
    // in it is left behind — how the person reaches the questions they did answer.
    if (!d.picked.length && !many) return state;
    return commit(state, {});
  }
  // TYPING starts the answer, as it does in every other field in the app: the
  // character opens the free-text field with itself already in it. Walking to the
  // "Other…" row first is a step nobody guesses at. On a page whose draft already
  // holds text the key goes in AT the caret — the draft is never overwritten. What
  // does NOT start it: a digit (1–9 are the shortcuts the list advertises — a numeric
  // answer is typed once the field is open) and the space bar (it toggles in a
  // multi-select, and an answer that begins with a space is nobody's intent). Both
  // branches above come first, so neither is stolen from.
  if (name === 'paste') {
    const pasted = onePasteLine(key.text ?? '').trim();
    if (!pasted) return state;
    return d.text === ''
      ? withDraft(state, { typing: true, cursor: otherRow, text: pasted, caret: pasted.length })
      : fieldKey(openField(state), key, width);
  }
  if (isPrintable({ ...key, name } as never) && !/[0-9 ]/.test(name)) {
    return d.text === ''
      ? withDraft(state, { typing: true, cursor: otherRow, text: name, caret: name.length })
      : fieldKey(openField(state), key, width);
  }
  return state;
}

// What the model reads back. A dismissal is spelled out as one: it is not consent,
// and the model must not quietly fill in the answer it wanted. An answer with nothing
// in it is said as one too — never left to look like a broken line.
export function askResult(state: AskState): string {
  if (state.cancelled) {
    return 'The user dismissed the question without answering. Do not assume an answer: either proceed without it and say which assumption you made, or stop and explain what you need.';
  }
  const lines = state.questions.map((q, i) => {
    const a = state.answers[i] ?? { question: q.question, labels: [] };
    const parts = [...a.labels, ...(a.other ? [`(their own words) ${a.other}`] : [])];
    return `- ${q.question} → ${parts.length ? parts.join(', ') : 'no answer given'}`;
  });
  return `The user answered:\n${lines.join('\n')}`;
}

// What the chat KEEPS of a question once it is answered: the title the block was shown
// under and the answer as the person gave it, one entry per question. The model already
// has the answer as the tool's result, so this is display only — it is what stops the
// question vanishing the moment it is answered. A question the person never answered
// reads as dismissed (they walked out of the call) or as not answered (they sent the
// call in with nothing on that page).
export interface AskShown { title: string; answer: string; dismissed?: boolean }
export function askShown(state: AskState): AskShown[] {
  return state.questions.map((q, i) => {
    const title = titled(q);
    const a = state.answers[i];
    if (!a) return { title, answer: 'dismissed', dismissed: true };
    return { title, answer: worded(a) };
  });
}
