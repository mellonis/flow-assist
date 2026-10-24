import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { spyOn } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import { clearSkillHashCache, loadSkillFresh, parseSkillFile, skillDirHash, skillDirHashCached, SKILL_CAP, SKILL_MAX_BYTES, SKILL_MAX_FILES } from '../skill-file.ts';

const made: string[] = [];
const tmp = (p: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };
afterEach(() => { clearSkillHashCache(); for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const parse = (text: string, dirName = 'pdf') => parseSkillFile(`/x/${dirName}/SKILL.md`, text, { kind: 'person' }, dirName);
const okOf = (text: string, dirName?: string) => { const r = parse(text, dirName); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r.skill; };
const errsOf = (text: string, dirName?: string) => { const r = parse(text, dirName); if (r.ok) throw new Error('parsed'); return r.errors; };

test('a plain header gives the description and the body', () => {
  const s = okOf('---\nname: pdf\ndescription: Extract text.\n---\n\nStep one.\nStep two.\n');
  expect(s).toMatchObject({ name: 'pdf', description: 'Extract text.', body: 'Step one.\nStep two.', notes: [] });
});

test('quoted scalars lose their quotes and keep a colon', () => {
  expect(okOf('---\ndescription: "Use when: the user asks"\n---\nb').description).toBe('Use when: the user asks');
  expect(okOf("---\ndescription: 'it''s fine'\n---\nb").description).toBe("it's fine");
  expect(errsOf('---\ndescription: "open\n---\nb')[0]).toMatchObject({ line: 2, message: 'the quoted value of "description" is not closed' });
});

test('block scalars and continuation lines fold into one line', () => {
  expect(okOf('---\ndescription: >\n  First part\n  second part\n---\nb').description).toBe('First part second part');
  expect(okOf('---\ndescription: |-\n  one\n  two\n---\nb').description).toBe('one two');
  expect(okOf('---\ndescription: First\n  continued # not a comment inside\n---\nb').description).toBe('First continued # not a comment inside');
  expect(okOf('---\ndescription: x # a comment\n---\nb').description).toBe('x');
});

test('other keys — scalars, lists, nested maps — are read and listed once as notes', () => {
  const s = okOf('---\ndescription: d\nallowed-tools:\n  - Read\n  - Grep\nlicense: MIT\nmetadata:\n  author: me\n  tags:\n    - a\nallowed-tools2: x\n---\nbody');
  expect(s.notes).toEqual(['allowed-tools', 'license', 'metadata', 'allowed-tools2']);
  expect(s.description).toBe('d');
  expect(okOf('---\ndescription: d\ntools:\n- Read\n---\nb').notes).toEqual(['tools']);
  expect(okOf('---\ndescription: d\nlicense: a\nlicense: b\n---\nb').notes).toEqual(['license']);
});

test('CRLF and a BOM are read', () => {
  expect(okOf('﻿---\r\ndescription: d\r\n---\r\nbody\r\n').body).toBe('body');
});

test('a name that differs from the directory is an error naming both', () => {
  expect(errsOf('---\nname: other\ndescription: d\n---\nb')).toEqual([
    { path: '/x/pdf/SKILL.md', line: 2, message: "name «other» differs from the directory's name «pdf»" },
  ]);
});

test('errors carry their line: no header, unclosed header, missing/empty/repeated/structured description, stray lines', () => {
  expect(errsOf('no header')[0]).toMatchObject({ line: 1 });
  expect(errsOf('---\ndescription: d\n')[0]!.message).toMatch(/not closed/);
  expect(errsOf('---\nname: pdf\n---\nb')[0]).toMatchObject({ line: 3, message: 'the header has no "description"' });
  expect(errsOf('---\ndescription:\n---\nb')[0]).toMatchObject({ line: 2, message: '"description" is empty' });
  expect(errsOf('---\ndescription: a\ndescription: b\n---\nb')[0]).toMatchObject({ line: 3, message: '"description" is given twice' });
  expect(errsOf('---\ndescription:\n  - a\n---\nb')[0]).toMatchObject({ line: 2, message: '"description" is a list or a map, not text' });
  expect(errsOf('---\ndescription: d\nnot a key\n---\nb')[0]).toMatchObject({ line: 3, message: 'expected "key: value"' });
  expect(errsOf('---\n  stray: x\ndescription: d\n---\nb')[0]).toMatchObject({ line: 2 });
});

test('a directory name that is not a name is an error', () => {
  expect(errsOf('---\ndescription: d\n---\nb', 'bad_name')[0]!.message).toMatch(/not a skill name/);
});

test('a placeholder in the body is text', () => {
  expect(okOf('---\ndescription: d\n---\nuse {{this}} as is').body).toBe('use {{this}} as is');
});

test('a file over the cap is an error, one at the cap is read', () => {
  const head = '---\ndescription: d\n---\n';
  expect(errsOf(head + 'x'.repeat(SKILL_CAP))[0]!.message).toBe('SKILL.md is larger than 32 KiB');
  expect(okOf(head + 'x'.repeat(SKILL_CAP - head.length)).body.length).toBe(SKILL_CAP - head.length);
});

const skillDir = (files: Record<string, string>) => {
  const d = tmp('fa-skill-hash-');
  for (const [rel, text] of Object.entries(files)) { const f = path.join(d, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
  return d;
};

test('the directory hash covers every file, its path and its content, and not the order of creation', () => {
  const base = { 'SKILL.md': 'a', 'refs/x.md': 'one' };
  const h = (d: string) => { const r = skillDirHash(d); if (!r.ok) throw new Error(r.message); return r; };
  const a = h(skillDir(base));
  expect(a).toMatchObject({ files: 2, bytes: 4 });
  expect(h(skillDir({ 'refs/x.md': 'one', 'SKILL.md': 'a' })).hash).toBe(a.hash);
  // the digest is over the sorted relative paths, each with its size and content
  expect(a.hash).toBe(createHash('sha256').update('SKILL.md\x00-\x001\x00a').update('refs/x.md\x00-\x003\x00one').digest('hex'));
  expect(h(skillDir({ ...base, 'refs/x.md': 'two' })).hash).not.toBe(a.hash); // content beside the body
  expect(h(skillDir({ 'SKILL.md': 'a', 'refs/y.md': 'one' })).hash).not.toBe(a.hash); // a path
  expect(h(skillDir({ ...base, 'scripts/new.sh': '' })).hash).not.toBe(a.hash); // an added file
  expect(h(skillDir({ 'SKILL.md': 'ao', 'refs/x.md': 'ne' })).hash).not.toBe(h(skillDir({ 'SKILL.md': 'a', 'refs/x.md': 'one' })).hash);
});

test('the digest walks paths in sorted order whatever the directory lists first', () => {
  const names = ['zeta.md', 'Beta.md', 'alpha/deep.md', 'alpha.md', 'SKILL.md', 'm/n/o.md', '0.md'];
  const r = skillDirHash(skillDir(Object.fromEntries(names.map((n) => [n, n]))));
  const want = createHash('sha256');
  for (const n of [...names].sort()) want.update(`${n}\0-\0${n.length}\0${n}`);
  expect(r).toMatchObject({ ok: true, hash: want.digest('hex') });
});

test('a link out of the directory is an error; a link inside is followed', () => {
  const outside = tmp('fa-skill-out-');
  fs.writeFileSync(path.join(outside, 'secret'), 's');
  const d = skillDir({ 'SKILL.md': 'a', 'real.md': 'r' });
  fs.symlinkSync('real.md', path.join(d, 'alias.md'));
  expect(skillDirHash(d)).toMatchObject({ ok: true, files: 3 });
  fs.symlinkSync(path.join(outside, 'secret'), path.join(d, 'leak'));
  const r = skillDirHash(d);
  expect(r).toEqual({ ok: false, message: "leak is a link out of the skill's directory" });
  const d2 = skillDir({ 'SKILL.md': 'a' });
  fs.symlinkSync(outside, path.join(d2, 'dir-leak'));
  expect(skillDirHash(d2).ok).toBe(false);
});

test('an empty key followed by indented plain lines is one scalar; a failed description is not also missing', () => {
  expect(okOf('---\ndescription:\n  Use this when\n  the user asks.\nname: pdf\n---\nb').description).toBe('Use this when the user asks.');
  expect(errsOf('---\ndescription: "open\n---\nb')).toHaveLength(1);
  expect(errsOf('---\ndescription:\n  - a\n---\nb')).toHaveLength(1);
  expect(errsOf('---\ndescription:\n  k: v\n---\nb')).toHaveLength(1);
});

test('\\u, \\x and \\U escapes in double quotes give the character; a bad one does not close', () => {
  expect(okOf('---\ndescription: "caf\\u00e9 \\x41 \\U0001F600 \\"q\\""\n---\nb').description).toBe('café A \u{1F600} "q"');
  expect(errsOf('---\ndescription: "bad \\uZZ"\n---\nb')[0]!.message).toMatch(/not closed/);
});

test('a document-end line in the header is passed over', () => {
  expect(okOf('---\ndescription: d\n...\n---\nb').description).toBe('d');
});

test('an oversize file or a bad directory name stops the parse at that one error', () => {
  expect(errsOf('x'.repeat(SKILL_CAP + 1))).toHaveLength(1);
  expect(errsOf('no header', 'bad_name')).toHaveLength(1);
});

const hashOf = (r: ReturnType<typeof skillDirHash>) => { if (!r.ok) throw new Error(r.message); return r.hash; };

test('the execute bit is in the hash', () => {
  const d = skillDir({ 'SKILL.md': 'a', 'run.sh': 'echo' });
  const before = hashOf(skillDirHash(d));
  fs.chmodSync(path.join(d, 'run.sh'), 0o755);
  expect(hashOf(skillDirHash(d))).not.toBe(before);
});

test('more than 256 files, or more than 2 MiB, is an error', () => {
  const many = skillDir(Object.fromEntries(Array.from({ length: SKILL_MAX_FILES + 1 }, (_, k) => [`f${k}`, 'x'])));
  expect(skillDirHash(many)).toEqual({ ok: false, message: 'the directory holds more than 256 files' });
  expect(skillDirHash(skillDir(Object.fromEntries(Array.from({ length: SKILL_MAX_FILES }, (_, k) => [`f${k}`, 'x'])))).ok).toBe(true);
  const big = skillDir({ 'SKILL.md': 'a', 'data.bin': 'x'.repeat(SKILL_MAX_BYTES) });
  expect(skillDirHash(big)).toEqual({ ok: false, message: 'the directory holds more than 2 MiB' });
});

test('the cached hash reads no content while the stat signature holds, and again when ctime moves though size and mtime are put back', () => {
  const d = skillDir({ 'SKILL.md': 'aaaa', 'refs/x.md': 'bbbb' });
  const f = path.join(d, 'refs', 'x.md');
  fs.utimesSync(f, 1_000_000_000, 1_000_000_000); // a whole-second mtime that can be put back exactly
  const first = hashOf(skillDirHashCached(d));
  const spy = spyOn(fs, 'readFileSync');
  try {
    expect(hashOf(skillDirHashCached(d))).toBe(first);
    expect(spy).not.toHaveBeenCalled();
    fs.writeFileSync(f, 'cccc'); // the same size
    fs.utimesSync(f, 1_000_000_000, 1_000_000_000); // mtime restored; ctime cannot be
    const second = hashOf(skillDirHashCached(d));
    expect(spy).toHaveBeenCalled();
    expect(second).not.toBe(first);
    expect(second).toBe(hashOf(skillDirHash(d)));
  } finally { spy.mockRestore(); }
});

test('loadSkillFresh reads every file again and returns the body and the hash of those bytes', () => {
  const d = skillDir({ 'SKILL.md': '---\ndescription: d\n---\nthe body\n', 'refs/x.md': 'r' });
  const cached = hashOf(skillDirHashCached(d));
  const spy = spyOn(fs, 'readFileSync');
  try {
    const r = loadSkillFresh(d, { kind: 'person' }, 'fresh');
    if (!r.ok) throw new Error('not ok');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(r.skill).toMatchObject({ name: 'fresh', body: 'the body', hash: cached, files: 2, dir: d });
  } finally { spy.mockRestore(); }
  const bad = loadSkillFresh(skillDir({ 'refs/x.md': 'r' }), { kind: 'person' }, 'x');
  expect(bad).toMatchObject({ ok: false });
});
