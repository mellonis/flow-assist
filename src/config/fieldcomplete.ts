// The chat field's completion beyond a `/command`'s name: the command's argument from
// the values it declares, and — in shell mode — the word being typed as a PATH, the
// way a shell completes one. Both answer in `CompleteResult`, so the field draws and
// walks them through the `:` line's own `lineView` / `lineTab` (./commandline.ts):
// the untyped rest after the caret, the other candidates beside it, Tab taking the
// offer and then walking the rest.
//
// Pure: the directory listing and the real-path check are injected (`PathDeps`), so
// the tests use a tree of their own and the chat hands in the filesystem.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { within } from '../assistant/shell.js';
import { completeValues, type ArgValues, type CompleteResult } from './commands.js';

const NONE = (head = ''): CompleteResult => ({ head, hasSpace: true, best: '', candidates: [] });

// ─── a `/command` and its argument ───────────────────────────────────────────
export type ChatCommandDef = { name: string; values?: ArgValues };

// `/co` completes the command's name — in the declared order, since the chat's
// commands are listed by what they are for, not alphabetically; a bare `/` lists them
// all (the field's own rule: a slash is a request for the list). `/notes o` completes
// the argument from the command's values (completeValues). Anything that is not a
// `/command` completes nothing.
export function completeSlash(text: string, commands: readonly ChatCommandDef[]): CompleteResult {
  if (!text.startsWith('/')) return NONE();
  const rest = text.slice(1);
  const m = rest.match(/^(\S*)(?:\s([\s\S]*))?$/);
  const head = m![1];
  if (m![2] === undefined) {
    const lower = head.toLowerCase();
    const matches = commands.map((c) => c.name).filter((n) => n.toLowerCase().startsWith(lower));
    const best = matches.find((n) => n.toLowerCase() !== lower) ?? matches[0] ?? '';
    return { head, hasSpace: false, best, candidates: matches };
  }
  const cmd = commands.find((c) => c.name.toLowerCase() === head.toLowerCase());
  return cmd?.values ? completeValues(m![2], cmd.values) : NONE();
}

// ─── a path in shell mode ────────────────────────────────────────────────────
// `link`: a symbolic link — the one kind of entry whose real path can lie outside the
// directory it is listed in, and so the only one checked against the roots.
export interface PathEntry { name: string; dir: boolean; link?: boolean }
export interface PathDeps {
  // The shell's directory, where a relative word starts.
  cwd: string;
  // The shell's roots by REAL path; nothing outside them is offered. `[]` — anywhere
  // (the rule `dirAllowed` in assistant/shell.ts keeps).
  roots: readonly string[];
  // The entries of a directory, or null when it cannot be listed.
  list: (abs: string) => PathEntry[] | null;
  // The real location of a path, links followed — what the roots are checked against.
  real: (abs: string) => string;
  // What `~` stands for; the person's home by default.
  home?: string;
}

// The last word of the line, with `\ ` read as a space inside it — the shell's own
// escape, and the one the candidates use.
export function lastWord(text: string): string {
  let i = text.length;
  while (i > 0) {
    const ch = text[i - 1]!;
    if (/\s/.test(ch) && !(i >= 2 && text[i - 2] === '\\')) break;
    i--;
  }
  return text.slice(i);
}
const escapeName = (name: string) => name.replace(/\\/g, '\\\\').replace(/ /g, '\\ ');
const unescape = (word: string) => word.replace(/\\(.)/g, '$1');

const allowed = (real: string, roots: readonly string[]) => !roots.length || roots.some((r) => within(real, r));

// The word under the caret as a path: its directory part is listed (relative to the
// shell's directory; `~` is the home), its last segment is the prefix. A directory
// gets a trailing `/`, a hidden entry is offered only for a word that starts with `.`,
// and a link whose real path is outside the roots — one that leads out — is not
// offered, nor is anything of a directory that is itself outside them. Only the
// directory and its links are resolved: a plain entry of a directory inside the roots
// is inside them, and resolving every entry would cost a syscall each per keystroke.
export function completePath(text: string, deps: PathDeps): CompleteResult {
  const word = lastWord(text);
  const home = deps.home ?? os.homedir();
  const slash = word.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : word.slice(0, slash + 1);
  const base = unescape(word.slice(slash + 1));
  const expanded = unescape(dirPart).replace(/^~(?=\/|$)/, home);
  const absDir = path.resolve(deps.cwd, expanded || '.');
  if (!allowed(deps.real(absDir), deps.roots)) return NONE(word);
  const entries = deps.list(absDir);
  if (!entries) return NONE(word);
  const candidates = entries
    .filter((e) => e.name.startsWith(base) && (base.startsWith('.') || !e.name.startsWith('.')))
    .filter((e) => !e.link || allowed(deps.real(path.join(absDir, e.name)), deps.roots))
    // Plain code-unit order, as `ls` sorts in the C locale — the same on every machine.
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => `${dirPart}${escapeName(e.name)}${e.dir ? '/' : ''}`);
  const best = candidates.find((c) => c !== word) ?? candidates[0] ?? '';
  return { head: word, hasSpace: true, best, candidates };
}

// The filesystem's listing for `PathDeps.list`: a link counts as a directory when
// its target is one; a path that is not a directory, or cannot be read, is null.
export function listDirectory(abs: string): PathEntry[] | null {
  try {
    return fs.readdirSync(abs, { withFileTypes: true }).map((d) => {
      const link = d.isSymbolicLink();
      let dir = d.isDirectory();
      if (link) { try { dir = fs.statSync(path.join(abs, d.name)).isDirectory(); } catch { dir = false; } }
      return { name: d.name, dir, link };
    });
  } catch { return null; }
}
