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
