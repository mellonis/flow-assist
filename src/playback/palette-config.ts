// The theme's config shape: `theme.<scheme>.base.<role>` and
// `theme.<scheme>.<surface>.<key>`, each value a flowtty colour or a
// `${base.<role>}` reference. `themeSchema` checks a write; `readThemeOverrides`
// reads a hand-edited file leniently; `oldThemeKeys` finds what an older config
// kept elsewhere (a flat `theme.*`, a plugin's `colors`).

import { NAMED_COLORS } from '@flowtty/core';
import { z } from 'zod';
import { isRef, ROLES, SCHEMES, type Role, type Scheme } from './palette.js';

const NAMED: readonly string[] = NAMED_COLORS;
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const RGB = /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/;
const ANSI256 = /^ansi256\(\s*\d{1,3}\s*\)$/;

function inRange(v: string): boolean {
  const nums = (v.slice(v.indexOf('(')).match(/\d+/g) ?? []).map(Number);
  return nums.every((n) => n <= 255);
}

/** A flowtty colour (named, `#rgb`, `#rrggbb`, `rgb(…)`, `ansi256(…)`, `default`) or a `${base.<role>}` naming a known role. */
export function isColorValue(v: string): boolean {
  if (isRef(v) !== null) return true;
  if (v === 'default' || NAMED.includes(v)) return true;
  if (HEX.test(v)) return true;
  return (RGB.test(v) || ANSI256.test(v)) && inRange(v);
}

const colorValue = z.string().refine(isColorValue, { message: 'a colour (named, #rgb, #rrggbb, rgb(r,g,b), ansi256(n), default) or ${base.<role>}' });

const baseShape = Object.fromEntries(ROLES.map((role) => [role, colorValue.optional()])) as Record<Role, z.ZodOptional<typeof colorValue>>;

// `base` names the 16 roles and nothing else; any other key is a surface.
const schemeOverrides = z.object({ base: z.object(baseShape).strict().optional() }).catchall(z.record(z.string(), colorValue));

/** `theme` as a write sees it: a scheme per key, nothing else. */
export const themeSchema = z.object({ dark: schemeOverrides.optional(), light: schemeOverrides.optional() }).strict();

export interface Overrides {
  base?: Partial<Record<Role, string>>;
  [surface: string]: Record<string, string> | undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The overrides a hand-edited `theme` holds: bad values are dropped and listed as `theme.dark.chat.userBg`. */
export function readThemeOverrides(theme: unknown): { overrides: Partial<Record<Scheme, Overrides>>; ignored: string[] } {
  const overrides: Partial<Record<Scheme, Overrides>> = {};
  const ignored: string[] = [];
  if (!isRecord(theme)) return { overrides, ignored };
  for (const scheme of SCHEMES) {
    const node = theme[scheme];
    if (node === undefined) continue;
    if (!isRecord(node)) {
      ignored.push(`theme.${scheme}`);
      continue;
    }
    const out: Overrides = {};
    for (const [surface, keys] of Object.entries(node)) {
      if (!isRecord(keys)) {
        ignored.push(`theme.${scheme}.${surface}`);
        continue;
      }
      const kept: Record<string, string> = {};
      for (const [key, value] of Object.entries(keys)) {
        const path = `theme.${scheme}.${surface}.${key}`;
        const known = surface !== 'base' || (ROLES as readonly string[]).includes(key);
        if (known && typeof value === 'string' && isColorValue(value)) kept[key] = value;
        else ignored.push(path);
      }
      if (Object.keys(kept).length > 0) out[surface] = kept;
    }
    if (Object.keys(out).length > 0) overrides[scheme] = out;
  }
  return { overrides, ignored };
}

/** Config paths an older version wrote: each top-level `theme.*` that is not a scheme, and each `plugins.<name>.colors`. */
export function oldThemeKeys(config: Record<string, unknown>): string[] {
  const out: string[] = [];
  const theme = config.theme;
  if (isRecord(theme)) {
    for (const key of Object.keys(theme)) if (key !== 'dark' && key !== 'light') out.push(`theme.${key}`);
  }
  const plugins = config.plugins;
  if (isRecord(plugins)) {
    for (const [name, value] of Object.entries(plugins)) {
      if (isRecord(value) && value.colors !== undefined) out.push(`plugins.${name}.colors`);
    }
  }
  return out;
}
