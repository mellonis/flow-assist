import { expect, test } from 'bun:test';
import { droppedReason, migrateTheme } from '../palette-migrate';
import { oldThemeKeys } from '../palette-config';

const PERSON = {"theme":{"modals":{"bg":"black","border":"cyan","borderBg":"black","text":"white","selected":"green","fieldBg":"gray","fieldBorder":"cyan"},"selected":"green","error":"red","success":"green","panelBg":"#1a1b26","highlightBg":"#3c3c3c","accentBg":"#20456b","highlightText":"white","canvas":{"modals":{"bg":"black"},"selected":"yellow"}},"plugins":{"chat":{"colors":{"userBg":"#232323","accent":"#fab283","shell":"#56b6c2","assistantAccent":"#7fd88f","fieldBg":"#141414","bgAccent":"#9d7cd8","bgBg":"#262335","warn":"#fcd53a","ok":"#7fd88f","idleBorder":"#4c4c4c","askBg":"#1b2a2a","askInk":"#d8e6e3"}}}};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

test('the person\'s config: only what differs from the dark defaults is set', () => {
  const r = migrateTheme(clone(PERSON));
  const keys = r.set.map(([k]) => k);
  // The flat theme equals today's dark defaults: no base value is set.
  expect(keys.filter((k) => k.startsWith('theme.dark.base.'))).toEqual([]);
  expect(r.set.filter(([k]) => k.startsWith('theme.dark.chat.'))).toHaveLength(12);
  expect(r.set).toContainEqual(['theme.dark.chat.userBg', '#232323']);
  expect(r.set).toContainEqual(['theme.dark.chat.askInk', '#d8e6e3']);
  expect(r.unset.sort()).toEqual(oldThemeKeys(PERSON).sort());
  expect(r.dropped).toEqual(['theme.modals.borderBg', 'theme.canvas']);
});

test('a value that differs is set under its role', () => {
  const r = migrateTheme({
    theme: { modals: { bg: '#101010', text: 'red', border: 'blue', fieldBg: 'blue', fieldBorder: 'red', selected: 'cyan' }, selected: 'magenta', error: '#f00', success: '#0f0', panelBg: '#111111', highlightBg: '#222222', accentBg: '#333333', highlightText: 'yellow' },
  });
  expect(Object.fromEntries(r.set)).toEqual({
    'theme.dark.base.bg': '#101010',
    'theme.dark.base.text': 'red',
    'theme.dark.base.border': 'blue',
    'theme.dark.base.fieldBg': 'blue',
    'theme.dark.base.fieldBorder': 'red',
    // theme.selected wins over theme.modals.selected.
    'theme.dark.base.selected': 'magenta',
    'theme.dark.base.danger': '#f00',
    'theme.dark.base.ok': '#0f0',
    'theme.dark.base.panelBg': '#111111',
    'theme.dark.base.highlight': '#222222',
    'theme.dark.base.highlightStrong': '#333333',
    'theme.dark.base.highlightText': 'yellow',
  });
  expect(r.unset.sort()).toEqual(['theme.accentBg', 'theme.error', 'theme.highlightBg', 'theme.highlightText', 'theme.modals', 'theme.panelBg', 'theme.selected', 'theme.success']);
});

test('an old ${token} is rewritten to its role; a plugin other than chat lands under its own name', () => {
  const r = migrateTheme({ theme: { highlightBg: '${panelBg}' }, plugins: { repo: { colors: { stripe: '${error}', plain: 'red' } } } });
  expect(Object.fromEntries(r.set)).toEqual({
    'theme.dark.base.highlight': '${base.panelBg}',
    'theme.dark.repo.stripe': '${base.danger}',
    'theme.dark.repo.plain': 'red',
  });
  expect(r.unset.sort()).toEqual(['plugins.repo.colors', 'theme.highlightBg']);
});

test('a value that is no colour, an unknown token and an unknown flat key are dropped', () => {
  const r = migrateTheme({ theme: { panelBg: 'not-a-colour', mystery: 'red', modals: { zzz: 'red' } } });
  expect(r.set).toEqual([]);
  expect(r.dropped.sort()).toEqual(['theme.mystery', 'theme.modals.zzz', 'theme.panelBg'].sort());
});

test('a new-format value already in the config is not overwritten', () => {
  const r = migrateTheme({ theme: { panelBg: '#111111', dark: { base: { panelBg: '#222222' } } } });
  expect(r.set).toEqual([]);
  expect(r.unset).toEqual(['theme.panelBg']);
});

test('nothing old means nothing to do, and a second pass over the result changes nothing', () => {
  expect(migrateTheme({})).toEqual({ set: [], unset: [], dropped: [] });
  expect(migrateTheme({ theme: { dark: { base: { bg: 'red' } } } })).toEqual({ set: [], unset: [], dropped: [] });
  // Apply the first pass by hand, then run again.
  const cfg: Record<string, any> = clone(PERSON);
  const first = migrateTheme(cfg);
  for (const [k, v] of first.set) {
    const parts = k.split('.');
    let cur = cfg;
    for (const p of parts.slice(0, -1)) cur = cur[p] ??= {};
    cur[parts.at(-1)!] = v;
  }
  for (const k of first.unset) {
    const parts = k.split('.');
    let cur = cfg;
    for (const p of parts.slice(0, -1)) cur = cur[p];
    delete cur[parts.at(-1)!];
  }
  expect(migrateTheme(cfg)).toEqual({ set: [], unset: [], dropped: [] });
});

test('each dropped key is given the reason that fits its value', () => {
  const cfg = {
    theme: { mystery: 'red', odd: { a: 1 }, panelBg: 'not-a-colour', accentBg: { a: 1 }, modals: { zzz: 'red', bg: 'nope', borderBg: 'black' }, canvas: { bg: 'black' } },
    plugins: { board: { colors: { lane: 'nope' } } },
  };
  const r = migrateTheme(clone(cfg));
  const why = Object.fromEntries(r.dropped.map((k) => [k, droppedReason(k, cfg)]));
  expect(why).toEqual({
    'theme.mystery': 'not a key the new theme knows',
    'theme.odd': 'not a key the new theme knows',
    'theme.panelBg': 'not a colour',
    'theme.accentBg': 'an object, not a colour',
    'theme.modals.zzz': 'not a key the new theme knows',
    'theme.modals.bg': 'not a colour',
    'theme.modals.borderBg': 'a frame\'s ground is base.bg',
    'theme.canvas': 'a resolved palette, not an override',
    'plugins.board.colors.lane': 'not a colour',
  });
});
