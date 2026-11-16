// Where the model is and how it is reached, read from `config.ai` in ONE place. Every
// caller that talks to the model — the chat, /compact, a background task, the one-shot
// prompt — spreads `llmOpts(ai)` into its call, and the start-up gate checks the same
// resolution (`config/load.ts`), so a default (the base URL, the token variable) can
// never hold in one of them and not in another. Pure: the environment is passed in.
//
// `provider` picks the wire: unset or anything but 'anthropic' is an OpenAI-compatible
// chat-completions API (`{baseUrl}/chat/completions`, a bearer token), 'anthropic' is
// Anthropic's own Messages API (./anthropic.ts). What the host keeps — the history, the
// sessions — has one shape for both; only the request and the stream differ.

import { RETRIES_DEFAULT, RETRY_DELAY_DEFAULT } from './llm-retry.js';
import { baseModel, modelWindow } from './model-roles.js';

export type Provider = 'openai' | 'anthropic';

// How the model is asked to think, on the Anthropic wire. `adaptive` lets the model
// decide how much (the current models' only thinking mode — a fixed budget is refused
// there with a 400); `budgetTokens` is the fixed budget older models take. Absent: the
// request says nothing and the model's own default holds.
export interface ThinkingConfig { adaptive?: boolean; budgetTokens?: number }

export interface LlmOpts {
  provider: Provider;
  baseUrl?: string;
  model?: string;
  token?: string;
  // The variable the token is read from — named in the error when it is not set.
  tokenEnv: string;
  // The ceiling on one answer, sent as `max_tokens` on both wires (`answerCeiling`).
  maxTokens: number;
  thinking?: ThinkingConfig;
  // How many times a request that failed for a reason that passes is repeated, and the
  // seconds before each repeat (./llm-retry.ts).
  retries: number;
  retryDelay: number;
}

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

// How long one answer may run: never over this, never under the floor the API's own
// thinking needs, and never past the room the window has left.
export const ANSWER_CEILING_MAX = 32_000;
export const ANSWER_CEILING_MIN = 1_024;

// The ceiling a provider that refuses the resolved one by name is asked for next: the
// smallest output cap a current model is assumed to take. One retry only — a refusal of
// this value stands, and both wires remember it for the process (`./wire-fields.ts`).
export const CEILING_FALLBACK = 8_192;

// Read as written by a person: `Anthropic` and ` anthropic ` are anthropic.
export function providerOf(ai: unknown): Provider {
  const p = (ai as { provider?: unknown } | null | undefined)?.provider;
  return typeof p === 'string' && p.trim().toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
}

// The ceiling one answer may take, in tokens — what both wires send as `max_tokens`. The
// person's `ai.maxTokens` is over everything; else the model's own entry in `ai.models`;
// else the room its window leaves after what this conversation last sent, kept between
// the floor and the cap. A model with no `inputTokens` said yet (a first request) gets
// the whole window's room. Pure: `config.ai` in, a number out.
export function answerCeiling(ai: unknown, opts: { model?: string; inputTokens?: number } = {}): number {
  const a = (ai && typeof ai === 'object' ? ai : {}) as Record<string, unknown>;
  const positive = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
  const ceiling = positive(a.maxTokens);
  if (ceiling) return ceiling;
  const model = opts.model?.trim() || baseModel(a);
  const models = (a.models && typeof a.models === 'object' ? a.models : {}) as Record<string, { maxTokens?: unknown } | undefined>;
  const own = positive(model ? models[model]?.maxTokens : undefined);
  if (own) return own;
  const room = Math.floor(modelWindow(a, model) * 0.99) - Math.max(0, opts.inputTokens ?? 0) - ANSWER_CEILING_MIN;
  return Math.min(ANSWER_CEILING_MAX, Math.max(ANSWER_CEILING_MIN, room));
}

// What the log says once at start about `config.ai` — never a refusal to start: the
// schema has always taken any string as `ai.provider`, so an older config may hold a
// value this host does not know, and it still works as the OpenAI-compatible API it
// always meant. `thinkingParams` (./anthropic.ts) is the rule the budget note describes.
export function llmConfigNotes(ai: unknown): string[] {
  const notes: string[] = [];
  const a = (ai && typeof ai === 'object' ? ai : {}) as Record<string, unknown>;
  const p = typeof a.provider === 'string' ? a.provider.trim().toLowerCase() : '';
  if (p && p !== 'anthropic' && p !== 'openai') {
    notes.push(`ai.provider "${String(a.provider)}" is not one this host knows — read as an OpenAI-compatible API; the other one is "anthropic"`);
  }
  const o = llmOpts(ai, {});
  const budget = o.thinking?.budgetTokens;
  if (o.provider === 'anthropic' && budget && budget > o.maxTokens - 1024) {
    const ceiling = Math.max(o.maxTokens, ANSWER_CEILING_MIN * 2);
    notes.push(`ai.thinking.budgetTokens ${budget} does not fit under the answer ceiling of ${o.maxTokens} with room for the answer — sent as ${ceiling - ANSWER_CEILING_MIN}${ceiling > o.maxTokens ? ` with max_tokens ${ceiling}` : ''}; raise ai.maxTokens to keep the budget`);
  }
  return notes;
}

export function llmOpts(ai: unknown, env: Record<string, string | undefined> = process.env): LlmOpts {
  const a = (ai && typeof ai === 'object' ? ai : {}) as Record<string, unknown>;
  const provider = providerOf(a);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  const tokenEnv = str(a.tokenEnv) ?? (provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'LLM_TOKEN');
  const baseUrl = str(a.baseUrl) ?? (provider === 'anthropic' ? ANTHROPIC_BASE_URL : undefined);
  const maxTokens = answerCeiling(a);
  const t = a.thinking as { adaptive?: unknown; budgetTokens?: unknown } | undefined;
  const thinking: ThinkingConfig | undefined = t && typeof t === 'object'
    ? t.adaptive === true
      ? { adaptive: true }
      : typeof t.budgetTokens === 'number' && t.budgetTokens > 0 ? { budgetTokens: Math.floor(t.budgetTokens) } : undefined
    : undefined;
  return {
    provider,
    ...(baseUrl ? { baseUrl } : {}),
    ...(str(a.model) ? { model: a.model as string } : {}),
    ...(env[tokenEnv] ? { token: env[tokenEnv] } : {}),
    tokenEnv,
    maxTokens,
    ...(thinking ? { thinking } : {}),
    retries: typeof a.retries === 'number' && Number.isInteger(a.retries) && a.retries >= 0 ? a.retries : RETRIES_DEFAULT,
    retryDelay: typeof a.retryDelay === 'number' && Number.isFinite(a.retryDelay) && a.retryDelay >= 0 ? a.retryDelay : RETRY_DELAY_DEFAULT,
  };
}

// The same options on another model: a conversation that runs a model of its own (a
// child's role) overrides what `ai.model` says, and everything else stays.
export function withModel(opts: LlmOpts, model: string | undefined): LlmOpts {
  const id = model?.trim();
  return id ? { ...opts, model: id } : opts;
}
