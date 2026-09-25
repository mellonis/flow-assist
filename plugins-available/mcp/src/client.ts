// A minimal MCP client — enough to list a server's tools and call them: `initialize` →
// `notifications/initialized` → `tools/list` (paged) → `tools/call`, JSON-RPC 2.0.
//
// The protocol is written once (`createProtocol`) over a transport that only moves
// messages: it sends one and, for a request, hands back the message that answers it.
// Two transports exist. Streamable HTTP lives here: a response may come back as plain
// JSON or as an SSE stream, and the session id the server hands out in
// `Mcp-Session-Id` travels with every later call. stdio — a server started as a
// command — lives in `stdio.ts`, with the child process it owns.
//
// No SDK: the official one brings a web server stack along (express, hono, jose, ajv…)
// for a client that needs a few POSTs. Not here (yet): OAuth, resources, prompts.
//
// `fetch` is injected — the tests run against a fake with no network.

export const PROTOCOL_VERSION = '2025-06-18';

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
};
export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image' | 'audio'; mimeType?: string; data?: string }
  | { type: 'resource'; resource?: { uri?: string; text?: string; mimeType?: string } }
  | { type: 'resource_link'; uri?: string; name?: string }
  | { type: string; [k: string]: unknown };
export type McpCallResult = { content?: McpContent[]; structuredContent?: unknown; isError?: boolean };

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export interface McpClientOptions {
  url: string;
  headers?: Record<string, string>;
  // Per request: `connectTimeoutMs` for the handshake and the tool list (the app waits
  // for them at start — a closed IDE must not hold it up), `timeoutMs` for a tool call
  // (an IDE running the tests takes its time).
  connectTimeoutMs?: number;
  timeoutMs?: number;
  fetch?: Fetcher;
  clientVersion?: string;
}

export class McpError extends Error {}

// `initialize`'s `instructions`, kept whole up to this many code points — cut never
// splits a surrogate pair, matching the cap other pieces of text the model sees use
// (`docs/plugins.md`, results). The rest is said, not silently dropped.
const MAX_INSTRUCTIONS = 2_000;

// Trimmed, and capped by code points with a note when it does not fit — nothing else:
// the app's own framing and control characters are taken out where the model actually
// reads it (`ToolGroup.description`, `src/assistant/tool-loading.ts`'s
// `sanitizeGroupDescription`), the one place every group's description passes through,
// not here, where a plugin loaded from source has no host module to call.
function capInstructions(raw: string): string {
  const trimmed = raw.trim();
  const cps = Array.from(trimmed);
  if (cps.length <= MAX_INSTRUCTIONS) return trimmed;
  return `${cps.slice(0, MAX_INSTRUCTIONS).join('')}\n… (${cps.length - MAX_INSTRUCTIONS} more characters not shown)`;
}

// What the protocol needs of a transport: send one JSON-RPC message and, when it is a
// request (`expectResponse`), resolve with the raw message answering it — the protocol
// unwraps `result` / `error` itself. A transport rejects with an McpError: `no answer in
// N ms` when the time ran out, or its own words when the line is down.
// `protocolVersion()` is read on every send (HTTP puts it in a header).
export interface McpTransport {
  send(message: { jsonrpc: '2.0'; id?: number; method: string; params?: unknown }, expectResponse: boolean, timeoutMs: number): Promise<unknown>;
  // Lets go of the connection. HTTP has nothing to let go of; stdio stops its process.
  close(): void;
}

export interface ProtocolOptions {
  connectTimeoutMs?: number;
  timeoutMs?: number;
  clientVersion?: string;
}

// The protocol over a transport. `onProtocol` hears the version the server agreed to, for
// a transport that has to carry it (HTTP's `mcp-protocol-version` header).
export function createProtocol(transport: McpTransport, opts: ProtocolOptions, onProtocol?: (version: string) => void) {
  const callTimeoutMs = opts.timeoutMs ?? 60_000;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 1_500;
  let nextId = 1;

  async function request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const message = (await transport.send({ jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) }, true, timeoutMs)) as { result?: unknown; error?: { code?: number; message?: string } } | undefined;
    if (message?.error) throw new McpError(`${message.error.message ?? 'error'}${message.error.code !== undefined ? ` (${message.error.code})` : ''}`);
    return message?.result;
  }
  const notify = (method: string) => transport.send({ jsonrpc: '2.0', method }, false, connectTimeoutMs);

  return {
    async initialize(): Promise<{ serverName?: string; serverVersion?: string; protocolVersion: string; instructions?: string }> {
      const r = (await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'flow-assist', version: opts.clientVersion ?? '0' },
      }, connectTimeoutMs)) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string }; instructions?: string };
      const protocol = r?.protocolVersion ?? PROTOCOL_VERSION;
      onProtocol?.(protocol);
      await notify('notifications/initialized');
      const instructions = typeof r?.instructions === 'string' && r.instructions.trim() ? capInstructions(r.instructions) : undefined;
      return { serverName: r?.serverInfo?.name, serverVersion: r?.serverInfo?.version, protocolVersion: protocol, ...(instructions ? { instructions } : {}) };
    },
    async listTools(): Promise<McpTool[]> {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const r = (await request('tools/list', cursor ? { cursor } : {}, connectTimeoutMs)) as { tools?: McpTool[]; nextCursor?: string };
        tools.push(...(r?.tools ?? []));
        cursor = r?.nextCursor;
        if (!cursor) break;
      }
      return tools;
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
      return ((await request('tools/call', { name, arguments: args }, callTimeoutMs)) ?? {}) as McpCallResult;
    },
    close: () => transport.close(),
  };
}
export type McpClient = ReturnType<typeof createProtocol>;

export function createMcpClient(opts: McpClientOptions) {
  const doFetch: Fetcher = opts.fetch ?? ((u, i) => fetch(u, i));
  let session: string | undefined;
  let protocol = PROTOCOL_VERSION;

  async function post(body: unknown, expectResponse: boolean, timeoutMs: number): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await doFetch(opts.url, {
        method: 'POST',
        signal: ctl.signal,
        headers: {
          ...opts.headers,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': protocol,
          ...(session ? { 'mcp-session-id': session } : {}),
        },
        body: JSON.stringify(body),
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) session = sid;
      if (!res.ok) throw new McpError(`HTTP ${res.status}${(await res.text().catch(() => '')).slice(0, 200).replace(/^/, ': ')}`);
      if (!expectResponse) return undefined;
      const id = (body as { id?: number }).id;
      const type = res.headers.get('content-type') ?? '';
      return type.includes('text/event-stream') ? await fromSse(res, id) : await res.json();
    } catch (e) {
      if (ctl.signal.aborted) throw new McpError(`no answer in ${timeoutMs} ms`);
      throw e instanceof McpError ? e : new McpError((e as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }

  const protocolClient = createProtocol({ send: post, close: () => {} }, opts, (v) => { protocol = v; });
  return {
    ...protocolClient,
    get session() { return session; },
  };
}

// The JSON-RPC message answering `id` out of an SSE body (`data:` lines, events split by
// a blank line). Other messages the server interleaves — notifications, progress — are
// skipped.
async function fromSse(res: Response, id: number | undefined): Promise<unknown> {
  const text = await res.text();
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    try {
      const msg = JSON.parse(data) as { id?: number };
      if (msg && msg.id === id) return msg;
    } catch { /* not JSON — skip */ }
  }
  throw new McpError('the event stream ended without an answer');
}

// A tool result as text for the model: text items as they are, the rest named.
export function resultText(r: McpCallResult): string {
  const parts = (r.content ?? []).map((c) => {
    if (c.type === 'text') return String((c as { text?: unknown }).text ?? '');
    if (c.type === 'image' || c.type === 'audio') return `[${c.type}${(c as { mimeType?: string }).mimeType ? ` ${(c as { mimeType?: string }).mimeType}` : ''} — not shown]`;
    if (c.type === 'resource') {
      const res = (c as { resource?: { uri?: string; text?: string } }).resource;
      return res?.text ?? `[resource ${res?.uri ?? ''}]`;
    }
    if (c.type === 'resource_link') return `[link ${(c as { uri?: string }).uri ?? ''}]`;
    return `[${c.type}]`;
  });
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 1));
  return parts.join('\n').trim();
}
