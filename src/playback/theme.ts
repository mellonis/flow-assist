// Theme / colors (config-driven). Plugin colors come from the theme, not from
// hardcoded values. A value may be a bare color name ("green") or a reference to
// a theme token ("${selected}"). References expand recursively (a token may point
// to another); an unknown token is returned as-is — that is the "no such color in
// the theme" escape hatch, where the plugin provides a literal color instead.

// The default theme the modals resolver builds on. `modals` is the ABSTRACT base
// any modal can reuse (bg/border/borderBg/text/selected/fieldBg/fieldBorder) — a
// plugin modal (log/tags/...) takes it as-is. Per-modal differences (the colored
// border of relation/delete/story/sprint, chat.userBg) live in MODAL_COLOR_DEFAULTS
// and per-plugin colors; the user's config.theme overrides on top.
export interface Theme {
  [key: string]: unknown;
  // `modals` carries BOTH the flat abstract base props (bg/border/borderBg/text/
  // selected/fieldBg/fieldBorder — a single string each) and the per-modal palettes
  // (chat/log/relation/... — a Record of props). It starts as the flat base and
  // resolveModalPalettes extends it with the named palettes.
  modals?: Record<string, string | Record<string, string>>;
}

export const DEFAULT_THEME: Theme = {
  // Abstract base of ANY modal: the common look a plugin may reuse. Concrete
  // modals (chat/log/relation/delete/story/sprint) are resolved later in
  // resolveModalPalettes on top of this base, where only their differences are set.
  modals: {
    bg: 'black',
    border: 'cyan',
    borderBg: 'black',
    text: 'white',
    selected: 'green',
    fieldBg: 'gray',
    fieldBorder: 'cyan',
  },
  selected: 'green',
  error: 'red',
  success: 'green',
};

export function resolveColorRefs(value: unknown, theme: Theme = {}): string {
  if (typeof value !== 'string' || !value.includes('${')) return value as string;
  return value.replace(/\$\{([^}]+)\}/g, (_, token: string) => {
    const resolved = resolveColorRefs(theme[token], theme);
    return resolved ?? `\${${token}}`;
  });
}

// Plugin palette: the plugin default (plugin.colors) with the config override
// (config.plugins.<name>.colors) on top, both with ${token} support.
export interface ResolveConfig {
  plugins?: Record<string, { colors?: Record<string, string> }>;
}

export function resolvePluginColors(
  plugin: { name?: string; colors?: Record<string, string> } | undefined,
  theme: Theme = {},
  config: ResolveConfig = {},
): Record<string, string> {
  const defaults = plugin?.colors ?? {};
  const override = config.plugins?.[plugin?.name ?? '']?.colors ?? {};
  const out: Record<string, string> = {};
  const keys = new Set([...Object.keys(defaults), ...Object.keys(override)]);
  for (const key of keys) {
    const raw = Object.prototype.hasOwnProperty.call(override, key) ? override[key] : defaults[key];
    if (raw !== undefined) out[key] = resolveColorRefs(raw, theme);
  }
  return out;
}

// Appearance of specific modals on top of the abstract base (DEFAULT_THEME).
// The base is shared; here is only what differs (usually the border color,
// sometimes selected). Plugin modals (log/tags/...) take the base as-is.
// Overrides come from config.plugins.<name>.colors (with ${} support).
export const MODAL_COLOR_DEFAULTS: Record<string, Record<string, string>> = {
  log: {},
  // userBg — the background of the user-message bubble in the chat (Text carries
  // no background; the full-width Box wrappers in the render carry it). Overridable
  // via config.plugins.chat.colors.userBg. If removed the background disappears,
  // leaving only the separators and the sticky dump without a background.
  // The chat's own colours, every one overridable via config.plugins.assistant.colors:
  //   accent   — the `›` prompt, shared by the input field and the person's messages
  //   shell    — the `!` prompt of shell mode and the `$ ` marker on a command's
  //              result — the same colour for both, so a shell command reads as one
  //              thing from the moment it is typed to the moment its output appears
  //   userBg   — the ground under the person's messages
  //   fieldBg  — the ground under the input field
  //   assistantAccent — the `ƒ` mark on the assistant's answers
  //   bgAccent / bgBg — the `◆` marker and ground of a background-task result
  //   warn     — things waiting on the person (the queue); ok — finished work
  chat: { userBg: '#2b2b40', accent: 'cyan', shell: 'magentaBright', assistantAccent: 'green', fieldBg: '#1f1f2e', bgAccent: 'magenta', bgBg: '#2a2438', warn: 'yellow', ok: 'green' },
  relation: { border: 'blue' },
  delete: { border: 'red' },
  story: { border: 'green', selected: 'yellow' },
  sprint: { border: 'magenta' },
};

// Resolves the abstract modal base into concrete palettes by name: base + modal
// default (MODAL_COLOR_DEFAULTS) + plugin colors + config.plugins.<name>.colors
// override — all with ${token} expansion. Modal renders keep reading
// theme.modals.<name>.<prop>, so they do not need to change.
export function resolveModalPalettes(
  theme: Theme = DEFAULT_THEME,
  plugins: { name?: string; colors?: Record<string, string> }[] = [],
  config: ResolveConfig = {},
): Theme {
  const base = theme.modals ?? {};
  const modals: Record<string, string | Record<string, string>> = { ...base };
  for (const name of Object.keys(MODAL_COLOR_DEFAULTS)) {
    const plugin = plugins.find((p) => p.name === name);
    const defaults = { ...(MODAL_COLOR_DEFAULTS[name] ?? {}), ...(plugin?.colors ?? {}) };
    const override = config.plugins?.[name]?.colors ?? {};
    const merged = { ...base, ...defaults, ...override };
    modals[name] = Object.fromEntries(
      Object.entries(merged).map(([k, v]) => [k, resolveColorRefs(v, theme)]),
    );
  }
  return { ...theme, modals };
}

// Resolves the config.theme the renderers read: the abstract base (DEFAULT_THEME)
// merged with the user's config.theme on top, then resolveModalPalettes lays the per-modal palettes down (base +
// MODAL_COLOR_DEFAULTS + plugin colors + config.plugins.<name>.colors), and
// resolvePluginColors adds any non-modal plugin palette (keycaps/bg, board).
// Returns the resolved theme the caller folds back into config.theme, so
// ft.config.theme carries the full palette and the renders get borders/colors
// instead of degrading to empty Flowtty defaults. `plugins` provides the
// plugin.colors sources; `config` the config.plugins.<name>.colors overrides.
export function resolveAppTheme(
  configTheme: Theme | undefined,
  plugins: { name?: string; colors?: Record<string, string> }[] = [],
  config: ResolveConfig = {},
): Theme {
  const merged: Theme = { ...DEFAULT_THEME, ...(configTheme ?? {}) };
  const resolved = resolveModalPalettes(merged, plugins, config);
  for (const p of plugins) {
    if (p.colors) resolved[p.name ?? ''] = resolvePluginColors(p, resolved, config);
  }
  return resolved;
}