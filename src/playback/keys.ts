// Hotkeys (config-driven). Binding aliases live in config (the keys section) via
// config.json, not hardcoded: a user can remap a key without rebuilding the TUI.
// This module holds the defaults and the rule for how a binding is WRITTEN (see
// "Two vocabularies" below): bindings here and in config say 'enter' / 'space'; the
// terminal says 'return' / ' '.

// ─── Two vocabularies, and the one place they meet ─────────────────────────────
// A key has a name in two different languages:
//   - what the TERMINAL says — the `key.name` flowtty's decoder produces: 'return',
//     ' ', ':', 'escape', 'pageup'. Every `key.name === …` comparison is in this one.
//   - what a PERSON writes — in config.json's `keys`, in a plugin's `keys` table:
//     "enter", "space", "colon", "esc". Nobody writes `"foldSwimlane": " "`.
// A binding is the second kind of thing and is turned into the first kind HERE, once,
// when the key map is built. Comparing a binding spelled 'enter' or 'space' directly
// against the decoder's name would simply never fire: a plugin's
// `open: 'enter'` replacing the host's `['enter','return']` would leave Enter dead.
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
// ─── A modifier is part of the key, and so part of a binding ───────────────────
// An action may live on a key that is held with Ctrl or Alt — the chat's `details`
// is `^o`. A person writes that the way it is printed (`ctrl+o`, `^o`, `alt+enter`),
// and it meets the terminal's own report in the same place every other spelling does:
// `keyId` gives both sides ONE string, the terminal's name with the modifiers that
// were part of pressing it, in one fixed order. Without this a binding could only ever
// name a bare key, and an action on a modified one would have to be hard-coded in its
// handler, `key.name === 'r' && key.ctrl` style.
const MODIFIER_WORDS: Record<string, 'ctrl' | 'meta' | 'shift'> = {
  ctrl: 'ctrl', control: 'ctrl', ctl: 'ctrl',
  alt: 'meta', meta: 'meta', opt: 'meta', option: 'meta',
  shift: 'shift',
};
// The caps a person may type instead of the word: ^ for Ctrl, ⌥/⌃ as macOS prints them.
const MODIFIER_GLYPHS: Record<string, 'ctrl' | 'meta' | 'shift'> = { '^': 'ctrl', '⌃': 'ctrl', '⌥': 'meta', '⇧': 'shift' };
interface KeyParts { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean }
// A binding as written, split into the key and what is held with it. A lone `^` or
// `⇧` is a key in its own right, so a glyph is a modifier only with a key after it.
function asKey(spelled: string): KeyParts {
  if (Array.from(spelled).length === 1) return { name: spelled };
  let rest = spelled.trim();
  const held: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {};
  for (;;) {
    const word = /^([A-Za-z]+)\s*\+\s*/.exec(rest);
    const mod = word && MODIFIER_WORDS[word[1]!.toLowerCase()];
    if (word && mod) { held[mod] = true; rest = rest.slice(word[0].length); continue; }
    const glyph = MODIFIER_GLYPHS[Array.from(rest)[0] ?? ''];
    if (glyph && Array.from(rest).length > 1) { held[glyph] = true; rest = rest.slice(Array.from(rest)[0]!.length); continue; }
    break;
  }
  if (Array.from(rest).length === 1) return { name: rest, ...held };
  const word = rest.toLowerCase();
  return { name: KEY_SPELLINGS[word] ?? word, ...held };
}
// The one canonical form: what a binding is stored as, and what a pressed key is
// compared as. Shift on a CHARACTER is already in the character — the decoder reports
// 'A', not shift+'a' — so it is left off there, or `config.keys` and the terminal would
// never agree about a capital.
export function keyId(key: KeyLike): string {
  if (typeof key === 'string') return keyId(asKey(key));
  const name = key.name ?? '';
  const named = Array.from(name).length !== 1;
  return `${key.ctrl ? 'ctrl+' : ''}${key.meta ? 'alt+' : ''}${key.shift && named ? 'shift+' : ''}${name}`;
}

// A binding as written → the name the decoder gives that key. A single character is
// itself (case matters: 'A' is Shift+a); a word is matched without regard to case; a
// modifier written before it is kept, in the canonical spelling above.
export function canonicalKey(spelled: string): string {
  return keyId(asKey(spelled));
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
// printed on the key: ⏎, ␣, ⇥, ⌫, arrows. One narrow-width code point each where a
// glyph exists, a short word where none does. The keycaps panel draws the pressed
// keys with it, and any hint that shows a binding as a symbol should too, so the
// same key never looks two ways on one screen.
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
  // Mouse buttons (flowtty ≥ 1.0.0-alpha.15). They drive the drag-selection and no
  // handler here acts on them (`isMouseButton`), but a cap must still be short.
  mousedown: 'btn↓',
  mousedrag: 'drag',
  mouseup: 'btn↑',
};
// A mouse button key — press, drag or release. These belong to flowtty's
// drag-selection: nothing in the host or a plugin treats one as text, a dismissal or
// "any key", and the host stops them before its own dispatch (`runtime/app.tsx`).
export function isMouseButton(name: string | undefined): boolean {
  return name === 'mousedown' || name === 'mousedrag' || name === 'mouseup';
}
// The cap for a key as the terminal reported it — or for a terminal-side NAME alone
// (a resolved binding). Modifiers are part of what was pressed: `^r` is not `r`.
// Shift is shown only with a named key (⇧⇥): for a character the character already
// says it ('A'), and the decoder reports 'A', not shift+'a'.
// The Alt key is printed ⌥ on a Mac keyboard and "Alt" everywhere else; a cap names
// what the person will look for on THEIR keyboard.
export const META_CAP = process.platform === 'darwin' ? '⌥' : 'Alt+';
export type KeyLike = string | { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean };
export function keyGlyph(key: KeyLike): string {
  const k = typeof key === 'string' ? asKey(key) : key;
  const name = k.name ?? '';
  const named = Array.from(name).length !== 1;
  const cap = KEY_GLYPHS[name] ?? (/^f\d{1,2}$/.test(name) ? name.toUpperCase() : name);
  return `${k.ctrl ? '^' : ''}${k.meta ? META_CAP : ''}${k.shift && (named || name === ' ') ? '⇧' : ''}${cap}`;
}
// A whole binding as caps: `['return']` → `⏎`, `['z', ' ']` → `z/␣`. Empty when the
// action is unbound (config may disable one with `[]`) — a hint for it must not be
// shown at all, which is the caller's business.
export function bindingGlyph(binding: string | string[] | null | undefined): string {
  return canonicalBinding(binding).map((k) => keyGlyph(k)).join('/');
}
// The cap of the FIRST spelling of a binding. An action may answer to more than one
// key — `details` took `^o` and kept `^r`, which every hint written so far names — and
// a hint teaches ONE key: `^o/^r` in the middle of a line of hints reads as two keys
// to learn. Empty when the action is unbound, as `bindingGlyph` is.
export function firstGlyph(binding: string | string[] | null | undefined): string {
  const first = canonicalBinding(binding)[0];
  return first === undefined ? '' : keyGlyph(first);
}

// Host base of key bindings: only the shared/navigation actions the host keeps.
// Domain actions (log/bookmarks/filters/tags/...) are declared by each plugin in
// its own `keys` field instead — the plugin registers its own hotkeys, with a
// default or `[]` (disabled). The builder assembles the final map from
// HOST_DEFAULT_KEYS + plugin keys + config.plugins.<name>.keys + config.keys
// (config wins).
export const HOST_DEFAULT_KEYS: Record<string, string | string[]> = {
  commandLine: ':',
  // Quitting is the `:quit` (`:q`) command, or Ctrl+C twice — not a letter: a stray `q`
  // closed the whole app. The action stays, unbound, so `config.keys.quit` can
  // still put it on a key for a person who wants one.
  quit: [],
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
// HOST_DEFAULT_KEYS (host-only actions), keeping the host tracker-agnostic.
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
// resolveKeys); `key` is what `useInput` reported — the whole key where an action may
// sit on a modified one (`^o`), or its `name` alone where every binding is a bare key
// and a modifier held with it should not stop it firing.
export function isKey(binding: string | string[], key: KeyLike): boolean {
  const id = keyId(key);
  return Array.isArray(binding) ? binding.includes(id) : binding === id;
}