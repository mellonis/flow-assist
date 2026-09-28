// Which memory facts the host wrote itself. A fact's line rides in the system prompt of
// every later request in its scope (./memory-store.ts), and a command the model runs
// can write a file into `memory/` as well as anyone — past the `memory` tool and its
// guards, into every later session (the global scope: every project). So the host keeps,
// in its own state (`memory.accepted.json`, 0600), the hash of each fact file as it last
// wrote it — `addFact`, `saveFact`, whoever called them: the `memory` tool, the move of
// an older `memory.json`, a plugin's `services.memory` — or as the person accepted it.
// A fact whose file does not match is left out of the prompt and out of the tool's own
// list, and `/memory` shows it as `changed outside flow-assist`, with `/memory accept`.
//
// The index file, `MEMORY.md`, is never in the prompt — the prompt's index is built from
// the facts' own files each time — so only the facts are checked. The check is a hash of
// text the index build reads anyway, and one read of the record.
//
// The first check under a workspace root with no record (the first start after this was
// added, a new `workspace.dir`) accepts every fact file already under it, once. A host
// process started from a command the model runs (`FLOW_ASSIST_MODEL_SHELL=1`,
// src/config/load.ts) writes no record at all. Like the settings guard, this stops the
// accident, not intent: a command that rewrites or deletes the record can forge it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hostStateDir, inModelShell } from '../config/load.js';

export const memoryTrustPath = (): string => path.join(hostStateDir(), 'memory.accepted.json');

// `roots`: the workspace roots (real paths) whose facts were accepted once; `files`: a
// fact file's real path → the hash of the text the host wrote or the person accepted.
type MemoryRecord = { roots: Record<string, true>; files: Record<string, string> };

const INDEX = 'memory.md';
const WORKSPACE_LEAF = '_workspace';
const WALK_DEPTH = 64;

export const factHash = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

const realOr = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
// A fact file's key: its directory's real path and its own name (the file itself is
// never followed — a link in its place is not a fact).
const keyOf = (file: string): string => path.join(realOr(path.dirname(file)), path.basename(file));

function readRecord(): MemoryRecord {
  try {
    const v = JSON.parse(fs.readFileSync(memoryTrustPath(), 'utf8')) as Partial<MemoryRecord>;
    const obj = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
    return { roots: obj(v?.roots) as MemoryRecord['roots'], files: obj(v?.files) as MemoryRecord['files'] };
  } catch { return { roots: {}, files: {} }; }
}

function writeRecord(rec: MemoryRecord): void {
  const file = memoryTrustPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* unrecorded, the fact reads as changed outside until accepted */ }
}

// The host wrote this fact file, with this text.
export function recordFactFile(file: string, text: string): void {
  if (inModelShell()) return;
  const rec = readRecord();
  rec.files[keyOf(file)] = factHash(text);
  writeRecord(rec);
}

// The host removed this fact file.
export function forgetFactFile(file: string): void {
  const rec = readRecord();
  const key = keyOf(file);
  if (!(key in rec.files)) return;
  delete rec.files[key];
  writeRecord(rec);
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

// The first check under a root accepts what is there, once.
function acceptRootOnce(root: string, rec: MemoryRecord): void {
  const key = realOr(root);
  if (rec.roots[key] || inModelShell()) return;
  for (const f of factFilesUnder(root)) rec.files[f.key] = factHash(f.text);
  rec.roots[key] = true;
  writeRecord(rec);
}

// The facts of a workspace, each marked `outside` when its text is not what the host
// wrote or the person accepted. `root` is the workspace root it lies under.
// The root is accepted first even when this workspace holds nothing yet: a fact put
// under it later is then checked, not taken in by the first look.
export function markFacts<F extends { id: string; hash?: string; outside?: boolean }>(root: string, ws: string, facts: F[]): F[] {
  const rec = readRecord();
  acceptRootOnce(root, rec);
  if (!facts.length) return facts;
  const memDir = realOr(path.join(ws, 'memory'));
  return facts.map((f) => (f.hash !== undefined && rec.files[path.join(memDir, `${f.id}.md`)] === f.hash ? f : { ...f, outside: true }));
}

// The person accepts a fact changed outside flow-assist: its text as they were shown it.
export function acceptFact(ws: string, id: string, hash: string): boolean {
  if (inModelShell() || !hash) return false;
  const rec = readRecord();
  rec.files[path.join(realOr(path.join(ws, 'memory')), `${id}.md`)] = hash;
  writeRecord(rec);
  return true;
}
