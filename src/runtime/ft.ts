// The `ft` runtime: the stable object injected into every plugin. It
// carries the React primitives (h/Box/Text/hooks), the cross-domain store, the
// service bundle, the resolved config/keys/registries and the notify channel.
// Plugins never import flowtty/react directly — they read everything from `ft`.
//
// `ft` is built ONCE per App and handed to each plugin's `components[slot]`
// factory; the object is stable so React does not remount plugin components on
// re-render. The mutable channel (`store`, `services`) is shared by reference —
// writes are visible to every plugin regardless of load order.

import type { LazyInputEntry } from './hooks.js';
import type { ReactElement } from 'react';

// The key shapes plugins/types use. We keep them loose (spec is a runtime blob —
// the real source of truth is what the plugins read).
type InputKey = { name?: string; [k: string]: unknown };
type UiState = { cmdOpen?: boolean; modalActive?: boolean };

// The `ft` runtime object. Every field is the shape the built-in plugins consume
// (typed by shape in the plugin modules; the runtime is the real source).
export interface FTRuntime {
  // React primitives (the plugin reads these off `ft` — it never imports
  // flowtty/react directly, so the whole plugin shares the host's one React
  // instance). Markdown/Table/Link are flowtty components like Box/Text; every
  // runtime field is the shape the built-in plugins consume.
  h: (type: unknown, props?: Record<string, unknown>, ...children: unknown[]) => ReactElement;
  Box: unknown;
  Text: unknown;
  Markdown: unknown;
  Table: unknown;
  Link: unknown;
  useState: <T>(init: T | (() => T)) => [T, (v: T | ((prev: T) => T)) => void];
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => void;
  useRef: <T>(init: T) => { current: T };
  useInput: (handler: (key: InputKey) => void, opts?: { isActive?: boolean }) => void;
  useTerminalSize: () => { width: number; height: number };
  // The room a plugin's surface has: the terminal less the host's title bar and
  // footer. A surface sizes itself by this, not by the terminal.
  useSurfaceSize: () => { width: number; height: number };
  // Host input hook (two-phase): register a handler into the App's registry.
  useInputHandler: (opts: { mode?: string; priority?: (ui: UiState) => number; handler: (key: InputKey, ui: UiState) => unknown }) => void;
  // Cross-domain channel: ft.store.<pluginName>.{api}. Kept as a plain record so
  // plugins may publish anything; the App reads it for hints/modal flags.
  store: Record<string, unknown>;
  // The service bundle (generic + plugin-provided).
  services: Record<string, unknown>;
  // Resolved config (theme resolved, plugin namespaces present).
  config: Record<string, unknown>;
  // Resolved hotkeys (HOST_DEFAULT_KEYS + plugin keys + config overrides).
  keys: Record<string, string[]>;
  // The CAP of an action's binding, as drawn: `keyCap('open')` → `⏎`, `z/␣` for two
  // keys, '' when the action is unbound. A hint a plugin shows for one of its keys
  // goes through this, so a key the person remapped is the key the hint names.
  keyCap: (action: string) => string;
  // Surface registry: '<plugin>:<surface>' and the unqualified surface names.
  viewRegistry: Record<string, unknown>;
  // Command registry (base + plugin commands, merged by short name).
  commandRegistry: unknown;
  // Help text for a command registry.
  helpFor: (registry: unknown) => string;
  // Force a re-render of the App.
  notify: () => void;
  // The host keeps the clipboard primitive (generic, alongside openBrowser).
  copyToClipboard?: (text: string) => void;
  // The plugin's own identity token, a unique Symbol the HOST issued and bound in
  // the mount closure (app.tsx passes `{ ...ft, pluginToken: identityToken(p.name) }`).
  // A plugin may relay ITS OWN token into toolCtx to assert who it is, but it can
  // never forge another plugin's — a Symbol is unforgeable and the host alone maps
  // tokens to names (memory's `plugin` scope resolves through that map).
  pluginToken?: symbol;
}

export interface CreateFtInput {
  h: FTRuntime['h'];
  Box: unknown;
  Text: unknown;
  Markdown: unknown;
  Table: unknown;
  Link: unknown;
  useState: FTRuntime['useState'];
  useEffect: FTRuntime['useEffect'];
  useRef: FTRuntime['useRef'];
  useInput: FTRuntime['useInput'];
  useTerminalSize: FTRuntime['useTerminalSize'];
  useSurfaceSize: FTRuntime['useSurfaceSize'];
  useInputHandler: FTRuntime['useInputHandler'];
  store: Record<string, unknown>;
  services: Record<string, unknown>;
  config: Record<string, unknown>;
  keys: Record<string, string[]>;
  keyCap: (action: string) => string;
  viewRegistry: Record<string, unknown>;
  commandRegistry: unknown;
  helpFor: (registry: unknown) => string;
  notify: () => void;
  copyToClipboard?: (text: string) => void;
}

// Assembles the runtime object. The App passes the concrete React hooks, the
// registry-ref-backed `useInputHandler`, the store/services and the resolved
// registries; this just binds them into the stable `FTRuntime` shape.
export function createFt(input: CreateFtInput): FTRuntime {
  return input;
}

export type { LazyInputEntry as RuntimeLazyInputEntry };