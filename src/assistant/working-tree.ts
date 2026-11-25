// The working tree as the `/diff` panel shows it: every change under the given roots,
// one section per git top.
//
// The host core does not run git. This module is the one deliberate exception, and it
// is READ-ONLY: `git status`, `git diff`, `git for-each-ref` and `git symbolic-ref`
// under a root, nothing else. What writes the tree stays in the `repo` plugin, behind
// the person's confirmation.
//
// The module is pure of the app: it takes the roots it is handed, answers a plain list,
// and imports no React. Every path it reads from a root is held to that root by REAL
// path, so a link in a clone cannot carry the panel out of the person's work.
//
// Three sources, one walk: a git top — the scope itself, a repository above it, or one
// nested under it — is sectioned on its own, and a nested repository beats anything
// else for its own paths. Each mode names what is compared:
// `branch-local` (the default) is the local changes AND the commits since a base ref,
// `committed` is only what the branch committed since that base, `worktree` is the
// uncommitted pile against HEAD. The base is one ref for every top or a lookup per
// top; a top with no base named for it resolves its own default branch
// (`defaultBaseRef`). Outside git there is no baseline that would mean anything: the
// scope must stand in a repository for anything to be walked at all, so a plain folder
// that merely holds repositories answers `gitless` — `git status` refuses there, and
// so does the panel. A scope inside a repository gets a section per top it holds.
//
// A source that names a base runs on no guesswork: when a top's base cannot be
// resolved the section is answered with `base: ''` and NO files — never a silent HEAD
// — and the panel words it (`pick a base to compare against`).
//
// A git that is missing, or that fails on one top, never throws out of here: that top
// contributes no section and the walk answers `failed`, so a tree that could not be
// read is never shown as a clean one.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { unifiedDiff } from './diff.js';
import { gitRootOf } from './sessions.js';
import { realOf, within } from './shell.js';

export interface FileDiff {
  status: 'A' | 'M' | 'D';
  path: string; // relative to the section's root, '/'-separated
  // The file's stable key part — what the fold and the cursor key by
  // (`diffFileKey(root, key ?? path)`) when the drawn path is not the name the file is
  // known by; a reported change's index key sets it. Defaults to `path`.
  key?: string;
  added: number;
  removed: number;
  hunks: string; // the unified diff text; '' for binary / too large
  note?: 'binary' | 'too large';
}

export interface DiffSection {
  root: string; // the root directory the section is under, by its REAL path
  // The label the header prints after `vs `: the ref this top was compared against, or
  // `HEAD` for the worktree source. `''` — the top names no base and nothing was
  // compared; the section then holds no files and the panel offers the picker.
  base: string;
  // What kind of section it is; absent means `'tree'` — a git top this walk drew
  // (or a path change `turn-diff.ts` grouped under one). `'reported'` is
  // `turn-diff.ts`'s group of changes that are not files.
  kind?: 'tree' | 'reported';
  files: FileDiff[];
}

// What a walk compares. `branch-local` (the default): the local changes AND the
// commits since the base. `committed`: only what the branch committed since the base.
// `worktree`: only the uncommitted changes, against HEAD — the one source that needs
// no base.
export type DiffMode = 'branch-local' | 'committed' | 'worktree';

// What a walk answers: the sections it drew — one per git top, each against its own
// base — and the two honest nothings. `gitless`: the scope is outside git entirely, so
// the panel says `not a git repository`; `failed`: a top was found and git could not
// read it, so the panel says that — neither ever reads as `no changes in the working
// tree` unless a repository was read and was clean.
export interface WorkingTreeDiff {
  sections: DiffSection[];
  gitless: boolean;
  failed: boolean;
}

// What the panel keys its cursor and its opened blocks by. A bare path repeats across
// roots (`src/index.ts` is in every project), and a section's paths are relative to
// its root, so the root is part of the name.
export const diffFileKey = (root: string, p: string): string => root + '\u0000' + p;

// The one directory the panel reads is where the shell stands: the repository at or
// above its directory — its git top, a linked worktree's own directory included, so a
// subdirectory still shows the whole working tree as `git status` does there — or the
// directory itself when no repository is above it. The `shell.roots` fence is not
// consulted: the panel is the person's own screen, and `git status` shows the whole
// repository however wide it is.
export function diffScopeOf(dir: string): string {
  const real = realOf(dir);
  return gitRootOf(real) ?? real;
}

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

// A change's own letter, read from the file's diff preamble: what the mode's diff adds
// is `A`, what it deletes is `D`, and what it changes in place is `M`. The status
// letter covers only what the diff says nothing about.
function preambleStatus(diff: string): 'A' | 'M' | 'D' {
  if (/^new file mode /m.test(diff)) return 'A';
  if (/^deleted file mode /m.test(diff)) return 'D';
  return 'M';
}

// The new path of a `diff --git a/<old> b/<new>` header. git prefixes are forced on
// the command line, so the shape is fixed; a path git had to C-quote (a control
// character in the name) does not match, and that file is diffed on its own instead.
function headerPath(line: string): string | null {
  const at = line.lastIndexOf(' b/');
  return at < 0 ? null : line.slice(at + 3);
}

// `git diff` split per file: the footprint git reports for a path is the hunks
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

// The one `git diff` batch per top, carrying the mode's comparison: `HEAD` against the
// worktree, the base against the worktree, or the base's merge-base against the
// branch's commits. git's prefixes are forced so its headers parse the same whatever
// the repository's config says.
const diffBatch = (spec: string): string[] => ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', '--src-prefix=a/', '--dst-prefix=b/', spec, '--'];
const diffOne = (spec: string, rel: string): string[] => ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', spec, '--', literalPath(rel)];

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

// One file of a git top, as the mode's diff sees it. What that diff carries is what
// the mode shows: a file the commits touched keeps THEIR hunks even where the worktree
// then deleted it, and a deletion reads against the ref the mode names. The
// syntheses below stand in only where the diff holds nothing of the file — an
// addition no diff lists (untracked), a deletion outside a batch that failed. An
// addition is then diffed from empty text and a deletion to empty text, so both read
// the way the panel draws any other change.
async function oneFile(root: string, top: string, entry: StatusEntry, status: 'A' | 'M' | 'D', segments: Map<string, string>, head: boolean, spec: string): Promise<Omit<FileDiff, 'path' | 'status'>> {
  if (pastReadSize(path.resolve(top, entry.path), root)) return { added: 0, removed: 0, hunks: '', note: 'too large' };
  const own = segments.get(entry.path);
  if (own !== undefined) {
    const seg = segmentOf(own);
    return { added: seg.added, removed: seg.removed, hunks: seg.hunks, ...(seg.binary ? { note: 'binary' as const } : {}) };
  }
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
  const diff = (await runGit(top, diffOne(spec, entry.path))).toString('utf8');
  const seg = segmentOf(diff);
  return { added: seg.added, removed: seg.removed, hunks: seg.hunks, ...(seg.binary ? { note: 'binary' as const } : {}) };
}

// What a walk may be given internally: the exported `opts` shape (`workingTreeDiff`),
// one base ref for every top or a lookup asked with the top, and the mode.
type WalkOpts = {
  base?: string | ((root: string) => string | undefined);
  mode?: DiffMode;
};

// A ref name, not a flag and not smuggled argument text: a caller's `base` reaches
// git's argv, so a name that could read as an option or that carries whitespace or a
// control byte is refused like a base that does not exist.
const refNameUsable = (name: string): boolean =>
  name.length > 0 && !name.startsWith('-') && !/[\s\u0000-\u001f]/.test(name);

// Whether a ref name is one git could compare against: it is listed as its own name
// under `refs/heads`, `refs/tags` or `refs/remotes`. A dangling name is no base —
// comparing against it would fail a tree git reads just fine.
async function refResolves(root: string, name: string): Promise<boolean> {
  return (await listedRefs(root, [`refs/heads/${name}`, `refs/tags/${name}`, `refs/remotes/${name}`])).includes(name);
}

// What a top compares against: the caller's own ref for it (a lookup asked with the
// top), else the top's default branch. `base` is ONE REF — the branch name a picker
// fed — and a raw SHA is not one: every name is existence-checked, and what does not
// resolve falls through as if no ref had been named. `null` — nothing usable was
// named or resolved; a lookup that throws is taken as answering `undefined`.
async function baseFor(top: string, opts: WalkOpts): Promise<string | null> {
  let given: string | undefined;
  if (typeof opts.base === 'function') {
    try { given = opts.base(top); } catch { given = undefined; }
  } else {
    given = opts.base;
  }
  const chosen = given !== undefined && given !== null && refNameUsable(given) && (await refResolves(top, given)) ? given : undefined;
  return chosen ?? (await defaultBaseRef(top));
}

// The branches a base picker lists, and what an existence check asks: the refs git
// lists under the given namespaces (`%(refname:short)`, its own name exactly — a ref
// under one never counts for its parent). A git that cannot answer lists nothing —
// never throws out of here.
async function listedRefs(root: string, namespaces: string[]): Promise<string[]> {
  try {
    return (await runGit(root, ['for-each-ref', '--format=%(refname:short)', ...namespaces]))
      .toString('utf8').split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
  } catch { return []; }
}

// The default branch of a repository: `origin/HEAD`'s target as a plain branch name —
// when the name it gives resolves among the refs git could compare against — else
// `main` when that branch exists, else `master` when it exists. A dangling `origin/HEAD`
// is no base: its tail names a ref that is not there, and comparing against it would
// fail on a tree git reads just fine. `null` — the repository names no default and the
// panel must offer its picker; HEAD is never a silent answer. A git that fails here
// answers `null` too — never throws.
export async function defaultBaseRef(root: string): Promise<string | null> {
  try {
    const target = (await runGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).toString('utf8').trim();
    const name = target.startsWith('origin/') ? target.slice('origin/'.length) : target;
    if (name && (await refResolves(root, name))) return name;
  } catch { /* no `origin/HEAD` to read */ }
  for (const name of ['main', 'master']) {
    if ((await listedRefs(root, [`refs/heads/${name}`])).includes(name)) return name;
  }
  return null;
}

// The branches a base picker lists: the local heads and the remote refs, in the order
// git sorts them. A git that cannot answer makes an empty list of that side — never
// throws out of here.
export async function listBaseRefs(root: string): Promise<{ local: string[]; remote: string[] }> {
  return { local: await listedRefs(root, ['refs/heads']), remote: await listedRefs(root, ['refs/remotes']) };
}

// One git top's section: everything the mode holds under `root` that belongs to `top`.
// A nested repository is left to the section the walk gives it — git reports it as a
// `sub/` entry or a staged gitlink, and it is a folder either way, never a file of
// this top. `null` — the mode holds nothing there, so there is nothing to draw. A top
// whose base the mode needs but cannot get answers an empty section with `base: ''` —
// not `null`, so the panel can word it and offer the picker.
async function headSection(root: string, top: string, tops: string[], opts: WalkOpts): Promise<DiffSection | null> {
  // Repositories nested INSIDE this top own their paths. A top above it owns `top`
  // itself and must not swallow what is inside.
  const nested = tops.filter((t) => t !== top && within(t, top));
  // A path under the root that is this top's own: not the root itself (that is the
  // nested repository the root stands in), not under another top, and not the folder
  // of a nested repository — that one is its own section.
  const owns = (abs: string): boolean =>
    abs !== root && within(abs, root) && !nested.some((t) => within(abs, t)) && !isDirectory(abs);
  // `git status` names every file — its letter, its rename, the untracked pile no diff
  // ever carries — and the mode says which of them it holds. A clean worktree still
  // leaves `committed` and `branch-local` their diffs: commits changed files the
  // status cannot see, and those are exactly what those sources show.
  const changed = parseStatus((await runGit(top, ['status', '--porcelain', '-z', '--untracked-files=all'])).toString('utf8'))
    .map((entry) => ({ entry, abs: path.resolve(top, entry.path) }))
    .filter(({ abs }) => owns(abs));
  const mode = opts.mode ?? 'branch-local';
  let spec: string;
  let base: string;
  if (mode === 'worktree') {
    // The one source that needs no base: the last commit is where the worktree stands.
    if (!changed.length) return null;
    spec = 'HEAD';
    base = 'HEAD';
  } else {
    const chosen = await baseFor(top, opts);
    if (chosen === null) return { root, base: '', files: [] };
    spec = mode === 'committed' ? `${chosen}...HEAD` : chosen;
    base = chosen;
  }
  const head = await hasHead(top);
  // The batch is scoped to the root's part of the tree — a root deep inside a large
  // repository would otherwise diff that entire repository on every refresh, and a top
  // nested under the root is wholly the root's part — and it is what makes a
  // modification cheap: one git call for the tree instead of one per file. Its failure
  // is not the section's either: `oneFile` diffs a file with no segment on its own, so
  // one failed batch costs per-file calls, never the section's hunks.
  const scope = within(root, top) ? path.relative(top, root) || '.' : '.';
  let segments = new Map<string, string>();
  let batched = false;
  if (head) {
    try {
      segments = splitDiff((await runGit(top, [...diffBatch(spec), literalPath(scope)])).toString('utf8'));
      batched = true;
    } catch { /* per file, below */ }
  }
  // What the mode holds: its diff's own files (a committed change to a file the
  // worktree is clean for is only here) plus every status entry it keeps — for the
  // letter, and for an untracked file in the local sources. `committed` keeps a status
  // entry only where its diff has a change to show: what is uncommitted is not "what
  // the branch committed", and an untracked pile never is. The batch failing leaves
  // the tracked entries to say what they can from their own per-file diffs.
  const kept = changed.filter(({ entry }) =>
    mode === 'committed' ? (batched ? segments.has(entry.path) : entry.code !== '??') : true);
  const named = new Set(kept.map(({ entry }) => entry.path));
  const carried = [...segments.keys()]
    .map((p) => ({ entry: { code: '', path: p }, abs: path.resolve(top, p) }))
    .filter(({ entry, abs }) => !named.has(entry.path) && owns(abs));
  const items = [...kept, ...carried]
    .sort((a, b) => (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0));
  const files: FileDiff[] = [];
  for (const { entry, abs } of items) {
    // The diff names its own change — added, deleted, modified — and the status letter
    // stands in only where the diff says nothing of the file.
    const own = segments.get(entry.path);
    const status = own !== undefined ? preambleStatus(own) : statusOf(entry.code);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    files.push({ status, path: rel, ...(await oneFile(root, top, entry, status, segments, head, spec)) });
  }
  if (!files.length) return null;
  return { root, base, files };
}

// What a root is made of: its git tops. The scope must itself stand in a repository —
// `git status` refuses outside one, and so does the walk — so a top above the root is
// what everything hangs off. The walk is a readdir tree, sorted so the section order is
// the same on every look; a link is never followed, `.git` and `node_modules` are never
// entered, a nested repository is a top of its own and is not looked into, and the
// search stops `MAX_TOP_DEPTH` directories below the root. A repository at or above the
// root claims every path under it, so the walk only adds tops under it. The walk yields
// the loop every `WALK_YIELD_EVERY` entries, so a refresh a second apart never holds a
// frame.
const WALK_YIELD_EVERY = 100;
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function scanRoot(root: string): Promise<string[]> {
  const tops: string[] = [];
  const fromAbove = gitRootOf(root);
  // Outside git there is nothing to walk: a repository nested under a plain folder is
  // not answered for — its differences from its own HEAD are not this scope's working
  // tree, and `git status` in the folder says "not a git repository".
  if (!fromAbove) return tops;
  tops.push(fromAbove);
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
      if (++examined % WALK_YIELD_EVERY === 0) await yieldToLoop();
      if (SKIPPED.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (await isTop(abs)) { tops.push(abs); continue; }
        if (depth < MAX_TOP_DEPTH) await walk(abs, depth + 1);
      }
    }
  };
  await walk(root, 0);
  return tops;
}

// Every change under `roots`, a root at a time in the order given: its git tops in walk
// order, each section against its own base. Sections are never merged across roots —
// two checkouts of one repository are two answers. `gitless` says the scope is outside
// git, which is what an empty `sections` then means: `not a git repository`, never a
// clean tree; `failed` says a top was found and git could not read it, which is never
// a clean tree either.
export async function workingTreeDiff(roots: string[], opts?: { base?: string | ((root: string) => string | undefined); mode?: DiffMode }): Promise<WorkingTreeDiff> {
  const sections: DiffSection[] = [];
  let gitless = true;
  let failed = false;
  for (const given of roots) {
    try {
      const root = realOf(given);
      const tops = await scanRoot(root);
      if (tops.length) gitless = false;
      for (const top of tops) {
        try {
          const section = await headSection(root, top, tops, opts ?? {});
          if (section) sections.push(section);
        } catch {
          // git is not installed, or it failed on this top: the top contributes no
          // section and the walk goes on — saying so, rather than drawing the rest as
          // the whole tree.
          failed = true;
        }
      }
    } catch { /* a root that cannot be read contributes nothing */ }
  }
  return { sections, gitless, failed };
}
