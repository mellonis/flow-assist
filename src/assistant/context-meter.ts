// How full the model's context is — for the chat's status line and `/context`.
//
// Two sources, and the difference is SAID:
//   - measured: `prompt_tokens` of the last response, when the provider reports usage.
//     That is the size of everything that was actually sent: system prompt, tool
//     definitions, the whole history.
//   - estimated: characters / 4, drawn with a `~`. Crude (code and Cyrillic are denser
//     than English prose) but it moves the right way, and the breakdown by part is
//     always an estimate — a provider reports one number, not where it came from.
// The window is `ai.contextWindow`; nobody can ask a model for it over this API.
//
// Pure: numbers in, numbers and text out.

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const CONTEXT_WARN_AT = 0.8;

const CHARS_PER_TOKEN = 4;
export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

export interface ContextParts {
  system: string; // instructions and identity
  memory: string; // the persistent-memory block
  plan: string; // the task plan block
  summary: string; // what /compact left
  tools: unknown[]; // tool definitions sent with every request
  messages: unknown[]; // the model's history
}

export interface ContextReading {
  used: number;
  window: number;
  ratio: number; // 0…1, clamped
  measured: boolean;
  parts: Array<{ label: string; tokens: number }>;
}

export function readContext(parts: ContextParts, window: number, measuredPromptTokens?: number): ContextReading {
  const est = [
    { label: 'instructions', tokens: estimateTokens(parts.system) },
    { label: 'tools', tokens: estimateTokens(JSON.stringify(parts.tools ?? [])) },
    { label: 'memory', tokens: estimateTokens(parts.memory) },
    { label: 'plan', tokens: estimateTokens(parts.plan) },
    { label: 'summary', tokens: estimateTokens(parts.summary) },
    { label: 'messages', tokens: estimateTokens(JSON.stringify(parts.messages ?? [])) },
  ];
  const estimated = est.reduce((n, p) => n + p.tokens, 0);
  const measured = typeof measuredPromptTokens === 'number' && measuredPromptTokens > 0;
  const used = measured ? measuredPromptTokens! : estimated;
  // With a measured total the parts are scaled to it, so the breakdown adds up to the
  // number on the status line instead of contradicting it.
  const scale = measured && estimated > 0 ? used / estimated : 1;
  const size = Math.max(1, window || DEFAULT_CONTEXT_WINDOW);
  return {
    used,
    window: size,
    ratio: Math.min(1, used / size),
    measured,
    parts: est.filter((p) => p.tokens > 0).map((p) => ({ label: p.label, tokens: Math.round(p.tokens * scale) })),
  };
}

const short = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

// The status line's word: `ctx 12%`, `ctx ~12%` when estimated.
export function contextBadge(r: ContextReading): string {
  return `ctx ${r.measured ? '' : '~'}${percent(r.ratio)}`;
}

const BAR = 30;
export function contextNote(r: ContextReading): string {
  const filled = Math.round(r.ratio * BAR);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(BAR - filled)}`;
  const widest = Math.max(...r.parts.map((p) => p.label.length), 'free'.length);
  const row = (label: string, tokens: number) => `  ${label.padEnd(widest)}  ${short(tokens).padStart(6)}  ${percent(tokens / r.window).padStart(4)}`;
  const free = Math.max(0, r.window - r.used);
  return [
    `Context  ${bar}  ${percent(r.ratio)} — ${short(r.used)} of ${short(r.window)} tokens${r.measured ? '' : ' (estimated)'}`,
    ...r.parts.map((p) => row(p.label, p.tokens)),
    row('free', free),
    r.measured
      ? 'The total is what the provider reported for the last request; the split between parts is an estimate.'
      : 'Estimated from the text (about 4 characters a token): the provider has not reported usage yet.',
    r.ratio >= CONTEXT_WARN_AT
      ? '/compact replaces the conversation with a summary; /clear starts over (memory is kept — /memory).'
      : '/compact shrinks the conversation to a summary · /clear starts over · the window is `ai.contextWindow`.',
  ].join('\n');
}
