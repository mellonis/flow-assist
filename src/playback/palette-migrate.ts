// `config migrate-theme`: the old flat `theme.*` and each plugin's `colors` become
// overrides under `theme.dark`. Pure — the command applies the result. Only what
// differs from the host's dark palette is set; a value already written in the new
// format is kept as the person wrote it. An old flat theme was often a copy of the
// colours the host drew when it was written (`OLD_DARK`), not the person's choice:
// a value equal to that is not carried either, so it does not pin the old look.

import { HOST_PALETTE } from './palette-defaults.js';
import { expand, resolveSurface, type Role } from './palette.js';
import { isColorValue, oldThemeKeys } from './palette-config.js';

export interface Migration {
  set: Array<[key: string, value: string]>;
  unset: string[];
  dropped: string[];
}

// The old name of a colour, as a `${token}` or a key, and the role that replaces it.
const ROLE_OF: Record<string, Role> = {
  bg: 'bg',
  text: 'text',
  border: 'border',
  selected: 'selected',
  fieldBg: 'fieldBg',
  fieldBorder: 'fieldBorder',
  error: 'danger',
  success: 'ok',
  panelBg: 'panelBg',
  highlightBg: 'highlight',
  accentBg: 'highlightStrong',
  highlightText: 'highlightText',
};

// The dark colours the host drew under the flat theme, per new surface and key.
const OLD_DARK: Record<string, Record<string, string>> = {
  base: {
    bg: 'black', text: 'white', border: 'cyan', selected: 'green', fieldBg: 'gray', fieldBorder: 'cyan',
    danger: 'red', ok: 'green', panelBg: '#1a1b26', highlight: '#3c3c3c', highlightStrong: '#20456b', highlightText: 'white',
  },
  chat: {
    userBg: '#2b2b40', accent: 'cyan', shell: 'magentaBright', assistantAccent: 'green', fieldBg: '#1f1f2e', bgAccent: 'magenta',
    bgBg: '#2a2438', warn: 'yellow', ok: 'green', add: 'green', del: 'red', addBg: '#003b00', delBg: '#3b0000', idleBorder: 'gray',
    askBg: '#243036', askInk: '#dfe8e6',
  },
};

// `theme.modals.<k>` and `theme.<k>` keys that carry over, in the order they are listed.
const MODAL_KEYS = ['bg', 'text', 'border', 'selected', 'fieldBg', 'fieldBorder'];
const FLAT_KEYS = ['selected', 'error', 'success', 'panelBg', 'highlightBg', 'accentBg', 'highlightText'];

const DROPPED_WHY: Record<string, string> = {
  'theme.modals.borderBg': 'a frame\'s ground is base.bg',
  'theme.canvas': 'a resolved palette, not an override',
};

// A dropped key that has a place in the new theme: its value is what kept it out.
function knownKey(key: string): boolean {
  const flat = /^theme\.([^.]+)$/.exec(key)?.[1];
  if (flat !== undefined) return FLAT_KEYS.includes(flat);
  const modal = /^theme\.modals\.([^.]+)$/.exec(key)?.[1];
  if (modal !== undefined) return MODAL_KEYS.includes(modal);
  return /^plugins\.[^.]+\.colors\.[^.]+$/.test(key);
}

/** Why `key` of `config` is not carried over, for the line the command prints. */
export function droppedReason(key: string, config: Record<string, unknown>): string {
  const fixed = DROPPED_WHY[key];
  if (fixed !== undefined) return fixed;
  if (!knownKey(key)) return 'not a key the new theme knows';
  const value = key.split('.').reduce<unknown>((v, part) => (isRecord(v) ? v[part] : undefined), config);
  return isRecord(value) ? 'an object, not a colour' : 'not a colour';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// An old `${token}` becomes `${base.<role>}`; a value that is no colour gives null.
function convert(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = /^\$\{([A-Za-z]+)\}$/.exec(value)?.[1];
  const out = token !== undefined && ROLE_OF[token] !== undefined ? `\${base.${ROLE_OF[token]}}` : value;
  return isColorValue(out) ? out : null;
}

export function migrateTheme(config: Record<string, unknown>): Migration {
  const out: Migration = { set: [], unset: oldThemeKeys(config), dropped: [] };
  const theme = isRecord(config.theme) ? config.theme : {};
  const dark = isRecord(theme.dark) ? theme.dark : {};
  const model = HOST_PALETTE.dark;

  const place = (surface: string, key: string, raw: unknown, from: string): void => {
    const value = convert(raw);
    if (value === null) {
      out.dropped.push(from);
      return;
    }
    const written = isRecord(dark[surface]) ? (dark[surface] as Record<string, unknown>)[key] : undefined;
    if (written !== undefined) return;
    const dflt = surface === 'base' ? expand(model.base, model.base[key as Role]) : resolveSurface(model, surface)[key];
    if (expand(model.base, value) === dflt) return;
    if (OLD_DARK[surface]?.[key] === value) return;
    out.set.push([`theme.dark.${surface}.${key}`, value]);
  };

  const modals = isRecord(theme.modals) ? theme.modals : {};
  const modalValue = (k: string): { raw: unknown; from: string } =>
    k === 'selected' && theme.selected !== undefined ? { raw: theme.selected, from: 'theme.selected' } : { raw: modals[k], from: `theme.modals.${k}` };

  for (const k of MODAL_KEYS) {
    const { raw, from } = modalValue(k);
    if (raw !== undefined) place('base', ROLE_OF[k]!, raw, from);
  }
  for (const k of Object.keys(modals)) {
    if (!MODAL_KEYS.includes(k)) out.dropped.push(`theme.modals.${k}`);
  }
  for (const k of FLAT_KEYS) {
    // `selected` was placed with the modals' keys, where the flat one wins.
    if (k !== 'selected' && theme[k] !== undefined) place('base', ROLE_OF[k]!, theme[k], `theme.${k}`);
  }
  for (const k of Object.keys(theme)) {
    if (k === 'dark' || k === 'light' || k === 'modals' || FLAT_KEYS.includes(k)) continue;
    out.dropped.push(`theme.${k}`);
  }

  const plugins = isRecord(config.plugins) ? config.plugins : {};
  for (const [name, entry] of Object.entries(plugins)) {
    if (!isRecord(entry) || !isRecord(entry.colors)) continue;
    for (const [k, v] of Object.entries(entry.colors)) place(name, k, v, `plugins.${name}.colors.${k}`);
  }
  return out;
}
