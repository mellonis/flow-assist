// What a provider's refusal SAYS, read out of its body. Pasted whole, the raw body
// would show as the reason a turn failed — `LLM 403: { "message":"model_access_denied",
// "request_id":"2395…" }` — so it is read instead for the provider's own words. The
// shapes providers answer with:
//
//   - OpenAI-style `{ "error": { "message", "code", "type", "request_id" } }` (or
//     `"error": "…"` as a bare string);
//   - a flat `{ "message": "…" }`;
//   - FastAPI-style `{ "detail": "…" }` or `{ "detail": [{ "msg": "…" }, …] }`;
//   - anything else: the text itself, whitespace collapsed and cut.
//
// The line keeps `LLM <status>` first — `isImageRefusal` (./images.ts) reads the
// status there and the provider's own words after it. Pure: the caller hands the
// status, the body text and what else it knows.

// How much of a provider's message is kept: one line's worth, not a dump.
const MESSAGE_CHARS = 200;

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();
const cut = (text: string, n = MESSAGE_CHARS): string => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

// The provider's message and request id, from a body in any of the shapes above.
export function readLlmBody(body: string): { message: string; requestId: string } {
  const text = String(body ?? '');
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = undefined; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { message: cut(collapse(text)), requestId: '' };
  const o = data as Record<string, unknown>;
  const err = o.error;
  const e = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
  const detail = o.detail;
  const detailText = typeof detail === 'string'
    ? detail
    : Array.isArray(detail)
      ? detail.map((d) => str((d as Record<string, unknown> | null)?.msg)).filter(Boolean).join('; ')
      : '';
  const message = str(e.message) || str(err) || str(o.message) || detailText || str(e.code) || str(e.type) || str(o.code);
  const requestId = str(o.request_id) || str(e.request_id);
  return { message: cut(collapse(message || text)), requestId };
}

// The error's text: `LLM 403 · <model>: model_access_denied (request 2395abcd)`, with a
// hint for a refusal of the token or the model. `requestId` from the response header
// (`x-request-id`) is taken when the body has none.
export function llmErrorMessage(status: number, body: string, opts: { model?: string; requestId?: string | null; statusText?: string } = {}): string {
  const read = readLlmBody(body);
  const message = read.message || collapse(opts.statusText ?? '') || 'no response body';
  const id = read.requestId || String(opts.requestId ?? '');
  const head = `LLM ${status}${opts.model ? ` · ${opts.model}` : ''}`;
  const request = id ? ` (request ${id.slice(0, 8)})` : '';
  const hint = status === 401 || status === 403 ? ' — the token or the model is not allowed; config set ai.model <model> or check the token' : '';
  return `${head}: ${message}${request}${hint}`;
}
