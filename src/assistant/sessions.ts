// Chat sessions on disk, so a restart (an update, a crash) does not lose the
// conversation. One file per session, `<config dir>/sessions/<id>.json`; the app
// continues the latest one on start, `/clear` begins a new one and `/resume` goes
// back to an older one — as in Claude Code.
//
// A session is ONE object: what is on screen, what the model sees, the summary a
// `/compact` left, the plan and the last usage reading. They are three views of one
// conversation (`/compact` moves the history into the summary), so they are saved
// together or not at all — and the directory the conversation's shell commands were
// left in, and the tools the model has loaded (the history calls them). Not saved: an answer being written, a pending y/n or
// question, queued messages — restored, they would resolve into nothing.
//
// An image the person attached is saved as a ref — its path, hash, type and size
// (./images.ts) — never as its bytes: a session is written after every turn, and a
// screenshot in base64 would be most of every write. It is read again from the path
// when it is next sent.
//
// The files hold whatever the conversation held (tracker text, MR text), so they are
// the person's alone: directory 700, files 600. A write goes to a temp file and is
// renamed over the old one — a kill mid-write never leaves a file that breaks the
// next start; a file that does not parse is skipped, never fatal.
//
// Two more things guard against two processes on one session (see AGENTS.md,
// "Sessions survive a restart"): an ownership LOCK beside the file
// (`<id>.lock`) so a second process does not silently continue what a live one
// still holds, and a `rev` counter in the file itself so a save that finds the
// disk changed since it last read or wrote it never overwrites that — it forks
// the conversation into a new session instead.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir } from '../config/load.js';
import { isImageRef, type ImageRef } from './images.js';
import { readLegacyView, type ViewRecord } from './views.js';

export const SESSION_VERSION = 1;
// What is kept of a long conversation: the summary plus this many latest messages
// on each side (screen, model). Older turns are what `/compact` is for.
export const KEEP_MESSAGES = 400;
export const KEEP_SESSIONS = 50;

export interface Session {
  version: number;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Record<string, unknown>[]; // the screen
  api: Record<string, unknown>[];      // the model's history
  summary: string;
  plan: { id: number; text: string; status: string }[];
  usage: { promptTokens: number; completionTokens: number } | null;
  prompts: string[];                   // ↑/↓ history of the field
  draft: string;                       // what was typed and not sent
  subject?: string | null;             // what the screen was about when the chat began (`chatSubject`), if anything
  shellCwd?: string | null;            // where `!command` / run_command were last left (null — the default)
  tools?: string[];                    // the tools the model loaded (tools on demand); absent in older sessions
  images?: ImageRef[];                 // what each `[Image #N]` of the conversation stands for; absent in older sessions
  imageSeq?: number;                   // the last N given out — numbering goes on from it
  closed?: boolean;                    // left with /clear — listed, never continued on start
  rev?: number;                        // bumped by every saveSession; absent (an older host) reads as 0
}

export interface SessionInfo { id: string; title: string; updatedAt: string; turns: number; closed: boolean }

// null — sessions stay in memory. That is the case under `bun test` (NODE_ENV=test)
// with no dir named: a test that boots the app must never write into, or continue,
// the person's own saved chats.
export function sessionsDir(config: Record<string, unknown> | undefined, env: Record<string, string | undefined> = process.env): string | null {
  const raw = (config?.sessions as { dir?: unknown } | undefined)?.dir;
  if (!raw) return env.NODE_ENV === 'test' ? null : path.join(configDir(), 'sessions');
  const expanded = String(raw).replace(/^~(?=\/|$)/, os.homedir());
  return path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
}

// Sortable and unique enough for one person: 2026-09-21T16-05-09-4f2a.
export function newSessionId(now = new Date()): string {
  return `${now.toISOString().slice(0, 19).replace(/:/g, '-')}-${Math.random().toString(16).slice(2, 6)}`;
}

const ID = /^[0-9T-]{19}-[0-9a-f]{4}$/;
const fileOf = (dir: string, id: string) => {
  if (!ID.test(id)) throw new Error(`not a session id: ${id}`);
  return path.join(dir, `${id}.json`);
};

// Something the person said, or a `!command` they ran.
const bySomeone = (m: Record<string, unknown>) => m.role === 'user' || m.role === 'shell';

// The first thing the person asked — what the list shows; a session that holds only
// `!commands` is named by the first of them.
export function sessionTitle(messages: Record<string, unknown>[]): string {
  const first = messages.find((m) => m.role === 'user' && String(m.content ?? '').trim());
  const ran = first ? undefined : messages.find((m) => m.role === 'shell' && typeof m.command === 'string');
  const t = (first ? String(first.content ?? '') : ran ? `$ ${String(ran.command)}` : '').replace(/\s+/g, ' ').trim();
  return t.length > 70 ? `${t.slice(0, 69)}…` : t;
}

// A session worth keeping has something the person said or ran in it.
export const isEmpty = (s: Pick<Session, 'messages'>) => !s.messages.some(bySomeone);

// The rev already on disk for a session file — 0 for one that does not exist, does
// not parse, or was written by a host old enough to have no `rev` field at all.
function readRev(file: string): number {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { rev?: unknown };
    return Number.isInteger(raw?.rev) ? (raw.rev as number) : 0;
  } catch { return 0; }
}

// The rev currently on disk for a session, by id — what a save must compare its own
// last-known rev against before writing, so it never overwrites a change it has not
// seen (an older host with no lock, a hand edit).
export function sessionRev(dir: string, id: string): number {
  try { return readRev(fileOf(dir, id)); } catch { return 0; }
}

// Returns the rev this save was written with — always the disk's previous rev + 1,
// regardless of what `s.rev` held coming in: rev is this function's own counter, not
// the caller's to set.
export function saveSession(dir: string, s: Session): number {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = fileOf(dir, s.id);
  const rev = readRev(file) + 1;
  const body: Session = {
    ...s,
    version: SESSION_VERSION,
    title: s.title || sessionTitle(s.messages),
    rev,
    // `live` is the half-written text of an answer in progress — not a message yet.
    messages: s.messages.slice(-KEEP_MESSAGES).map(({ live: _live, ...m }) => m),
    api: s.api.slice(-KEEP_MESSAGES),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return rev;
}

// A saved subject; an old session may hold a number there.
const subjectOf = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);

// Views as a session keeps them: records — the renderer's kind and the tool's data —
// never drawn rows. Two readings on the way in: a view saved while its tool still ran
// (the process ended mid-command) is `failed`, or its clock would tick forever after
// a restart; and a console view saved before renderers is read as a record. Anything
// else — a stray string or number in the array, an object with no `kind` string — is
// not a view a renderer can draw (`frameView`/`resolveRenderer` need `kind` to be a
// string) and is dropped rather than reaching the screen and throwing.
export function normalizeViews(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (!Array.isArray(m.views)) return m;
    const views = (m.views as unknown[]).map((v) => {
      const old = readLegacyView(v);
      if (old) return old;
      const r = v as ViewRecord | null;
      if (!r || typeof r !== 'object' || typeof r.kind !== 'string') return null;
      return r.phase === 'live' ? { ...r, phase: 'failed' } : r;
    }).filter((v): v is ViewRecord => v !== null);
    return { ...m, views };
  });
}

export function loadSession(dir: string, id: string): Session | null {
  try {
    const s = JSON.parse(fs.readFileSync(fileOf(dir, id), 'utf8')) as Session;
    if (!s || s.version !== SESSION_VERSION || !Array.isArray(s.messages) || !Array.isArray(s.api)) return null;
    return {
      ...s,
      messages: normalizeViews(s.messages),
      summary: typeof s.summary === 'string' ? s.summary : '',
      plan: Array.isArray(s.plan) ? s.plan : [],
      usage: s.usage ?? null,
      prompts: Array.isArray(s.prompts) ? s.prompts.map(String) : [],
      draft: typeof s.draft === 'string' ? s.draft : '',
      // Saved before the rename as `issue`; read either spelling, write the new one.
      subject: subjectOf(s.subject ?? (s as { issue?: unknown }).issue),
      // Checked again when it is used: a directory that has gone or left the roots
      // since reads as the default (`createShellState`).
      shellCwd: typeof s.shellCwd === 'string' ? s.shellCwd : null,
      // A tool no longer offered (a plugin removed since) stays in the list and is
      // simply never sent — the request is built from what exists.
      tools: Array.isArray(s.tools) ? s.tools.filter((n): n is string => typeof n === 'string') : [],
      images: Array.isArray(s.images) ? s.images.filter(isImageRef) : [],
      imageSeq: Number.isInteger(s.imageSeq) && (s.imageSeq as number) > 0 ? s.imageSeq : 0,
      rev: Number.isInteger(s.rev) ? (s.rev as number) : 0,
    };
  } catch {
    return null;
  }
}

// Newest first; a file that does not parse is left out.
export function listSessions(dir: string): SessionInfo[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: SessionInfo[] = [];
  for (const n of names) {
    const id = n.replace(/\.json$/, '');
    if (!n.endsWith('.json') || !ID.test(id)) continue;
    const s = loadSession(dir, id);
    if (s) out.push({ id, title: s.title || sessionTitle(s.messages), updatedAt: s.updatedAt, turns: s.messages.filter(bySomeone).length, closed: s.closed === true });
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

// `/clear`: the conversation stays on the list, but a restart does not bring it back.
export function closeSession(dir: string, id: string): void {
  const s = loadSession(dir, id);
  if (s) saveSession(dir, { ...s, closed: true });
}

// What a start continues: the newest session, unless it was cleared.
export function sessionToContinue(dir: string): Session | null {
  const last = listSessions(dir)[0];
  if (!last || last.closed) return null;
  return loadSession(dir, last.id);
}

export function deleteSession(dir: string, id: string): void {
  try { fs.unlinkSync(fileOf(dir, id)); } catch { /* already gone */ }
}

// Keeps the newest `keep`; returns how many went.
export function pruneSessions(dir: string, keep = KEEP_SESSIONS): number {
  const old = listSessions(dir).slice(keep);
  for (const s of old) deleteSession(dir, s.id);
  return old.length;
}

// The last change is written at exit even if its debounced save has not fired. One
// process listener for every chat (a test boots the app many times) — `exitHooked`,
// not `atExit.size`, gates the `process.once`: a chat that unregisters (component
// unmount) brings the set back to empty, and re-arming on the next boot would add a
// second `process.once('exit', …)` listener that fires everything twice.
const atExit = new Set<() => void>();
let exitHooked = false;
export function flushOnExit(fn: () => void): () => void {
  if (!exitHooked) {
    exitHooked = true;
    process.once('exit', () => { for (const f of atExit) { try { f(); } catch { /* exiting */ } } });
  }
  atExit.add(fn);
  return () => { atExit.delete(fn); };
}

// ─── Ownership lock ─────────────────────────────────────────────────────────────
// A session held by a live chat has a lock beside it, `<id>.lock` — `{ pid, host,
// token, at }`. `token` names a CHAT INSTANCE, not a process: two instances can live
// in one process (as the e2e tests do), so `process.pid` alone cannot tell them
// apart — the caller makes one token per chat (`makeLockToken`) and keeps it for the
// chat's life.
//
// A lock is OURS when its token matches. Otherwise it is HELD when its pid is alive
// on this host, or its host is not this one at all (a foreign host's pid cannot be
// checked, so it counts as held). Anything else — the owning process is gone — is
// STALE and is taken over. `acquireLock` is side-effect free on a held lock, so a
// caller that only wants to know (a `/resume` refusal, the start-up continue check)
// can call it directly rather than peeking first.
export interface LockInfo { pid: number; host: string; token: string; at: string }
export interface LockDeps {
  host?: string;                        // this machine's name; defaults to os.hostname()
  pidAlive?: (pid: number) => boolean;  // injectable for tests
}
export type LockOutcome =
  | { status: 'acquired' | 'ours' }
  | { status: 'held'; holder: LockInfo };

const lockFile = (dir: string, id: string) => path.join(dir, `${id}.lock`);

function readLock(file: string): LockInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockInfo>;
    if (raw && typeof raw.pid === 'number' && typeof raw.host === 'string' && typeof raw.token === 'string') return raw as LockInfo;
  } catch { /* missing or unreadable — the caller treats this like no lock at all */ }
  return null;
}

// `process.kill(pid, 0)` sends no signal; it throws ESRCH when the pid is gone and
// EPERM when it exists but belongs to someone else — EPERM still means alive.
function defaultPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function writeLock(file: string, info: LockInfo): boolean {
  try {
    fs.writeFileSync(file, JSON.stringify(info), { mode: 0o600, flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

export function acquireLock(dir: string, id: string, token: string, deps: LockDeps = {}): LockOutcome {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = lockFile(dir, id);
  const host = deps.host ?? os.hostname();
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const info: LockInfo = { pid: process.pid, host, token, at: new Date().toISOString() };

  if (writeLock(file, info)) return { status: 'acquired' };
  const lock = readLock(file);
  if (lock?.token === token) return { status: 'ours' };
  const held = lock !== null && (lock.host !== host || pidAlive(lock.pid));
  if (held) return { status: 'held', holder: lock! };

  // Stale (a dead pid on our own host) or unreadable — take over, once.
  try { fs.unlinkSync(file); } catch { /* raced away already */ }
  if (writeLock(file, info)) return { status: 'acquired' };
  const relock = readLock(file);
  if (relock?.token === token) return { status: 'ours' };
  return { status: 'held', holder: relock ?? info };
}

// Unlinks only when the token is ours — releasing a lock we do not hold would tear
// down someone else's ownership.
export function releaseLock(dir: string, id: string, token: string): void {
  const lock = readLock(lockFile(dir, id));
  if (lock?.token === token) { try { fs.unlinkSync(lockFile(dir, id)); } catch { /* already gone */ } }
}

// One per chat instance, made once and kept for its life — not per process (see the
// section comment above).
export function makeLockToken(): string {
  return crypto.randomUUID();
}

// "16:05" for today, "2026-09-20 16:05" for any other day.
export function sessionWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '?';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}
