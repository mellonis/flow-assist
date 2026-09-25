import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderTree, type RenderCtx } from '../tree';

// A `ui` whose components are named markers, so the element tree is readable.
const mark = (name: string) => Object.assign(() => null, { displayName: name });
const ui = { h: createElement, Box: mark('Box'), Text: mark('Text'), Markdown: mark('Markdown'), Table: mark('Table'), Link: mark('Link'), ScrollBox: mark('ScrollBox'), Select: mark('Select'), ListSelect: mark('ListSelect'), ListMultiSelect: mark('ListMultiSelect'), Checkbox: mark('Checkbox'), TextInput: mark('TextInput') } as unknown as RenderCtx['ui'];
const stubState = () => { const m = new Map<string, unknown>(); const queued: string[] = []; return { queued, get: (id: string) => m.get(id), set: (id: string, v: unknown) => { m.set(id, v); queued.push(id); }, hold: (id: string, v: unknown) => { m.set(id, v); }, noteFrameIds: () => {}, focusedIn: () => null }; };
const ctx = (over: Partial<RenderCtx> = {}): RenderCtx & { events: unknown[]; warned: string[] } => {
  const events: unknown[] = []; const warned: string[] = [];
  return { ui, hasKeyboard: true, state: stubState() as never, onEvent: (m, ev) => events.push([m, ev]), warn: (l) => warned.push(l), events, warned, ...over };
};
const name = (el: any) => el.type.displayName ?? el.type;

test('a tree becomes elements of the same shape, props passed through, strings as children', () => {
  const el: any = renderTree(['Box', { flexDirection: 'column', padding: 1 }, ['Text', { bold: true }, 'Sign in'], 'plain'], ctx());
  expect(name(el)).toBe('Box');
  expect(el.props.flexDirection).toBe('column');
  const [title, plain] = el.props.children;
  expect(name(title)).toBe('Text');
  expect(title.props.bold).toBe(true);
  expect(title.props.children).toBe('Sign in');
  expect(plain).toBe('plain');
});

test('an unknown type is one dim line naming it; an on* prop is dropped and said once', () => {
  const c = ctx();
  const el: any = renderTree(['Box', {}, ['Gauge', { value: 3 }], ['Text', { onClick: 'x', dim: true }, 'a'], ['Text', { onClick: 'y' }, 'b']], c);
  const [gauge, a] = el.props.children;
  expect(name(gauge)).toBe('Text');
  expect(gauge.props.dim).toBe(true);
  expect(gauge.props.children).toBe('▸ Gauge');
  expect(a.props.onClick).toBeUndefined();
  expect(c.warned).toEqual(['prop onClick is not sent over the protocol — an event carries what a function prop did']);
});

test('a TextInput takes its value from the host state and reports changed/submitted/cancelled with its id', () => {
  const c = ctx();
  c.state.set('name', 'ann');
  const el: any = renderTree(['TextInput', { id: 'name', isFocused: true, mask: true }], c);
  expect(name(el)).toBe('TextInput');
  expect(el.props.value).toBe('ann');
  expect(el.props.mask).toBe(true);
  expect(el.props.isFocused).toBe(true);
  el.props.onChange('anna');
  el.props.onSubmit('anna');
  el.props.onCancel();
  expect(c.state.get('name')).toBe('anna');
  expect(c.events).toEqual([['changed', { id: 'name', value: 'anna' }], ['submitted', { id: 'name', value: 'anna' }], ['cancelled', { id: 'name' }]]);
});

test('isFocused is ANDed with hasKeyboard; a node with no id gets no state and no events', () => {
  const c = ctx({ hasKeyboard: false });
  const el: any = renderTree(['TextInput', { id: 'q', isFocused: true }], c);
  expect(el.props.isFocused).toBe(false);
  const bare: any = renderTree(['TextInput', { isFocused: true }], ctx());
  expect(bare.props.onChange).toBeUndefined();
  expect(bare.props.value).toBeUndefined();
});

test('a Checkbox reports toggled; a ListSelect changed and submitted; error becomes validate', () => {
  const c = ctx();
  const cb: any = renderTree(['Checkbox', { id: 'ok', label: 'agree' }], c);
  cb.props.onChange(true);
  const ls: any = renderTree(['ListSelect', { id: 'lesson', items: [{ label: 'One', value: 1 }] }], c);
  ls.props.onChange(1); ls.props.onSubmit(1);
  const ti: any = renderTree(['TextInput', { id: 'e', error: 'required' }], c);
  expect(ti.props.validate('anything')).toBe('required');
  expect(c.events).toEqual([['toggled', { id: 'ok', value: true }], ['changed', { id: 'lesson', value: 1 }], ['submitted', { id: 'lesson', value: 1 }]]);
});

test("key is React's key", () => {
  const el: any = renderTree(['Box', {}, ['Text', { key: 'a' }, 'x'], ['Text', { key: 'b' }, 'y']], ctx());
  expect(el.props.children.map((c: any) => c.key)).toEqual(['a', 'b']);
});

test('a ScrollBox has no isFocused — hasKeyboard gates isActive instead', () => {
  const el: any = renderTree(['ScrollBox', { isFocused: true }], ctx({ hasKeyboard: false }));
  expect(el.props.isActive).toBe(false);
  expect(el.props.isFocused).toBeUndefined();
  const nullActive: any = renderTree(['ScrollBox', { isActive: null }], ctx());
  expect(nullActive.props.isActive).toBe(true);
});

test('a ListMultiSelect with no held value renders value: [] rather than undefined', () => {
  const c = ctx();
  const noId: any = renderTree(['ListMultiSelect', { items: [] }], c);
  expect(noId.props.value).toEqual([]);
  const unset: any = renderTree(['ListMultiSelect', { id: 'tags', items: [] }], c);
  expect(unset.props.value).toEqual([]);
  const nullValue: any = renderTree(['ListMultiSelect', { items: [], value: null }], c);
  expect(nullValue.props.value).toEqual([]);
});

test('a Checkbox whose checked arrives as JSON null is unchecked', () => {
  const el: any = renderTree(['Checkbox', { label: 'agree', checked: null }], ctx());
  expect(el.props.checked).toBe(false);
});

test('children and ref are reserved: dropped from the props and said once', () => {
  const c = ctx();
  const el: any = renderTree(['Box', { ref: 'x', children: { x: 1 } }, ['Text', { children: 'no' }, 'own']], c);
  expect(el.props.ref).toBeUndefined();
  const [text] = [].concat(el.props.children);
  expect((text as any).props.children).toBe('own');
  expect(c.warned).toEqual(['prop ref is reserved and dropped — a node\'s children follow its props', 'prop children is reserved and dropped — a node\'s children follow its props']);
});

test('a ScrollBox scrolled by the person holds its offset without queueing it: nothing is sent to echo', () => {
  const c = ctx();
  const el: any = renderTree(['ScrollBox', { id: 'sb' }, 'text'], c);
  el.props.onScroll(4);
  expect(c.state.get('sb')).toBe(4);
  expect((c.state as any).queued).toEqual([]);
  expect(c.events).toEqual([]);
});
