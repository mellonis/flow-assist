// TUI command line (neovim-style `:`). Only pure parsing logic and command
// metadata live here — no state/setter reading. Handlers live in App() and in the
// plugins that own the commands: commands hand back a parsed
// name + arguments, and App() dispatches against the command registry.
//
// `minArgs`/`maxArgs` (maxArgs = -1 — unlimited) validate the argument count.
// `usage` is the help text for the `help` command and for error hints.
//
// The host is tracker-agnostic: this is the generic command set only. Tracker-
// specific commands (open/search/bookmark/boards/browser/expand/full) are not
// part of the host command registry; they move to the tracker plugin.

import { hostConfigSchema } from './schema.js';
import { cellWidth } from '../cells.js';

// One value a command's argument takes: the word itself, or the word with a label
// shown beside it (`{ value: '3', label: 'fix the build' }` — the label is never
// inserted).
export type ArgValue = string | { value: string; label?: string };
// What a command's FIRST argument may be: a fixed list, or a function read each time
// the line is drawn — for a list that changes (the saved sessions). A function that
// throws reads as no values.
export type ArgValues = readonly ArgValue[] | (() => readonly ArgValue[]);

export type Command = {
  name: string;
  aliases?: string[];
  usage: string;
  minArgs: number;
  maxArgs: number;
  description: string;
  // `false` keeps the command out of the `:` line's ↑/↓ history — for a command whose
  // argument may carry a secret. Every command is remembered otherwise.
  history?: boolean;
  // The values the first argument takes; the line completes it from them.
  values?: ArgValues;
};

// Basic host command set. `maxArgs = -1` means an unlimited argument count.
// The host's own commands. Every entry DOES something: a command that only set a
// view state nothing in the host reads would be listed in :help and silent when run.
// (A plugin that wants navigation commands declares its own.)
export const BASE_COMMANDS: Command[] = [
  { name: 'clear', aliases: ['clear-cache'], usage: 'clear', minArgs: 0, maxArgs: 0, description: 'Flush the cache' },
  { name: 'quit', aliases: ['q'], usage: 'quit', minArgs: 0, maxArgs: 0, description: 'Quit' },
  // Not remembered: a value set may be a secret — an MCP server's `headers` or `env`.
  { name: 'config', aliases: [], usage: 'config [get <key>|set [--session] <key> <value>|unset [--session] <key>|help]', minArgs: 0, maxArgs: -1, description: 'Show the whole config; get a key and where its value comes from; set a key (config.local.json, or with --session for this run only); unset a key (with --session, only the value for this run); help — what the keys are', history: false },
  { name: 'cache', aliases: [], usage: 'cache [on|off]', minArgs: 0, maxArgs: 1, description: 'Turn the cache on or off (config.cache.enabled)' },
  { name: 'help', aliases: ['?'], usage: 'help', minArgs: 0, maxArgs: 0, description: 'List the commands' },
];

// The words after `config`, read the same way on the `:` line and in the CLI:
// `get <key>`, `set [--session] <key> <value…>`, `unset [--session] <key>`. `value` is the rest
// of the words joined by one space — still text, `parseValue` reads it.
export type ConfigArgs = { sub: string; key?: string; value?: string; session: boolean };
export function parseConfigArgs(words: string[]): ConfigArgs {
  const sub = (words[0] ?? '').toLowerCase();
  const rest = words.slice(1);
  const session = (sub === 'set' || sub === 'unset') && rest[0] === '--session';
  if (session) rest.shift();
  return { sub, key: rest[0], ...(rest.length > 1 ? { value: rest.slice(1).join(' ') } : {}), session };
}

// A value typed on the `:` line loses one layer of surrounding quotes, as a shell
// takes it off: `config set ui.verbs '["Thinking"]'` reads the same in both places. Inside
// single quotes `'\''` is an apostrophe, as a shell reads it — what `configSetLine`
// writes for a value holding both kinds of quote. (The line's words are joined by one
// space, so a run of spaces inside quotes comes back as one.)
export function unquoteValue(text: string): string {
  const t = text.trim();
  if (t.length < 2 || (t[0] !== "'" && t[0] !== '"') || t.at(-1) !== t[0]) return t;
  const inner = t.slice(1, -1);
  return t[0] === "'" ? inner.replace(/'\\''/g, "'") : inner;
}

// What `config get` answers: the value and where it comes from — `session`, `local`
// (config.local.json), `config` (config.json) or `default` (neither: the consumer's
// own default).
export function describeConfigValue(key: string, value: unknown, source: string): string {
  return value === undefined ? `no key ${key} · ${source}` : `${JSON.stringify(value)} · ${source}`;
}

// The `config set` line that sets `value` at `key` — what the person would type, in
// the app's `:` line or (without `--session`) in a shell: the y/n block of the model's
// `config_set` shows it, and a refusal names it. A string goes as its text, anything
// else as JSON; a word with a character a shell would read is single-quoted, and the
// `:` line takes the quotes off again (`unquoteValue`).
// A control character in a string is drawn as its escape, so the line stays one line.
export function configSetLine(key: string, value: unknown, scope: 'session' | 'saved'): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, (c) => JSON.stringify(c).slice(1, -1));
  const word = text !== '' && /^[\w.,:/@+=%-]+$/.test(text) ? text
    : text.includes("'") && !text.includes('"') ? `"${text}"`
    : `'${text.replace(/'/g, `'\\''`)}'`;
  return `config set ${scope === 'session' ? '--session ' : ''}${key.trim()} ${word}`;
}

// Returns the command metadata for a name/alias, or null.
export function findCommand(name: string): Command | null {
  const n = String(name ?? '').toLowerCase();
  return BASE_COMMANDS.find(c => c.name === n || c.aliases?.includes(n)) ?? null;
}

// Parses a command input line into { name, rawArgs, cmd }. Returns null on an
// empty line — then App() just closes the command line without any action.
export function parseCommand(text: string): { name: string; rawArgs: string; cmd: Command | null } | null {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\S+)(?:\s([\s\S]*))?$/);
  const name = match![1];
  const rawArgs = (match![2] ?? '').trim();
  const cmd = findCommand(name);
  return { name, rawArgs, cmd };
}

// Number of arguments (whitespace-separated words) — for validation.
export function argCount(rawArgs: string): number {
  return String(rawArgs ?? '').split(/\s+/).filter(Boolean).length;
}

// Validates a command: unknown name or an out-of-range argument count.
// Returns an error message, or null when everything is fine.
export function validateCommand(cmd: Command | null, count: number): string | null {
  if (!cmd) return 'Unknown command';
  if (count < cmd.minArgs) return `Not enough arguments. Usage: ${cmd.usage}`;
  if (cmd.maxArgs >= 0 && count > cmd.maxArgs) return `Too many arguments. Usage: ${cmd.usage}`;
  return null;
}

// Flat walk of the config: returns dot paths to leaves with their values
// [{ path, value }]. For `config <key>` completion we complete by path.
export function flattenConfigPaths(obj: unknown, prefix = ''): { path: string; value: unknown }[] {
  const out: { path: string; value: unknown }[] = [];
  for (const [k, v] of Object.entries((obj ?? {}) as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenConfigPaths(v, path));
    } else {
      out.push({ path, value: v });
    }
  }
  return out;
}

// Acceptable values for completing `config <key> <value>`. Takes either an
// actual value (for keys from the config) or a schema node `{ schema }` (for
// plugin namespaces whose fields are not yet set in the config). For now only
// boolean keys (parseValue understands 'true'/'false'; the `cache` command uses
// on/off separately, so for config we keep true/false).
export function configValueOptions(node: unknown): string[] {
  if (node && typeof node === 'object') {
    if ('value' in node) node = (node as { value: unknown }).value;
    else if ('schema' in node) {
      const t = schemaType((node as { schema: unknown }).schema);
      if (t === 'boolean') return ['true', 'false'];
      return [];
    }
  }
  if (typeof node === 'boolean') return ['true', 'false'];
  return [];
}

// The zod node type with wrappers (optional/nullable/default) unwrapped — in v4
// the inner schema is only reachable after `.unwrap()`.
function schemaType(schema: unknown): string {
  let cur = schema as any;
  while (cur && (cur.type === 'optional' || cur.type === 'nullable' || cur.type === 'default')) {
    cur = cur.unwrap?.() ?? cur;
  }
  return cur?.type ?? '';
}

// Completion of arguments after the `config get|set|unset <key> [value]`
// subcommand. `text` is everything after the subcommand (e.g. `cache.` for
// `config get cache.`). Returns the same contract as completeCommand: head =
// the prefix of the part being completed (keyHead when completing a key, else
// valueHead — when completing a value), best = the Tab candidate, candidates =
// the completion hint list.
export function completeConfigArgs(text: string, config?: unknown, configSchema: any = hostConfigSchema): CompleteResult {
  const m = String(text ?? '').match(/^(\S*)(?:\s([\s\S]*))?$/);
  const keyHead = m![1];
  const hasValueSpace = m![2] !== undefined;
  const valueHead = m![2] ?? '';
  const nodes = configPaths(config, configSchema);

  if (!hasValueSpace) return completeConfigKey(keyHead, nodes);
  return completeConfigValue(keyHead, valueHead, nodes);
}

// Subcommands of `config get|set|unset|help` — there is no bare `config <key>` form.
const CONFIG_SUBS = ['get', 'set', 'unset', 'help'];

// Completion of arguments after `config ` accounting for subcommands. Empty
// input hints the subcommands themselves; a subcommand prefix completes it;
// after get/set/unset it is the usual key/value completion (completeConfigArgs).
// `help` and any non-subcommand input get no candidates (that is an error
// anyway).
export function completeConfigCommand(text: string, config?: unknown, configSchema: any = hostConfigSchema): CompleteResult {
  const m = String(text ?? '').match(/^(\S*)(?:\s([\s\S]*))?$/);
  const first = m![1];
  const hasSpace = m![2] !== undefined;
  const lower = first.toLowerCase();

  if (!first) return { head: '', hasSpace: true, best: '', candidates: CONFIG_SUBS.slice() };
  if (!hasSpace && CONFIG_SUBS.some(s => s.startsWith(lower))) {
    const matches = CONFIG_SUBS.filter(s => s.startsWith(lower)).sort();
    // Full match — the subcommand is typed entirely; next it needs an argument
    // (get/set/unset) or nothing (help), so no candidates are shown.
    if (matches.length === 1 && matches[0] === lower) {
      return { head: first, hasSpace: false, best: '', candidates: [] };
    }
    const best = matches.find(s => s !== lower) ?? matches[0] ?? '';
    return { head: first, hasSpace: false, best, candidates: matches };
  }
  if (lower === 'set' || lower === 'unset') {
    // `--session` is a flag before the key: the key after it completes as it does
    // without it, and a word starting with `-` is offered the flag itself.
    const rest = m![2] ?? '';
    const flag = /^--session\s+([\s\S]*)$/.exec(rest);
    if (flag) return completeConfigArgs(flag[1]!, config, configSchema);
    if (/^-\S*$/.test(rest)) {
      const hit = '--session'.startsWith(rest) ? ['--session'] : [];
      return { head: rest, hasSpace: false, best: hit[0] ?? '', candidates: hit };
    }
  }
  if (lower === 'get' || lower === 'set' || lower === 'unset') {
    return completeConfigArgs(m![2] ?? '', config, configSchema);
  }
  return { head: first, hasSpace, best: '', candidates: [] };
}

function completeConfigKey(head: string, nodes: { path: string; value?: unknown; schema?: unknown }[]): CompleteResult {
  const kl = head.toLowerCase();
  let matches = [...new Set(nodes.map(n => n.path).filter(p => p.toLowerCase().startsWith(kl)))];
  // On a trailing dot (`config plugins.` / `config plugin.keycaps.`) show only
  // paths one segment deeper — namespaces at the `plugins.` level, fields at the
  // `plugins.keycaps.` level — not all the nested ones at once.
  if (head.endsWith('.')) {
    const target = head.split('.').filter(Boolean).length + 1;
    matches = matches.filter(p => p.split('.').length === target);
  }
  matches.sort((a, b) => a.localeCompare(b));
  const best = matches.find(p => p.toLowerCase() !== kl) ?? matches[0] ?? '';
  return { head, hasSpace: false, best, candidates: matches };
}

function completeConfigValue(keyHead: string, valueHead: string, nodes: { path: string; value?: unknown; schema?: unknown }[]): CompleteResult {
  const node = nodes.find(n => n.path === keyHead);
  const opts = configValueOptions(node);
  if (!opts.length) return { head: valueHead, hasSpace: true, best: '', candidates: [] };
  const vh = valueHead.toLowerCase();
  const matches = opts.filter(v => v.toLowerCase().startsWith(vh))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  const best = matches.find(v => v.toLowerCase() !== vh) ?? matches[0] ?? '';
  return { head: valueHead, hasSpace: true, best, candidates: matches };
}

// All candidate keys for completing `config get|set|unset <key>`: nodes
// { path, value } (the actual config) and { path, schema } (plugin namespaces).
// Value options for namespaces come from the schema (a getSchemaAtPath-like node
// type), because fields like plugins.keycaps.enabled are not yet set in the
// config. Plugin namespaces are always in the candidate registry — `config get
// pl` knows about plugins from a partial prefix, and the actual value wins over
// the node type.
function configPaths(config?: unknown, configSchema: any = hostConfigSchema): { path: string; value?: unknown; schema?: unknown }[] {
  const nodes = new Map<string, { path: string; value?: unknown; schema?: unknown }>();
  for (const n of pluginSchemaPaths(configSchema)) nodes.set(n.path, n);
  for (const { path, value } of flattenConfigPaths(config ?? {})) {
    nodes.set(path, { path, value });
  }
  return [...nodes.values()];
}

// Plugin-namespace paths from the schema: the root (plugins), the namespaces
// (plugins.<name>) and their fields (plugins.<name>.<field>). A plugin without a
// configSchema yields z.unknown — only the namespace, no deeper.
function pluginSchemaPaths(configSchema: any): { path: string; schema: unknown }[] {
  const pluginsNode = configSchema?.shape?.plugins;
  const pluginsShape = pluginsNode?.shape;
  if (!pluginsShape) return [];
  const out: { path: string; schema: unknown }[] = [{ path: 'plugins', schema: pluginsNode }];
  for (const [name, pluginSchema] of Object.entries(pluginsShape) as [string, any][]) {
    const base = `plugins.${name}`;
    out.push({ path: base, schema: pluginSchema });
    const inner = pluginSchema?.unwrap?.();
    if (inner?.shape) {
      for (const [field, fieldSchema] of Object.entries(inner.shape)) {
        out.push({ path: `${base}.${field}`, schema: fieldSchema });
      }
    }
  }
  return out;
}

export type CompleteResult = {
  head: string;
  hasSpace: boolean;
  best: string;
  candidates: string[];
  // A word said beside a candidate (a session's title beside its number), by
  // candidate; absent when no candidate has one.
  labels?: Record<string, string>;
};

// The values of a command's argument, resolved: a function is called (its throw is an
// empty list), each entry read as its word and its label.
function argValues(values: ArgValues | undefined): { value: string; label?: string }[] {
  if (!values) return [];
  let list: readonly ArgValue[];
  try { list = typeof values === 'function' ? values() : values; } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.map((v) => (typeof v === 'string' ? { value: v } : { value: String(v?.value ?? ''), label: v?.label })).filter((v) => v.value);
}

// Completion of a command's first argument from its declared values. `text` is the
// argument text — everything after the command and its space. The values are kept in
// their declared order (an `/auto` rung after the one before it); `best` is the first
// that is not the typed word itself, so Tab on a whole word walks to the next. A text
// with a second word in it completes nothing: the values are the first argument's.
export function completeValues(text: string, values: ArgValues | undefined): CompleteResult {
  const m = String(text ?? '').match(/^(\S*)(\s[\s\S]*)?$/);
  const head = m![1];
  if (m![2] !== undefined) return { head: '', hasSpace: true, best: '', candidates: [] };
  const all = argValues(values);
  const lower = head.toLowerCase();
  const matches = all.filter((v) => v.value.toLowerCase().startsWith(lower));
  const best = matches.find((v) => v.value.toLowerCase() !== lower)?.value ?? matches[0]?.value ?? '';
  const labels: Record<string, string> = {};
  for (const v of matches) if (v.label) labels[v.value] = v.label;
  return { head, hasSpace: true, best, candidates: matches.map((v) => v.value), ...(Object.keys(labels).length ? { labels } : {}) };
}

// Completion of a command name/alias by the first word's prefix. Returns:
//   head      — the typed prefix (first word up to the space);
//   hasSpace  — whether a space follows (after the first word);
//   best      — the Tab candidate: the first alphabetically that is actually
//               longer than the prefix (i.e. it completes), else the first of
//               the matches (when the prefix already equals the name/alias —
//               nothing to insert);
//   candidates— all matching names/aliases, alphabetically (the hint list).
// An empty prefix → candidates=[] (don't complete an empty string with the full
// command list — too noisy; the user completes a specific command).
// For `config get|set|unset <key> [value]` it delegates the arguments to
// completeConfigCommand (config — the actual config object, configSchema — the
// schema for plugin namespaces, both optional); for any other command that declares
// `values`, the first argument is completed from them (completeValues). The first
// command word is still the ordinary completion.
export function completeCommand(text: string, commands: Command[] = BASE_COMMANDS, config?: unknown, configSchema: any = hostConfigSchema): CompleteResult {
  const raw = String(text ?? '');
  const m = raw.match(/^(\S*)(?:\s([\s\S]*))?$/);
  const head = m![1];
  const hasSpace = m![2] !== undefined;
  if (head.toLowerCase() === 'config' && hasSpace) {
    return completeConfigCommand(m![2] ?? '', config, configSchema);
  }
  if (hasSpace) {
    // The command by the bare name the person typed (a plugin's is registered
    // qualified, `boards:open`, as in the name completion below).
    const lower = head.toLowerCase();
    const bare = (n: string) => (n.includes(':') ? n.slice(n.lastIndexOf(':') + 1) : n).toLowerCase();
    const cmd = commands.find((c) => bare(c.name) === lower || (c.aliases ?? []).some((a) => a.toLowerCase() === lower));
    if (cmd?.values) return completeValues(m![2] ?? '', cmd.values);
    return { head, hasSpace, best: '', candidates: [] };
  }
  if (!head) return { head, hasSpace, best: '', candidates: [] };
  const lower = head.toLowerCase();
  // The command registry namespaces plugin commands ('assistant:ask'), but the
  // user types the BARE name — and findIn resolves it by that same bare form
  // (see registry.findIn). So complete against the bare name/alias: the hint and
  // Tab should insert `ask`, not `assistant:ask`.
  const names = commands.flatMap(c => [
    c.name.includes(':') ? c.name.slice(c.name.lastIndexOf(':') + 1) : c.name,
    ...(c.aliases ?? []),
  ]);
  const matches = [...new Set(names)]
    .filter(Boolean)
    .filter(n => n.toLowerCase().startsWith(lower))
    .sort((a: string, b: string) => a.localeCompare(b));
  const best = matches.find(n => n.toLowerCase() !== lower) ?? matches[0] ?? '';
  return { head, hasSpace, best, candidates: matches };
}

// A command reduced to its "help mode": sorted by name, showing usage +
// description. A pure function — easy to cover with a test.
export function helpText(commands: Command[] = BASE_COMMANDS): string {
  return commands
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => {
      const alias = (c.aliases ?? []).filter(a => a !== c.name).join('/');
      // A command may omit `usage` (some plugins define only name+description);
      // fall back to the name so the padding never runs on undefined and crashes
      // the help modal (a real latent defect). For a namespaced plugin command
      // (`core:help`) the prefix is stripped so the list reads `help`/`ask` —
      // matching what the user actually types, since findIn's bare-name fallback
      // resolves those too (a `:core:help` entry would be uninvokable-looking).
      const usage = c.usage ?? (c.name.includes(':') ? c.name.slice(c.name.indexOf(':') + 1) : c.name);
      const label = alias ? `${usage} (${alias})` : usage;
      // Padded by cells: a usage may hold a wide character, a flag or a ZWJ sequence.
      return `${label}${' '.repeat(Math.max(0, 24 - cellWidth(label)))} ${c.description}`;
    })
    .join('\n');
}