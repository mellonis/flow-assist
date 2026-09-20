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
  // domain modals get their colored border by default.
  expect(out.modals.relation.border).toBe('blue');
  expect(out.modals.delete.border).toBe('red');
  expect(out.modals.story.border).toBe('green');
  expect(out.modals.sprint.border).toBe('magenta');
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