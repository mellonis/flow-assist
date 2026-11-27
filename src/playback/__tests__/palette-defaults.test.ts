// The host's palettes written as base roles: resolving them gives the colours the
// host has always drawn, and the chat's own keys follow the roles they name.
import { expect, test } from 'bun:test';
import { CHAT_KEYS, HOST_PALETTE, UNKNOWN_RESOLVED } from '../palette-defaults';
import { ROLES, resolveSurface, type Scheme } from '../palette';

// The colours the host drew before the palette was written as roles, kept here as
// the fixture for "the look did not change".
const OLD_BASE: Record<Scheme, Record<string, string>> = {
  dark: {
    bg: 'black', border: 'cyan', text: 'white', selected: 'green', fieldBg: 'gray', fieldBorder: 'cyan',
    panelBg: '#1a1b26', highlight: '#3c3c3c', highlightStrong: '#20456b', highlightText: 'white',
    danger: 'red', ok: 'green',
  },
  light: {
    bg: '#f4f4f6', border: 'blue', text: 'black', selected: 'green', fieldBg: '#e2e2e8', fieldBorder: 'blue',
    panelBg: '#ececf2', highlight: '#e2e2e2', highlightStrong: '#d4e3f5', highlightText: 'black',
    danger: 'red', ok: 'green',
  },
};
const OLD_CHAT: Record<Scheme, Record<string, string>> = {
  dark: { userBg: '#2b2b40', accent: 'cyan', shell: 'magentaBright', assistantAccent: 'green', fieldBg: '#1f1f2e', bgAccent: 'magenta', bgBg: '#2a2438', warn: 'yellow', ok: 'green', add: 'green', del: 'red', addBg: '#003b00', delBg: '#3b0000', idleBorder: 'gray', askBg: '#243036', askInk: '#dfe8e6' },
  light: { userBg: '#e4e4f0', accent: 'blue', shell: 'magenta', assistantAccent: 'green', fieldBg: '#eaeaf0', bgAccent: 'magenta', bgBg: '#efe4f2', warn: '#9a6700', ok: 'green', add: 'green', del: '#a40000', addBg: '#e6f4e6', delBg: '#fce8e8', idleBorder: '#a0a0b0', askBg: '#e3eeec', askInk: '#2b3f3b' },
};
const OLD_UNKNOWN_BASE: Record<string, string> = {
  bg: 'default', border: 'cyan', text: 'default', selected: 'green', fieldBg: 'default', fieldBorder: 'cyan',
  panelBg: 'default', highlight: 'default', highlightStrong: 'default', highlightText: 'default',
  danger: 'red', ok: 'green',
};
const OLD_UNKNOWN_CHAT: Record<string, string> = {
  ...OLD_CHAT.dark, userBg: 'default', fieldBg: 'default', bgBg: 'default', addBg: 'default', delBg: 'default', askBg: 'default', askInk: 'default',
};

for (const scheme of ['dark', 'light'] as const) {
  test(`${scheme}: the base roles equal the colours the host drew`, () => {
    const base = resolveSurface(HOST_PALETTE[scheme], 'log');
    for (const [role, value] of Object.entries(OLD_BASE[scheme])) expect(base[role]).toBe(value);
  });

  test(`${scheme}: the chat resolves to the colours it drew`, () => {
    const chat = resolveSurface(HOST_PALETTE[scheme], 'chat');
    for (const [key, value] of Object.entries(OLD_CHAT[scheme])) expect(chat[key]).toBe(value);
  });

  test(`${scheme}: every chat key and every role resolves to a non-empty string`, () => {
    const chat = resolveSurface(HOST_PALETTE[scheme], 'chat');
    for (const key of CHAT_KEYS) expect(chat[key]?.length).toBeGreaterThan(0);
    for (const role of ROLES) expect(chat[role]?.length).toBeGreaterThan(0);
  });

  test(`${scheme}: keycaps ride the panel ground and the text ink`, () => {
    const base = resolveSurface(HOST_PALETTE[scheme], 'log');
    const keycaps = resolveSurface(HOST_PALETTE[scheme], 'keycaps');
    expect(keycaps.bg).toBe(base.panelBg!);
    expect(keycaps.text).toBe(base.text!);
  });

  test(`${scheme}: the markdown keys are written as roles`, () => {
    const keys = HOST_PALETTE[scheme].surfaces.chat!;
    expect(keys.mdHeading).toBe('${base.accent}');
    expect(keys.mdCode).toBe('${base.selected}');
    expect(keys.mdLink).toBe('${base.selected}');
    expect(keys.mdList).toBe('${base.muted}');
    expect(keys.mdQuote).toBe('${base.muted}');
  });

  test(`${scheme}: the log surface adds nothing`, () => {
    expect(HOST_PALETTE[scheme].surfaces.log).toEqual({});
  });
}

test('CHAT_KEYS lists the chat keys', () => {
  expect([...CHAT_KEYS]).toEqual([
    'accent', 'shell', 'assistantAccent', 'userBg', 'fieldBg', 'bgAccent', 'bgBg', 'warn', 'ok', 'add', 'del',
    'addBg', 'delBg', 'idleBorder', 'askBg', 'askInk', 'mdHeading', 'mdCode', 'mdLink', 'mdList', 'mdQuote',
  ]);
});

test('unknown: the resolved records hold plain strings and the colours the host drew', () => {
  const base = UNKNOWN_RESOLVED.base!;
  for (const role of ROLES) expect(base[role]?.length).toBeGreaterThan(0);
  for (const [role, value] of Object.entries(OLD_UNKNOWN_BASE)) expect(base[role]).toBe(value);
  for (const key of CHAT_KEYS) expect(UNKNOWN_RESOLVED.chat![key]?.length).toBeGreaterThan(0);
  for (const [key, value] of Object.entries(OLD_UNKNOWN_CHAT)) expect(UNKNOWN_RESOLVED.chat![key]).toBe(value);
  expect(UNKNOWN_RESOLVED.log).toEqual({});
  expect(UNKNOWN_RESOLVED.keycaps).toEqual({ bg: 'default', text: 'default' });
  for (const record of Object.values(UNKNOWN_RESOLVED)) {
    for (const value of Object.values(record)) expect(value.includes('${')).toBe(false);
  }
});
