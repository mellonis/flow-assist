// The theme the app draws in. At start the host builds one palette model per scheme
// (`buildModels`): its own surfaces (palette-defaults.ts), a surface per plugin, and
// the person's `theme.<scheme>` overrides laid on top. `resolveAppTheme` turns the
// model of the scheme on screen into what every renderer reads: `theme.base.<role>`
// and, per surface, `theme.<surface>.<key>` — every role plus the surface's own keys,
// each a colour flowtty paints.

import { expand, layer, resolveSurface, ROLES, SCHEMES, type PaletteModel, type Role, type Scheme } from './palette.js';
import { HOST_PALETTE, UNKNOWN_RESOLVED } from './palette-defaults.js';
import { hostSurfaceKeys, paletteKeys, readThemeOverrides, type IgnoredPath, type Overrides } from './palette-config.js';

// Which scheme the terminal is on, as flowtty reports it (docs/app.md in flowtty —
// the color scheme). It can change while the app runs: macOS switches its
// appearance by itself, and the terminal follows.
export type ColorScheme = 'light' | 'dark' | 'unknown';

/** What the renderers read: the base roles and, per surface, every role plus its own keys. */
export type ResolvedTheme = { base: Record<Role, string> } & Record<string, Record<string, string>>;

/** A plugin as the palette sees it: its name and the palette its manifest declares, per scheme. */
export interface PalettePlugin {
  name: string;
  palette?: { dark: Record<string, string>; light: Record<string, string> };
}

/** Both schemes' models with the person's overrides laid on, and the defaults they were laid on. */
export interface ThemeModels {
  models: PaletteModel;
  defaults: PaletteModel;
}

/**
 * Both schemes' models: the host's surfaces, each plugin's palette as a surface of its
 * name (never over a host surface), the person's overrides laid on. `defaults` is the
 * same before the overrides; `ignored` lists each override path the theme does not take:
 * a value no colour, or a key no surface draws — a host surface's own keys, a plugin's
 * from its manifest, and a surface no plugin here owns. A plugin still starting
 * (`pending`) is not judged before it joins: its overrides are kept for it.
 */
export function buildModels(
  theme: unknown,
  plugins: readonly PalettePlugin[],
  opts: { pending?: readonly string[] } = {},
): ThemeModels & { ignored: IgnoredPath[] } {
  const read = readThemeOverrides(theme);
  const ignored: IgnoredPath[] = [...read.ignored];
  const taken = new Set(['base', ...Object.keys(HOST_PALETTE.dark.surfaces), ...Object.keys(HOST_PALETTE.light.surfaces)]);
  const owners = new Map(plugins.filter((p) => !taken.has(p.name)).map((p) => [p.name, paletteKeys(p.palette)]));
  const pending = new Set(opts.pending ?? []);
  const drawn = (surface: string): ReadonlySet<string> | null => hostSurfaceKeys(surface) ?? owners.get(surface) ?? null;
  const models = {} as PaletteModel;
  const defaultsOut = {} as PaletteModel;
  for (const scheme of SCHEMES) {
    const defaults = HOST_PALETTE[scheme];
    const surfaces: Record<string, Record<string, string>> = { ...defaults.surfaces };
    for (const p of plugins) {
      if (p.palette !== undefined && !taken.has(p.name)) surfaces[p.name] = { ...p.palette[scheme] };
    }
    defaultsOut[scheme] = { base: defaults.base, surfaces };
    const over: Overrides = {};
    for (const [surface, keys] of Object.entries(read.overrides[scheme as Scheme] ?? {})) {
      if (keys === undefined) continue;
      const known = surface === 'base' ? null : drawn(surface);
      if (surface === 'base' || (known === null && pending.has(surface))) {
        over[surface] = keys;
        continue;
      }
      const kept: Record<string, string> = {};
      for (const [key, value] of Object.entries(keys)) {
        if (known?.has(key)) kept[key] = value;
        else ignored.push({ path: `theme.${scheme}.${surface}.${key}`, why: 'key' });
      }
      if (Object.keys(kept).length > 0) over[surface] = kept;
    }
    models[scheme] = layer(defaultsOut[scheme], over);
  }
  return { models, defaults: defaultsOut, ignored };
}

const listed = (paths: readonly string[]): string => paths.join(', ');

/**
 * What the start says of the person's theme, one line per kind: values no colour, keys
 * no surface draws, keys from the old format (`config migrate-theme` moves those; one in
 * config.json, which the host never writes, is left there for the person to remove).
 */
export function themeStartNotes(ignored: readonly IgnoredPath[], oldKeys: readonly string[], inConfigJson: (key: string) => boolean): string[] {
  const out: string[] = [];
  const values = ignored.filter((i) => i.why === 'value').map((i) => i.path);
  const keys = ignored.filter((i) => i.why === 'key').map((i) => i.path);
  const one = (paths: readonly string[]) => paths.length === 1;
  if (values.length) {
    out.push(one(values)
      ? `${values[0]} is not a colour the theme takes, and is not applied`
      : `${listed(values)} are not colours the theme takes, and are not applied`);
  }
  if (keys.length) {
    out.push(one(keys)
      ? `${keys[0]} is not a key that surface draws, and is not applied`
      : `${listed(keys)} are not keys their surfaces draw, and are not applied`);
  }
  const local = oldKeys.filter((k) => !inConfigJson(k));
  const json = oldKeys.filter((k) => inConfigJson(k));
  const run = 'run flow-assist config migrate-theme';
  if (local.length) {
    out.push(one(local)
      ? `${local[0]} is from the old format and is not applied — ${run}`
      : `${listed(local)} are from the old format and are not applied — ${run}`);
  }
  if (json.length) {
    out.push(one(json)
      ? `${json[0]} in config.json is from the old format and is not applied — ${run}, then remove it from config.json`
      : `${listed(json)} in config.json are from the old format and are not applied — ${run}, then remove them from config.json`);
  }
  return out;
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
