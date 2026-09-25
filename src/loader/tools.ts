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
import { coreTools } from './tools-core.js';
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
}

export type AiToolDef = ToolDef & { run: (...args: unknown[]) => unknown };

export type ToolCtx = CoreCtx & Record<string, unknown>;

// What a tool answers with: a string for the model, or text with images beside it
// (src/assistant/tool-images.ts — only from a tool whose def says `returnsImages`).
export type ToolResult = string | ToolImageResult;

// A self-contained tool group factory object — `args` is already parsed, `ctx`
// is the runtime context ({ memoryFile, configLocalPath }).
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

  // web_fetch is a group of its own so it can be turned off (core cannot be).
  const web = disabled.includes('web') ? null : webTools(config);
  // run_command likewise — and every call of it waits for the person's y/n.
  const shell = disabled.includes('shell') ? null : shellTools(config);
  const groups: ToolGroup[] = [core, host, ...(web ? [web] : []), ...(shell ? [shell] : [])];
  const nameToGroup = new Map<string, ToolGroup>();
  // ─── How a tool gets its name ───────────────────────────────────────────────
  // The model sees the name the plugin gave: `get_issue`, `open_issue`, `read_file`.
  // No plugin prefix — it is shorter, costs fewer tokens on every request, and the
  // model has no use for which plugin stands behind a tool.
  //
  // A prefix appears only when it is NEEDED: a name already claimed by another group
  // is registered as `<owner>:<name>` instead, and said so. The first claimant keeps
  // the bare word. `ownName` remembers what the group itself calls the tool, since
  // that is the name its `exec` understands.
  const ownName = new Map<string, string>();
  const register = (group: ToolGroup, owner: string = group.id) => {
    group.tools = group.tools.flatMap((t) => {
      const name = t.function.name;
      const holder = nameToGroup.get(name);
      if (!holder || holder === group) {
        nameToGroup.set(name, group);
        return [t];
      }
      const qualified = `${owner}:${name}`;
      if (nameToGroup.has(qualified)) {
        console.warn(`[tools] "${name}" is declared by both ${holder.id} and ${group.id}, and "${qualified}" is taken too — ${group.id}'s is not offered.`);
        return [];
      }
      console.warn(`[tools] "${name}" is declared by both ${holder.id} and ${group.id} — ${holder.id} keeps the name, ${group.id}'s is offered as "${qualified}".`);
      nameToGroup.set(qualified, group);
      ownName.set(qualified, name);
      return [{ ...t, function: { ...t.function, name: qualified } }];
    });
  };
  register(core);
  register(host);
  if (web) register(web);
  if (shell) register(shell);

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
      register(wrapped, p.name);
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
      register(aiGroup, p.name);
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
      return group.exec(ownName.get(name) ?? name, args ?? {}, ctx);
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