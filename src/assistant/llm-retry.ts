// A model request that fails for a reason that passes is made again. Every request to
// the model goes through `withRetry`: both streamed rounds (the OpenAI-compatible one in
// ./agent.ts and the Anthropic one in ./anthropic.ts) and both compaction paths.
//
// What is repeated: an HTTP status 429, 500, 502, 503, 504 or 529, the same statuses
// arriving as a stream's `error` event, and a network failure of the request itself
// (refused, reset, no such host). Anything else — a 400, 401, 403, 404, a stop by the
// person — fails at once.
//
// When: only while the round has given nothing to its callbacks. A round that already
// showed text, reasoning or a tool call is never made again — the answer would appear
// twice and a call could run twice — so `withRetry` wraps those callbacks itself and
// the rule holds for every caller.
//
// How often and how long: the first request plus up to `retries` repeats (`ai.retries`,
// 10), `retryDelay` seconds before each (`ai.retryDelay`, 3) or the response's
// `Retry-After` when it sent one, capped at a minute. The wait ends at once when the
// signal aborts, and the request then ends as an abort, not a failure.
//
// The text of a failure is the one `llmErrorMessage` (./llm-error.ts) builds, so
// `isImageRefusal` and every reader of its head `LLM <status>` keep working; only a
// give-up after repeats appends ` — gave up after N retries`.

import { llmErrorMessage } from './llm-error.js';

export const RETRIES_DEFAULT = 10;
export const RETRY_DELAY_DEFAULT = 3;
// The longest a `Retry-After` is obeyed, in milliseconds.
export const RETRY_AFTER_CAP_MS = 60_000;

// The statuses worth repeating: the provider is limiting, busy or failing, not refusing.
export const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 529]);

// The clock a wait and a `Retry-After` date are read from. A seam for tests, which move
// it instead of sleeping.
export const retryClock: {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  // Calls `fn` every `ms` until the returned function is called (the status line's
  // countdown).
  every: (fn: () => void, ms: number) => () => void;
} = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  }),
  every: (fn, ms) => {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  },
};

const abortError = (): Error => new DOMException('The operation was aborted.', 'AbortError');

// A request that failed: `status` is the provider's (or the stream's `error` event's),
// absent for a network failure; `retryAfterMs` is what its `Retry-After` asked for.
export class LlmRequestError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly network: boolean;
  // How many repeats were made before this failure was given up on.
  retries = 0;
  constructor(message: string, o: { status?: number; retryAfterMs?: number; network?: boolean; cause?: unknown } = {}) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = 'Error';
    if (o.status !== undefined) this.status = o.status;
    if (o.retryAfterMs !== undefined) this.retryAfterMs = o.retryAfterMs;
    this.network = !!o.network;
  }
}

// `Retry-After` is whole seconds or an HTTP date. A date in the past, a negative number
// and anything unreadable are no hint at all.
export function parseRetryAfter(value: string | null | undefined, now: number = retryClock.now()): number | undefined {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  if (/^-/.test(text)) return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

// The error for a response that was not ok, with the text `llmErrorMessage` gives it.
export function failedRequest(res: Response, body: string, o: { model?: string; idHeader?: string }): LlmRequestError {
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
  return new LlmRequestError(
    llmErrorMessage(res.status, body, { model: o.model, requestId: res.headers.get(o.idHeader ?? 'x-request-id'), statusText: res.statusText }),
    { status: res.status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
  );
}

const NETWORK_CODES = new Set(['ConnectionRefused', 'ConnectionClosed', 'FailedToOpenSocket', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

// `fetch` itself rejected: the request never got a response. An abort by the signal is
// the person's and passes through as it is; so does anything that is not the network's
// (a test double that throws a plain Error).
export async function reach(send: () => Promise<Response>, signal?: AbortSignal): Promise<Response> {
  try {
    return await send();
  } catch (e) {
    const err = e as { name?: string; code?: unknown; cause?: { code?: unknown }; message?: unknown } | null;
    if (signal?.aborted || err?.name === 'AbortError') throw e;
    const code = String(err?.code ?? err?.cause?.code ?? '');
    if (e instanceof TypeError || NETWORK_CODES.has(code)) throw new LlmRequestError(String(err?.message ?? e), { network: true, cause: e });
    throw e;
  }
}

export interface RetryInfo {
  // This repeat's number (1-based) and how many at most.
  attempt: number;
  of: number;
  // The failure that is being waited out; absent for a network failure.
  status?: number;
  waitMs: number;
  message: string;
}

// What the person reads while a repeat waits: `LLM 429 · retry 2/10 in 3 s`.
export function retryLabel(info: Pick<RetryInfo, 'attempt' | 'of' | 'status'>, secondsLeft: number): string {
  return `${info.status !== undefined ? `LLM ${info.status}` : 'LLM unreachable'} · retry ${info.attempt}/${info.of} in ${secondsLeft} s`;
}

export interface RetryOpts {
  retries?: number;
  retryDelay?: number;
  signal?: AbortSignal;
  // Told before each wait. What it returns, a function, is called when the wait ends
  // (completed or cut short) — the place to take a countdown down.
  onRetry?: (info: RetryInfo) => void | (() => void);
  onDelta?: (d: string) => void;
  onReasoning?: (d: string) => void;
  onToolCalls?: () => void;
}

export interface RoundCallbacks {
  onDelta: (d: string) => void;
  onReasoning: (d: string) => void;
  onToolCalls: () => void;
}

// A whole number at or above 0, else the default.
const whole = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : dflt);
const seconds = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : dflt);

const retryable = (e: unknown): e is LlmRequestError =>
  e instanceof LlmRequestError && (e.network || (e.status !== undefined && RETRY_STATUSES.has(e.status)));

// Runs `attempt` until it succeeds or fails for a reason that does not pass. `attempt`
// is handed the callbacks to give the round (wrapping the caller's own, which it names
// in `o`); it is called again only while none of them has fired.
export async function withRetry<R>(o: RetryOpts, attempt: (callbacks: RoundCallbacks) => Promise<R>): Promise<R> {
  const retries = whole(o.retries, RETRIES_DEFAULT);
  const delayMs = seconds(o.retryDelay, RETRY_DELAY_DEFAULT) * 1000;
  let delivered = false;
  const callbacks: RoundCallbacks = {
    onDelta: (d) => { delivered = true; o.onDelta?.(d); },
    onReasoning: (d) => { delivered = true; o.onReasoning?.(d); },
    onToolCalls: () => { delivered = true; o.onToolCalls?.(); },
  };
  for (let made = 0; ; made++) {
    try {
      return await attempt(callbacks);
    } catch (e) {
      if (o.signal?.aborted || (e as Error)?.name === 'AbortError') throw e;
      if (!retryable(e) || delivered) throw e;
      if (made >= retries) {
        if (made > 0) {
          e.retries = made;
          e.message = `${e.message} — gave up after ${made} ${made === 1 ? 'retry' : 'retries'}`;
        }
        throw e;
      }
      const waitMs = e.retryAfterMs !== undefined ? Math.min(e.retryAfterMs, RETRY_AFTER_CAP_MS) : delayMs;
      const end = o.onRetry?.({ attempt: made + 1, of: retries, ...(e.status !== undefined ? { status: e.status } : {}), waitMs, message: e.message });
      try {
        await retryClock.sleep(waitMs, o.signal);
      } finally {
        if (typeof end === 'function') end();
      }
    }
  }
}
