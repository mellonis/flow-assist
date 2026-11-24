// Theme / colors (config-driven). Plugin colors come from the theme, not from
// hardcoded values. A value may be a bare color name ("green") or a reference to
// a theme token ("${selected}"). References expand recursively (a token may point
// to another); an unknown token is returned as-is — that is the "no such color in
// the theme" escape hatch, where the plugin provides a literal color instead.

// The default theme the modals resolver builds on. `modals` is the ABSTRACT base
// any modal can reuse (bg/border/borderBg/text/selected/fieldBg/fieldBorder) — a
// plugin modal (log/tags/...) takes it as-is. Per-modal differences live in
// MODAL_COLOR_DEFAULTS for the host's own modals (chat.userBg, …) and in a plugin's
// `modalColors` for its modals; the user's config.theme overrides on top.
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
  // Grounds a plugin's own screens reference by `${token}`, so they follow the
  // terminal's scheme with the host's windows (a literal colour would not):
  //   panelBg       — a floating panel (the keycaps)
  //   highlightBg   — a highlighted row (the current one)
  //   accentBg      — a stronger highlight (the current column)
  //   highlightText — the ink on either
  panelBg: '#1a1b26',
  highlightBg: '#3c3c3c',
  accentBg: '#20456b',
  highlightText: 'white',
};

// Which scheme the terminal is on, as flowtty reports it (docs/app.md in flowtty —
// the color scheme). It can change while the app runs: macOS switches its
// appearance by itself, and the terminal follows.
export type ColorScheme = 'light' | 'dark' | 'unknown';

// The same palette for a light terminal: light grounds, dark ink.
const LIGHT_THEME: Theme = {
  modals: {
    bg: '#f4f4f6',
    border: 'blue',
    borderBg: '#f4f4f6',
    text: 'black',
    selected: 'green',
    fieldBg: '#e2e2e8',
    fieldBorder: 'blue',
  },
  selected: 'green',
  error: 'red',
  success: 'green',
  panelBg: '#ececf2',
  highlightBg: '#e2e2e2',
  accentBg: '#d4e3f5',
  highlightText: 'black',
};

// While the terminal has not said (and for good where it never does): no grounds and
// no ink of the app's own — the terminal's, which read right on either scheme.
const UNKNOWN_THEME: Theme = {
  modals: {
    bg: 'default',
    border: 'cyan',
    borderBg: 'default',
    text: 'default',
    selected: 'green',
    fieldBg: 'default',
    fieldBorder: 'cyan',
  },
  selected: 'green',
  error: 'red',
  success: 'green',
  panelBg: 'default',
  highlightBg: 'default',
  accentBg: 'default',
  highlightText: 'default',
};

// The base palette for a scheme. Dark is DEFAULT_THEME — the look the host had
// before it could tell.
export function themeFor(scheme: ColorScheme): Theme {
  return scheme === 'light' ? LIGHT_THEME : scheme === 'unknown' ? UNKNOWN_THEME : DEFAULT_THEME;
}

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

// Appearance of the HOST's own modals on top of the abstract base (DEFAULT_THEME).
// The base is shared; here is only what differs. A plugin's modals bring their own
// palettes (`modalColors` in the plugin shape); a modal without one takes the base
// as-is. Overrides come from config.plugins.<modal>.colors (with ${} support).
export const MODAL_COLOR_DEFAULTS: Record<string, Record<string, string>> = {
  log: {},
  // userBg — the background of the user-message bubble in the chat (Text carries
  // no background; the full-width Box wrappers in the render carry it). Overridable
  // via config.plugins.chat.colors.userBg. If removed the background disappears,
  // leaving only the separators and the sticky dump without a background.
  // The chat's own colours, every one overridable via config.plugins.chat.colors:
  //   accent   — the `›` prompt, shared by the input field and the person's messages
  //   shell    — the `!`/`‼` prompt of shell/interactive mode, and a command's own
  //              `! `/`‼ ` marker while it still runs (pulsing) — so a shell command
  //              reads as one thing from the moment it is typed to the moment it
  //              starts; once it ends the marker takes `ok` or the error colour
  //   userBg   — the ground under the person's messages
  //   fieldBg  — the ground under the input field
  //   assistantAccent — the `ƒ` mark on the assistant's answers
  //   bgAccent / bgBg — the `◆` marker and ground of a background-task result
  //   warn     — things waiting on the person (the queue)
  //   ok       — finished work, and a command's marker on exit 0
  //   add / del     — a diff row: what came in, what went out — in the `✎` block, in a
  //              diff the model writes, and in the `/diff` panel alike
  //   addBg / delBg — the ground those rows sit on
  //   idleBorder — the frame of a docked chat while the plugin has the keyboard; with
  //              it, the frame is in `accent`
  //   askBg    — the ground under a kept question and the answer it got: a quiet
  //              slate-teal tint on black, its own band apart from the person's
  //              violet bubble and a background result's plum ground
  //   askInk   — the ink of those rows; a dismissed answer keeps the ground and dims it
  chat: { userBg: '#2b2b40', accent: 'cyan', shell: 'magentaBright', assistantAccent: 'green', fieldBg: '#1f1f2e', bgAccent: 'magenta', bgBg: '#2a2438', warn: 'yellow', ok: 'green', add: 'green', del: 'red', addBg: '#003b00', delBg: '#3b0000', idleBorder: 'gray', askBg: '#243036', askInk: '#dfe8e6' },
};

// The same for a light terminal (light grounds; accents dark enough to read on them) —
// the ask ground is a pale teal over the light `#f4f4f6`, quieter than the person's
// lavender and a background result's pink — and for an unknown one (no grounds of the
// chat's own — a tint on a terminal colour nobody knows would be a blind guess, so the
// ask rows keep the terminal's own).
const LIGHT_MODAL_COLORS: Record<string, Record<string, string>> = {
  log: {},
  chat: { userBg: '#e4e4f0', accent: 'blue', shell: 'magenta', assistantAccent: 'green', fieldBg: '#eaeaf0', bgAccent: 'magenta', bgBg: '#efe4f2', warn: '#9a6700', ok: 'green', add: 'green', del: '#a40000', addBg: '#e6f4e6', delBg: '#fce8e8', idleBorder: '#a0a0b0', askBg: '#e3eeec', askInk: '#2b3f3b' },
};
const UNKNOWN_MODAL_COLORS: Record<string, Record<string, string>> = {
  log: {},
  // On a terminal whose scheme nobody knows, the DIFF bands are not drawn either:
  // `default` is flowtty's "no background" sentinel, so those rows keep the ground
  // they sit on and the `+`/`-` glyphs carry the meaning.
  chat: { ...MODAL_COLOR_DEFAULTS.chat, userBg: 'default', fieldBg: 'default', bgBg: 'default', addBg: 'default', delBg: 'default', askBg: 'default', askInk: 'default' },
};

export function modalColorDefaults(scheme: ColorScheme): Record<string, Record<string, string>> {
  return scheme === 'light' ? LIGHT_MODAL_COLORS : scheme === 'unknown' ? UNKNOWN_MODAL_COLORS : MODAL_COLOR_DEFAULTS;
}

// What a plugin may bring for the palettes: its flat `colors` and, per modal it
// draws, what that modal's palette differs in from the base (`modalColors`).
export interface ThemePlugin {
  name?: string;
  colors?: Record<string, string>;
  modalColors?: Record<string, Record<string, string>>;
}

// Resolves the abstract modal base into concrete palettes by name: base + modal
// default (MODAL_COLOR_DEFAULTS, or the `modalColors` of the plugin that draws the
// modal) + plugin colors + config.plugins.<name>.colors override — all with
// ${token} expansion. Modal renders keep reading theme.modals.<name>.<prop>, so
// they do not need to change. A host modal's palette is never replaced by a plugin's
// same-named one, and between plugins the first to name a modal keeps it.
export function resolveModalPalettes(
  theme: Theme = DEFAULT_THEME,
  plugins: ThemePlugin[] = [],
  config: ResolveConfig = {},
  scheme: ColorScheme = 'dark',
): Theme {
  const base = theme.modals ?? {};
  const modals: Record<string, string | Record<string, string>> = { ...base };
  const palettes: Record<string, Record<string, string>> = {};
  for (const p of plugins) {
    for (const [name, palette] of Object.entries(p.modalColors ?? {})) palettes[name] ??= palette;
  }
  Object.assign(palettes, modalColorDefaults(scheme));
  for (const name of Object.keys(palettes)) {
    const plugin = plugins.find((p) => p.name === name);
    const defaults = { ...(palettes[name] ?? {}), ...(plugin?.colors ?? {}) };
    const override = config.plugins?.[name]?.colors ?? {};
    const merged = { ...base, ...defaults, ...override };
    modals[name] = Object.fromEntries(
      Object.entries(merged).map(([k, v]) => [k, resolveColorRefs(v, theme)]),
    );
  }
  return { ...theme, modals };
}

// Resolves the config.theme the renderers read: the scheme's base (themeFor)
// merged with the user's config.theme on top, then resolveModalPalettes lays the
// per-modal palettes down (base + the scheme's host modal colours / plugin
// modalColors + plugin colors + config.plugins.<name>.colors), and
// resolvePluginColors adds any non-modal plugin palette (keycaps/bg, board).
// Returns the resolved theme the caller folds back into config.theme, so
// host.config.theme carries the full palette and the renders get borders/colors
// instead of degrading to empty Flowtty defaults. `plugins` provides the
// plugin.colors sources; `config` the config.plugins.<name>.colors overrides. The
// user's theme wins over every scheme: a person who set a colour keeps it.
export function resolveAppTheme(
  configTheme: Theme | undefined,
  plugins: ThemePlugin[] = [],
  config: ResolveConfig = {},
  scheme: ColorScheme = 'dark',
): Theme {
  const merged: Theme = { ...themeFor(scheme), ...(configTheme ?? {}) };
  const resolved = resolveModalPalettes(merged, plugins, config, scheme);
  for (const p of plugins) {
    if (p.colors) resolved[p.name ?? ''] = resolvePluginColors(p, resolved, config);
  }
  return resolved;
}

// The ABSTRACT base (`modals`' flat props), as the host's own screen reads it: the
// start screen, the title bar, the `: ` line and the hint row are not a modal, so
// nothing but this gave them a ground and an ink. A value the palette leaves to the
// terminal (`default` — the scheme was never said, or a person's own `default`) is
// `undefined`, so nothing is painted over the terminal's own colours.
export interface BaseInk {
  bg?: string;
  text?: string;
  border?: string;
  selected?: string;
}

export function baseInk(theme: Theme | undefined): BaseInk {
  const base = (theme?.modals ?? {}) as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const value = base[key];
    return typeof value === 'string' && value !== 'default' ? value : undefined;
  };
  return { bg: pick('bg'), text: pick('text'), border: pick('border'), selected: pick('selected') };
}
