// A remote plugin as a child process, spoken to over its stdin and stdout, one
// message per line. The rules are the ones AGENTS.md sets for a plugin that starts a
// process, held here by the host: started without a shell; stderr to the host log;
// unref'd, so a short-lived command exits when its own work is done; stopped with the
// program (`process.on('exit')`, and the termination signals — the handler removes
// itself and re-raises when nobody else listens, so flowtty's own re-raise still
// works); SIGTERM, then SIGKILL after the grace. It follows the rules
// plugins-available/mcp/src/stdio.ts follows, in code of its own — the host imports
// no plugin.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { LineSplitter } from '@flow-assist/remote';
import type { Transport, TransportClose } from './transport.js';

const live = new Set<ChildProcess>();
const TAIL_LINES = 5;
const TAIL_LINE_CHARS = 200;
const STDERR_LATE_MS = 100;
const SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT'] as const;
let hooked = false;

export function stopAllRemote(): void {
  for (const child of live) { try { child.stdin?.destroy(); } catch {} try { child.kill('SIGTERM'); } catch {} }
  live.clear();
}
function hookExit(): void {
  if (hooked) return;
  hooked = true;
  process.on('exit', stopAllRemote);
  for (const sig of SIGNALS) {
    const onSignal = () => { stopAllRemote(); process.removeListener(sig, onSignal); if (process.listenerCount(sig) === 0) process.kill(process.pid, sig); };
    process.on(sig, onSignal);
  }
}

export interface StdioOpts { name: string; command: string[]; cwd: string; env?: Record<string, string>; log: (line: string) => void }

export function stdioTransport(opts: StdioOpts): Transport & { start(): Promise<void>; pid(): number | undefined } {
  const lines: Array<(l: string) => void> = [];
  const closes: Array<(w: TransportClose) => void> = [];
  let child: ChildProcess | undefined;
  let closedWith: TransportClose | undefined;
  let exited = false; // the OS process, specifically — set only by the exit event, so close() never re-arms a kill on a process it has already seen die
  let spawned = false; // a child that failed to start (ENOENT) fires `error`, never `exit` — close() must not wait on an exit that is never coming
  const closeOnce = (why: TransportClose) => { if (closedWith) return; closedWith = why; live.delete(child!); for (const f of closes) f(why); };
  const splitter = new LineSplitter((l) => lines.forEach((f) => f(l)), (n) => opts.log(`[${opts.name}] a line of ${n} bytes was dropped`));
  return {
    pid: () => child?.pid,
    start: () => new Promise<void>((resolve, reject) => {
      hookExit();
      const [cmd, ...args] = opts.command;
      const c = spawn(path.isAbsolute(cmd!) || cmd!.includes('/') ? path.resolve(opts.cwd, cmd!) : cmd!, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] });
      child = c;
      // `.on`, not `.once`: a second error after a successful spawn (a failed kill,
      // say) must still be heard, or it has no listener and crashes the host.
      c.on('error', (e) => { reject(new Error(`${opts.name}: cannot start ${opts.command.join(' ')}: ${e.message}`)); closeOnce({ error: e.message }); });
      c.once('spawn', () => {
        spawned = true;
        live.add(c);
        c.unref();
        for (const s of [c.stdin, c.stdout, c.stderr]) (s as { unref?: () => void } | null)?.unref?.();
        resolve();
      });
      c.stdout!.setEncoding('utf8');
      c.stdout!.on('data', (chunk: string) => splitter.feed(chunk));
      // A write to a child that has just died fails with EPIPE; the exit event says
      // what happened, in better words, so the error is swallowed here.
      c.stdin?.on('error', () => {});
      // Each stderr line goes to the log; the last few are kept for the close, which
      // is what the adapter draws under `plugin stopped` — the words a crash left.
      let err = '';
      const tail: string[] = [];
      const said = (raw: string) => {
        const line = raw.trimEnd();
        if (!line) return;
        opts.log(`[${opts.name}] ${line}`);
        tail.push(line.slice(0, TAIL_LINE_CHARS));
        if (tail.length > TAIL_LINES) tail.shift();
      };
      let stderrEnded = false;
      c.stderr!.setEncoding('utf8');
      c.stderr!.on('data', (chunk: string) => { err += chunk; let nl; while ((nl = err.indexOf('\n')) !== -1) { said(err.slice(0, nl)); err = err.slice(nl + 1); } });
      c.stderr!.once('end', () => { stderrEnded = true; });
      c.once('exit', (code, signal) => {
        exited = true;
        // A last line with no newline is still a line. The pipe usually ends before
        // `exit`; when it has not yet, its last bytes get a moment to arrive.
        const report = () => {
          said(err); err = '';
          const why: TransportClose = signal ? { signal } : { code: code ?? 0 };
          closeOnce(tail.length ? { ...why, stderr: [...tail] } : why);
        };
        if (stderrEnded) { report(); return; }
        const late = setTimeout(report, STDERR_LATE_MS);
        c.stderr!.once('end', () => { clearTimeout(late); report(); });
      });
    }),
    send: (line) => { if (closedWith || !child?.stdin?.writable) return; try { child.stdin.write(`${line}\n`); } catch {} },
    onLine: (f) => { lines.push(f); },
    onClose: (f) => { closes.push(f); },
    close: async (graceMs) => {
      if (!child || exited || !spawned) return;
      const c = child;
      const done = new Promise<void>((r) => c.once('exit', () => r()));
      // One timer handle, whichever stage is current: cleared unconditionally on
      // exit, so a child that ends on its own, or from SIGTERM, never leaves a
      // SIGKILL armed against a process that is already gone (mcp's own model).
      let timer: ReturnType<typeof setTimeout> | undefined;
      c.once('exit', () => clearTimeout(timer));
      try { c.stdin?.end(); } catch {}
      timer = setTimeout(() => {
        try { c.kill('SIGTERM'); } catch {}
        timer = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, Math.max(100, graceMs / 2));
      }, Math.max(0, graceMs / 2));
      await done;
    },
  };
}
