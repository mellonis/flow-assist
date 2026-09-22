import { expect, test } from 'bun:test';
import {
  resolveModalPalettes,
  resolveColorRefs,
  resolveAppTheme,
  DEFAULT_THEME,
} from '../theme';

test('resolveModalPalettes merges base + modal default + plugin colors + override', () => {
  const theme = { modals: { bg: 'black', border: 'cyan' } };
  const out = resolveModalPalettes(theme, [{ name: 'chat', colors: { userBg: '#000' } }], {});
  expect(out.modals.chat.userBg).toBe('#000');
});

test('resolveColorRefs expands ${token} against the theme', () => {
  expect(resolveColorRefs('${selected}', { selected: 'green' })).toBe('green');
});

test('DEFAULT_THEME carries the abstract modal base palette (bg/border/borderBg/text/selected/fieldBg/fieldBorder)', () => {
  const m = DEFAULT_THEME.modals ?? {};
  expect(m.bg).toBe('black');
  expect(m.border).toBe('cyan');
  expect(m.borderBg).toBe('black');
  expect(m.text).toBe('white');
  expect(m.selected).toBe('green');
  expect(m.fieldBg).toBe('gray');
  expect(m.fieldBorder).toBe('cyan');
  expect(DEFAULT_THEME.selected).toBe('green');
  expect(DEFAULT_THEME.error).toBe('red');
  expect(DEFAULT_THEME.success).toBe('green');
});

test('resolveModalPalettes lays the base palette + MODAL_COLOR_DEFAULTS down on each modal', () => {
  const out = resolveModalPalettes(DEFAULT_THEME, [], {});
  // chat inherits the base (border/bg) and gets its own userBg default.
  expect(out.modals.chat.border).toBe('cyan');
  expect(out.modals.chat.bg).toBe('black');
  expect(out.modals.chat.userBg).toBe('#2b2b40');
  // The host ships no palette for a modal it does not draw.
  expect(out.modals.relation).toBeUndefined();
});

test("a plugin's modals take their palettes from its `modalColors`, over the base, under the person's override", () => {
  const boards = { name: 'boards', modalColors: { move: { border: 'blue' }, drop: { border: 'red', selected: 'yellow' } } };
  const out = resolveModalPalettes(DEFAULT_THEME, [boards], { plugins: { drop: { colors: { border: '${success}' } } } });
  expect(out.modals.move).toEqual({ ...DEFAULT_THEME.modals, border: 'blue' });
  expect(out.modals.drop.selected).toBe('yellow');
  expect(out.modals.drop.border).toBe('green'); // the override, its `${success}` resolved
  expect(out.modals.drop.bg).toBe('black');
});

test("a plugin's `modalColors` never restyles a host modal, and the first plugin to name a modal keeps it", () => {
  const a = { name: 'a', modalColors: { chat: { userBg: '#ffffff' }, pick: { border: 'blue' } } };
  const b = { name: 'b', modalColors: { pick: { border: 'red' } } };
  const out = resolveModalPalettes(DEFAULT_THEME, [a, b], {});
  expect(out.modals.chat.userBg).toBe('#2b2b40');
  expect(out.modals.pick.border).toBe('blue');
});

test('resolveAppTheme merges the user theme over the base and resolves palettes + plugin colors', () => {
  const out = resolveAppTheme(undefined, [{ name: 'keycaps', colors: { bg: '#1a1b26' } }], {});
  // base + per-modal defaults present.
  expect(out.modals.chat.border).toBe('cyan');
  expect(out.modals.chat.userBg).toBe('#2b2b40');
  // top-level palette keys survive.
  expect(out.selected).toBe('green');
  expect(out.error).toBe('red');
  // a plugin palette (non-modal) resolves into theme.<name>.
  expect(out.keycaps.bg).toBe('#1a1b26');
});

test('resolveAppTheme lets the user theme override the base palette', () => {
  const out = resolveAppTheme({ modals: { border: 'red' }, error: 'yellow' }, [], {});
  expect(out.modals.chat.border).toBe('red');
  expect(out.error).toBe('yellow');
});

test('every colour the host ships is one flowtty can paint', async () => {
  // An unknown colour name paints NOTHING, silently: `fieldBg: 'gray'` was exactly
  // that until flowtty learned the name. flowtty publishes the list (≥ 1.0.0-alpha.10),
  // so a colour in a default palette is checked against it — a name, a #hex or rgb().
  const { NAMED_COLORS } = await import('@flowtty/core');
  const { buildKeycapsPlugin } = await import('../../plugins/keycaps');
  // `'default'` is the terminal's own colour — what an unknown scheme leaves to it.
  const paintable = (v: string) => v === 'default' || (NAMED_COLORS as readonly string[]).includes(v) || /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v) || /^rgb\(/.test(v);
  const bad: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === 'string') { if (!paintable(node)) bad.push(`${path} = ${node}`); return; }
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  };
  // The resolved theme: the base palette, every modal's palette with its `${ref}`s
  // resolved, and a plugin's own palette on top.
  const keycaps = buildKeycapsPlugin({ renders: {}, config: {}, make: ((_: string, shape: unknown) => shape) as never });
  // Every scheme's palette — a `${token}` a scheme lacks would stay a literal string.
  for (const scheme of ['dark', 'light', 'unknown'] as const) walk(resolveAppTheme({}, [keycaps as never], {}, scheme), scheme);
  expect(bad).toEqual([]);
});

test('each scheme has its own grounds, and the person\'s theme wins over every scheme', () => {
  const dark = resolveAppTheme(undefined, [], {}, 'dark');
  const light = resolveAppTheme(undefined, [], {}, 'light');
  expect(dark.modals.chat.bg).toBe('black');
  expect(light.modals.chat.bg).toBe('#f4f4f6');
  expect(light.modals.chat.text).toBe('black');
  expect(light.modals.chat.userBg).not.toBe(dark.modals.chat.userBg);
  // A plugin palette written as `${token}` follows the scheme.
  const panel = { name: 'panel', colors: { bg: '${panelBg}' } };
  expect(resolveAppTheme(undefined, [panel], {}, 'dark').panel.bg).toBe('#1a1b26');
  expect(resolveAppTheme(undefined, [panel], {}, 'light').panel.bg).toBe('#ececf2');
  // A colour the person set stays theirs, on light as on dark.
  const mine = resolveAppTheme({ error: 'magenta' }, [], {}, 'light');
  expect(mine.error).toBe('magenta');
});
