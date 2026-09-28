// Tool-group registry. The host is plugin-delivered, not fs-scanned: the
// registry is assembled from (a) the built-in `core` group (alwaysOn), (b) the
// built-in `host` group (reads `repo`), and (c) each enabled plugin's
// `shape.tools` groups + `shape.aiTools`. There is NO filesystem scan and no
// `scripts/tools/` import.
//
// Naming: a tool is offered under the name its plugin gave it — group tools and
// aiTools alike — and gets a `<plugin>:` prefix from the loader only when that name
// is already claimed (see `register`). Host tools are `host:`-prefixed by the host
// group itself; core tools are bare. config.ai.disabledTools is a BLACKLIST — any group
// whose id is listed is withheld (core, alwaysOn, is never withheld).
//
// The registry exposes `tools` as the LLM-facing array with `write`/`run`
// tree-shaken out; internally a name→group map (keeping write/run on the owner
// group) lets `exec(name, args, ctx)` dispatch to the group that owns the tool.

import type { Plugin } from './plugin.js';
import { coreTools, workspaceTools } from './tools-core.js';
import type { CoreCtx } from './tools-core.js';
import { hostGroupTools } from './host-group.js';
import { webTools } from './tools-web.js';
import { shellTools } from './tools-shell.js';
import type { PluginRepo } from './host-group.js';
import { buildKeys } from './registry.js';
import { purgePluginMemories } from '../runtime/services/memory.js';
import { identityToken } from '../runtime/plugin-identity.js';
import { qualifyKind } from '../assistant/views.js';
import { toolImageResult, type ToolImageResult } from '../assistant/tool-images.js';

// ─── Types ────────────────────────────────────────────────────────────────────
export type ToolParameters = Record<string, unknown>;

export interface ToolFunction {
  name: string;
  description: string;
  parameters: ToolParameters;
}

export interface ToolDef {
  type: 'function';
  function: ToolFunction;
  // Whether this tool mutates state (chat pauses with a y/n before it runs).
  // A boolean or a predicate over the parsed args.
  write?: boolean | ((args: Record<string, unknown>) => boolean);
  // Present only on `aiTools`: the execution handler.
  run?: (...args: unknown[]) => unknown;
  // Overrides the conversation's `ai.toolResultMaxChars` for THIS tool's result —
  // for one a plugin knows returns a lot and is worth the tokens (docs/plugins.md).
  // Clamped to `TOOL_RESULT_MAX_CHARS_CEILING` (src/assistant/tool-result-cap.ts).
  // Never sent to the provider: stripped from a wire tool def like `write`/`run`.
  maxResultChars?: number;
  // The tool may return images beside its text — `{ text, images }`, the
  // `ToolImageResult` of src/assistant/tool-images.ts. Images from a tool that does
  // not say so are dropped with a note in the result (docs/plugins.md). Never sent to
  // the provider: stripped like `write`/`run`/`maxResultChars`.
  returnsImages?: boolean;
  // The host's own, not part of the plugin contract: the argument that names an earlier
  // tool call whose result the tool takes as its input — `run_command`'s `stdinFrom`.
  // The host resolves it before the y/n (an id it cannot resolve is an error, and
  // nothing runs), names the source in the y/n, and hands the tool the call's data as
  // `ctx.resultInput` (src/assistant/tool-results.ts). Never sent to the provider:
  // stripped like `write`/`run`.
  resultInput?: string;
}

export type AiToolDef = ToolDef & { run: (...args: unknown[]) => unknown };

export type ToolCtx = CoreCtx & Record<string, unknown>;

// What a tool answers with: a string for the model, or text with images beside it
// (src/assistant/tool-images.ts — only from a tool whose def says `returnsImages`).
export type ToolResult = string | ToolImageResult;

// A self-contained tool group factory object — `args` is already parsed, `ctx`
// is the runtime context (`CoreCtx`: the conversation's project, configLocalPath, …).
export interface ToolGroup {
  id: string;
  alwaysOn?: boolean;
  tools: ToolDef[];
  exec(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult>;
  // What the group is, beyond its tools' own descriptions — an MCP server's
  // `instructions`, say: how its data is shaped, its vocabulary, what to check before
  // trusting it. Read where the model reads the group's tools (tools on demand: the
  // index line under the group's heading, and the full text once the group is loaded
  // or sent in full — src/assistant/tool-loading.ts), sanitized the same way a tool
  // description is. Absent for a group that is just its tools.
  description?: string;
}

export interface ToolRegistry {
  groups: ToolGroup[];
  tools: ToolDef[];
  exec(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult>;
  // Reads every plugin's groups again into this object — after a plugin joined the list
  // it was assembled from, or changed its `tools`. Absent on a registry made by hand.
  refresh?(): void;
}

export interface AssembledToolRegistryInput {
  plugins: Plugin[];
  config: Record<string, unknown>;
  repo: PluginRepo;
}

// ─── Assembly ─────────────────────────────────────────────────────────────────
// Collects the plugins' own configSchemas (name → schema) for the config tool.
// Only plugins that declare one are included (today that is keycaps).
export function pluginConfigs(plugins: Plugin[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of plugins) if (p.configSchema != null) out[p.name] = p.configSchema;
  return out;
}

// A plugin's tool names its view kinds as its plugin named its renderers — bare — and
// they are qualified here, on the way out of the plugin, so `card` from `notes` is
// `notes:card` and never another plugin's `card`. The old one-argument
// `reportView({ kind: 'console', … })` passes through as it is.
export function scopeViews(ctx: ToolCtx, owner: string): ToolCtx {
  const c = ctx as Record<string, unknown>;
  const out: Record<string, unknown> = { ...c };
  if (typeof c.liveView === 'function') {
    const live = c.liveView as (k: string, d: unknown) => unknown;
    out.liveView = (kind: string, data: unknown) => live(qualifyKind(owner, String(kind)), data);
  }
  if (typeof c.reportView === 'function') {
    const report = c.reportView as (k: unknown, d?: unknown) => unknown;
    out.reportView = (kind: unknown, data?: unknown) => (typeof kind === 'string' ? report(qualifyKind(owner, kind), data) : report(kind));
  }
  return out as ToolCtx;
}

// Module-level singleton registry so the agent loop can dispatch tools without
// threading a registry through every call (source-faithful `chatTools` /
// `execChatTool`). Set by every `assembleToolRegistry` call and brought up to date in
// place by `refreshToolRegistry`.
let currentRegistry: ToolRegistry | null = null;
let refreshCurrent: (() => void) | null = null;
// Counts the refreshes of the current registry: a turn reads it before each round and
// works out its tool list again only when it moved, so a round with nothing new sends
// the list it sent before, byte for byte.
let revision = 0;

type Assembled = { groups: ToolGroup[]; tools: ToolDef[]; nameToGroup: Map<string, ToolGroup>; ownName: Map<string, string> };

// Which plugin group holds each bare tool name: a name handed out keeps its holder for as
// long as the holder still declares it.
const holdersOf = (a: Assembled): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [name, group] of a.nameToGroup) if (!a.ownName.has(name)) out.set(name, group.id);
  return out;
};

export function assembleToolRegistry(input: AssembledToolRegistryInput): ToolRegistry {
  // A name clash is said once per registry, not again at every refresh.
  const said = new Set<string>();
  const warn = (line: string) => {
    if (said.has(line)) return;
    said.add(line);
    console.warn(line);
  };
  let state = assemble(input, warn, new Map());
  // The tools a refresh took away, each with the group that last held it: a turn fixes
  // the list it sends when it starts, so it may still call one — the group answers for
  // itself (an MCP server's says it is not connected and when it is tried next), and the
  // model never reads a bare "Unknown tool" for a tool it was offered.
  const left = new Map<string, { group: ToolGroup; own: string }>();
  const registry: ToolRegistry = {
    groups: state.groups,
    tools: state.tools,
    exec: async (name, args, ctx) => {
      const group = state.nameToGroup.get(name);
      if (group) return group.exec(state.ownName.get(name) ?? name, args ?? {}, ctx);
      const gone = left.get(name);
      if (gone) return gone.group.exec(gone.own, args ?? {}, ctx);
      throw new Error(`Unknown tool: ${name}`);
    },
  };
  // A refresh swaps what this object holds, never the object: the app, its services and
  // the context meter keep the one they were handed.
  const refresh = () => {
    const before = state;
    state = assemble(input, warn, holdersOf(before));
    for (const [name, group] of before.nameToGroup) {
      if (!state.nameToGroup.has(name)) left.set(name, { group, own: before.ownName.get(name) ?? name });
    }
    for (const name of state.nameToGroup.keys()) left.delete(name);
    registry.groups = state.groups;
    registry.tools = state.tools;
    if (currentRegistry === registry) revision++;
  };
  // `refresh` touches this registry alone: an App that has gone (a test's) never
  // reassembles the one assembled after it.
  registry.refresh = refresh;
  refreshCurrent = refresh;
  currentRegistry = registry;
  revision++;
  return registry;
}

// Reads every plugin's `tools` again into the registry already handed out — for a
// plugin whose groups change while the app runs (an MCP server that connects after the
// start, or is turned off): the plugin sets `tools` on its plugin object and calls this,
// handed to its builder as `toolsChanged`. `ai.disabledTools` is read again with it.
// A turn reads the list again before each of its rounds (`agentChat`), so a group that
// arrives mid-turn is sent from the next round on; a call runs against the registry as
// it is, and a call to a tool that left since reaches the group that last held it. A
// no-op before any registry is assembled.
export function refreshToolRegistry(): void {
  refreshCurrent?.();
}

// How many times the current registry has been assembled or refreshed — `agentChat`
// compares it between rounds.
export function toolRegistryRevision(): number {
  return revision;
}

// `held` — the bare names the last assembly handed out, each with the group that holds it.
function assemble({ plugins, config, repo }: AssembledToolRegistryInput, warn: (line: string) => void, held: Map<string, string>): Assembled {
  const disabled = (config?.ai as { disabledTools?: string[] } | undefined)?.disabledTools ?? [];
  // The resolved hotkey map (host defaults + plugin keys + config.keys overrides).
  // Handed to the config tool so `config get/explain keys` reports the EFFECTIVE
  // bindings, not just the (usually empty) `config.keys` override — otherwise the
  // LLM wrongly concludes "no hotkeys configured" and hallucinates.
  // `pluginConfigs` is the plugin name → configSchema map (a plugin's own
  // config.plugins.<name>.* schema), handed to the config tool so it can resolve
  // `config get/explain set plugins.<name>.<flag>` for flags a plugin declares
  // (e.g. config.plugins.keycaps.enabled) — the host schema sees plugins as an
  // opaque record, so without this the tool rejects them as "unknown key".
  const core = coreTools(config, buildKeys(plugins, config), pluginConfigs(plugins));

  // Clearing a plugin's memory on uninstall: purge the host memory file's entries
  // scoped to that plugin (the host knows the name). Wired so `host:plugins_remove`
  // calls it after a successful remove — only removal leaves orphaned facts (install
  // and update never create them).
  const purgePluginMemory = (plugin: string) => {
    purgePluginMemories(config, plugin);
  };

  // Host group's `tools_list` reports the full inventory; the list is wired via a
  // mutable ref populated after every group is collected (avoids a build cycle).
  // `plugins.map(p => p.name)` lets `plugins_list` report the always-loaded built-ins
  // (which the registry list omits), so the LLM doesn't conclude "no plugins".
  const toolNamesRef: { names: string[] } = { names: [] };
  const host = hostGroupTools(repo, () => toolNamesRef.names, plugins.map(p => p.name), purgePluginMemory);

  // web_fetch is a group of its own so it can be turned off (core cannot be).
  const web = disabled.includes('web') ? null : webTools(config);
  // run_command likewise — and every call of it waits for the person's y/n.
  const shell = disabled.includes('shell') ? null : shellTools(config);
  // The model's own files beyond reading one: loaded when it needs them.
  const workspace = disabled.includes('workspace') ? null : workspaceTools(config);
  const groups: ToolGroup[] = [core, host, ...(web ? [web] : []), ...(shell ? [shell] : []), ...(workspace ? [workspace] : [])];
  const nameToGroup = new Map<string, ToolGroup>();
  // ─── How a tool gets its name ───────────────────────────────────────────────
  // The model sees the name the plugin gave: `get_issue`, `open_issue`, `read_file`.
  // No plugin prefix — it is shorter, costs fewer tokens on every request, and the
  // model has no use for which plugin stands behind a tool.
  //
  // A prefix appears only when it is NEEDED: a name already claimed by another group
  // is registered as `<owner>:<name>` instead, and said so. The first claimant keeps
  // the bare word — first in the list, unless a refresh finds the name already handed
  // out (`held`, `claim`): then its holder keeps it, so a plugin that joins later, or a
  // server that connects, never renames a tool the model was already given. `ownName`
  // remembers what the group itself calls the tool, since that is the name its `exec`
  // understands.
  const ownName = new Map<string, string>();
  const claim = new Map<string, ToolGroup>();
  const register = (group: ToolGroup, owner: string = group.id) => {
    group.tools = group.tools.flatMap((t) => {
      const name = t.function.name;
      const claimed = claim.get(name);
      const holder = nameToGroup.get(name) ?? (claimed && claimed !== group ? claimed : undefined);
      if (!holder || holder === group) {
        nameToGroup.set(name, group);
        return [t];
      }
      const qualified = `${owner}:${name}`;
      if (nameToGroup.has(qualified)) {
        warn(`[tools] "${name}" is declared by both ${holder.id} and ${group.id}, and "${qualified}" is taken too — ${group.id}'s is not offered.`);
        return [];
      }
      warn(`[tools] "${name}" is declared by both ${holder.id} and ${group.id} — ${holder.id} keeps the name, ${group.id}'s is offered as "${qualified}".`);
      nameToGroup.set(qualified, group);
      ownName.set(qualified, name);
      return [{ ...t, function: { ...t.function, name: qualified } }];
    });
  };
  register(core);
  register(host);
  if (web) register(web);
  if (shell) register(shell);
  if (workspace) register(workspace);

  const pending: Array<[ToolGroup, string]> = [];
  for (const p of plugins) {
    // Plugin-supplied tool groups — used as-is (the plugin author namespaces the
    // tool names with `<plugin.name>:`). Withhold a group whose id is in the
    // blacklist unless it is alwaysOn. Each group's exec is wrapped to tag ctx with
    // the plugin's HOST-ISSUED identity token, so core tools (memory: scope
    // "plugin") resolve to it — and a caller cannot spoof a different plugin (only
    // the host holds the token→name map).
    for (const group of (p.tools ?? []) as unknown as ToolGroup[]) {
      if (disabled.includes(group.id) && !group.alwaysOn) continue;
      const wrapped = { ...group, exec: (name: string, args: Record<string, unknown>, ctx: ToolCtx) => group.exec(name, args, scopeViews({ ...ctx, pluginToken: identityToken(p.name) }, p.name)) };
      groups.push(wrapped);
      pending.push([wrapped, p.name]);
    }
    // Plugin aiTools — standalone `run`-bearing tools. Wrapped in a synthetic
    // group so they appear in the flattened registry and dispatch. Named as the
    // plugin named them, like group tools; `register` qualifies one only on a clash.
    const aiTools = (p.aiTools ?? []) as unknown as AiToolDef[];
    if (aiTools.length) {
      // Self-bind the owning plugin's OWN services into each ai-tool's `run`, so a
      // navigation ai-tool resolves its ctx service even when the caller's toolCtx
      // doesn't carry that plugin's services — the assistant's toolCtx is the
      // ASSISTANT's host bundle, which lacks another plugin's services, and one-shot
      // passes `{}`.
      // Agent dispatch calls `def.run(parsed, toolCtx)` directly (bypassing this
      // group's exec), so the bind must live on the run closure, not just the exec.
      // The caller's ctx still wins on shared keys (`...ctx` overrides), so a real
      // host openBrowser beats a plugin no-op stub.
      const prefixed = aiTools.map((t) => {
        const run = (t as AiToolDef).run;
        return {
          ...t,
          function: {
            ...t.function,
            // As the plugin wrote it. A plugin that qualified a name itself meant to;
            // the loader neither adds a prefix nor takes one away.
            name: t.function.name,
          },
          run: (args: Record<string, unknown>, ctx: ToolCtx) =>
            run(args, scopeViews({ ...p.services, ...ctx, pluginToken: identityToken(p.name) } as ToolCtx, p.name)),
        };
      });
      const aiGroup: ToolGroup = {
        id: `${p.name}:aiTools`,
        alwaysOn: true,
        tools: prefixed as ToolDef[],
        exec: async (name, args, ctx) => {
          const def = prefixed.find((t) => t.function.name === name);
          // `def.run` is already self-bound (wraps `p.services` + caller ctx), so
          // pass ctx through untouched — fusing plugin services again would be a
          // no-op (same keys, same values) and confuse the caller's overrides.
          if (def && typeof def.run === 'function') {
            // A result with images keeps its shape; anything else is the string it reads as.
            const r = await def.run(args, ctx);
            return toolImageResult(r) ?? String(r);
          }
          throw new Error(`Unknown tool: ${name}`);
        },
      };
      groups.push(aiGroup);
      pending.push([aiGroup, p.name]);
    }
  }

  // A bare name the last assembly handed out stays with its holder while the holder
  // still declares it; the host's own groups hold theirs regardless.
  for (const [name, id] of held) {
    if (nameToGroup.has(name)) continue;
    const holder = pending.find(([g]) => g.id === id && g.tools.some((t) => t.function.name === name));
    if (holder) claim.set(name, holder[0]);
  }
  for (const [group, owner] of pending) register(group, owner);

  toolNamesRef.names = groups.flatMap((g) => g.tools.map((t) => t.function.name));

  // LLM-facing tools: `write`/`run` tree-shaken out; the owner group (with them
  // retained) is resolved at exec time via the name→group map.
  const tools: ToolDef[] = [];
  for (const g of groups) for (const t of g.tools) tools.push(stripTool(t));

  return { groups, tools, nameToGroup, ownName };
}

// The LLM-facing (tree-shaken, disabledTools-filtered) tools of the last
// assembled registry — the agent loop asks for these to advertise tool defs.
export function chatTools(): ToolDef[] {
  return currentRegistry?.tools ?? [];
}

// The UNSTRIPPED tool defs of the last assembled registry — `write`/`run`
// retained. The group `tools` keep the service fields (unlike the flattened
// `registry.tools` which `stripTool` tree-shakes them away). The agent builds
// its `toolByName` confirmation map from these so a `write`-flagged tool is
// present and `needsConfirm` can fire, while the LLM still sees only the
// stripped `{type,function}` from `chatTools()`.
export function chatToolDefs(): ToolDef[] {
  return currentRegistry?.groups.flatMap((g) => g.tools) ?? [];
}

// Which group each tool of the last assembled registry belongs to (name → group id),
// under the name the model sees. Tools on demand send the `core` group in full and
// index the rest by group (src/assistant/tool-loading.ts).
export function chatToolGroupOf(): Map<string, string> {
  return new Map(currentRegistry?.groups.flatMap((g) => g.tools.map((t) => [t.function.name, g.id] as [string, string])) ?? []);
}

// A group's own description, by its id — raw, as the group set it: tools on demand
// sanitizes and shapes it (src/assistant/tool-loading.ts). A group with none is absent,
// not an empty string.
export function chatGroupDescriptions(): Map<string, string> {
  return new Map(currentRegistry?.groups.flatMap((g) => (g.description ? [[g.id, g.description] as [string, string]] : [])) ?? []);
}

// Dispatches a tool call to the current registry (source-faithful, module-level).
export async function execChatTool(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  if (!currentRegistry) throw new Error('No tool registry assembled');
  return currentRegistry.exec(name, args, ctx);
}

function stripTool(t: ToolDef): ToolDef {
  return { type: 'function', function: t.function };
}

export type { PluginRepo as RepoShape };