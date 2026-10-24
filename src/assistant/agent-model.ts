// The model starts an agent file by name through its `subagent` tool: the arguments it
// gave are checked against the file's parameters and every refusal is worded for the
// model to read (never a question to the person). Also the block of the system prompt
// that lists the agents it may start. Pure but for the trust record the check reads.
import { agentTrusted, trustedNow } from './agent-trust.js';
import { fillPrompt, paramsText } from './agent-file.js';
import { resolveAgent, type FoundAgent, type FoundAgents } from './agent-find.js';
import { agentAutoMode, agentRef, agentToolGroups } from './agent-start.js';
import type { AutoMode } from './auto.js';
import type { AgentRef } from './conversation-types.js';
import { uniqueLabel } from './subagent-command.js';

// What the host gives a `subagent` call so it can start an agent: the agent files as of
// now, the cap on their auto mode, the tool groups loaded, the labels of the live children.
export interface AgentStarter {
  found: () => FoundAgents;
  cap: () => AutoMode;
  loaded: () => ReadonlySet<string>;
  labels: () => string[];
}

export const AGENT_FOLLOW_UP = 'Additional instructions from the conversation that started you:';
export const AGENTS_LISTED_MAX = 20;

export type AgentStartPlan =
  | { ok: false; message: string }
  | { ok: true; id: string; label: string; prompt: string; mode: AutoMode; agent: AgentRef; toolGroups: string[] | null; absent: string[] };

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function planAgentStart(starter: AgentStarter, call: { agent: string; args: unknown; prompt: string }): AgentStartPlan {
  const hit = resolveAgent(call.agent, starter.found());
  if (!hit.ok) return { ok: false, message: `subagent: ${hit.message}` };
  const agent = hit.agent;
  const id = agent.id;
  if (!agentTrusted(agent)) return { ok: false, message: `subagent: @${id} is not trusted here — ask the person to start @${id} once` };
  if (call.args !== undefined && !isMap(call.args)) return { ok: false, message: `subagent: args must be an object of parameter values for @${id}` };
  const given = (call.args ?? {}) as Record<string, unknown>;
  const declared = agent.params.map((p) => p.name);
  const unknown = Object.keys(given).filter((k) => !declared.includes(k));
  if (unknown.length) {
    return { ok: false, message: `subagent: @${id} has no parameter ${unknown.map((k) => `«${k}»`).join(', ')}${declared.length ? ` — it takes ${paramsText(agent.params)}` : ' — it takes none'}` };
  }
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [k, v] of Object.entries(given)) values[k] = typeof v === 'string' ? v : v === null || v === undefined ? '' : JSON.stringify(v);
  const missing = agent.params.filter((p) => !p.optional && !(Object.hasOwn(values, p.name) ? values[p.name]! : '').trim()).map((p) => p.name);
  if (missing.length) return { ok: false, message: `subagent: @${id} needs ${missing.join(', ')}` };
  const extra = call.prompt.trim();
  const body = fillPrompt(agent, values);
  const groups = agentToolGroups(agent, starter.loaded());
  return {
    ok: true,
    id,
    label: uniqueLabel(id, starter.labels()),
    prompt: extra ? `${body}\n\n${AGENT_FOLLOW_UP}\n${extra}` : body,
    mode: agentAutoMode(agent.auto, starter.cap()),
    agent: agentRef(agent, id),
    toolGroups: groups.groups,
    absent: groups.absent,
  };
}

export const AGENT_DESCRIPTION_MAX = 200;

// One line, at most 200 characters, an ellipsis where it was cut.
export const clip = (text: string): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > AGENT_DESCRIPTION_MAX ? `${one.slice(0, AGENT_DESCRIPTION_MAX - 1).trimEnd()}…` : one;
};

const lineOf = (a: FoundAgent): string => {
  const params = a.params.length ? ` (${paramsText(a.params)})` : '';
  return `@${a.id} — ${clip(a.description)}${params}`;
};

// The system prompt's list of the agents the model may start: the trusted ones only, at
// most twenty. '' when there is none.
export function agentsBlock(found: Pick<FoundAgents, 'agents'>, trusted: (a: FoundAgent) => boolean = trustedNow()): string {
  const lines = found.agents.filter(trusted).slice(0, AGENTS_LISTED_MAX).map(lineOf);
  return lines.length ? ['Agents you can start by name with the subagent tool (agent, args):', ...lines].join('\n') : '';
}
