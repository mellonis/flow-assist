// `!!command` — the person runs an INTERACTIVE program from the chat: a TUI, a prompt,
// `git add -p`, a login flow. `!command` (./shell.ts) captures a command's output
// through pipes, so anything that needs the terminal cannot run there.
//
// The chat hands the terminal over (flowtty's `suspend`, reached as
// `services.suspend`), and the program runs under `script`, which gives it a real
// terminal of its own while recording what it printed into a file. On return the
// recording is read, cleaned (`cleanRecording`) and capped, the file is removed
// whatever happened, and the chat shows the result as the command's console view and
// hands it to the model. Nothing the model writes reaches this path — like
// `!command`, it is the person's own, typed into the field.
//
// Where `script` is not on PATH the program still runs with the terminal, through the
// same shell `!` uses, and nothing is recorded.
//
// Everything that touches the machine — which `script` there is, the process, the
// signals — is injectable (`InteractiveDeps`): a test has no terminal to hand over.

import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ShellResult } from './shell.js';
import { sanitizeViewText } from './views.js';
import { withPwdTrailer } from './shell.js';

// What the model is asked once an interactive run is recorded. It goes as the
// person's message (the host's, and drawn as such), after the recording.
export const INTERACTIVE_ASK = 'Look at what the interactive command above printed: what happened, whether anything went wrong, and what to do next.';

// ── `script` ─────────────────────────────────────────────────────────────────
// Two families: BSD / macOS (`script [-q] file command…`, the child's own status as
// its exit code) and util-linux (`script [-q] [-e] -c "command" file`, where the
// command is ONE string its shell runs and `-e` returns the child's status).
export type ScriptFlavor = 'bsd' | 'util-linux';

export function flavorFrom(onPath: boolean, versionOutput: string): ScriptFlavor | null {
  if (!onPath) return null;
  return /util-linux/i.test(versionOutput) ? 'util-linux' : 'bsd';
}

let detected: ScriptFlavor | null | undefined;
// Which `script` this machine has, asked once per process (never at import): whether
// it is on PATH, then what `--version` says — util-linux answers with its name, BSD's
// refuses the option with its usage on stderr.
export function detectScript(): ScriptFlavor | null {
  if (detected !== undefined) return detected;
  const which = spawnSync('/bin/sh', ['-c', 'command -v script'], { encoding: 'utf8', timeout: 2000 });
  const onPath = which.status === 0 && !!String(which.stdout ?? '').trim();
  const version = onPath ? spawnSync('script', ['--version'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'] }) : null;
  detected = flavorFrom(onPath, version ? `${version.stdout ?? ''}${version.stderr ?? ''}` : '');
  return detected;
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// The `script` invocation that runs `body` through `shell -c` and records into `file`.
export function scriptCommand(flavor: ScriptFlavor, body: string, file: string, shell = '/bin/sh'): { file: string; args: string[] } {
  if (flavor === 'bsd') return { file: 'script', args: ['-q', file, shell, '-c', body] };
  return { file: 'script', args: ['-q', '-e', '-c', `${shell} -c ${shQuote(body)}`, file] };
}

// ── The recording ────────────────────────────────────────────────────────────
// What the program drew, as a terminal would have left it, line by line: a carriage
// return goes back to the start of the line and what follows overwrites it (a
// progress bar ends in its last state), a backspace moves back without erasing,
// `ESC[K` erases, `ESC[nG` moves to a column. Every other sequence — colours, cursor
// shows and hides, a title — is taken out. What moves between lines (a full-screen
// program's cursor addressing) is not followed: such a program's recording is its
// text in the order it was written.
const TOKEN = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B\[([0-?]*)[ -/]*([@-~])|\u001B[()*+][\s\S]?|\u001B[@-Z\\-_]|[\s\S]/gu;

export function cleanRecording(raw: string): string {
  const text = String(raw ?? '')
    .replace(/^Script started on [^\n]*\n/, '')
    .replace(/\n?Script done on [^\n]*\n?$/, '');
  const lines: string[][] = [];
  let line: string[] = [];
  let col = 0;
  const num = (p: string | undefined, d: number) => { const n = parseInt(String(p ?? ''), 10); return Number.isFinite(n) ? n : d; };
  for (const m of text.matchAll(TOKEN)) {
    const t = m[0];
    if (t.length > 1 && t.startsWith('\u001B')) {
      if (m[2] === 'K') {
        const mode = num(m[1], 0);
        if (mode === 2) line = [];
        else if (mode === 1) for (let i = 0; i <= col && i < line.length; i++) line[i] = ' ';
        else line.length = Math.min(line.length, col);
      } else if (m[2] === 'G') col = Math.max(0, num(m[1], 1) - 1);
      else if (m[2] === 'C') col += Math.max(1, num(m[1], 1));
      else if (m[2] === 'D') col = Math.max(0, col - Math.max(1, num(m[1], 1)));
      continue;
    }
    if (t === '\n') { lines.push(line); line = []; col = 0; continue; }
    if (t === '\r') { col = 0; continue; }
    if (t === '\b') { col = Math.max(0, col - 1); continue; }
    if (t === '\t') { const next = (Math.floor(col / 8) + 1) * 8; while (line.length < next) line.push(' '); col = next; continue; }
    if (/[\u0000-\u001F\u007F-\u009F]/.test(t)) continue;
    while (line.length < col) line.push(' ');
    line[col] = t;
    col++;
  }
  lines.push(line);
  const out = lines.map((l) => l.join('').replace(/\s+$/, ''));
  while (out.length && out.at(-1) === '') out.pop();
  return sanitizeViewText(out.join('\n'));
}

// ── Signals ──────────────────────────────────────────────────────────────────
// While the program has the terminal, Ctrl+C and Ctrl+\ are ITS keys. A terminal in
// its normal mode turns them into SIGINT / SIGQUIT for the whole foreground process
// group — this process too (`script` switches its own terminal to raw and passes the
// key on, but without `script` nothing does). flowtty unmounts the app on SIGINT
// whatever else listens, and SIGQUIT has no listener at all, so either would end the
// app. So, as a shell does for the job in front: a no-op listener goes on first (with
// one there the process is not ended), the others are taken off, and afterwards they
// are put back in their order and the no-op removed.
export interface SignalTarget {
  on(event: string, fn: (...a: any[]) => void): unknown;
  removeListener(event: string, fn: (...a: any[]) => void): unknown;
  rawListeners(event: string): Function[];
}
const HELD_SIGNALS = ['SIGINT', 'SIGQUIT'] as const;

export async function holdSignals<T>(target: SignalTarget, fn: () => Promise<T>): Promise<T> {
  const noop = () => {};
  const stash = new Map<string, Function[]>();
  for (const sig of HELD_SIGNALS) {
    target.on(sig, noop);
    const others = target.rawListeners(sig).filter((l) => l !== noop);
    stash.set(sig, others);
    for (const l of others) target.removeListener(sig, l as () => void);
  }
  try {
    return await fn();
  } finally {
    for (const sig of HELD_SIGNALS) {
      for (const l of stash.get(sig) ?? []) target.on(sig, l as () => void);
      target.removeListener(sig, noop);
    }
  }
}

// ── The run ──────────────────────────────────────────────────────────────────
export interface SpawnOutcome { code: number | null; signal: string | null; error?: string }
// Runs `file args` with the terminal (stdio inherited) and resolves when it exits.
// It stays in this process's group — the terminal's foreground group — or its first
// read of the terminal would stop it (SIGTTIN). No time limit: the person is at it.
export type InteractiveSpawn = (file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<SpawnOutcome>;

export const spawnWithTerminal: InteractiveSpawn = (file, args, { cwd, env }) => new Promise((resolve) => {
  let done = false;
  const end = (o: SpawnOutcome) => { if (!done) { done = true; resolve(o); } };
  try {
    const child = nodeSpawn(file, args, { cwd, env, stdio: 'inherit' });
    child.on('error', (e) => end({ code: null, signal: null, error: e.message }));
    child.on('exit', (code, signal) => end({ code, signal }));
  } catch (e) {
    end({ code: null, signal: null, error: (e as Error).message });
  }
});

export interface InteractiveDeps {
  detect?: () => ScriptFlavor | null;
  spawn?: InteractiveSpawn;
  signals?: SignalTarget;
}
export interface InteractiveOptions {
  cwd: string;
  // Hands the terminal over for the duration of `fn` (flowtty's `suspend`).
  suspend: <T>(fn: () => T | Promise<T>) => Promise<T>;
  maxChars: number; // how much of the recording's END the model is given (shell.maxChars)
}
export interface InteractiveRun { recorded: boolean; result: ShellResult }

export async function runInteractive(cmd: string, opts: InteractiveOptions, deps: InteractiveDeps = {}): Promise<InteractiveRun> {
  const flavor = (deps.detect ?? detectScript)();
  const spawnFn = deps.spawn ?? spawnWithTerminal;
  const signals = deps.signals ?? (process as unknown as SignalTarget);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-tty-'));
  const recording = path.join(dir, 'recording');
  const pwdFile = path.join(dir, 'pwd');
  try {
    // The environment is the person's own, untouched: `!`'s PAGER=cat and
    // GIT_TERMINAL_PROMPT=0 exist because nobody can answer a prompt there, and here
    // somebody is.
    const body = withPwdTrailer(cmd, pwdFile);
    const run = flavor ? scriptCommand(flavor, body, recording) : { file: '/bin/sh', args: ['-c', body] };
    const t0 = Date.now();
    const outcome = await opts.suspend(() => holdSignals(signals, () => spawnFn(run.file, run.args, { cwd: opts.cwd, env: process.env })));
    const ms = Date.now() - t0;
    let raw = '';
    if (flavor) { try { raw = fs.readFileSync(recording, 'utf8'); } catch { /* nothing was recorded */ } }
    const text = cleanRecording(raw);
    const cut = Math.max(0, text.length - opts.maxChars);
    let pwd = '';
    try { pwd = fs.readFileSync(pwdFile, 'utf8').trim(); } catch { /* ended before the trailer */ }
    const result: ShellResult = {
      code: outcome.signal ? null : outcome.code,
      output: cut ? text.slice(-opts.maxChars) : text,
      cut,
      timedOut: false,
      stopped: false,
      ms,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.signal ? { signal: outcome.signal } : {}),
      ...(pwd ? { pwd } : {}),
    };
    return { recorded: !!flavor && !outcome.error, result };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a temp dir */ }
  }
}
