import { expect, test } from 'bun:test';
import { TOKEN_COLOR, toElement, type TRenderCtx } from '../render.ts';
import { TONE_TOKENS } from '../tree.ts';

type T = { type: string; props: Record<string, unknown>; children: unknown[] };
const h = (type: unknown, props: Record<string, unknown> = {}, ...children: unknown[]): T => ({ type: String(type), props, children });
const ui = { h, Box: 'Box', Text: 'Text', Markdown: 'Markdown', Table: 'Table', ScrollBox: 'ScrollBox', Link: 'Link' };
const ctx = (over: Partial<TRenderCtx> = {}): TRenderCtx => ({ ui, width: 80, stringWidth: (s) => s.length, focusKey: null, hasKeyboard: true, values: {}, onValue: () => {}, onPress: () => {}, ...over });

test('Text keeps its props and resolves the colour through the palette', () => {
  const el = toElement(['Text', { color: 'error', bold: true }, 'hello'], ctx()) as T;
  expect(el.type).toBe('Text');
  expect(el.props).toEqual({ color: 'red', bold: true });
  expect(el.children).toEqual(['hello']);
});

test('a literal colour is never passed through', () => {
  const el = toElement(['Text', { color: '#ff0000' }, 'x'], ctx()) as T;
  expect(el.props.color).toBe('default');
});

test('progress becomes a label and a bar sized to the width', () => {
  const el = toElement(['progress', { label: 'jobs', value: 75 }], ctx({ width: 40 })) as T;
  expect(el.type).toBe('Box');
  const line = (el.children as T[])[0]!;
  const text = (line.children as T[]).map((c) => c.children?.[0] ?? c).join('');
  expect(text).toContain('jobs');
  expect(text).toContain('75%');
  expect(text).toContain('█');
});

test('progress on a narrow pane still draws one cell of bar', () => {
  const el = toElement(['progress', { label: 'jobs', value: 50 }], ctx({ width: 12 })) as T;
  expect(JSON.stringify(el)).toContain('█');
});

test('tasks and rows render one line per item, narrow panes truncated', () => {
  const el = toElement(['tasks', { items: [{ text: 'a very long job name that will not fit', state: 'done' }] }], ctx({ width: 14 })) as T;
  expect(JSON.stringify(el)).toContain('…');
  const rows = toElement(['rows', { items: [{ label: 'branch', value: 'main' }] }], ctx()) as T;
  expect(JSON.stringify(rows)).toContain('branch');
});

test('a table adapts the vocabulary props to flowtty data and columns', () => {
  const el = toElement(['Table', { columns: [{ key: 'a', label: 'A', width: 4 }, { key: 'b', label: 'B' }], rows: [['1'], ['2', '3']], selectedIndex: 1 }], ctx()) as T;
  expect(el.type).toBe('Table');
  expect(el.props.columns).toEqual([{ accessor: 'a', header: 'A', width: 4 }, { accessor: 'b', header: 'B' }]);
  expect(el.props.data).toEqual([{ a: '1', b: '' }, { a: '2', b: '3' }]);
  expect(el.props.selectedIndex).toBe(1);
});

test('a short row fills its missing cells with an empty string', () => {
  const el = toElement(['Table', { columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }], rows: [['1']] }], ctx()) as T;
  expect(el.props.data).toEqual([{ a: '1', b: '', c: '' }]);
});

test('a border boolean becomes a flowtty border style', () => {
  const boxRound = toElement(['Box', { border: true }, ['Text', {}, 'x']], ctx()) as T;
  expect(boxRound.props.border).toBe('round');
  const boxPlain = toElement(['Box', { border: false }, ['Text', {}, 'x']], ctx()) as T;
  expect(boxPlain.props).toEqual({});
  const boxAbsent = toElement(['Box', {}, ['Text', {}, 'x']], ctx()) as T;
  expect(boxAbsent.props).toEqual({});
  const tableRound = toElement(['Table', { columns: [], rows: [], border: true }], ctx()) as T;
  expect(tableRound.props.border).toBe('round');
  const tablePlain = toElement(['Table', { columns: [], rows: [], border: false }], ctx()) as T;
  expect(tablePlain.props.border).toBe('none');
  const tableAbsent = toElement(['Table', { columns: [], rows: [] }], ctx()) as T;
  expect(tableAbsent.props.border).toBeUndefined();
});

test('wide characters are measured with the injected stringWidth', () => {
  const el = toElement(['Text', { truncate: true }, '日本語テキスト'], ctx({ width: 6, stringWidth: () => 20 })) as T;
  expect(JSON.stringify(el)).toContain('…');
});

test('truncation is opt-in: a text that does not ask for it keeps its string', () => {
  const text = 'a long line that would be cut';
  const plain = toElement(['Text', {}, text], ctx({ width: 6 })) as T;
  expect(plain.children).toEqual([text]);
  const off = toElement(['Text', { truncate: false, wrap: false }, text], ctx({ width: 6 })) as T;
  expect(off.children).toEqual([text]);
  const wrapped = toElement(['Text', { wrap: true }, text], ctx()) as T;
  expect(wrapped.props).toEqual({ wrap: 'wrap' });
  expect(wrapped.children).toEqual([text]);
});

test('a badge is one pill: its glyph, its text and its tone', () => {
  const el = toElement(['badge', { text: 'failed', tone: 'error' }], ctx()) as T;
  expect(el.type).toBe('Text');
  expect(el.props).toEqual({ color: 'red', bold: true });
  expect(el.children).toEqual(['✗ failed']);
});

test('a rule fills the pane width, and a label sits in it', () => {
  const plain = toElement(['rule'], ctx({ width: 10 })) as T;
  expect(plain.children).toEqual(['──────────']);
  const labelled = toElement(['rule', { label: 'logs' }], ctx({ width: 20 })) as T;
  expect(labelled.children).toEqual([`─ logs ${'─'.repeat(13)}`]);
});

test('a link carries its url as the target', () => {
  const el = toElement(['Link', { url: 'https://gitlab/pipelines/1' }], ctx()) as T;
  expect(el.type).toBe('Link');
  expect(el.props).toEqual({ href: 'https://gitlab/pipelines/1' });
});

test('containers recurse, and Markdown keeps its one string', () => {
  const el = toElement(['Box', { flexDirection: 'column' }, ['ScrollBox', { height: 3 }, ['Text', {}, 'a']]], ctx()) as T;
  expect(el.type).toBe('Box');
  expect(el.props).toEqual({ flexDirection: 'column' });
  const scroll = el.children[0] as T;
  expect(scroll.type).toBe('ScrollBox');
  expect(scroll.props).toEqual({ height: 3 });
  expect((scroll.children[0] as T).children).toEqual(['a']);
  const md = toElement(['Markdown', {}, '# hi'], ctx()) as T;
  expect(md.type).toBe('Markdown');
  expect(md.children).toEqual(['# hi']);
});

test('an interactive control is a dim placeholder naming it and its bind', () => {
  const input = toElement(['input', { bind: 'branch', label: 'branch', value: 'feature-x' }], ctx()) as T;
  const check = toElement(['check', { bind: 'watch', label: 'watch it', value: true }], ctx()) as T;
  const select = toElement(['select', { bind: 'env', options: [{ value: 'dev', label: 'dev' }], value: 'dev' }], ctx()) as T;
  const button = toElement(['button', { label: 'check again', action: 'check the pipeline' }], ctx()) as T;
  for (const el of [input, check, select, button]) {
    expect(el.type).toBe('Text');
    expect(el.props).toEqual({ dim: true });
  }
  expect(JSON.stringify(input)).toContain('branch');
  expect(JSON.stringify(input)).toContain('feature-x');
  expect(JSON.stringify(check)).toContain('watch');
  expect(JSON.stringify(select)).toContain('env');
  expect(JSON.stringify(button)).toContain('check again');
});

test('every palette token the vocabulary names has a colour', () => {
  expect(Object.keys(TOKEN_COLOR).sort()).toEqual([...TONE_TOKENS].sort());
});

test('a ctx palette wins over the plugin default, an unmapped token falls back', () => {
  const override = toElement(['Text', { color: 'error' }, 'x'], ctx({ colors: { error: '#ff0000' } })) as T;
  expect(override.props.color).toBe('#ff0000');
  const unmapped = toElement(['Text', { color: 'ok' }, 'x'], ctx({ colors: { error: '#ff0000' } })) as T;
  expect(unmapped.props.color).toBe('default');
});

test('every colour the composites emit is a flowtty colour, never a token', () => {
  const el = toElement(['Box', { flexDirection: 'column' },
    ['progress', { label: 'jobs', value: 50, tone: 'warn' }],
    ['badge', { text: 'queued', tone: 'accent' }],
    ['rows', { items: [{ label: 'branch', value: 'main', tone: 'ok' }] }],
    ['tasks', { items: [{ text: 'build', state: 'failed' }] }]], ctx()) as T;
  const drawn = JSON.stringify(el);
  expect(drawn).toContain('"color":"yellow"');
  expect(drawn).toContain('"color":"cyan"');
  expect(drawn).toContain('"color":"green"');
  expect(drawn).toContain('"color":"red"');
  for (const token of TONE_TOKENS.filter((t) => t !== 'default')) {
    expect(drawn).not.toContain(`"color":"${token}"`);
  }
});
