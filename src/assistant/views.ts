// What a tool shows the person: a BLOCK it describes, which the host draws.
//
// A write tool can already say what it changed (`ctx.reportChange`, ./diff.ts) and the
// host turns that into the `✎ title · +N −M` diff. Everything else a tool does used to
// collapse to one dim line under ^r unless the host knew the tool by name. So a tool
// may also hand over a VIEW — data, never rendering — and the host owns the frame, the
// colours, the wrapping and every cap.
//
// One kind so far: `console`, what `run_command` prints (the same block the person's
// own `!command` leaves). `reportChange` stays as the shorthand it is and becomes a
// kind of its own later, when a second real case says what the kinds have in common;
// `kind` is a discriminant so that is an added member here and not a rewrite.
//
// Two rules hold this file together:
//
//   - **A view is display only.** It rides on the display message and never on the
//     tool result, so the model's history does not grow a copy of what it already
//     read. The e2e tests assert on what is SENT.
//   - **A view is not the host speaking.** Its text comes from a command, a file or a
//     page, which somebody else may have written: it is drawn inside a fenced block
//     that cannot close itself early, escape sequences and control characters are
//     stripped, and every part of it is capped — at collection time, so what a session
//     keeps is bounded too.
//
// Pure: no fs, no clock, no colours.

// A command that ran and what it printed. `status` is the outcome in words when there
// is no exit code to give — a command stopped with Esc, one that ran out of time —
// because `exit ?` says nothing about which of those happened. `cwd` is already in the
// form it is shown in (`~/src/app`): where a command ran is display, not a path to
// resolve.
export interface ConsoleView {
  kind: 'console';
  command: string;
  text: string;
  exitCode: number | null;
  ms: number;
  cwd: string;
  status?: string;
}

// The kinds the host knows. A tool that reports anything else is ignored (see
// `toolView`), so a plugin written against a later host never throws in an older one.
export type ToolView = ConsoleView;

export const VIEW_CAPS = {
  // What a view KEEPS — and so what a session file holds and what ^r unfolds.
  lines: 200,
  chars: 20_000,
  // One line of output; the rest of it is cut with an ellipsis. This is the cap that
  // protects the screen: a fenced line longer than the window is hard-wrapped into
  // several rows, so a few very long lines cost more rows than many short ones.
  lineChars: 200,
  command: 300,
  // How many lines of the block stand in the chat before ^r unfolds the rest.
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

// One line of a command line or a title: everything on one row, nothing to draw but text.
function oneLine(raw: unknown, max: number): string {
  const text = sanitizeViewText(raw).replace(/\n+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// The tail of a text, capped in every direction a view is capped in: each line, the
// number of lines, and the characters altogether. The TAIL, because the end of a
// command's output is what a person looks for.
function capText(raw: unknown): string {
  const lines = sanitizeViewText(raw).replace(/\n+$/, '').split('\n')
    .map((l) => (l.length > VIEW_CAPS.lineChars ? `${l.slice(0, VIEW_CAPS.lineChars)}…` : l));
  const kept = lines.length > VIEW_CAPS.lines ? lines.slice(-VIEW_CAPS.lines) : lines;
  const text = kept.join('\n');
  return text.length > VIEW_CAPS.chars ? text.slice(-VIEW_CAPS.chars) : text;
}

// What a tool reported, as the host will keep it — or null when there is nothing to
// draw. Every cap is applied HERE, at collection, so nothing unbounded ever reaches a
// message, a session file or the screen. An unknown `kind` is ignored rather than
// refused: a plugin built against a later host must not break an older one.
export function toolView(raw: unknown): ToolView | null {
  const v = raw as Partial<ConsoleView> | null | undefined;
  if (!v || typeof v !== 'object' || v.kind !== 'console') return null;
  const command = oneLine(v.command, VIEW_CAPS.command);
  if (!command) return null; // a console block with no command line is not one
  return {
    kind: 'console',
    command,
    text: capText(v.text),
    exitCode: typeof v.exitCode === 'number' ? v.exitCode : null,
    ms: Number.isFinite(v.ms) ? Math.max(0, Number(v.ms)) : 0,
    cwd: oneLine(v.cwd, VIEW_CAPS.command),
    ...(v.status ? { status: oneLine(v.status, 80) } : {}),
  };
}

const fmtSecs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export interface ViewDrawOpts {
  // Folded (the chat's usual state): only the last `lines` rows stand, and the block
  // says how many were left out and which key shows them all.
  folded?: boolean;
  lines?: number;
  // What the key that opens the block is drawn as — the caps come from one dictionary
  // (playback/keys.ts) and follow the binding, so this is given rather than written here.
  moreKey?: string;
}

// How many lines the block leaves out — 0 when all of it stands. The chat asks
// separately because that marker row is the one a CLICK acts on: it is the block's
// fold line, and a block that cut nothing has nothing to open.
export function viewCut(view: ToolView, opts: ViewDrawOpts = {}): number {
  const { folded = true, lines = VIEW_CAPS.folded } = opts;
  const all = view.text ? view.text.split('\n') : [];
  const max = Math.max(1, lines);
  return folded && all.length > max ? all.length - max : 0;
}

// The markdown the chat lays out for one view. A console block reads exactly as the
// person's own `!command` does: the command line and the output in a ```console fence,
// and one quiet line under it.
export function viewMarkdown(view: ToolView, opts: ViewDrawOpts = {}): string {
  const { folded = true, lines = VIEW_CAPS.folded, moreKey = '^o' } = opts;
  const all = view.text ? view.text.split('\n') : [];
  const max = Math.max(1, lines);
  const cut = viewCut(view, { folded, lines });
  const shown = cut ? all.slice(-max) : all;
  // The marker sits where the lines are missing — above what is left of them. It is
  // the block's fold line: a click on it asks for the rest, as the key does.
  // A key nobody has bound is not named: `config.keys.details: []` disables it, and
  // the block is then opened by a click alone.
  const body = [...(cut ? [`… ${cut} line${cut === 1 ? '' : 's'} cut${moreKey ? ` · ${moreKey} for all` : ''}`] : []), ...shown];
  const inside = `$ ${view.command}${body.length ? `\n${body.join('\n')}` : ''}`;
  const f = fence(inside);
  const how = view.status ?? (view.exitCode == null ? 'no exit code' : `exit ${view.exitCode}`);
  const under = [how, fmtSecs(view.ms), view.cwd].filter(Boolean).join(' · ');
  return `${f}console\n${inside}\n${f}\n${under}`;
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
  failed: boolean;   // the tool threw
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
  const own = table[kind];
  if (typeof own === 'function') return own;
  const bare = kind.slice(kind.indexOf(':') + 1);
  const host = bare !== kind ? table[bare] : undefined;
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
// naming the kind; `onFail` hears why, and the caller says it once.
export function frameView(
  rec: ViewRecord,
  table: ViewRenderers,
  ctx: ViewRenderCtx,
  palette: Record<string, string | undefined>,
  onFail?: (kind: string, why: string) => void,
): FramedLine[] {
  const fallback = (why: string): FramedLine[] => {
    onFail?.(rec.kind, why);
    return [{ spans: [{ text: cutTo(`▸ ${rec.kind}`, ctx.width), dim: true }] }];
  };
  const render = resolveRenderer(table, rec.kind);
  if (!render) return fallback('no renderer');
  let lines: unknown;
  try {
    lines = render(rec.data, ctx);
  } catch (e) {
    return fallback(e instanceof Error ? e.message : String(e));
  }
  if (!Array.isArray(lines) || lines.some((l) => !Array.isArray(l))) return fallback('not a list of lines');
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
      const color = typeof s?.color === 'string' ? palette[s.color] : undefined;
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
