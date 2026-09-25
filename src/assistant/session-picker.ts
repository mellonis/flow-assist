// The session picker (`/sessions`, the assistant's `sessions` key): every saved session,
// newest first, filtered as the person types. A pure state machine, as ./ask.ts is: the
// chat owns the disk and the pause, this file only what a key does to what is shown and
// which action the chat must carry out. The two one-line fields — the filter and a new
// name — are flowtty's `editorReducer`, the chat's own field, so caret motion, the kill
// bindings and paste behave as they do there.
import { editorReducer } from '@flowtty/core';
import { keyGlyph } from '../playback/keys.js';
import type { SessionRow } from './sessions.js';

export type PickerKey = { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; text?: string };
export type PickerMode = 'list' | 'rename' | 'delete';
export interface PickerState {
  rows: SessionRow[];    // as `sessionRows` read them, newest first
  filter: string;
  caret: number;         // in `filter`, a UTF-16 index (flowtty's unit)
  cursor: number;        // an index into `pickerMatches(state)`
  mode: PickerMode;
  name: string;          // the rename field
  nameCaret: number;
  notice: string;        // one line: why a key did nothing, or what was just done
}
export type PickerAction =
  | { kind: 'close' }
  | { kind: 'open'; id: string }
  | { kind: 'new' }
  | { kind: 'rename'; id: string; title: string }
  | { kind: 'delete'; id: string };
export interface PickerStep { state: PickerState; action?: PickerAction }

export const pickerStart = (rows: SessionRow[]): PickerState =>
  ({ rows, filter: '', caret: 0, cursor: 0, mode: 'list', name: '', nameCaret: 0, notice: '' });

// Every word of the filter, case-blind, in the title or the conversation's text.
export function sessionMatches(row: SessionRow, filter: string): boolean {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${row.title.toLowerCase()}\n${row.text}`;
  return words.every((w) => hay.includes(w));
}
export const pickerMatches = (state: PickerState): SessionRow[] => state.rows.filter((r) => sessionMatches(r, state.filter));
export const pickerSelected = (state: PickerState): SessionRow | undefined => pickerMatches(state)[state.cursor];

// A list read again (after a rename or a delete) keeps the filter, and the cursor where
// it still can be.
export function pickerReload(state: PickerState, rows: SessionRow[], notice = ''): PickerState {
  const next: PickerState = { ...state, rows, mode: 'list', notice };
  return { ...next, cursor: Math.min(state.cursor, Math.max(0, pickerMatches(next).length - 1)) };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const label = (r: SessionRow) => r.title || r.id;
const held = (r: SessionRow, what: string) => `"${label(r)}" is open in another flow-assist process — it cannot be ${what}`;
const NEW_CAP = keyGlyph({ name: 'n', ctrl: true });
type EditorKey = Parameters<typeof editorReducer>[1];
// A paste into a one-line field goes in on one line.
const oneLine = (key: PickerKey): PickerKey => (key.name === 'paste' ? { ...key, text: (key.text ?? '').replace(/\s+/g, ' ') } : key);

export function pickerKey(state: PickerState, key: PickerKey, width = 60): PickerStep {
  const name = key.name ?? '';
  const row = pickerSelected(state);

  if (state.mode === 'delete') {
    if (name === 'y' && row) return { state: { ...state, mode: 'list', notice: '' }, action: { kind: 'delete', id: row.id } };
    if (name === 'n' || name === 'escape' || !row) return { state: { ...state, mode: 'list', notice: '' } };
    return { state };
  }

  if (state.mode === 'rename') {
    if (name === 'escape' || !row) return { state: { ...state, mode: 'list' } };
    const act = editorReducer({ value: state.name, cursor: state.nameCaret }, oneLine(key) as EditorKey, { multiline: false, width });
    if (act.kind === 'submit') {
      const title = state.name.trim();
      if (!title) return { state };
      return { state: { ...state, mode: 'list', notice: '' }, action: { kind: 'rename', id: row.id, title } };
    }
    if (act.kind === 'edit') return { state: { ...state, name: act.state.value, nameCaret: act.state.cursor } };
    return { state };
  }

  const shown = pickerMatches(state).length;
  if (name === 'up') return { state: { ...state, cursor: Math.max(0, state.cursor - 1), notice: '' } };
  if (name === 'down') return { state: { ...state, cursor: Math.min(Math.max(0, shown - 1), state.cursor + 1), notice: '' } };
  if (name === 'escape') {
    return state.filter ? { state: { ...state, filter: '', caret: 0, cursor: 0, notice: '' } } : { state, action: { kind: 'close' } };
  }
  if (name === 'return') {
    if (!row) return { state };
    if (row.lock === 'held') return { state: { ...state, notice: held(row, 'opened here') } };
    if (row.lock === 'ours') return { state, action: { kind: 'close' } }; // already this chat's
    return { state, action: { kind: 'open', id: row.id } };
  }
  if (key.ctrl && name === 'n') return { state, action: { kind: 'new' } };
  if (key.ctrl && name === 'r') {
    if (!row) return { state };
    if (row.lock === 'held') return { state: { ...state, notice: held(row, 'renamed here') } };
    return { state: { ...state, mode: 'rename', name: row.title, nameCaret: row.title.length, notice: '' } };
  }
  if (key.ctrl && name === 'x') {
    if (!row) return { state };
    if (row.lock === 'held') return { state: { ...state, notice: held(row, 'deleted') } };
    if (row.lock === 'ours') return { state: { ...state, notice: `"${label(row)}" is the session in this chat — open another one or start a new one (${NEW_CAP}) first` } };
    return { state: { ...state, mode: 'delete', notice: '' } };
  }
  const act = editorReducer({ value: state.filter, cursor: state.caret }, oneLine(key) as EditorKey, { multiline: false, width });
  if (act.kind === 'edit') return { state: { ...state, filter: act.state.value, caret: act.state.cursor, cursor: 0, notice: '' } };
  return { state };
}
