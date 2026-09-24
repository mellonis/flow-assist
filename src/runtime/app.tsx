// Host App shell + two-phase input dispatch. `renderApp` builds what a plugin is given,
// `{ ui, host }` (src/runtime/plugin-api.ts), once per plugin and hands it to every
// plugin's `components[slot]` factory and hooks, then renders a
// minimal shell: a title bar, a content slot for the active view, the plugin
// component overlay (each modal gates itself via its own state — closed modals
// return null), and a bottom line (command line / toast message / footer hints).
// Input is dispatched two-phase: observers never consume, then the consumer race
// (`partitionInput`/`runConsumers`), then the host fallback (command line `:`,
// Esc back, `x` clear cache; quitting is `:quit` or Ctrl+C twice — the three keys that
// take a second press are the App's own, before any of this: src/runtime/exit-keys.ts).

import { pluginConfigs } from '../loader/tools.js';
import { Box, Text, Markdown, Table, Link, ScrollBox, Select, ListSelect, ListMultiSelect, Checkbox, TextInput, DialogHost, render, useApp, useColorScheme, useInput, useTerminalSize, type CopyEvent } from '@flowtty/react';
import { isPrintable, type Backend } from '@flowtty/core';
import { Fragment, createContext, createElement as h, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { HOST_API } from '../version.js';
import type { PluginApi, PluginHost, PluginUi } from './plugin-api.js';
import { identityToken } from './plugin-identity.js';
import { createServices } from './services.js';
import type { HostServices } from './services.js';
import { registerInputHandler, useToast } from './hooks.js';
import type { LazyInputEntry } from './hooks.js';
import {
  buildCommandRegistry,
  buildKeys,
  buildViewRegistry,
  collectViewRenderers,
  commandContextFor,
  cacheInPlay,
  composeFooterHints,
  findIn,
  helpFor as helpForRegistry,
  partitionInput,
  runConsumers,
} from '../loader/registry.js';
import { completeCommand, flattenConfigPaths } from '../config/commands.js';
import { lineTab, lineView, type TabWalk } from '../config/commandline.js';
import { hostConfigSchema } from '../config/schema.js';
import {
  getDeep,
  parseValue,
  validateConfigWriteValue,
  saveConfigSetting,
  saveConfigUnset,
} from '../config/load.js';
import { bindingGlyph, isKey, isMouseButton, keyGlyph } from '../playback/keys.js';
import { ARM_MS, armHint, armKeyOf, armStep, type Arm } from './exit-keys.js';
import { copyToClipboard } from '../assistant/copy.js';
import { readClipboardImage, type ClipboardImage } from '../assistant/images.js';
import { legacyRootsNote } from '../assistant/shell.js';
import { llmConfigNotes } from '../assistant/llm-endpoint.js';
import { collectContext } from '../assistant/screen-context.js';
import { resolveAppTheme } from '../playback/theme.js';
import type { ColorScheme, Theme } from '../playback/theme.js';
import type { Command } from '../loader/plugin.js';
import type { Plugin, PluginShape } from '../loader/plugin.js';
import { renderHome } from '../views/home.js';
import { FOOTER_ROWS, TITLE_ROWS, chatModeOf, panelLayout, type ChatMode, type PanelLayout } from './panel-layout.js';

// The host's own plugins: they ARE the host, so the start screen does not list them
// among the guests.
const BUILTIN_PLUGINS = ['core', 'assistant', 'keycaps', 'log'];
// The host's furniture drawn over everything, the docked chat included, and the corner
// of the terminal each piece places itself from: the reminder is laid out over the
// whole terminal from its top-left corner, the keycaps panel floats in from the
// bottom-right one.
const TOP_LAYER: Record<string, 'topLeft' | 'bottomRight'> = { 'core:reminder': 'topLeft', 'keycaps:keycaps': 'bottomRight' };

// ─── Two-phase input dispatch ────────────────────────────────────────────────
// Observers (mode 'observe') always run, never consume; then the consumer race
// (`partitionInput`/`runConsumers` — the first handler returning STRICT `true`
// short-circuits); then the host fallback. `registry` may hold lazy `{ get }`
// wrappers or resolved entries; `partitionInput` unwraps lazily either way.
type UiState = {
  cmdOpen?: boolean;
  modalActive?: boolean;
  view?: string;
  overlay?: string;
};
type InputKey = { name?: string; [k: string]: unknown };

export function twoPhaseDispatch(
  registry: LazyInputEntry[],
  ui: UiState = {},
  key: InputKey = {},
  fallback?: () => boolean,
): boolean {
  // A mouse button (press / drag / release) is flowtty's drag-selection, which runs
  // on its own path whatever a handler returns. Almost nothing here is written for
  // one, and several read an unknown key as "any key": the y/n pause and an open
  // question swallow every key, the command line's catch-all consumes it, the keycaps
  // panel would draw a cap per dragged cell — and every consumed key costs a
  // re-render. So a button reaches ONLY a handler that asked for it (`mouse: true`),
  // and never the host fallback: a handler that opts in knows what is under the
  // pointer, which is the whole of what a button means.
  if (isMouseButton(key.name)) {
    const { consumers } = partitionInput(registry, ui);
    return runConsumers(consumers.filter((c) => c.mouse === true), key, ui);
  }
  const { observers, consumers } = partitionInput(registry, ui);
  for (const o of observers) o.handler(key, ui); // observers never consume
  if (runConsumers(consumers, key, ui)) return true;
  return fallback ? fallback() : false;
}

// ─── Host service bindings the App reassigns each render ───────────────────
// `createServices` (services.ts) wires the generic slice with no-op stubs for
// the React-bound members (showMessage/pushLog/notify/logs/view). The App
// reassigns them per render so plugins reading `host.services` see the live
// channels (same object, mutated by reference).
type ReactBoundServices = {
  showMessage: (msg: string) => void;
  pushLog: (entry: string) => void;
  notify: () => void;
  logs: string[];
  reminder: string | null;
  showReminder: (text: string) => void;
  dismissReminder: () => void;
};

// ─── App shell ──────────────────────────────────────────────────────────────
export interface RenderAppInput {
  plugins: Plugin[];
  config: Record<string, unknown>;
  onExit: () => void;
  // The renders bundle the load step handed each plugin builder; accepted here so
  // runtime plugin loading can thread it through, unused by the App itself
  // (components, not views, mount here).
  renders?: Record<string, unknown>;
  // The assembled tool registry — passed to `createServices` so the synthetic
  // `<plugin>:aiTools` groups populate `pluginAiTools`. Optional: a test that
  // needs no tools leaves it out.
  tools?: import('../loader/tools.js').ToolRegistry;
  // How long a toast stays, in ms (default `TOAST_MS`, 4 s). Only tests change it.
  toastMs?: number;
  // Reads the image on the system clipboard into a file (`readClipboardImage`, the
  // platform's tools). Only tests pass one — a fake clipboard, no tools run.
  clipboardImage?: () => ClipboardImage;
  // Where the host looked for plugins when it found none (`noPluginsNote`). It goes
  // into the log and onto the start screen: a binary started from the wrong place
  // otherwise just looks like an assistant with fewer tools.
  pluginsNote?: string;
  // What the loader said about the plugins it skipped (`loadPlugins`' notes): each goes
  // into the log.
  loadNotes?: string[];
  // What the chat's `!!command` runs with — which `script`, the process, the signals.
  // Only tests pass one: the test backend has no terminal to hand to a program.
  interactive?: import('../assistant/interactive.js').InteractiveDeps;
  // What the TTY backend took off the console while it holds the screen (its
  // `onConsole`, src/runtime/console-log.ts): each line goes to the log.
  consoleLog?: import('./console-log.js').ConsoleBridge;
}

// Command-line state lives in a single stable `{ current }` object created in
// `renderApp` (not inside the App body) so the host fallback and the render both
// see the SAME object across re-renders — a per-render object would reset the
// line to closed/empty on every `notify()` (a real runtime defect).
interface CommandLineState {
  open: boolean;
  input: string;
  // History of executed `:`-commands + the cursor index. `historyIdx` = -1 (or
  // history.length) means "the live edit buffer, not a recalled line"; up
  // decrements toward the newest recallable entry, down returns toward the
  // buffer. Reloaded from the persisted log on restart (below).
  history: string[];
  historyIdx: number;
  // A Tab walk through the completion candidates (see config/commandline.ts).
  walk: TabWalk | null;
}

// The host's chrome around a plugin's surface (the title bar and the footer, three rows
// apiece) is counted where the panel's layout needs it too.
export { TITLE_ROWS, FOOTER_ROWS };

// The part of the terminal a subtree is drawn in. With the chat docked beside it, a
// plugin's side of the screen is smaller than the terminal, and everything drawn there
// — its surface, its modals, the host's own furniture — is laid out as on a smaller
// terminal; the chat is given its panel the same way. Unset: the whole terminal.
// flowtty's own size context is not exported, so this reaches what a plugin reads
// through `host` (`host.useTerminalSize`, `host.useSurfaceSize`), not flowtty's hook itself.
const AreaContext = createContext<{ width: number; height: number } | null>(null);
export function useAreaSize(): { width: number; height: number } {
  const terminal = useTerminalSize();
  return useContext(AreaContext) ?? terminal;
}

// The room a plugin's surface has: its side of the screen less the title bar and the
// footer. A surface that sized itself by the terminal was four rows taller than its room
// and pushed the command line off the screen.
export function useSurfaceSize(): { width: number; height: number } {
  const { width, height } = useAreaSize();
  return { width, height: Math.max(1, height - TITLE_ROWS - FOOTER_ROWS) };
}

// What the App reads of the chat (the assistant plugin publishes it on `host.store.chat`;
// its `setup` seeds the first three before anything renders).
type ChatStore = {
  open?: boolean;
  mode?: ChatMode;
  focus?: 'chat' | 'plugin';
  ctrlKey?: (k: InputKey) => 'handled' | 'field' | undefined;
  // Ctrl+] (`chatFocus`) and the collapse key (`chatCollapse`): true when the chat acted.
  panelKey?: (which: 'focus' | 'collapse') => boolean;
  // A click at a cell: the chat moves the keyboard to the pane under it.
  pointer?: (x: number, y: number) => void;
  // The rows the open chat needs at a panel `width` columns wide to show a pending
  // question or y/n whole; 0 when nothing is pending.
  needRows?: (width: number) => number;
  // The running turn's status, drawn on the plugin's bottom row while the panel is
  // collapsed on the right; null when nothing runs.
  statusRow?: unknown;
};

// Where the host hears a key, in a fixed order whatever was mounted when:
//   1. The host's chords (`first`): the exit keys, Ctrl+], the collapse key, where a
//      press landed — `HostChords`, a capture handler: it hears every key before the
//      ordinary handlers (flowtty's capture phase), before any component can take it.
//   2. Whatever flowtty component takes the key: a dropdown's popup, a focused field
//      or list, a scroll box — each takes the keys it acts on.
//   3. The host's key path (`last`, `twoPhaseDispatch`): plugin handlers, the chat, the
//      host fallback — for a key nothing took. Tab and ⇧⇥ come here straight from
//      step 1: the DialogHost's FocusGroup above the App would take them otherwise.
// flowtty has no phase after the ordinary handlers, and those go in mount order — a
// plugin's surface opened after boot comes after anything of the App's — so step 3 is
// a second pass: the backend's key listener is wrapped (`hostKeyed`), and a key nothing
// took in pass 1 goes round again, where `HostChords`, the first capture handler, runs
// step 3 and takes it — no other handler hears it twice, and step 3 runs inside
// flowtty's own synchronous render, as every handler does. A mouse button runs step 3
// straight after pass 1 instead: a second press or release would redo the selection.
// While a dropdown's popup is open flowtty mutes the App's subtree, `HostChords` with
// it: the exit keys are then heard by `HostExit`, a capture handler beside the
// DialogHost, so they still take two presses; nothing else of the host's runs.
interface HostKeyPath {
  // `muted`: the App's subtree is muted (a popup is open) — the exit keys only.
  first: (key: InputKey, muted: boolean) => unknown;
  last: (key: InputKey) => unknown;
  pass: 1 | 2;
  // Whether `HostChords` heard the key in pass 1 — whether the App's subtree was live.
  heard: boolean;
}

// The backend as flowtty sees it: each key it reports goes through the host's passes.
function hostKeyed(root: Backend, path: HostKeyPath): Backend {
  return new Proxy(root, {
    get(target, prop) {
      if (prop === 'onKey' && typeof target.onKey === 'function') {
        return (listener: (key: never) => unknown) => target.onKey!(((key: InputKey) => {
          path.pass = 1;
          path.heard = false;
          if (listener(key as never) === true) return true;
          if (!path.heard) return false;
          if (isMouseButton(key.name)) {
            path.last(key);
            return false;
          }
          path.pass = 2;
          try {
            listener(key as never);
          } finally {
            path.pass = 1;
          }
          return false;
        }) as never);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// Steps 1 and 3 of `HostKeyPath` — the App's first child, so the first capture handler
// in the App's subtree for the App's life.
function HostChords({ path }: { path: HostKeyPath }) {
  useInput((key) => {
    if (path.pass === 1) {
      path.heard = true;
      const k = key as unknown as InputKey;
      if (path.first(k, false) === true) return true;
      // Tab and ⇧⇥ are the host's key path's at once — the chat completes and steps
      // its auto mode with them, a plugin's handlers hear them — never flowtty's focus
      // cycling above the App, which would take them whenever two fields are mounted.
      if (k.name === 'tab') {
        path.last(k);
        return true;
      }
      return undefined;
    }
    path.last(key as unknown as InputKey);
    return true;
  }, { capture: true });
  return null;
}

// The exit keys while a popup mutes the App — beside the DialogHost, so never muted,
// and mounted after it, so it hears a key after `HostChords`.
function HostExit({ path }: { path: HostKeyPath }) {
  useInput((key) => (path.pass === 1 && !path.heard ? path.first(key as unknown as InputKey, true) : undefined), { capture: true });
  return null;
}

// Whether the plugin's side has the keyboard — `host.hasKeyboard()`, which a plugin
// gates its flowtty pickers, checkboxes and scroll boxes with. Not while the `:` line is
// open, the log or the help is up, or the chat has the keys (open, and not docked with
// the focus on the plugin). While a dropdown's popup is open flowtty mutes everything
// under it, whatever this says.
export function pluginHasKeyboard(store: Record<string, unknown>, ui: { cmdOpen?: boolean }): boolean {
  if (ui.cmdOpen) return false;
  const s = store as { log?: { open?: boolean }; help?: { helpModal?: boolean }; chat?: { open?: boolean; focus?: string } };
  if (s.log?.open || s.help?.helpModal) return false;
  return !(s.chat?.open && s.chat.focus !== 'plugin');
}

// How often a console line may redraw the App (see `consoleLog` in renderApp) — the
// chat's own rate for a view that updates fast.
const CONSOLE_REDRAW_MS = 200;

export function renderApp(
  root: Backend,
  { plugins, config, onExit, renders: _renders = {}, tools, toastMs, clipboardImage, pluginsNote, loadNotes = [], interactive, consoleLog }: RenderAppInput,
) {
  // Resolve config.theme into the full per-modal palette BEFORE anything reads it
  // (createServices, the plugins' `host` and every renderer read `config.theme`): the base of the
  // terminal's scheme + user config.theme on top, then resolveModalPalettes lays the
  // per-modal palettes down and resolvePluginColors adds non-modal plugin palettes.
  // Without this the modals degrade to empty Flowtty defaults — no borders, no colors.
  // The person's own theme is kept apart: the scheme can change while the app runs
  // (App re-resolves then), and their colours go on top of every scheme.
  const userTheme = config.theme as Theme | undefined;
  let themeScheme: ColorScheme = root.colorScheme?.().scheme ?? 'unknown';
  config.theme = resolveAppTheme(userTheme, plugins, config, themeScheme);
  const services = createServices({ config, tools, onExit });
  (services as unknown as HostServices).clipboardImage = clipboardImage ?? (() => readClipboardImage());
  if (interactive) (services as unknown as HostServices).interactive = interactive;
  if (pluginsNote) services.log.append(`[plugins] ${pluginsNote}`);
  for (const line of loadNotes) services.log.append(line);
  // A config that still sets the roots as `fs.roots` is read, and said once in the log.
  const rootsNote = legacyRootsNote(config);
  if (rootsNote) services.log.append(`[config] ${rootsNote}`);
  for (const note of llmConfigNotes(config.ai)) services.log.append(`[config] ${note}`);
  // A console line reaches the log as soon as it is printed, and an open log shows it:
  // while the log is open the App is asked to redraw, at most once per
  // CONSOLE_REDRAW_MS. Not per line, as `pushLog` does, and not while the log is closed:
  // a plugin that prints on every render (a debug line left in a view) is redrawn by
  // the redraw its line asked for and prints again. With the log closed nothing redraws
  // for it; with the log open it costs a few frames a second.
  let pushLogBound = false;
  let logOpen = () => false;
  let consoleRedraw: ReturnType<typeof setTimeout> | null = null;
  consoleLog?.attach((line) => {
    services.log.append(line);
    if (!pushLogBound || consoleRedraw || !logOpen()) return;
    consoleRedraw = setTimeout(() => {
      consoleRedraw = null;
      const bound = services as unknown as ReactBoundServices;
      bound.logs = services.log.read();
      bound.notify();
    }, CONSOLE_REDRAW_MS);
    consoleRedraw.unref?.();
  });
  const viewRegistry = buildViewRegistry(plugins);
  const commandRegistry = buildCommandRegistry(plugins);
  const keys = buildKeys(plugins, config, undefined, (line) => services.log.append(line));
  const helpFor = (reg: unknown) => helpForRegistry(reg as Command[]);

  // Shared per-app mutable state (created ONCE; read by the App and the
  // fallback handler so a re-render never resets them).
  const ui: UiState = { cmdOpen: false, modalActive: false };
  const cmdline = { current: { open: false, input: '', history: [], historyIdx: -1, walk: null } as CommandLineState };
  // The host's place in key delivery (see `HostKeyPath`); the App fills in its steps.
  const keyPath: HostKeyPath = { first: () => undefined, last: () => undefined, pass: 1, heard: false };

  function App() {
    const inputRegistryRef = useRef<LazyInputEntry[]>([]);
    const armRef = useRef<Arm>(null);
    const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [, setTick] = useState(0);
    const toast = useToast(toastMs);
    const app = useApp();
    const notify = () => setTick((t) => t + 1);
    // The terminal switched between light and dark (macOS does it by itself at
    // sunset and sunrise): lay the other scheme's palette into the SAME theme object
    // — a plugin may hold a reference to it — before anything below renders with it.
    const { scheme } = useColorScheme();
    if (scheme !== themeScheme) {
      themeScheme = scheme;
      const theme = config.theme as Theme;
      const next = resolveAppTheme(userTheme, plugins, config, scheme);
      for (const key of Object.keys(theme)) delete theme[key];
      Object.assign(theme, next);
    }

    // React-bound services rebound on every render (merged into the shared
    // `services` object so plugins see the live channels). `showMessage` uses
    // the toast (auto-clears after 4s); `pushLog` appends to the log buffer and
    // refreshes `logs` for the log modal to read.
    (services as unknown as ReactBoundServices).showMessage = (msg) => toast.showMessage(msg);
    (services as unknown as ReactBoundServices).pushLog = (entry) => {
      services.log.append(entry);
      (services as unknown as ReactBoundServices).logs = services.log.read();
      notify();
    };
    pushLogBound = true;
    logOpen = () => !!(hostBase.store as { log?: { open?: boolean } }).log?.open;
    (services as unknown as ReactBoundServices).notify = notify;
    (services as unknown as ReactBoundServices).logs = services.log.read();
    // Reminder banner: `showReminder` is the `remind` tool's timer delivery (the
    // core `reminder` component reads `services.reminder` and draws a centered
    // top-most banner); `dismissReminder` is what its Esc/Enter handler calls.
    (services as unknown as ReactBoundServices).reminder ??= null;
    (services as unknown as ReactBoundServices).showReminder = (text) => {
      (services as unknown as ReactBoundServices).reminder = text;
      notify();
    };
    (services as unknown as ReactBoundServices).dismissReminder = () => {
      (services as unknown as ReactBoundServices).reminder = null;
      notify();
    };
    (services as unknown as HostServices).alert = (title, body) => app.notify(title, body);
    // The terminal handed to another program and taken back (the chat's `!!command`).
    (services as unknown as HostServices).suspend = (fn) => app.suspend(fn);
    // The terminal's clipboard first; the platform's tool where no sequence went out.
    // `app.copy` fires `onCopy` too (source 'api'), which leaves an api copy alone —
    // the caller says what it copied, so the toast is not shown twice.
    (services as unknown as HostServices).copy = (text) => (app.copy(text) ? { ok: true } : copyToClipboard(text));
    // Overlay channel: a plugin opens its overlay surface (e.g. a tracker's
    // detail view) by calling `services.setOverlay(name)`; it mutates the shared
    // `ui.overlay` the input race reads and re-renders so the surface repaints.
    // `null`/undefined closes it (falls back to the base consumer race).
    (services as unknown as HostServices).setOverlay = (overlay) => {
      ui.overlay = overlay ?? undefined;
      notify();
    };

    // What every plugin is given is built ONCE per App (stable objects): `ui`, shared by
    // every plugin, and the host's part, of which each plugin gets its own copy with its
    // services view and identity (below). The useInputHandler closes over the SAME
    // inputRegistryRef the App reads in dispatch, so plugin handlers registered during
    // render land in the registry the App consumes.
    const apiRef = useRef<{ ui: PluginUi; host: PluginHost } | null>(null);
    if (!apiRef.current) {
      apiRef.current = {
        ui: {
          h: h as unknown as PluginUi['h'],
          useState: useState as unknown as PluginUi['useState'],
          useEffect,
          useRef,
          Box,
          Text,
          Markdown,
          Table,
          Link,
          ScrollBox,
          Select,
          ListSelect,
          ListMultiSelect,
          Checkbox,
          TextInput,
          isPrintable: isPrintable as unknown as PluginUi['isPrintable'],
          useInput: useInput as unknown as PluginUi['useInput'],
        },
        host: {
          hostApi: HOST_API,
          useTerminalSize: useAreaSize,
          useSurfaceSize,
          useInputHandler: (opts) => registerInputHandler(inputRegistryRef, opts as Parameters<typeof registerInputHandler>[1]),
          store: {},
          services: services as unknown as Record<string, unknown>,
          config,
          keys,
          keyCap: (action: string) => bindingGlyph(keys[action]),
          viewRegistry,
          commandRegistry,
          helpFor,
          notify,
          copyToClipboard: services.copyToClipboard,
          hasKeyboard: () => pluginHasKeyboard(apiRef.current!.host.store, ui),
        },
      };
    }
    const { ui: pluginUi, host: hostBase } = apiRef.current;

    // Mount each plugin's `components[slot]` factory EXACTLY once: memoize only
    // the component FUNCTION (stable identity → no remount, state preserved),
    // but render a fresh element each App render (so a modal re-renders on
    // `notify()` and re-reads shared mutable state like `services.logs`). Each
    // plugin's factory receives `{ ui, host }` with its OWN `host` — its services view
    // and the HOST-ISSUED identity token bound in the closure (`identityToken(p.name)`),
    // so the memory `plugin` scope resolves to the true owner — a caller or LLM cannot
    // forge this value.
    // Each plugin's pair, captured so the footer can call the plugin's `keycaps` with
    // the SAME objects the plugin reads its live state from. Populated by
    // `overlayComps`; a ref, so it SURVIVES renders where the useMemo does not run (a
    // fresh `{}` each render would lose the capture and the footer would collapse even
    // while a board is open). The pairs are stable, and the services/store they point
    // at are mutated live, so re-reading them each render stays fresh.
    const apiMap = useRef<Record<string, PluginApi>>({}).current;
    // The plugins whose `chatContext` threw and was logged — once each, for the run.
    const contextFailed = useRef(new Set<string>()).current;
    const overlayComps = useMemo(
      () => {
        const comps: { Comp: () => unknown; key: string; plugin: PluginShape; surface: boolean }[] = [];
        for (const p of plugins) {
          // Host contract (AGENTS.md §shape): a plugin's `services` are exposed
          // through `host.services`, but the HOST must win on keys it owns — a
          // plugin's no-op `showMessage`/`openBrowser` must never clobber the real
          // toast/browser. Build a per-plugin view with the host services as the
          // prototype (host wins via lookup) and only the plugin-OWNED keys (the
          // lazy getters like `detail`/`boardData`) as own props, preserving their
          // getter descriptors so they stay live.
          const pServices = Object.create(services) as Record<string, unknown>;
          if (p.services) {
            for (const key of Object.keys(p.services)) {
              if (key in services) continue;
              const desc = Object.getOwnPropertyDescriptor(p.services, key);
              if (desc) Object.defineProperty(pServices, key, desc);
            }
          }
          // `setup` seeds the plugin's cross-component store BEFORE any component
          // mounts, so hooks reading the store during render don't throw.
          const api: PluginApi = { ui: pluginUi, host: { ...hostBase, services: pServices, pluginToken: identityToken(p.name) } };
          apiMap[p.name] = api;
          p.setup?.(api);
          for (const [slot, factory] of Object.entries(p.components ?? {})) {
            const Comp = factory(api);
            // A plugin's SURFACE — its own full screen — is the slot named `view`, or
            // named after `shape.surface`. Everything else (modals, triggers, the
            // workspace that feeds them) is furniture and is always mounted.
            const surface = slot === 'view' || (!!p.surface && slot === p.surface);
            if (typeof Comp === 'function') comps.push({ Comp: Comp as () => unknown, key: `${p.name}:${slot}`, plugin: p, surface });
          }
        }
        return comps;
      },
      [plugins, pluginUi, hostBase],
    );

    // Every view renderer, the host's and each plugin's: the chat draws a tool's block
    // with the renderer its kind names (src/loader/registry.ts).
    (services as unknown as HostServices).viewRenderers = collectViewRenderers(plugins as never);

    // The chat's two plugin hooks (AGENTS.md, plugin contract). Each plugin is asked
    // with its OWN runtime — the one its services and store live on; the chat's
    // runtime cannot see another plugin's services.
    // Asked on every draw of the chat and before every request: a plugin whose hook
    // throws gives nothing, and it is said in the log once per plugin, not per draw.
    // The log line is written after the draw, never during it: pushLog sets the App's
    // state, and a setState while the chat renders is React's "cannot update a
    // component while rendering a different component".
    (services as unknown as HostServices).chatContext = () =>
      collectContext(plugins as Plugin[], (name) => apiMap[name], (name, e) => {
        if (contextFailed.has(name)) return;
        contextFailed.add(name);
        const line = `[${name}] chatContext failed: ${(e as Error)?.message ?? String(e)}`;
        queueMicrotask(() => (services as unknown as ReactBoundServices).pushLog(line));
      });
    (services as unknown as HostServices).afterWrite = async () => {
      for (const p of plugins) {
        const api = apiMap[p.name];
        if (!api || !(p as Plugin).afterWrite) continue;
        try {
          await (p as Plugin).afterWrite!(api);
        } catch (e) {
          (services as unknown as ReactBoundServices).pushLog(`[${p.name}] refresh after a write failed: ${(e as Error).message}`);
        }
      }
    };

    // ── Host command-line handlers (F1) ─────────────────────────────────────
    // The `:config`/`:cache` commands route to the same config-write modules
    // the CLI `config` subcommand uses; `:view`/`:back` just record the active
    // view (the host renders no surface — a tracker plugin supplies the views).
    // All feedback lands in the command-line toast.
    const setHelpModalOpen = (open: boolean): void => {
      const h = (hostBase.store as { help?: { setHelpModal?: (o: boolean) => void } } | undefined)?.help;
      if (h?.setHelpModal) h.setHelpModal(open);
      notify();
    };
    const toggleKeycaps = (arg: string): void => {
      const k = (hostBase.store as { keycaps?: { toggle?: (a: string) => void } } | undefined)?.keycaps;
      if (k?.toggle) k.toggle(arg);
    };
    const runConfigCmd = (arg: string): void => {
      const parts = String(arg ?? '').trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? '').toLowerCase();
      const key = parts[1];
      if (sub === 'get' && key) {
        const v = getDeep(config, key);
        toast.showMessage(v === undefined ? `no key ${key}` : JSON.stringify(v));
        return;
      }
      if (sub === 'set' && key && parts.length >= 3) {
        const parsed = parseValue(parts.slice(2).join(' '));
        const check = validateConfigWriteValue(hostConfigSchema, key, parsed, pluginConfigs(plugins));
        if (!check.ok) { toast.showMessage(check.error); return; }
        saveConfigSetting(key, check.value);
        toast.showMessage(JSON.stringify(check.value));
        return;
      }
      if (sub === 'unset' && key) {
        saveConfigUnset(key);
        toast.showMessage(`config: unset ${key}`);
        return;
      }
      const paths = flattenConfigPaths(config);
      toast.showMessage(paths.length ? paths.map((p) => `${p.path}=${JSON.stringify(p.value)}`).join('  ') : 'no config keys');
    };
    const runCacheCmd = (arg: string): void => {
      const v = String(arg ?? '').trim().toLowerCase();
      const cur = (config.cache as { enabled?: boolean } | undefined)?.enabled;
      if (v === 'on' || v === 'off') {
        const next = v === 'on';
        saveConfigSetting('cache.enabled', next);
        config.cache = { ...((config.cache as object) ?? {}), enabled: next };
        toast.showMessage(`cache ${next ? 'on' : 'off'}`);
      } else {
        toast.showMessage(`cache ${cur ? 'on' : 'off'}`);
      }
    };
    // Base host commands (the BASE_COMMANDS metadata has no `run`). Dispatches
    // the unprefixed names to the ctx closures; plugin commands carry their own
    // `run` and are dispatched separately. `:quit`/`:clear` stay works — they
    // are base commands here (a plugin's namespaced `core:quit` also works via
    // its own `run`).
    const runHostCommand = (name: string, arg: string): void => {
      switch (name) {
        case 'quit': case 'q': onExit(); break;
        case 'clear': case 'clear-cache': services.clearCache(); toast.showMessage('Cache cleared'); break;
        case 'config': runConfigCmd(arg); break;
        case 'cache': runCacheCmd(arg); break;
        case 'help': case '?': setHelpModalOpen(true); break;
        case 'keycaps': toggleKeycaps(arg); break;
        // A typo is answered, not swallowed: silence after Enter reads as a hang.
        default: if (name) toast.showMessage(`Unknown command: ${name} — try :help`);
      }
    };

    // Host fallback for the two-phase dispatch result: `:` toggles the command
    // line, Enter runs the command, Esc closes it, arrow/type edits it, `q`/Ctrl+c
    // exits, `x` clears the cache, `b` opens the browser (no target in a
    // tracker-agnostic host — consumes the key, defers the URL to a tracker).
    // One completer for what is drawn and for what Tab does, so they cannot disagree.
    const completeLine = (text: string) => completeCommand(text, commandRegistry as never, config, hostConfigSchema);
    const hostFallback = (key: InputKey): boolean => {
      const name = key.name ?? '';
      // `:` OPENS the command line (when it is closed). It must NOT toggle it
      // closed again — with the box open, `:` should be treated as a regular key
      // (so a command containing a colon, or a stray `:`, edits the buffer rather
      // than discarding what was typed); closing the box is ESC's job. The old
      // toggle behaviour made `:help` close the line you had just typed — a real
      // runtime defect.
      if (isKey(keys.commandLine, name) && !cmdline.current.open) {
        cmdline.current.open = true;
        ui.cmdOpen = true;
        notify();
        return true;
      }
      // While the command line is open, Esc closes it and every other key edits
      // the input. The global one-shot actions (q/x/b) apply to the CLOSED state
      // only — with the box open they must type into `:back`/`:quit` instead of
      // firing quit/clearCache/openBrowser (a real runtime defect).
      if (cmdline.current.open) {
        if (isKey(keys.back, name)) {
          cmdline.current.open = false;
          ui.cmdOpen = false;
          // Discard the half-typed buffer on close so the next `:` opens fresh.
          cmdline.current.input = '';
          cmdline.current.historyIdx = cmdline.current.history.length;
          notify();
          return true;
        }
        // With the line open, `:` is a NO-OP: it is the OPEN key, the line is
        // already open, so it must neither toggle it closed nor print itself into
        // the buffer (a command token stays clean — `:help` remains `help`, not
        // `help:`). Closing the line is ESC's job.
        if (isKey(keys.commandLine, name)) return true;
        // Enter/Return runs a command. This is a HOST concern — it must not depend on
        // the plugin-namespaced `open` action: tracker defines `open:'enter'`
        // (open an issue), which overrides the host's `open:['enter','return']`
        // in buildKeys and drops `return` — yet the real TTY reports Enter as
        // `{name:'return'}` (see TtyBackend). Relying on isKey(keys.open, name)
        // there made `:help`/`:ask` silently dead on Enter in a real terminal
        // while working in a headless probe that pressed `enter`. Check the key
        // directly.
        if (name === 'return') {
          const input = cmdline.current.input.trim();
          // The command is the FIRST WORD; the rest is its argument. Looking up the
          // whole line instead would fail to find every plugin command given an
          // argument — `:ask hi`, a tracker's `:open ABC-1` — and fall through to the
          // host's own dispatch, which knows nothing of it and says nothing.
          const [head = '', ...rest] = input.split(/\s+/);
          const cmd = findIn(commandRegistry, head);
          const arg = rest.join(' ');
          // The command context carries the REAL closures (F1): setView/back
          // mutate ui state + notify, setHelpModal opens core's help modal via
          // host.store.help, runConfigCommand/runCacheCommand route to the
          // config/cache handlers. Before, most were no-ops/absent, so
          // `:help`/`:config`/`:back`/`:cache`/`:view` were silent.
          const ctx = {
            showMessage: (m: string) => toast.showMessage(m),
            setView: (v: string) => { ui.view = v; notify(); },
            onExit,
            back: () => { ui.view = undefined; notify(); },
            clearCache: () => services.clearCache(),
            runConfigCommand: (a: string) => runConfigCmd(a),
            runCacheCommand: (a: string) => runCacheCmd(a),
            setHelpModal: (open: boolean) => setHelpModalOpen(open),
            toggleKeycaps: (a: string) => toggleKeycaps(a),
            // `:ask`/`:chat` route to the assistant plugin's live `openChat`,
            // published on the shared host.store.chat by its ChatModal (the same
            // bridge pattern setHelpModal uses for the help modal). Absent until
            // the chat surface mounts — the optional chaining makes it a no-op,
            // exactly like the other not-yet-mounted plugin channels.
            openChat: (t?: string) => (hostBase.store as { chat?: { openChat?: (t?: string) => void } } | undefined)?.chat?.openChat?.(t),
          };
          if (cmd?.run) {
            try {
              // A plugin command (`tracker:open`) forwards its `run(ctx, arg)` into a
              // plugin-specific ctx (TrackerCommandCtx). The base ctx carries only
              // host-owned closures — a `:open`/`:board` would find no `openIssue`
              // and silently no-op. Extend it with the OWNING plugin's own-key
              // services (mutated live by its mount) so tracker commands reach real
              // nav/modals; the host base closures stay on top (name collisions win
              // for the host — `showMessage` stays the toast, not a plugin no-op).
              const ctxForCmd = commandContextFor(cmd, ctx, apiMap as never);
              cmd.run(ctxForCmd as never, arg);
            } catch {
              // A failing host command must not crash the shell.
            }
          } else {
            // Base commands (BASE_COMMANDS) have no `run` — dispatch by name.
            runHostCommand(cmd?.name ?? head, arg);
          }
          // Remember the executed command (no empty lines) and CLEAR the buffer so
          // the next `:` opens fresh — before, the leftover input was shown again
          // on the next open (a real defect).
          // A command that says `history: false` (its argument may be a secret) is not.
          if (input && cmd?.history !== false) cmdline.current.history.push(input);
          cmdline.current.historyIdx = cmdline.current.history.length;
          cmdline.current.input = '';
          cmdline.current.open = false;
          ui.cmdOpen = false;
          notify();
          return true;
        }
        // Up/Down recall the `:`-command history (the executed commands above).
        // Up walks back toward the oldest entry, Down toward the newest; past the
        // newest you land back on the live edit buffer. historyIdx starts at
        // history.length (buffer), so Up immediately recalls the newest entry.
        if (name === 'up') {
          const h = cmdline.current.history;
          if (h.length && cmdline.current.historyIdx > 0) {
            cmdline.current.historyIdx -= 1;
            cmdline.current.input = h[cmdline.current.historyIdx];
            notify();
          }
          return true;
        }
        if (name === 'down') {
          const h = cmdline.current.history;
          if (cmdline.current.historyIdx < h.length) {
            cmdline.current.historyIdx += 1;
            cmdline.current.input = h[cmdline.current.historyIdx] ?? '';
            notify();
          }
          return true;
        }
        // Tab takes the completion offered inline, then walks the other candidates
        // (config/commandline.ts). It replaces the WORD being completed — a command
        // name, or a `config get|set|unset` argument.
        if (name === 'tab') {
          const next = lineTab(cmdline.current.input, cmdline.current.walk, completeLine);
          cmdline.current.input = next.input;
          cmdline.current.walk = next.walk;
          notify();
          return true;
        }
        if (name === 'backspace') {
          cmdline.current.input = cmdline.current.input.slice(0, -1);
          notify();
          return true;
        }
        // A character, not a chord: Ctrl+D or Alt+x typed no `d` / `x` into the line.
        if (isPrintable(key as never)) {
          cmdline.current.input += name;
          notify();
          return true;
        }
        return true;
      }
      // Command line closed: the global host action keys fire here.
      if (isKey(keys.quit, name)) {
        onExit();
        return true;
      }
      if (isKey(keys.back, name)) {
        ui.cmdOpen = false;
        notify();
        return true;
      }
      // `x` flushes the cache only while the footer offers it — while a plugin that
      // keeps something there is on screen. `:clear` works from anywhere.
      if (isKey(keys.clearCache, name) && cacheInPlay(plugins, apiMap)) {
        services.clearCache();
        toast.showMessage('Cache cleared');
        return true;
      }
      // `openBrowser` (b), `prev`, `next` and `open` are NOT handled here: the host only
      // gives them a default so plugins share one vocabulary.
      return false;
    };

    // Ctrl+C / Ctrl+D / Ctrl+Z take a second press, everywhere in the app
    // (src/runtime/exit-keys.ts). The arm is the host's, one for the whole screen; the
    // chat draws its hint on its status line (`services.armedHint`), any other screen
    // on the bottom row.
    const setArm = (next: Arm) => {
      armRef.current = next;
      if (armTimer.current) { clearTimeout(armTimer.current); armTimer.current = null; }
      if (next) armTimer.current = setTimeout(() => { armRef.current = null; armTimer.current = null; (services as unknown as HostServices).armedHint = ''; notify(); }, ARM_MS);
      (services as unknown as HostServices).armedHint = armHint(next);
    };
    useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current); }, []);
    const chatStore = () => (hostBase.store as { chat?: ChatStore } | undefined)?.chat;

    // Step 1 of the host's key path (`HostKeyPath`): the host's own keys, before any
    // component on screen. A flowtty component takes the keys it acts on (a focused
    // list takes what is typed as its filter), and one in a
    // plugin's screen would otherwise keep the person from the chat.
    keyPath.first = (k, popup) => {
      // A popup open over the screen has every key but the exit keys: they arm and fire
      // as everywhere else, and nothing under the popup is asked.
      // The three keys flowtty lets an app take before the terminal backend acts
      // (exit, exit, suspend). Taken here, before any handler: the y/n pause, an open
      // question and a modal's catch-all consume EVERY key, and would otherwise
      // swallow the only key that quits. The chat speaks first — Ctrl+C stops a turn
      // that is running, Ctrl+D in a field with text is the editor's forward delete.
      const armKey = armKeyOf(k);
      if (armKey) {
        // The `:` line owns the keyboard while it is open: the chat's field is not asked.
        const claim = ui.cmdOpen || popup ? undefined : chatStore()?.ctrlKey?.(k);
        if (claim === 'handled') { setArm(null); notify(); return true; }
        if (claim !== 'field') {
          const step = armStep(armRef.current, armKey, Date.now());
          setArm(step.arm);
          notify();
          if (!step.fire) return true;
          // The second press. Ctrl+Z is let through: the backend hands the terminal
          // back and stops the process, and repaints on `fg`. Ctrl+C / Ctrl+D leave
          // the way `:quit` does.
          if (armKey === 'z') return false;
          onExit();
          return true;
        }
        // The field's: the chat's editor deletes forward. Consumed whatever the
        // editor made of it — let through, the backend would exit.
        setArm(null);
        if (twoPhaseDispatch(inputRegistryRef.current, ui, k, () => hostFallback(k))) notify();
        return true;
      } else if (armRef.current && !isMouseButton(k.name)) {
        setArm(null);
        notify();
      }
      if (popup) return undefined;
      // Ctrl+] moves the keyboard between the chat and the plugin, and the collapse key
      // folds the docked chat away and back. Taken here, before any handler, as the
      // exit keys are: a plugin that consumes every key, or one of its modals, must
      // never be able to keep the person from the chat. Not while the `:` line is
      // open, though: it owns the keyboard then (as with the exit keys above), and a
      // chat opened over it would leave what is typed going into a line nobody sees.
      const chat = chatStore();
      const panelKey = ui.cmdOpen ? null : isKey(keys.chatFocus ?? [], k) ? 'focus' : isKey(keys.chatCollapse ?? [], k) ? 'collapse' : null;
      if (panelKey && chat?.panelKey?.(panelKey)) { notify(); return true; }
      // A press anywhere tells the chat which pane it landed in (the keyboard follows
      // it). The button goes on its usual path: a click in the panel may open a fold, and a
      // drag still selects.
      if (k.name === 'mousedown' && typeof k.x === 'number' && typeof k.y === 'number') chat?.pointer?.(k.x, k.y);
      return undefined;
    };
    // Step 3: the host's key path, for a key no component took. A handled key is
    // followed by a redraw: a plugin keeps its state in one component and draws it in a
    // sibling, and the sibling redraws when the HOST does.
    // `twoPhaseDispatch`'s true means "handled — redraw", not "consume": the chat
    // answers true for every key. So nothing is consumed here.
    keyPath.last = (k) => {
      if (twoPhaseDispatch(inputRegistryRef.current, ui, k, () => hostFallback(k))) notify();
      return undefined;
    };

    // The header, the content slot (host has no single base surface yet — a
    // placeholder the overlay may sit over), the plugin overlay, and the bottom
    // line (command line / toast message / footer hints).
    // Footer hints: the host base (`: commands`, plus `quit` if config binds it to a
    // key) + each plugin's non-empty `keycaps({ ui, host })`. A plugin returns `[]` when
    // its surface is inactive, so an empty screen collapses to `: commands`; `x flush
    // cache` joins only while a plugin that caches is on screen. Each plugin's pair
    // comes from `apiMap`, built by `overlayComps`; its services and store are mutated
    // live, so reading them here each render stays fresh.
    const { width: termWidth, height: termHeight } = useTerminalSize();
    // Where the chat is. Docked (`panel`), the terminal is split between the plugin's
    // side — title bar, surface, footer, always at the top-left corner — and the
    // chat's; in `window` and `full` the chat is drawn over the whole terminal while it
    // is open, and the plugin's side is all of it.
    const chat = chatStore();
    const assistantCfg = (config.plugins as Record<string, Record<string, unknown> | undefined> | undefined)?.assistant;
    const mode: ChatMode | null = chat ? chat.mode ?? chatModeOf(assistantCfg) : null;
    const panelCfg = (assistantCfg?.panel as { side?: unknown; size?: unknown } | undefined) ?? {};
    let layout: PanelLayout | null = mode === 'panel'
      ? panelLayout({ width: termWidth, height: termHeight, ...panelCfg, collapsed: !chat?.open })
      : null;
    // A question or a y/n the open chat must show whole: the panel is given the rows it
    // needs at the width it has — or, when that would leave the plugin less than its
    // least, the chat is a window until it is answered.
    const need = layout && chat?.open ? chat.needRows?.(layout.panel.width) ?? 0 : 0;
    if (layout && need > layout.panel.height) layout = panelLayout({ width: termWidth, height: termHeight, ...panelCfg, collapsed: false, need });
    // A terminal too small for the panel's least and the plugin's is laid out as for a
    // window, for as long as it is that small: `chatDock` is null, and the chat reads
    // that as being drawn as a window (src/runtime/panel-layout.ts, `fits`).
    const dock: PanelLayout | null = layout?.fits ? layout : null;
    (services as unknown as HostServices).chatDock = dock;
    const region = dock ? dock.region : { width: termWidth, height: termHeight };
    // The side with the keyboard is marked: the chat's frame in its accent, or — the
    // plugin's side — the title bar in the same colour.
    const pluginFocused = !!dock && !dock.collapsed && chat?.focus === 'plugin';
    const chatAccent = ((config.theme as Theme | undefined)?.modals as Record<string, { accent?: string }> | undefined)?.chat?.accent;
    const hints = composeFooterHints(plugins, apiMap, keys).join(' · ');
    const surfaceActive = (p: PluginShape): boolean => {
      const kc = (p as Plugin).keycaps;
      const api = apiMap[p.name];
      return !kc || !api ? true : kc(api).length > 0;
    };
    const atHome = !overlayComps.some((c) => c.surface && surfaceActive(c.plugin));

    const title = String((config.app as { title?: string } | undefined)?.title ?? 'flow-assist');
    // `bottom` is the command-line buffer (with a leading `: `), the active toast,
    // or the footer hints — which START with `: commands` (part of the host base),
    // so no extra `: ` literal is prepended here.
    // An armed Ctrl+C / Ctrl+D / Ctrl+Z says so first; the open chat says it on its own
    // status line instead.
    const armed = chat?.open && !pluginFocused ? '' : (services as unknown as HostServices).armedHint;
    // Collapsed on the right, the chat's running turn says what it is doing here; so does
    // a closed window's (or full chat's) y/n or question left waiting. A bottom panel
    // says it on its own strip.
    const status = chat && !chat.open && (dock ? dock.side === 'right' : true) && !armed && !toast.message ? chat.statusRow : null;
    const bottom = armed || toast.message || hints;
    // The command line completes INLINE, on its own one row: the untyped rest of the
    // suggestion after the caret, the other candidates beside it. A second row of
    // candidates appearing and vanishing under the line with every keystroke would
    // jump the whole screen by a row each time.
    const line = cmdline.current.open ? lineView(cmdline.current.input, cmdline.current.walk, completeLine) : null;

    const isChat = (c: { key: string }) => c.key === 'assistant:chat';
    const chatComp = overlayComps.find(isChat);
    // What floats over the whole terminal, the chat included: a fired reminder, and the
    // keycaps panel (the keys being pressed, wherever they go).
    const isTop = (c: { key: string }) => c.key in TOP_LAYER;
    // A layer of no size of its own, at one corner of the terminal: what it holds places
    // itself from that corner, and the layer takes no room — and no pointer: a box that
    // covered the screen would be what every drag started in, and no pane's own
    // selection bounds would hold.
    const layer = (corner: 'topLeft' | 'bottomRight') =>
      h(Box, { position: 'absolute', top: corner === 'topLeft' ? 0 : termHeight, left: corner === 'topLeft' ? 0 : termWidth, width: 0, height: 0, zIndex: 6 },
        overlayComps.filter((c) => TOP_LAYER[c.key] === corner).map(({ Comp, key }) => h(Comp as any, { key })));
    // Two slots, in every mode and in the same order — only their props change. A
    // component that moved from one parent to another would be mounted anew, and the
    // chat would lose the turn it is writing, the draft and the queue with every
    // `/mode`; so would a plugin's screen.
    const panelBox = dock
      ? { width: dock.panel.width, height: dock.panel.height, flexShrink: 0, overflow: 'hidden' as const }
      // Over everything: the chat's own window is laid out over the whole terminal
      // (and steps the screen behind it back). Closed, it takes no room at all.
      : chat?.open
        ? { position: 'absolute' as const, top: 0, left: 0, width: termWidth, height: termHeight, zIndex: 5 }
        : { position: 'absolute' as const, top: 0, left: 0, width: 0, height: 0 };
    const panelArea = dock ? { width: dock.panel.width, height: dock.panel.height } : { width: termWidth, height: termHeight };
    return h(
      Box,
      { flexDirection: dock?.side === 'right' ? 'row' : 'column', width: termWidth, height: termHeight },
      h(HostChords, { path: keyPath }),
      h(AreaContext.Provider, { value: region },
      // The plugin's side of the screen. A drag that starts here stays here — never
      // into the panel beside it.
      h(Box, { flexDirection: 'column', width: region.width, height: region.height, flexShrink: 0, overflow: 'hidden', selectionScope: true },
      // The title bar names the app over a guest's screen; the start screen says it itself.
      // Chrome, not text: a drag that runs over the title bar or the footer copies
      // nothing from them.
      atHome ? h(Box, { height: 1 }) : h(Box, { padding: 1, selectable: false }, h(Text, { bold: true, ...(pluginFocused ? { color: chatAccent } : {}) }, title)),
      // A plugin is a guest: its surface takes the screen only while the plugin says
      // its context is active — `keycaps` non-empty, which is already the
      // contract ("returns [] when its surface is inactive"). Until then the screen
      // is the host's own. A plugin with no `keycaps` cannot say, and keeps the old
      // behaviour of being shown always.
      // `zIndex: 1` — the content is a layer ABOVE the footer. flowtty stacks by
      // zIndex only among siblings, so a floating panel inside it (the keycaps, at the
      // bottom right) lost to the footer — drawn later, one level up — whatever its
      // own zIndex, and the footer's text ran over the panel's frame. It also puts
      // the footer under a modal's dimmed backdrop, like everything else behind it.
      h(Box, { flexGrow: 1, zIndex: 1 },
        overlayComps.filter((c) => !isChat(c) && !isTop(c) && (!c.surface || surfaceActive(c.plugin))).map(({ Comp, key }) => h(Comp as any, { key })),
        atHome ? renderHome({ title, plugins, keys, builtins: BUILTIN_PLUGINS, width: region.width, pluginsNote }) : null),
      // The bottom row, and the one place on this screen a drag has something to
      // copy: the command the person typed. Marking the box `selectable: false`
      // whole would be right for what surrounds the command, but would swallow the
      // command with it, so a long `:config set …` could not be copied out to be
      // fixed or shared. It follows the rule the chat's rows follow instead (the
      // gutter is chrome, the text is not): the typed text is the only selectable
      // thing here, everything drawn around it says `selectable: false`.
      // `selectionScope` keeps a drag that starts here on this row and inside the
      // padding — it never runs up into the screen above, and the padding cells never
      // come back as spaces around what was copied.
      h(Box, { padding: 1, flexDirection: 'column', selectionScope: true },
        // `dim`, not `dimColor` — the latter is another library's prop; flowtty does
        // not know it, so an `as any` would hide that the footer is never dimmed.
        line
          ? h(Box, { flexDirection: 'row' },
              // The prompt, the inline offer and the candidate list are the host
              // speaking, not text anyone asked for: a copy of the command line is
              // what was typed and nothing else.
              h(Text, { bold: true, color: 'cyan', selectable: false }, ': '),
              h(Text, null, cmdline.current.input),
              // The caret sits ON the first offered character, as in the chat's field.
              line.ghost
                ? [h(Text, { key: 'g0', inverse: true, dim: true, color: 'cyan', selectable: false }, line.ghost[0]), h(Text, { key: 'g1', dim: true, color: 'cyan', selectable: false }, line.ghost.slice(1))]
                : h(Text, { inverse: true, selectable: false }, ' '),
              // What the offered candidate's label says (a value declared as
              // `{ value, label }`): said, dim, never part of the command.
              line.label ? h(Text, { dim: true, wrap: 'truncate', selectable: false }, ` ${line.label}`) : null,
              line.others.length ? h(Text, { dim: true, wrap: 'truncate', selectable: false }, `  ${keyGlyph('tab')} ${line.others.slice(0, 12).join(' · ')}`) : null)
          : status
            ? h(Box, { flexDirection: 'row', selectable: false }, status as never, h(Text, { dim: true, wrap: 'truncate' }, ` · ${bottom}`))
            : h(Text, { dim: true, selectable: false }, bottom),
      ))),
      h(AreaContext.Provider, { value: panelArea },
        h(Box, panelBox, chatComp ? h(chatComp.Comp as any, { key: chatComp.key }) : null)),
      h(AreaContext.Provider, { value: { width: termWidth, height: termHeight } }, layer('topLeft'), layer('bottomRight')),
    );
  }

  // A drag over the screen selects and, on release, copies (flowtty's copy-on-select;
  // the backend has the mouse on unless `ui.mouse` is false). `onCopy` is read through
  // `services`, whose toast the App rebinds on every render.
  // A <DialogHost> at the root: a plugin's `ui.Select` opens its popup through it (a
  // floating dialog anchored under the field, in frame cells — which is why it sits at
  // the frame's origin). While a popup is open every key is the popup's but the exit
  // keys (`HostKeyPath`).
  return render(h(Fragment, null, h(DialogHost, null, h(App)), h(HostExit, { path: keyPath })), hostKeyed(root, keyPath), {
    onCopy: (event) => onCopySelection(event, {
      say: (msg) => (services as unknown as ReactBoundServices).showMessage(msg),
      fallback: (text) => copyToClipboard(text),
    }),
  });
}

// What a finished copy does beyond flowtty's own clipboard write. It fires for every
// copy, delivered or not; only a DRAG is handled here — an api copy
// (`services.copy`) already ran the fallback and its caller says what it copied.
// Where no clipboard sequence went out (Apple Terminal has no OSC 52) the platform's
// tool takes the text. It never throws: flowtty calls it on the key path, and a throw
// would take the app down through its error path.
export function onCopySelection(
  { text, delivered, source }: CopyEvent,
  { say, fallback }: { say: (msg: string) => void; fallback: (text: string) => { ok: boolean; error?: string } },
): void {
  if (source !== 'selection') return;
  try {
    const done = delivered ? { ok: true } : fallback(text);
    say(done.ok ? `Copied ${Array.from(text).length} chars` : `Copy failed — ${done.error ?? 'no clipboard'}`);
  } catch (err) {
    try { say(`Copy failed — ${err instanceof Error ? err.message : String(err)}`); } catch { /* nothing left to tell */ }
  }
}