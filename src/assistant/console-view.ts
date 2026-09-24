// The host's own view renderer: a shell command and what it printed. Registered as
// `console` exactly as a plugin's renderer is (src/loader/registry.ts) — the host has
// no drawing path of its own. `run_command` and the person's `!command` both use it,
// and so does an interactive `!!command` (./interactive.ts), marked `interactive`.
//
// Folded, a command is ONE line: `bun test · ✓ 4.2 s` (the `$ ` is the gutter's).
// Open, it is the command, the last `ctx.lines` lines of output under a bar a drag
// never copies, and the same tail. The tail says how it ended in words a person reads
// without decoding: ✓, ✗ with the code (1 and 127 mean different things), stopped,
// timed out, or ✗ failed — the tool threw, or a restart found this block still live
// (the process ended mid-command, so its own true ending was never recorded).
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

const oneLine = (s: string, max: number) => {
  const t = sanitizeViewText(s).replace(/\n+/g, ' ').trim();
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
    command: oneLine(String(v.command ?? ''), VIEW_CAPS.command),
    cwd: oneLine(String(v.cwd ?? ''), VIEW_CAPS.command),
    text: capConsoleText(String(v.text ?? '')),
    ...(v.exitCode === undefined ? {} : { exitCode: typeof v.exitCode === 'number' ? v.exitCode : null }),
    ...(v.ms === undefined ? {} : Number.isFinite(ms) && ms >= 0 ? { ms } : {}),
    ...(v.status ? { status: oneLine(String(v.status), 80) } : {}),
    ...(v.showCwd === true ? { showCwd: true } : {}),
    ...(v.movedTo ? { movedTo: oneLine(String(v.movedTo), VIEW_CAPS.command) } : {}),
    ...(v.note ? { note: oneLine(String(v.note), 80) } : {}),
    ...(v.interactive === true ? { interactive: true } : {}),
  };
}

// A finished command as the view keeps it. `opts` carries what a `cd` inside the
// command did to the conversation's directory (`!command`'s own — `run_command`'s
// call sites pass neither and stay exactly as they were).
export function consoleData(cmd: string, r: ShellResult, cwd: string, timeoutMs: number, showCwd = false, opts: { movedTo?: string; note?: string; interactive?: boolean } = {}): ConsoleData {
  return {
    command: oneLine(cmd, VIEW_CAPS.command),
    cwd: tildePath(cwd),
    text: capConsoleText(r.output),
    exitCode: r.code,
    ms: r.ms,
    status: shellOutcome(r, timeoutMs),
    ...(showCwd ? { showCwd: true } : {}),
    ...(opts.movedTo ? { movedTo: opts.movedTo } : {}),
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.interactive ? { interactive: true } : {}),
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

export const renderConsole: ViewRenderer = (raw, ctx) => {
  const d = (raw ?? {}) as ConsoleData;
  const command = String(d.command ?? '');
  const tail = consoleTail(d, ctx);
  const head: ViewLine = [{ text: command }, ...(d.interactive ? [{ text: ' · interactive', dim: true }] : [])];
  if (ctx.folded) return [[...head, { text: ' · ', dim: true }, ...tail]];
  const all = d.text ? String(d.text).split('\n') : [];
  const max = Math.max(1, ctx.lines);
  const cutN = all.length > max ? all.length - max : 0;
  const bar: ViewSpan = { text: '│ ', chrome: true, dim: true };
  const body: ViewLine[] = [
    ...(cutN ? [[bar, { text: `… ${cutN} line${cutN === 1 ? '' : 's'} cut${ctx.moreKey ? ` · ${ctx.moreKey} for all` : ''}`, dim: true }]] : []),
    ...(cutN ? all.slice(-max) : all).map((l): ViewLine => [bar, { text: l }]),
  ];
  return [head, ...body, tail];
};
