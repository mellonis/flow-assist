// The host's own view renderer: a shell command and what it printed. Registered as
// `console` exactly as a plugin's renderer is (src/loader/registry.ts) — the host has
// no drawing path of its own. `run_command` and the person's `!command` both use it.
//
// Folded, a command is ONE line: `bun test · ✓ 4.2 s` (the `$ ` is the gutter's).
// Open, it is the command, the last `ctx.lines` lines of output under a bar a drag
// never copies, and the same tail. The tail says how it ended in words a person reads
// without decoding: ✓, ✗ with the code (1 and 127 mean different things), stopped,
// timed out, or — the tool threw — ✗ failed.
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
  };
}

// A finished command as the view keeps it.
export function consoleData(cmd: string, r: ShellResult, cwd: string, timeoutMs: number, showCwd = false): ConsoleData {
  return {
    command: oneLine(cmd, VIEW_CAPS.command),
    cwd: tildePath(cwd),
    text: capConsoleText(r.output),
    exitCode: r.code,
    ms: r.ms,
    status: shellOutcome(r, timeoutMs),
    ...(showCwd ? { showCwd: true } : {}),
  };
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function consoleTail(d: ConsoleData, ctx: Pick<ViewRenderCtx, 'live' | 'failed' | 'elapsedMs'>): ViewSpan[] {
  if (ctx.failed) return [{ text: '✗ failed', color: 'warn' }];
  if (ctx.live) return [{ text: `${Math.floor(ctx.elapsedMs / 1000)} s`, dim: true }];
  const ms = Number(d.ms ?? 0);
  const status = String(d.status ?? '');
  const where: ViewSpan[] = d.showCwd && d.cwd ? [{ text: ` · ${d.cwd}`, dim: true }] : [];
  if (d.exitCode === 0) return [{ text: '✓', color: 'ok' }, { text: ` ${secs(ms)}`, dim: true }, ...where];
  if (typeof d.exitCode === 'number') return [{ text: `✗ exit ${d.exitCode}`, color: 'warn' }, { text: ` · ${secs(ms)}`, dim: true }, ...where];
  const word = status.startsWith('stopped') ? 'stopped' : status.startsWith('timed out') ? 'timed out' : status || 'no exit code';
  return [{ text: word, color: 'warn' }, { text: ` · ${secs(ms)}`, dim: true }, ...where];
}

export const renderConsole: ViewRenderer = (raw, ctx) => {
  const d = (raw ?? {}) as ConsoleData;
  const command = String(d.command ?? '');
  const tail = consoleTail(d, ctx);
  if (ctx.folded) return [[{ text: command }, { text: ' · ', dim: true }, ...tail]];
  const all = d.text ? String(d.text).split('\n') : [];
  const max = Math.max(1, ctx.lines);
  const cutN = all.length > max ? all.length - max : 0;
  const bar: ViewSpan = { text: '│ ', chrome: true, dim: true };
  const body: ViewLine[] = [
    ...(cutN ? [[bar, { text: `… ${cutN} line${cutN === 1 ? '' : 's'} cut${ctx.moreKey ? ` · ${ctx.moreKey} for all` : ''}`, dim: true }]] : []),
    ...(cutN ? all.slice(-max) : all).map((l): ViewLine => [bar, { text: l }]),
  ];
  return [[{ text: command }], ...body, tail];
};
