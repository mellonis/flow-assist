// A background shell: a command that runs on while the conversation goes on. `ShellJob`
// is one such command; `ShellJobs` is the host's registry of them — the one counter that
// names them (`sh-1`, `sh-2`, …), the limit on how many run at once, and the small state
// file that lets the next start notice the ones a crash left behind.
//
// A job is started like a shell command is (./shell.ts): through `/bin/sh -c`, in a
// process group of its own, with its stdin closed and the same environment guards. It is
// not run by `runShell`: that runner ends a command's group 200 ms after the shell exits,
// which is right for a command whose result is waited for and wrong for a server. A job
// ends when its pipes close — a program it left running with `&` holds them — and is
// ended by `kill`: SIGTERM to the group, SIGKILL two seconds later. At the host's exit
// `killNow` sends SIGKILL at once (a synchronous exit has no time to wait), after the
// job's end has been announced to its listeners, so the journal's end line comes first.
//
// Its output (stdout and stderr in the order they arrived, secrets taken out before
// anything sees them) is kept in a ring buffer of `shell.jobChars` characters. A reader
// holds a cursor — the count of characters printed so far — and `read(since)` returns
// what came after it and how many were dropped from under it, so nothing is lost
// silently. An ended job keeps its record and buffer; whoever holds it decides how long
// (a conversation keeps the last twenty).
//
// Which conversation owns a job, what its journal says and when the model hears of its
// end belong to the callers (./conversation.ts, and the tools that start and read jobs).

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { formatDuration } from './duration.js';
import { secretStream } from './secrets.js';
import { commandEnv } from './shell.js';

export const JOB_DEFAULTS = { maxBackground: 4, jobChars: 64_000 };
// After a `kill`, how long the group has to end on SIGTERM before it is sent SIGKILL.
export const JOB_KILL_GRACE_MS = 2000;
// How many ended jobs a conversation keeps (record and buffer).
export const MAX_ENDED_JOBS = 20;
// The most matching lines one `grep` returns.
export const GREP_LINES = 100;
// How long the model's `run_command({ background: true })` waits before it answers: a
// command that ends within it is an ordinary foreground result and leaves no job.
export const BACKGROUND_SETTLE_MS = 2000;

// `shell.maxBackground` / `shell.jobChars`, a bad value falling back to the default. Read
// when a job starts: a lowered limit does not end the jobs that run.
export function jobLimits(config: { shell?: unknown } | undefined): { maxBackground: number; jobChars: number } {
  const s = (config?.shell ?? {}) as { maxBackground?: unknown; jobChars?: unknown };
  const pos = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : d);
  return { maxBackground: pos(s.maxBackground, JOB_DEFAULTS.maxBackground), jobChars: pos(s.jobChars, JOB_DEFAULTS.jobChars) };
}

// Who started the job, and who ended it. A job that ends by itself is `exited`; one that
// was ended from outside is `killed` — by the person, by the model's tool, with its
// conversation (`clear`), with the subagent that owned it (`parent`), with the process
// (`exit`), or by a signal nobody here sent.
export type JobStarter = 'model' | 'person';
export type JobKilledBy = 'person' | 'model' | 'clear' | 'exit' | 'parent' | 'signal';
export type JobStatus =
  | { state: 'running' }
  | { state: 'exited'; code: number | null }
  | { state: 'killed'; by: JobKilledBy };

export interface JobRead {
  text: string;      // what came after the cursor, up to `max` characters
  from: number;      // the position of its first character
  next: number;      // the cursor to read from next time
  dropped: number;   // characters between the cursor given and `from` that the buffer no longer holds
}

export interface JobSpec {
  command: string;
  cwd: string;
  by: JobStarter;
  // The environment the command starts from; absent — the process's whole one. The model's
  // jobs pass it without the secrets (`withheldEnv`, ./secrets.ts).
  env?: Record<string, string | undefined>;
}

export class ShellJob {
  readonly command: string;
  readonly cwd: string;
  readonly by: JobStarter;
  readonly startedAt = Date.now();
  readonly pid: number | undefined;
  // The conversation that owns it, set by the one that started it (opaque here).
  owner: object | null = null;
  // The cursor up to which the model has been shown the output: what `run_command` returned
  // and what its reads returned since. The model's next plain read starts there.
  told = 0;
  endedAt: number | null = null;
  // Set when the shell could not be started.
  error: string | undefined;
  private state: JobStatus = { state: 'running' };
  private buf = '';
  // The position of `buf[0]` in everything the job printed.
  private base = 0;
  private newlines = 0;
  // Whether the buffer starts at the start of a line (the character before it, if any, was
  // a newline); false after the ring buffer has cut a line in two.
  private baseAtLine = true;
  private lastChar = '';
  private killedBy: JobKilledBy | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private reapTimer: ReturnType<typeof setTimeout> | null = null;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private readonly child: ChildProcess;
  private readonly outputs = new Set<(chunk: string) => void>();
  private readonly ends = new Set<(job: ShellJob) => void>();
  private readonly secrets = [secretStream(), secretStream()];

  constructor(readonly id: string, spec: JobSpec, private readonly chars: number, private readonly graceMs = JOB_KILL_GRACE_MS) {
    this.command = spec.command;
    this.cwd = spec.cwd;
    this.by = spec.by;
    this.child = spawn('/bin/sh', ['-c', spec.command], {
      cwd: spec.cwd,
      detached: true, // its own process group: `kill(-pid)` reaches everything it started
      stdio: ['ignore', 'pipe', 'pipe'],
      env: commandEnv(spec.env),
    });
    this.pid = this.child.pid;
    this.child.stdout!.setEncoding('utf8').on('data', (c: string) => this.take(this.secrets[0]!.push(c)));
    this.child.stderr!.setEncoding('utf8').on('data', (c: string) => this.take(this.secrets[1]!.push(c)));
    this.child.on('error', (e) => { this.error = e.message; this.finish({ state: 'exited', code: 127 }); });
    this.child.on('exit', (code, signal) => { this.exitCode = code; this.exitSignal = signal; });
    // `close` comes after every pipe has drained, so the tail is not lost.
    this.child.on('close', (code, signal) => {
      this.exitCode = code ?? this.exitCode;
      this.exitSignal = signal ?? this.exitSignal;
      if (this.killedBy) this.finish({ state: 'killed', by: this.killedBy });
      else if (this.exitSignal) this.finish({ state: 'killed', by: 'signal' });
      else this.finish({ state: 'exited', code: this.exitCode });
    });
  }

  get status(): JobStatus { return this.state; }
  get running(): boolean { return this.state.state === 'running'; }
  // A kill was asked for and the job has not ended yet.
  get killing(): boolean { return this.running && this.killedBy !== null; }
  // The status in words: `running`, `exited 0`, `killed (person)`.
  get statusText(): string {
    const s = this.state;
    return s.state === 'running' ? (this.killing ? 'stopping' : 'running') : s.state === 'exited' ? (s.code == null ? 'exited' : `exited ${s.code}`) : `killed (${s.by})`;
  }
  // How long it has run, or ran.
  get ms(): number { return (this.endedAt ?? Date.now()) - this.startedAt; }
  // Everything it printed, in characters, the dropped ones included: the cursor at the end.
  get total(): number { return this.base + this.buf.length; }
  // How many lines it has printed (a last line still being written counts).
  get lines(): number { return this.newlines + (this.total > 0 && this.lastChar !== '\n' ? 1 : 0); }
  // Characters the ring buffer has let go from the start.
  get droppedChars(): number { return this.base; }

  // What came after the cursor `since` (0 — from the start), at most `max` characters
  // from it. A cursor behind the buffer reads from the buffer's start and says how much
  // was lost; one past the end reads nothing.
  read(since = 0, max?: number): JobRead {
    const cursor = Math.min(Math.max(0, Math.floor(since)), this.total);
    const from = Math.max(cursor, this.base);
    let text = this.buf.slice(from - this.base);
    if (max !== undefined && max >= 0 && text.length > max) text = text.slice(0, max);
    return { text, from, next: from + text.length, dropped: from - cursor };
  }
  // The last `n` lines the buffer holds.
  tail(n: number): JobRead {
    if (!(n >= 1) || !this.buf) return { text: '', from: this.total, next: this.total, dropped: 0 };
    const lines = this.buf.replace(/\n$/, '').split('\n');
    const take = lines.slice(-Math.floor(n));
    const text = take.join('\n') + (this.buf.endsWith('\n') ? '\n' : '');
    return { text, from: this.total - text.length, next: this.total, dropped: 0 };
  }
  // The lines after the cursor that contain `literal` (not a pattern; case-sensitive),
  // in order, at most GREP_LINES of them, and the cursor to read from next. `more` counts
  // the matching lines past the cap. The cursor stops after the last complete line, so a
  // line still being written is read whole next time (an ended job's last line counts as
  // complete); after a drop the fragment the buffer starts in is skipped. An empty
  // literal matches nothing.
  grep(literal: string, since = 0): { lines: string[]; next: number; dropped: number; more: number } {
    const r = this.read(since);
    let text = r.text;
    let start = r.from;
    // The buffer's first line may be the tail of one the ring buffer cut: it is skipped,
    // however the cursor got here (a drop under it, or a read that stopped at the start).
    if (r.from === this.base && !this.baseAtLine) {
      const nl = text.indexOf('\n');
      if (nl < 0) return { lines: [], next: r.from + (this.running ? 0 : text.length), dropped: r.dropped, more: 0 };
      start += nl + 1;
      text = text.slice(nl + 1);
    }
    const complete = this.running ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
    if (!literal) return { lines: [], next: start + complete.length, dropped: r.dropped, more: 0 };
    const lines: string[] = [];
    let more = 0;
    let used = 0;
    let next = start + complete.length;
    for (const line of complete.split('\n')) {
      if (lines.length < GREP_LINES) { used += line.length + 1; if (line.includes(literal)) lines.push(line); if (lines.length === GREP_LINES) next = Math.min(next, start + used); }
      else if (line.includes(literal)) more++;
    }
    return { lines, next, dropped: r.dropped, more };
  }

  // Waits until the job has ended or `ms` has passed, or the signal aborts: true when it
  // ended. An abort ends the wait, never the job.
  wait(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (!this.running) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ended: boolean) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); off(); resolve(ended); };
      const timer = setTimeout(() => done(!this.running), ms);
      const onAbort = () => done(!this.running);
      const off = this.onEnd(() => done(true));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  // Every chunk as it is taken in, secrets already out. Returns what removes the listener.
  onOutput(fn: (chunk: string) => void): () => void {
    this.outputs.add(fn);
    return () => { this.outputs.delete(fn); };
  }
  // Called once, when the job ends; at once when it already has. Returns what removes it.
  onEnd(fn: (job: ShellJob) => void): () => void {
    if (!this.running) { try { fn(this); } catch { /* a listener never breaks the job */ } return () => {}; }
    this.ends.add(fn);
    return () => { this.ends.delete(fn); };
  }

  // Ends the job's group: SIGTERM now, SIGKILL after `JOB_KILL_GRACE_MS`. The job ends
  // (and its listeners hear it) when the pipes close. false when it is ending already.
  kill(by: JobKilledBy): boolean {
    if (!this.running || this.killedBy) return false;
    this.killedBy = by;
    this.signalGroup('SIGTERM');
    this.killTimer = setTimeout(() => { this.killTimer = null; this.signalGroup('SIGKILL'); this.reapAfterKill(); }, this.graceMs);
    this.killTimer.unref?.();
    return true;
  }
  // After SIGKILL the job ends when its pipes close — but a process that left the group
  // (a daemon that called setsid) can hold them for good. Once the shell is reaped, the
  // pipes are closed from here and the job ends as killed: a kill always ends the job.
  private reapAfterKill(): void {
    if (!this.running) return;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.reapTimer = setTimeout(() => this.reapAfterKill(), 100);
      this.reapTimer.unref?.();
      return;
    }
    this.reapTimer = setTimeout(() => {
      this.reapTimer = null;
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();
      this.finish({ state: 'killed', by: this.killedBy ?? 'signal' });
    }, 200);
    this.reapTimer.unref?.();
  }
  // For a host that is exiting: the job's end is announced first, then the group gets
  // SIGKILL — all synchronous.
  killNow(by: JobKilledBy): void {
    if (!this.running) return;
    this.killedBy ??= by;
    this.finish({ state: 'killed', by: this.killedBy });
  }

  private signalGroup(sig: NodeJS.Signals): void {
    if (this.pid == null) return;
    try { process.kill(-this.pid, sig); return; } catch { /* the group is gone, or not made yet */ }
    // Just after the spawn the child may not have become its group's leader yet: the shell
    // itself is signalled then, as long as it has not been reaped (its pid is still its own).
    if (this.child.exitCode === null && this.child.signalCode === null) { try { process.kill(this.pid, sig); } catch { /* gone */ } }
  }
  private take(text: string): void {
    if (!text || this.endedAt !== null) return;
    this.buf += text;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) this.newlines++;
    this.lastChar = text[text.length - 1]!;
    if (this.buf.length > this.chars) {
      const cut = this.buf.length - this.chars;
      this.baseAtLine = this.buf[cut - 1] === '\n';
      this.base += cut;
      this.buf = this.buf.slice(-this.chars);
    }
    for (const fn of [...this.outputs]) { try { fn(text); } catch { /* a listener never breaks the job */ } }
  }
  private finish(status: JobStatus): void {
    if (!this.running) return;
    // What the secret streams held back goes out first, as the last of the output.
    for (const s of this.secrets) this.take(s.flush());
    this.state = status;
    this.endedAt = Date.now();
    if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = null; }
    if (this.reapTimer) { clearTimeout(this.reapTimer); this.reapTimer = null; }
    this.outputs.clear();
    const ends = [...this.ends];
    this.ends.clear();
    for (const fn of ends) { try { fn(this); } catch { /* a listener never breaks the job */ } }
    // After the listeners have heard it: a group the kill left stragglers in does not
    // outlive the job's end (with no group left this reaches nothing), and at an exit
    // this is the SIGKILL itself. The group id is not checked for liveness: a pid reused as a
    // new group leader inside this window (milliseconds, and only after the ids wrap) would be hit.
    if (this.killedBy) this.signalGroup('SIGKILL');
  }
}

// What a running job looks like in a refusal or a listing.
export function jobLine(j: ShellJob): string {
  return `${j.id} · ${j.command.replace(/\s+/g, ' ').slice(0, 80)} · ${j.statusText} ${formatDuration(j.ms)}${j.pid ? ` · pid ${j.pid}` : ''}`;
}

// A job the last run left behind: still alive when this one started.
export interface Leftover { id: string; pgid: number; startedAt: number; command: string }
interface StateEntry extends Leftover { owner: number }

const alive = (pid: number, group = false): boolean => {
  try { process.kill(group ? -pid : pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

// The host's jobs: one counter, one limit, one state file.
export class ShellJobs {
  private seq = 0;
  private readonly live = new Set<ShellJob>();
  private left: Leftover[] = [];

  // `stateFile`: where the running jobs are listed for the next start; null — nowhere.
  constructor(private readonly opts: { config: () => { shell?: unknown } | undefined; stateFile: () => string | null }) {}

  // The running jobs of every conversation, in the order they started.
  list(): ShellJob[] { return [...this.live]; }
  // The running job with this id.
  get(id: string): ShellJob | undefined { return [...this.live].find((j) => j.id === id); }

  // Starts a job, or says why not: `shell.maxBackground` running at once in the whole
  // process (a job already being killed does not count), the refusal listing them.
  start(spec: JobSpec): { job: ShellJob } | { refused: string } {
    const { maxBackground, jobChars } = jobLimits(this.opts.config());
    const counted = [...this.live].filter((j) => !j.killing);
    if (counted.length >= maxBackground) {
      return { refused: `${counted.length} background shells are running — the limit is ${maxBackground} (shell.maxBackground). Wait for one to end or kill one:\n${counted.map((j) => `- ${jobLine(j)}`).join('\n')}` };
    }
    const job = new ShellJob(`sh-${++this.seq}`, spec, jobChars);
    this.live.add(job);
    job.onEnd(() => { this.live.delete(job); this.writeState(); });
    this.writeState();
    return { job };
  }

  // The process exits: every job's end is announced and its group sent SIGKILL, now.
  killAll(by: JobKilledBy): void {
    for (const j of [...this.live]) { try { j.killNow(by); } catch { /* exiting */ } }
  }

  // The jobs listed by a run that is gone and whose process group is still alive, read
  // once at start; they are named, never ended — a pid may have been reused since. Entries
  // of a run that is still alive (another flow-assist) are left alone, dead ones dropped.
  scanLeftovers(): Leftover[] {
    const file = this.opts.stateFile();
    if (!file) return [];
    const entries = this.readState(file);
    const keep: StateEntry[] = [];
    const found: Leftover[] = [];
    for (const e of entries) {
      if (e.owner === process.pid || alive(e.owner)) { keep.push(e); continue; }
      if (alive(e.pgid, true)) found.push({ id: e.id, pgid: e.pgid, startedAt: e.startedAt, command: e.command });
    }
    this.left = found;
    this.save(file, keep);
    return found;
  }
  // The one note for what `scanLeftovers` found, else null.
  leftoverNote(): string | null {
    if (!this.left.length) return null;
    const list = this.left.map((l) => `pid ${l.pgid} (${l.command.replace(/\s+/g, ' ').slice(0, 60)}, started ${new Date(l.startedAt).toISOString().slice(0, 16).replace('T', ' ')})`).join('; ');
    return `${this.left.length} background ${this.left.length === 1 ? 'shell' : 'shells'} from an earlier run still ${this.left.length === 1 ? 'runs' : 'run'}: ${list}. flow-assist does not stop ${this.left.length === 1 ? 'it' : 'them'}.`;
  }

  private readState(file: string): StateEntry[] {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { jobs?: unknown };
      return (Array.isArray(j.jobs) ? j.jobs : []).filter((e): e is StateEntry => !!e && typeof e === 'object'
        && Number.isInteger((e as StateEntry).owner) && Number.isInteger((e as StateEntry).pgid) && typeof (e as StateEntry).command === 'string');
    } catch { return []; }
  }
  private save(file: string, entries: StateEntry[]): void {
    try {
      if (!entries.length) { fs.rmSync(file, { force: true }); return; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ jobs: entries }));
      fs.renameSync(tmp, file);
    } catch { /* a state file is a courtesy */ }
  }
  // The running jobs of this run, over what other live runs listed.
  private writeState(): void {
    const file = this.opts.stateFile();
    if (!file) return;
    const others = this.readState(file).filter((e) => e.owner !== process.pid && alive(e.owner));
    const mine: StateEntry[] = [...this.live].filter((j) => j.pid != null).map((j) => ({ owner: process.pid, id: j.id, pgid: j.pid!, startedAt: j.startedAt, command: j.command }));
    this.save(file, [...others, ...mine]);
  }
}
