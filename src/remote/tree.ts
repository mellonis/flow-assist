// A frame's tree into React elements over the host's `ui` — the same components a JS
// plugin draws with, so a remote plugin describes "a list with these rows", never
// cells. Props pass through as they are. Reserved: `key` (React's), `id` (a stateful
// node: its value comes from the host's field state, its events carry the id), and
// `children` and `ref`, which are dropped — children are the node's own, and a ref has
// nothing to point at across a process.
// A function prop cannot cross the boundary: `onChange`, `onSubmit`, `onCancel` and
// `Checkbox`'s `onChange` are supplied HERE and become the events `changed`,
// `submitted`, `cancelled`, `toggled`; `TextInput`'s `validate` is the plugin's `error`
// prop, set in the frame after a `changed`. An unknown type is one dim `▸ <type>` line,
// as a missing view renderer is; an `on*` prop in the JSON is dropped and said once.
//
// A frame the host cannot draw — a prop of the wrong shape that throws inside a
// component (a `ListSelect` with no `items`) — must not take the App down with it:
// `drawFrame` puts each root behind a boundary that draws `▸ frame failed: <message>`
// in its place, and the next frame (a new `seq`) draws again.
import { Component, type ReactElement, type ReactNode } from 'react';
import type { Tree } from '@flow-assist/remote';
import type { PluginUi } from '../runtime/plugin-api.js';
import { normalizeNode } from './frame.js';

export type FieldEventMethod = 'changed' | 'submitted' | 'cancelled' | 'toggled';
export interface FieldStateLike {
  get(id: string): unknown;
  set(id: string, value: unknown): void;
  hold(id: string, value: unknown): void;
}
export interface RenderCtx {
  ui: PluginUi;
  hasKeyboard: boolean;
  state: FieldStateLike;
  onEvent: (method: FieldEventMethod, ev: { id: string; value?: unknown }) => void;
  // Draws again now. A node with a held value is controlled by it, so its own change
  // must be drawn before the next key, or keys that arrive together (a paste, key
  // repeat) each start from the value before the last one.
  redraw?: () => void;
  warn: (line: string) => void;
}

const KNOWN = ['Box', 'Text', 'Markdown', 'Table', 'Link', 'ScrollBox', 'Select', 'ListSelect', 'ListMultiSelect', 'Checkbox', 'TextInput'] as const;
const VALUE_PROP: Record<string, string> = { TextInput: 'value', Select: 'value', ListSelect: 'value', ListMultiSelect: 'value', Checkbox: 'checked', ScrollBox: 'offset' };
const FOCUSABLE = new Set(['TextInput', 'Select', 'ListSelect', 'ListMultiSelect', 'Checkbox']);

export function renderTree(tree: Tree | null, ctx: RenderCtx): ReactElement | null {
  if (!tree) return null;
  const warnedProps = new Set<string>();
  const warnProp = (name: string) => { if (!warnedProps.has(name)) { warnedProps.add(name); ctx.warn(`prop ${name} is not sent over the protocol — an event carries what a function prop did`); } };
  const warnReserved = (name: string) => { if (!warnedProps.has(name)) { warnedProps.add(name); ctx.warn(`prop ${name} is reserved and dropped — a node's children follow its props`); } };

  const render = (n: unknown): ReactElement | string | null => {
    if (typeof n === 'string') return n;
    const node = normalizeNode(n);
    if (!node) return null;
    const { type, children } = node;
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.props)) {
      if (/^on[A-Z]/.test(k) || k === 'validate') { warnProp(k); continue; }
      if (k === 'children' || k === 'ref') { warnReserved(k); continue; }
      props[k] = v;
    }
    if (!(KNOWN as readonly string[]).includes(type)) {
      return ctx.ui.h(ctx.ui.Text, { key: props.key as string | undefined, dim: true }, `▸ ${type}`);
    }
    const id = typeof props.id === 'string' && props.id ? props.id : null;
    delete props.id;
    if (FOCUSABLE.has(type)) props.isFocused = !!props.isFocused && ctx.hasKeyboard;
    // ScrollBox has no `isFocused` — it gates PgUp/PgDn and the wheel on `isActive`
    // (default true, and a JSON `null` reads as unset), so a plugin's `isFocused` is
    // dropped and `isActive` is what carries `hasKeyboard` here instead.
    if (type === 'ScrollBox') {
      delete props.isFocused;
      props.isActive = (props.isActive == null ? true : !!props.isActive) && ctx.hasKeyboard;
    }
    // A stateful node: the host's state is what is drawn; the plugin's own `value` in
    // the frame is applied by the field store before this render (./fieldState.ts).
    if (id && VALUE_PROP[type]) {
      const valueProp = VALUE_PROP[type]!;
      const held = ctx.state.get(id);
      if (held !== undefined) props[valueProp] = held;
      const report = (method: FieldEventMethod, value?: unknown) => ctx.onEvent(method, value === undefined ? { id } : { id, value });
      if (type === 'Checkbox') {
        props.onChange = (next: boolean) => { ctx.state.set(id, next); ctx.redraw?.(); report('toggled', next); };
      } else if (type === 'ScrollBox') {
        // Held, never sent: there is no echo to wait for (./fieldState.ts).
        props.onScroll = (offset: number) => { ctx.state.hold(id, offset); ctx.redraw?.(); };
      } else {
        props.onChange = (value: unknown) => { ctx.state.set(id, value); ctx.redraw?.(); report('changed', value); };
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
    // A JSON `null` is a plugin's "nothing" in many languages, read as the prop unset.
    if (type === 'Checkbox' && props.checked == null) props.checked = false;
    if (type === 'Checkbox' && !props.onChange) props.onChange = () => {};
    // flowtty's ListMultiSelect calls `value.includes(...)` unconditionally on every
    // render, so an unset value (no id, or an id the field state hasn't populated yet)
    // must default to an array rather than reach the component as undefined or null.
    if (type === 'ListMultiSelect' && props.value == null) props.value = [];
    const comp = (ctx.ui as unknown as Record<string, unknown>)[type];
    return ctx.ui.h(comp, props, ...children.map(render));
  };
  const el = render(tree);
  return typeof el === 'string' ? ctx.ui.h(ctx.ui.Text, undefined, el) : el;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface BoundaryProps { seq: number; ui: PluginUi; onError: (message: string) => void; children?: ReactNode }
interface BoundaryState { seq: number; failed: string | null }

// One root of a frame behind a boundary. It is never remounted by a new frame (that
// would lose a field's caret, a list's filter, a scroll offset on every frame); a new
// `seq` clears a failure instead, so the next frame is drawn afresh.
export class FrameBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { seq: this.props.seq, failed: null };
  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.seq !== state.seq ? { seq: props.seq, failed: null } : null;
  }
  static getDerivedStateFromError(e: unknown): Partial<BoundaryState> {
    return { failed: errorMessage(e) };
  }
  override componentDidCatch(e: unknown): void {
    this.props.onError(errorMessage(e));
  }
  override render(): ReactNode {
    const { ui } = this.props;
    if (this.state.failed !== null) return ui.h(ui.Text, { dim: true }, `▸ frame failed: ${this.state.failed}`);
    return this.props.children ?? null;
  }
}

// `renderTree` runs in a component of its own, inside the boundary: a boundary catches
// what its children throw, never what its own render does.
function DrawTree({ tree, ctx }: { tree: Tree | null; ctx: RenderCtx }): ReactElement | null {
  return renderTree(tree, ctx);
}

export function drawFrame(tree: Tree | null, ctx: RenderCtx, seq: number, onError: (message: string) => void): ReactElement {
  return ctx.ui.h(FrameBoundary, { seq, ui: ctx.ui, onError }, ctx.ui.h(DrawTree, { tree, ctx }));
}
