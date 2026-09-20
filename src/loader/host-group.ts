// Built-in "host" tool group: plugin management (list/install/remove/update) and
// the current tool inventory. These read the host's plugin repository (the
// `createPluginRepo` shape: list/install/remove/update/enabledPlugins)
// rather than scanning the filesystem. Always on (built-in, not gated by
// config.ai.disabledTools). plugin_list and tools_list are read-only; the three
// mutating tools are write-flagged so the chat pauses with a y/n confirmation.

import type { ToolGroup } from './tools.js';

// The plugin-repository shape (`createPluginRepo`'s). Methods are optional
// here because the repo may be partially constructed in tests/the runtime; the
// exec dispatches handle a missing method gracefully.
export interface PluginRepo {
  list?: (...args: unknown[]) => Promise<unknown>;
  install?: (...args: unknown[]) => Promise<unknown>;
  remove?: (...args: unknown[]) => Promise<unknown>;
  update?: (...args: unknown[]) => Promise<unknown>;
  enabledPlugins?: (...args: unknown[]) => Promise<unknown>;
}

// Extracts the `name` field from a parsed tool-call args object. The `host:plugins_*`
// tools declare `name` as a required string, but `args` arrives as a decoded object
// while the repository methods take a bare string — unwrap at this boundary so a
// malformed call degrades to an empty-string name (which the repo guards catch)
// instead of path.join stringifying the object into `'[object Object]'`.
function argName(args: unknown): string {
  const n = (args as { name?: unknown } | null)?.name;
  return typeof n === 'string' ? n : '';
}

// Appends a "restart needed" note to a successful plugin-state mutation result so
// the assistant tells the user the change won't take effect until the host is
// restarted (loadPlugins runs once at startup and does not re-import plugins).
const RESTART_HINT = ' — restart the assistant for the change to take effect';
function withRestartHint(result: unknown): string {
  const r = result as { ok?: boolean } | null;
  return JSON.stringify(result) + (r?.ok ? RESTART_HINT : '');
}

export const hostGroupTools = (
  repo: PluginRepo,
  getToolNames: () => string[] = () => [],
  loadedPluginNames: string[] = [],
  purgePluginMemory?: (plugin: string) => void,
): ToolGroup => ({
  id: 'host',
  alwaysOn: true,
  tools: [
    {
      type: 'function',
      function: {
        name: 'host:plugins_list',
        description: 'List the plugins the assistant runs: the always-loaded built-ins (core, assistant, keycaps, log) plus any installed/registry plugins, with name, version and enabled state. Read-only.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'host:plugins_install',
        description: 'WRITE: install a plugin into the assistant (added to the enabled set and pulled from the package registry). Write-flagged: the chat pauses with a y/n confirmation.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Plugin name/namespace to install.' },
            version: { type: 'string', description: 'Optional version (default: latest).' },
          },
          required: ['name'],
        },
      },
      write: true,
    },
    {
      type: 'function',
      function: {
        name: 'host:plugins_remove',
        description: 'WRITE: remove a plugin from the assistant (dropped from the enabled set). Write-flagged: the chat pauses with a y/n confirmation.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Plugin name/namespace to remove.' },
          },
          required: ['name'],
        },
      },
      write: true,
    },
    {
      type: 'function',
      function: {
        name: 'host:plugins_update',
        description: 'WRITE: update an installed plugin to a newer version from the package registry. Write-flagged: the chat pauses with a y/n confirmation.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Plugin name/namespace to update.' },
          },
          required: ['name'],
        },
      },
      write: true,
    },
    {
      type: 'function',
      function: {
        name: 'host:tools_list',
        description: 'List the tool names currently available to the model across all active groups (core, host, plugins). Read-only — useful to discover tool names and their namespaces.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ],
  exec: async (name, args) => {
    switch (name) {
      case 'host:plugins_list': {
        if (typeof repo.list !== 'function') return 'host:plugins_list — plugin repository not configured.';
        const registry = (await repo.list()) as { name?: string }[];
        // The registry list omits built-ins (they live in src/plugins/, not
        // plugins-available/), so the assistant would wrongly conclude "no plugins".
        // Merge the always-loaded built-ins (loaded names not present in the registry)
        // marked `builtin: true`, so `host:plugins_list` reports the real set.
        const regNames = new Set(registry.map(e => e.name));
        const builtins = loadedPluginNames
          .filter(n => !regNames.has(n))
          .map(n => ({ name: n, version: '', description: 'built-in plugin (always loaded)', active: true, builtin: true }));
        return JSON.stringify([...builtins, ...registry]);
      }
      case 'host:plugins_install':
        if (typeof repo.install !== 'function') return 'host:plugins_install — plugin repository not configured.';
        return withRestartHint(await repo.install(argName(args)));
      case 'host:plugins_remove': {
        if (typeof repo.remove !== 'function') return 'host:plugins_remove — plugin repository not configured.';
        const res = (await repo.remove(argName(args))) as { ok?: boolean; error?: string };
        // A successful uninstall purges the plugin's memory (its `plugin`-scope facts),
        // so they don't linger after the plugin is gone.
        if (res.ok && purgePluginMemory) purgePluginMemory(argName(args));
        return withRestartHint(res);
      }
      case 'host:plugins_update':
        if (typeof repo.update !== 'function') return 'host:plugins_update — plugin repository not configured.';
        return withRestartHint(await repo.update(argName(args) || undefined));
      case 'host:tools_list':
        return JSON.stringify(getToolNames());
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  },
});

export default hostGroupTools;