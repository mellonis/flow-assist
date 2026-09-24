// Plugin factory. Each plugin module (`src/loader/plugins/*` or the host's
// plugins-enabled/) exports a `build<X>Plugin({ renders, config, make })` and
// wraps its shape in `make`, which injects the name, the config slice
// (`config.plugins.<name>`) and the `keys` field (default hotkeys; `[]` =
// disabled). Extracted into its own module so the registry (`registry.ts`) and
// the plugins themselves can both import it without a cycle.
import type { ContextItem } from '../assistant/screen-context.js';

export type { ContextItem };

// Input shape — the plugin author supplies this; `make` fills in the host-owned
// fields (`name`, `config`, `keys`). `keyActions` is a legacy alias for `keys`;
// `modals` is accepted but not part of the resolved `Plugin` contract.
export type PluginShape = {
  name: string;
  commands?: Command[];
  keys?: Record<string, string | string[]>;
  keyActions?: Record<string, string | string[]>;
  views?: Record<string, unknown>;
  // How the blocks this plugin's tools report are drawn: kind → renderer, qualified
  // `<plugin>:<kind>` by the host (docs/plugins.md, "Showing what a tool does").
  viewRenderers?: Record<string, (data: unknown, ctx: unknown) => unknown>;
  surface?: string;
  modals?: string[];
  colors?: Record<string, string>;
  // Per modal the plugin draws, what its palette differs in from the modal base
  // (`{ relation: { border: 'blue' } }`); resolved into `theme.modals.<modal>`, and
  // overridable by the person via config.plugins.<modal>.colors.
  modalColors?: Record<string, Record<string, string>>;
  configSchema?: unknown;
  components?: Record<string, (api: unknown) => unknown>;
  tools?: unknown[];
  services?: Record<string, unknown>;
  aiTools?: unknown[];
  // Context-aware footer hints: a function of `{ ui, host }` returning the `<key>: <label>`
  // hints for the plugin's CURRENT context, or `[]` when its surface is inactive.
  // The host footer = its base (`: commands`) + concat of each plugin's
  // non-empty `keycaps`. Optional — absent/null means `() => []`.
  // The key in a hint is `host.keyCap('<action>')` — the cap of what the action is
  // bound to NOW — never a letter written in the plugin: the person can remap it,
  // and the hint would then name a key that does nothing. `''` means unbound: show
  // no hint for it.
  keycaps?: (api: unknown) => string[];
  // The key actions that lead INTO the plugin from the host's start screen (e.g.
  // `['boardPicker']`). The start screen names these beside the plugin; without
  // `entry` it lists every key the plugin binds.
  entry?: string[];
  // One line saying what the plugin is — shown on the start screen. Taken from the
  // plugin's manifest.json when the shape does not set it.
  description?: string;
  // Whether the plugin keeps data in `services.cache` (default true). The footer
  // offers "flush cache" only while such a plugin is showing hints; a plugin with
  // nothing in the cache says `false`, so its hint does not advertise one.
  usesCache?: boolean;
  // A per-plugin setup hook the host calls ONCE with the plugin's `{ ui, host }` before any
  // of its components mount. A plugin uses it to seed its cross-component store
  // channel (e.g. tracker's `createTrackerStore(host)`), so hooks that read the
  // store during render never see an uninitialized one.
  setup?: (api: unknown) => unknown;
  // What the plugin's screens show right now, as items the model reads and the chat's
  // title names: `{ label: 'Board: Frontend', text: 'filter: mine · cursor on ABC-12' }`.
  // Asked before every request; the host sanitizes and caps them and frames them as
  // data (docs/plugins.md, "The chat's two hooks"). `[]` / `null` — nothing on screen.
  chatContext?: (api: unknown) => ContextItem[] | null | undefined;
  // Deprecated — `chatContext` replaces it: one short id of what the screen is about,
  // read as a single item with no text. Ignored when the plugin has `chatContext`.
  chatSubject?: (api: unknown) => string | null | undefined;
  // Called after a chat turn in which a write tool was confirmed and applied, so a
  // plugin reloads what it shows — otherwise the screen keeps the text from before
  // the write. May return a promise; a failure is logged.
  afterWrite?: (api: unknown) => unknown;
};

// A plugin command. The host prefixes the command name at load time; the base
// fields (`usage`/`minArgs`/`maxArgs`/`description`/`run`) are optional because
// a plugin command may rely on being merged with a base command of the same name
// (source behaviour) or declare only `name` + `run`.
export type Command = {
  name: string;
  aliases?: string[];
  usage?: string;
  minArgs?: number;
  maxArgs?: number;
  description?: string;
  // `false` keeps the command out of the `:` line's ↑/↓ history — for a command whose
  // argument may carry a secret (a token, a header). Declared, never decided per call.
  history?: boolean;
  run?: (ctx?: unknown, arg?: string) => unknown;
};

// Resolved plugin — `make`'s output. `config` is the plugin's config slice,
// `keys` is the normalized binding map (`Record<string, string[]>`).
export interface Plugin {
  name: string;
  config: Record<string, unknown>;
  keys: Record<string, string[]>;
  commands?: Command[];
  views?: Record<string, unknown>;
  // How the blocks this plugin's tools report are drawn: kind → renderer, qualified
  // `<plugin>:<kind>` by the host (docs/plugins.md, "Showing what a tool does").
  viewRenderers?: Record<string, (data: unknown, ctx: unknown) => unknown>;
  surface?: string;
  colors?: Record<string, string>;
  modalColors?: Record<string, Record<string, string>>;
  configSchema?: unknown;
  components?: Record<string, (api: unknown) => unknown>;
  tools?: unknown[];
  services?: Record<string, unknown>;
  aiTools?: unknown[];
  keycaps?: (api: unknown) => string[];
  entry?: string[];
  description?: string;
  usesCache?: boolean;
  setup?: (api: unknown) => unknown;
  chatContext?: (api: unknown) => ContextItem[] | null | undefined;
  chatSubject?: (api: unknown) => string | null | undefined;
  afterWrite?: (api: unknown) => unknown;
}

export type MakeFactoryConfig = {
  plugins?: Record<string, Record<string, unknown>>;
};

// Returns a `make(name, shape)` function that closes over `config`. `make`
// injects the plugin name, its config slice (`config.plugins.<name>`) and the
// `keys` field (default hotkeys; `keyActions` is the legacy alias for `keys`).
// `[]` = the action is disabled.
export function makeFactory(config: MakeFactoryConfig = {}) {
  return (name: string, shape: PluginShape): Plugin => ({
    ...shape,
    name,
    config: config.plugins?.[name] ?? {},
    keys: (shape.keys ?? shape.keyActions ?? {}) as Record<string, string[]>,
  });
}

export type Make = ReturnType<typeof makeFactory>;