// Tool-group registry. The host is plugin-delivered, not fs-scanned: the
// registry is assembled from (a) the built-in `core` group (alwaysOn), (b) the
// built-in `host` group (reads `repo`), and (c) each enabled plugin's
// `shape.tools` groups + `shape.aiTools`. There is NO filesystem scan and no
// `scripts/tools/` import.
//
// Namespacing: plugin tool names are prefixed `<plugin.name>:` by the
// plugin author (shape.tools is used as-is) and host tools are prefixed `host:`;
// core tools are unprefixed. config.ai.disabledTools is a BLACKLIST — any group
// whose id is listed is withheld (core, alwaysOn, is never withheld).
//
// The registry exposes `tools` as the LLM-facing array with `write`/`run`
// tree-shaken out; internally a name→group map (keeping write/run on the owner
// group) lets `exec(name, args, ctx)` dispatch to the group that owns the tool.

import type { Plugin } from './plugin.js';
import { coreTools } from './tools-core.js';
import type { CoreCtx } from './tools-core.js';
import { hostGroupTools } from './host-group.js';
import type { PluginRepo } from './host-group.js';
import { buildKeys } from './registry.js';
import { purgePluginMemories } from '../runtime/services/memory.js';
import { identityToken } from '../runtime/plugin-identity.js';

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
}

export type AiToolDef = ToolDef & { run: (...args: unknown[]) => unknown };

export type ToolCtx = CoreCtx & Record<string, unknown>;

// A self-contained tool group factory object — `args` is already parsed, `ctx`
// is the runtime context ({ memoryFile, configLocalPath }).
export interface ToolGroup {
  id: string;
  alwaysOn?: boolean;
  tools: ToolDef[];
  exec(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<string>;
}

export interface ToolRegistry {
  groups: ToolGroup[];
  tools: ToolDef[];
  exec(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<string>;
}

export interface AssembledToolRegistryInput {
  plugins: Plugin[];
  config: Record<string, unknown>;
  repo: PluginRepo;
}

// ─── Assembly ─────────────────────────────────────────────────────────────────
// Collects the plugins' own configSchemas (name → schema) for the config tool.
// Only plugins that declare one are included (today that is keycaps).
function pluginConfigs(plugins: Plugin[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of plugins) if (p.configSchema != null) out[p.name] = p.configSchema;
  return out;
}

// Module-level singleton registry so the agent loop can dispatch tools without
// threading a registry through every call (source-faithful `chatTools` /
// `execChatTool`). Refreshed on every `assembleToolRegistry` call.
let currentRegistry: ToolRegistry | null = null;

export function assembleToolRegistry({ plugins, config, repo }: AssembledToolRegistryInput): ToolRegistry {
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

  const groups: ToolGroup[] = [core, host];
  const nameToGroup = new Map<string, ToolGroup>();
  // A tool name is claimed ONCE. Group tools keep the bare names their plugin gives
  // them (`get_issue`, `read_file`), so two plugins can pick the same word. The later
  // one used to take the name silently — the model called `search` and got the other
  // plugin's — and the provider's "Duplicate tool name" 400, which at least was loud,
  // is gone now that agentChat sends one declaration per name. The first claimant
  // keeps the name; the loser is dropped from its group and named in a warning.
  const register = (group: ToolGroup) => {
    group.tools = group.tools.filter((t) => {
      const name = t.function.name;
      const owner = nameToGroup.get(name);
      if (owner && owner !== group) {
        console.warn(`[tools] "${name}" is declared by both ${owner.id} and ${group.id} — ${owner.id} keeps it; ${group.id}'s is not offered. Qualify the name (${group.id}:${name}).`);
        return false;
      }
      nameToGroup.set(name, group);
      return true;
    });
  };
  register(core);
  register(host);

  for (const p of plugins) {
    // Plugin-supplied tool groups — used as-is (the plugin author namespaces the
    // tool names with `<plugin.name>:`). Withhold a group whose id is in the
    // blacklist unless it is alwaysOn. Each group's exec is wrapped to tag ctx with
    // the plugin's HOST-ISSUED identity token, so core tools (memory: scope
    // "plugin") resolve to it — and a caller cannot spoof a different plugin (only
    // the host holds the token→name map).
    for (const group of (p.tools ?? []) as unknown as ToolGroup[]) {
      if (disabled.includes(group.id) && !group.alwaysOn) continue;
      const wrapped = { ...group, exec: (name: string, args: Record<string, unknown>, ctx: ToolCtx) => group.exec(name, args, { ...ctx, pluginToken: identityToken(p.name) }) };
      groups.push(wrapped);
      register(wrapped);
    }
    // Plugin aiTools — standalone `run`-bearing tools. Wrapped in a synthetic
    // group so they appear in the flattened registry and dispatch; names are
    // prefixed `<plugin.name>:` for consistency (doubling-proof).
    const aiTools = (p.aiTools ?? []) as unknown as AiToolDef[];
    if (aiTools.length) {
      // Self-bind the owning plugin's OWN services into each ai-tool's `run`, so a
      // nav ai-tool (open_issue/open_board/open_browser) resolves its ctx service
      // even when the caller's toolCtx doesn't carry the tracker's services — the
      // assistant's toolCtx (`{ ...f.services }` in assistant.ts) is the ASSISTANT's
      // host bundle, which lacks openIssue/openBoard, and one-shot passes `{}`.
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
            name: t.function.name.startsWith(`${p.name}:`) ? t.function.name : `${p.name}:${t.function.name}`,
          },
          run: (args: Record<string, unknown>, ctx: ToolCtx) =>
            run(args, { ...p.services, ...ctx, pluginToken: identityToken(p.name) }),
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
            return String(await def.run(args, ctx));
          }
          throw new Error(`Unknown tool: ${name}`);
        },
      };
      groups.push(aiGroup);
      register(aiGroup);
    }
  }

  toolNamesRef.names = groups.flatMap((g) => g.tools.map((t) => t.function.name));

  // LLM-facing tools: `write`/`run` tree-shaken out; the owner group (with them
  // retained) is resolved at exec time via the name→group map.
  const tools: ToolDef[] = [];
  for (const g of groups) for (const t of g.tools) tools.push(stripTool(t));

  const registry: ToolRegistry = {
    groups,
    tools,
    exec: async (name, args, ctx) => {
      const group = nameToGroup.get(name);
      if (!group) throw new Error(`Unknown tool: ${name}`);
      return group.exec(name, args ?? {}, ctx);
    },
  };
  currentRegistry = registry;
  return registry;
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

// Dispatches a tool call to the current registry (source-faithful, module-level).
export async function execChatTool(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  if (!currentRegistry) throw new Error('No tool registry assembled');
  return currentRegistry.exec(name, args, ctx);
}

function stripTool(t: ToolDef): ToolDef {
  return { type: 'function', function: t.function };
}

export type { PluginRepo as RepoShape };