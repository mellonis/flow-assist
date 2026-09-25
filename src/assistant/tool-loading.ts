// Tools on demand: what one request tells the model about the tools it has.
//
// Carrying the full schema of every enabled tool on every request — the core ones,
// `repo`'s seventeen, `gitlab`, an MCP server's, a tracker plugin's couple of dozen —
// costs prompt tokens paid on every round, and a longer list to choose from, while a
// turn uses two or three. With `ai.toolLoading: 'onDemand'` (the default) a
// request carries:
//   - the `core` group in full — the chat itself relies on it (`todo`, `ask_user`,
//     `memory`, …);
//   - the tools this conversation has LOADED, in full;
//   - `tools_load`, whose description is the index of everything else: each tool's
//     name and one line of what it does, grouped by where it comes from.
// The model loads by name or by group; the loaded tools join the list from the next
// round on — within the same turn — and stay for the rest of the conversation. A call
// to a tool that is known but not loaded is answered with an error that names
// `tools_load`, never with silence. `ai.toolLoading: 'all'` goes back to the full list
// for a model that handles this badly.
//
// The loaded set belongs to a CONVERSATION, like the plan: the chat holds one, saves it
// with the session and empties it on /clear; a background run and the one-shot CLI get
// a fresh one. Everything here is pure; `agentChat` does the wiring.
import type { ToolDef } from '../loader/tools.js';
import { unframe } from './screen-context.js';
import { sanitizeViewText } from './views.js';

export type ToolLoading = 'all' | 'onDemand';

export const TOOLS_LOAD = 'tools_load';
// The group that is always sent in full.
export const ALWAYS_LOADED_GROUP = 'core';

// The mode config asks for; anything but an explicit 'all' is on demand.
export function toolLoadingMode(ai: unknown): ToolLoading {
  return (ai as { toolLoading?: unknown } | null | undefined)?.toolLoading === 'all' ? 'all' : 'onDemand';
}

export interface ToolSet {
  has(name: string): boolean;
  // In the order they were loaded — what a session saves.
  names(): string[];
  // Returns the names that were not loaded before.
  add(names: string[]): string[];
  // Puts back a set saved with a session; anything that is not a list of names is ignored.
  load(saved: unknown): void;
  reset(): void;
}

export function createToolSet(): ToolSet {
  let loaded: string[] = [];
  return {
    has: (name) => loaded.includes(name),
    names: () => loaded.slice(),
    add(names) {
      const fresh = [...new Set(names)].filter((n) => !loaded.includes(n));
      loaded = [...loaded, ...fresh];
      return fresh;
    },
    load(saved) {
      loaded = Array.isArray(saved) ? [...new Set(saved.filter((n): n is string => typeof n === 'string'))] : [];
    },
    reset() { loaded = []; },
  };
}

// One tool as the index knows it: `group` is the registry group's id (a plugin's
// standalone tools sit in `<plugin>:aiTools`), `def` is what goes on the wire.
export interface CatalogEntry { name: string; group: string; def: ToolDef }

// What the model is shown as the group's name: the plugin, not the registry's
// bookkeeping suffix.
export const groupLabel = (id: string) => id.replace(/:aiTools$/, '');

// One line of what a tool does: its description up to the end of the first sentence,
// capped. A description's first sentence is where every tool here says what it is.
export function toolSummary(description: string, max = 110): string {
  const flat = String(description ?? '').replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  const first = end >= 0 ? flat.slice(0, end + 1) : flat;
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

// A group's description as the model may read it: control characters and escape
// sequences gone (`sanitizeViewText`), and the app's own frame words taken out
// (`unframe`) — a server's own text (an MCP server's `instructions`, say) is trusted
// like a tool description, but not trusted to reproduce the app's own framing.
export function sanitizeGroupDescription(raw: string): string {
  return unframe(sanitizeViewText(raw)).trim();
}

// The tools that are NOT always sent, by name.
export function deferredTools(catalog: CatalogEntry[]): Map<string, CatalogEntry> {
  return new Map(catalog.filter((e) => e.group !== ALWAYS_LOADED_GROUP && e.name !== TOOLS_LOAD).map((e) => [e.name, e]));
}

// The index: one line per group, `name — what it does` per tool, with the group's own
// description (an MCP server's `instructions`, say — `groupDescriptions`, keyed by the
// RAW group id as `CatalogEntry.group` carries it) as one line under its heading, cut
// the same way a tool's first sentence is. Stable for a given set of tools — it does
// not change as tools are loaded, so the request's prefix stays the same from turn to
// turn.
export function toolIndex(deferred: Map<string, CatalogEntry>, groupDescriptions: Map<string, string> = new Map()): string {
  const byGroup = new Map<string, CatalogEntry[]>();
  for (const e of deferred.values()) {
    const g = groupLabel(e.group);
    byGroup.set(g, [...(byGroup.get(g) ?? []), e]);
  }
  return [...byGroup].map(([g, es]) => {
    const raw = groupDescriptions.get(es[0]!.group);
    const heading = raw ? `${toolSummary(sanitizeGroupDescription(raw), 200)}\n` : '';
    return `${g}:\n${heading}${es.map((e) => `- ${e.name} — ${toolSummary(e.def.function.description)}`).join('\n')}`;
  }).join('\n');
}

export function toolsLoadDef(deferred: Map<string, CatalogEntry>, groupDescriptions: Map<string, string> = new Map()): ToolDef {
  return {
    type: 'function',
    function: {
      name: TOOLS_LOAD,
      description:
        'Load tools before calling them. Only the tools you already see in full can be called; the ones below are listed by name and what they do. ' +
        'Pass `names` (tool names) or `group` (a group name — loads all of its tools). A loaded tool joins your tool list for the next step and stays for the rest of the conversation. ' +
        'Load what the task needs, not everything.\n\n' +
        toolIndex(deferred, groupDescriptions),
      parameters: {
        type: 'object',
        properties: {
          names: { type: 'array', items: { type: 'string' }, description: 'Tool names from the list.' },
          group: { type: 'string', description: 'A group name from the list; loads every tool in it.' },
        },
      },
    },
  };
}

// A described group's full text, once — on the first tool of that group in `entries`,
// in the order they are about to be sent; never on the rest, so it is not repeated per
// tool. Builds new defs only where a description actually lands; everything else is
// the same `ToolDef` reference the catalog already holds.
function withGroupDescriptions(entries: CatalogEntry[], groupDescriptions: Map<string, string>): ToolDef[] {
  if (!groupDescriptions.size) return entries.map((e) => e.def);
  const seen = new Set<string>();
  return entries.map((e) => {
    const raw = groupDescriptions.get(e.group);
    if (!raw || seen.has(e.group)) return e.def;
    seen.add(e.group);
    return { ...e.def, function: { ...e.def.function, description: `${sanitizeGroupDescription(raw)}\n\n${e.def.function.description}` } };
  });
}

// What one request carries. The order keeps what was sent before as the head of what
// is sent now — core, then `tools_load` with the index, then the loaded tools in the
// order they were loaded — so a load only APPENDS: a provider's prompt cache, which
// holds up to the first byte that changed, keeps everything sent before it.
// `groupDescriptions` (a group's own text, keyed by its raw id) rides on the group's
// first tool once that tool is actually SENT in full — in `'all'`, that is its first
// tool in the catalog; on demand, its first LOADED tool, so the text arrives exactly
// when the group's tools do, in the index before that and nowhere once every tool of
// the group has been seen.
export function toolsToSend(catalog: CatalogEntry[], mode: ToolLoading, set: ToolSet, groupDescriptions: Map<string, string> = new Map()): ToolDef[] {
  const deferred = deferredTools(catalog);
  if (mode === 'all' || !deferred.size) return withGroupDescriptions(catalog, groupDescriptions);
  return [
    ...withGroupDescriptions(catalog.filter((e) => !deferred.has(e.name)), groupDescriptions),
    toolsLoadDef(deferred, groupDescriptions),
    ...withGroupDescriptions(set.names().flatMap((n) => { const e = deferred.get(n); return e ? [e] : []; }), groupDescriptions),
  ];
}

// The index shows a tool grouped under its group's name (`repo:\n- read_file — …`),
// which reads naturally as `<group>:<name>` — a model that passes it that way
// qualified, exactly as a clash-qualified tool's own name looks, would otherwise get
// `ERROR: Not in the list` for a whole round. Stripped only as a FALLBACK: a name
// that is already in `deferred` (bare, or genuinely qualified by a clash — see
// `register` in ../loader/tools.js) is tried first and never rewritten; this only
// fires when that lookup misses AND the prefix names the group the bare tool
// actually belongs to.
function unqualify(n: string, deferred: Map<string, CatalogEntry>): string {
  const i = n.indexOf(':');
  if (i < 0) return n;
  const rest = n.slice(i + 1);
  const entry = deferred.get(rest);
  return entry && groupLabel(entry.group) === n.slice(0, i) ? rest : n;
}

// A `tools_load` call. Returns what the model reads; throws when nothing it asked for
// exists, so the result is an ERROR the model cannot mistake for a success.
export function runToolsLoad(args: Record<string, unknown>, catalog: CatalogEntry[], set: ToolSet): string {
  const deferred = deferredTools(catalog);
  const askedRaw = Array.isArray(args.names) ? args.names.map(String) : typeof args.names === 'string' ? [args.names] : [];
  const asked = askedRaw.map((n) => (deferred.has(n) ? n : unqualify(n, deferred)));
  const group = typeof args.group === 'string' ? args.group.trim() : '';
  const groups = [...new Set([...deferred.values()].map((e) => groupLabel(e.group)))];
  if (!asked.length && !group) throw new Error(`Pass \`names\` or \`group\`. Groups: ${groups.join(', ')}.`);
  const wanted: string[] = [];
  const always: string[] = []; // sent in full on every request anyway
  const unknown: string[] = [];
  const inGroup = (label: string) => [...deferred.values()].filter((e) => groupLabel(e.group) === label).map((e) => e.name);
  if (group) {
    const tools = inGroup(group);
    if (tools.length) wanted.push(...tools);
    else if (group === ALWAYS_LOADED_GROUP) always.push(`group "${group}"`);
    else unknown.push(`group "${group}"`);
  }
  for (const n of asked) {
    if (deferred.has(n)) wanted.push(n);
    else if (n === TOOLS_LOAD || catalog.some((e) => e.name === n)) always.push(n);
    // A group's name in `names` is read as that group. The index shows the groups
    // right beside the tools, so a model reasonably passes one there; refusing it
    // with an error that lists it as a group cost a round for nothing. A tool of the
    // same name wins, which the two branches above already decide.
    else if (inGroup(n).length) wanted.push(...inGroup(n));
    else if (n === ALWAYS_LOADED_GROUP) always.push(`group "${n}"`);
    else unknown.push(n);
  }
  if (!wanted.length && !always.length) throw new Error(`Not in the list: ${unknown.join(', ')}. Groups: ${groups.join(', ')}.`);
  const fresh = set.add(wanted);
  const already = [...new Set([...wanted.filter((n) => !fresh.includes(n)), ...always])];
  return [
    fresh.length ? `Loaded: ${fresh.join(', ')} — call them now.` : '',
    already.length ? `Already loaded: ${already.join(', ')}.` : '',
    unknown.length ? `Not in the list: ${unknown.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
}

// The answer to a call of a tool the index lists but this conversation has not loaded.
export const notLoadedError = (name: string) =>
  `${name} is not loaded — call ${TOOLS_LOAD} with names ["${name}"] first, then call it.`;
