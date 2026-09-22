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
// An image is counted by its pixels, as providers bill it (`imageTokens`), never by
// the text of its saved form — and never by base64, which the history does not hold.
//
// Pure: numbers in, numbers and text out.
import { imageTokens } from './images.js';

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

// The images the history carries, and the history without them.
function splitImages(messages: unknown[]): { text: unknown[]; tokens: number } {
  let tokens = 0;
  const text = (messages ?? []).map((m) => {
    const refs = (m as { images?: unknown } | null)?.images;
    if (!Array.isArray(refs) || !refs.length) return m;
    for (const r of refs) tokens += imageTokens(r as { width?: number; height?: number });
    const { images: _images, ...rest } = m as Record<string, unknown>;
    return rest;
  });
  return { text, tokens };
}

export function readContext(parts: ContextParts, window: number, measuredPromptTokens?: number): ContextReading {
  const history = splitImages(parts.messages);
  const est = [
    { label: 'instructions', tokens: estimateTokens(parts.system) },
    { label: 'tools', tokens: estimateTokens(JSON.stringify(parts.tools ?? [])) },
    { label: 'memory', tokens: estimateTokens(parts.memory) },
    { label: 'plan', tokens: estimateTokens(parts.plan) },
    { label: 'summary', tokens: estimateTokens(parts.summary) },
    { label: 'messages', tokens: estimateTokens(JSON.stringify(history.text)) },
    { label: 'images', tokens: history.tokens },
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

// What a TURN cost, in the same short form: every round's prompt plus its completion,
// added up as the provider reported them. It sits beside `ctx N%` and means something
// else — that one is how big the next request is, this one is what has been spent —
// so both say what they are: `3.1k tok`, `ctx 12%`.
export const tokensBadge = (tokens: number): string => `${short(Math.max(0, Math.round(tokens)))} tok`;

// The panel's picture: the window as a field of cells, each part filling its share.
// A part that is there at all gets a cell, however small — tools at 0.4% are still
// sent with every request, and a field that hides them lies about what is in it.
// The last cell of a part is drawn half-full when the part does not fill it.
export const GRID_COLS = 20;
export const GRID_ROWS = 5;
export const CELL_FULL = '⛁';
export const CELL_PART = '⛀';
export const CELL_FREE = '⛶';

export interface GridCell { label: string | null; glyph: string } // label null — free

export function contextGrid(r: ContextReading, cells = GRID_COLS * GRID_ROWS): GridCell[] {
  const per = r.window / cells;
  const out: GridCell[] = [];
  for (const part of r.parts) {
    if (part.tokens <= 0) continue;
    const exact = part.tokens / per;
    const whole = Math.floor(exact);
    const n = Math.max(1, Math.ceil(exact - 0.05)); // a hair over a cell is not a new cell
    for (let i = 0; i < n && out.length < cells; i++) {
      out.push({ label: part.label, glyph: i < whole ? CELL_FULL : CELL_PART });
    }
  }
  while (out.length < cells) out.push({ label: null, glyph: CELL_FREE });
  return out;
}

// The panel's heading and legend, as data: the view owns colours and layout.
export function contextHeading(r: ContextReading): string {
  return `${percent(r.ratio)} — ${short(r.used)} of ${short(r.window)} tokens${r.measured ? '' : ' (estimated)'}`;
}
export function contextLegend(r: ContextReading): Array<{ label: string | null; text: string }> {
  const widest = Math.max(...r.parts.map((p) => p.label.length), 'free'.length);
  const row = (label: string, tokens: number) => `${label.padEnd(widest)}  ${short(tokens).padStart(6)}  ${percent(tokens / r.window).padStart(4)}`;
  return [
    ...r.parts.map((p) => ({ label: p.label as string | null, text: row(p.label, p.tokens) })),
    { label: null, text: row('free', Math.max(0, r.window - r.used)) },
  ];
}
export function contextFootnote(r: ContextReading): string {
  return r.measured
    ? 'Total: reported by the provider for the last request. The split is an estimate.'
    : 'Estimated from the text (about 4 characters a token) until the provider reports usage.';
}
