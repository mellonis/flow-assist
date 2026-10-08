import { expect, test } from 'bun:test';
import { panelAnswer, panelCursor, panelKey, panelKeys, panelRows, panelStart, panelTop, type PanelSpec } from '../command-panel';

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
