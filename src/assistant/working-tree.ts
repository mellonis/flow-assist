// The working tree as the `/diff` panel shows it: every change under the given roots,
// one section per baseline.
//
// The host core does not run git. This module is the one deliberate exception, and it
// is READ-ONLY: `git status` and `git diff` under a root, nothing else. What writes
// the tree stays in the `repo` plugin, behind the person's confirmation.
//
// The module is pure of the app: it takes the roots it is handed, answers a plain list,
// and imports no React. The one thing it reads from the host is `hostStateDir()`, where
// the snapshot store lives. Every path it reads from a root is held to that root by REAL
// path, so a link in a clone cannot carry the panel out of the person's work.
//
// Two baselines meet here:
//   - a git top — the root itself, a repository above it, or one nested under it — is
//     diffed against HEAD; a nested repository beats anything else for its own paths;
//   - the paths of a root that no git top claims are diffed against the root's
//     persistent snapshot (`snapshotSection`, below).
//
// A git that is missing, or that fails on one top, never throws out of here: that top
// contributes no section and the root falls back to its snapshot.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hostStateDir } from '../config/load.js';
import { unifiedDiff } from './diff.js';
import { gitRootOf } from './sessions.js';
import { realOf, within } from './shell.js';

export interface FileDiff {
  status: 'A' | 'M' | 'D';
  path: string; // relative to the section's root, '/'-separated
  added: number;
  removed: number;
  hunks: string; // the unified diff text; '' for binary / too large
  note?: 'binary' | 'too large';
}

export interface DiffSection {
  root: string; // the root directory the section is under, by its REAL path
  baseline: 'head' | 'snapshot';
  label: string; // 'vs HEAD', or 'vs snapshot (taken <date>)'
  files: FileDiff[];
}

// What the panel keys its cursor and its opened blocks by. A bare path repeats across
// roots (`src/index.ts` is in every project), and a section's paths are relative to
// its root, so the root is part of the name.
export const diffFileKey = (root: string, p: string): string => root + '\u0000' + p;

// A git call that has not answered by now is not going to: the panel is asking about
// the person's own machine, and a stuck index lock must not hang the chat.
const GIT_TIMEOUT_MS = 10_000;
// How much of one git answer is kept. A diff past this is not a diff anyone reads;
// the section is dropped rather than the frame frozen by its size.
const GIT_MAX_BYTES = 16 * 1024 * 1024;
const GIT_STDERR_MAX = 4 * 1024;
// A file is read whole for its diff; anything bigger is named and not shown.
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// How far below a root a nested repository is looked for.
const MAX_TOP_DEPTH = 8;
// Entry names the walk never enters: git's own directory, and the one tree that is
// never part of a person's change.
const SKIPPED = new Set(['.git', 'node_modules']);
// The panel shows a file whole — it is a reader, not a summary.
const FULL_DIFF = { context: 3, maxLines: Number.MAX_SAFE_INTEGER } as const;

// `runGit` as `plugins-available/repo/src/tools.ts` starts git: no shell, 'git' and its
// arguments, stderr collected, a non-zero exit rejecting. The additions here are the
// time limit and the output cap, since this runs while a screen is drawn.
function runGit(dir: string, argv: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', dir, ...argv], { shell: false });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const fail = (message: string) => settle(() => {
      try { child.kill('SIGKILL'); } catch { /* it ended on its own */ }
      reject(new Error(message));
    });
    timer = setTimeout(() => fail(`git: no answer in ${GIT_TIMEOUT_MS / 1000} s`), GIT_TIMEOUT_MS);
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > GIT_MAX_BYTES) { fail('git: output too large'); return; }
      chunks.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < GIT_STDERR_MAX) stderr += chunk.toString('utf8');
    });
    child.on('error', (e) => fail(`git: ${e.message}`));
    child.on('close', (code) => settle(() => {
      if (code === 0) { resolve(Buffer.concat(chunks)); return; }
      reject(new Error(`git ${code}: ${(stderr || Buffer.concat(chunks).toString('utf8')).trim().slice(0, 300)}`));
    }));
  });
}

type TextRead = { text: string; bytes?: Buffer } | { note: 'binary' | 'too large' } | null;

// Bytes as the text a diff shows; a NUL or a byte sequence that is not UTF-8 is a
// binary file, and a text that big is not read at all.
function decodeText(buf: Buffer): TextRead {
  if (buf.length > MAX_FILE_BYTES) return { note: 'too large' };
  if (buf.includes(0)) return { note: 'binary' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf) }; }
  catch { return { note: 'binary' }; }
}

// One file of the working tree, as a diff sees it. A link is not followed for its
// content: git records the LINK TARGET as the file's text, and reading through it
// would put a file of somebody else's into the panel. `null` — nothing readable here
// (gone, a directory, or a real location outside the root). A text read keeps its
// raw bytes, so a caller can compare content without encoding it again.
async function readWorkingFile(abs: string, root: string): Promise<TextRead> {
  let st: fs.Stats;
  try { st = await fs.promises.lstat(abs); } catch { return null; }
  if (st.isSymbolicLink()) {
    try { return { text: await fs.promises.readlink(abs) }; } catch { return null; }
  }
  if (!st.isFile()) return null;
  if (!within(realOf(abs), root)) return null;
  if (st.size > MAX_FILE_BYTES) return { note: 'too large' };
  let buf: Buffer;
  try { buf = await fs.promises.readFile(abs); } catch { return null; }
  const read = decodeText(buf);
  return read && 'text' in read ? { text: read.text, bytes: buf } : read;
}

// A file's text in HEAD, for a deletion's removed lines. `null` — HEAD has no such
// file (an addition deleted before it was ever committed) or git cannot hand it over.
async function headFile(top: string, p: string): Promise<TextRead> {
  const spec = `HEAD:${p}`;
  let size: number;
  try { size = Number((await runGit(top, ['cat-file', '-s', spec])).toString('utf8').trim()); } catch { return null; }
  if (!Number.isFinite(size)) return null;
  if (size > MAX_FILE_BYTES) return { note: 'too large' };
  try { return decodeText(await runGit(top, ['cat-file', 'blob', spec])); } catch { return null; }
}

interface StatusEntry {
  code: string; // `XY` of `git status --porcelain`
  path: string; // relative to the top; for a rename, the NEW path
}

// `--porcelain -z` entries: `XY <path>` NUL-separated, so a path is never C-quoted.
// A rename or a copy occupies two entries — its new path, then the old one — and the
// old one is dropped: the panel shows the file where it is now.
function parseStatus(raw: string): StatusEntry[] {
  const parts = raw.split('\u0000');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part) continue;
    const code = part.slice(0, 2);
    const entry: StatusEntry = { code, path: part.slice(3) };
    if (code.includes('R') || code.includes('C')) i++; // the old path follows
    entries.push(entry);
  }
  return entries;
}

// git's two status letters as the panel's three: a file that is new in either the
// index or the tree is added, one that is gone from the tree is deleted, everything
// else — modified, renamed, copied, type-changed, unmerged — is modified.
function statusOf(code: string): 'A' | 'M' | 'D' {
  if (code === '??') return 'A';
  const [x, y] = [code[0], code[1]];
  if (y === 'D' || x === 'D') return 'D';
  if (x === 'A') return 'A';
  return 'M';
}

// One file's part of `git diff HEAD`: the hunks without git's own preamble
// (`diff --git`, `index`, `---`, `+++`), an `@@` row and its body being what the panel
// draws — the same shape `unifiedDiff` answers with. Counted from the body: a header
// can never be taken for a changed line.
function segmentOf(diff: string): { hunks: string; added: number; removed: number; binary: boolean } {
  if (/^Binary files .* differ$/m.test(diff) || diff.includes('GIT binary patch')) return { hunks: '', added: 0, removed: 0, binary: true };
  const lines = diff.split('\n');
  const first = lines.findIndex((l) => l.startsWith('@@ '));
  if (first < 0) return { hunks: '', added: 0, removed: 0, binary: false };
  const body = lines.slice(first).filter((l) => l !== '');
  let added = 0;
  let removed = 0;
  for (const line of body) {
    if (line.startsWith('@@ ')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { hunks: body.join('\n'), added, removed, binary: false };
}

// The new path of a `diff --git a/<old> b/<new>` header. git prefixes are forced on
// the command line, so the shape is fixed; a path git had to C-quote (a control
// character in the name) does not match, and that file is diffed on its own instead.
function headerPath(line: string): string | null {
  const at = line.lastIndexOf(' b/');
  return at < 0 ? null : line.slice(at + 3);
}

// `git diff HEAD` split per file: the footprint git reports for a path is the hunks
// under its `diff --git` header. A rename's segment is filed under the NEW path.
function splitDiff(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  let key: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (key !== null && lines.length) out.set(key, lines.join('\n'));
    lines = [];
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      key = headerPath(line);
    } else if (key !== null) {
      lines.push(line);
    }
  }
  flush();
  return out;
}

const GIT_DIFF_ARGS = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD', '--'];

// A path handed to git as a pathspec, read as the one file or directory it names. A
// plain pathspec takes `*` and `?` as wildcards (brackets are literal to git), so a root
// or a file called `w*` would name every sibling that the star matches — the batch then
// diffs more of the tree than the section holds, and a per-file call after a failed batch
// would draw a sibling's hunks under this file's row.
const literalPath = (rel: string): string => (rel === '.' ? '.' : `:(literal)${rel}`);

// Whether HEAD names a commit. A repository with nothing committed has no HEAD, and
// `git diff HEAD` would fail on it; its files are all untracked and are diffed from
// empty text anyway.
async function hasHead(top: string): Promise<boolean> {
  try { await runGit(top, ['rev-parse', '--verify', '--quiet', 'HEAD']); return true; } catch { return false; }
}

// Whether a path a status entry names is a directory on disk. A nested repository
// staged as a gitlink, or an untracked one git collapses to `sub/`, is a DIRECTORY:
// the walk has a section of its own for it, and a folder drawn in its parent as an
// added file with no diff is a phantom. A link is not a directory here — git keeps a
// link's target as its text, and it is a file of the tree.
function isDirectory(abs: string): boolean {
  try { return fs.lstatSync(abs).isDirectory(); } catch { return false; }
}

// Whether a modified file is past the size the panel reads. A modification is diffed
// by git, whose hunks are as big as the change: a lockfile or a generated dump of a
// few megabytes is not something to carry through every refresh, so it is named and
// not shown, as an added or a deleted file of that size is. A file gone from the disk
// (a deletion the status has not caught up with) is not this check's business.
function pastReadSize(abs: string, root: string): boolean {
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch { return false; }
  if (!st.isFile() || !within(realOf(abs), root)) return false;
  return st.size > MAX_FILE_BYTES;
}

// One file of a git top, as its own diff. An addition (staged or untracked) is diffed
// from empty text and a deletion to empty text, so both read the way the panel draws
// any other change; a modification is git's own diff of it.
async function oneFile(root: string, top: string, entry: StatusEntry, status: 'A' | 'M' | 'D', segments: Map<string, string>, head: boolean): Promise<Omit<FileDiff, 'path' | 'status'>> {
  if (status === 'A') {
    const read = await readWorkingFile(path.resolve(top, entry.path), root);
    if (read && 'note' in read) return { added: 0, removed: 0, hunks: '', note: read.note };
    const d = unifiedDiff('', read ? read.text : '', FULL_DIFF);
    return { added: d.added, removed: d.removed, hunks: d.diff };
  }
  if (status === 'D') {
    if (!head) return { added: 0, removed: 0, hunks: '' };
    const read = await headFile(top, entry.path);
    if (read && 'note' in read) return { added: 0, removed: 0, hunks: '', note: read.note };
    const d = unifiedDiff(read ? read.text : '', '', FULL_DIFF);
    return { added: d.added, removed: d.removed, hunks: d.diff };
  }
  if (pastReadSize(path.resolve(top, entry.path), root)) return { added: 0, removed: 0, hunks: '', note: 'too large' };
  const own = segments.get(entry.path);
  const diff = own ?? (await runGit(top, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', 'HEAD', '--', literalPath(entry.path)])).toString('utf8');
  const seg = segmentOf(diff);
  return { added: seg.added, removed: seg.removed, hunks: seg.hunks, ...(seg.binary ? { note: 'binary' as const } : {}) };
}

// One git top's section: everything changed under `root` that belongs to `top`.
// A nested repository is left to the section the walk gives it — git reports it as a
// `sub/` entry or a staged gitlink, and it is a folder either way, never a file of
// this top. `null` — nothing changed there, so there is nothing to draw.
async function headSection(root: string, top: string, tops: string[]): Promise<DiffSection | null> {
  // Repositories nested INSIDE this top own their paths. A top above it owns `top`
  // itself and must not swallow what is inside.
  const nested = tops.filter((t) => t !== top && within(t, top));
  const changed = parseStatus((await runGit(top, ['status', '--porcelain', '-z', '--untracked-files=all'])).toString('utf8'))
    .map((entry) => ({ entry, abs: path.resolve(top, entry.path) }))
    // Only what the root holds: a repository above it carries paths of its own too.
    .filter(({ abs }) => abs !== root && within(abs, root))
    // Only what this top holds: a path at or under another one is that one's.
    .filter(({ abs }) => !nested.some((t) => within(abs, t)))
    .filter(({ abs }) => !isDirectory(abs));
  if (!changed.length) return null;
  const head = await hasHead(top);
  // The batch is scoped to the root's part of the tree — a root deep inside a large
  // repository would otherwise diff that entire repository on every refresh, and a top
  // nested under the root is wholly the root's part — and it is what makes a
  // modification cheap: one git call for the tree instead of one per file. Its failure
  // is not the section's either: `oneFile` diffs a file with no segment on its own, so
  // one failed batch costs per-file calls, never the section's hunks.
  const scope = within(root, top) ? path.relative(top, root) || '.' : '.';
  let segments = new Map<string, string>();
  if (head) {
    try { segments = splitDiff((await runGit(top, [...GIT_DIFF_ARGS, literalPath(scope)])).toString('utf8')); } catch { /* per file, below */ }
  }
  const files: FileDiff[] = [];
  for (const { entry, abs } of changed) {
    const status = statusOf(entry.code);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    files.push({ status, path: rel, ...(await oneFile(root, top, entry, status, segments, head)) });
  }
  return { root, baseline: 'head', label: 'vs HEAD', files };
}

interface RootScan {
  tops: string[]; // absolute, real; the nearest repository above the root first
  files: string[]; // root-relative paths no git top claims
}

// What a root is made of: its git tops and the paths left over for the snapshot.
// The walk is a readdir tree, sorted so the section order is the same on every look;
// a link is never followed, `.git` and `node_modules` are never entered, a nested
// repository is a top of its own and is not looked into, and the search stops
// `MAX_TOP_DEPTH` directories below the root. A repository at or above the root
// claims every path under it, so no file is collected then. The walk yields the loop
// every `SNAPSHOT_YIELD_EVERY` entries, so a refresh a second apart never holds a frame.
async function scanRoot(root: string): Promise<RootScan> {
  const tops: string[] = [];
  const files: string[] = [];
  const fromAbove = gitRootOf(root);
  if (fromAbove) tops.push(fromAbove);
  const claimed = fromAbove !== null;
  // `.git` as a directory is a repository and as a file a worktree; either way the
  // entry's presence makes a top. It is asked with `stat`, so a link is read as what it
  // leads to: one that leads nowhere names no repository. An entry that cannot be
  // looked at is none.
  const isTop = async (abs: string): Promise<boolean> => {
    try { await fs.promises.stat(path.join(abs, '.git')); return true; } catch { return false; }
  };
  let examined = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (++examined % SNAPSHOT_YIELD_EVERY === 0) await yieldToLoop();
      if (SKIPPED.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (await isTop(abs)) { tops.push(abs); continue; }
        if (depth < MAX_TOP_DEPTH) await walk(abs, depth + 1);
        continue;
      }
      if (!claimed) files.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  await walk(root, 0);
  return { tops, files };
}

// ── the snapshot baseline ────────────────────────────────────────────────────
// A root outside git still carries dirt that was there before the session began,
// and a baseline taken when the panel opens would draw that dirt as "unchanged"
// exactly when the panel first looks at it. So each root's baseline is captured
// ONCE and kept on the host's disk: content-addressed blobs plus one index per
// root. Everything after the capture shows; nothing before it can.
// A file that is indexed is read whole for its hash, so one capture stops at this
// count rather than hashing a whole workspace's tree. `snapshotMaxFiles` is the live
// ceiling; `setSnapshotMaxFilesForTests` is the only thing that moves it.
const SNAPSHOT_MAX_FILES = 20_000;
let snapshotMaxFiles = SNAPSHOT_MAX_FILES;

// Test-only: exercise the cap without putting twenty thousand files on disk. The
// module's public answer never reads it.
export function setSnapshotMaxFilesForTests(n: number): void { snapshotMaxFiles = n; }

// A blob's name: the sha-256 of its bytes. The index is the only thing that decides
// what a hash is used as a filename, so it is held to that shape before the store is
// asked to open anything.
const SNAPSHOT_HASH = /^[0-9a-f]{64}$/;

// A walk this long runs between two paints unless it lets the loop breathe: a file's
// read is awaited, and every `SNAPSHOT_YIELD_EVERY` entries the walk waits a macrotask
// so a frame drawn by the caller can be shown while the baseline is captured.
const SNAPSHOT_YIELD_EVERY = 100;
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Names the snapshot leaves alone wherever they turn up. The system's own directory
// droppings are never a person's change, and `.gitignore` means nothing outside a
// repository, so no ignore file is read here.
const JUNK = new Set(['.DS_Store']);

interface SnapshotIndex {
  root: string; // the root's REAL path
  taken: number; // when the baseline was captured, ms since the epoch
  truncated: boolean; // the capture left files out: it reached `SNAPSHOT_MAX_FILES`, or a directory would not be read
  files: Record<string, string>; // root-relative '/'-path → sha-256 hex of the file's bytes
}

const hex = (buf: Buffer | string): string => crypto.createHash('sha256').update(buf).digest('hex');

// One root's store. `hostStateDir` is not a constant — under `bun test` it is a
// temporary directory made per process — so it is resolved on every call.
const snapshotDir = (root: string): string => path.join(hostStateDir(), 'snapshot', hex(root).slice(0, 16));

// The index on disk, or `null` when there is none or it no longer parses. An index is
// trusted only for the root it names: a copied or hand-edited one could otherwise
// compare one tree's bytes with another's. A root's id is fixed, so a bad index is the
// only way to get a `null` here once a capture has run — and the caller captures again.
function readIndex(dir: string, root: string): SnapshotIndex | null {
  let raw: string;
  try { raw = fs.readFileSync(path.join(dir, 'index.json'), 'utf8'); } catch { return null; }
  try {
    const parsed = JSON.parse(raw) as Partial<SnapshotIndex> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.root !== root) return null;
    if (typeof parsed.taken !== 'number' || !Number.isFinite(parsed.taken)) return null;
    if (typeof parsed.truncated !== 'undefined' && typeof parsed.truncated !== 'boolean') return null;
    if (!parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) return null;
    // A null-prototype map, so a file whose name is `toString`, `valueOf` or
    // `__proto__` is an entry of its own rather than a member the prototype answers
    // for — and so a path named `__proto__` is stored at all.
    const files: Record<string, string> = Object.create(null);
    for (const [rel, hash] of Object.entries(parsed.files)) {
      // A hash names a file in this directory; anything else is not an index we trust.
      if (typeof hash !== 'string' || !SNAPSHOT_HASH.test(hash)) return null;
      files[rel] = hash;
    }
    return { root, taken: parsed.taken, truncated: parsed.truncated === true, files };
  } catch { return null; }
}

// The index is replaced through a temp file in its own directory, so a reader never
// sees half of one. The blobs are written before it, so an index never names bytes
// that are not there.
function writeIndex(dir: string, index: SnapshotIndex): void {
  const tmp = path.join(dir, `.index-${process.pid}-${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(index), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, 'index.json'));
}

// A blob's text as a diff shows it. `null` — the store does not hold those bytes.
// The hash is checked again here, so no caller can turn an index value into a path.
async function blobText(dir: string, hash: string): Promise<TextRead> {
  if (!SNAPSHOT_HASH.test(hash)) return null;
  try { return decodeText(await fs.promises.readFile(path.join(dir, hash))); } catch { return null; }
}

// One root's baseline: every regular file the walk meets, hashed, up to
// `snapshotMaxFiles`. A link is never followed — its target may be somebody else's
// file — and a file over `MAX_FILE_BYTES` is left out of the index: the diff names it
// without reading it and cannot show it. A capture that stopped at the cap, or could
// not read a directory, records `truncated`, and the diff then draws no addition for a
// path the index does not name: an incomplete baseline cannot tell a new file from one
// it left out.
async function captureSnapshot(root: string, dir: string): Promise<SnapshotIndex | null> {
  const files: Record<string, string> = Object.create(null);
  const cap = snapshotMaxFiles;
  let count = 0;
  let examined = 0;
  let truncated = false;
  const walk = async (d: string): Promise<void> => {
    if (count >= cap) return;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch (e) {
      // A directory that is there and could not be read holds files the baseline never
      // saw, and an index that did not record them would draw them as additions that
      // were always there. One that vanished between two listings — `ENOENT`, or a path
      // that is no longer a directory — lost the baseline nothing.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') truncated = true;
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      // An entry reached with the cap full is a file the baseline will not hold.
      if (count >= cap) { truncated = true; return; }
      if (++examined % SNAPSHOT_YIELD_EVERY === 0) await yieldToLoop();
      if (SKIPPED.has(e.name) || JUNK.has(e.name) || e.isSymbolicLink()) continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { await walk(abs); continue; }
      if (!e.isFile()) continue;
      let st: fs.Stats;
      try { st = await fs.promises.lstat(abs); } catch { continue; }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      if (!within(realOf(abs), root)) continue;
      let bytes: Buffer;
      try { bytes = await fs.promises.readFile(abs); } catch { continue; }
      const hash = hex(bytes);
      const blob = path.join(dir, hash);
      // A blob is published whole: its bytes go to a temp name in the store's own
      // directory, and only a complete file ever appears under the hash. A reader that
      // indexed a half-written blob would keep that hash for good.
      const tmp = path.join(dir, `.blob-${process.pid}-${crypto.randomUUID()}.tmp`);
      try {
        await fs.promises.writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
        try {
          await fs.promises.link(tmp, blob);
        } catch (e) {
          // A blob already published under its hash is the same bytes, and is kept as it
          // stands. Any other failure means a store without hard links (a link is
          // refused, or the directory does not take one): a rename publishes the
          // complete file just as well, and whatever else it throws leaves this file out
          // of the index rather than under a name its bytes do not fill.
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') await fs.promises.rename(tmp, blob);
        }
      } catch { continue; } finally {
        // The temp name never outlives the attempt, whatever it ended in.
        await fs.promises.unlink(tmp).catch(() => {});
      }
      files[path.relative(root, abs).split(path.sep).join('/')] = hash;
      count++;
    }
  };
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    await walk(root);
    const index: SnapshotIndex = { root, taken: Date.now(), truncated, files };
    writeIndex(dir, index);
    return index;
  } catch { return null; }
}

// One capture per root at a time: the walk is the expensive part, and the panel may
// ask on a key press while it is already running.
const capturing = new Map<string, Promise<SnapshotIndex | null>>();

// Captures the root's baseline, or answers the one it already has: the first capture
// sticks across refreshes, sessions and restarts, so a file that was dirty before the
// panel was ever opened is still reviewed against what it held then. `null` — the
// root is not a directory, or its store cannot be written.
export async function ensureSnapshot(root: string): Promise<{ taken: number } | null> {
  let real: string;
  let st: fs.Stats;
  try {
    real = fs.realpathSync(root);
    st = fs.statSync(real);
  } catch { return null; }
  if (!st.isDirectory()) return null;
  const dir = snapshotDir(real);
  const existing = readIndex(dir, real);
  if (existing) return { taken: existing.taken };
  let job = capturing.get(real);
  if (!job) {
    job = captureSnapshot(real, dir).finally(() => capturing.delete(real));
    capturing.set(real, job);
  }
  const made = await job;
  return made ? { taken: made.taken } : null;
}

// The baseline's date as the section's label says it, in the person's own time zone.
function snapshotDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// One current file against the index. `null` — unchanged, or not a file the snapshot
// sees at all (a link, a junk name, no longer there).
async function snapshotFile(root: string, dir: string, index: SnapshotIndex, rel: string): Promise<FileDiff | null> {
  const known = index.files[rel];
  // A path the capture never reached is not a change: whether it is new or was left
  // out at the cap cannot be told from a truncated index, so it is not drawn as one.
  if (known === undefined && index.truncated) return null;
  const status: 'A' | 'M' = known === undefined ? 'A' : 'M';
  // The module's one read of a working file: the real-path guard, the link rule and
  // the size cap all come from there, and the reader's own note says what it found.
  const read = await readWorkingFile(path.resolve(root, rel), root);
  if (!read) return null;
  if ('note' in read) {
    // A file that was already past the cap when the baseline was taken is not part of
    // it, so being that big is not a change.
    if (read.note === 'too large' && known === undefined) return null;
    return { status, path: rel, added: 0, removed: 0, hunks: '', note: read.note };
  }
  const bytes = read.bytes ?? Buffer.from(read.text);
  if (known !== undefined && hex(bytes) === known) return null;
  const before = known === undefined ? null : await blobText(dir, known);
  if (before && 'note' in before) {
    return { status, path: rel, added: 0, removed: 0, hunks: '', note: before.note };
  }
  // A byte-level change the lines do not show (a trailing newline) still reads as a
  // modification, as a pure rename does in a git section.
  const d = unifiedDiff(before ? before.text : '', read.text, FULL_DIFF);
  return { status, path: rel, added: d.added, removed: d.removed, hunks: d.diff };
}

// One file the tree no longer holds: its text from the baseline, diffed to nothing.
async function deletedSnapshotFile(dir: string, rel: string, hash: string): Promise<FileDiff> {
  const before = await blobText(dir, hash);
  if (before && 'note' in before) {
    return { status: 'D', path: rel, added: 0, removed: 0, hunks: '', note: before.note };
  }
  const d = unifiedDiff(before ? before.text : '', '', FULL_DIFF);
  return { status: 'D', path: rel, added: d.added, removed: d.removed, hunks: d.diff };
}

// The root's leftover paths against its persistent snapshot, captured here on the
// first look. A path a git top claims is that top's on BOTH sides of the comparison:
// a file that moved into a repository since the capture is not the snapshot's
// deletion, and a nested repository's own files stay out of the leftover section
// however much of them the baseline holds.
async function snapshotSection(root: string, scan: RootScan): Promise<DiffSection | null> {
  // A top at or above the root claims every path under it, so this section can never
  // hold one; capturing would only hash a repository for nobody.
  if (scan.tops.some((t) => within(root, t))) return null;
  const dir = snapshotDir(root);
  let index = readIndex(dir, root);
  if (!index) {
    if (!(await ensureSnapshot(root))) return null;
    index = readIndex(dir, root);
    if (!index) return null;
  }
  const own = (rel: string): boolean => {
    const abs = path.resolve(root, rel);
    return scan.tops.some((t) => within(abs, t));
  };
  const base = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);
  const current = new Set<string>();
  const files: FileDiff[] = [];
  let examined = 0;
  for (const rel of scan.files) {
    if (own(rel) || JUNK.has(base(rel))) continue;
    if (++examined % SNAPSHOT_YIELD_EVERY === 0) await yieldToLoop();
    let st: fs.Stats;
    try { st = await fs.promises.lstat(path.resolve(root, rel)); } catch { continue; }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    current.add(rel);
    const file = await snapshotFile(root, dir, index, rel);
    if (file) files.push(file);
  }
  for (const [rel, hash] of Object.entries(index.files)) {
    if (current.has(rel) || own(rel) || JUNK.has(base(rel))) continue;
    if (++examined % SNAPSHOT_YIELD_EVERY === 0) await yieldToLoop();
    files.push(await deletedSnapshotFile(dir, rel, hash));
  }
  if (!files.length) return null;
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root, baseline: 'snapshot', label: `vs snapshot (taken ${snapshotDate(index.taken)})`, files };
}

async function rootSections(given: string): Promise<DiffSection[]> {
  const out: DiffSection[] = [];
  const root = realOf(given);
  const scan = await scanRoot(root);
  for (const top of scan.tops) {
    try {
      const section = await headSection(root, top, scan.tops);
      if (section) out.push(section);
    } catch {
      // git is not installed, or it failed on this top: the root keeps what is left
      // of the panel — its snapshot — rather than an error.
    }
  }
  const snapshot = await snapshotSection(root, scan);
  if (snapshot) out.push(snapshot);
  return out;
}

// Every change under `roots`, a root at a time in the order given: its git tops in walk
// order, then the leftover paths against its snapshot. Sections are never merged
// across roots — two checkouts of one repository are two answers.
export async function workingTreeDiff(roots: string[]): Promise<DiffSection[]> {
  const sections: DiffSection[] = [];
  for (const given of roots) {
    try { sections.push(...(await rootSections(given))); } catch { /* a root that cannot be read contributes nothing */ }
  }
  return sections;
}
