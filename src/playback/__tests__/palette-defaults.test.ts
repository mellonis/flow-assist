// The host's palettes written as base roles: resolving them gives Claude Code's own
// dark and light colours, and the chat's own keys follow the roles they name.
import { expect, test } from 'bun:test';
import { CHAT_KEYS, HOST_PALETTE, UNKNOWN_RESOLVED } from '../palette-defaults';
import { ROLES, resolveSurface, type Scheme } from '../palette';

// The colours of the Claude Code CLI's dark and light themes, as the host resolves them.
const CLAUDE_BASE: Record<Scheme, Record<string, string>> = {
  dark: {
    bg: '#1a1a1a', border: '#888888', text: '#ffffff', muted: '#999999', accent: '#d77757', selected: '#b1b9f9',
    fieldBg: '#1a1a1a', fieldBorder: '#888888', panelBg: '#262626', highlight: '#264f78', highlightStrong: '#20456b',
    highlightText: '#ffffff', danger: '#ff6b80', ok: '#4eba65', warn: '#ffc107',
  },
  light: {
    bg: '#ffffff', border: '#8a8a8a', text: '#000000', muted: '#666666', accent: '#d77757', selected: '#5769f7',
    fieldBg: '#ffffff', fieldBorder: '#8a8a8a', panelBg: '#f5f5f5', highlight: '#b4d5ff', highlightStrong: '#d4e3f5',
    highlightText: '#000000', danger: '#ab2b3f', ok: '#2c7a39', warn: '#966c1e',
  },
};
const CLAUDE_CHAT: Record<Scheme, Record<string, string>> = {
  dark: { userBg: '#373737', accent: '#d77757', shell: '#fd5db1', assistantAccent: '#d77757', fieldBg: '#262626', bgAccent: '#00cccc', bgBg: '#374146', warn: '#ffc107', ok: '#4eba65', add: '#ffffff', del: '#ffffff', addBg: '#225c2b', delBg: '#7a2936', idleBorder: '#505050', askBg: '#262626', askInk: '#ffffff' },
  light: { userBg: '#f0f0f0', accent: '#d77757', shell: '#ff0087', assistantAccent: '#d77757', fieldBg: '#f5f5f5', bgAccent: '#009999', bgBg: '#e6f5fa', warn: '#966c1e', ok: '#2c7a39', add: '#000000', del: '#000000', addBg: '#69db7c', delBg: '#ffa8b4', idleBorder: '#afafaf', askBg: '#f5f5f5', askInk: '#000000' },
};
// The unknown scheme keeps the terminal's own colours (it is not Claude Code's).
const OLD_CHAT_DARK: Record<string, string> = { accent: 'cyan', shell: 'magentaBright', assistantAccent: 'green', bgAccent: 'magenta', warn: 'yellow', ok: 'green', add: 'green', del: 'red', idleBorder: 'gray' };
const OLD_UNKNOWN_BASE: Record<string, string> = {
  bg: 'default', border: 'cyan', text: 'default', selected: 'green', fieldBg: 'default', fieldBorder: 'cyan',
  panelBg: 'default', highlight: 'default', highlightStrong: 'default', highlightText: 'default',
  danger: 'red', ok: 'green',
};
const OLD_UNKNOWN_CHAT: Record<string, string> = {
  ...OLD_CHAT_DARK, userBg: 'default', fieldBg: 'default', bgBg: 'default', addBg: 'default', delBg: 'default', askBg: 'default', askInk: 'default',
};

for (const scheme of ['dark', 'light'] as const) {
  test(`${scheme}: the base roles are Claude Code's`, () => {
    const base = resolveSurface(HOST_PALETTE[scheme], 'log');
    for (const [role, value] of Object.entries(CLAUDE_BASE[scheme])) expect(base[role]).toBe(value);
  });

  test(`${scheme}: the chat resolves to Claude Code's colours`, () => {
    const chat = resolveSurface(HOST_PALETTE[scheme], 'chat');
    for (const [key, value] of Object.entries(CLAUDE_CHAT[scheme])) expect(chat[key]).toBe(value);
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

// The keys that were literals in the drawing code: the phase colours follow Claude
// Code (pulse = claudeShimmer, thought = autoAccept, plan = planMode); the context
// meter keeps its own.
const DRAWN: Record<Scheme, Record<string, string>> = {
  dark: { pulse: '#eb9f7f', thought: '#af87ff', plan: '#48968c', ctxInstructions: '#d77757', ctxTools: 'magenta', ctxMemory: '#ffc107', ctxPlan: '#4eba65', ctxSummary: 'blue', ctxScreen: 'greenBright', ctxMessages: '#ffffff', ctxImages: 'cyanBright' },
  light: { pulse: '#f59575', thought: '#8700ff', plan: '#006666', ctxInstructions: '#d77757', ctxTools: 'magenta', ctxMemory: '#966c1e', ctxPlan: '#2c7a39', ctxSummary: '#005f87', ctxScreen: '#2e7d32', ctxMessages: '#000000', ctxImages: '#007b83' },
};
for (const scheme of ['dark', 'light'] as const) {
  test(`${scheme}: the keys the drawing code used to hard-code resolve`, () => {
    const chat = resolveSurface(HOST_PALETTE[scheme], 'chat');
    for (const [key, value] of Object.entries(DRAWN[scheme])) expect(chat[key]).toBe(value);
  });
}

test('CHAT_KEYS lists the chat keys', () => {
  expect([...CHAT_KEYS]).toEqual([
    'accent', 'shell', 'assistantAccent', 'userBg', 'fieldBg', 'bgAccent', 'bgBg', 'warn', 'ok', 'add', 'del',
    'addBg', 'delBg', 'idleBorder', 'askBg', 'askInk', 'mdHeading', 'mdCode', 'mdLink', 'mdList', 'mdQuote',
    'pulse', 'thought', 'plan', 'ctxInstructions', 'ctxTools', 'ctxMemory', 'ctxPlan', 'ctxSummary', 'ctxScreen', 'ctxMessages', 'ctxImages',
  ]);
});

test('unknown: the resolved records hold plain strings and the colours the host drew', () => {
  const base = UNKNOWN_RESOLVED.base!;
  for (const role of ROLES) expect(base[role]?.length).toBeGreaterThan(0);
  for (const [role, value] of Object.entries(OLD_UNKNOWN_BASE)) expect(base[role]).toBe(value);
  // The markdown prose keys are absent: on unknown the prose keeps flowtty's own colours.
  for (const key of CHAT_KEYS) {
    if (key.startsWith('md')) expect(UNKNOWN_RESOLVED.chat![key]).toBeUndefined();
    else expect(UNKNOWN_RESOLVED.chat![key]?.length).toBeGreaterThan(0);
  }
  for (const [key, value] of Object.entries(OLD_UNKNOWN_CHAT)) expect(UNKNOWN_RESOLVED.chat![key]).toBe(value);
  expect(UNKNOWN_RESOLVED.log).toEqual({});
  expect(UNKNOWN_RESOLVED.keycaps).toEqual({ bg: 'default', text: 'default' });
  for (const record of Object.values(UNKNOWN_RESOLVED)) {
    for (const value of Object.values(record)) expect(value.includes('${')).toBe(false);
  }
});
