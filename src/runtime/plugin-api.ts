// What a plugin is given: `{ ui, host }` — every hook of the plugin shape receives the
// pair (`components[slot]`, `setup`, `keycaps`, `chatContext`, `chatSubject`,
// `afterWrite`). The rule for which name is where:
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

type InputKey = { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; [k: string]: unknown };
type UiState = { cmdOpen?: boolean; modalActive?: boolean };

export interface PluginUi {
  // React.
  h: (type: unknown, props?: Record<string, unknown>, ...children: unknown[]) => ReactElement;
  useState: <T>(init: T | (() => T)) => [T, (v: T | ((prev: T) => T)) => void];
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => void;
  useRef: <T>(init: T) => { current: T };
  // flowtty's components. The pickers (flowtty's docs/components.md, Choosing):
  // `Select` is a dropdown — a one-line field whose popup the host's <DialogHost>
  // opens; `ListSelect` and `ListMultiSelect` are the inline lists. The pickers,
  // `Checkbox` and `ScrollBox` hear flowtty's own input, not `host.useInputHandler`,
  // and take the keys they act on: a plugin gates them (`isFocused`, `isActive`) from
  // its own state, off whenever its side does not have the keyboard.
  Box: unknown;
  Text: unknown;
  Markdown: unknown;
  Table: unknown;
  Link: unknown;
  ScrollBox: unknown;
  Select: unknown;
  ListSelect: unknown;
  ListMultiSelect: unknown;
  Checkbox: unknown;
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
}

export interface PluginApi {
  ui: PluginUi;
  host: PluginHost;
}

export type { LazyInputEntry as RuntimeLazyInputEntry };
