// What a tool shows the person: a BLOCK it describes, which a RENDERER draws and the
// host FRAMES.
//
// A write tool can already say what it changed (`ctx.reportChange`, ./diff.ts) and the
// host turns that into the `✎ title · +N −M` diff. Everything else a tool does would
// collapse to one dim line under ^r if the host had to know the tool by name. So a tool
// may also hand over a VIEW — a kind and data, never rendering — and something draws
// it: the host's own `console` (./console-view.ts, what `run_command` and the person's
// own `!command` both print) or a plugin's own renderer, named in its shape's
// `viewRenderers`. This file holds what is common to every kind: the record a session
// keeps (`ViewRecord`), the lookup from a kind to its renderer (`resolveRenderer`,
// `qualifyKind`), and the framing every renderer's rows go through on the way to the
// screen (`frameView`) — the cap on rows and line width, the colour resolved from the
// palette, escape sequences and control characters stripped. `reportChange` stays as
// the shorthand it is and becomes a kind of its own later, when a second real case
// says what the kinds have in common.
//
// Two rules hold this file together:
//
//   - **A view is display only.** It rides on the display message and never on the
//     tool result, so the model's history does not grow a copy of what it already
//     read. The e2e tests assert on what is SENT.
//   - **A view is not the host speaking.** Its text comes from a command, a file or a
//     page, which somebody else may have written: escape sequences and control
//     characters are stripped and every part of it is capped — at collection time
//     (the per-kind cap, e.g. `console`'s in ./console-view.ts) and again in
//     `frameView` (rows, line width) — so what a session keeps, and what reaches the
//     screen, are both bounded.
//
// Pure: no fs, no clock, no colours.

export const VIEW_CAPS = {
  // What a view KEEPS — and so what a session file holds and what ^r unfolds.
  lines: 200,
  chars: 20_000,
  // One line of output; the rest of it is cut with an ellipsis. This is the cap that
  // protects the screen: a fenced line longer than the window is hard-wrapped into
  // several rows, so a few very long lines cost more rows than many short ones.
  lineChars: 200,
  command: 300,
  // How many lines an open console block shows.
  folded: 20,
  // How many rows any block may take, whatever its renderer returns.
  rows: 400,
} as const;

// A fence longer than any run of backticks in the text, so a text that prints a fence
// of its own cannot close ours and write markdown — or host-looking chrome — outside it.
export function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

// An ANSI escape sequence in any of the shapes a program emits: CSI (colours, cursor
// moves), OSC (a title, ended by BEL or ST), and anything else introduced by ESC.
const ESCAPES = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[[(][0-?]*[ -/]*[@-~]|\u001B[@-Z\\-_]/g;
// What is left of C0 and C1 once the line breaks are line breaks and tabs are spaces.
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const TAB_WIDTH = 4;

// Text as it may be drawn: no escape sequences, no control characters, and `\r`
// treated as a line break of its own — a progress bar that rewrites one line with
// carriage returns becomes one line per state, so the cap below keeps its LAST state
// rather than gluing the whole bar into a single unreadable row.
export function sanitizeViewText(raw: unknown): string {
  return String(raw ?? '')
    .replace(ESCAPES, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' '.repeat(TAB_WIDTH))
    .replace(CONTROLS, '');
}

// ─── Renderers ────────────────────────────────────────────────────────────────
// A view is what a tool DESCRIBES; a renderer — the host's own `console`
// (./console-view.ts) or a plugin's, from its shape's `viewRenderers` — DRAWS it;
// the host FRAMES what the renderer returns. What a session keeps is the record:
// the kind, the tool's data, where the view is in its life, when it began. Never
// drawn rows — those depend on the width and the theme, and are drawn again.
export type ViewPhase = 'live' | 'done' | 'failed' | 'discarded';
export interface ViewRecord {
  kind: string;
  data: unknown;
  phase: ViewPhase;
  startedAt: number;
  // Which call reported it (`<tool_call id>#<n>`), its place among the turn's calls,
  // and which turn — what the chat finalises by and groups by.
  callId?: string;
  seq?: number;
  turn?: number;
}

// A colour is a TOKEN of the chat palette (`ok`, `warn`, `accent`, `shell`, `text`,
// …), never a literal, so one renderer is right on a dark, a light and an unknown
// terminal. A leading `chrome` span (a gutter bar) is painted and never copied.
export interface ViewSpan { text: string; color?: string; dim?: boolean; bold?: boolean; chrome?: boolean }
export type ViewLine = ViewSpan[];
export interface ViewRenderCtx {
  width: number;     // columns for the block's content
  folded: boolean;   // the renderer draws both states
  live: boolean;     // the tool is still running
  failed: boolean;   // the tool threw, or the view was still live when its session was saved and a restart caught it mid-run
  elapsedMs: number; // host clock since the view began — meaningful only while live
  lines: number;     // how many lines of output an open block shows (runOutputLines)
  moreKey: string;   // the cap of the key that opens everything, from its binding
}
export type ViewRenderer = (data: unknown, ctx: ViewRenderCtx) => ViewLine[];
export type ViewRenderers = Record<string, ViewRenderer>;
export interface FramedLine { spans: { text: string; color?: string; dim?: boolean; bold?: boolean }[]; chrome?: number }

export const VIEW_DATA_MAX = 65_536;

export const isConsoleKind = (kind: string) => kind === 'console' || kind.endsWith(':console');

// `notes` + `card` → `notes:card`. A kind the plugin qualified itself is left alone.
export function qualifyKind(owner: string, kind: string): string {
  return kind.includes(':') ? kind : `${owner}:${kind}`;
}

// The plugin's own renderer first; failing that, the host's kind of the same name
// (a plugin's tool reporting `console` gets `notes:console`, which is the host's).
export function resolveRenderer(table: ViewRenderers, kind: string): ViewRenderer | null {
  if (typeof kind !== 'string') return null; // a session file may hold anything
  const own = Object.hasOwn(table, kind) ? table[kind] : undefined;
  if (typeof own === 'function') return own;
  const bare = kind.slice(kind.indexOf(':') + 1);
  const host = bare !== kind && Object.hasOwn(table, bare) ? table[bare] : undefined;
  return typeof host === 'function' ? host : null;
}

// Data a view may carry: JSON, and small enough that a session file stays bounded.
export function acceptData(data: unknown): boolean {
  try {
    const s = JSON.stringify(data);
    return typeof s === 'string' && s.length <= VIEW_DATA_MAX;
  } catch {
    return false;
  }
}

const cutTo = (s: string, width: number) => {
  const cps = Array.from(s);
  return cps.length > width ? `${cps.slice(0, Math.max(0, width - 1)).join('')}…` : s;
};

// What reaches the screen, whatever the renderer returned: one row per line — a line
// break inside a span is a space, and a line wider than the block is cut with `…` (a
// wrapped row would be two terminal lines, and the list counts one) — at most
// `VIEW_CAPS.rows` rows, every text stripped, every colour resolved from the palette.
// A renderer that is missing, throws or returns something else costs ONE dim row
// naming the kind; `onFail` hears why, and the caller says it once. `rec` itself is
// display-only input the chat did not build (a session file, another process) — not
// an object, or a `kind` that is not a string, draws `▸ view` rather than throwing.
export function frameView(
  rec: ViewRecord,
  table: ViewRenderers,
  ctx: ViewRenderCtx,
  palette: Record<string, string | undefined>,
  onFail?: (kind: string, why: string) => void,
): FramedLine[] {
  const fallback = (kind: string, why: string): FramedLine[] => {
    onFail?.(kind, why);
    return [{ spans: [{ text: cutTo(`▸ ${sanitizeViewText(kind).replace(/\n/g, ' ')}`, ctx.width), dim: true }] }];
  };
  if (!rec || typeof rec !== 'object' || typeof rec.kind !== 'string') return fallback('view', 'not a view');
  const render = resolveRenderer(table, rec.kind);
  if (!render) return fallback(rec.kind, 'no renderer');
  let lines: unknown;
  try {
    lines = render(rec.data, ctx);
  } catch (e) {
    return fallback(rec.kind, e instanceof Error ? e.message : String(e));
  }
  if (!Array.isArray(lines) || lines.some((l) => !Array.isArray(l))) return fallback(rec.kind, 'not a list of lines');
  return (lines as ViewLine[]).slice(0, VIEW_CAPS.rows).map((line) => {
    let room = ctx.width;
    let chrome = 0;
    let leading = true;
    const spans: FramedLine['spans'] = [];
    for (const s of line) {
      if (room <= 0) break;
      const t = cutTo(sanitizeViewText(s?.text).replace(/\n/g, ' '), room);
      room -= Array.from(t).length;
      if (leading && s?.chrome) chrome++; else leading = false;
      const color = typeof s?.color === 'string' && Object.hasOwn(palette, s.color) ? palette[s.color] : undefined;
      spans.push({ text: t, ...(color ? { color } : {}), ...(s?.dim ? { dim: true } : {}), ...(s?.bold ? { bold: true } : {}) });
    }
    return { spans, ...(chrome ? { chrome } : {}) };
  });
}

// A view as it was reported and saved before renderers — `{ kind: 'console', command,
// text, exitCode, ms, cwd, status }` — read as the console renderer's data. A record
// (it has `phase`) or any other kind is not one.
export function readLegacyView(raw: unknown): ViewRecord | null {
  const v = raw as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || v.kind !== 'console' || 'phase' in v) return null;
  const { kind: _kind, ...data } = v;
  return { kind: 'console', data, phase: 'done', startedAt: 0 };
}
