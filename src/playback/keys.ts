// Hotkeys (config-driven). Binding aliases live in config (the keys section) via
// config.json, not hardcoded: a user can remap a key without rebuilding the TUI.
// This module holds the defaults and the rule for how a binding is WRITTEN (see
// "Two vocabularies" below): bindings here and in config say 'enter' / 'space'; the
// terminal says 'return' / ' '.

// Full reference map of default key bindings. This is the tracker plugin's
// complete map: it includes tracker-domain actions (storyPoints, createSprint,
// foldSwimlane, filters, tags, comments, subissues, analysisJson, ...) that the
// host does not own or resolve.
export const DEFAULT_KEYS: Record<string, string | string[]> = {
  // command line
  commandLine: ':',
  // global
  log: 'l',
  bookmarks: 'M',          // opens the bookmarks popup; also Shift+m
  quit: 'q',
  search: '/',
  back: ['escape'],
  // navigation
  prev: 'up',
  next: 'down',
  open: ['enter', 'return'],
  openBrowser: 'b',
  // sprints
  createSprint: 'c',
  // task list
  bookmark: 'm',           // mark/unmark a bookmark (without Shift)
  filters: 'f',
  toggleBoard: 'g',
  clearCache: 'x',
  // board
  foldSwimlane: ['space', 'z'],
  boardPicker: 'c',
  // detail
  infoPanel: 'i',
  relations: 'r',
  addRelation: 'R',        // also Shift+r
  storyPoints: 'p',
  tags: 't',
  comments: 'c',
  subissues: 's',
  analyze: 'a',
  analysisJson: 'j',
  chat: 'A',               // opens the chat with the LLM (Shift+a; lowercase 'a' is analyze)
  attachment: 'o',
};

// ─── Two vocabularies, and the one place they meet ─────────────────────────────
// A key has a name in two different languages:
//   - what the TERMINAL says — the `key.name` flowtty's decoder produces: 'return',
//     ' ', ':', 'escape', 'pageup'. Every `key.name === …` comparison is in this one.
//   - what a PERSON writes — in config.json's `keys`, in a plugin's `keys` table:
//     "enter", "space", "colon", "esc". Nobody writes `"foldSwimlane": " "`.
// A binding is the second kind of thing and is turned into the first kind HERE, once,
// when the key map is built. Before this, a binding spelled 'enter' or 'space' was
// compared with the decoder's name as it stood and simply never fired: a plugin's
// `open: 'enter'` replaced the host's `['enter','return']` and Enter went dead.
// (What is DRAWN for a key — ⏎, ␣ — is a third thing, the plugins' keycaps.)
const KEY_SPELLINGS: Record<string, string> = {
  enter: 'return',
  space: ' ',
  spacebar: ' ',
  colon: ':',
  esc: 'escape',
  del: 'delete',
  ins: 'insert',
  pgup: 'pageup',
  pgdn: 'pagedown',
  pgdown: 'pagedown',
  bs: 'backspace',
};
// A binding as written → the name the decoder gives that key. A single character is
// itself (case matters: 'A' is Shift+a); a word is matched without regard to case.
export function canonicalKey(spelled: string): string {
  if (Array.from(spelled).length === 1) return spelled;
  const word = spelled.trim().toLowerCase();
  return KEY_SPELLINGS[word] ?? word;
}
// A whole binding (one spelling or several), canonical and without duplicates — so
// the old `['enter', 'return']` is just `['return']`.
export function canonicalBinding(binding: string | string[] | null | undefined): string[] {
  const list = Array.isArray(binding) ? binding : binding == null ? [] : [binding];
  return [...new Set(list.map((k) => canonicalKey(String(k))))];
}

// The other way: a decoder name → how a person would WRITE that key, for anything
// that shows a binding in words (the model's `config_schema`, a help line). ' ' is
// invisible and 'return' is not what is printed on the key.
const WRITTEN: Record<string, string> = { return: 'enter', ' ': 'space' };
export function writtenKey(name: string): string {
  return WRITTEN[name] ?? name;
}

// ─── The third vocabulary: what is DRAWN for a key ─────────────────────────────
// A keycap is neither the terminal's name nor a config spelling — it is what is
// printed on the key: ⏎, ␣, ⇥, ⌫, arrows. One code point each where a glyph exists
// (flowtty counts one cell per code point), a short word where none does. The
// keycaps panel draws the pressed keys with it, and any hint that shows a binding as
// a symbol should too, so the same key never looks two ways on one screen.
const KEY_GLYPHS: Record<string, string> = {
  return: '⏎',
  ' ': '␣',
  tab: '⇥',
  backspace: '⌫',
  delete: '⌦',
  escape: 'Esc',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  home: 'Home',
  end: 'End',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  insert: 'Ins',
  paste: 'paste',
  wheelup: 'wheel↑',
  wheeldown: 'wheel↓',
};
// The cap for a key as the terminal reported it — or for a terminal-side NAME alone
// (a resolved binding). Modifiers are part of what was pressed: `^r` is not `r`.
// Shift is shown only with a named key (⇧⇥): for a character the character already
// says it ('A'), and the decoder reports 'A', not shift+'a'.
export function keyGlyph(key: string | { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): string {
  const k = typeof key === 'string' ? { name: key } : key;
  const name = k.name ?? '';
  const named = Array.from(name).length !== 1;
  const cap = KEY_GLYPHS[name] ?? (/^f\d{1,2}$/.test(name) ? name.toUpperCase() : name);
  return `${k.ctrl ? '^' : ''}${k.meta ? '⌥' : ''}${k.shift && (named || name === ' ') ? '⇧' : ''}${cap}`;
}

// Host base of key bindings: only the shared/navigation actions the host keeps.
// Domain actions (log/bookmarks/filters/tags/...) are declared by each plugin in
// its own `keys` field instead — the plugin registers its own hotkeys, with a
// default or `[]` (disabled). The builder assembles the final map from
// HOST_DEFAULT_KEYS + plugin keys + config.plugins.<name>.keys + config.keys
// (config wins). Note: HOST_DEFAULT_KEYS is the resolvable base for the host —
// DEFAULT_KEYS above is the full reference map for the tracker plugin, and is NOT
// the host's base.
export const HOST_DEFAULT_KEYS: Record<string, string | string[]> = {
  commandLine: ':',
  quit: 'q',
  back: ['escape'],
  prev: 'up',
  next: 'down',
  open: 'enter',
  openBrowser: 'b',
  clearCache: 'x',
};

// Normalizes a hotkey map: an action's value is always reduced to an array of
// names (string -> [string], missing -> []). Defaults are merged with user
// overrides, so config.keys can override only the keys it needs. The host base is
// HOST_DEFAULT_KEYS (host-only actions), keeping the host tracker-agnostic;
// DEFAULT_KEYS is the full reference map for the tracker plugin.
export function resolveKeys(
  userKeys: Record<string, string | string[] | undefined> = {},
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [action, def] of Object.entries(HOST_DEFAULT_KEYS)) {
    out[action] = canonicalBinding(userKeys?.[action] ?? def);
  }
  return out;
}

// Did a key fire for an action? `binding` is the array of names (the result of
// resolveKeys), `name` is the key.name from useInput.
export function isKey(binding: string | string[], name: string): boolean {
  return Array.isArray(binding) ? binding.includes(name) : binding === name;
}