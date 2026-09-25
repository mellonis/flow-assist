// A remote plugin as a child process, spoken to over its stdin and stdout, one
// message per line. The rules are the ones AGENTS.md sets for a plugin that starts a
// process, held here by the host: started without a shell; stderr to the host log;
// unref'd, so a short-lived command exits when its own work is done; stopped with the
// program (`process.on('exit')`, and the termination signals — the handler removes
// itself and re-raises when nobody else listens, so flowtty's own re-raise still
// works); SIGTERM, then SIGKILL after the grace. The same logic as
// plugins-available/mcp/src/stdio.ts — a copy, since the host imports no plugin.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { LineSplitter } from '@flow-assist/remote';
import type { Transport, TransportClose } from './transport.js';

const live = new Set<ChildProcess>();
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
  const closeOnce = (why: TransportClose) => { if (closedWith) return; closedWith = why; live.delete(child!); for (const f of closes) f(why); };
  const splitter = new LineSplitter((l) => lines.forEach((f) => f(l)), (n) => opts.log(`[${opts.name}] a line of ${n} bytes was dropped`));
  return {
    pid: () => child?.pid,
    start: () => new Promise<void>((resolve, reject) => {
      hookExit();
      const [cmd, ...args] = opts.command;
      const c = spawn(path.isAbsolute(cmd!) || cmd!.includes('/') ? path.resolve(opts.cwd, cmd!) : cmd!, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] });
      child = c;
      c.once('error', (e) => { reject(new Error(`${opts.name}: cannot start ${opts.command.join(' ')}: ${e.message}`)); closeOnce({ error: e.message }); });
      c.once('spawn', () => {
        live.add(c);
        c.unref();
        for (const s of [c.stdin, c.stdout, c.stderr]) (s as { unref?: () => void } | null)?.unref?.();
        resolve();
      });
      c.stdout!.setEncoding('utf8');
      c.stdout!.on('data', (chunk: string) => splitter.feed(chunk));
      let err = '';
      c.stderr!.setEncoding('utf8');
      c.stderr!.on('data', (chunk: string) => { err += chunk; let nl; while ((nl = err.indexOf('\n')) !== -1) { const line = err.slice(0, nl).trimEnd(); err = err.slice(nl + 1); if (line) opts.log(`[${opts.name}] ${line}`); } });
      c.once('exit', (code, signal) => closeOnce(signal ? { signal } : { code: code ?? 0 }));
    }),
    send: (line) => { if (!closedWith && child?.stdin?.writable) child.stdin.write(`${line}\n`); },
    onLine: (f) => { lines.push(f); },
    onClose: (f) => { closes.push(f); },
    close: async (graceMs) => {
      if (!child || closedWith) return;
      const exited = new Promise<void>((r) => child!.once('exit', () => r()));
      try { child.stdin?.end(); } catch {}
      const timer = setTimeout(() => { try { child!.kill('SIGTERM'); } catch {} setTimeout(() => { try { child!.kill('SIGKILL'); } catch {} }, Math.max(100, graceMs / 2)); }, Math.max(0, graceMs / 2));
      await exited;
      clearTimeout(timer);
    },
  };
}
