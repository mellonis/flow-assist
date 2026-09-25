// The project's own instructions for the model: the `AGENTS.md` files between the
// shell's directory and the `shell.roots` entry that holds it. The chat reads them
// whenever the shell's directory is set and puts them in the system prompt as a
// section of their own — README.md (project instructions).
//
// - From the directory up to, and not above, its root — the innermost root when roots
//   nest — outermost first, nearest last, so the nearer file is read last and wins
//   where two disagree. A directory that is itself a root has only its own file.
// - Nothing outside the roots is read: a directory outside them, or no roots at all,
//   finds nothing, and a file that is a link out of the roots is skipped. Paths are
//   compared REAL (a link in a clone must not carry the read out of it).
// - The name is exactly `AGENTS.md`, matched against the directory's listing — on a
//   case-insensitive file system a stat would also find `agents.md`.
// - Each file is capped at `INSTRUCTIONS_CAP` bytes, cut at a line boundary with a
//   note saying how many lines were left out, so a stray huge file does not eat the
//   context. Only the head is kept in memory; the rest is counted as it is read.

import fs from 'node:fs';
import path from 'node:path';
import { realOf, shellRoots, tildePath, within } from './shell.js';

export const INSTRUCTIONS_FILE = 'AGENTS.md';
export const INSTRUCTIONS_CAP = 32 * 1024;

export interface InstructionFile {
  path: string; // real, absolute
  text: string; // the file's text, up to the cap
  cut: number; // lines left out by the cap (0 — whole)
}
export interface ProjectInstructions {
  dir: string; // the directory asked about, real
  root: string | null; // the root that holds it, real; null — outside every root
  files: InstructionFile[]; // outermost first
}

const NONE = (dir: string): ProjectInstructions => ({ dir, root: null, files: [] });

// The text a file keeps under the cap, and how many lines the cut left out. A file
// of the cap or less is whole. Otherwise the head ends at the last line break within
// the cap (the break itself dropped); a first line longer than the cap keeps nothing.
export function capInstructions(bytes: Buffer, cap = INSTRUCTIONS_CAP): { text: string; cut: number } {
  if (bytes.length <= cap) return { text: bytes.toString('utf8'), cut: 0 };
  const nl = bytes.lastIndexOf(0x0a, cap - 1);
  const rest = bytes.subarray(nl + 1);
  return { text: nl < 0 ? '' : bytes.subarray(0, nl).toString('utf8'), cut: countLines(rest) };
}

function countLines(buf: Buffer): number {
  let n = 0;
  for (let i = buf.indexOf(0x0a); i >= 0; i = buf.indexOf(0x0a, i + 1)) n++;
  return buf.length && buf[buf.length - 1] !== 0x0a ? n + 1 : n;
}

// A file read through the cap: the head (one byte past the cap, so a file of exactly
// the cap is known to be whole) and the rest counted in chunks, never held.
function readCapped(file: string, cap = INSTRUCTIONS_CAP): { text: string; cut: number } {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(cap + 1);
    const got = fs.readSync(fd, head, 0, head.length, 0);
    if (got <= cap) return { text: head.subarray(0, got).toString('utf8'), cut: 0 };
    const nl = head.lastIndexOf(0x0a, cap - 1);
    const text = nl < 0 ? '' : head.subarray(0, nl).toString('utf8');
    // Lines from just after the break to the end of the file.
    let cut = 0;
    let last = 0x0a;
    let pos = nl + 1;
    const chunk = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      const part = chunk.subarray(0, n);
      for (let i = part.indexOf(0x0a); i >= 0; i = part.indexOf(0x0a, i + 1)) cut++;
      last = part[n - 1]!;
      pos += n;
    }
    if (pos > nl + 1 && last !== 0x0a) cut++;
    return { text, cut };
  } finally {
    fs.closeSync(fd);
  }
}

const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// The instruction files for `dir`, from its root down to it.
export function findInstructions(config: Parameters<typeof shellRoots>[0], dir: string): ProjectInstructions {
  const real = realOf(path.resolve(dir));
  if (!isDir(real)) return NONE(real);
  const roots = shellRoots(config).map(realOf);
  // The innermost root that holds the directory.
  const root = roots.filter((r) => within(real, r)).sort((a, b) => b.length - a.length)[0];
  if (!root) return NONE(real);
  const dirs: string[] = [];
  for (let d = real; ; d = path.dirname(d)) {
    dirs.unshift(d);
    if (d === root || path.dirname(d) === d) break;
  }
  const files: InstructionFile[] = [];
  for (const d of dirs) {
    let names: string[];
    try { names = fs.readdirSync(d); } catch { continue; }
    if (!names.includes(INSTRUCTIONS_FILE)) continue;
    const file = realOf(path.join(d, INSTRUCTIONS_FILE));
    if (!roots.some((r) => within(file, r))) continue; // a link out of the roots
    if (files.some((f) => f.path === file)) continue; // a link to a file already found
    try {
      if (!fs.statSync(file).isFile()) continue; // a directory, a FIFO — never read
      files.push({ path: file, ...readCapped(file) });
    } catch { /* gone, or unreadable: nothing to add */ }
  }
  return { dir: real, root, files };
}

const capNote = (cut: number) => `… (cut at ${INSTRUCTIONS_CAP / 1024} KiB — ${cut} more line${cut === 1 ? '' : 's'})`;

// The system prompt's section — '' when there is nothing to say.
export function instructionsBlock(p: ProjectInstructions): string {
  if (!p.files.length) return '';
  const head = `## Project instructions\nThe ${INSTRUCTIONS_FILE} files from the shell's directory (${p.dir}) up to its root (${p.root}), outermost first: they are the project's own rules for working in it, and where two disagree the later, nearer one wins.`;
  const files = p.files.map((f) => `### ${f.path}\n${f.text}${f.cut ? `${f.text ? '\n' : ''}${capNote(f.cut)}` : ''}`);
  return [head, ...files].join('\n\n');
}

// The files as the person reads them: `~`-shortened, a cut one marked.
export function instructionsSummary(p: ProjectInstructions): string {
  return p.files.map((f) => `${tildePath(f.path)}${f.cut ? ` (cut at ${INSTRUCTIONS_CAP / 1024} KiB)` : ''}`).join(', ');
}

// What the chat says when the files picked up change — null when they have not. A
// move between directories that share the same files says nothing.
export function instructionsNote(prev: ProjectInstructions, next: ProjectInstructions): string | null {
  const key = (p: ProjectInstructions) => p.files.map((f) => `${f.path}:${f.cut}`).join('\n');
  if (key(prev) === key(next)) return null;
  if (next.files.length) return `Project instructions: ${instructionsSummary(next)}`;
  return next.root ? `Project instructions: none — no ${INSTRUCTIONS_FILE} between ${tildePath(next.dir)} and its root` : 'Project instructions: none — the shell is outside the roots';
}
