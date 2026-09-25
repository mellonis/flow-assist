// Where a shared server's socket lives, and the lock that keeps two hosts from
// starting two servers. Under `hostStateDir()` (resolved on every call — a test's
// temp dir): `sockets/`, 0700, and a plugin names its socket, never a path — nothing
// a plugin says can put a listener elsewhere on the machine. The lock is
// `<socket>.lock`, created O_EXCL with `{ pid, at }`; a lock whose pid is not alive
// is stale and taken over — the session lock's rule (src/assistant/sessions.ts),
// including its rule for a lock that will not parse: an `O_EXCL` create exists empty
// for an instant before its write lands, so an unreadable lock is held while it is
// younger than `UNREADABLE_HELD_MS` and stale after. `release` removes the lock only
// while it is still the one this acquire wrote — a host judged stale and taken over
// must not delete its successor's.
import fs from 'node:fs';
import path from 'node:path';
import { hostStateDir } from '../config/load.js';
import { UNREADABLE_HELD_MS } from '../assistant/sessions.js';

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
  if (!name || name === '.' || name.length > 64 || /[/\\]/.test(name) || name.includes('..')) throw new Error(`socket name must be a plain file name under 64 characters, got ${JSON.stringify(name)}`);
  const dir = socketsDir();
  const problem = socketPathProblem(dir, name);
  if (problem) throw new Error(problem);
  return path.join(dir, name);
}

// A unix socket binds only a path that fits in `sun_path` with its terminating NUL:
// 104 bytes on macOS and the BSDs, 108 on Linux — so at most 103 or 107 bytes of
// path. Past that the bind fails with an error that names neither part, so the check
// is here, and says whether the directory or the name is what to shorten.
const SUN_PATH_BYTES: Record<string, number> = { linux: 108, android: 108 };
export function socketPathProblem(dir: string, name: string, platform: string = process.platform): string | null {
  const limit = (SUN_PATH_BYTES[platform] ?? 104) - 1;
  const full = path.join(dir, name);
  const bytes = Buffer.byteLength(full);
  if (bytes <= limit) return null;
  const dirBytes = Buffer.byteLength(dir) + 1;
  // A name of a few characters is what any socket needs; a directory that leaves less
  // room than that is the part to move.
  const part = limit - dirBytes < 8
    ? `the sockets directory ${dir} takes ${dirBytes} of them — set a shorter XDG_CONFIG_HOME`
    : `the name ${JSON.stringify(name)} takes ${Buffer.byteLength(name)} of them, and at most ${limit - dirBytes} fit after the sockets directory`;
  return `socket path ${full} is ${bytes} bytes, over this platform's limit of ${limit}: ${part}`;
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === 'EPERM'; } };

export function acquireStartLock(sock: string, deps: { pidAlive?: (pid: number) => boolean } = {}): { ok: true; release(): void } | { ok: false; heldBy: number } {
  const lock = `${sock}.lock`;
  const isAlive = deps.pidAlive ?? alive;
  const mine = JSON.stringify({ pid: process.pid, at: Date.now() });
  const tryTake = (): boolean => { try { fs.writeFileSync(lock, mine, { flag: 'wx', mode: 0o600 }); return true; } catch { return false; } };
  const release = () => { try { if (fs.readFileSync(lock, 'utf8') === mine) fs.unlinkSync(lock); } catch { /* already gone */ } };
  if (tryTake()) return { ok: true, release };
  let holder = 0;
  let readable = false;
  try { holder = Number((JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid?: unknown }).pid) || 0; readable = true; } catch { /* missing, or not yet written */ }
  if (holder && isAlive(holder)) return { ok: false, heldBy: holder };
  if (!readable) {
    let mtimeMs: number | null = null;
    try { mtimeMs = fs.statSync(lock).mtimeMs; } catch { /* gone meanwhile */ }
    if (mtimeMs !== null && Date.now() - mtimeMs <= UNREADABLE_HELD_MS) return { ok: false, heldBy: 0 };
  }
  try { fs.unlinkSync(lock); } catch { /* already gone */ }
  if (tryTake()) return { ok: true, release };
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
