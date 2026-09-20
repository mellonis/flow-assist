// Plugin factory. Each plugin module (`src/loader/plugins/*` or the host's
// plugins-enabled/) exports a `build<X>Plugin({ renders, config, make })` and
// wraps its shape in `make`, which injects the name, the config slice
// (`config.plugins.<name>`) and the `keys` field (default hotkeys; `[]` =
// disabled). Extracted into its own module so the registry (`registry.ts`) and
// the plugins themselves can both import it without a cycle.

// Input shape — the plugin author supplies this; `make` fills in the host-owned
// fields (`name`, `config`, `keys`). `keyActions` is a legacy alias for `keys`;
// `modals` is accepted but not part of the resolved `Plugin` contract.
export type PluginShape = {
  name: string;
  commands?: Command[];
  keys?: Record<string, string | string[]>;
  keyActions?: Record<string, string | string[]>;
  views?: Record<string, unknown>;
  surface?: string;
  modals?: string[];
  colors?: Record<string, string>;
  configSchema?: unknown;
  components?: Record<string, (ft: unknown) => unknown>;
  tools?: unknown[];
  services?: Record<string, unknown>;
  aiTools?: unknown[];
  // Context-aware footer hints: a function of `ft` returning the `<key>: <label>`
  // hints for the plugin's CURRENT context, or `[]` when its surface is inactive.
  // The host footer = its base (`: commands · q quit`) + concat of each plugin's
  // non-empty `keycaps(ft)`. Optional — absent/null means `() => []`.
  // The key in a hint is `ft.keyCap('<action>')` — the cap of what the action is
  // bound to NOW — never a letter written in the plugin: the person can remap it,
  // and the hint would then name a key that does nothing. `''` means unbound: show
  // no hint for it.
  keycaps?: (ft: unknown) => string[];
  // The key actions that lead INTO the plugin from the host's start screen (e.g.
  // `['boardPicker']`). The start screen names these beside the plugin; without
  // `entry` it lists every key the plugin binds.
  entry?: string[];
  // Whether the plugin keeps data in `services.cache` (default true). The footer
  // offers "flush cache" only while such a plugin is showing hints; a plugin with
  // nothing in the cache says `false`, so its hint does not advertise one.
  usesCache?: boolean;
  // A per-plugin setup hook the host calls ONCE with the plugin's `ft` before any
  // of its components mount. A plugin uses it to seed its cross-component store
  // channel (e.g. tracker's `createTrackerStore(ft)`), so hooks that read the
  // store during render never see an uninitialized one.
  setup?: (ft: unknown) => unknown;
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
  surface?: string;
  colors?: Record<string, string>;
  configSchema?: unknown;
  components?: Record<string, (ft: unknown) => unknown>;
  tools?: unknown[];
  services?: Record<string, unknown>;
  aiTools?: unknown[];
  keycaps?: (ft: unknown) => string[];
  usesCache?: boolean;
  setup?: (ft: unknown) => unknown;
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