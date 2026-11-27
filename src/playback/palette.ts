// The palette model. A scheme (`dark` or `light`) holds 16 base roles and, per
// surface, the keys that surface adds or overrides. A value is a literal or a
// reference `${base.<role>}`; references resolve inside their scheme, and a
// surface key never references another surface's key. This module imports
// nothing from the rest of the host.

export const ROLES = [
  'bg',
  'text',
  'muted',
  'border',
  'accent',
  'selected',
  'highlight',
  'danger',
  'ok',
  'warn',
  'fieldBg',
  'fieldText',
  'fieldBorder',
  'panelBg',
  'highlightStrong',
  'highlightText',
] as const;
export type Role = (typeof ROLES)[number];

export type Scheme = 'dark' | 'light';
export const SCHEMES: readonly Scheme[] = ['dark', 'light'];

export interface SchemeModel {
  base: Record<Role, string>;
  surfaces: Record<string, Record<string, string>>;
}
export type PaletteModel = Record<Scheme, SchemeModel>;

const REF = /^\$\{base\.([A-Za-z]+)\}$/;

/** `${base.<role>}` gives the role; anything else, an unknown role included, gives null. */
export function isRef(value: string): Role | null {
  const match = REF.exec(value);
  const role = match?.[1];
  return role !== undefined && (ROLES as readonly string[]).includes(role) ? (role as Role) : null;
}

function follow(base: Record<Role, string>, value: string, seen: ReadonlySet<Role>): string {
  const role = isRef(value);
  if (role === null || seen.has(role)) return value;
  return follow(base, base[role], new Set([...seen, role]));
}

/** Follows references through the base roles; a cycle returns the first ref that repeats (the value as written when the start is on the loop). */
export function expand(base: Record<Role, string>, value: string): string {
  return follow(base, value, new Set());
}

/** The overrides laid on the defaults, without touching either. */
export function layer(
  m: SchemeModel,
  over: { base?: Partial<Record<Role, string>>; [surface: string]: Record<string, string> | undefined },
): SchemeModel {
  const { base: baseOver, ...surfaceOver } = over;
  const surfaces: Record<string, Record<string, string>> = {};
  for (const [name, keys] of Object.entries(m.surfaces)) surfaces[name] = { ...keys };
  for (const [name, keys] of Object.entries(surfaceOver)) {
    if (keys !== undefined) surfaces[name] = { ...surfaces[name], ...keys };
  }
  return { base: { ...m.base, ...stripUndefined(baseOver) }, surfaces };
}

function stripUndefined(over: Partial<Record<Role, string>> | undefined): Partial<Record<Role, string>> {
  const out: Partial<Record<Role, string>> = {};
  for (const role of ROLES) {
    const value = over?.[role];
    if (value !== undefined) out[role] = value;
  }
  return out;
}

/** All 16 roles expanded, then the surface's own keys expanded on top. */
export function resolveSurface(m: SchemeModel, surface: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of ROLES) out[role] = expand(m.base, m.base[role]);
  for (const [key, value] of Object.entries(m.surfaces[surface] ?? {})) out[key] = expand(m.base, value);
  return out;
}

/**
 * What the tuner shows for one row. A surface key is `own` when the person's
 * overrides set it to something the defaults do not hold; otherwise it inherits,
 * from the role a `${base.*}` value names or, for a key the surface does not set,
 * from the base role of the same name. A base row is `own` unless its value is a
 * reference.
 */
export function provenance(
  defaults: SchemeModel,
  effective: SchemeModel,
  surface: string | null,
  key: string,
): { value: string; source: 'own' | 'inherit'; from?: Role } {
  const isRole = (k: string): k is Role => (ROLES as readonly string[]).includes(k);
  if (surface === null) {
    const raw = isRole(key) ? effective.base[key] : '';
    const ref = isRef(raw);
    const value = expand(effective.base, raw);
    return ref === null ? { value, source: 'own' } : { value, source: 'inherit', from: ref };
  }
  const own = (m: SchemeModel): string | undefined =>
    Object.hasOwn(m.surfaces[surface] ?? {}, key) ? m.surfaces[surface]?.[key] : undefined;
  const set = own(effective);
  const inDefaults = own(defaults);
  const raw = set ?? inDefaults ?? (isRole(key) ? effective.base[key] : '');
  const value = expand(effective.base, raw);
  // An override equal to the default reads as `inherit`: the values are compared.
  if (set !== undefined && set !== inDefaults) return { value, source: 'own' };
  // A key the surface lacks inherits from the base role of the same name; a
  // reference in the surface's own default names its role; a literal names none.
  const from = inDefaults === undefined ? (isRole(key) ? key : null) : isRef(inDefaults);
  return from === null ? { value, source: 'inherit' } : { value, source: 'inherit', from };
}
