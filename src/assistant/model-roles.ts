// What a model is and what it can hold (`config.ai`): the window of each model id, the
// roles a person defines, and the one place a role becomes a model id. A conversation
// runs ONE model id; an agent file and the `subagent` tool ask for a ROLE, so a file that
// travels between machines names `fast` and the machine says what that runs on
// (AGENTS.md (models)). Pure: `config.ai` in, values out.
import { DEFAULT_CONTEXT_WINDOW } from './context-meter.js';

interface AiConfig {
  model?: unknown;
  contextWindow?: unknown;
  models?: Record<string, { contextWindow?: unknown } | undefined>;
  roles?: Record<string, unknown>;
}

const asAi = (ai: unknown): AiConfig => (ai && typeof ai === 'object' ? (ai as AiConfig) : {});
const name = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const positive = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};

// `ai.model` as written — a model id, never a role.
export function baseModel(ai: unknown): string | undefined {
  return name(asAi(ai).model);
}

// The model id a role runs on this machine, or undefined when `ai.roles` does not define
// it (the start then degrades: the conversation's model, and one note).
export function roleModel(ai: unknown, role: unknown): string | undefined {
  const key = name(role);
  return key ? name(asAi(ai).roles?.[key]) : undefined;
}

// The window of a model id: its own entry in `ai.models`, else `ai.contextWindow` for a
// model the catalogue does not name, else 200k. A conversation measures against the
// window of the model it runs — `ctx N%`, the automatic compaction, the recall threshold.
export function modelWindow(ai: unknown, model: string | undefined): number {
  const cfg = asAi(ai);
  const id = name(model);
  return positive(id ? cfg.models?.[id]?.contextWindow : undefined) ?? positive(cfg.contextWindow) ?? DEFAULT_CONTEXT_WINDOW;
}

// What a start that asked for a role gets: the model id, or the line the chat and the
// tool say when the role is not defined here. The work goes on either way.
export function roleStart(ai: unknown, role: unknown): { model?: string; note?: string } {
  const key = name(role);
  if (!key) return {};
  const model = roleModel(ai, key);
  return model ? { model } : { note: `role "${key}" is not defined (ai.roles) — using the conversation's model` };
}
