// The host's own view renderer: a shell command and what it printed. Registered as
// `console` exactly as a plugin's renderer is (src/loader/registry.ts) — the host has
// no drawing path of its own. `run_command` and the person's `!command` both use it,
// and so does an interactive `!!command` (./interactive.ts), marked `interactive`.
//
// Folded, a command is ONE line: `bun test · ✓ 4.2 s` (the `! `/`‼ ` mark is the gutter's), and
// `· 40 lines` after it when the output is longer than a click shows — how much there
// is to read is news only then, and a block that size may open in the chat's pager —
// or `· last 200 of 300 lines` when the view kept only the tail of what was printed.
// The command itself is kept WHOLE up to `VIEW_CAPS.command` — it is text someone
// typed. A folded row that has no room for it is cut with `cutStep`, reserving space
// for the outcome first, so the duration and how it ended stay on screen even when
// the command does not fit; the open block never cuts it, wrapping it across its own
// rows instead (`wrapCells`) — up to `VIEW_CAPS.commandRows`, past which the DISPLAY
// (never the record, the journal or `/export`) shows a dim `… N more lines of the
// command` row, so the command's own rows can never grow past the output's tail and
// the outcome row. Open, it is the (possibly wrapped, possibly cut) command, the last
// `ctx.lines` lines of output under a bar a drag never copies, and the same tail. The
// tail says how it ended in words a person reads without decoding: ✓, ✗ with the code
// (1 and 127 mean different things), stopped, timed out, or ✗ failed — the tool
// threw, or a restart found this block still live (the process ended mid-command, so
// its own true ending was never recorded).
import { cellWidth, cutStep, wrapCells } from '../cells.js';
import { VIEW_CAPS, sanitizeViewText, type ViewLine, type ViewRenderCtx, type ViewRenderer, type ViewSpan } from './views.js';
import { shellOutcome, tildePath, type ShellResult } from './shell.js';

export interface ConsoleData {
  command: string;
  cwd: string; // in the form it is shown in (`~/src/app`)
  text: string; // the capped tail (capConsoleText)
  exitCode?: number | null; // absent while live
  ms?: number;
  status?: string; // shellOutcome's words
  showCwd?: boolean; // the person's own !command says where it ran — its `cd` sticks
  // Where a `cd` inside the command left the conversation's directory — shown as
  // `cwd → movedTo` when it differs from `cwd`; drawn only alongside `showCwd`.
  movedTo?: string;
  // Set when a `cd` tried to leave the configured roots and stayed put — drawn as
  // the fixed "cd led outside the roots — stayed" note; its own text is unused,
  // only its presence (kept anyway, so a session file records the WHY too).
  note?: string;
  // The person's `!!command` (./interactive.ts): the program had the terminal, and
  // `text` is its recording. Drawn as a dim `interactive` beside the command.
  interactive?: boolean;
  // How many lines the output had when the view kept only its last `VIEW_CAPS.lines`
  // — present only when it was cut, so the folded line can say it holds a tail.
  lines?: number;
}

// The tail of a text, capped in every direction: each line, the number of lines, the
// characters altogether. The TAIL, because the end of a command's output is what a
// person looks for. Applied where the text is COLLECTED, so a session stays bounded.
export function capConsoleText(raw: string): string {
  const lines = sanitizeViewText(raw).replace(/\n+$/, '').split('\n')
    .map((l) => (l.length > VIEW_CAPS.lineChars ? `${l.slice(0, VIEW_CAPS.lineChars)}…` : l));
  const kept = lines.length > VIEW_CAPS.lines ? lines.slice(-VIEW_CAPS.lines) : lines;
  const text = kept.join('\n');
  return text.length > VIEW_CAPS.chars ? text.slice(-VIEW_CAPS.chars) : text;
}

// How many lines a text has, counted as `capConsoleText` counts them, when that is
// more than a view keeps — else undefined.
function cutLines(raw: string): number | undefined {
  const n = sanitizeViewText(raw).replace(/\n+$/, '').split('\n').length;
  return n > VIEW_CAPS.lines ? n : undefined;
}
// The count a view carries: the one it was handed, when it says more than the kept
// text holds (a view capped once already), else the text's own.
function linesOf(raw: string, given: unknown): number | undefined {
  const own = cutLines(raw);
  return typeof given === 'number' && Number.isInteger(given) && given > VIEW_CAPS.lines && given >= (own ?? 0) ? given : own;
}

const oneLine = (s: string, max: number) => {
  const t = sanitizeViewText(s).replace(/\n+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

// The command keeps its own line breaks — a heredoc or a multi-line paste is text
// someone typed too — where every other field here (`cwd`, `status`, `note`, …) is
// flattened to read on one line. `renderConsole`'s folded row still shows it as one
// line: `frameView` flattens a line break inside any span to a space when it draws a
// row, so nothing here has to; the open block draws each line of the command on its
// own row (`renderConsole`, split before wrapping).
const capCommand = (s: string, max: number) => {
  const t = sanitizeViewText(s).trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

// What a tool reports is capped where it is COLLECTED, so a message, a session file
// and the screen are bounded alike — the same rule `consoleData` already applies to a
// confirmed `run_command`, held here so every path that hands over console data (a
// live view's first state, an update, the old one-argument `reportView`) goes through
// it too. Fields are read defensively: a wrong shape yields the empty/absent form of
// each field rather than throwing, and a field this shape does not know is dropped.
export function capConsoleData(raw: unknown): ConsoleData {
  const v = (raw ?? {}) as Partial<ConsoleData>;
  const ms = Number(v.ms);
  return {
    command: capCommand(String(v.command ?? ''), VIEW_CAPS.command),
    cwd: oneLine(String(v.cwd ?? ''), VIEW_CAPS.path),
    text: capConsoleText(String(v.text ?? '')),
    ...(v.exitCode === undefined ? {} : { exitCode: typeof v.exitCode === 'number' ? v.exitCode : null }),
    ...(v.ms === undefined ? {} : Number.isFinite(ms) && ms >= 0 ? { ms } : {}),
    ...(v.status ? { status: oneLine(String(v.status), 80) } : {}),
    ...(v.showCwd === true ? { showCwd: true } : {}),
    ...(v.movedTo ? { movedTo: oneLine(String(v.movedTo), VIEW_CAPS.path) } : {}),
    ...(v.note ? { note: oneLine(String(v.note), 80) } : {}),
    ...(v.interactive === true ? { interactive: true } : {}),
    ...((n) => (n ? { lines: n } : {}))(linesOf(String(v.text ?? ''), v.lines)),
  };
}

// A finished command as the view keeps it. `opts` carries what a `cd` inside the
// command did to the conversation's directory (`!command`'s own — `run_command`'s
// call sites pass neither and stay exactly as they were).
export function consoleData(cmd: string, r: ShellResult, cwd: string, timeoutMs: number, showCwd = false, opts: { movedTo?: string; note?: string; interactive?: boolean } = {}): ConsoleData {
  return {
    command: capCommand(cmd, VIEW_CAPS.command),
    cwd: tildePath(cwd),
    text: capConsoleText(r.output),
    exitCode: r.code,
    ms: r.ms,
    status: shellOutcome(r, timeoutMs),
    ...(showCwd ? { showCwd: true } : {}),
    ...(opts.movedTo ? { movedTo: opts.movedTo } : {}),
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.interactive ? { interactive: true } : {}),
    ...((n) => (n ? { lines: n } : {}))(cutLines(r.output)),
  };
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function consoleTail(d: ConsoleData, ctx: Pick<ViewRenderCtx, 'live' | 'failed' | 'elapsedMs'>): ViewSpan[] {
  if (ctx.failed) return [{ text: '✗ failed', color: 'warn' }];
  if (ctx.live) return [{ text: `${Math.floor(ctx.elapsedMs / 1000)} s`, dim: true }];
  const ms = Number(d.ms ?? 0);
  const status = String(d.status ?? '');
  // Where it ran — and, for the person's own command (showCwd), where a `cd` inside
  // it left the directory, or that one tried to leave the roots and stayed. Never
  // drawn for a tool's run_command view, which never sets showCwd.
  const where: ViewSpan[] = [];
  if (d.showCwd && d.cwd) {
    const moved = !!d.movedTo && d.movedTo !== d.cwd;
    where.push({ text: ` · ${d.cwd}${moved ? ` → ${d.movedTo}` : ''}`, dim: true });
  }
  if (d.showCwd && d.note) where.push({ text: ' · cd led outside the roots — stayed', dim: true });
  if (d.exitCode === 0) return [{ text: '✓', color: 'ok' }, { text: ` ${secs(ms)}`, dim: true }, ...where];
  if (typeof d.exitCode === 'number') return [{ text: `✗ exit ${d.exitCode}`, color: 'warn' }, { text: ` · ${secs(ms)}`, dim: true }, ...where];
  const word = status.startsWith('stopped') ? 'stopped' : status.startsWith('timed out') ? 'timed out' : status || 'no exit code';
  return [{ text: word, color: 'warn' }, { text: ` · ${secs(ms)}`, dim: true }, ...where];
}

const INTERACTIVE_LABEL = ' · interactive';

export const renderConsole: ViewRenderer = (raw, ctx) => {
  const d = (raw ?? {}) as ConsoleData;
  const command = String(d.command ?? '');
  const tail = consoleTail(d, ctx);
  const marker: ViewSpan[] = d.interactive ? [{ text: INTERACTIVE_LABEL, dim: true }] : [];
  const all = d.text ? String(d.text).split('\n') : [];
  if (ctx.folded) {
    // A folded row is ONE line: a multi-line command (its own line breaks kept in
    // the open block below) reads here as `frameView` would flatten it anyway, but
    // flattened here first so the width this reserves for it matches what is drawn.
    const foldedCommand = command.replace(/\n+/g, ' ');
    const total = typeof d.lines === 'number' && d.lines > all.length ? d.lines : 0;
    const size: ViewSpan[] = total
      ? [{ text: ` · last ${all.length} of ${total} lines`, dim: true }]
      : all.length > Math.max(1, ctx.lines) ? [{ text: ` · ${all.length} lines`, dim: true }] : [];
    // What does not fit is cut, but the duration and the
    // outcome are news every time, so they are reserved first and the COMMAND gives
    // up its room, not them. Only the OUTCOME itself (its icon/word and, unless the
    // tail ended there already, its duration) is reserved — a person's own
    // `!command` also appends where it ran (`showCwd`), which is a bonus and may be
    // the one thing cut instead when a long directory would otherwise squeeze the
    // command down to nothing.
    const outcome = tail.slice(0, ctx.failed || ctx.live ? 1 : 2);
    const rest = [...marker, { text: ' · ' }, ...outcome];
    const restWidth = rest.reduce((w, s) => w + cellWidth(String(s.text ?? '')), 0);
    const cmd = cutStep(foldedCommand, ctx.width - restWidth);
    return [[{ text: cmd }, ...marker, { text: ' · ', dim: true }, ...tail, ...size]];
  }
  const max = Math.max(1, ctx.lines);
  const cutN = all.length > max ? all.length - max : 0;
  const bar: ViewSpan = { text: '│ ', chrome: true, dim: true };
  // The command is kept WHOLE in the RECORD, never cut with an ellipsis: it is
  // wrapped across its own rows. But those rows are DISPLAY only and share the
  // block's `VIEW_CAPS.rows` budget with the output and the outcome — so a 16 KiB
  // command wrapped at a narrow width is itself capped at `VIEW_CAPS.commandRows`,
  // past which it shows a dim `… N more lines of the command` row instead of
  // growing further; the journal and `/export` still write the command whole. The
  // interactive label rides the command's own last drawn row when there is room for
  // it there and nothing was cut, or gets a row of its own otherwise. A multi-line
  // command (a heredoc, a paste) keeps its own line breaks: each of its lines is
  // wrapped on its own, as `typedLines` wraps the person's own field text, rather
  // than joined into one span a line break inside would flatten to a space.
  const cmdRows = command.split('\n').flatMap((line) => wrapCells(line, ctx.width));
  const cmdCutN = cmdRows.length > VIEW_CAPS.commandRows ? cmdRows.length - VIEW_CAPS.commandRows : 0;
  const shownCmdRows = cmdCutN ? cmdRows.slice(0, VIEW_CAPS.commandRows) : cmdRows;
  const lastRow = shownCmdRows[shownCmdRows.length - 1]!;
  const markerFits = marker.length > 0 && !cmdCutN && cellWidth(INTERACTIVE_LABEL) <= ctx.width - cellWidth(lastRow);
  const head: ViewLine[] = shownCmdRows.map((line, i): ViewLine =>
    i === shownCmdRows.length - 1 && markerFits ? [{ text: line }, ...marker] : [{ text: line }]);
  if (cmdCutN) head.push([{ text: `… ${cmdCutN} more line${cmdCutN === 1 ? '' : 's'} of the command`, dim: true }]);
  if (marker.length > 0 && !markerFits) head.push([{ text: INTERACTIVE_LABEL.trimStart(), dim: true }]);
  const body: ViewLine[] = [
    ...(cutN ? [[bar, { text: `… ${cutN} line${cutN === 1 ? '' : 's'} cut${ctx.moreKey ? ` · ${ctx.moreKey} for all` : ''}`, dim: true }]] : []),
    ...(cutN ? all.slice(-max) : all).map((l): ViewLine => [bar, { text: l }]),
  ];
  return [...head, ...body, tail];
};
