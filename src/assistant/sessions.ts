// Chat sessions on disk, so a restart (an update, a crash) does not lose the
// conversation. One file per session, `<config dir>/sessions/<project>/<id>.json`; the
// app continues the latest one on start, `/clear` begins a new one and `/resume` goes
// back to an older one — as in Claude Code.
//
// A session belongs to the project it started in (`projectOf`): its files live under a
// mirror of that project's path (`projectHome`), a session with no project at the top
// level. Every `(dir, id)` function below takes a session's OWN directory — where its
// state file, journal and lock sit side by side; the ones that read every session
// (`listSessions`, `sessionRows`, `pruneSessions`, `sweepJournals`) take the root and walk
// the tree. A file written flat by an older host is read where it is, as a session with
// no project, and never moved: another process may hold its lock beside it, and a
// move would part the file from that lock.
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
// still holds, and a FINGERPRINT — the file's `rev` plus its `mtimeMs`/`size` on
// disk — so a save that finds the disk changed since it last read or wrote it
// never overwrites that. `rev` alone is not enough: a hand edit that leaves the
// number untouched, or an older host that never wrote one at all (so two
// different foreign writes both read as rev 0), would still read as unchanged —
// `mtimeMs`/`size` catch what the counter cannot. A mismatch on any of the three
// forks the conversation into a new session instead of overwriting what changed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir } from '../config/load.js';
import { isImageRef, type ImageRef } from './images.js';
import { createRecallState, saveRecallState } from './recall.js';
import { readLegacyView, type ViewRecord } from './views.js';
import { realOf, within } from './shell.js';
import { addCalls, callRun, readChange, readParts, type CallRun, type TurnPart } from './step.js';
import type { ChangeView } from './diff.js';
import type { TokenUsage } from './agent.js';

export const SESSION_VERSION = 1;
// What the state file keeps of a long conversation: the summary plus this many latest
// messages on each side (screen, model). Older turns are what `/compact` is for, and
// the journal beside the file (./journal.ts) keeps all of it. On the screen side only
// the conversation counts: a command's block (a `view` row) is kept under a smaller cap
// of its own, so a session that runs many commands keeps as much of what was said as
// one that runs none.
export const KEEP_MESSAGES = 400;
export const KEEP_VIEWS = 100;
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
  usage: TokenUsage | null;
  prompts: string[];                   // ↑/↓ history of the field
  draft: string;                       // what was typed and not sent
  subject?: string | null;             // written by older hosts (what the screen was about); read, no longer written or used
  shellCwd?: string | null;            // where `!command` / run_command were last left (null — the default)
  tools?: string[];                    // the tools the model loaded (tools on demand); absent in older sessions
  images?: ImageRef[];                 // what each `[Image #N]` of the conversation stands for; absent in older sessions
  imageSeq?: number;                   // the last N given out — numbering goes on from it
  recall?: { stubbed: string[]; turns: number }; // the bulky items sent as stubs (by id) and the turns since the last batch (./recall.ts)
  closed?: boolean;                    // left with /clear — listed, never continued on start
  project?: string | null;             // the project it started in (`projectOf`), decided once; absent — none
  answeredAt?: string;                 // when its last turn ended with an answer; absent — none yet
  seenAt?: string;                     // when a chat last showed its end (`unseenAnswer`)
  rev?: number;                        // bumped by every saveSession; absent (an older host) reads as 0
}

// `dir` — the directory the file was found in (the session's own, for every
// `(dir, id)` function); `project` — the one it recorded, null for none.
export interface SessionInfo { id: string; title: string; updatedAt: string; turns: number; closed: boolean; dir: string; project: string | null }

// null — sessions stay in memory. That is the case under `bun test` (NODE_ENV=test)
// with no dir named: a test that boots the app must never write into, or continue,
// the person's own saved chats.
export function sessionsDir(config: Record<string, unknown> | undefined, env: Record<string, string | undefined> = process.env): string | null {
  const raw = (config?.sessions as { dir?: unknown } | undefined)?.dir;
  if (!raw) return env.NODE_ENV === 'test' ? null : path.join(configDir(), 'sessions');
  const expanded = String(raw).replace(/^~(?=\/|$)/, os.homedir());
  return path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
}

// ─── Where a session lives ──────────────────────────────────────────────────────
// The project a directory belongs to: the innermost shell root holding it, else the
// nearest directory above it with a `.git` (a directory, or a file in a worktree), else
// none. By real path, as the roots are compared everywhere (./shell.ts, `dirAllowed`).
export function gitRootOf(dir: string): string | null {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}
export function projectOf(dir: string, roots: string[], gitRoot: (dir: string) => string | null = gitRootOf): string | null {
  const real = realOf(path.resolve(dir));
  const root = roots.map(realOf).filter((r) => within(real, r)).sort((a, b) => b.length - a.length)[0];
  return root ?? gitRoot(real);
}

// A project's sessions directory: the project's path mirrored under the root, its
// separators kept as directories (`/Users/me/app` → `<root>/Users/me/app`); no project
// is the root itself.
export function projectHome(root: string, project: string | null): string {
  if (!project) return root;
  return path.join(root, ...project.split(/[\\/]/).filter((seg) => seg && seg !== '.' && seg !== '..').map((seg) => seg.replace(/:$/, '')));
}
const projectRead = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

// Every directory of the tree, the root first. A link is never followed: the tree is
// ours, and a link in it leads somewhere that is not.
const MAX_DEPTH = 64;
function sessionDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    out.push(dir);
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  return out;
}
const namesIn = (dir: string): string[] => {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { return []; }
};
const newestFirst = (a: { updatedAt: string }, b: { updatedAt: string }) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);

// Sortable and unique enough for one person: 2026-09-21T16-05-09-4f2a.
export function newSessionId(now = new Date()): string {
  return `${now.toISOString().slice(0, 19).replace(/:/g, '-')}-${Math.random().toString(16).slice(2, 6)}`;
}

const ID = /^[0-9T-]{19}-[0-9a-f]{4}$/;
const fileOf = (dir: string, id: string) => {
  if (!ID.test(id)) throw new Error(`not a session id: ${id}`);
  return path.join(dir, `${id}.json`);
};

// The session's journal (./journal.ts): beside its state file, never trimmed, removed
// with the session — and before it only when `sessions.journalDays` says so.
const JOURNAL_EXT = '.log.jsonl';
export function journalPath(dir: string, id: string): string {
  if (!ID.test(id)) throw new Error(`not a session id: ${id}`);
  return path.join(dir, `${id}${JOURNAL_EXT}`);
}
export const JOURNAL_DAYS = 0;

// The screen list as the state file keeps it: the latest `keep` conversation rows —
// every row but a `view` — and, among them, the latest `keepViews` view rows in their
// places.
export function trimScreen(messages: Record<string, unknown>[], keep = KEEP_MESSAGES, keepViews = KEEP_VIEWS): Record<string, unknown>[] {
  let start = 0;
  for (let i = messages.length - 1, n = 0; i >= 0; i--) {
    if (messages[i]!.role === 'view') continue;
    if (++n > keep) { start = i + 1; break; }
  }
  const tail = messages.slice(start);
  let views = tail.filter((m) => m.role === 'view').length;
  return views <= keepViews ? tail : tail.filter((m) => m.role !== 'view' || views-- <= keepViews);
}

// The model's history as the state file keeps it: about the latest `keep` messages,
// cut where a turn begins — something the person said or ran, or a background result —
// never between a call and its result, which a provider refuses to be sent. The cut
// moves forward to the next turn; when the last turn alone is longer than `keep`, it is
// kept whole, from where it began.
export function trimHistory(api: Record<string, unknown>[], keep = KEEP_MESSAGES): Record<string, unknown>[] {
  if (api.length <= keep) return api;
  const begins = (m: Record<string, unknown>) => m.role === 'user' || m.role === 'bg' || m.role === 'shell';
  const cut = api.length - keep;
  const next = api.findIndex((m, i) => i >= cut && begins(m));
  if (next >= 0) return api.slice(next);
  const last = api.findLastIndex(begins);
  return api.slice(Math.max(0, last));
}

// Something the person said, or a `!command` they ran.
export const bySomeone = (m: Record<string, unknown>) => m.role === 'user' || m.role === 'shell';

// A title is ONE line: the first non-empty line of what it is made from, runs of
// whitespace collapsed, cut at TITLE_MAX code points with an ellipsis. Nothing asks the
// model for one.
export const TITLE_MAX = 70;
export function cutTitle(text: string): string {
  const line = (text.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim();
  const points = Array.from(line);
  return points.length > TITLE_MAX ? `${points.slice(0, TITLE_MAX - 1).join('')}…` : line;
}

// The first thing the person asked — what the list shows; a session that holds only
// `!commands` is named by the first of them.
export function sessionTitle(messages: Record<string, unknown>[]): string {
  // The host's own ask after a `!!command` is not something the person asked.
  const first = messages.find((m) => m.role === 'user' && m.hostAsk !== true && String(m.content ?? '').trim());
  const ran = first ? undefined : messages.find((m) => m.role === 'shell' && typeof m.command === 'string');
  return cutTitle(first ? String(first.content ?? '') : ran ? `$ ${String(ran.command)}` : '');
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

// The rev currently on disk for a session, by id — a plain peek at the counter
// alone. `sessionFingerprint` below is what a save actually checks against; this
// stays exported for callers (and tests) that want the counter on its own.
export function sessionRev(dir: string, id: string): number {
  try { return readRev(fileOf(dir, id)); } catch { return 0; }
}

// What a save compares the disk against before writing: the `rev` a save bumps,
// plus the file's own `mtimeMs`/`size` — the two `rev` cannot see through (a hand
// edit that leaves the number alone, or two different foreign writes that both
// have no `rev` field and so both read as 0). A file that does not exist reads as
// the same all-zero fingerprint a session with nothing written yet starts from, so
// "nothing there" and "nothing seen yet" compare equal.
export interface SessionFingerprint { rev: number; mtimeMs: number; size: number }
const NO_FILE_FINGERPRINT: SessionFingerprint = { rev: 0, mtimeMs: 0, size: 0 };

function fingerprintOf(file: string): SessionFingerprint {
  try {
    const stat = fs.statSync(file);
    return { rev: readRev(file), mtimeMs: stat.mtimeMs, size: stat.size };
  } catch { return NO_FILE_FINGERPRINT; }
}

// The fingerprint currently on disk for a session, by id — read at every load and
// every successful write, and compared before every later write so a save never
// overwrites a change it has not seen.
export function sessionFingerprint(dir: string, id: string): SessionFingerprint {
  try { return fingerprintOf(fileOf(dir, id)); } catch { return NO_FILE_FINGERPRINT; }
}

export const sessionFingerprintsEqual = (a: SessionFingerprint, b: SessionFingerprint): boolean =>
  a.rev === b.rev && a.mtimeMs === b.mtimeMs && a.size === b.size;

// Returns the fingerprint this save was written with — rev is always the disk's
// previous rev + 1 regardless of what `s.rev` held coming in (rev is this
// function's own counter, not the caller's to set), and mtimeMs/size are read back
// off the renamed file so the caller's record matches the disk exactly.
export function saveSession(dir: string, s: Session): SessionFingerprint {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = fileOf(dir, s.id);
  const rev = readRev(file) + 1;
  const body: Session = {
    ...s,
    version: SESSION_VERSION,
    title: s.title || sessionTitle(s.messages),
    rev,
    // `live` is the half-written text of a round in progress — not a message yet.
    messages: trimScreen(s.messages).map(({ live: _live, liveQuiet: _quiet, ...m }) => m),
    api: trimHistory(s.api),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  fs.renameSync(tmp, file);
  const stat = fs.statSync(file);
  return { rev, mtimeMs: stat.mtimeMs, size: stat.size };
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

// A turn's parts as a session keeps them (src/assistant/step.ts): the steps and the
// changes, in the order they happened. An older session (saved before turns were
// drawn in time order) keeps them by category instead — the text of its tool rounds (`process`;
// `shown`, the part of it that had been on screen) and every change of the turn
// (`changes`) and the turn's whole trail of calls (`toolRuns`) — and reads as those
// parts in that old order: the text, then the changes, then the calls (the trail was
// drawn under the answer; as the last part it stands just before it). `step` (the
// one-line summary that went with it) is dropped. A part that is not one a renderer
// can draw is dropped too, and a "message" that is not an object at all is not a
// message.
export function normalizeParts(messages: unknown[]): Record<string, unknown>[] {
  return messages.filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && !Array.isArray(m)).map((m) => {
    if (m.role !== 'assistant') return m;
    const { process, shown, changes, toolRuns, step: _step, liveAs: _liveAs, live: _live, liveQuiet: _quiet, parts, ...rest } = m;
    // A call that left a view is drawn by its view message already.
    const calls = Array.isArray(toolRuns)
      ? toolRuns.filter((r) => !(Array.isArray((r as { views?: unknown } | null)?.views) && ((r as { views: unknown[] }).views.length > 0))).map(callRun).filter((c): c is CallRun => c !== null)
      : [];
    // An old-format trail belongs to the turn, drawn under the answer — never a step's
    // own calls, so an empty step stands between it and the text before (as `endRound` does).
    const trail = (ps: TurnPart[]): TurnPart[] => (calls.length && ps.at(-1)?.kind === 'text' ? addCalls([...ps, { kind: 'text', text: '' }], calls) : addCalls(ps, calls));
    if (Array.isArray(parts)) {
      const kept = trail(readParts(parts));
      return kept.length ? { ...rest, parts: kept } : rest;
    }
    const text = [process, shown].find((t): t is string => typeof t === 'string' && !!t.trim());
    const old: TurnPart[] = trail([
      ...(text ? [{ kind: 'text' as const, text }] : []),
      ...(Array.isArray(changes) ? changes.map(readChange).filter((c): c is ChangeView => c !== null).map((change) => ({ kind: 'change' as const, change })) : []),
    ]);
    return old.length ? { ...rest, parts: old } : rest;
  });
}

export function loadSession(dir: string, id: string): Session | null {
  try {
    const s = JSON.parse(fs.readFileSync(fileOf(dir, id), 'utf8')) as Session;
    if (!s || s.version !== SESSION_VERSION || !Array.isArray(s.messages) || !Array.isArray(s.api)) return null;
    return {
      ...s,
      messages: normalizeViews(normalizeParts(s.messages)),
      summary: typeof s.summary === 'string' ? s.summary : '',
      plan: Array.isArray(s.plan) ? s.plan : [],
      usage: s.usage ?? null,
      prompts: Array.isArray(s.prompts) ? s.prompts.map(String) : [],
      draft: typeof s.draft === 'string' ? s.draft : '',
      // A session may hold this as `issue`, an earlier spelling; read either, write the new one.
      subject: subjectOf(s.subject ?? (s as { issue?: unknown }).issue),
      // Checked again when it is used: a directory that has gone or left the roots
      // since reads as the default (`createShellState`).
      shellCwd: typeof s.shellCwd === 'string' ? s.shellCwd : null,
      // A tool not currently offered (its plugin missing or removed) stays in the
      // list and is simply never sent — the request is built from what exists.
      tools: Array.isArray(s.tools) ? s.tools.filter((n): n is string => typeof n === 'string') : [],
      images: Array.isArray(s.images) ? s.images.filter(isImageRef) : [],
      imageSeq: Number.isInteger(s.imageSeq) && (s.imageSeq as number) > 0 ? s.imageSeq : 0,
      // The ids are content hashes, so a set saved by any host still names the same
      // items; anything that is not a list of strings reads as nothing stubbed.
      recall: saveRecallState(createRecallState(s.recall)),
      rev: Number.isInteger(s.rev) ? (s.rev as number) : 0,
      project: projectRead(s.project),
      answeredAt: typeof s.answeredAt === 'string' ? s.answeredAt : '',
      seenAt: typeof s.seenAt === 'string' ? s.seenAt : '',
    };
  } catch {
    return null;
  }
}

// Every session under the root, newest first; a file that does not parse is left out.
export function listSessions(root: string): SessionInfo[] {
  const out: SessionInfo[] = [];
  for (const dir of sessionDirs(root)) {
    for (const n of namesIn(dir)) {
      const id = n.replace(/\.json$/, '');
      if (!n.endsWith('.json') || !ID.test(id)) continue;
      const s = loadSession(dir, id);
      if (s) out.push({ id, title: s.title || sessionTitle(s.messages), updatedAt: s.updatedAt, turns: s.messages.filter(bySomeone).length, closed: s.closed === true, dir, project: s.project ?? null });
    }
  }
  return out.sort(newestFirst);
}

// The sessions a list for the current project offers: its own, or — when it has none —
// every session, so a first start in a new project still finds the last conversation.
export function projectFirst<T extends { project: string | null }>(list: T[], project: string | null): T[] {
  const mine = list.filter((s) => s.project === project);
  return mine.length ? mine : list;
}

// ─── The picker's rows ──────────────────────────────────────────────────────────
// What the session picker lists (src/assistant/session-picker.ts). Besides the title
// the filter reads `text`: the person's words, the answers and the commands run,
// lower-cased — at most SEARCH_TEXT_MAX characters per session, the NEWEST kept, since
// the word a person looks for is most often one said lately.
export const SEARCH_TEXT_MAX = 64 * 1024;
export interface SessionRow { id: string; title: string; updatedAt: string; turns: number; bytes: number; lock: LockState; status: SessionStatus; text: string; dir: string; project: string | null }

// What a session is doing, for the picker to say — from what is on disk and in this
// process, nothing running in the background: `working` and `waiting` are this chat's
// own session while a turn or a `!command` runs, or while a y/n or a question waits
// (the chat says, session-picker.ts `rowStatus`); `held` — another live process has
// its lock; `done` — its last message is an answer no chat has shown since it came
// (`unseenAnswer`); `idle` otherwise.
export type SessionStatus = 'working' | 'waiting' | 'held' | 'done' | 'idle';

// Whether a session ends in an answer nobody has seen: the last thing said in it — by
// the person, the model, a command or a background result; notes and views are not
// said — is the model's answer, and it came after the last time a chat showed the end.
// The times are ISO strings, compared as such; an answer seen at the moment it came
// is seen.
export function unseenAnswer(messages: unknown[], answeredAt: string, seenAt: string): boolean {
  if (!answeredAt || (seenAt && seenAt >= answeredAt)) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | null;
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'assistant') return true;
    if (m.role === 'user' || m.role === 'shell' || m.role === 'bg') return false;
  }
  return false;
}

export function searchText(messages: unknown[]): string {
  let out = '';
  for (let i = messages.length - 1; i >= 0 && out.length < SEARCH_TEXT_MAX; i--) {
    const m = messages[i] as Record<string, unknown> | null;
    if (!m || typeof m !== 'object') continue;
    const t = m.role === 'user' && m.hostAsk !== true ? String(m.content ?? '')
      : m.role === 'assistant' && typeof m.content === 'string' ? m.content
      : m.role === 'shell' && typeof m.command === 'string' ? m.command
      : '';
    if (t) out = out ? `${t}\n${out}` : t;
  }
  return out.toLowerCase().slice(-SEARCH_TEXT_MAX); // lower-cased first: a few characters grow
}

// Every session under the root, newest first. One file is parsed at a time and dropped
// once its row is made, so the list never holds every conversation at once — only each
// one's bounded `text`. The picker reads it when it opens and after a rename or a
// delete, never per keystroke. A file that does not parse is left out, as
// `listSessions` leaves it.
export function sessionRows(root: string, token: string, deps: LockDeps = {}): SessionRow[] {
  const out: SessionRow[] = [];
  for (const dir of sessionDirs(root)) for (const n of namesIn(dir)) {
    const id = n.replace(/\.json$/, '');
    if (!n.endsWith('.json') || !ID.test(id)) continue;
    try {
      const file = path.join(dir, n);
      const bytes = fs.statSync(file).size;
      const s = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Session> | null;
      if (!s || s.version !== SESSION_VERSION || !Array.isArray(s.messages) || !Array.isArray(s.api)) continue;
      const messages = (s.messages as unknown[]).filter((m): m is Record<string, unknown> => !!m && typeof m === 'object');
      const lock = lockState(dir, id, token, deps);
      out.push({
        id, title: (typeof s.title === 'string' && s.title) || sessionTitle(messages), updatedAt: String(s.updatedAt ?? ''),
        turns: messages.filter(bySomeone).length, bytes, lock, text: searchText(messages),
        status: lock === 'held' ? 'held' : unseenAnswer(messages, typeof s.answeredAt === 'string' ? s.answeredAt : '', typeof s.seenAt === 'string' ? s.seenAt : '') ? 'done' : 'idle',
        dir, project: projectRead(s.project),
      });
    } catch { /* unreadable — left out */ }
  }
  return out.sort(newestFirst);
}

// `/clear`: the conversation stays on the list, but a restart does not bring it back.
export function closeSession(dir: string, id: string): void {
  const s = loadSession(dir, id);
  if (s) saveSession(dir, { ...s, closed: true });
}

// What a start continues: the newest session of the current project — the newest of
// all only when the project has none — unless it was cleared. A project whose newest
// was cleared continues nothing: another project's conversation is not what it left.
export function pickToContinue(list: SessionInfo[], project: string | null): SessionInfo | null {
  const last = projectFirst(list, project)[0];
  return !last || last.closed ? null : last;
}
export function sessionToContinue(root: string, project: string | null = null): Session | null {
  const last = pickToContinue(listSessions(root), project);
  return last ? loadSession(last.dir, last.id) : null;
}

// The state file and the journal go together.
export function deleteSession(dir: string, id: string): void {
  try { fs.unlinkSync(fileOf(dir, id)); } catch { /* already gone */ }
  try { fs.unlinkSync(journalPath(dir, id)); } catch { /* none, or already gone */ }
}

// Retention, swept at start, and only when the person asks for it: by default (0) a
// journal lives exactly as long as its session — a session that can still be opened
// keeps its evidence. With `days` set, a journal not written to for longer goes, and
// its session, which stays, gets a note row saying so: a state file whose record is
// gone must not look like one that still has it. A journal whose session a live chat
// holds is left alone, and so is one whose state file never got written (a crash in
// the first moments of a session) until it is as old as any other.
export function sweepJournals(root: string, days = JOURNAL_DAYS, now = Date.now()): number {
  if (!(days > 0)) return 0;
  let removed = 0;
  for (const dir of sessionDirs(root)) for (const n of namesIn(dir)) {
    if (!n.endsWith(JOURNAL_EXT)) continue;
    const id = n.slice(0, -JOURNAL_EXT.length);
    if (!ID.test(id)) continue;
    const file = path.join(dir, n);
    let mtimeMs: number;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
    if (now - mtimeMs <= days * 24 * 60 * 60 * 1000) continue;
    // The session's lock is taken for the removal and the note, as a rename takes it:
    // a process opening the session meanwhile waits for neither, and one that holds it
    // is left alone.
    const token = makeLockToken();
    if (acquireLock(dir, id, token).status !== 'acquired') continue;
    try {
      try { fs.unlinkSync(file); removed++; } catch { continue; }
      const s = loadSession(dir, id);
      if (s) saveSession(dir, { ...s, messages: [...s.messages, { role: 'note', content: `Journal removed after ${days} days without a write (sessions.journalDays) — this session's full record is gone.` }] });
    } finally {
      releaseLock(dir, id, token);
    }
  }
  return removed;
}

// Keeps the newest `keep` of each project — each directory of the tree, the top level
// one of them; returns how many session files went. A session whose
// lock is currently HELD by a live process (this one or another) is left alone —
// deleting its file out from under a process still writing it would be a second
// way to lose data. A `.lock` whose session file is already gone (deleted just
// above, or by hand) is swept too, unless it is itself still held.
export function pruneSessions(root: string, keep = KEEP_SESSIONS): number {
  const byDir = new Map<string, SessionInfo[]>();
  for (const s of listSessions(root)) byDir.set(s.dir, [...(byDir.get(s.dir) ?? []), s]);
  let removed = 0;
  for (const s of [...byDir.values()].flatMap((list) => list.slice(keep))) {
    if (isLockHeld(s.dir, s.id)) continue;
    deleteSession(s.dir, s.id);
    removed++;
  }
  for (const dir of sessionDirs(root)) for (const n of namesIn(dir)) {
    if (!n.endsWith('.lock')) continue;
    const id = n.slice(0, -'.lock'.length);
    if (!ID.test(id) || fs.existsSync(path.join(dir, `${id}.json`))) continue;
    if (isLockHeld(dir, id)) continue;
    try { fs.unlinkSync(path.join(dir, n)); } catch { /* already gone */ }
  }
  return removed;
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
//
// A lock file that exists but will not parse — a `wx` create racing its own
// `writeFileSync` (the file exists with zero or partial bytes for an instant), or
// genuine corruption — is HELD while it is recent (`UNREADABLE_HELD_MS`, the same
// order of magnitude a create-then-write race could plausibly take) and STALE once
// it has sat there longer than that: nothing still racing to finish writing it
// would take this long, so it reads as abandoned rather than in-flight.
export interface LockInfo { pid: number; host: string; token: string; at: string }
export interface LockDeps {
  host?: string;                        // this machine's name; defaults to os.hostname()
  pidAlive?: (pid: number) => boolean;  // injectable for tests
}
export type LockOutcome =
  | { status: 'acquired' | 'ours' }
  | { status: 'held'; holder: LockInfo };

export const lockPath = (dir: string, id: string): string => path.join(dir, `${id}.lock`);

export const UNREADABLE_HELD_MS = 5000;
// What an unreadable lock's `holder` reads as — there is nothing real to report,
// but `LockOutcome`'s `held` case always carries one.
const UNREADABLE_HOLDER: LockInfo = { pid: 0, host: '', token: '', at: '' };

function readLock(file: string): LockInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockInfo>;
    if (raw && typeof raw.pid === 'number' && typeof raw.host === 'string' && typeof raw.token === 'string') return raw as LockInfo;
  } catch { /* missing or unreadable — the caller treats this like no lock at all */ }
  return null;
}

function statMtimeOrNull(file: string): number | null {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
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

// Classifies whatever is at `file` right now, without ever writing or unlinking.
// `token`/`host`/`pidAlive` decide ours vs. held for a readable lock; a readable
// lock with a dead pid on our own host, or an unreadable one old enough, reads as
// `'stale'`, which the caller decides what to do with.
function classifyLock(file: string, token: string, host: string, pidAlive: (pid: number) => boolean): LockOutcome | 'stale' {
  const lock = readLock(file);
  if (lock) {
    if (lock.token === token) return { status: 'ours' };
    if (lock.host !== host || pidAlive(lock.pid)) return { status: 'held', holder: lock };
    return 'stale'; // a dead pid on our own host
  }
  const mtimeMs = statMtimeOrNull(file);
  if (mtimeMs !== null && Date.now() - mtimeMs <= UNREADABLE_HELD_MS) return { status: 'held', holder: UNREADABLE_HOLDER };
  return 'stale'; // gone, or unreadable and old enough to be abandoned
}

export function acquireLock(dir: string, id: string, token: string, deps: LockDeps = {}): LockOutcome {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = lockPath(dir, id);
  const host = deps.host ?? os.hostname();
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const info: LockInfo = { pid: process.pid, host, token, at: new Date().toISOString() };

  if (writeLock(file, info)) return { status: 'acquired' };
  const first = classifyLock(file, token, host, pidAlive);
  if (first !== 'stale') return first;

  // Stale — take over, once.
  try { fs.unlinkSync(file); } catch { /* raced away already */ }
  if (writeLock(file, info)) return { status: 'acquired' };
  const second = classifyLock(file, token, host, pidAlive);
  // A second race in the same call is vanishingly rare; never falsely report
  // "acquired" when our own write did not actually land.
  return second === 'stale' ? { status: 'held', holder: readLock(file) ?? UNREADABLE_HOLDER } : second;
}

// Unlinks only when the token is ours — releasing a lock we do not hold would tear
// down someone else's ownership.
export function releaseLock(dir: string, id: string, token: string): void {
  const lock = readLock(lockPath(dir, id));
  if (lock?.token === token) { try { fs.unlinkSync(lockPath(dir, id)); } catch { /* already gone */ } }
}

// Read-only: whether a session's lock is currently held by a live process — ours or
// another's, this host or (as far as it can tell) a foreign one. Never creates,
// unlinks or otherwise touches the lock file; what `pruneSessions` uses to leave a
// still-open session alone.
function isLockHeld(dir: string, id: string): boolean {
  // No token of our own to check against — `''` never matches a real one, so
  // 'ours' reads the same as 'held' here: either way, something live owns it.
  return classifyLock(lockPath(dir, id), '', os.hostname(), defaultPidAlive) !== 'stale';
}

// One per chat instance, made once and kept for its life — not per process (see the
// section comment above).
export function makeLockToken(): string {
  return crypto.randomUUID();
}

// Read-only: whose a session is right now, for a list to say — `ours` (this token's),
// `held` (another live chat's, here or on another host), `free` (no lock, or a stale
// one). Never creates, unlinks or touches the lock file.
export type LockState = 'free' | 'ours' | 'held';
export function lockState(dir: string, id: string, token: string, deps: LockDeps = {}): LockState {
  const c = classifyLock(lockPath(dir, id), token, deps.host ?? os.hostname(), deps.pidAlive ?? defaultPidAlive);
  return c === 'stale' ? 'free' : c.status === 'held' ? 'held' : 'ours';
}

// Renames a session that no chat holds: the lock is taken for the write and released
// after it, so a process opening the session meanwhile waits for neither. A session
// another process holds is left alone (its next save would find the disk changed and
// fork), and so is this token's own — its chat writes its own title. `updatedAt` stays
// as it was: a rename does not move a session up the list. The write goes through
// `loadSession`/`saveSession`, as `closeSession` does, so it bumps `rev`.
export type RenameOutcome = 'renamed' | 'held' | 'ours' | 'missing';
export function renameSession(dir: string, id: string, title: string, token: string, deps: LockDeps = {}): RenameOutcome {
  const lock = acquireLock(dir, id, token, deps);
  if (lock.status === 'held') return 'held';
  if (lock.status === 'ours') return 'ours';
  try {
    const s = loadSession(dir, id);
    if (!s) return 'missing';
    saveSession(dir, { ...s, title: cutTitle(title) });
    return 'renamed';
  } finally {
    releaseLock(dir, id, token);
  }
}

// Deletes a session that no chat holds, and the lock taken to do it. A session another
// process holds, and this token's own, are never deleted.
export type RemoveOutcome = 'deleted' | 'held' | 'ours';
export function removeSession(dir: string, id: string, token: string, deps: LockDeps = {}): RemoveOutcome {
  const lock = acquireLock(dir, id, token, deps);
  if (lock.status === 'held') return 'held';
  if (lock.status === 'ours') return 'ours';
  try {
    deleteSession(dir, id);
    return 'deleted';
  } finally {
    releaseLock(dir, id, token);
  }
}

// "16:05" for today, "2026-09-20 16:05" for any other day.
export function sessionWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '?';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}
