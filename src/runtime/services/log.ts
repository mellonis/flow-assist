import fs from 'node:fs';
import { hostStateDir } from '../../config/load.js';
import path from 'node:path';

// Debug log for tool runs lives with the rest of the host state (`hostStateDir`,
// honouring the XDG override — a temporary directory under `bun test`, so a test that
// turns `debug.logTools` on does not append to the person's own log). Resolved on
// every call, never at import, or the guard would be fixed before a test could move it.
const toolsLogPath = (): string => path.join(hostStateDir(), 'tools.log');

// ~5 MB cap on the tool-call log file — a simple rotation: when the file grows
// past this, it is renamed to `<file>.1` before the next append.
export const LOG_TOOLS_MAX = 5 * 1024 * 1024;

// Attributes describing a single tool invocation for the debug log. All but
// `name` are optional; `ts` is filled in by the service when omitted.
export interface ToolRunEntry {
  ts?: string;
  name?: string;
  write?: boolean;
  outcome?: string;
  args?: unknown;
  detail?: unknown;
}

// Renders one tool call to a single grep-able line: time, name, truncated args,
// read/write, outcome, and a truncated detail. Long values are clipped at 300
// chars with a trailing ellipsis.
export function formatToolRun(entry: ToolRunEntry): string {
  const ts = entry.ts ?? new Date().toISOString();
  const short = (v: unknown, n = 300): string => {
    const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
    return s.length > n ? s.slice(0, n) + '…' : s;
  };
  return `${ts}  ${entry.name ?? ''}  ${short(entry.args)}  ${
    entry.write ? 'write' : 'read'
  }  ${entry.outcome ?? ''} | ${short(entry.detail)}`;
}

export interface LogService {
  // Append a raw line to the in-memory buffer.
  append(entry: string): void;
  // Return the current in-memory buffer (as an array of lines).
  read(): string[];
  // Empty the in-memory buffer.
  clear(): void;
  // Append a formatted tool-run line to the home log file (with rotation),
  // gated by config.debug.logTools. File-write errors are silently swallowed.
  logToolRun(entry: ToolRunEntry): void;
}

// Creates the host log service: an in-memory line buffer plus an opt-in
// on-disk tool-call log. The buffer is a plain array of strings; the file log is
// the only place `logToolRun` writes and it never throws.
// The in-memory log keeps its last LOG_MAX_LINES lines: a plugin printing on every
// render, or a long session, must not grow it without end.
export const LOG_MAX_LINES = 2000;

export function createLogService(config: Record<string, unknown> | undefined): LogService {
  const debug = config?.debug as { logTools?: boolean } | undefined;
  const logTools = debug?.logTools === true;
  const buffer: string[] = [];

  return {
    append(entry: string): void {
      // When it happened is half of what a log line says; the buffer had none.
      const t = new Date();
      const stamp = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
      buffer.push(`${stamp} ${entry}`);
      if (buffer.length > LOG_MAX_LINES) buffer.splice(0, buffer.length - LOG_MAX_LINES);
    },

    read(): string[] {
      return buffer;
    },

    clear(): void {
      buffer.length = 0;
    },

    logToolRun(entry: ToolRunEntry): void {
      if (!logTools) return;
      const file = toolsLogPath();
      try {
        if (fs.existsSync(file) && fs.statSync(file).size > LOG_TOOLS_MAX) {
          fs.renameSync(file, `${file}.1`);
        }
      } catch {
        // Rotation is best-effort; a failed rename must not abort the loop.
      }
      try {
        const line = formatToolRun({ ts: new Date().toISOString(), ...entry }) + '\n';
        fs.appendFileSync(file, line, 'utf8');
      } catch {
        // Logging is optional; a failed write is silently ignored.
      }
    },
  };
}