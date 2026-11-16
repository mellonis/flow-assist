// The working tree as the `/diff` panel shows it: every change under the given roots,
// one section per baseline.
//
// The host core does not run git. This module is the one deliberate exception, and it
// is READ-ONLY: `git status` and `git diff` under a root, nothing else. What writes
// the tree stays in the `repo` plugin, behind the person's confirmation.
//
// The module is pure of the app: it takes the roots it is handed, imports no config and
// no React, and answers a plain list. Every path it reads is held to its root by REAL
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
import fs from 'node:fs';
import path from 'node:path';
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

type TextRead = { text: string } | { note: 'binary' | 'too large' } | null;

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
// (gone, a directory, or a real location outside the root).
function readWorkingFile(abs: string, root: string): TextRead {
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch { return null; }
  if (st.isSymbolicLink()) {
    try { return { text: fs.readlinkSync(abs) }; } catch { return null; }
  }
  if (!st.isFile()) return null;
  if (!within(realOf(abs), root)) return null;
  if (st.size > MAX_FILE_BYTES) return { note: 'too large' };
  try { return decodeText(fs.readFileSync(abs)); } catch { return null; }
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

// Whether HEAD names a commit. A repository with nothing committed has no HEAD, and
// `git diff HEAD` would fail on it; its files are all untracked and are diffed from
// empty text anyway.
async function hasHead(top: string): Promise<boolean> {
  try { await runGit(top, ['rev-parse', '--verify', '--quiet', 'HEAD']); return true; } catch { return false; }
}

// One file of a git top, as its own diff. An addition (staged or untracked) is diffed
// from empty text and a deletion to empty text, so both read the way the panel draws
// any other change; a modification is git's own diff of it.
async function oneFile(root: string, top: string, entry: StatusEntry, status: 'A' | 'M' | 'D', segments: Map<string, string>, head: boolean): Promise<Omit<FileDiff, 'path' | 'status'>> {
  if (status === 'A') {
    const read = readWorkingFile(path.resolve(top, entry.path), root);
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
  const own = segments.get(entry.path);
  const diff = own ?? (await runGit(top, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', 'HEAD', '--', entry.path])).toString('utf8');
  const seg = segmentOf(diff);
  return { added: seg.added, removed: seg.removed, hunks: seg.hunks, ...(seg.binary ? { note: 'binary' as const } : {}) };
}

// One git top's section: everything changed under `root` that belongs to `top`.
// `null` — nothing changed there, so there is nothing to draw.
async function headSection(root: string, top: string): Promise<DiffSection | null> {
  const changed = parseStatus((await runGit(top, ['status', '--porcelain', '-z', '--untracked-files=all'])).toString('utf8'))
    .map((entry) => ({ entry, abs: path.resolve(top, entry.path) }))
    // Only what the root holds: a repository above it carries paths of its own too.
    .filter(({ abs }) => abs !== root && within(abs, root));
  if (!changed.length) return null;
  const head = await hasHead(top);
  const segments = head ? splitDiff((await runGit(top, GIT_DIFF_ARGS)).toString('utf8')) : new Map<string, string>();
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
// claims every path under it, so no file is collected then.
function scanRoot(root: string): RootScan {
  const tops: string[] = [];
  const files: string[] = [];
  const fromAbove = gitRootOf(root);
  if (fromAbove) tops.push(fromAbove);
  const claimed = fromAbove !== null;
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (SKIPPED.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (fs.existsSync(path.join(abs, '.git'))) { tops.push(abs); continue; }
        if (depth < MAX_TOP_DEPTH) walk(abs, depth + 1);
        continue;
      }
      if (!claimed) files.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(root, 0);
  return { tops, files };
}

// The root's leftover paths against its persistent snapshot. Task 3 fills this in; until
// then a root outside git contributes no section at all.
async function snapshotSection(root: string, paths: string[]): Promise<DiffSection | null> {
  void root;
  void paths;
  return null;
}

async function rootSections(given: string): Promise<DiffSection[]> {
  const out: DiffSection[] = [];
  const root = realOf(given);
  const scan = scanRoot(root);
  for (const top of scan.tops) {
    try {
      const section = await headSection(root, top);
      if (section) out.push(section);
    } catch {
      // git is not installed, or it failed on this top: the root keeps what is left
      // of the panel — its snapshot — rather than an error.
    }
  }
  const snapshot = await snapshotSection(root, scan.files);
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
