// A JSON-RPC 2.0 peer over lines: both sides of the protocol are one of these. It
// numbers its requests, matches answers by id, times each out, dispatches the other
// side's requests and notifications to handlers by method, and answers an unknown
// method with -32601. Lines that are not messages go to `onUnknown` and nowhere else.
import { formatMessage, parseLine, type Message, type Request, type Response } from './codec.js';

// `onClose` is optional: a transport that can tell its other side is gone (a plugin's
// own stdio, closed when the host that spawned it is gone; one connection of a shared
// server, closed when its host leaves) reports it here, so a peer over it can react to
// the other side vanishing without a message; one that cannot (an in-memory pair in a
// test) leaves it out.
export interface PeerIo { send(line: string): void; onLine(fn: (line: string) => void): void; onClose?(fn: () => void): void }
export interface PeerOpts { defaultTimeoutMs?: number }

export class PeerError extends Error {
  static readonly TIMEOUT = -32000;
  static readonly CLOSED = -32001;
  static readonly METHOD_NOT_FOUND = -32601;
  static readonly INVALID_PARAMS = -32602;
  static readonly INTERNAL = -32603;
  constructor(message: string, public readonly code: number, public readonly data?: unknown) { super(message); this.name = 'PeerError'; }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export interface Peer {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onRequest(method: string, handler: (params: unknown) => unknown | Promise<unknown>): void;
  onNotify(method: string, handler: (params: unknown) => void): void;
  onUnknown(fn: (line: string) => void): void;
  close(): void;
}

export function createPeer(io: PeerIo, opts: PeerOpts = {}): Peer {
  const defaultTimeout = opts.defaultTimeoutMs ?? 60_000;
  const pending = new Map<number, Pending>();
  const requests = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
  const notifies = new Map<string, (params: unknown) => void>();
  let unknown: (line: string) => void = () => {};
  let nextId = 1;
  let closed = false;

  const send = (m: Message) => { if (!closed) io.send(formatMessage(m)); };
  const answer = (id: Request['id'], result: unknown) => send({ jsonrpc: '2.0', id, result: result === undefined ? null : result });
  const fail = (id: Request['id'], code: number, message: string, data?: unknown) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  io.onLine((line) => {
    const m = parseLine(line);
    if (!m) { unknown(line); return; }
    if ('method' in m) {
      const isRequest = 'id' in m && m.id !== undefined && m.id !== null;
      if (isRequest) {
        const h = requests.get(m.method);
        if (!h) { fail((m as Request).id, PeerError.METHOD_NOT_FOUND, `unknown method: ${m.method}`); return; }
        Promise.resolve().then(() => h(m.params)).then((r) => answer((m as Request).id, r), (e: unknown) => {
          const err = e instanceof PeerError ? e : new PeerError(e instanceof Error ? e.message : String(e), PeerError.INTERNAL);
          fail((m as Request).id, err.code, err.message, err.data);
        });
      } else {
        try { notifies.get(m.method)?.(m.params); } catch { /* a handler's own trouble */ }
      }
      return;
    }
    const r = m as Response;
    const p = typeof r.id === 'number' ? pending.get(r.id) : undefined;
    if (!p) return;
    pending.delete(r.id as number);
    clearTimeout(p.timer);
    if (r.error) p.reject(new PeerError(r.error.message ?? 'error', r.error.code ?? PeerError.INTERNAL, r.error.data));
    else p.resolve(r.result);
  });

  return {
    request(method, params, timeoutMs = defaultTimeout) {
      if (closed) return Promise.reject(new PeerError('closed', PeerError.CLOSED));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new PeerError(`${method}: no answer in ${timeoutMs} ms`, PeerError.TIMEOUT)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      });
    },
    notify(method, params) { send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }); },
    onRequest(method, handler) { requests.set(method, handler); },
    onNotify(method, handler) { notifies.set(method, handler); },
    onUnknown(fn) { unknown = fn; },
    close() {
      closed = true;
      for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new PeerError('closed', PeerError.CLOSED)); pending.delete(id); }
    },
  };
}
