import { expect, test } from 'bun:test';
import { hostConfigSchema } from '../../config/schema';
import { validateConfigWriteValue } from '../../config/load';
import { isColorValue, oldThemeKeys, readThemeOverrides } from '../palette-config';

const write = (key: string, value: unknown) => validateConfigWriteValue(hostConfigSchema, key, value);

test('isColorValue knows every flowtty spelling and a known ref', () => {
  for (const ok of ['red', 'gray', 'default', '#abc', '#1a1b26', 'rgb(1, 2, 3)', 'ansi256(200)', '${base.bg}']) expect(isColorValue(ok)).toBe(true);
  for (const bad of ['', '#12', '#12345g', 'rgb(1,2)', 'rgb(1,2,300)', 'ansi256(256)', 'purple', '${base.nope}', '${bg}']) expect(isColorValue(bad)).toBe(false);
});

test('config set takes a base role, a surface key and a ref', () => {
  expect(write('theme.dark.base.bg', '#010203').ok).toBe(true);
  expect(write('theme.light.chat.userBg', '${base.panelBg}').ok).toBe(true);
  expect(write('theme.dark.chat', { userBg: 'red' }).ok).toBe(true);
});

test('config set refuses what the palette cannot hold, naming the key', () => {
  const nope = write('theme.dark.base.nope', 'red') as { ok: false; error: string };
  expect(nope.ok).toBe(false);
  expect(nope.error).toContain('theme.dark.base.nope');
  const short = write('theme.dark.chat.userBg', '#12') as { ok: false; error: string };
  expect(short.ok).toBe(false);
  expect(short.error).toContain('theme.dark.chat.userBg');
  const ref = write('theme.dark.chat.userBg', '${base.nope}') as { ok: false; error: string };
  expect(ref.ok).toBe(false);
  expect(ref.error).toContain('theme.dark.chat.userBg');
  expect(write('theme.modals', { bg: 'red' }).ok).toBe(false);
  expect(write('theme.selected', 'green').ok).toBe(false);
});

test('readThemeOverrides keeps the good keys and lists the bad ones', () => {
  const { overrides, ignored } = readThemeOverrides({
    dark: { base: { bg: '#010203', nope: 'red' }, chat: { userBg: '#12', text: '${base.text}' }, log: 'x' },
    light: 'oops',
    modals: { bg: 'red' },
  });
  expect(overrides).toEqual({ dark: { base: { bg: '#010203' }, chat: { text: '${base.text}' } } });
  expect(ignored.sort()).toEqual(['theme.dark.base.nope', 'theme.dark.chat.userBg', 'theme.dark.log', 'theme.light'].sort());
  expect(readThemeOverrides(undefined)).toEqual({ overrides: {}, ignored: [] });
});

test('oldThemeKeys finds the flat theme and every plugin colors', () => {
  const old = {
    theme: { modals: { bg: 'red' }, selected: 'green', panelBg: '#1a1b26', canvas: { bg: 'black' } },
    plugins: { chat: { colors: { userBg: '#232323' } }, repo: { roots: [] } },
  };
  expect(oldThemeKeys(old).sort()).toEqual(['plugins.chat.colors', 'theme.canvas', 'theme.modals', 'theme.panelBg', 'theme.selected']);
  expect(oldThemeKeys({ theme: { dark: { base: { bg: 'red' } } } })).toEqual([]);
  expect(oldThemeKeys({})).toEqual([]);
});
