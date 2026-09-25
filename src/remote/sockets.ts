// Where a shared server's socket lives, and the lock that keeps two hosts from
// starting two servers. Under `hostStateDir()` (resolved on every call — a test's
// temp dir): `sockets/`, 0700, and a plugin names its socket, never a path — nothing
// a plugin says can put a listener elsewhere on the machine. The lock is
// `<socket>.lock`, created O_EXCL with `{ pid, at }`; a lock whose pid is not alive
// is stale and taken over — the session lock's rule (src/assistant/sessions.ts).
import fs from 'node:fs';
import path from 'node:path';
import { hostStateDir } from '../config/load.js';

// Bun's unix-connect API — the one call this file needs; its full type definitions
// are not part of the typecheck (the same convention as `src/loader/compat.ts`'s
// `Bun.semver` declaration).
declare const Bun: {
  connect(opts: { unix: string; socket: { open(): void; data(): void; close(): void; error(): void } }): Promise<{ end(): void }>;
};

export function socketsDir(): string {
  const dir = path.join(hostStateDir(), 'sockets');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* platform without chmod semantics */ }
  return dir;
}

export function socketPath(name: string): string {
  if (!name || name.length > 64 || /[/\\]/.test(name) || name.includes('..')) throw new Error(`socket name must be a plain file name under 64 characters, got ${JSON.stringify(name)}`);
  return path.join(socketsDir(), name);
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === 'EPERM'; } };

export function acquireStartLock(sock: string, deps: { pidAlive?: (pid: number) => boolean } = {}): { ok: true; release(): void } | { ok: false; heldBy: number } {
  const lock = `${sock}.lock`;
  const isAlive = deps.pidAlive ?? alive;
  const tryTake = (): boolean => { try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx', mode: 0o600 }); return true; } catch { return false; } };
  if (tryTake()) return { ok: true, release: () => { try { fs.unlinkSync(lock); } catch { /* already gone */ } } };
  let holder = 0;
  try { holder = Number((JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid?: unknown }).pid) || 0; } catch { /* unreadable — treated as no one to identify */ }
  if (holder && isAlive(holder)) return { ok: false, heldBy: holder };
  try { fs.unlinkSync(lock); } catch { /* already gone */ }
  if (tryTake()) return { ok: true, release: () => { try { fs.unlinkSync(lock); } catch { /* already gone */ } } };
  return { ok: false, heldBy: holder };
}

export async function isSocketDead(sock: string): Promise<boolean> {
  if (!fs.existsSync(sock)) return true;
  try {
    const c = await Bun.connect({ unix: sock, socket: { data() {}, open() {}, close() {}, error() {} } });
    c.end();
    return false;
  } catch { return true; }
}
