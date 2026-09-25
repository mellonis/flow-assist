// A frame's tree into React elements over the host's `ui` — the same components a JS
// plugin draws with, so a remote plugin describes "a list with these rows", never
// cells. Props pass through as they are. Two reserved: `key` (React's) and `id` (a
// stateful node: its value comes from the host's field state, its events carry the id).
// A function prop cannot cross the boundary: `onChange`, `onSubmit`, `onCancel` and
// `Checkbox`'s `onChange` are supplied HERE and become the events `changed`,
// `submitted`, `cancelled`, `toggled`; `TextInput`'s `validate` is the plugin's `error`
// prop, set in the frame after a `changed`. An unknown type is one dim `▸ <type>` line,
// as a missing view renderer is; an `on*` prop in the JSON is dropped and said once.
import type { ReactElement } from 'react';
import type { Tree } from '@flow-assist/remote';
import type { PluginUi } from '../runtime/plugin-api.js';
import { normalizeNode } from './frame.js';

export type FieldEventMethod = 'changed' | 'submitted' | 'cancelled' | 'toggled';
export interface FieldStateLike {
  get(id: string): unknown;
  set(id: string, value: unknown): void;
}
export interface RenderCtx {
  ui: PluginUi;
  hasKeyboard: boolean;
  state: FieldStateLike;
  onEvent: (method: FieldEventMethod, ev: { id: string; value?: unknown }) => void;
  warn: (line: string) => void;
}

const KNOWN = ['Box', 'Text', 'Markdown', 'Table', 'Link', 'ScrollBox', 'Select', 'ListSelect', 'ListMultiSelect', 'Checkbox', 'TextInput'] as const;
const VALUE_PROP: Record<string, string> = { TextInput: 'value', Select: 'value', ListSelect: 'value', ListMultiSelect: 'value', Checkbox: 'checked', ScrollBox: 'offset' };
const FOCUSABLE = new Set(['TextInput', 'Select', 'ListSelect', 'ListMultiSelect', 'Checkbox', 'ScrollBox']);

export function renderTree(tree: Tree | null, ctx: RenderCtx): ReactElement | null {
  if (!tree) return null;
  const warnedProps = new Set<string>();
  const warnProp = (name: string) => { if (!warnedProps.has(name)) { warnedProps.add(name); ctx.warn(`prop ${name} is not sent over the protocol — an event carries what a function prop did`); } };

  const render = (n: unknown): ReactElement | string | null => {
    if (typeof n === 'string') return n;
    const node = normalizeNode(n);
    if (!node) return null;
    const { type, children } = node;
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.props)) {
      if (/^on[A-Z]/.test(k) || k === 'validate') { warnProp(k); continue; }
      props[k] = v;
    }
    if (!(KNOWN as readonly string[]).includes(type)) {
      return ctx.ui.h(ctx.ui.Text, { key: props.key as string | undefined, dim: true }, `▸ ${type}`);
    }
    const id = typeof props.id === 'string' && props.id ? props.id : null;
    delete props.id;
    if (FOCUSABLE.has(type)) props.isFocused = !!props.isFocused && ctx.hasKeyboard;
    // A stateful node: the host's state is what is drawn; the plugin's own `value` in
    // the frame is applied by the field store before this render (./fieldState.ts).
    if (id && VALUE_PROP[type]) {
      const valueProp = VALUE_PROP[type]!;
      const held = ctx.state.get(id);
      if (held !== undefined) props[valueProp] = held;
      const report = (method: FieldEventMethod, value?: unknown) => ctx.onEvent(method, value === undefined ? { id } : { id, value });
      if (type === 'Checkbox') {
        props.onChange = (next: boolean) => { ctx.state.set(id, next); report('toggled', next); };
      } else if (type === 'ScrollBox') {
        props.onScroll = (offset: number) => { ctx.state.set(id, offset); };
      } else {
        props.onChange = (value: unknown) => { ctx.state.set(id, value); report('changed', value); };
        if (type !== 'Select') {
          props.onSubmit = (value: unknown) => report('submitted', value);
          props.onCancel = () => report('cancelled');
        }
      }
    }
    if (type === 'TextInput' && typeof props.error === 'string') {
      const error = props.error as string;
      delete props.error;
      props.validate = () => error;
    }
    if (type === 'Checkbox' && props.checked === undefined) props.checked = false;
    if (type === 'Checkbox' && !props.onChange) props.onChange = () => {};
    const comp = (ctx.ui as unknown as Record<string, unknown>)[type];
    return ctx.ui.h(comp, props, ...children.map(render));
  };
  const el = render(tree);
  return typeof el === 'string' ? ctx.ui.h(ctx.ui.Text, undefined, el) : el;
}
