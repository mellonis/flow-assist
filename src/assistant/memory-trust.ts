// Which memory facts the host wrote itself. A fact's line rides in the system prompt of
// every later request in its scope (./memory-store.ts), and a command the model runs
// can write a file into `memory/` as well as anyone — past the `memory` tool and its
// guards, into every later session (the global scope: every project). So the host keeps,
// in its own state (`memory.accepted.json`, 0600), the hash of each fact file as it last
// wrote it — `addFact`, `saveFact`, whoever called them: the `memory` tool, a plugin's
// `services.memory` — or as the person accepted it.
// A fact whose file does not match is left out of the prompt and out of the tool's own
// list, and `/memory` shows it as `changed outside flow-assist`, with `/memory accept`.
//
// The index file, `MEMORY.md`, is never in the prompt — the prompt's index is built from
// the facts' own files each time — so only the facts are checked. The check is a hash of
// text the index build reads anyway, and one read of the record.
//
// The first start — the record MISSING, or written by the host before its first look,
// found by the chat's start-up pass (`firstStart`, never an index build) — accepts every
// fact file already under the workspace root, once, and the record then says so: a workspace root seen for the first time after that (a new `workspace.dir`)
// starts with nothing accepted. A record that cannot be read accepts nothing, and the
// start screen says so. An older host's `memory.json` is moved into files without
// recording them: its facts are accepted only when the move is part of the first start —
// a `memory.json` that turns up later is a file anyone could have written, and its facts
// wait for `/memory accept`. A host
// process started from a command the model runs (`FLOW_ASSIST_MODEL_SHELL=1`,
// src/config/load.ts) writes no record at all. Like the settings guard, this stops the
// accident, not intent: a command that rewrites or deletes the record can forge it (a
// deleted one makes the next start a first start).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hostStateDir, inModelShell } from '../config/load.js';

export const memoryTrustPath = (): string => path.join(hostStateDir(), 'memory.accepted.json');

// `firstStartDone`: whether the first start's pass ran; `files`: a fact file's real path
// → the hash of the text the host wrote or the person accepted.
type MemoryRecord = { firstStartDone: boolean; files: Record<string, string> };
// `pending`: written by the host (its own fact writes) before the start's first pass.
type RecordState = 'missing' | 'pending' | 'ok' | 'unreadable';

const INDEX = 'memory.md';
const WORKSPACE_LEAF = '_workspace';
const WALK_DEPTH = 64;

export const factHash = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

const realOr = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
// A fact file's key: its directory's real path and its own name (the file itself is
// never followed — a link in its place is not a fact).
const keyOf = (file: string): string => path.join(realOr(path.dirname(file)), path.basename(file));
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// Only ENOENT is a first start; anything that does not parse to the record's shape is
// unreadable, and accepts nothing.
function readRecord(): { state: RecordState; rec: MemoryRecord } {
  const empty = (): MemoryRecord => ({ firstStartDone: false, files: {} });
  let raw: string;
  try { raw = fs.readFileSync(memoryTrustPath(), 'utf8'); } catch (e) {
    return { state: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable', rec: empty() };
  }
  try {
    const v = JSON.parse(raw) as unknown;
    if (!isMap(v) || typeof v.firstStartDone !== 'boolean' || !isMap(v.files) || Object.values(v.files).some((h) => typeof h !== 'string')) return { state: 'unreadable', rec: empty() };
    const rec = { firstStartDone: v.firstStartDone, files: v.files as Record<string, string> };
    return { state: rec.firstStartDone ? 'ok' : 'pending', rec };
  } catch { return { state: 'unreadable', rec: empty() }; }
}

// An unreadable record is kept beside it before a new one takes its place — from then on
// holding only what the host writes and the person accepts.
function writeRecord(rec: MemoryRecord, state: RecordState): void {
  const file = memoryTrustPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (state === 'unreadable') {
      try { fs.renameSync(file, `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`); } catch { /* gone meanwhile */ }
      rec.firstStartDone = true;
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* unrecorded, the fact reads as changed outside until accepted */ }
}

// The host wrote this fact file, with this text.
export function recordFactFile(file: string, text: string): void {
  if (inModelShell()) return;
  const { state, rec } = readRecord();
  rec.files[keyOf(file)] = factHash(text);
  writeRecord(rec, state);
}

// The host removed this fact file.
export function forgetFactFile(file: string): void {
  const { state, rec } = readRecord();
  const key = keyOf(file);
  if (state === 'unreadable' || !(key in rec.files)) return;
  delete rec.files[key];
  writeRecord(rec, state);
}

// Every fact file under a workspace root: `<…>/_workspace/memory/<id>.md`, the index and
// links left out, no link followed on the way.
function factFilesUnder(root: string): Array<{ key: string; text: string }> {
  const out: Array<{ key: string; text: string }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > WALK_DEPTH) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = path.join(dir, e.name);
      if (e.name !== WORKSPACE_LEAF) { walk(sub, depth + 1); continue; }
      const mem = path.join(sub, 'memory');
      let names: fs.Dirent[];
      try {
        if (!fs.lstatSync(mem).isDirectory()) continue;
        names = fs.readdirSync(mem, { withFileTypes: true });
      } catch { continue; }
      const realMem = realOr(mem);
      for (const n of names) {
        if (!n.isFile() || !n.name.endsWith('.md') || n.name.toLowerCase() === INDEX) continue;
        try { out.push({ key: path.join(realMem, n.name), text: fs.readFileSync(path.join(mem, n.name), 'utf8') }); } catch { /* unreadable — not a fact */ }
      }
    }
  };
  walk(root, 0);
  return out;
}

// Whether the first start's pass is still to run (the record missing).
export function firstStartPending(): boolean {
  const { state } = readRecord();
  return state === 'missing' || state === 'pending';
}

// The first start: every fact under the root is accepted, once — not from a command the
// model runs, and not over a record that cannot be read.
export function firstStart(root: string): void {
  const { state, rec } = readRecord();
  runFirstStart(root, state, rec);
}
function runFirstStart(root: string, state: RecordState, rec: MemoryRecord): void {
  if ((state !== 'missing' && state !== 'pending') || inModelShell()) return;
  for (const f of factFilesUnder(root)) rec.files[f.key] = factHash(f.text);
  rec.firstStartDone = true;
  writeRecord(rec, state);
}

// What is said of the record: at `start` (the start screen) a missing one — this start
// is the first, and accepts what is stored — or one that cannot be read; `later` (the
// chat, after the start's pass) a missing one, which accepts nothing until the next start.
export function memoryRecordNotes(when: 'start' | 'later' = 'start'): string[] {
  const { state } = readRecord();
  if (state === 'unreadable') return [`${memoryTrustPath()} cannot be read — no memory fact is sent; /memory lists them and /memory accept sends one again (the file is then replaced, its old text kept beside it)`];
  if (inModelShell()) return [];
  // A record the host started before any first pass says the same at a start: this
  // start is the first, whoever deleted the one before.
  if (when === 'start' && state === 'pending') return [`${memoryTrustPath()} has had no first start yet — this start accepts every memory fact stored now, as a first start does`];
  if (state !== 'missing') return [];
  return when === 'start'
    ? [`${memoryTrustPath()} is missing — this start accepts every memory fact stored now, as a first start does`]
    : [`${memoryTrustPath()} is missing — no memory fact is sent until the next start, which accepts every fact stored then; /memory lists them`];
}

// The facts of a workspace, each marked `outside` when its text is not what the host
// wrote or the person accepted. The first start never runs here — only in the start's
// own pass (`firstStart`) — so a record that goes missing while the app runs accepts
// nothing: its facts wait for the next start, which the start screen names.
export function markFacts<F extends { id: string; hash?: string; outside?: boolean }>(ws: string, facts: F[]): F[] {
  const { state, rec } = readRecord();
  return compare(ws, facts, state === 'ok' || state === 'pending' ? rec : null);
}

// The same marks with no first start run — for MEMORY.md, written after the host's own
// writes.
export function acceptedOnly<F extends { id: string; hash?: string; outside?: boolean }>(ws: string, facts: F[]): F[] {
  const { state, rec } = readRecord();
  return compare(ws, facts, state === 'ok' || state === 'pending' ? rec : null).filter((f) => !f.outside);
}

function compare<F extends { id: string; hash?: string; outside?: boolean }>(ws: string, facts: F[], rec: MemoryRecord | null): F[] {
  if (!facts.length) return facts;
  const memDir = realOr(path.join(ws, 'memory'));
  return facts.map((f) => (rec && f.hash !== undefined && rec.files[path.join(memDir, `${f.id}.md`)] === f.hash ? f : { ...f, outside: true }));
}

// The person accepts a fact changed outside flow-assist: the text they were shown, by
// its hash (the caller checks it is still the file's).
export function acceptFact(ws: string, id: string, hash: string): boolean {
  if (inModelShell() || !hash) return false;
  const { state, rec } = readRecord();
  rec.files[path.join(realOr(path.join(ws, 'memory')), `${id}.md`)] = hash;
  writeRecord(rec, state);
  return true;
}
