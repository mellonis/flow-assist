// What starting an agent file decides besides its prompt: the auto mode (the file's, never
// above the person's `agents.maxAuto`), the tool groups it may use, and the record of it
// the journal keeps. Pure; the chat starts the child.
import { AUTO_CYCLE, type AutoMode } from './auto.js';
import type { Agent } from './agent-file.js';
import type { AgentRef } from './conversation-types.js';

export const DEFAULT_MAX_AUTO: AutoMode = 'reads';

// The person's cap on what an agent file may run without asking: `agents.maxAuto`, `reads`
// when unset or not a mode.
export function maxAutoOf(config: unknown): AutoMode {
  const v = (config as { agents?: { maxAuto?: unknown } } | undefined)?.agents?.maxAuto;
  return AUTO_CYCLE.includes(v as AutoMode) ? (v as AutoMode) : DEFAULT_MAX_AUTO;
}

// The lower of the file's mode and the cap, on the rungs `ask < reads < all`.
export function agentAutoMode(fileAuto: AutoMode, cap: AutoMode): AutoMode {
  return AUTO_CYCLE[Math.min(AUTO_CYCLE.indexOf(fileAuto), AUTO_CYCLE.indexOf(cap))]!;
}

// The tool groups the child may use besides the core group: null when the file names none
// (no restriction), else the named ones. `absent` lists a named group the registry does not
// hold now; the agent starts without it.
export function agentToolGroups(agent: Pick<Agent, 'tools'>, loaded: ReadonlySet<string>): { groups: string[] | null; absent: string[] } {
  if (!agent.tools) return { groups: null, absent: [] };
  return { groups: [...agent.tools], absent: agent.tools.filter((g) => g !== 'core' && !loaded.has(g)) };
}

// The note a start says for groups it goes on without.
export const absentGroupsNote = (id: string, absent: readonly string[]): string =>
  absent.map((g) => `@${id}: group "${g}" is not loaded — starting without it`).join('\n');

// The record of the file a child was started from, as the journal's start lines carry it.
export function agentRef(agent: Pick<Agent, 'path' | 'source' | 'hash'>, id: string): AgentRef {
  return { id, source: agent.source.kind, path: agent.path, hash: agent.hash };
}

// Why a start that must ask cannot: the session's own question holds the slot the blocks
// of the missing parameters would take, and two do not stack. null when it may go on.
export const askBlockedBy = (pending: unknown, missing: readonly string[]): string | null =>
  missing.length && pending ? 'answer the open question first' : null;
