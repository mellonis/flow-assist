import { expect, test } from 'bun:test';
import { baseInk, buildModels, resolveAppTheme, themeStartNotes, type ResolvedTheme } from '../theme';
import { HOST_PALETTE, UNKNOWN_RESOLVED } from '../palette-defaults';

const resolved = (theme: unknown, scheme: 'dark' | 'light' | 'unknown', plugins: Parameters<typeof buildModels>[1] = []): ResolvedTheme =>
  resolveAppTheme(buildModels(theme, plugins), scheme);

// A pairing's readability is a relation: on a light terminal the band is the paler of
// the two, on a dark one the deeper. A named terminal colour gets a stand-in hex —
// near enough for a relation, and the named inks the palettes use are far from their
// bands in lightness either way.
const NAMED: Record<string, string> = {
  black: '#000000', red: '#800000', green: '#008000', yellow: '#808000',
  blue: '#0000ff', magenta: '#800080', cyan: '#008080', white: '#c0c0c0', gray: '#808080',
};
function luminance(color: string): number {
  const hex = /^#([0-9a-f]{6})$/i.exec(NAMED[color] ?? color);
  if (!hex) throw new Error(`no luminance stand-in for ${color}`);
  const n = parseInt(hex[1]!, 16);
  const chan = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
}

test('an override on one scheme stays on it, and a chat key that names the role follows it', () => {
  const { models, defaults } = buildModels({ dark: { base: { bg: '#010203' } } }, []);
  expect(resolveAppTheme({ models, defaults }, 'light').base.bg).toBe(HOST_PALETTE.light.base.bg);
  const dark = resolveAppTheme({ models, defaults }, 'dark');
  expect(dark.base.bg).toBe('#010203');
  // `askBg` written as `${base.bg}` moves with the role it names.
  const followed = resolved({ dark: { base: { bg: '#010203' }, chat: { askBg: '${base.bg}' } } }, 'dark');
  expect(followed.chat!.askBg).toBe('#010203');
  // Every surface carries every role beside its own keys.
  expect(dark.chat!.bg).toBe('#010203');
  expect(dark.chat!.userBg).toBe('#2b2b40');
});

test("a plugin's manifest palette is a surface, resolved on both schemes", () => {
  const plugins = [{ name: 'board', palette: { dark: { swimlaneBg: '${base.highlight}' }, light: { swimlaneBg: '${base.highlight}' } } }];
  expect(resolved({}, 'dark', plugins).board!.swimlaneBg).toBe(HOST_PALETTE.dark.base.highlight);
  expect(resolved({}, 'light', plugins).board!.swimlaneBg).toBe(HOST_PALETTE.light.base.highlight);
  // The person's override for the plugin's surface lands on its scheme.
  expect(resolved({ light: { board: { swimlaneBg: 'red' } } }, 'light', plugins).board!.swimlaneBg).toBe('red');
  // A plugin's palette never replaces a host surface of the same name.
  const chat = [{ name: 'chat', palette: { dark: { userBg: 'red' }, light: { userBg: 'red' } } }];
  expect(resolved({}, 'dark', chat).chat!.userBg).toBe('#2b2b40');
});

test('a value the theme does not take is left out and listed', () => {
  const { models, defaults, ignored } = buildModels({ dark: { base: { bg: 'not-a-colour' }, chat: { userBg: '#123456' } } }, []);
  expect(ignored).toEqual([{ path: 'theme.dark.base.bg', why: 'value' }]);
  expect(resolveAppTheme({ models, defaults }, 'dark').base.bg).toBe(HOST_PALETTE.dark.base.bg);
  expect(resolveAppTheme({ models, defaults }, 'dark').chat!.userBg).toBe('#123456');
});

test('a theme still in the old format applies nothing of it', () => {
  const out = resolved({ modals: { bg: 'red' }, error: 'yellow' }, 'dark');
  expect(out.base.bg).toBe('black');
  expect(out.base.danger).toBe('red');
  expect(out.modals).toBeUndefined();
});

test('an unknown terminal gets the resolved unknown palette, plugin surfaces resolved against it', () => {
  const plugins = [{ name: 'board', palette: { dark: { lane: '${base.highlight}', mark: '#123456' }, light: { lane: '${base.highlight}', mark: '#123456' } } }];
  const out = resolved({ dark: { base: { bg: '#010203' } } }, 'unknown', plugins);
  expect(out.base).toEqual(UNKNOWN_RESOLVED.base as ResolvedTheme['base']);
  expect(out.chat!.userBg).toBe('default');
  // A host surface on unknown carries every role too: a frame keeps its border.
  expect(out.log!.border).toBe('cyan');
  expect(out.chat!.border).toBe('cyan');
  expect(out.board!.lane).toBe('default');
  expect(out.board!.mark).toBe('#123456');
});

test('every colour the host ships is one flowtty can paint', async () => {
  // An unknown colour name paints NOTHING, silently; an unexpanded `${base.*}` is caught
  // here too. flowtty publishes the list, so a resolved colour is checked against it.
  const { NAMED_COLORS } = await import('@flowtty/core');
  const paintable = (v: string) => v === 'default' || (NAMED_COLORS as readonly string[]).includes(v) || /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v) || /^rgb\(/.test(v);
  const bad: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === 'string') { if (!paintable(node)) bad.push(`${path} = ${node}`); return; }
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  };
  for (const scheme of ['dark', 'light', 'unknown'] as const) walk(resolved({}, scheme), scheme);
  expect(bad).toEqual([]);
});

test("each scheme has its own grounds, and the person's colour is theirs on its scheme", () => {
  const dark = resolved(undefined, 'dark');
  const light = resolved(undefined, 'light');
  expect(dark.chat!.bg).toBe('black');
  expect(light.chat!.bg).toBe('#f4f4f6');
  expect(light.chat!.text).toBe('black');
  expect(light.chat!.userBg).not.toBe(dark.chat!.userBg);
  expect(dark.keycaps!.bg).toBe('#1a1b26');
  expect(light.keycaps!.bg).toBe('#ececf2');
  expect(resolved({ light: { base: { danger: 'magenta' } } }, 'light').base.danger).toBe('magenta');
});

// The kept question and its answer are one block on a ground of their own: both
// keys are on the chat palette of every scheme, or the rows would paint nothing on
// one of them.
test('the ask ground lands in every palette', () => {
  for (const scheme of ['light', 'dark', 'unknown'] as const) {
    const chat = resolved({}, scheme).chat!;
    expect(chat.askBg).toBeString();
    expect(chat.askInk).toBeString();
  }
  // A quiet tint, not a second ground or a second ink: on the schemes that ship colours
  // of their own it tells apart from the chat's `bg`, from the person's bubble, and the
  // ink from the ground it is read on.
  for (const scheme of ['light', 'dark'] as const) {
    const chat = resolved({}, scheme).chat!;
    expect(chat.askBg).not.toBe(chat.bg);
    expect(chat.askBg).not.toBe(chat.userBg);
    expect(chat.askInk).not.toBe(chat.askBg);
  }
  const mine = resolved({ light: { chat: { askBg: 'red', askInk: 'white' } } }, 'light').chat!;
  expect(mine.askBg).toBe('red');
  expect(mine.askInk).toBe('white');
});

// A diff's two inks and the grounds they sit on are the palette's, in every scheme:
// the `✎` block, a fence the model wrote and the `/diff` panel all read them, and
// none of the three falls back to a colour of its own.
test('the diff inks and their bands land in every palette', () => {
  for (const scheme of ['light', 'dark', 'unknown'] as const) {
    const chat = resolved({}, scheme).chat!;
    for (const key of ['add', 'del', 'addBg', 'delBg'] as const) expect(chat[key]).toBeString();
  }
  const light = resolved({}, 'light').chat!;
  const dark = resolved({}, 'dark').chat!;
  // A deletion is not what waits on the person: the two are told apart in both schemes.
  expect(light.del).not.toBe(light.warn);
  expect(dark.del).not.toBe(dark.warn);
  // A pale band under dark ink on a light terminal, a dark one under bright ink — the
  // relation, not just "a different value": a swapped pair (a pale ink on its own pale
  // band) keeps every inequality and still reads as mud.
  expect(light.delBg).not.toBe(dark.delBg);
  expect(luminance(light.add!)).toBeLessThan(luminance(light.addBg!));
  expect(luminance(light.del!)).toBeLessThan(luminance(light.delBg!));
  expect(luminance(dark.add!)).toBeGreaterThan(luminance(dark.addBg!));
  expect(luminance(dark.del!)).toBeGreaterThan(luminance(dark.delBg!));
  const mine = resolved({ light: { chat: { del: 'blue', delBg: 'black' } } }, 'light').chat!;
  expect(mine.del).toBe('blue');
  expect(mine.delBg).toBe('black');
});

test('baseInk takes the base roles, and leaves the terminal what the palette left it', () => {
  // `default` is the palette saying "the terminal's": nothing of the app's own is
  // painted where it is — the honest ground for a scheme that was never said.
  expect(baseInk(resolved({}, 'unknown'))).toEqual({ bg: undefined, text: undefined, border: 'cyan', selected: 'green' });
  expect(baseInk(resolved({}, 'light'))).toEqual({ bg: '#f4f4f6', text: 'black', border: 'blue', selected: 'green' });
  expect(baseInk(resolved({}, 'dark'))).toEqual({ bg: 'black', text: 'white', border: 'cyan', selected: 'green' });
  // A person's own value on its scheme reaches the host's side too.
  expect(baseInk(resolved({ dark: { base: { bg: 'blue' } } }, 'dark'))).toMatchObject({ bg: 'blue' });
  expect(baseInk(undefined)).toEqual({ bg: undefined, text: undefined, border: undefined, selected: undefined });
});

test("an unknown terminal takes no tuned plugin colour: the person's tuning stays on its scheme", () => {
  const plugins = [{ name: 'board', palette: { dark: { x: '#123456' }, light: { x: '#123456' } } }];
  const theme = { dark: { board: { x: 'red' } } };
  expect(resolved(theme, 'dark', plugins).board!.x).toBe('red');
  expect(resolved(theme, 'unknown', plugins).board!.x).toBe('#123456');
});

test('each value a hand edit gets wrong is listed, and the rest of the theme still builds', () => {
  const cases: Array<[unknown, string]> = [
    [{ dark: { chat: { userBg: '#12' } } }, 'theme.dark.chat.userBg'],
    [{ dark: { chat: { userBg: '${base.nope}' } } }, 'theme.dark.chat.userBg'],
    [{ dark: { base: { nope: 'red' } } }, 'theme.dark.base.nope'],
    [{ dark: 'red' }, 'theme.dark'],
    ['red', 'theme'],
  ];
  for (const [theme, path] of cases) {
    const built = buildModels(theme, []);
    expect(built.ignored.map((i) => i.path)).toEqual([path]);
    expect(resolveAppTheme(built, 'dark').base.bg).toBe(HOST_PALETTE.dark.base.bg);
  }
});

test('a configured key no surface draws is left out and listed as such', () => {
  const plugins = [{ name: 'board', palette: { dark: { swimlaneBg: 'red' }, light: { swimlaneBg: 'red' } } }, { name: 'plain' }];
  const built = buildModels({
    dark: { chat: { usrBg: '#111111', userBg: '#111111' }, nosuchplugin: { x: 'red' }, board: { zzz: 'red', swimlaneBg: 'blue', text: 'red' }, plain: { text: 'red', y: 'red' } },
  }, plugins);
  expect(built.ignored.filter((i) => i.why === 'key').map((i) => i.path).sort()).toEqual(
    ['theme.dark.board.zzz', 'theme.dark.chat.usrBg', 'theme.dark.nosuchplugin.x', 'theme.dark.plain.y'],
  );
  expect(built.ignored.filter((i) => i.why !== 'key')).toEqual([]);
  const dark = resolveAppTheme(built, 'dark');
  expect(dark.chat!.usrBg).toBeUndefined();
  expect(dark.chat!.userBg).toBe('#111111');
  expect(dark.board!.swimlaneBg).toBe('blue');
  expect(dark.nosuchplugin).toBeUndefined();
});

test('a plugin still starting keeps its overrides and is not judged before it joins', () => {
  const built = buildModels({ dark: { late: { x: 'red' } } }, [], { pending: ['late'] });
  expect(built.ignored).toEqual([]);
  expect(resolveAppTheme(built, 'dark').late!.x).toBe('red');
});

test('the start notes say what is not applied, by count, and where an old key is to be removed', () => {
  const none = () => false;
  expect(themeStartNotes([], [], none)).toEqual([]);
  expect(themeStartNotes([{ path: 'theme.dark.chat.userBg', why: 'value' }], [], none)).toEqual([
    'theme.dark.chat.userBg is not a colour the theme takes, and is not applied',
  ]);
  expect(themeStartNotes([{ path: 'theme.dark.a', why: 'value' }, { path: 'theme.dark.b', why: 'value' }, { path: 'theme.dark.chat.usrBg', why: 'key' }], [], none)).toEqual([
    'theme.dark.a, theme.dark.b are not colours the theme takes, and are not applied',
    'theme.dark.chat.usrBg is not a key that surface draws, and is not applied',
  ]);
  expect(themeStartNotes([], ['theme.modals'], none)).toEqual([
    'theme.modals is from the old format and is not applied — run flow-assist config migrate-theme',
  ]);
  const inJson = (key: string) => key === 'theme.selected' || key === 'plugins.board.colors';
  expect(themeStartNotes([], ['theme.modals', 'theme.selected', 'plugins.board.colors'], inJson)).toEqual([
    'theme.modals is from the old format and is not applied — run flow-assist config migrate-theme',
    'theme.selected, plugins.board.colors in config.json are from the old format and are not applied — run flow-assist config migrate-theme, then remove them from config.json',
  ]);
  for (const line of themeStartNotes([{ path: 'theme.dark', why: 'value' }], ['theme.modals'], none)) expect(line.startsWith('theme: ')).toBe(false);
});
