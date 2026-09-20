// Hotkeys (config-driven). Binding aliases live in config (the keys section) via
// config.json, not hardcoded: a user can remap a key without rebuilding the TUI.
// This module only holds the defaults. `open` maps to the single physical Enter
// that flowty reports as both 'enter' and 'return', so by default it is an array
// of two names. `back` is Escape and left-arrow.

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
  open: ['enter', 'return'],
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
  const toArr = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const out: Record<string, string[]> = {};
  for (const [action, def] of Object.entries(HOST_DEFAULT_KEYS)) {
    out[action] = toArr(userKeys?.[action] ?? def);
  }
  return out;
}

// Did a key fire for an action? `binding` is the array of names (the result of
// resolveKeys), `name` is the key.name from useInput.
export function isKey(binding: string | string[], name: string): boolean {
  return Array.isArray(binding) ? binding.includes(name) : binding === name;
}