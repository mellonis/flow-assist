import { expect, test } from 'bun:test';
import { z } from 'zod';
import { hostConfigSchema } from '../../config/schema';
import { validateConfigWriteValue } from '../../config/load';
import { isColorValue, oldThemeKeys, readThemeOverrides, type SurfaceKeys } from '../palette-config';
import { ROLES } from '../palette';

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
  expect(ignored.map((i) => i.path).sort()).toEqual(['theme.dark.base.nope', 'theme.dark.chat.userBg', 'theme.dark.log', 'theme.light'].sort());
  expect(ignored.find((i) => i.path === 'theme.dark.base.nope')?.why).toBe('key');
  expect(ignored.find((i) => i.path === 'theme.dark.chat.userBg')?.why).toBe('value');
  expect(readThemeOverrides(undefined)).toEqual({ overrides: {}, ignored: [] });
  // A `theme` that is no record at all is said too.
  expect(readThemeOverrides('red').ignored).toEqual([{ path: 'theme', why: 'value' }]);
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

test('a passthrough schema does not make every unknown key writable', () => {
  const unknown = write('nope', 'red') as { ok: false; error: string };
  expect(unknown.ok).toBe(false);
  expect(unknown.error).toContain('unknown key nope');
  const plugin = z.object({ a: z.string().optional() }).passthrough();
  const viaPlugin = validateConfigWriteValue(hostConfigSchema, 'plugins.p.zzz', 'x', { p: plugin }) as { ok: false; error: string };
  expect(viaPlugin.ok).toBe(false);
  expect(viaPlugin.error).toContain('unknown key');
  expect(write('theme.dark.chat.userBg', '#010203').ok).toBe(true);
});

test('a flat theme key is refused as the old format, naming the migration', () => {
  for (const key of ['theme.modals', 'theme.selected', 'theme.modals.chat.bg']) {
    const refused = write(key, 'red') as { ok: false; error: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('old format');
    expect(refused.error).toContain('flow-assist config migrate-theme');
  }
  expect((write('theme.dark.base.nope', 'red') as { error: string }).error).not.toContain('old format');
});

test('config set refuses a key a host surface does not draw, naming it', () => {
  for (const key of ['theme.dark.chat.usrBg', 'theme.light.keycaps.nope', 'theme.dark.log.userBg']) {
    const refused = write(key, '#111111') as { ok: false; error: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain(key);
    expect(refused.error).toContain('not a key');
  }
  // A role and a surface's own key are both its keys.
  expect(write('theme.dark.chat.text', 'red').ok).toBe(true);
  expect(write('theme.dark.log.text', 'red').ok).toBe(true);
  expect(write('theme.dark.keycaps.bg', 'red').ok).toBe(true);
  expect(write('theme.dark.chat.mdLink', 'red').ok).toBe(true);
  const whole = write('theme.dark.chat', { usrBg: 'red' }) as { ok: false; error: string };
  expect(whole.ok).toBe(false);
  expect(whole.error).toContain('theme.dark.chat.usrBg');
});

test('config set checks a plugin surface against its manifest when it can be read', () => {
  const board = new Set<string>([...ROLES, 'swimlaneBg']);
  const keys: SurfaceKeys = (surface) => (surface === 'board' ? board : null);
  const set = (key: string, value: unknown) => validateConfigWriteValue(hostConfigSchema, key, value, undefined, keys);
  expect(set('theme.dark.board.swimlaneBg', 'red').ok).toBe(true);
  expect(set('theme.dark.board.text', 'red').ok).toBe(true);
  for (const [key, value] of [['theme.dark.board.zzz', 'red'], ['theme.dark.board', { zzz: 'red' }], ['theme', { light: { board: { zzz: 'red' } } }]] as const) {
    const refused = set(key, value) as { ok: false; error: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('board.zzz');
    expect(refused.error).toContain('not a key');
  }
  // A plugin whose manifest cannot be read (not installed): taken, and the start says it.
  expect(set('theme.dark.nosuchplugin.x', 'red').ok).toBe(true);
});

test('config set on the unknown scheme says only dark and light are tuned', () => {
  const refused = write('theme.unknown.base.bg', '#000000') as { ok: false; error: string };
  expect(refused.ok).toBe(false);
  expect(refused.error).toContain('theme.unknown');
  expect(refused.error).toContain('not a scheme you tune');
  expect(refused.error).not.toContain('old format');
});

test('a bad value inside a record names the key and value that are wrong', () => {
  const value = write('theme.dark', { chat: { userBg: '#12' } }) as { ok: false; error: string };
  expect(value.ok).toBe(false);
  expect(value.error).toContain('theme.dark.chat.userBg');
  expect(value.error).toContain('"#12"');
  expect(value.error).not.toContain('expected object');
  const role = write('theme.dark', { base: { nope: 'red' } }) as { ok: false; error: string };
  expect(role.error).toContain('theme.dark.base.nope');
  expect(role.error).not.toContain('expected object');
});
