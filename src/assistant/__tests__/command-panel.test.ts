import { expect, test } from 'bun:test';
import { panelAnswer, panelCursor, panelDrop, panelKey, panelKeys, panelRows, panelStart, panelTop, type PanelKeyDef, type PanelRow, type PanelSpec, type PanelState } from '../command-panel';

const spec = (rows: string[], ran: string[] = []): PanelSpec => ({
  title: 'Servers',
  rows: () => rows.map((id) => ({ id, text: id })),
  keys: [
    { key: 'r', label: 'restart', run: (id) => { ran.push(`r:${id}`); return `restarting ${id}`; } },
    { key: 'escape', label: 'never', run: () => 'no' },
  ],
});

test('the cursor walks the rows as they are now; Esc closes', () => {
  const rows = ['a', 'b', 'c'];
  let s = panelStart(spec(rows));
  s = panelKey(s, { name: 'down' }).state!;
  s = panelKey(s, { name: 'down' }).state!;
  s = panelKey(s, { name: 'down' }).state!;
  expect(s.cursor).toBe(2);
  // The rows shrink under it: a key acts on the last row there is.
  rows.pop();
  const step = panelKey(s, { name: 'r' });
  expect(step.run?.id).toBe('b');
  expect(panelKey(s, { name: 'up' }).state!.cursor).toBe(0);
  expect(panelKey(s, { name: 'escape' }).state).toBeNull();
});

test('a declared key runs on the row under the cursor; the panel\'s own keys are never the plugin\'s', () => {
  const ran: string[] = [];
  const s = panelStart(spec(['a', 'b'], ran));
  expect(panelKeys(s).map((k) => k.key)).toEqual(['r']);
  const step = panelKey(s, { name: 'r' });
  expect(step.run?.def.label).toBe('restart');
  expect(step.run?.def.run(step.run.id)).toBe('restarting a');
  expect(ran).toEqual(['r:a']);
  // A chord or an undeclared key does nothing.
  expect(panelKey(s, { name: 'r', ctrl: true }).run).toBeUndefined();
  expect(panelKey(s, { name: 'x' }).run).toBeUndefined();
});

test('an answer is the notice, or a panel opened over this one that Esc goes back from', () => {
  let s = panelStart(spec(['a']));
  s = panelAnswer(s, 'done');
  expect(s.notice).toBe('done');
  const inner: PanelSpec = { title: 'Tools of a', rows: () => [{ id: 't', text: 'get_file_text' }] };
  s = panelAnswer(s, inner);
  expect(panelTop(s).title).toBe('Tools of a');
  expect(s.notice).toBe('');
  s = panelKey(s, { name: 'escape' }).state!;
  expect(panelTop(s).title).toBe('Servers');
  expect(panelAnswer(s, undefined)).toBe(s);
});

test('rows that throw are no rows, and say why', () => {
  const s = panelStart({ title: 'x', rows: () => { throw new Error('gone'); } });
  expect(panelRows(s)).toEqual({ rows: [], error: 'gone' });
  expect(panelKey(s, { name: 'down' }).state!.cursor).toBe(0);
});

test('a following panel keeps its cursor on its row when rows change above it, and at its place when the row is gone', () => {
  const rows = ['a', 'b', 'c', 'd'];
  const follow: PanelSpec = { title: 'Agents', follow: true, rows: () => rows.map((id) => ({ id, text: id })) };
  let s = panelStart(follow);
  s = panelKey(s, { name: 'down' }).state!;
  s = panelKey(s, { name: 'down' }).state!;
  expect(panelCursor(s, panelRows(s).rows)).toBe(2);
  // The first row ends: the cursor is still on c.
  rows.shift();
  expect(panelCursor(s, panelRows(s).rows)).toBe(1);
  // Its own row ends: the place it was, among the rows there are.
  rows.splice(1, 1);
  expect(panelCursor(s, panelRows(s).rows)).toBe(1);
  rows.pop();
  expect(panelCursor(s, panelRows(s).rows)).toBe(0);
});

test('without follow the cursor is an index: a row that ends above moves it onto another', () => {
  const rows = ['a', 'b', 'c'];
  let s = panelStart(spec(rows));
  s = panelKey(s, { name: 'down' }).state!;
  s = panelKey(s, { name: 'down' }).state!;
  rows.shift();
  expect(panelCursor(s, panelRows(s).rows)).toBe(1);
  expect(panelKey(s, { name: 'r' }).run?.id).toBe('c');
});

test('a key on a following panel runs on the row the cursor follows', () => {
  const rows = ['a', 'b', 'c'];
  const follow: PanelSpec = { title: 'Agents', follow: true, rows: () => rows.map((id) => ({ id, text: id })), keys: [{ key: 'x', label: 'stop', run: () => undefined }] };
  let s = panelStart(follow);
  s = panelKey(s, { name: 'down' }).state!;
  rows.shift();
  expect(panelKey(s, { name: 'x' }).run?.id).toBe('b');
});

test('a panel that does not follow records no row id on ↑/↓ or on a key', () => {
  let s = panelStart(spec(['a', 'b']));
  s = panelKey(s, { name: 'down' }).state!;
  expect(s.at).toBeUndefined();
  expect(panelKey(s, { name: 'r' }).state!.at).toBeUndefined();
});

test('onCursor runs as the cursor moves', () => {
  const seen: Array<[string, number]> = [];
  const preview: PanelSpec = {
    title: 'Theme',
    rows: () => ['system', 'light', 'dark'].map((id) => ({ id, text: id })),
    keys: [{ key: 'r', label: 'use', run: () => 'used' }],
    onCursor: (id, index) => { seen.push([id, index]); },
  };
  const s = panelStart(preview);
  const moved = panelKey(s, { name: 'down' });
  expect(seen).toEqual([['light', 1]]);
  // Up at the top is no move: nothing is said.
  expect(panelKey(s, { name: 'up' }).state!.cursor).toBe(0);
  expect(seen).toEqual([['light', 1]]);
  // A key is a decision, not a move: its run is untouched and no preview is said.
  expect(panelKey(moved.state!, { name: 'r' }).run?.def.run(null)).toBe('used');
  expect(seen).toEqual([['light', 1]]);
  panelKey(moved.state!, { name: 'up' });
  expect(seen).toEqual([['light', 1], ['system', 0]]);
});

test('the drop hook runs only when the panel goes without a decision', () => {
  const seen: string[] = [];
  const inner: PanelSpec = { title: 'inner', rows: () => [{ id: 'a', text: 'a' }], onDrop: () => { seen.push('inner'); } };
  const outer: PanelSpec = {
    title: 'outer',
    rows: () => [{ id: 'x', text: 'x' }],
    keys: [{ key: 'r', label: 'use', run: () => 'used' }],
    onDrop: () => { seen.push('outer'); },
  };
  const start = panelStart(outer);
  // A key's run is a decision: the panel closes by `run`'s own answer, not by a drop.
  expect(panelKey(start, { name: 'r' }).run).toBeDefined();
  expect(seen).toEqual([]);
  // A panel over it: Esc goes back, and that is no drop either.
  const nested = panelAnswer(start, inner);
  const back = panelKey(nested, { name: 'escape' });
  expect(back.state).not.toBeNull();
  expect(seen).toEqual([]);
  // Esc on the last one is a drop: the chat puts it away through `panelDrop`.
  const closed = panelKey(back.state!, { name: 'escape' });
  expect(closed.state).toBeNull();
  expect(seen).toEqual([]);
  expect(panelDrop(back.state!)).toBeNull();
  expect(seen).toEqual(['outer']);
  // Nothing to drop says nothing.
  expect(panelDrop(null)).toBeNull();
  expect(seen).toEqual(['outer']);
});

test('no key runs on a group header, bare or chord', () => {
  const ran: string[] = [];
  const grouped: PanelSpec = {
    title: 'Work',
    rows: () => [
      { id: 'group:agents', text: 'Agents', kind: 'group' },
      { id: 'a', text: 'agent a' },
      { id: 'group:shells', text: 'Shells', kind: 'group' },
      { id: 's', text: 'shell s' },
    ],
    keys: [
      { key: 'x', label: 'stop', run: (id) => { ran.push(`x:${id}`); } },
      { key: 'ctrl+d', label: 'kill', run: (id) => { ran.push(`kill:${id}`); } },
    ],
  };
  // The cursor opens on the first row a key can run on, and ↑ takes it onto the header.
  let s = panelStart(grouped);
  expect(s.cursor).toBe(1);
  s = panelKey(s, { name: 'up' }).state!;
  expect(s.cursor).toBe(0);
  // Neither a bare key nor a chord runs on it — nothing was handed to `run`.
  expect(panelKey(s, { name: 'x' }).run).toBeUndefined();
  expect(panelKey(s, { name: 'd', ctrl: true }).run).toBeUndefined();
  expect(ran).toEqual([]);
  // Arrow keys still move the cursor off the header and back onto a row.
  s = panelKey(s, { name: 'down' }).state!;
  expect(s.cursor).toBe(1);
  const onRow = panelKey(s, { name: 'x' });
  expect(onRow.run?.id).toBe('a');
  onRow.run!.def.run(onRow.run!.id);
  expect(ran).toEqual(['x:a']);
});

test('a panel pushed over a following one starts without the parent\'s row id', () => {
  const follow: PanelSpec = { title: 'Agents', follow: true, rows: () => [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }] };
  let s = panelStart(follow);
  s = panelKey(s, { name: 'down' }).state!;
  expect(s.at).toBe('b');
  s = panelAnswer(s, spec(['p', 'q']));
  expect(s.stack.length).toBe(2);
  expect(s.at).toBeUndefined();
  expect(panelCursor(s, panelRows(s).rows)).toBe(0);
});

// A key that changes what the rows are (a tab switch) marks itself `reset`: once its
// run has answered and no panel opened over it, the cursor is back on the first row a
// key can run on — the rule the panel opens on.
test('a key marked reset lands the cursor on the first runnable row', () => {
  const rows: PanelRow[] = [
    { id: 'group:agents', text: 'Agents', kind: 'group' },
    { id: 'a', text: 'agent a' },
    { id: 'group:shells', text: 'Shells', kind: 'group' },
    { id: 's', text: 'shell s' },
  ];
  const keys: PanelKeyDef[] = [
    { key: 'right', label: 'tabs', reset: true, run: () => undefined },
    { key: 'ctrl+d', label: 'kill', reset: true, run: () => undefined },
    { key: 'x', label: 'stop', run: () => undefined },
  ];
  const panel: PanelSpec = { title: 'Work', rows: () => rows, keys };
  // What the chat does with a key: press it, run it, lay the answer on the panel.
  const press = (state: PanelState, key: { name?: string; ctrl?: boolean; meta?: boolean }): PanelState => {
    const step = panelKey(state, key);
    const run = step.run!;
    return panelAnswer(step.state!, run.def.run(run.id), run.def.reset);
  };
  // The cursor walks off the panel's opening row, onto the shell's group header then its
  // row.
  let s = panelStart(panel);
  expect(s.cursor).toBe(1);
  s = panelKey(s, { name: 'down' }).state!;
  s = panelKey(s, { name: 'down' }).state!;
  expect(s.cursor).toBe(3);
  // The key marked reset answers without opening a panel: the cursor lands on the first
  // row a key can run on — the group header skipped.
  expect(press(s, { name: 'right' }).cursor).toBe(1);
  // A chord honours the flag the same way.
  expect(press(s, { name: 'd', ctrl: true }).cursor).toBe(1);
  // A key without the flag leaves the cursor where it was.
  expect(press(s, { name: 'x' }).cursor).toBe(3);
  // A run that opens a panel is not a reset: the panel over it starts on its own row.
  const inner = panelAnswer(s, { title: 'Tools', rows: () => [{ id: 't', text: 'tool t' }] } satisfies PanelSpec, true);
  expect(panelTop(inner).title).toBe('Tools');
  expect(inner.cursor).toBe(0);
});

