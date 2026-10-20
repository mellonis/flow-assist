// A model request that fails for a reason that passes is made again. Every request to
// the model goes through `withRetry`: both streamed rounds (the OpenAI-compatible one in
// ./agent.ts and the Anthropic one in ./anthropic.ts) and both compaction paths.
//
// What is repeated: an HTTP status 429, 500, 502, 503, 504 or 529, the same statuses
// arriving as a stream's `error` event, and a network failure of the request itself
// or of reading its body (refused, reset, no such host), told by its connection code.
// Anything else — a 400, 401, 403, 404, an invalid URL or header, a stop by the person —
// fails at once.
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

// The real wait: ends at once, as an abort, when the signal aborts.
export const sleepFor = (ms: number, signal?: AbortSignal): Promise<void> => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(abortError()); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(abortError()); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

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
  sleep: sleepFor,
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

const IMF_FIXDATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

// `Retry-After` is whole seconds or an HTTP date in its IMF-fixdate form
// (`Sun, 06 Nov 1994 08:49:37 GMT`) that lies in the future. A date in the past, a
// negative number and anything else (`1 2`, `Mon 3`) are no hint at all, so the
// configured delay applies.
export function parseRetryAfter(value: string | null | undefined, now: number = retryClock.now()): number | undefined {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  if (/^-/.test(text)) return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  if (!IMF_FIXDATE.test(text)) return undefined;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return at > now ? at - now : undefined;
}

// The error for a response that was not ok, with the text `llmErrorMessage` gives it.
export function failedRequest(res: Response, body: string, o: { model?: string; idHeader?: string }): LlmRequestError {
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
  return new LlmRequestError(
    llmErrorMessage(res.status, body, { model: o.model, requestId: res.headers.get(o.idHeader ?? 'x-request-id'), statusText: res.statusText }),
    { status: res.status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
  );
}

// The codes a connection failure carries, on the error or on its cause: Bun's own names
// and the system's.
const NETWORK_CODES = new Set(['ConnectionRefused', 'ConnectionClosed', 'FailedToOpenSocket', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

type CodedError = { name?: string; code?: unknown; cause?: { code?: unknown }; message?: unknown } | null;

// A failure is the network's only by its code. An invalid URL, an invalid header and any
// other `TypeError` carry none, so they fail at once instead of being repeated.
const connectionFailure = (e: unknown): boolean => {
  const err = e as CodedError;
  return NETWORK_CODES.has(String(err?.code ?? '')) || NETWORK_CODES.has(String(err?.cause?.code ?? ''));
};

const networkError = (e: unknown): LlmRequestError => new LlmRequestError(String((e as CodedError)?.message ?? e), { network: true, cause: e });

// `fetch` itself rejected: the request never got a response. An abort by the signal is
// the person's and passes through as it is; so does anything without a connection code
// (a configuration error, a test double that throws a plain Error). `send` holds only
// the `fetch` call: the URL, headers and body are built before it.
export async function reach(send: () => Promise<Response>, signal?: AbortSignal): Promise<Response> {
  try {
    return await send();
  } catch (e) {
    if (signal?.aborted || (e as CodedError)?.name === 'AbortError') throw e;
    if (connectionFailure(e)) throw networkError(e);
    throw e;
  }
}

// One `reader.read()` of a streamed body. A failure of the connection while the body is
// read is the network's, by the same rule as `reach`; the reader is cancelled before the
// error goes on, and `withRetry` repeats the round only if it has delivered nothing. A
// stop by the person stays an abort.
export async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  try {
    return await reader.read();
  } catch (e) {
    if (signal?.aborted || (e as CodedError)?.name === 'AbortError') throw e;
    if (!connectionFailure(e)) throw e;
    reader.cancel().catch(() => {});
    throw networkError(e);
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
      // A notice that throws does not change the outcome: the wait goes on.
      let end: void | (() => void) = undefined;
      try {
        end = o.onRetry?.({ attempt: made + 1, of: retries, ...(e.status !== undefined ? { status: e.status } : {}), waitMs, message: e.message });
      } catch { /* swallowed */ }
      try {
        await retryClock.sleep(waitMs, o.signal);
      } finally {
        if (typeof end === 'function') end();
      }
    }
  }
}
