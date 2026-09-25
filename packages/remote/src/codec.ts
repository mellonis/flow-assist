// JSON-RPC 2.0 over lines: one message per line, the MCP stdio framing. A line that is
// not a JSON-RPC message — a banner, a stray print — is not a message and never an
// error. A line past `MAX_LINE` is dropped whole so a writer that never sends a newline
// cannot eat the memory.
export interface Request { jsonrpc: '2.0'; id: number | string; method: string; params?: unknown }
export interface Notification { jsonrpc: '2.0'; method: string; params?: unknown }
export interface Response { jsonrpc: '2.0'; id: number | string | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }
export type Message = Request | Notification | Response;

export const MAX_LINE = 64 * 1024 * 1024;

export function parseLine(line: string): Message | null {
  if (!line || line[0] !== '{') return null;
  let v: unknown;
  try { v = JSON.parse(line); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const m = v as Record<string, unknown>;
  if (m.jsonrpc !== '2.0') return null;
  if (typeof m.method === 'string') return m as unknown as Request | Notification;
  if ('id' in m && ('result' in m || 'error' in m)) return m as unknown as Response;
  return null;
}

export const formatMessage = (m: Message): string => JSON.stringify(m);

// Splits a byte stream into lines. `onLine` gets each complete line without its
// newline; `onDrop` the length of a line that grew past `MAX_LINE` and was thrown away.
export class LineSplitter {
  private buf = '';
  private dropping = 0;
  constructor(private onLine: (line: string) => void, private onDrop: (length: number) => void = () => {}) {}
  feed(chunk: string): void {
    let text = chunk;
    while (text.length) {
      const nl = text.indexOf('\n');
      if (this.dropping) {
        if (nl === -1) { this.dropping += text.length; return; }
        this.onDrop(this.dropping + nl);
        this.dropping = 0;
        text = text.slice(nl + 1);
        continue;
      }
      if (nl === -1) {
        this.buf += text;
        if (this.buf.length > MAX_LINE) { this.dropping = this.buf.length; this.buf = ''; }
        return;
      }
      const line = this.buf + text.slice(0, nl);
      this.buf = '';
      text = text.slice(nl + 1);
      if (line.length > MAX_LINE) this.onDrop(line.length);
      else if (line.endsWith('\r')) this.onLine(line.slice(0, -1));
      else this.onLine(line);
    }
  }
}
