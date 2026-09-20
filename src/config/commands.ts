// TUI command line (neovim-style `:`). Only pure parsing logic and command
// metadata live here — no state/setter reading. Handlers that drive
// openIssue/back/search and the like live in App(): commands hand back a parsed
// name + arguments, and App() dispatches against the command registry.
//
// `minArgs`/`maxArgs` (maxArgs = -1 — unlimited) validate the argument count.
// `usage` is the help text for the `help` command and for error hints.
//
// The host is tracker-agnostic: this is the generic command set only. Tracker-
// specific commands (open/search/bookmark/boards/browser/expand/full) are not
// part of the host command registry; they move to the tracker plugin.

import { hostConfigSchema } from './schema.js';

export type Command = {
  name: string;
  aliases?: string[];
  usage: string;
  minArgs: number;
  maxArgs: number;
  description: string;
};

// Basic host command set. `maxArgs = -1` means an unlimited argument count.
export const BASE_COMMANDS: Command[] = [
  { name: 'view', aliases: [], usage: 'view <mode>', minArgs: 1, maxArgs: 1, description: 'Switch the view' },
  { name: 'clear', aliases: ['clear-cache'], usage: 'clear', minArgs: 0, maxArgs: 0, description: 'Flush the cache' },
  { name: 'back', aliases: [], usage: 'back', minArgs: 0, maxArgs: 0, description: 'Back' },
  { name: 'quit', aliases: ['q'], usage: 'quit', minArgs: 0, maxArgs: 0, description: 'Quit' },
  { name: 'config', aliases: [], usage: 'config [get <key>|set <key> <value>|unset <key>|help]', minArgs: 0, maxArgs: -1, description: 'Show the whole config; get/set/unset a key (writes config.local.json); help — what the keys are' },
  { name: 'cache', aliases: [], usage: 'cache [on|off]', minArgs: 0, maxArgs: 1, description: 'Turn the cache on or off (config.cache.enabled)' },
  { name: 'help', aliases: ['?'], usage: 'help', minArgs: 0, maxArgs: 0, description: 'List the commands' },
];

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

// Subcommands of `config get|set|unset|help` (the old `config <key>` syntax is
// gone).
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

type CompleteResult = {
  head: string;
  hasSpace: boolean;
  best: string;
  candidates: string[];
};

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
// schema for plugin namespaces, both optional). The first command word is
// still the ordinary completion.
export function completeCommand(text: string, commands: Command[] = BASE_COMMANDS, config?: unknown, configSchema: any = hostConfigSchema): CompleteResult {
  const raw = String(text ?? '');
  const m = raw.match(/^(\S*)(?:\s([\s\S]*))?$/);
  const head = m![1];
  const hasSpace = m![2] !== undefined;
  if (head.toLowerCase() === 'config' && hasSpace) {
    return completeConfigCommand(m![2] ?? '', config, configSchema);
  }
  if (hasSpace) return { head, hasSpace, best: '', candidates: [] };
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
      // fall back to the name so `padEnd` never runs on undefined and crashes
      // the help modal (a real latent defect). For a namespaced plugin command
      // (`core:help`) the prefix is stripped so the list reads `help`/`ask` —
      // matching what the user actually types, since findIn's bare-name fallback
      // resolves those too (a `:core:help` entry would be uninvokable-looking).
      const usage = c.usage ?? (c.name.includes(':') ? c.name.slice(c.name.indexOf(':') + 1) : c.name);
      const label = alias ? `${usage} (${alias})` : usage;
      return `${label.padEnd(24)} ${c.description}`;
    })
    .join('\n');
}