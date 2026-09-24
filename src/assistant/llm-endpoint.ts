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
  // The Messages API requires a ceiling on the answer; the OpenAI path does not send one.
  maxTokens: number;
  thinking?: ThinkingConfig;
}

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export const DEFAULT_MAX_TOKENS = 8192;

// Read as written by a person: `Anthropic` and ` anthropic ` are anthropic.
export function providerOf(ai: unknown): Provider {
  const p = (ai as { provider?: unknown } | null | undefined)?.provider;
  return typeof p === 'string' && p.trim().toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
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
    const ceiling = Math.max(o.maxTokens, 2048);
    notes.push(`ai.thinking.budgetTokens ${budget} does not fit under ai.maxTokens ${o.maxTokens} with room for the answer — sent as ${ceiling - 1024}${ceiling > o.maxTokens ? ` with max_tokens ${ceiling}` : ''}; raise ai.maxTokens to keep the budget`);
  }
  return notes;
}

export function llmOpts(ai: unknown, env: Record<string, string | undefined> = process.env): LlmOpts {
  const a = (ai && typeof ai === 'object' ? ai : {}) as Record<string, unknown>;
  const provider = providerOf(a);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  const tokenEnv = str(a.tokenEnv) ?? (provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'LLM_TOKEN');
  const baseUrl = str(a.baseUrl) ?? (provider === 'anthropic' ? ANTHROPIC_BASE_URL : undefined);
  const maxTokens = typeof a.maxTokens === 'number' && Number.isInteger(a.maxTokens) && a.maxTokens > 0 ? a.maxTokens : DEFAULT_MAX_TOKENS;
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
  };
}
