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
// A window as configured: a whole positive number, or no value at all. A fraction, a
// string or a boolean is none — the schema takes `z.number().int().positive()`, and a
// hand-edited file that breaks it must never become a zero window.
const positive = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;

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

// A name `/model` offers. `name` is what the person types (`default`, a role, or a
// catalogue id); `model` the id it runs — null for the reset, which puts the session back
// on `ai.model`; `label` what the chat and the panel read; `window` what the conversation
// would measure against.
export type ModelRow = { name: string; model: string | null; label: string; window?: number };

// The word that takes a session back to `ai.model`. Reserved: no role or id shadows it.
const RESET = 'default';

// The keys of a record in `config.ai`, or none: a hand-edited file may say anything.
const keysOf = (v: unknown): string[] => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []);

// Every name `/model` offers, in the order the panel draws it: the reset, then the roles
// (`ai.roles`, in the order its keys come), then the ids of `ai.models` no role names. A
// role and an id of the same name are one row — the role's — so a name means one thing.
// Pure: `ai` in, rows out.
export function modelRows(ai: unknown): ModelRow[] {
  const cfg = asAi(ai);
  const base = baseModel(ai);
  const rows: ModelRow[] = [{ name: RESET, model: null, label: base ? `${RESET} (${base})` : RESET, window: modelWindow(ai, base) }];
  const named = new Set([RESET]);
  const mapped = new Set<string>();
  for (const role of keysOf(cfg.roles)) {
    const key = name(role);
    const model = key ? roleModel(ai, key) : undefined;
    if (!key || !model || named.has(key)) continue;
    named.add(key);
    mapped.add(model);
    rows.push({ name: key, model, label: `${key} → ${model}`, window: modelWindow(ai, model) });
  }
  for (const id of keysOf(cfg.models)) {
    const key = name(id);
    if (!key || named.has(key) || mapped.has(key)) continue;
    named.add(key);
    rows.push({ name: key, model: key, label: key, window: modelWindow(ai, key) });
  }
  return rows;
}

// What a typed name chooses: the reset, the id a role runs, or an id of the catalogue —
// an id a role maps to is still an id the person may name. Anything else is the line that
// sends them to the list.
export function modelChoice(ai: unknown, asked: unknown): { model: string | null } | { error: string } {
  const key = typeof asked === 'string' ? asked.trim() : '';
  if (key === RESET) return { model: null };
  const role = roleModel(ai, key);
  if (role) return { model: role };
  const catalogue = new Set(keysOf(asAi(ai).models).map(name).filter((id): id is string => !!id));
  if (catalogue.has(key)) return { model: key };
  const shown = typeof asked === 'string' ? key : String(asked ?? '');
  return { error: `no model or role "${shown}" here (/model lists them)` };
}
