// The theme the app draws in. At start the host builds one palette model per scheme
// (`buildModels`): its own surfaces (palette-defaults.ts), a surface per plugin, and
// the person's `theme.<scheme>` overrides laid on top. `resolveAppTheme` turns the
// model of the scheme on screen into what every renderer reads: `theme.base.<role>`
// and, per surface, `theme.<surface>.<key>` — every role plus the surface's own keys,
// each a colour flowtty paints.

import { expand, layer, resolveSurface, ROLES, SCHEMES, type PaletteModel, type Role, type Scheme } from './palette.js';
import { HOST_PALETTE, UNKNOWN_RESOLVED } from './palette-defaults.js';
import { readThemeOverrides } from './palette-config.js';

// Which scheme the terminal is on, as flowtty reports it (docs/app.md in flowtty —
// the color scheme). It can change while the app runs: macOS switches its
// appearance by itself, and the terminal follows.
export type ColorScheme = 'light' | 'dark' | 'unknown';

/** What the renderers read: the base roles and, per surface, every role plus its own keys. */
export type ResolvedTheme = { base: Record<Role, string> } & Record<string, Record<string, string>>;

/** A plugin as the palette sees it: its name and the palette its manifest declares. */
export interface PalettePlugin {
  name: string;
  palette?: { dark: Record<string, string>; light: Record<string, string> };
}

// The palette a plugin's shape carries in code: `colors` for the surface named after
// the plugin, `modalColors` per modal it draws.
interface ShapeColors {
  colors?: Record<string, string>;
  modalColors?: Record<string, Record<string, string>>;
}

// A shape's `${token}` names the theme's tokens; each one means a base role.
const SHAPE_TOKENS: Record<string, Role> = {
  panelBg: 'panelBg',
  highlightBg: 'highlight',
  accentBg: 'highlightStrong',
  highlightText: 'highlightText',
  selected: 'selected',
  error: 'danger',
  success: 'ok',
};

function fromShapeValue(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (ref, token: string) => {
    const role = SHAPE_TOKENS[token];
    return role === undefined ? ref : `\${base.${role}}`;
  });
}

// A plugin that declares no manifest palette is drawn from its shape's colors: the
// surface named after the plugin takes `colors`, and each modal in `modalColors` is a
// surface of its own — the first plugin to name a modal keeps it, and a host surface
// is never replaced. The same values stand on both schemes.
function shapeSurfaces(plugins: readonly (PalettePlugin & ShapeColors)[], taken: ReadonlySet<string>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  const add = (name: string, keys: Record<string, string>) => {
    out[name] = { ...out[name], ...Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, fromShapeValue(v)])) };
  };
  for (const p of plugins) {
    if (p.palette !== undefined) continue;
    for (const [modal, keys] of Object.entries(p.modalColors ?? {})) {
      if (!taken.has(modal) && out[modal] === undefined) add(modal, keys);
    }
  }
  for (const p of plugins) {
    if (p.palette === undefined && p.colors !== undefined && !taken.has(p.name)) add(p.name, p.colors);
  }
  return out;
}

/** Both schemes' models with the person's overrides laid on, and the defaults they were laid on. */
export interface ThemeModels {
  models: PaletteModel;
  defaults: PaletteModel;
}

/**
 * Both schemes' models: the host's surfaces, each plugin's palette as a surface of its
 * name (never over a host surface), the person's overrides laid on. `defaults` is the
 * same before the overrides; `ignored` lists each override path the theme does not take.
 */
export function buildModels(theme: unknown, plugins: readonly (PalettePlugin & ShapeColors)[]): ThemeModels & { ignored: string[] } {
  const { overrides, ignored } = readThemeOverrides(theme);
  const taken = new Set(['base', ...Object.keys(HOST_PALETTE.dark.surfaces), ...Object.keys(HOST_PALETTE.light.surfaces)]);
  const bridged = shapeSurfaces(plugins, taken);
  const models = {} as PaletteModel;
  const defaultsOut = {} as PaletteModel;
  for (const scheme of SCHEMES) {
    const defaults = HOST_PALETTE[scheme];
    const surfaces: Record<string, Record<string, string>> = { ...defaults.surfaces };
    for (const p of plugins) {
      if (p.palette !== undefined && !taken.has(p.name)) surfaces[p.name] = { ...p.palette[scheme] };
    }
    for (const [name, keys] of Object.entries(bridged)) surfaces[name] ??= keys;
    defaultsOut[scheme] = { base: defaults.base, surfaces };
    models[scheme] = layer(defaultsOut[scheme], overrides[scheme as Scheme] ?? {});
  }
  return { models, defaults: defaultsOut, ignored };
}

/**
 * The theme for the scheme on screen. `unknown` is not tuned: the resolved unknown
 * palette, and each plugin's surface from its own defaults (its dark ones) expanded
 * against that palette's base — the person's overrides stay on their scheme.
 */
export function resolveAppTheme({ models, defaults }: ThemeModels, scheme: ColorScheme): ResolvedTheme {
  if (scheme === 'unknown') {
    const base = UNKNOWN_RESOLVED.base as Record<Role, string>;
    const out: Record<string, Record<string, string>> = { base: { ...base } };
    for (const [name, keys] of Object.entries(UNKNOWN_RESOLVED)) {
      if (name !== 'base') out[name] = { ...base, ...keys };
    }
    for (const [name, keys] of Object.entries(defaults.dark.surfaces)) {
      if (out[name] !== undefined) continue;
      out[name] = { ...base, ...Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, expand(base, v)])) };
    }
    return out as ResolvedTheme;
  }
  const m = models[scheme];
  const base = {} as Record<Role, string>;
  for (const role of ROLES) base[role] = expand(m.base, m.base[role]);
  const out: Record<string, Record<string, string>> = { base };
  for (const name of Object.keys(m.surfaces)) out[name] = resolveSurface(m, name);
  return out as ResolvedTheme;
}

// The base roles as the host's own screen reads them: the start screen, the title
// bar, the `: ` line and the hint row are not a modal, so nothing but this gives them
// a ground and an ink. A value the palette leaves to the terminal (`default` — the
// scheme was never said, or a person's own `default`) is `undefined`, so nothing is
// painted over the terminal's own colours.
export interface BaseInk {
  bg?: string;
  text?: string;
  border?: string;
  selected?: string;
}

export function baseInk(theme: { base?: Partial<Record<Role, string>> } | undefined): BaseInk {
  const base = theme?.base ?? {};
  const pick = (key: Role): string | undefined => {
    const value = base[key];
    return typeof value === 'string' && value !== 'default' ? value : undefined;
  };
  return { bg: pick('bg'), text: pick('text'), border: pick('border'), selected: pick('selected') };
}
