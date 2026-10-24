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
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
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
  if (bytes.length > SKILL_CAP) err(1, `${SKILL_FILE} is larger than ${SKILL_CAP / 1024} KiB`);
  if (!NAME.test(dirName)) err(1, `the directory name «${dirName}» is not a skill name — letters, digits and -`);

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
  let i = 1;
  while (i < close) {
    const raw = lines[i]!;
    const at = i + 1;
    if (!raw.trim() || raw.trimStart().startsWith('#')) { i++; continue; }
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
      value = ''; // a list or a nested map: read, not interpreted
    } else {
      rest = rest.replace(/\s+#.*$/, '');
      value = [rest, ...child.map((l) => l.trim())].filter(Boolean).join(' ');
    }
    i = j;
    if (key !== 'name' && key !== 'description') {
      if (!notes.includes(key)) notes.push(key);
      continue;
    }
    if (!ok) continue;
    if (values.has(key)) { err(at, `"${key}" is given twice`); continue; }
    if (rest === '' && child.length) { err(at, `"${key}" is a list or a map, not text`); continue; }
    values.set(key, { value: value.replace(/\s+/g, ' ').trim(), line: at });
  }

  const name = values.get('name');
  if (name && name.value !== dirName) err(name.line, `name «${name.value}» differs from the directory's name «${dirName}»`);
  const description = values.get('description');
  if (!description) err(close + 1, 'the header has no "description"');
  else if (!description.value) err(description.line, '"description" is empty');
  if (errors.length) return { ok: false, errors };

  let b = close + 1;
  while (b < lines.length && !lines[b]!.trim()) b++;
  const body = lines.slice(b).join('\n').trimEnd();
  return { ok: true, skill: { name: dirName, description: description!.value, body, path: file, dir, source, notes } };
}

export type DirHash = { ok: true; hash: string; files: number; bytes: number } | { ok: false; message: string };

// The hash of a skill's whole directory: sha-256 over each file's relative path (with `/`),
// size and content, in sorted path order. A link is followed only when its target lies inside
// the directory; one that leads out, or a directory that cannot be read, is an error — the
// files beside the instructions are part of what the model is told to use.
export function skillDirHash(dir: string): DirHash {
  const h = createHash('sha256');
  let files = 0;
  let total = 0;
  let realRoot: string;
  try { realRoot = fs.realpathSync(dir); } catch (e) { return { ok: false, message: `the directory cannot be read: ${(e as Error).message}` }; }
  const inside = (p: string): boolean => p === realRoot || p.startsWith(realRoot + path.sep);
  const seen = new Set<string>();
  const entries: { rel: string; real: string }[] = [];
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
    entries.push({ rel, real });
    return null;
  };
  const why = walk(dir, '');
  if (!why) {
    entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    for (const { rel, real } of entries) {
      let data: Buffer;
      try { data = fs.readFileSync(real); } catch (e) { return { ok: false, message: `${rel} cannot be read: ${(e as Error).message}` }; }
      h.update(`${rel}\0${data.length}\0`);
      h.update(data);
      files++;
      total += data.length;
    }
  }
  return why ? { ok: false, message: why } : { ok: true, hash: h.digest('hex'), files, bytes: total };
}
