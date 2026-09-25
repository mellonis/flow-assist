// Which AGENTS.md files reach the model for the shell's directory: from the directory
// up to its enclosing root, outermost first, each capped — and nothing outside the roots.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INSTRUCTIONS_CAP, capInstructions, findInstructions, instructionsBlock, instructionsNote, instructionsSummary } from '../project-instructions.ts';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-instr-')));
const write = (p: string, text: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

test('from the directory up to its root, outermost first, nearest last', () => {
  const root = tmp();
  write(path.join(root, 'AGENTS.md'), 'root rules');
  write(path.join(root, 'app', 'AGENTS.md'), 'app rules');
  fs.mkdirSync(path.join(root, 'app', 'src', 'deep'), { recursive: true });
  write(path.join(root, 'app', 'src', 'deep', 'AGENTS.md'), 'deep rules');
  const found = findInstructions({ shell: { roots: [root] } }, path.join(root, 'app', 'src', 'deep'));
  expect(found.root).toBe(root);
  expect(found.files.map((f) => f.path)).toEqual([
    path.join(root, 'AGENTS.md'),
    path.join(root, 'app', 'AGENTS.md'),
    path.join(root, 'app', 'src', 'deep', 'AGENTS.md'),
  ]);
  expect(found.files.map((f) => f.text)).toEqual(['root rules', 'app rules', 'deep rules']);
});

test('nothing above the root is read — the root itself is the last directory asked', () => {
  const outer = tmp();
  write(path.join(outer, 'AGENTS.md'), 'above the root');
  const root = path.join(outer, 'work');
  write(path.join(root, 'proj', 'AGENTS.md'), 'proj rules');
  const inRoot = findInstructions({ shell: { roots: [root] } }, root);
  expect(inRoot.files).toEqual([]);
  const inProj = findInstructions({ shell: { roots: [root] } }, path.join(root, 'proj'));
  expect(inProj.files.map((f) => f.text)).toEqual(['proj rules']);
});

test('when the directory is a root, only its own file counts', () => {
  const root = tmp();
  write(path.join(root, 'AGENTS.md'), 'root rules');
  const found = findInstructions({ shell: { roots: [root] } }, root);
  expect(found.files.map((f) => f.text)).toEqual(['root rules']);
});

test('nested roots: the innermost enclosing root is the boundary', () => {
  const outer = tmp();
  write(path.join(outer, 'AGENTS.md'), 'outer rules');
  const inner = path.join(outer, 'inner');
  write(path.join(inner, 'AGENTS.md'), 'inner rules');
  const found = findInstructions({ shell: { roots: [outer, inner] } }, inner);
  expect(found.root).toBe(inner);
  expect(found.files.map((f) => f.text)).toEqual(['inner rules']);
});

test('a directory without the file is skipped; a missing directory finds nothing', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  write(path.join(root, 'a', 'b', 'AGENTS.md'), 'b rules');
  expect(findInstructions({ shell: { roots: [root] } }, path.join(root, 'a', 'b')).files.map((f) => f.text)).toEqual(['b rules']);
  expect(findInstructions({ shell: { roots: [root] } }, path.join(root, 'gone')).files).toEqual([]);
});

test('a directory outside the roots, or no roots at all, reads nothing', () => {
  const root = tmp();
  const other = tmp();
  write(path.join(other, 'AGENTS.md'), 'not ours');
  const outside = findInstructions({ shell: { roots: [root] } }, other);
  expect(outside).toMatchObject({ root: null, files: [] });
  expect(findInstructions({}, other)).toMatchObject({ root: null, files: [] });
});

test('the legacy fs.roots is read as the shell\'s roots', () => {
  const root = tmp();
  write(path.join(root, 'AGENTS.md'), 'root rules');
  expect(findInstructions({ fs: { roots: [root] } }, root).files).toHaveLength(1);
});

test('the name is case-sensitive: agents.md is not AGENTS.md, whatever the file system', () => {
  const root = tmp();
  write(path.join(root, 'agents.md'), 'lower case');
  expect(findInstructions({ shell: { roots: [root] } }, root).files).toEqual([]);
});

test('a link that leads out of the roots is not followed; a directory named AGENTS.md is not a file', () => {
  const root = tmp();
  const other = tmp();
  write(path.join(other, 'secret.md'), 'outside');
  fs.mkdirSync(path.join(root, 'a'));
  fs.symlinkSync(path.join(other, 'secret.md'), path.join(root, 'a', 'AGENTS.md'));
  expect(findInstructions({ shell: { roots: [root] } }, path.join(root, 'a')).files).toEqual([]);
  fs.mkdirSync(path.join(root, 'b', 'AGENTS.md'), { recursive: true });
  expect(findInstructions({ shell: { roots: [root] } }, path.join(root, 'b')).files).toEqual([]);
});

test('a directory reached through a link is walked by its real path', () => {
  const root = tmp();
  write(path.join(root, 'AGENTS.md'), 'root rules');
  write(path.join(root, 'proj', 'AGENTS.md'), 'proj rules');
  fs.symlinkSync(path.join(root, 'proj'), path.join(root, 'alias'));
  const found = findInstructions({ shell: { roots: [root] } }, path.join(root, 'alias'));
  expect(found.files.map((f) => f.path)).toEqual([path.join(root, 'AGENTS.md'), path.join(root, 'proj', 'AGENTS.md')]);
});

test('the cap: a file up to 32 KiB is whole; a larger one is cut at a line boundary with a note', () => {
  expect(INSTRUCTIONS_CAP).toBe(32 * 1024);
  const exact = 'x'.repeat(INSTRUCTIONS_CAP - 1) + '\n';
  expect(capInstructions(Buffer.from(exact))).toEqual({ text: exact, cut: 0 });
  const line = 'y'.repeat(99) + '\n'; // 100 bytes
  const big = line.repeat(400); // 40000 bytes, 400 lines
  const r = capInstructions(Buffer.from(big));
  expect(r.text).toBe(line.repeat(327).slice(0, -1)); // 32700 bytes fit, the newline dropped
  expect(r.cut).toBe(400 - 327);
  // A last line with no newline still counts as a line.
  expect(capInstructions(Buffer.from(big + 'tail')).cut).toBe(400 - 327 + 1);
  // One line longer than the cap: nothing of it is kept, and it is counted.
  expect(capInstructions(Buffer.from('z'.repeat(INSTRUCTIONS_CAP + 10) + '\nsecond\n'))).toEqual({ text: '', cut: 2 });
  // The cut never splits a multi-byte character: it is on a line boundary.
  const cyr = ('ж'.repeat(49) + '\n').repeat(400); // 99 bytes a line
  expect(capInstructions(Buffer.from(cyr)).text.includes('�')).toBe(false);
});

test('a large file on disk is cut, and the block says so', () => {
  const root = tmp();
  write(path.join(root, 'AGENTS.md'), ('r'.repeat(99) + '\n').repeat(400));
  const found = findInstructions({ shell: { roots: [root] } }, root);
  expect(found.files[0]!.cut).toBe(73);
  const block = instructionsBlock(found);
  expect(block).toContain('… (cut at 32 KiB — 73 more lines)');
  // Read from disk the way the pure cap reads a buffer: the edges agree.
  for (const text of ['x'.repeat(INSTRUCTIONS_CAP - 1) + '\n', ('r'.repeat(99) + '\n').repeat(400) + 'tail', 'z'.repeat(INSTRUCTIONS_CAP + 10) + '\nsecond\n', ('ж'.repeat(49) + '\n').repeat(2000)]) {
    write(path.join(root, 'AGENTS.md'), text);
    const [f] = findInstructions({ shell: { roots: [root] } }, root).files;
    expect({ text: f!.text, cut: f!.cut }).toEqual(capInstructions(Buffer.from(text)));
  }
});

test('the block: a section of its own, each file under its path; empty with no files', () => {
  const root = tmp();
  write(path.join(root, 'AGENTS.md'), '# Root\nroot rules');
  write(path.join(root, 'app', 'AGENTS.md'), 'app rules');
  const block = instructionsBlock(findInstructions({ shell: { roots: [root] } }, path.join(root, 'app')));
  expect(block.startsWith('## Project instructions\n')).toBe(true);
  const a = block.indexOf(`### ${path.join(root, 'AGENTS.md')}\n# Root\nroot rules`);
  const b = block.indexOf(`### ${path.join(root, 'app', 'AGENTS.md')}\napp rules`);
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
  expect(instructionsBlock(findInstructions({ shell: { roots: [root] } }, tmp()))).toBe('');
});

test('the note: said when the files change, silent when they do not', () => {
  const root = tmp();
  write(path.join(root, 'app', 'AGENTS.md'), 'app rules');
  fs.mkdirSync(path.join(root, 'app', 'src'));
  const cfg = { shell: { roots: [root] } };
  const none = findInstructions(cfg, root);
  const app = findInstructions(cfg, path.join(root, 'app'));
  const src = findInstructions(cfg, path.join(root, 'app', 'src'));
  const home = os.homedir();
  const shown = (p: string) => (p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
  expect(instructionsNote(none, none)).toBeNull();
  expect(instructionsNote(none, app)).toBe(`Project instructions: ${shown(path.join(root, 'app', 'AGENTS.md'))}`);
  expect(instructionsNote(app, src)).toBeNull(); // the same file, one level deeper
  expect(instructionsNote(src, none)).toBe(`Project instructions: none — no AGENTS.md between ${shown(root)} and its root`);
  expect(instructionsSummary(app)).toBe(shown(path.join(root, 'app', 'AGENTS.md')));
});
