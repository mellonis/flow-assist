// A minimal MCP client over Streamable HTTP — enough to list a server's tools and call
// them: `initialize` → `notifications/initialized` → `tools/list` (paged) → `tools/call`.
// JSON-RPC 2.0; a response may come back as plain JSON or as an SSE stream, and the
// session id the server hands out in `Mcp-Session-Id` travels with every later call.
//
// No SDK: the official one brings a web server stack along (express, hono, jose, ajv…)
// for a client that needs a few POSTs. Not here (yet): the stdio transport (it needs a
// way to stop child processes on exit), OAuth, resources, prompts.
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
  timeoutMs?: number;
  fetch?: Fetcher;
  clientVersion?: string;
}

export class McpError extends Error {}

export function createMcpClient(opts: McpClientOptions) {
  const doFetch: Fetcher = opts.fetch ?? ((u, i) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let session: string | undefined;
  let protocol = PROTOCOL_VERSION;
  let nextId = 1;

  async function post(body: unknown, expectResponse: boolean): Promise<unknown> {
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
      const message = type.includes('text/event-stream') ? await fromSse(res, id) : await res.json();
      const m = message as { result?: unknown; error?: { code?: number; message?: string } };
      if (m?.error) throw new McpError(`${m.error.message ?? 'error'}${m.error.code !== undefined ? ` (${m.error.code})` : ''}`);
      return m?.result;
    } catch (e) {
      if (ctl.signal.aborted) throw new McpError(`no answer in ${timeoutMs} ms`);
      throw e instanceof McpError ? e : new McpError((e as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }

  const request = (method: string, params?: unknown) => post({ jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) }, true);
  const notify = (method: string) => post({ jsonrpc: '2.0', method }, false);

  return {
    get session() { return session; },
    async initialize(): Promise<{ serverName?: string; serverVersion?: string; protocolVersion: string }> {
      const r = (await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'flow-assist', version: opts.clientVersion ?? '0' },
      })) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } };
      protocol = r?.protocolVersion ?? PROTOCOL_VERSION;
      await notify('notifications/initialized');
      return { serverName: r?.serverInfo?.name, serverVersion: r?.serverInfo?.version, protocolVersion: protocol };
    },
    async listTools(): Promise<McpTool[]> {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const r = (await request('tools/list', cursor ? { cursor } : {})) as { tools?: McpTool[]; nextCursor?: string };
        tools.push(...(r?.tools ?? []));
        cursor = r?.nextCursor;
        if (!cursor) break;
      }
      return tools;
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
      return ((await request('tools/call', { name, arguments: args })) ?? {}) as McpCallResult;
    },
  };
}
export type McpClient = ReturnType<typeof createMcpClient>;

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
