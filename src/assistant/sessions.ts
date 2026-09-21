// Chat sessions on disk, so a restart (an update, a crash) does not lose the
// conversation. One file per session, `<config dir>/sessions/<id>.json`; the app
// continues the latest one on start, `/clear` begins a new one and `/resume` goes
// back to an older one — as in Claude Code.
//
// A session is ONE object: what is on screen, what the model sees, the summary a
// `/compact` left, the plan and the last usage reading. They are three views of one
// conversation (`/compact` moves the history into the summary), so they are saved
// together or not at all — and the directory the conversation's shell commands were
// left in. Not saved: an answer being written, a pending y/n or
// question, queued messages — restored, they would resolve into nothing.
//
// The files hold whatever the conversation held (tracker text, MR text), so they are
// the person's alone: directory 700, files 600. A write goes to a temp file and is
// renamed over the old one — a kill mid-write never leaves a file that breaks the
// next start; a file that does not parse is skipped, never fatal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir } from '../config/load.js';

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
  issue?: string | number | null;      // the task the chat was opened on, if any
  shellCwd?: string | null;            // where `!command` / run_command were last left (null — the default)
  closed?: boolean;                    // left with /clear — listed, never continued on start
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

export function saveSession(dir: string, s: Session): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = fileOf(dir, s.id);
  const body: Session = {
    ...s,
    version: SESSION_VERSION,
    title: s.title || sessionTitle(s.messages),
    // `live` is the half-written text of an answer in progress — not a message yet.
    messages: s.messages.slice(-KEEP_MESSAGES).map(({ live: _live, ...m }) => m),
    api: s.api.slice(-KEEP_MESSAGES),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadSession(dir: string, id: string): Session | null {
  try {
    const s = JSON.parse(fs.readFileSync(fileOf(dir, id), 'utf8')) as Session;
    if (!s || s.version !== SESSION_VERSION || !Array.isArray(s.messages) || !Array.isArray(s.api)) return null;
    return {
      ...s,
      summary: typeof s.summary === 'string' ? s.summary : '',
      plan: Array.isArray(s.plan) ? s.plan : [],
      usage: s.usage ?? null,
      prompts: Array.isArray(s.prompts) ? s.prompts.map(String) : [],
      draft: typeof s.draft === 'string' ? s.draft : '',
      issue: typeof s.issue === 'string' || typeof s.issue === 'number' ? s.issue : null,
      // Checked again when it is used: a directory that has gone or left the roots
      // since reads as the default (`createShellState`).
      shellCwd: typeof s.shellCwd === 'string' ? s.shellCwd : null,
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
// process listener for every chat (a test boots the app many times).
const atExit = new Set<() => void>();
export function flushOnExit(fn: () => void): () => void {
  if (!atExit.size) process.once('exit', () => { for (const f of atExit) { try { f(); } catch { /* exiting */ } } });
  atExit.add(fn);
  return () => { atExit.delete(fn); };
}

// "16:05" for today, "2026-09-20 16:05" for any other day.
export function sessionWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '?';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}
