// The arguments of `/subagent @<name> …`: `name=value` pairs first, then positional
// values in the declared order, the last parameter taking the rest of the line whole
// (docs/usage.md (agent files)). Pure text in, values out; the chat asks for what is missing.
import type { AgentParam } from './agent-file.js';

export type AgentArgs =
  | { ok: true; values: Record<string, string>; missing: string[] }
  | { ok: false; message: string };

// `name=value`, the value one word or `"…"` (no quote inside), then the space after it.
const PAIR = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|(\S*))(?:\s+|$)/;
const QUOTED = /^"([^"]*)"(?:\s+|$)/;
const WORD = /^(\S+)(?:\s+|$)/;

// `text` is the line after the agent's name, trimmed. `missing` lists the required
// parameters nothing gave a value to, in the declared order; an optional one left over is
// the empty string. A pair naming no parameter, a name given twice, or a value with no
// parameter left to take it is a refusal.
export function parseAgentArgs(params: readonly AgentParam[], text: string): AgentArgs {
  const values: Record<string, string> = {};
  const known = new Set(params.map((p) => p.name));
  let rest = text.trim();
  for (let m = PAIR.exec(rest); m; m = PAIR.exec(rest)) {
    const name = m[1]!;
    if (!known.has(name)) return { ok: false, message: `no parameter «${name}»${params.length ? ` — it takes ${params.map((p) => p.name).join(', ')}` : ' — it takes none'}` };
    if (name in values) return { ok: false, message: `«${name}» is given twice` };
    values[name] = m[2] ?? m[3] ?? '';
    rest = rest.slice(m[0].length);
  }
  const last = params[params.length - 1]?.name;
  for (const p of params) {
    if (p.name in values || !rest) continue;
    if (p.name === last) { values[p.name] = rest; rest = ''; break; }
    const m = QUOTED.exec(rest) ?? WORD.exec(rest)!;
    values[p.name] = m[1]!;
    rest = rest.slice(m[0].length);
  }
  if (rest) return { ok: false, message: `too many values — it takes ${params.length ? params.map((p) => p.name).join(', ') : 'none'}` };
  const missing = params.filter((p) => !(p.name in values) && !p.optional).map((p) => p.name);
  for (const p of params) if (!(p.name in values) && p.optional) values[p.name] = '';
  return { ok: true, values, missing };
}
