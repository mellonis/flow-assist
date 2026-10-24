// The plugins whose agent files may be offered: loaded from a directory, not built in,
// not disabled in this run, and not waiting for the person's trust.
import type { PluginAgentSource } from './agent-find.js';

export function agentPluginsOf(
  plugins: readonly { name: string; dir?: string }[],
  skip: { builtins: readonly string[]; disabled: ReadonlySet<string>; untrusted: readonly { name: string }[] },
): PluginAgentSource[] {
  return plugins
    .filter((p) => p.dir && !skip.builtins.includes(p.name) && !skip.disabled.has(p.name) && !skip.untrusted.some((u) => u.name === p.name))
    .map((p) => ({ name: p.name, dir: p.dir! }));
}
