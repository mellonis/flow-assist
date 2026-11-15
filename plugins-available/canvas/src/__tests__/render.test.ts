import { expect, test } from 'bun:test';
import { focusKeys } from '../focus.ts';
import { TOKEN_COLOR, toElement, type TRenderCtx } from '../render.ts';
import { checkTree, TONE_TOKENS } from '../tree.ts';

type T = { type: string; props: Record<string, unknown>; children: unknown[] };
const h = (type: unknown, props: Record<string, unknown> = {}, ...children: unknown[]): T => ({ type: String(type), props, children });
const ui = { h, Box: 'Box', Text: 'Text', Markdown: 'Markdown', Table: 'Table', ScrollBox: 'ScrollBox', Link: 'Link', TextInput: 'TextInput', Checkbox: 'Checkbox', Select: 'Select' };
const ctx = (over: Partial<TRenderCtx> = {}): TRenderCtx => ({ ui, width: 80, stringWidth: (s) => s.length, focusKey: null, hasKeyboard: true, values: {}, onValue: () => {}, onPress: () => {}, ...over });

// The TextInput an input node yields: the element itself when it has no label, or the
// field after the label inside the row a label puts in front of it.
const fieldOf = (el: T): T => {
  if (el.type === 'TextInput') return el;
  const field = (el.children as T[]).find((child) => child.type === 'TextInput');
  if (field === undefined) throw new Error('the input drew no TextInput');
  return field;
};

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

test('a field is focusable only when the canvas has the keys', () => {
  const focused = fieldOf(toElement(['input', { bind: 'branch', value: 'main' }], ctx({ focusKey: 'branch', values: { branch: 'main' }, hasKeyboard: true })) as T);
  expect(focused.props.isFocused).toBe(true);
  const muted = fieldOf(toElement(['input', { bind: 'branch' }], ctx({ focusKey: 'branch', values: { branch: 'main' }, hasKeyboard: false })) as T);
  expect(muted.props.isFocused).toBe(false);
  const other = fieldOf(toElement(['input', { bind: 'branch' }], ctx({ focusKey: 'watch', values: { branch: 'main' } })) as T);
  expect(other.props.isFocused).toBe(false);
  const labelled = fieldOf(toElement(['input', { bind: 'branch', label: 'branch' }], ctx({ focusKey: 'branch' })) as T);
  expect(labelled.props.isFocused).toBe(true);
});

test('a field reports an edit with its bind', () => {
  const seen: Array<[string, unknown]> = [];
  const el = fieldOf(toElement(['input', { bind: 'branch' }], ctx({ values: { branch: 'main' }, onValue: (bind, v) => seen.push([bind, v]) })) as T);
  (el.props.onChange as (v: string) => void)('feature-x');
  expect(seen).toEqual([['branch', 'feature-x']]);
});

test('a field takes its value from the canvas, falling back to the declared one', () => {
  const live = fieldOf(toElement(['input', { bind: 'branch', value: 'main' }], ctx({ values: { branch: 'typed' } })) as T);
  expect(live.type).toBe('TextInput');
  expect(live.props.value).toBe('typed');
  expect(live.props.frame).toBe('field');
  expect(live.props.width).toBe(24);
  const declared = fieldOf(toElement(['input', { bind: 'branch', value: 'main' }], ctx()) as T);
  expect(declared.props.value).toBe('main');
  const blank = fieldOf(toElement(['input', { bind: 'branch' }], ctx()) as T);
  expect(blank.props.value).toBe('');
  const wide = fieldOf(toElement(['input', { bind: 'branch', width: 40 }], ctx()) as T);
  expect(wide.props.width).toBe(40);
});

test('an input with a label draws the label and the field in a row', () => {
  const el = toElement(['input', { bind: 'branch', label: 'branch' }], ctx({ colors: { dim: '#123456' } })) as T;
  expect(el.type).toBe('Box');
  expect(el.props).toEqual({ flexDirection: 'row', gap: 1 });
  const [caption, field] = el.children as T[];
  expect(caption?.type).toBe('Text');
  expect(caption?.props).toEqual({ dim: true, color: '#123456' });
  expect(caption?.children).toEqual(['branch']);
  expect(field?.type).toBe('TextInput');
  expect(field?.props.width).toBe(24);
  expect(el.children.length).toBe(2);
});

test('an input without a label is the field itself', () => {
  const el = toElement(['input', { bind: 'branch' }], ctx()) as T;
  expect(el.type).toBe('TextInput');
  expect(el.props.value).toBe('');
  expect(el.children).toEqual([]);
});

test('a check shows its state, carries its label and reports a boolean', () => {
  const seen: Array<[string, unknown]> = [];
  const el = toElement(['check', { bind: 'watch', label: 'watch it' }], ctx({ values: { watch: true }, focusKey: 'watch', onValue: (bind, v) => seen.push([bind, v]) })) as T;
  expect(el.type).toBe('Checkbox');
  expect(el.props.checked).toBe(true);
  expect(el.props.label).toBe('watch it');
  expect(el.props.isFocused).toBe(true);
  (el.props.onChange as (next: boolean) => void)(false);
  expect(seen).toEqual([['watch', false]]);
  const declared = toElement(['check', { bind: 'watch', label: 'watch it', value: true }], ctx()) as T;
  expect(declared.props.checked).toBe(true);
  const unchecked = toElement(['check', { bind: 'watch', label: 'watch it' }], ctx()) as T;
  expect(unchecked.props.checked).toBe(false);
});

test('a select passes its options through and reports the picked value', () => {
  const seen: Array<[string, unknown]> = [];
  const options = [{ value: 'dev', label: 'development' }, { value: 'prod', label: 'production' }];
  const el = toElement(['select', { bind: 'env', options, value: 'dev' }], ctx({ values: { env: 'prod' }, focusKey: 'env', onValue: (bind, v) => seen.push([bind, v]) })) as T;
  expect(el.type).toBe('Select');
  expect(el.props.items).toEqual(options);
  expect(el.props.value).toBe('prod');
  expect(el.props.isFocused).toBe(true);
  (el.props.onChange as (v: string) => void)('dev');
  expect(seen).toEqual([['env', 'dev']]);
});

test('a select with nothing chosen takes its first option, an empty bind asks for the placeholder', () => {
  const options = [{ value: 'dev', label: 'development' }];
  const first = toElement(['select', { bind: 'env', options }], ctx()) as T;
  expect(first.props.value).toBe('dev');
  const none = toElement(['select', { bind: 'env', options }], ctx({ values: { env: '' } })) as T;
  expect(none.props.value).toBeUndefined();
  const unlisted = toElement(['select', { bind: 'env', options }], ctx({ values: { env: 'stage' } })) as T;
  expect(unlisted.props.value).toBe('stage');
});

test('a button presses through onClick and reports its action', () => {
  const seen: Array<[string, string]> = [];
  const el = toElement(['button', { label: 'check again', action: 'check it' }], ctx({ onPress: (label, action) => seen.push([label, action]) })) as T;
  (el.props.onClick as () => void)();
  expect(seen).toEqual([['check again', 'check it']]);
});

test('a button is bold in its tone, never selectable, and needs no focus key to press', () => {
  const el = toElement(['button', { label: 'go', action: 'a', tone: 'error' }], ctx({ hasKeyboard: false })) as T;
  expect(el.type).toBe('Text');
  expect(el.props).toEqual({ bold: true, color: 'red', selectable: false, onClick: el.props.onClick });
  expect(typeof el.props.onClick).toBe('function');
  expect(el.props.isFocused).toBeUndefined();
  expect(el.children).toEqual(['go']);
});

test('a focused button is marked inverse, in lockstep with the focus keys', () => {
  const tree = ['Box', { flexDirection: 'row' },
    ['input', { bind: 'branch' }],
    ['button', { label: 'go', action: 'check it' }],
    ['button', { label: 'stop', action: 'stop it' }]] as never;
  const keys = focusKeys(tree);
  expect(keys).toEqual(['branch', 'btn:0', 'btn:1']);
  const marks = (el: T): Array<unknown> => (el.children as T[]).filter((child) => child.type === 'Text').map((child) => child.props.inverse);
  const second = toElement(tree, ctx({ focusKey: keys[2], values: { branch: 'main' } })) as T;
  expect(marks(second)).toEqual([undefined, true]);
  const first = toElement(tree, ctx({ focusKey: keys[1], values: { branch: 'main' } })) as T;
  expect(marks(first)).toEqual([true, undefined]);
  const muted = toElement(tree, ctx({ focusKey: keys[2], values: { branch: 'main' }, hasKeyboard: false })) as T;
  expect(marks(muted)).toEqual([undefined, undefined]);
});

test('a validated tree of every interactive type still draws', () => {
  const checked = checkTree(['Box', { flexDirection: 'column' },
    ['input', { bind: 'branch', label: 'branch', value: 'main' }],
    ['check', { bind: 'watch', label: 'watch it', value: true }],
    ['select', { bind: 'env', options: [{ value: 'dev', label: 'dev' }] }],
    ['button', { label: 'go', action: 'check it' }]]);
  expect(checked.ok).toBe(true);
  const el = toElement(checked.ok ? checked.tree : ['Text', {}], ctx({ focusKey: 'branch', values: { branch: 'typed', watch: false, env: 'dev' } })) as T;
  const drawn = JSON.stringify(el);
  expect(drawn).toContain('TextInput');
  expect(drawn).toContain('Checkbox');
  expect(drawn).toContain('Select');
  expect(drawn).toContain('"isFocused":true');
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
