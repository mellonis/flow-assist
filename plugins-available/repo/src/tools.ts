// The `repo` tool group for the chat: local clones of projects and the git context
// of their branches. A self-contained factory: `clip` (a result post-processor) and
// `roots` come in as deps, and it imports nothing from the host or React. It
// reads the disk with node builtins and runs git as `git -C <repo>`.
//
// Security: an ALLOWLIST of roots (config.fs.roots, `~` expanded; `roots` may be a
// lazy loader). A path is resolved and must lie STRICTLY under one root, or it is
// refused — nothing like "take a look at /etc". File writes (write_file, edit_file,
// …) and git writes (branch, commit, push) are write-flagged, so the chat pauses
// for a y/n; git reads find the repository under a root and never leave the clone.
//
// Every output is windowed: one sliceWindow(items, start, end) with a
// [start–end/total] note, so the model pages through big lists, files and diffs.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

type Clip = (value: unknown) => unknown;

type RepoDeps = {
  clip: Clip;
  roots?: string[] | (() => string[] | Promise<string[]>);
  homeDir?: string;
};

export function buildRepoGroup({ clip, roots, homeDir = os.homedir() }: RepoDeps = {} as RepoDeps) {
  // The roots from the config, `~` expanded. Re-read on every call (as memory is), so
  // a change to config.fs.roots mid-session takes effect at once.
  const readRoots = async () => {
    const raw = typeof roots === 'function' ? await roots() : (roots ?? []);
    return (Array.isArray(raw) ? raw : [])
      .map((x: string) => path.resolve(String(x).replace(/^~(?=\/)/, homeDir)));
  };

  // The longest root that holds abs (it matters when roots are nested).
  const matchRoot = (abs: string, all: string[]): string | null => {
    let best: string | null = null;
    for (const r of all) {
      if (abs === r || abs.startsWith(r + path.sep)) {
        if (!best || r.length > best.length) best = r;
      }
    }
    return best;
  };

  // The real location of a path that may not exist yet (write_file creates it):
  // the deepest existing ancestor is resolved through its links, the rest rejoined.
  const realOf = (abs: string): string => {
    let head = abs;
    const tail: string[] = [];
    for (;;) {
      try { return path.join(fs.realpathSync(head), ...tail); } catch {}
      // A dangling link has no real path, yet a write through it lands at its target.
      try {
        if (fs.lstatSync(head).isSymbolicLink()) return path.join(path.resolve(path.dirname(head), fs.readlinkSync(head)), ...tail);
      } catch {}
      const up = path.dirname(head);
      if (up === head) return abs;
      tail.unshift(path.basename(head));
      head = up;
    }
  };

  // Resolves a path under a root. A relative path is tried from every root, and the
  // one that stays inside its root wins (the longest root when several do); an
  // absolute path is only checked to be inside one of the roots.
  // Returns { abs, root } or { error }.
  const resolveRead = (rel: any, all: string[]): any => {
    const s = String(rel ?? '').trim();
    let abs;
    if (!s) {
      // An empty path is the first root (the default "look where we are").
      if (!all.length) return { error: 'repo: no read roots configured (config.fs.roots is empty)' };
      return { abs: all[0], root: all[0] };
    }
    if (path.isAbsolute(s)) {
      abs = path.resolve(s);
    } else {
      const cands = all
        .map((r) => ({ r, a: path.resolve(r, s) }))
        .filter((c) => c.a === c.r || c.a.startsWith(c.r + path.sep));
      if (!cands.length) return { error: `repo: «${s}» is under no configured root` };
      cands.sort((a, b) => b.r.length - a.r.length);
      abs = cands[0].a;
    }
    const root = matchRoot(abs, all);
    if (!root) return { error: `repo: «${abs}» is outside the configured roots` };
    // The check above is lexical, and a clone may hold a symlink that points out of
    // it (`docs -> /etc`): the path reads as inside the root while the file it names
    // is not. So the REAL location must sit under a root's real location as well.
    const real = realOf(abs);
    if (!matchRoot(real, all.map(realOf))) return { error: `repo: «${abs}» resolves through a link to «${real}», outside the configured roots` };
    return { abs, root };
  };

  // A git ref that starts with `-` is an option, not a ref: `--output=<file>` makes
  // `git diff` and `git log` WRITE that file — from a tool that is read-only and so
  // never pauses for a y/n. Refused by name here; `--end-of-options` in the argv is
  // the second lock on the same door.
  const badRef = (...refs: string[]): string | null => {
    const bad = refs.find((r) => r.startsWith('-'));
    return bad ? `git: «${bad}» is not a ref — a ref cannot start with "-".` : null;
  };

  // A window over a list: [start..end] (1-based, inclusive); without bounds, the
  // first DEFAULT_WINDOW items. Returns the slice and what the note needs.
  const DEFAULT_WINDOW = 200;
  const sliceWindow = <T>(items: T[], start: any, end: any) => {
    const total = items.length;
    const s = (Number.isInteger(start) && start >= 1) ? start : 1;
    let e = (Number.isInteger(end) && end >= s) ? Math.min(end, total) : Math.min(total, s + DEFAULT_WINDOW - 1);
    if (e < s) e = s;
    const slice = items.slice(Math.max(0, s - 1), Math.min(total, e));
    return { slice, total, range: `[${s}–${Math.max(s, e)}/${total}]`, more: e < total };
  };

  // A plain `*`/`?` mask as a regex (search's glob argument).
  const globToRegex = (mask: string): RegExp => {
    let out = '';
    for (const ch of mask) {
      if (ch === '*') out += '.*';
      else if (ch === '?') out += '.';
      else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out}$`);
  };

  // Lines for a window; one trailing \n is not an empty last line (a normal file).
  const readLines = (text: string): { n: number; l: string }[] => text.replace(/\n$/, '').split('\n').map((l, i) => ({ n: i + 1, l }));

  // ── FILES (read) ───────────────────────────────────────────────────────────
  const listDir = (args: any, all: string[]) => {
    const r = resolveRead(args.path ?? '.', all);
    if (r.error) return r.error;
    const abs = r.abs;
    if (!fs.existsSync(abs)) return `list_dir: no such directory «${abs}»`;
    if (!fs.statSync(abs).isDirectory()) return `list_dir: not a directory «${abs}»`;
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .map((d) => {
        if (d.isDirectory()) return `d  ${d.name}`;
        if (d.isFile()) {
          let size = '';
          try { size = String(fs.statSync(path.join(abs, d.name)).size); } catch {}
          return `f  ${d.name}${size ? ` (${size}B)` : ''}`;
        }
        return `?  ${d.name}`;
      })
      .sort();
    const { slice, total, range, more } = sliceWindow(entries, args.start, args.end);
    return `list_dir ${range} (${abs})\n${slice.join('\n')}${more ? '\n… (more — pass start/end)' : ''}`;
  };

  const readFile = (args: any, all: string[]) => {
    const r = resolveRead(args.path, all);
    if (r.error) return r.error;
    const abs = r.abs;
    if (!fs.existsSync(abs)) return `read_file: no such file «${abs}»`;
    if (!fs.statSync(abs).isFile()) return `read_file: not a file «${abs}»`;
    const stat = fs.statSync(abs);
    if (stat.size > 5 * 1024 * 1024) return `read_file: «${abs}» is ${(stat.size / 1024 / 1024).toFixed(1)}MiB — too large; use search or git_show.`;
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch (e: any) { return `read_file: ${e.message}`; }
    const raw = readLines(text);
    const { slice, total, range, more } = sliceWindow(raw, args.start, args.end);
    return `read_file ${range} (${abs})\n${slice.map((x: any) => `${x.n}\t${x.l}`).join('\n')}${more ? '\n… (more — pass start/end)' : ''}`;
  };

  const search = (args: any, all: string[]) => {
    const q = String(args.query ?? '').trim();
    if (!q) return 'search: query is required (substring to find).';
    const r = resolveRead(args.path ?? '.', all);
    if (r.error) return r.error;
    const abs = r.abs;
    if (!fs.existsSync(abs)) return `search: no such path «${abs}»`;
    const mask = String(args.glob ?? '').trim();
    const rx = mask ? globToRegex(mask) : null;
    const hits: string[] = [];
    let scanned = 0;
    const MAX_SCAN = 4000;
    const MAX_HITS = 1000;
    const grab = (full: string, rel: string) => {
      if (scanned >= MAX_SCAN) return;
      scanned++;
      let stat;
      try { stat = fs.statSync(full); } catch { return; }
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return;
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { return; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= MAX_HITS) return;
        if (lines[i] && lines[i].includes(q)) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
      }
    };
    const walk = (dir: string, rel: string) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of ents) {
        if (scanned >= MAX_SCAN || hits.length >= MAX_HITS) return;
        if (d.name === 'node_modules' || d.name === '.git') continue;
        const full = path.join(dir, d.name);
        const relPath = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) { walk(full, relPath); continue; }
        if (!d.isFile()) continue;
        if (rx && !rx.test(d.name)) continue;
        grab(full, relPath);
      }
    };
    if (fs.statSync(abs).isFile()) {
      if (!rx || rx.test(path.basename(abs))) grab(abs, abs);
    } else {
      walk(abs, '');
    }
    const { slice, total, range, more } = sliceWindow(hits, args.start, args.end);
    const capNote = hits.length >= MAX_HITS ? `\n(capped at ${MAX_HITS} matches)` : '';
    return `search «${q}» ${range} (${abs})${capNote}\n${slice.join('\n')}${more ? '\n… (more — pass start/end)' : ''}`;
  };

  // ── FILES (write): write-flagged, so the chat pauses for a y/n ──────────────
  const writeFile = (args: any, all: string[]) => {
    const r = resolveRead(args.path, all);
    if (r.error) return r.error;
    const abs = r.abs;
    try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch (e: any) { return `write_file: mkdir failed: ${e.message}`; }
    const content = String(args.content ?? '');
    try { fs.writeFileSync(abs, content, 'utf8'); } catch (e: any) { return `write_file: ${e.message}`; }
    return `write_file: wrote ${abs} (${content.length} chars)`;
  };

  const editFile = (args: any, all: string[]) => {
    const r = resolveRead(args.path, all);
    if (r.error) return r.error;
    const abs = r.abs;
    const oldStr = String(args.old ?? '');
    const newStr = String(args.new ?? '');
    if (!oldStr) return 'edit_file: old is required — the exact substring to replace.';
    if (!fs.existsSync(abs)) return `edit_file: no such file «${abs}»`;
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch (e: any) { return `edit_file: ${e.message}`; }
    const idx = text.indexOf(oldStr);
    if (idx === -1) return `edit_file: «${oldStr.slice(0, 40)}…» not found in ${abs}`;
    const next = text.slice(0, idx) + newStr + text.slice(idx + oldStr.length);
    try { fs.writeFileSync(abs, next, 'utf8'); } catch (e: any) { return `edit_file: ${e.message}`; }
    return `edit_file: replaced in ${abs} (${oldStr.length}→${newStr.length} chars)`;
  };

  const deleteFile = (args: any, all: string[]) => {
    const r = resolveRead(args.path, all);
    if (r.error) return r.error;
    const abs = r.abs;
    // A configured root is the clone itself. One confirmed y/n must never be the
    // whole repository with its unpushed work, so the root is not deletable at all.
    if (abs === r.root) return `delete_file: «${abs}» is a configured root — it is not deleted from here.`;
    if (!fs.existsSync(abs)) return `delete_file: no such path «${abs}»`;
    const st = fs.statSync(abs);
    const recursive = args.recursive === true;
    // A directory goes only with an explicit recursive: true, so the model cannot
    // wipe a tree by accident (an empty one needs it too — one rule for all).
    if (st.isDirectory()) {
      if (!recursive) return `delete_file: «${abs}» is a directory — pass recursive: true to remove it and its contents`;
      try { fs.rmSync(abs, { recursive: true, force: true }); } catch (e: any) { return `delete_file: ${e.message}`; }
      return `delete_file: removed directory ${abs}`;
    }
    if (!st.isFile()) return `delete_file: «${abs}» is not a file or directory`;
    try { fs.unlinkSync(abs); } catch (e: any) { return `delete_file: ${e.message}`; }
    return `delete_file: removed ${abs}`;
  };

  // ── GIT (read): the repository under a root, output windowed ───────────────
  const runGit = (repo: string, argv: string[]): Promise<string> => new Promise((resolve, reject) => {
    const c = spawn('git', ['-C', repo, ...argv], { shell: false });
    let out = '', err = '';
    c.stdout!.on('data', (d: any) => { out += d; });
    c.stderr!.on('data', (d: any) => { err += d; });
    c.on('error', (e) => reject(new Error(`git: ${e.message}`)));
    c.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`git ${code}: ${(err || out).trim().slice(0, 300)}`));
    });
  });

  // Finds the repository: resolves the path under a root, then asks
  // `rev-parse --show-toplevel`. Returns { repo } or { error }.
  const gitRepo = async (rel: any, all: string[]): Promise<any> => {
    const r = resolveRead(rel ?? '.', all);
    if (r.error) return { error: r.error };
    try {
      const top = (await runGit(r.abs, ['rev-parse', '--show-toplevel'])).trim();
      return { repo: top };
    } catch (e: any) {
      return { error: `git: «${r.abs}» is not inside a git repository (${e.message})` };
    }
  };

  // A git tool's output: a window of lines and its note.
  const gitOutput = (label: string, text: string, args: any) => {
    const { slice, total, range, more } = sliceWindow(readLines(text), args.start, args.end);
    return `${label} ${range}\n${slice.map((x: any) => (label === 'git_diff' ? '\t' : '') + x.l).join('\n')}${more ? '\n… (more — pass start/end)' : ''}`;
    // Diff lines are not numbered (they carry +/−/@@ already), and other git output
    // needs no numbers beside the window note. read_file and git_show number their
    // lines (a range refers to them); the rest is shown as it is.
  };

  return {
    id: 'repo',
    // Active once roots are configured — without them there is nothing to read.
    detect: async () => (await readRoots()).length > 0,
    tools: [
      {
        type: 'function',
        function: {
          name: 'list_dir',
          description: 'List the entries of a directory inside the configured repo roots (config.fs.roots). path — absolute path or a root-relative path; default: the first root. start/end — 1-based window over the sorted entries (default: first 200). Returns entries as "d name" (dir) or "f name (sizeB)" (file), annotated [start–end/total] — pass start/end to page.',
          parameters: { type: 'object', properties: {
            path: { type: 'string', description: 'Directory path (absolute or relative to a root).' },
            start: { type: 'number', description: '1-based index of the first entry to show.' },
            end: { type: 'number', description: '1-based index of the last entry to show.' },
          }, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a text file under the configured repo roots (config.fs.roots). path — absolute or root-relative. start/end — 1-based inclusive LINE window (default: first 200 lines); each line is prefixed with its number, annotated [start–end/total] — request the next window to read larger files. Rejects paths outside the roots and files > 5MiB.',
          parameters: { type: 'object', properties: {
            path: { type: 'string', description: 'File path (absolute or relative to a root).' },
            start: { type: 'number', description: 'First line (1-based).' },
            end: { type: 'number', description: 'Last line (inclusive).' },
          }, required: ['path'] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'search',
          description: 'Search for a substring inside files under the configured roots (config.fs.roots). query — the literal text to find. path — directory (recursive) or a single file; default ".". glob — optional filename mask with * and ?. start/end — 1-based window over MATCHES (each "rel/file:line: text"), annotated [start–end/total]. Skips node_modules/.git and files > 2MiB, capped at 4000 files / 1000 matches.',
          parameters: { type: 'object', properties: {
            query: { type: 'string', description: 'Substring to find in file contents.' },
            path: { type: 'string', description: 'Directory or file to search (default: a root).' },
            glob: { type: 'string', description: 'Filename mask filter, e.g. "*.ts".' },
            start: { type: 'number', description: '1-based index of the first match to show.' },
            end: { type: 'number', description: '1-based index of the last match to show.' },
          }, required: ['query'] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'WRITE: create or overwrite a file under the configured repo roots (config.fs.roots). path — absolute or root-relative (parent dirs created). content — the full file text. The tool is write-flagged: the chat pauses with a y/n confirmation before it runs.',
          parameters: { type: 'object', properties: {
            path: { type: 'string', description: 'File path to write (absolute or relative to a root).' },
            content: { type: 'string', description: 'Full file content.' },
          }, required: ['path', 'content'] },
        },
        write: true,
      },
      {
        type: 'function',
        function: {
          name: 'edit_file',
          description: 'WRITE: replace the FIRST occurrence of a substring in a file under the configured roots (config.fs.roots). path — file; old — exact substring to find; new — replacement. Safer than full overwrite. Write-flagged: chat pauses with y/n confirmation. Fails (no change) if old is not found.',
          parameters: { type: 'object', properties: {
            path: { type: 'string', description: 'File path (absolute or relative to a root).' },
            old: { type: 'string', description: 'Exact substring to replace (first occurrence).' },
            new: { type: 'string', description: 'Replacement text.' },
          }, required: ['path', 'old', 'new'] },
        },
        write: true,
      },
      {
        type: 'function',
        function: {
          name: 'delete_file',
          description: 'WRITE: delete a file or directory under the configured repo roots (config.fs.roots). path — absolute or root-relative. Files are removed directly. Directories require recursive: true (removes the tree); without it a directory is refused. Rejects paths outside the roots. Irreversible (no trash) — write-flagged, so the chat pauses with a y/n confirmation before it runs; use it deliberately after reading the path.',
          parameters: { type: 'object', properties: {
            path: { type: 'string', description: 'File or directory path to delete (absolute or relative to a root).' },
            recursive: { type: 'boolean', description: 'Required to delete a directory (removes it and its contents); ignored for files.' },
          }, required: ['path'] },
        },
        write: true,
      },
      {
        type: 'function',
        function: {
          name: 'git_status',
          description: 'Git status of a repository under the configured roots: current branch + changed/untracked files (git status --short --branch). path — optional repo dir (default: a root that is a git repo). start/end — window over status lines, annotated [start–end/total]. Read-only.',
          parameters: { type: 'object', properties: {
            path: { type: 'string', description: 'Repo directory (absolute or root-relative).' },
            start: { type: 'number', description: 'First line to show (1-based).' },
            end: { type: 'number', description: 'Last line to show (inclusive).' },
          }, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'git_branches',
          description: 'List branches of a repository under the configured roots (git branch -a), current branch marked with *. path — optional repo dir. start/end — window over the branch list, annotated [start–end/total]. Read-only.',
          parameters: { type: 'object', properties: {
            path: { type: 'string', description: 'Repo directory (absolute or root-relative).' },
            start: { type: 'number', description: 'First branch to show (1-based).' },
            end: { type: 'number', description: 'Last branch to show (inclusive).' },
          }, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'git_log',
          description: 'Recent commit history (git log --oneline, capped at 100) of a repo under the roots. path — optional repo dir. ref — optional branch/commit to log (default: current HEAD); with base set, shows ONLY commits unique to ref vs base (`git log base..ref`) — e.g. git_log(ref="feature-ABC-18", base="master") lists the ABC-18-specific commits. start/end — window over commits, annotated [start–end/total]. Read-only.',
          parameters: { type: 'object', properties: {
            path: { type: 'string', description: 'Repo directory (absolute or root-relative).' },
            ref: { type: 'string', description: 'Branch/commit to log (default current branch).' },
            base: { type: 'string', description: 'With ref — restrict to commits unique to ref vs base (base..ref).' },
            start: { type: 'number', description: 'First commit to show (1-based).' },
            end: { type: 'number', description: 'Last commit to show (inclusive).' },
          }, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'git_ls_tree',
          description: 'List the tree of a branch/commit in a repo under the roots (git ls-tree --name-only <ref> [<path>]). ref — branch/tag/commit-ish, e.g. "feature-ABC-18"; path — optional subdir. start/end — window over entries, annotated [start–end/total]. Read-only. Combine with git_branches to discover a branch, then git_show to read its files.',
          parameters: { type: 'object', properties: {
            ref: { type: 'string', description: 'Branch/tag/commit to list (e.g. feature-ABC-18).' },
            path: { type: 'string', description: 'Subdir within the ref (optional).' },
            repo: { type: 'string', description: 'Repo directory (absolute or root-relative, default a root).' },
            start: { type: 'number', description: 'First entry to show (1-based).' },
            end: { type: 'number', description: 'Last entry to show (inclusive).' },
          }, required: ['ref'] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'git_show',
          description: 'Show a file content at a branch/commit in a repo under the roots (git show <ref>:<path>). ref — branch/tag/commit-ish (e.g. feature-ABC-18); path — file path within the ref. start/end — 1-based LINE window, prefixed with line numbers, annotated [start–end/total]. Read-only. Use git_branches/git_ls_tree to discover a branch and its files.',
          parameters: { type: 'object', properties: {
            ref: { type: 'string', description: 'Branch/tag/commit (e.g. feature-ABC-18).' },
            path: { type: 'string', description: 'File path within the ref.' },
            repo: { type: 'string', description: 'Repo directory (absolute or root-relative, default a root).' },
            start: { type: 'number', description: 'First line to show (1-based).' },
            end: { type: 'number', description: 'Last line to show (inclusive).' },
          }, required: ['ref', 'path'] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'git_diff',
          description: 'Uncommitted or between-branch diff (git diff) of a repo under the roots. No refs: working tree vs HEAD (uncommitted). One ref: HEAD vs ref (what the branch adds/changes). Two refs: base vs ref. path — optional file filter; repo — optional repo dir. start/end — window over diff lines, annotated [start–end/total]. Read-only. Example: git_diff(base="master", ref="feature-ABC-18") shows a feature implementation.',
          parameters: { type: 'object', properties: {
            base: { type: 'string', description: 'Base ref (optional).' },
            ref: { type: 'string', description: 'Target ref (optional).' },
            path: { type: 'string', description: 'Limit diff to this file/dir (optional).' },
            repo: { type: 'string', description: 'Repo directory (absolute or root-relative, default a root).' },
            start: { type: 'number', description: 'First diff line to show (1-based).' },
            end: { type: 'number', description: 'Last diff line to show (inclusive).' },
          }, required: [] },
        },
      },
    ],
    exec: async (name: string, args: any, ctx: any) => {
      const all = await readRoots();
      if (!all.length && !['write_file', 'edit_file', 'delete_file'].includes(name)) {
        return 'repo: no read roots configured — add config.fs.roots (array of absolute clone dirs).';
      }
      switch (name) {
        case 'list_dir': return clip(listDir(args, all));
        case 'read_file': return clip(readFile(args, all));
        case 'search': return clip(search(args, all));
        case 'write_file': return clip(writeFile(args, all));
        case 'edit_file': return clip(editFile(args, all));
        case 'delete_file': return clip(deleteFile(args, all));
        case 'git_status': case 'git_branches': case 'git_log':
        case 'git_ls_tree': case 'git_show': case 'git_diff': {
          // Whether `path` picks the REPOSITORY (status/branches/log) rather than a
          // file or subtree (ls_tree/show/diff, whose args.path is a path inside it).
          const pathIsRepo = name === 'git_status' || name === 'git_branches' || name === 'git_log';
          const repoArg = args.repo ?? (pathIsRepo ? args.path : null) ?? '.';
          const gr = await gitRepo(repoArg, all);
          if (gr.error) return clip(gr.error);
          const repo = gr.repo;
          try {
            let label: string, text: string;
            if (name === 'git_status') { label = 'git_status'; text = await runGit(repo, ['status', '--short', '--branch']); }
            else if (name === 'git_branches') { label = 'git_branches'; text = await runGit(repo, ['branch', '-a']); }
            else if (name === 'git_log') {
              const lref = String(args.ref ?? '').trim();
              const lbase = String(args.base ?? '').trim();
              // ref — the branch or commit whose log to show (HEAD by default).
              // base + ref — only the commits ref has and base has not
              // (`git log base..ref`): the model sees "what was done in ABC-18",
              // not master's whole history that the branch carries along.
              const bad = badRef(lref, lbase);
              if (bad) return clip(bad);
              const argv = ['log', '--oneline', '-n', '100', '--end-of-options'];
              if (lbase && lref) argv.push(`${lbase}..${lref}`);
              else if (lref) argv.push(lref);
              label = `git_log${lbase && lref ? `(${lbase}..${lref})` : lref ? `(${lref})` : ''}`;
              text = await runGit(repo, argv);
            }
            else if (name === 'git_ls_tree') {
              const bad = badRef(String(args.ref ?? '').trim());
              if (bad) return clip(bad);
              const argv = ['ls-tree', '--name-only', '--end-of-options', String(args.ref ?? '').trim()];
              if (args.path != null && String(args.path).trim()) argv.push('--', String(args.path).trim());
              label = `git_ls_tree(${String(args.ref ?? '').trim()})`; text = await runGit(repo, argv);
            }
            else if (name === 'git_show') {
              const ref = String(args.ref ?? '').trim();
              const p = String(args.path ?? '').trim();
              const bad = badRef(ref);
              if (bad) return clip(bad);
              label = `git_show(${ref}:${p})`; text = await runGit(repo, ['show', '--end-of-options', `${ref}:${p}`]);
            }
            else { // git_diff
              const base = String(args.base ?? '').trim();
              const ref = String(args.ref ?? '').trim();
              // base + ref — what the branch changes against its base; ref alone —
              // against HEAD; no refs — the uncommitted changes against HEAD. With
              // base + ref the argv has EXACTLY two refs, `git diff <base> <ref>`: an
              // extra `HEAD` in it makes git print nothing, and the assistant then
              // concludes the branch changes nothing.
              const bad = badRef(base, ref);
              if (bad) return clip(bad);
              const argv = base && ref
                ? ['diff', '--end-of-options', base, ref]
                : ref
                  ? ['diff', '--end-of-options', 'HEAD', ref]
                  : ['diff', 'HEAD'];
              if (args.path != null && String(args.path).trim()) argv.push('--', String(args.path).trim());
              label = `git_diff${base && ref ? `(${base}..${ref})` : ref ? `(HEAD..${ref})` : ''}`;
              text = await runGit(repo, argv);
            }
            return clip(gitOutput(label, text, args));
          } catch (e: any) {
            return clip(`git ${name}: ${e.message}`);
          }
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    },
  };
}

export default buildRepoGroup;