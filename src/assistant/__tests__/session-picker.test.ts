import { expect, test } from 'bun:test';
import { formatBytes, pickerKey, pickerMatches, pickerReload, pickerSelected, pickerStart, type PickerAction, type PickerKey, type PickerState } from '../session-picker.ts';
import type { SessionRow } from '../sessions.ts';

const row = (over: Partial<SessionRow>): SessionRow => ({ id: 'x', title: 't', updatedAt: '2026-09-25T10:00:00.000Z', turns: 1, bytes: 10, lock: 'free', text: '', ...over });
const ROWS = [
  row({ id: 'a', title: 'Current chat', lock: 'ours' }),
  row({ id: 'b', title: 'Held one', lock: 'held', text: 'zebrafish in the pond' }),
  row({ id: 'c', title: 'Idle one', text: 'nothing special' }),
];
// Keys in order; each a terminal name, or a whole key for a chord.
function press(state: PickerState, ...keys: (string | PickerKey)[]): { state: PickerState; actions: PickerAction[] } {
  let s = state;
  const actions: PickerAction[] = [];
  for (const k of keys) {
    const step = pickerKey(s, typeof k === 'string' ? { name: k } : k);
    s = step.state;
    if (step.action) actions.push(step.action);
  }
  return { state: s, actions };
}
const ctrl = (name: string): PickerKey => ({ name, ctrl: true });

test('typing filters by every word, in the title or the conversation, case-blind', () => {
  const { state } = press(pickerStart(ROWS), 'Z', 'e', 'b', 'r', 'a');
  expect(state.filter).toBe('Zebra');
  expect(pickerMatches(state).map((r) => r.id)).toEqual(['b']);
  expect(pickerMatches({ ...state, filter: 'idle special' }).map((r) => r.id)).toEqual(['c']);
  expect(pickerMatches({ ...state, filter: 'idle zebra' })).toEqual([]);
  expect(press(state, 'backspace').state.filter).toBe('Zebr');
});

test('the cursor stays inside what is shown, and a change of filter puts it back on top', () => {
  const s = press(pickerStart(ROWS), 'down', 'down', 'down').state;
  expect(s.cursor).toBe(2);
  expect(press(s, 'up', 'up', 'up').state.cursor).toBe(0);
  expect(press(s, 'o').state.cursor).toBe(0);
});

test('Esc clears the filter first, then closes', () => {
  const typed = press(pickerStart(ROWS), 'i', 'd').state;
  const once = press(typed, 'escape');
  expect(once.state.filter).toBe('');
  expect(once.actions).toEqual([]);
  expect(press(once.state, 'escape').actions).toEqual([{ kind: 'close' }]);
});

test('⏎ opens the session under the cursor; the one in this chat just closes; a held one is refused', () => {
  expect(press(pickerStart(ROWS), 'down', 'down', 'return').actions).toEqual([{ kind: 'open', id: 'c' }]);
  expect(press(pickerStart(ROWS), 'return').actions).toEqual([{ kind: 'close' }]);
  const held = press(pickerStart(ROWS), 'down', 'return');
  expect(held.actions).toEqual([]);
  expect(held.state.notice).toBe('"Held one" is open in another flow-assist process — it cannot be opened here');
  expect(press(pickerStart([]), 'return').actions).toEqual([]);
});

test('^n asks for a new session', () => {
  expect(press(pickerStart(ROWS), ctrl('n')).actions).toEqual([{ kind: 'new' }]);
});

test('^r renames through a field that starts with the title; Esc goes back; an empty name is not a name', () => {
  const open = press(pickerStart(ROWS), 'down', 'down', ctrl('r')).state;
  expect(open.mode).toBe('rename');
  expect(open.name).toBe('Idle one');
  expect(open.nameCaret).toBe('Idle one'.length);
  expect(press(open, 'escape').state.mode).toBe('list');
  const emptied = press(open, ctrl('u')).state;
  expect(emptied.name).toBe('');
  expect(press(emptied, 'return').actions).toEqual([]);
  const named = press(emptied, 'N', 'e', 'w', 'return');
  expect(named.actions).toEqual([{ kind: 'rename', id: 'c', title: 'New' }]);
  expect(named.state.mode).toBe('list');
  expect(press(pickerStart(ROWS), ctrl('r')).state.mode).toBe('rename'); // this chat's own may be renamed
  const held = press(pickerStart(ROWS), 'down', ctrl('r')).state;
  expect(held.mode).toBe('list');
  expect(held.notice).toBe('"Held one" is open in another flow-assist process — it cannot be renamed here');
});

test('^x asks y/n before a delete — n or Esc keeps it; the held one and this chat’s own are refused', () => {
  const asked = press(pickerStart(ROWS), 'down', 'down', ctrl('x')).state;
  expect(asked.mode).toBe('delete');
  expect(press(asked, 'return').state.mode).toBe('delete'); // ⏎ is not an answer
  expect(press(asked, 'n').state.mode).toBe('list');
  expect(press(asked, 'escape').actions).toEqual([]);
  expect(press(asked, 'y').actions).toEqual([{ kind: 'delete', id: 'c' }]);
  const held = press(pickerStart(ROWS), 'down', ctrl('x')).state;
  expect(held.mode).toBe('list');
  expect(held.notice).toBe('"Held one" is open in another flow-assist process — it cannot be deleted');
  const own = press(pickerStart(ROWS), ctrl('x')).state;
  expect(own.mode).toBe('list');
  expect(own.notice).toBe('"Current chat" is the session in this chat — open another one or start a new one (^n) first');
});

test('pickerReload keeps the filter and pulls the cursor back into a shorter list', () => {
  const s = press(pickerStart(ROWS), 'down', 'down').state;
  const next = pickerReload(s, ROWS.slice(0, 2), 'Deleted «Idle one»');
  expect(next.cursor).toBe(1);
  expect(next.mode).toBe('list');
  expect(next.notice).toBe('Deleted «Idle one»');
  expect(pickerSelected(next)?.id).toBe('b');
});

test('formatBytes says a size the way a person reads it', () => {
  expect(formatBytes(812)).toBe('812 B');
  expect(formatBytes(12 * 1024 + 100)).toBe('12 KB');
  expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
});
