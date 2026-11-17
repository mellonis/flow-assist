import { expect, test } from 'bun:test';
import { lineTab, lineView, type TabWalk } from '../commandline';
import { BASE_COMMANDS, completeCommand } from '../commands';

const complete = (text: string) => completeCommand(text, BASE_COMMANDS, {});

test('the line view keeps a caret and ghosts only at the end', () => {
  // The caret is the line's own index, and the offer is drawn after the line only
  // while the caret is at its end: mid-line the rest of a suggestion would land on
  // the wrong side of the caret.
  expect(lineView('config set', 6, null, complete)).toMatchObject({ caret: 6, ghost: '' });
  expect(lineView('config set', 10, null, complete)).toMatchObject({ caret: 10, ghost: '' });
  // A command with something left to offer: the rest at the end, none mid-line.
  expect(lineView('config se', 8, null, complete).ghost).toBe('');
  expect(lineView('config se', 9, null, complete)).toMatchObject({ caret: 9, ghost: 't' });
});

test('the untyped rest of the best match is offered after the caret', () => {
  const v = lineView('he', 2, null, complete);
  expect(`he${v.ghost}`).toBe('help');
  // Nothing typed → nothing offered: the full command list is noise.
  expect(lineView('', 0, null, complete)).toEqual({ caret: 0, ghost: '', label: '', others: [] });
  // A whole command has nothing left to offer.
  expect(lineView('help', 4, null, complete).ghost).toBe('');
});

test('Tab takes the offer, then walks the other candidates and comes back round', () => {
  const start = 'c';
  const all = complete(start).candidates;
  expect(all.length).toBeGreaterThan(1);
  let input = start;
  let walk: TabWalk | null = null;
  const seen: string[] = [];
  for (let i = 0; i < all.length + 1; i++) {
    ({ input, walk } = lineTab(input, walk, complete));
    seen.push(input);
  }
  // Every candidate once, in order, then the first again.
  expect(new Set(seen.slice(0, all.length))).toEqual(new Set(all));
  expect(seen[all.length]).toBe(seen[0]!);
  // While walking the line holds a whole candidate: no ghost, the OTHERS are named.
  const v = lineView(input, input.length, walk, complete);
  expect(v.ghost).toBe('');
  expect(v.others).not.toContain(input);
  expect(v.others.length).toBe(all.length - 1);
});

test('typing anything ends the walk', () => {
  const first = lineTab('c', null, complete);
  const typed = `${first.input}x`;
  // The stale walk no longer applies: the view is computed from the line as it is.
  expect(lineView(typed, typed.length, first.walk, complete)).toEqual(lineView(typed, typed.length, null, complete));
});

test('Tab replaces the WORD being completed, not everything before the first space', () => {
  // Completing the whole line instead of just the word would give `config ge` + Tab → `get ge`.
  expect(lineTab('config ge', null, complete).input).toBe('config get');
  expect(lineView('config ge', 9, null, complete).ghost).toBe('t');
  // A config key is completed in place too.
  const key = lineTab('config get ai.mod', null, (t) => completeCommand(t, BASE_COMMANDS, { ai: { model: 'x' } }));
  expect(key.input).toBe('config get ai.model');
});

test('Tab with nothing to offer changes nothing', () => {
  expect(lineTab('zzzz', null, complete)).toEqual({ input: 'zzzz', walk: null });
  expect(lineTab('', null, complete)).toEqual({ input: '', walk: null });
});

test('a labelled candidate is said beside the field, and the others carry their labels', () => {
  const labelled = (text: string) => {
    const head = text.replace(/^open ?/, '');
    const all = ['1', '2', '3'].filter((c) => c.startsWith(head));
    return { head, hasSpace: true, best: all.find((c) => c !== head) ?? all[0] ?? '', candidates: all, labels: { '1': 'first', '2': 'second' } };
  };
  expect(lineView('open ', 5, null, labelled)).toEqual({ caret: 5, ghost: '1', label: 'first', others: ['2 second', '3'] });
  // Typed by hand, the whole word still says what it names.
  expect(lineView('open 2', 6, null, labelled)).toMatchObject({ ghost: '', label: 'second' });
  // Walking: the label follows the candidate the line holds.
  const first = lineTab('open ', null, labelled);
  const second = lineTab(first.input, first.walk, labelled);
  expect(second.input).toBe('open 2');
  expect(lineView(second.input, second.input.length, second.walk, labelled)).toEqual({ caret: 6, ghost: '', label: 'second', others: ['1 first', '3'] });
  // No labels: the view says nothing beside the field.
  expect(lineView('he', 2, null, complete).label).toBe('');
});

test('a walk over a single candidate completes anew: Tab after a unique directory walks into it', () => {
  // A completer over a small tree: `a` → `a/`, then `a/` → `a/b/`.
  const tree = (text: string) => {
    const word = text.split(' ').at(-1)!;
    const all = word.startsWith('a/') ? ['a/b/'] : ['a/'].filter((c) => c.startsWith(word));
    return { head: word, hasSpace: true, best: all[0] ?? '', candidates: all };
  };
  const first = lineTab('cd a', null, tree);
  expect(first.input).toBe('cd a/');
  expect(lineTab(first.input, first.walk, tree).input).toBe('cd a/b/');
});

// ─── The list ────────────────────────────────────────────────────────────────
import { LIST_ROWS, lineViewWithList, listKey, newListState, openList } from '../commandline';
import type { CompleteResult } from '../commands';

const names = (n: number) => Array.from({ length: n }, (_, i) => `item${String(i).padStart(2, '0')}`);
const many = (count: number) => (text: string): CompleteResult => {
  const head = text.split(' ').at(-1)!;
  const candidates = names(count).filter((c) => c.startsWith(head));
  return { head, hasSpace: true, best: candidates.find((c) => c !== head) ?? candidates[0] ?? '', candidates, details: { item01: 'the second' } };
};

test('the list opens at two candidates and not at one or none', () => {
  const c = many(12);
  expect(openList('x item0', newListState(), c)?.total).toBe(10);
  expect(openList('x item1', newListState(), c)?.total).toBe(2);
  expect(openList('x item11', newListState(), c)).toBeNull();
  expect(openList('x zzz', newListState(), c)).toBeNull();
  // An empty line offers nothing.
  expect(openList('', newListState(), c)).toBeNull();
});

test('up and down move the selection and wrap; the inline rest follows it', () => {
  const c = many(3);
  const st = newListState();
  expect(openList('x item', st, c)).toMatchObject({ selected: 'item00', ghost: '00', number: 1 });
  expect(listKey('x item', st, { name: 'down' }, c)).toEqual({ handled: true });
  expect(openList('x item', st, c)).toMatchObject({ selected: 'item01', ghost: '01', at: 1 });
  listKey('x item', st, { name: 'up' }, c);
  listKey('x item', st, { name: 'up' }, c);
  expect(openList('x item', st, c)?.selected).toBe('item02');
  listKey('x item', st, { name: 'down' }, c);
  expect(openList('x item', st, c)?.selected).toBe('item00');
  // Shift+Tab moves up, like the up arrow.
  listKey('x item', st, { name: 'tab', shift: true }, c);
  expect(openList('x item', st, c)?.selected).toBe('item02');
});

test('Tab takes the selected candidate; Enter does only once an arrow moved the selection', () => {
  const c = many(3);
  // Untouched, Tab takes the best match and Enter is the line's own.
  expect(listKey('x item', newListState(), { name: 'tab' }, c)).toEqual({ handled: true, input: 'x item00' });
  expect(listKey('x item', newListState(), { name: 'return' }, c)).toEqual({ handled: false });
  // Moved, both take it.
  for (const name of ['tab', 'return']) {
    const st = newListState();
    listKey('x item', st, { name: 'down' }, c);
    expect(listKey('x item', st, { name }, c)).toEqual({ handled: true, input: 'x item01' });
  }
  // A changed line forgets the move.
  const st = newListState();
  listKey('x item', st, { name: 'down' }, c);
  openList('x item0', st, c);
  expect(listKey('x item0', st, { name: 'return' }, c)).toEqual({ handled: false });
});

test('taking the candidate the line already holds closes the list instead', () => {
  const c = (text: string): CompleteResult => ({ head: text, hasSpace: true, best: 'ab', candidates: ['a', 'ab'] });
  const st = newListState();
  // `ab` is the best match; ↓ wraps to `a`, the line itself.
  expect(openList('a', st, c)).toMatchObject({ selected: 'ab' });
  listKey('a', st, { name: 'down' }, c);
  expect(openList('a', st, c)).toMatchObject({ selected: 'a', ghost: '' });
  expect(listKey('a', st, { name: 'return' }, c)).toEqual({ handled: true });
  // Closed: the next Enter is the line's own.
  expect(listKey('a', st, { name: 'return' }, c)).toEqual({ handled: false });
});

test('Esc closes the list until the text changes', () => {
  const c = many(3);
  const st = newListState();
  expect(listKey('x item', st, { name: 'escape' }, c)).toEqual({ handled: true });
  expect(openList('x item', st, c)).toBeNull();
  expect(listKey('x item', st, { name: 'down' }, c)).toEqual({ handled: false });
  expect(listKey('x item', st, { name: 'escape' }, c)).toEqual({ handled: false });
  expect(openList('x item0', st, c)).not.toBeNull();
});

test('keys that are not the list\'s are not handled, with a list open', () => {
  const st = newListState();
  expect(listKey('x item', st, { name: 'left' }, many(3))).toEqual({ handled: false });
});

test('more candidates than rows scroll around the selection and say where it is', () => {
  const c = many(41);
  const st = newListState();
  const first = openList('x item', st, c)!;
  expect(first.rows).toHaveLength(LIST_ROWS);
  expect(first.count).toBe('1/41');
  expect(first.rows[0]!.value).toBe('item00');
  for (let i = 0; i < 20; i++) listKey('x item', st, { name: 'down' }, c);
  const mid = openList('x item', st, c)!;
  expect(mid.count).toBe('21/41');
  expect(mid.rows[mid.at]!.value).toBe('item20');
  expect(mid.rows).toHaveLength(LIST_ROWS);
  // Up from the first wraps to the last, which stays in view.
  const wrap = newListState();
  listKey('x item', wrap, { name: 'up' }, c);
  const last = openList('x item', wrap, c)!;
  expect(last.rows.at(-1)!.value).toBe('item40');
  expect(last.count).toBe('41/41');
  // No count with every candidate in view.
  expect(openList('x item', newListState(), many(5))!.count).toBe('');
});

test('the list keeps its height while it is open and narrowing, and forgets it when it closes', () => {
  const c = many(12);
  const st = newListState();
  expect(openList('x item', st, c)!.height).toBe(LIST_ROWS + 1);
  // Two candidates left: the list still takes its nine lines.
  expect(openList('x item1', st, c)!.height).toBe(LIST_ROWS + 1);
  expect(openList('x item11', st, c)).toBeNull();
  expect(st.height).toBe(0);
  expect(openList('x item1', st, c)!.height).toBe(2);
});

test('a row carries its detail, or its label when it has no detail', () => {
  const c = (text: string): CompleteResult => ({ head: text, hasSpace: true, best: 'a', candidates: ['a', 'b', 'c'], details: { a: 'detail a' }, labels: { b: 'label b' } });
  expect(openList('x', newListState(), c)!.rows).toEqual([
    { value: 'a', detail: 'detail a' }, { value: 'b', detail: 'label b' }, { value: 'c', detail: '' },
  ]);
});

test('with a list open the line is drawn with the selected rest and the label, no `others`', () => {
  const c = (text: string): CompleteResult => ({ head: text, hasSpace: true, best: 'ab', candidates: ['ab', 'ac'], labels: { ab: 'first', ac: 'second' } });
  const st = newListState();
  listKey('a', st, { name: 'down' }, c);
  const { view, list } = lineViewWithList('a', 1, null, st, c);
  expect(view).toEqual({ caret: 1, ghost: 'c', label: 'second', others: [] });
  expect(list?.selected).toBe('ac');
  // With one candidate it is the inline view.
  const one = lineViewWithList('help', 4, null, newListState(), (t) => completeCommand(t, BASE_COMMANDS, {}));
  expect(one.list).toBeNull();
});

test('the list and its ghost hold only while the caret is at the end of the line', () => {
  // `c` has four candidates; the list belongs to the line's LAST word, so a caret
  // moved into the middle of the line takes it away — the rows, the ⏎/Tab take and
  // the inline rest would all target the wrong word there.
  const st = newListState();
  expect(openList('c', st, complete)?.total).toBe(4);
  const mid = lineViewWithList('c', 0, null, st, complete);
  expect(mid.list).toBeNull();
  expect(mid.view).toMatchObject({ caret: 0, ghost: '' });
  // Back at the end it is the same list again.
  expect(lineViewWithList('c', 1, null, st, complete).list?.selected).toBe('cache');
});

test('a recalled line offers no list', () => {
  const two = (text: string): CompleteResult => ({ head: text, hasSpace: true, best: 'item00', candidates: ['item00', 'item01'] });
  const st = newListState();
  // ↑ recalled the line from history: the mark rides beside the list's state, so the
  // line offers nothing — neither the rows nor the inline rest.
  st.fromHistory = true;
  const recalled = lineViewWithList('item0', 5, null, st, two);
  expect(recalled.list).toBeNull();
  expect(recalled.view).toEqual({ caret: 5, ghost: '', label: '', others: [] });
  // Every list key is the line's own then: ↑ walks the history again.
  expect(listKey('item0', st, { name: 'down' }, two)).toEqual({ handled: false });
  // The next content edit (`editorReducer` `edit` from typing or a paste) brings them
  // back: the field clears the mark as it takes the edited text.
  st.fromHistory = false;
  const edited = lineViewWithList('item0', 5, null, st, two);
  expect(edited.list?.total).toBe(2);
  expect(edited.view.ghost).toBe('0');
});

test('a draw or a key runs the completer once for the line', () => {
  let calls = 0;
  const counted = (text: string): CompleteResult => { calls++; return many(1)(text); };
  lineViewWithList('x item0', 7, null, newListState(), counted);
  expect(calls).toBe(1);
  calls = 0;
  const two = (text: string): CompleteResult => { calls++; return many(3)(text); };
  const st = newListState();
  listKey('x item', st, { name: 'down' }, two);
  listKey('x item', st, { name: 'tab' }, two);
  expect(calls).toBe(2);
});
