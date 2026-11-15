// What a plugin is given: `{ ui, host }` — every hook of the plugin shape receives the
// pair (`components[slot]`, `setup`, `keycaps`, `chatContext`, `chatSubject`,
// `afterWrite`, a screen's `open` and `close`). The rule for which name is where:
//
// - `ui` is what React and flowtty ship, passed through unchanged — the same object
//   for every plugin. A plugin takes them from here, never from its own copy of React
//   or flowtty: one React for the host and every plugin.
// - `host` is what the host implements or wraps — its services, its state, its key
//   path, the sizes it lays a plugin out in — one per plugin: `services` is the
//   plugin's own view over the host's, and `pluginToken` its identity.
//
// Both are built once per App, so a component factory called with them makes one
// component type for the App's life. What they hold is the host API (`HOST_API`,
// src/version.ts): a change a plugin built for it would break on bumps the number.

import type { LazyInputEntry } from './hooks.js';
import type { ReactElement } from 'react';
import type { ScreenResult } from './screens.js';

// `count` is how many notches a 'wheelup' / 'wheeldown' stands for — the TTY backend
// collapses a run of identical wheel reports in one read into one key with the run's
// length (undefined for every other key, and for a lone notch).
type InputKey = { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; count?: number; [k: string]: unknown };
type UiState = { cmdOpen?: boolean; modalActive?: boolean };

export interface PluginUi {
  // React.
  h: (type: unknown, props?: Record<string, unknown>, ...children: unknown[]) => ReactElement;
  useState: <T>(init: T | (() => T)) => [T, (v: T | ((prev: T) => T)) => void];
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => void;
  useRef: <T>(init: T) => { current: T };
  // React's `Fragment`: siblings with no box around them — what an overlay that must be
  // the root of its slot is returned in.
  Fragment: unknown;
  // flowtty's components. The pickers (flowtty's docs/components.md, Choosing):
  // `Select` is a dropdown — a one-line field whose popup the host's <DialogHost>
  // opens; `ListSelect` and `ListMultiSelect` are the inline lists. The pickers,
  // `Checkbox` and `ScrollBox` hear flowtty's own input, not `host.useInputHandler`,
  // and take the keys they act on: a plugin gates them (`isFocused`, `isActive`) from
  // its own state, off whenever its side does not have the keyboard.
  Box: unknown;
  Text: unknown;
  Span: unknown;
  Markdown: unknown;
  Title: unknown;
  HRule: unknown;
  HelpBar: unknown;
  Table: unknown;
  Link: unknown;
  ScrollBox: unknown;
  ScrollList: unknown;
  Select: unknown;
  ListSelect: unknown;
  ListMultiSelect: unknown;
  Checkbox: unknown;
  // A one-line text field (`frame`: `field`, `none`, `border`), as wide as the column
  // around it — it hears keys itself, gated like the pickers.
  TextInput: unknown;
  // A multi-line field: soft wrap, a caret that moves across visual rows, `maxRows` a
  // height cap. It is gated the same way, and it takes `isFocused` as a prop, so no
  // group is needed for the one field a surface has.
  TextArea: unknown;
  // A press. `Button` carries no `isFocused` of its own: it is focused by the group
  // around it, or ALWAYS focused when there is none. So a surface that does not hold
  // the host's keyboard goes deaf with `<Box inert>` (docs/plugins.md, "What a plugin
  // is given") rather than by gating the press per control.
  Button: unknown;
  // The state a person watches while work runs: `Spinner` and `Shimmer` paint
  // themselves off their own ticker, `ProgressBar` takes a `value` and a `total`,
  // `TaskList` a list of `{ label, state }`.
  Spinner: unknown;
  Shimmer: unknown;
  ProgressBar: unknown;
  TaskList: unknown;
  // flowtty's ticker — a re-render every `interval` ms while `active`, what the state
  // components above are built on and what a plugin's own elapsed-time line uses.
  useTicker: unknown;
  // A surface's own focus: Tab moves through the registered controls while `isActive`,
  // `useFocus()` reports which one has it and calls `focus(id)` to move it. This is
  // the plugin's focus, not the host's keyboard — the two are gated apart (see
  // `Box inert` below).
  FocusGroup: unknown;
  useFocus: unknown;
  // A click on what the plugin drew: `useClick(rectRef, onClick)` fires when the press
  // lands in that rect. `useHover()` reports a pointer over the component it is called
  // in — what a row under the pointer is painted with.
  useClick: unknown;
  useHover: unknown;
  // A form over the fields the plugin declares: `useField(name, opts)` registers one
  // (validators included), `Form` owns the values, the errors and which field has the
  // focus, `Confirm` the y/n a destructive step asks.
  Form: unknown;
  useField: unknown;
  Confirm: unknown;
  // Whether a key types a character (@flowtty/core): never a chord, never a control
  // character — what a plugin's own field or filter accepts.
  isPrintable: (key: { name: string; ctrl?: boolean; meta?: boolean }) => boolean;
  // Display columns of a text (@flowtty/core), measured as the grid draws it: per
  // grapheme cluster, so a CJK character, an emoji, a flag or a ZWJ sequence takes two.
  // A column sized from a name or a tag is measured with this, never with `.length`.
  stringWidth: (text: string) => number;
  // flowtty's own `useInput`: every key, in flowtty's delivery order — beside the
  // host's key path, not in it. A plugin's keys go through `host.useInputHandler`.
  useInput: (handler: (key: InputKey) => void, opts?: { isActive?: boolean }) => void;
}

export interface PluginHost {
  // The host API this host provides — for a plugin whose manifest names several, the
  // one it runs under.
  hostApi: number;
  // The room the plugin's side of the screen has (the terminal less a docked chat).
  useTerminalSize: () => { width: number; height: number };
  // The room a plugin's surface has: that side less the host's title bar and footer.
  // A surface sizes itself by this, not by the terminal.
  useSurfaceSize: () => { width: number; height: number };
  // The host's key path (two-phase): a handler joins the race for a key (`consume`) or
  // sees every key (`observe`), from the highest `priority(ui)` down. `mouse: true`
  // asks for the mouse buttons too.
  useInputHandler: (opts: { mode?: string; priority?: (ui: UiState) => number; handler: (key: InputKey, ui: UiState) => unknown; mouse?: boolean }) => void;
  // The cross-plugin channel: `store.<plugin>.{…}`, a plain record the App reads too.
  store: Record<string, unknown>;
  // The host's services, and the plugin's own under them — the host wins on every key
  // it owns. Read members at call time (`host.services.pushLog(…)`): the App rebinds
  // some on every render, so a copy taken once is stale.
  services: Record<string, unknown>;
  // The resolved config (theme resolved, plugin namespaces present).
  config: Record<string, unknown>;
  // The resolved key bindings.
  keys: Record<string, string[]>;
  // The cap of an action's binding, as drawn: `keyCap('open')` → `⏎`, '' when unbound.
  keyCap: (action: string) => string;
  viewRegistry: Record<string, unknown>;
  commandRegistry: unknown;
  helpFor: (registry: unknown) => string;
  // Redraw the App — for a change that does not come from a key.
  notify: () => void;
  copyToClipboard?: (text: string) => void;
  // The plugin's identity, a Symbol the host issued: relayed into a tool's ctx, it says
  // which plugin is asking, and no plugin can forge another's.
  pluginToken?: symbol;
  // Whether the plugin's side has the keyboard now: not while the `:` line is open, the
  // log or the help is up, or the chat has the keys (a dropdown's popup mutes the rest
  // on its own). What a
  // plugin passes as `isFocused` / `isActive` to the flowtty components that hear keys
  // themselves. Read it while drawing: the host redraws when it changes.
  hasKeyboard: () => boolean;
  // Opens one of the plugin's declared screens (`screens` in its shape) with its params —
  // a bare name is the plugin's own, `<plugin>:<screen>` another loaded plugin's — and
  // closes one that declared how. Resolves with what was opened, or why not, as `text`;
  // over the person's typing or an open y/n the open waits for the turn's end and says
  // so (src/runtime/screens.ts). An older host has neither: check that it is there.
  open?: (screen: string, params?: Record<string, unknown>) => Promise<ScreenResult>;
  close?: (screen: string) => Promise<ScreenResult>;
}

export interface PluginApi {
  ui: PluginUi;
  host: PluginHost;
}

export type { LazyInputEntry as RuntimeLazyInputEntry };
