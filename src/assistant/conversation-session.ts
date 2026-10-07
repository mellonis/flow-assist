// The session a conversation is saved as (src/assistant/sessions.ts): its id and its
// ownership lock, the state file and its fork, the journal (src/assistant/journal.ts).
// Functions over a Conversation, which holds the state; its methods call them.
import fs from 'node:fs';
import type { ToolRun } from './agent.js';
import { confirmFor, type ConfirmWrite } from './confirm-policy.js';
import { appendJournal, callEndEvent, callStartEvent, rowOf, type JournalEvent } from './journal.js';
import { createRecallState, saveRecallState } from './recall.js';
import {
  SESSION_VERSION, acquireLock, journalPath, newSessionId, projectHome, projectOf, releaseLock, saveSession,
  sessionFingerprint, sessionFingerprintsEqual, sessionTitle, type Session, type SessionFingerprint,
} from './sessions.js';
import { shellRoots } from './shell.js';
import { stripToolMarkup } from './tool-markup.js';
import type { ChatMessage } from './agent.js';
import type { ChatMsg } from './conversation-types.js';
import type { Conversation } from './conversation.js';

// The fingerprint of a session nothing has been read or written for yet — the value
// `sessionFingerprint` reads back for a file that does not exist.
export const NO_FILE: SessionFingerprint = { rev: 0, mtimeMs: 0, size: 0 };

// Something the person said or did: a message, or a `!command` they ran. A session
// with neither is not worth saving.
export const personSpoke = (role: string) => role === 'user' || role === 'shell';

// A session belongs to the project it started in (sessions.ts, `projectOf`), decided
// when it gets its id and kept for its life; its files live in that project's directory
// (`projectHome`). `homes` knows the directory of every session this conversation has
// held — a turn, a `!command` or a background task still writing to one it has left
// finds its journal by it.
const homeOf = (c: Conversation, id: string): string | null => c.homes.get(id) ?? null;

// Where the shell is now, as a project.
export const projectHere = (c: Conversation): string | null =>
  projectOf(c.shell.cwd(), shellRoots(c.deps.config() as Parameters<typeof shellRoots>[0]));

// The project the lists open on: this conversation's session's, once it has one; else
// where the shell is — the memory's, the workspace's and the lists' project.
// A child's is its parent's, whatever directory its shell moves to (`inheritedProject`).
export const currentProject = (c: Conversation): string | null =>
  (c.inheritedProject !== undefined ? c.inheritedProject : c.sessionId ? c.sessionProject : projectHere(c));

// A session gets its id — and its lock — when it first has something to keep: its
// first save, or the first thing its journal records. Its project is decided here too,
// from where the shell is at that moment, and never again.
export function ensureSessionId(c: Conversation): string {
  if (!c.sessionId) {
    c.sessionId = newSessionId(); c.createdAt = new Date().toISOString(); c.fingerprint = NO_FILE;
    // The project is the conversation's — its workspace and memory too — with or
    // without a sessions directory to keep it in.
    let project: string | null = null;
    try { project = projectHere(c); } catch { /* no project — the top level */ }
    c.sessionProject = project;
    const dir = c.deps.sessionsDir();
    if (dir) {
      const home = projectHome(dir, project);
      c.homes.set(c.sessionId, home);
      acquireLock(home, c.sessionId, c.deps.lockToken); // a fresh id — nothing else could hold it
    }
  }
  return c.sessionId;
}

export function releaseLockOf(c: Conversation): void {
  const home = homeOf(c, c.sessionId);
  if (home && c.sessionId) releaseLock(home, c.sessionId, c.deps.lockToken);
}

// What a save writes depends on whether anybody draws the conversation. With a port
// attached it is the list as the chat last drew it, and the draft the port holds. With
// none (a conversation kept loaded without a view) nothing draws, so the drawn list may
// lag a row that landed since: it is the conversation's own `messages`
// (`Conversation.currentRows`) and the draft it kept when it was detached.
export function snapshotSession(c: Conversation): Session {
  ensureSessionId(c);
  const rows = c.currentRows() as Record<string, unknown>[];
  if (!c.title) c.title = sessionTitle(rows);
  return {
    version: SESSION_VERSION, id: c.sessionId, title: c.title, createdAt: c.createdAt, updatedAt: new Date().toISOString(),
    messages: rows, api: c.api as unknown as Record<string, unknown>[],
    summary: c.summary, plan: c.plan.snapshot(), usage: c.usage,
    // What the field holds, as a session keeps it: a /command, a !command or a bang
    // level is being run, not drafted (the chat's `ViewPort.draft`).
    prompts: c.prompts.slice(-100), draft: c.port ? c.port.draft() : c.keptDraft,
    shellCwd: c.shell.saved(),
    tools: c.toolSet.names(),
    // Refs only — a path and a hash per image, never its bytes.
    images: [...c.images.values()], imageSeq: c.imageSeq,
    recall: saveRecallState(c.recall),
    closed: false, // written means in use — a resumed cleared session is open again
    project: c.sessionProject,
    ...(c.answeredAt ? { answeredAt: c.answeredAt } : {}),
    ...(c.seenAt ? { seenAt: c.seenAt } : {}),
  };
}

// ── The journal (src/assistant/journal.ts) ── one line per event, appended as it
// happens. Events before the session has an id (a note said at start, the memory note
// after /clear) wait in `journalBuf` for the first thing the person says or runs, which
// gives it one — a start with nothing said leaves no journal. A session opened from a
// state file with no journal beside it (saved before journals, or its journal swept by
// retention) brings the rows it holds into the journal it starts (`journalImport`),
// marked `imported`. `forkedTo` redirects an id a fork left to the fork. A child keeps
// no journal: its lines go through its `journalRoute` to its parent's.
export function journalTo(c: Conversation, from: string, ev: JournalEvent): void {
  if (c.journalRoute) { c.journalRoute(ev); return; }
  let id = from;
  for (let i = 0; i < 64 && c.forkedTo.has(id); i++) id = c.forkedTo.get(id)!;
  if (!c.deps.sessionsDir() || !id) return;
  const home = homeOf(c, id);
  if (!home) { c.deps.pushLog(`[session] journal not written: no directory known for ${id}`); return; }
  try { appendJournal(journalPath(home, id), ev); }
  catch (e) { c.deps.pushLog(`[session] journal not written: ${(e as Error).message}`); }
}

// `person` — the event is something the person said or ran (or the question a turn
// starts from): the session gets its id if it has none.
export function journal(c: Conversation, ev: JournalEvent, opts: { person?: boolean } = {}): string {
  if (c.journalRoute) { c.journalRoute(ev); return ''; }
  const dir = c.deps.sessionsDir();
  if (!dir) return '';
  const stamped = { ...ev, at: ev.at ?? new Date().toISOString() };
  if (!c.sessionId && !opts.person) { c.journalBuf.push(stamped); return ''; }
  const id = ensureSessionId(c);
  let fresh = false;
  try { fresh = !fs.existsSync(journalPath(homeOf(c, id) ?? dir, id)); } catch { /* an id that is not one — journalTo says so */ }
  if (fresh) {
    const imported = c.journalImport ?? [];
    journalTo(c, id, { t: 'start', id, ...(imported.length ? { continued: true } : {}) });
    for (const m of imported) { const row = rowOf(m, c.deps.viewRenderers()); if (row) journalTo(c, id, { ...row, imported: true }); }
  }
  c.journalImport = null;
  for (const held of c.journalBuf.splice(0)) journalTo(c, id, held);
  journalTo(c, id, stamped);
  return id;
}

// The host's LLM service as a tool is handed it — a plugin tool asking the model: the
// nested run's calls, their start, their y/n and their end, go into the journal of
// `from`'s session. (A background task is a conversation of its own and journals
// through its `journalRoute`, not through this.) Only a caller that passed a
// confirmation gets a y/n, journaled as its answer `by: 'plugin'`; with none, agentChat
// declines each write itself and the journal hears it as a declined call.
export function journaledChatLLM(c: Conversation, from: string) {
  return (messages: unknown[], opts: Record<string, any> = {}) => {
    const { confirmWrite: answer, ...rest } = opts;
    return c.deps.chatLLM(messages as ChatMessage[], {
      ...rest,
      onToolStart: (call: { id?: string; name: string; args: Record<string, unknown>; confirm: boolean }) => {
        journalTo(c, from, callStartEvent(call));
        rest.onToolStart?.(call);
      },
      onToolRun: (run: ToolRun) => {
        journalTo(c, from, callEndEvent(run, c.deps.viewRenderers()));
        rest.onToolRun?.(run);
      },
      ...(typeof answer === 'function' ? {
        confirmWrite: confirmFor({ kind: 'caller', confirm: answer as ConfirmWrite }, { conv: c, journalId: from }),
      } : {}),
    } as never);
  };
}

// A row the host says to the person: drawn and journaled.
export function pushNote(c: Conversation, content: string): void {
  journal(c, { t: 'row', role: 'note', text: content });
  c.setRows((cur) => [...cur, { role: 'note', content }]);
}

// The fork note's text.
const forkNoteText = (title: string, id: string): string =>
  `Session "${title || id}" was changed elsewhere — saved this conversation as a new session.`;

// `silent` — nothing shown, no notify — for the paths that write on the way out (exit,
// unmount): the screen is not going to be read again, though the fork itself (never
// overwrite what changed) still happens even there. A closed conversation saves nothing:
// the chat saved it before it closed it.
export function writeSession(c: Conversation, opts: { silent?: boolean } = {}): void {
  if (c.closed) return;
  if (c.saveTimer) { clearTimeout(c.saveTimer); c.saveTimer = null; }
  const dir = c.deps.sessionsDir();
  if (!dir || !c.currentRows().some((m) => personSpoke(m.role))) return; // nothing said or run yet
  try {
    const snap = snapshotSession(c);
    const home = homeOf(c, snap.id) ?? projectHome(dir, snap.project ?? null);
    const disk = sessionFingerprint(home, snap.id);
    if (!sessionFingerprintsEqual(disk, c.fingerprint)) {
      // Someone else changed this file since we last read or wrote it — an older host
      // with no lock, a hand edit (rev alone would miss a hand edit that leaves the
      // number untouched, or two foreign writes that both have no `rev` field at all).
      // Never overwrite what we have not seen: fork this conversation into a new
      // session instead.
      const forkedId = newSessionId();
      const now = new Date().toISOString();
      releaseLockOf(c);
      // The fork is the same conversation: the same project, the same directory.
      c.homes.set(forkedId, home);
      acquireLock(home, forkedId, c.deps.lockToken);
      const forked: Session = { ...snap, id: forkedId, createdAt: now, updatedAt: now };
      const fp = saveSession(home, forked);
      c.sessionId = forkedId; c.createdAt = now; c.fingerprint = fp;
      // The fork's journal begins with where it came from; what came before is in that
      // session's journal.
      journalTo(c, forkedId, { t: 'start', id: forkedId, parent: snap.id });
      c.forkedTo.set(snap.id, forkedId);
      const text = forkNoteText(snap.title, snap.id);
      if (!opts.silent) {
        pushNote(c, text);
        c.deps.notify();
      }
      return;
    }
    c.fingerprint = saveSession(home, snap);
  } catch (e) {
    c.deps.pushLog(`[session] not saved: ${(e as Error).message}`);
  }
}

// The save 250 ms after the last change: a burst of changes writes once, after the
// render that carries the change — the list is read as last drawn (`Conversation.rows`).
export function persist(c: Conversation): void {
  if (c.closed) return;
  if (c.saveTimer) clearTimeout(c.saveTimer);
  c.saveTimer = setTimeout(() => { c.saveTimer = null; writeSession(c); }, 250);
}

// The chat shows the session's end: an answer that came before now is seen, and the
// file says so at the next save.
export function markSeen(c: Conversation): void {
  if (!c.shows() || !c.answeredAt || c.seenAt >= c.answeredAt) return;
  c.seenAt = new Date().toISOString();
  persist(c);
}

// The model half of opening a saved session — the chat does its own half after it.
// `fingerprint` is the caller's — taken with a stat BEFORE the content in `s` was read,
// never re-derived here. Reading it fresh off the disk at this point (after `s` was
// already loaded) would leave a window: a foreign write landing between the two reads
// would then be recorded as "seen" even though `s` never saw it, and the next save would
// silently overwrite it. Taking the fingerprint first means a write in that window is
// instead caught — the next save finds the disk has moved and forks. `dir` — the
// directory the session's file was found in. The conversation it opens into is a new
// one (`/resume`), or the chat's first, which has shown nothing yet (the start); every
// field below is set from the file whole, never left to what the object was made with.
export function applySession(c: Conversation, s: Session, fingerprint: SessionFingerprint, dir: string): void {
  c.sessionId = s.id; c.createdAt = s.createdAt;
  c.homes.set(s.id, dir);
  c.sessionProject = s.project ?? null;
  c.journalBuf = []; // nothing held: the session's journal begins where its file left off
  // The session writes its own journal: no redirect of its id to a fork.
  c.forkedTo.delete(s.id);
  let journaled = true;
  try { journaled = !c.deps.sessionsDir() || fs.existsSync(journalPath(dir, s.id)); } catch { /* not an id — nothing to journal */ }
  c.journalImport = journaled ? null : (s.messages as Record<string, unknown>[]).filter((m) => m.role !== 'system');
  c.title = s.title;
  c.answeredAt = s.answeredAt ?? ''; c.seenAt = s.seenAt ?? '';
  markSeen(c); // opened where the conversation shows: its end is on screen
  c.fingerprint = fingerprint;
  c.api = s.api as unknown as ChatMessage[];
  // A summary saved with tool-call markup in it is read without it: it rides in every
  // later system context.
  c.summary = stripToolMarkup(s.summary ?? '');
  c.plan.load(s.plan);
  c.toolSet.load(s.tools);
  c.resetLiveViews(); // no live view tracked: the session's views are as saved
  c.resetImages(s.images ?? [], s.imageSeq ?? 0);
  c.recall = createRecallState(s.recall); // the ids are hashes: they still name the same items
  c.setAutoMode('ask'); // the mode is never saved: an opened session asks
  c.roundTools = false; // no round is being written
  c.usage = s.usage;
  c.prompts = s.prompts.slice();
  if (c.drawnRows) c.drawnRows = s.messages as ChatMsg[];
  c.setRows(s.messages as ChatMsg[]);
  // After the list is replaced, so the note the directory brings lands in it (said once
  // — a session that ends in the same note is left as it is). No note waits for a turn's
  // end: none runs.
  c.projectNote = null;
  c.project = { dir: '', root: null, files: [] };
  c.shell.setCwd(s.shellCwd ?? null);
  // What the session's commands told the model is told again.
  c.shell.told.clear();
}
