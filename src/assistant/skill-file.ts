// A skill: a directory `<name>/` holding `SKILL.md` and any files beside it. The file is a
// header between two `---` lines, then the body, the instructions the model follows in the
// conversation that loads it. The header is read by a small reader of our own for the
// subset of YAML such files use, so a skill written for another assistant loads as it is:
//
//   key: value          a plain scalar; a ` #` comment ends it; indented lines continue it
//   key: "v" / 'v'      a quoted scalar, unquoted, on one line or several
//   key: > / key: |     a block scalar (folded / literal), `-` and `+` indicators accepted
//   key:                followed by `- item` lines or an indented map: read, not interpreted
//
// `name` (letters, digits, `-`; equal to the directory's name when given) and `description`
// (required) are known. Every other key is read and ignored; the keys are returned as
// notes. Every error names the file and the 1-based line it stands on, and a file with any
// error is not a skill. There is no `{{param}}` pass: a body is text.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { INSTRUCTIONS_CAP } from './project-instructions.js';
import type { AgentError, AgentSource } from './agent-file.js';

export type SkillSource = AgentSource;
export type SkillError = AgentError;
export interface Skill {
  name: string; // the directory's name
  description: string; // one line
  body: string;
  path: string; // the SKILL.md as asked for
  dir: string; // the skill's directory (the real path when found by the finder)
  source: SkillSource;
  notes: string[]; // the keys of the header that are read and ignored, once each
  hash: string; // of the whole directory, see `skillDirHash`
  files: number; // files under the directory
  bytes: number; // their total size
}
export type ParsedSkill = { ok: true; skill: Omit<Skill, 'hash' | 'files' | 'bytes'> } | { ok: false; errors: SkillError[] };

export const SKILL_FILE = 'SKILL.md';
// The core tool that loads a skill into the conversation.
export const SKILL_TOOL = 'skill';
export const SKILL_CAP = INSTRUCTIONS_CAP;
const NAME = /^[A-Za-z0-9-]+$/;
const KEY = /^([A-Za-z_][A-Za-z0-9_.-]*):(?:[ \t]+(.*))?$/;
const BLOCK = /^([>|])([+-]?)(\d?)$/;
const indentOf = (s: string): number => s.length - s.trimStart().length;

// A quoted scalar's text without its quotes, or null when it does not close.
function unquote(raw: string): { value: string; rest: string } | null {
  const q = raw[0]!;
  let out = '';
  for (let i = 1; i < raw.length; i++) {
    const ch = raw[i]!;
    if (q === '"' && ch === '\\') {
      const n = raw[++i];
      if (n === undefined) return null;
      const width = n === 'x' ? 2 : n === 'u' ? 4 : n === 'U' ? 8 : 0;
      if (width) {
        const digits = raw.slice(i + 1, i + 1 + width);
        const code = /^[0-9A-Fa-f]+$/.test(digits) && digits.length === width ? parseInt(digits, 16) : NaN;
        if (Number.isNaN(code) || code > 0x10ffff) return null;
        out += String.fromCodePoint(code);
        i += width;
      } else out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === '0' ? '\0' : n;
    } else if (q === "'" && ch === "'" && raw[i + 1] === "'") { out += "'"; i++; }
    else if (ch === q) return { value: out, rest: raw.slice(i + 1) };
    else out += ch;
  }
  return null;
}

export function parseSkillFile(file: string, content: string | Uint8Array, source: SkillSource, dirName: string, dir = path.dirname(file)): ParsedSkill {
  const bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
  const text = bytes.toString('utf8').replace(/^﻿/, '');
  const errors: SkillError[] = [];
  const err = (line: number, message: string) => errors.push({ path: file, line, message });
  if (bytes.length > SKILL_CAP) { err(1, `${SKILL_FILE} is larger than ${SKILL_CAP / 1024} KiB`); return { ok: false, errors }; }
  if (!NAME.test(dirName)) { err(1, `the directory name «${dirName}» is not a skill name — letters, digits and -`); return { ok: false, errors }; }

  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') {
    err(1, 'the file does not start with a header — the first line is ---');
    return { ok: false, errors };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i]!.trimEnd() === '---') { close = i; break; }
  if (close < 0) {
    err(1, 'the header is not closed — a second --- line is missing');
    return { ok: false, errors };
  }

  const values = new Map<string, { value: string; line: number }>();
  const notes: string[] = [];
  const seen = new Set<string>(); // known keys met, whether or not they read
  let i = 1;
  while (i < close) {
    const raw = lines[i]!;
    const at = i + 1;
    if (!raw.trim() || raw.trimStart().startsWith('#') || raw.trimEnd() === '...') { i++; continue; }
    const m = indentOf(raw) === 0 ? KEY.exec(raw.trimEnd()) : null;
    if (!m) { err(at, indentOf(raw) ? 'an indented line with no key above it' : 'expected "key: value"'); i++; continue; }
    const key = m[1]!;
    let rest = (m[2] ?? '').trim();
    i++;
    // The lines that belong to this key: indented ones, blank ones between them, and `- ` items.
    const belongs = (j: number): boolean => j < close && (!lines[j]!.trim() || indentOf(lines[j]!) > 0 || lines[j]!.startsWith('- ') || lines[j]!.trimEnd() === '-');
    const child: string[] = [];
    let j = i;
    while (belongs(j)) { child.push(lines[j]!); j++; }
    while (child.length && !child[child.length - 1]!.trim()) child.pop();
    let value = '';
    let ok = true;
    const block = BLOCK.exec(rest);
    if (block) {
      const pad = Math.min(...child.filter((l) => l.trim()).map(indentOf), Infinity);
      const body = child.map((l) => (l.trim() ? l.slice(Number.isFinite(pad) ? pad : 0) : ''));
      value = body.join(block[1] === '|' ? '\n' : ' ');
    } else if (rest.startsWith('"') || rest.startsWith("'")) {
      const joined = [rest, ...child.map((l) => l.trim())].join(' ');
      const u = unquote(joined);
      if (!u) { err(at, `the quoted value of "${key}" is not closed`); ok = false; }
      else {
        value = u.value;
        const tail = u.rest.trim();
        if (tail && !tail.startsWith('#')) { err(at, `unexpected text after the quoted value of "${key}"`); ok = false; }
      }
    } else if (rest === '') {
      // A list or a nested map is read, not interpreted; indented plain lines are one scalar.
      const structured = child.some((l) => /^\s*-(\s|$)/.test(l) || /^\s*[A-Za-z_][A-Za-z0-9_.-]*:(\s|$)/.test(l));
      value = structured ? '' : child.map((l) => l.trim()).filter(Boolean).join(' ');
      if (structured) rest = '-';
    } else {
      rest = rest.replace(/\s+#.*$/, '');
      value = [rest, ...child.map((l) => l.trim())].filter(Boolean).join(' ');
    }
    i = j;
    if (key !== 'name' && key !== 'description') {
      if (!notes.includes(key)) notes.push(key);
      continue;
    }
    seen.add(key);
    if (!ok) continue;
    if (values.has(key)) { err(at, `"${key}" is given twice`); continue; }
    if (rest === '-') { err(at, `"${key}" is a list or a map, not text`); continue; }
    values.set(key, { value: value.replace(/\s+/g, ' ').trim(), line: at });
  }

  const name = values.get('name');
  if (name && name.value !== dirName) err(name.line, `name «${name.value}» differs from the directory's name «${dirName}»`);
  const description = values.get('description');
  if (!description && !seen.has('description')) err(close + 1, 'the header has no "description"');
  else if (description && !description.value) err(description.line, '"description" is empty');
  if (errors.length) return { ok: false, errors };

  let b = close + 1;
  while (b < lines.length && !lines[b]!.trim()) b++;
  const body = lines.slice(b).join('\n').trimEnd();
  return { ok: true, skill: { name: dirName, description: description!.value, body, path: file, dir, source, notes } };
}

export type DirHash = { ok: true; hash: string; files: number; bytes: number } | { ok: false; message: string };

export const SKILL_MAX_FILES = 256;
export const SKILL_MAX_BYTES = 2 * 1024 * 1024;

interface ScanEntry { rel: string; real: string; size: number; mtimeMs: number; ctimeMs: number; ino: number; mode: number }
type Scan = { ok: true; entries: ScanEntry[]; signature: string; bytes: number } | { ok: false; message: string };

// The files of a skill's directory, found by walking and stat: no content is read. A link
// is followed only when its target lies inside the directory; one that leads out, an
// unreadable entry, more than SKILL_MAX_FILES files or SKILL_MAX_BYTES bytes is an error —
// the files beside the instructions are part of what the model is told to use, and a
// directory too big to hash is too big to trust. Empty directories carry no content and
// are not part of the result.
function scanSkillDir(dir: string): Scan {
  let realRoot: string;
  try { realRoot = fs.realpathSync(dir); } catch (e) { return { ok: false, message: `the directory cannot be read: ${(e as Error).message}` }; }
  const inside = (p: string): boolean => p === realRoot || p.startsWith(realRoot + path.sep);
  const seen = new Set<string>();
  const entries: ScanEntry[] = [];
  let total = 0;
  const walk = (abs: string, rel: string): string | null => {
    let real: string;
    try { real = fs.realpathSync(abs); } catch (e) { return `${rel || '.'} cannot be read: ${(e as Error).message}`; }
    if (!inside(real)) return `${rel || '.'} is a link out of the skill's directory`;
    let st: fs.Stats;
    try { st = fs.statSync(real); } catch (e) { return `${rel || '.'} cannot be read: ${(e as Error).message}`; }
    if (st.isDirectory()) {
      if (seen.has(real)) return null;
      seen.add(real);
      let names: string[];
      try { names = fs.readdirSync(abs).sort(); } catch (e) { return `${rel || '.'} cannot be read: ${(e as Error).message}`; }
      for (const n of names) {
        const why = walk(path.join(abs, n), rel ? `${rel}/${n}` : n);
        if (why) return why;
      }
      return null;
    }
    if (!st.isFile()) return null; // a FIFO, a socket — not content
    if (entries.length >= SKILL_MAX_FILES) return `the directory holds more than ${SKILL_MAX_FILES} files`;
    total += st.size;
    if (total > SKILL_MAX_BYTES) return `the directory holds more than ${SKILL_MAX_BYTES / 1024 / 1024} MiB`;
    entries.push({ rel, real, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino, mode: st.mode });
    return null;
  };
  const why = walk(dir, '');
  if (why) return { ok: false, message: why };
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const signature = entries.map((e) => `${e.rel}\0${e.size}\0${e.mtimeMs}\0${e.ctimeMs}\0${e.ino}\0${e.mode}`).join('\n');
  return { ok: true, entries, signature, bytes: total };
}

// The digest: sha-256 over each file's relative path (with `/`), whether any execute bit is
// set, size and content, in sorted path order.
function digest(entries: readonly ScanEntry[], data: readonly Buffer[]): string {
  const h = createHash('sha256');
  entries.forEach((e, k) => {
    h.update(`${e.rel}\0${e.mode & 0o111 ? 'x' : '-'}\0${data[k]!.length}\0`);
    h.update(data[k]!);
  });
  return h.digest('hex');
}

function readAll(entries: readonly ScanEntry[]): Buffer[] | string {
  const data: Buffer[] = [];
  for (const e of entries) {
    try { data.push(fs.readFileSync(e.real)); } catch (err) { return `${e.rel} cannot be read: ${(err as Error).message}`; }
  }
  return data;
}

// The hash of a skill's whole directory, every file read now (no cache).
export function skillDirHash(dir: string): DirHash {
  const scan = scanSkillDir(dir);
  if (!scan.ok) return scan;
  const data = readAll(scan.entries);
  if (typeof data === 'string') return { ok: false, message: data };
  return { ok: true, hash: digest(scan.entries, data), files: scan.entries.length, bytes: scan.bytes };
}

// The same hash for a listing, which asks every round: content is read only when the stat
// signature of the directory (path, size, mtime, ctime, inode, mode per file) differs from
// the last call's for this real directory. ctime cannot be set by a program, so a file
// rewritten with its mtime put back still differs.
// The cache holds at most SKILL_HASH_CACHE_MAX directories; the least recently asked goes first.
export const SKILL_HASH_CACHE_MAX = 128;
const hashCache = new Map<string, { signature: string; result: DirHash }>();
export function clearSkillHashCache(): void { hashCache.clear(); }
export const skillHashCacheSize = (): number => hashCache.size;
export function skillDirHashCached(dir: string): DirHash {
  const scan = scanSkillDir(dir);
  if (!scan.ok) return scan;
  let key: string;
  try { key = fs.realpathSync(dir); } catch { key = dir; }
  const hit = hashCache.get(key);
  if (hit && hit.signature === scan.signature) {
    hashCache.delete(key);
    hashCache.set(key, hit); // most recently asked last
    return hit.result;
  }
  const data = readAll(scan.entries);
  if (typeof data === 'string') return { ok: false, message: data };
  const result: DirHash = { ok: true, hash: digest(scan.entries, data), files: scan.entries.length, bytes: scan.bytes };
  hashCache.delete(key);
  hashCache.set(key, { signature: scan.signature, result });
  while (hashCache.size > SKILL_HASH_CACHE_MAX) hashCache.delete(hashCache.keys().next().value!);
  return result;
}

// A skill read for loading: one walk, every file read once, the hash and the body taken
// from those same bytes, so the body shown is the content hashed. Never cached.
export function loadSkillFresh(dir: string, source: SkillSource, dirName = path.basename(dir)): { ok: true; skill: Skill } | { ok: false; errors: SkillError[] } {
  const file = path.join(dir, SKILL_FILE);
  const refuse = (message: string) => ({ ok: false as const, errors: [{ path: file, line: 1, message }] });
  const scan = scanSkillDir(dir);
  if (!scan.ok) return refuse(scan.message);
  const data = readAll(scan.entries);
  if (typeof data === 'string') return refuse(data);
  const at = scan.entries.findIndex((e) => e.rel === SKILL_FILE);
  if (at < 0) return refuse(`${SKILL_FILE} is missing`);
  let realDir = dir;
  try { realDir = fs.realpathSync(dir); } catch { /* as given */ }
  const parsed = parseSkillFile(file, data[at]!, source, dirName, realDir);
  if (!parsed.ok) return parsed;
  return { ok: true, skill: { ...parsed.skill, hash: digest(scan.entries, data), files: scan.entries.length, bytes: scan.bytes } };
}
