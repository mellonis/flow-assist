import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addFact, MEMORY_PROMPT_LINES, memoryPromptBlock, migrateMemoryJson, parseFact, readFacts, removeFact, saveFact } from '../memory-store.js';

const ws = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-memws-')));
const index = (dir: string) => fs.readFileSync(path.join(dir, 'memory', 'MEMORY.md'), 'utf8');

test('a fact is a file with front matter, and MEMORY.md has one line per file', () => {
  const dir = ws();
  const f = addFact(dir, { text: 'This repo rebases; it never merges.', name: 'Rebase, never merge', type: 'convention' });
  expect(f.id).toBe('rebase-never-merge');
  const file = path.join(dir, 'memory', 'rebase-never-merge.md');
  expect(fs.readFileSync(file, 'utf8')).toBe('---\nname: Rebase, never merge\ndescription: This repo rebases; it never merges.\ntype: convention\n---\nThis repo rebases; it never merges.\n');
  expect(index(dir)).toContain('- [Rebase, never merge](rebase-never-merge.md) — This repo rebases; it never merges.');
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.join(dir, 'memory')).mode & 0o777).toBe(0o700);
  expect(readFacts(dir).map((x) => x.text)).toEqual(['This repo rebases; it never merges.']);
});

test('a name gives a slug of [a-z0-9-] only, never MEMORY (the index, whatever the case of the disk), and a taken one gets a number', () => {
  const dir = ws();
  expect(addFact(dir, { text: 'a', name: 'Ключ: ../../etc/passwd' }).id).toMatch(/^[a-z0-9-]+$/);
  expect(addFact(dir, { text: 'b', name: 'memory' }).id).not.toBe('memory');
  expect(addFact(dir, { text: 'c', name: 'Same' }).id).toBe('same');
  expect(addFact(dir, { text: 'd', name: 'same' }).id).toBe('same-2');
  // No name: the first words of the text.
  expect(addFact(dir, { text: 'Prefers tabs over spaces in Go' }).id).toBe('prefers-tabs-over-spaces-in-go');
  // The index is never read as a fact.
  expect(readFacts(dir).every((f) => f.id.toLowerCase() !== 'memory')).toBe(true);
});

test('a value that tries to break the front matter or the index is flattened to one line', () => {
  const dir = ws();
  const f = addFact(dir, { text: 'x', name: 'a]\n---\nname: evil', description: 'd\n---\ntype: secret\n- [x](y) — z' });
  const back = parseFact(f.id, fs.readFileSync(path.join(dir, 'memory', `${f.id}.md`), 'utf8'))!;
  expect(back.name).not.toContain('\n');
  expect(back.name).not.toContain(']');
  expect(back.description).not.toContain('\n');
  expect(back.type).toBe('fact');
  expect(index(dir).trim().split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1);
});

test('saving and removing keep the index current; a link and a stray file are not facts', () => {
  const dir = ws();
  const f = addFact(dir, { text: 'one' });
  saveFact(dir, { ...f, text: 'one, changed', description: 'changed' });
  expect(index(dir)).toContain('— changed');
  fs.writeFileSync(path.join(dir, 'memory', 'notes.txt'), 'not a fact');
  fs.symlinkSync('/etc/hosts', path.join(dir, 'memory', 'hosts.md'));
  expect(readFacts(dir).map((x) => x.id)).toEqual([f.id]);
  expect(removeFact(dir, f.id)).toBe(true);
  expect(removeFact(dir, f.id)).toBe(false);
  expect(readFacts(dir)).toEqual([]);
  expect(index(dir)).not.toContain('one');
});

test('the prompt carries the index of both scopes, framed as the model\'s own notes — never a fact\'s full text', () => {
  const p = ws();
  const g = ws();
  addFact(p, { text: 'The build needs ZANZIBAR set before it runs.', name: 'Build variable', description: 'what the build needs' });
  addFact(g, { text: 'Answers in Russian unless asked otherwise.', name: 'Language', description: 'which language to answer in' });
  const block = memoryPromptBlock(readFacts(p), readFacts(g));
  expect(block).toContain('- [Build variable](memory/build-variable.md) — what the build needs');
  expect(block).toContain('- [Language](memory/language.md) — which language to answer in');
  expect(block).not.toContain('ZANZIBAR');
  expect(block).toContain('your own notes');
  expect(block).toContain('never the person');
  expect(block).toContain('workspace_read');
  expect(block).toContain('(scope "global")');
  expect(memoryPromptBlock([], [])).toBe('');
});

test('memory.json moves into the global workspace once: as files, the old file renamed, a fact already there not doubled', () => {
  const g = ws();
  const legacy = path.join(ws(), 'memory.json');
  fs.writeFileSync(legacy, JSON.stringify({ memories: [
    { id: 'm-1', text: 'Prefers rebase over merge.', scope: 'host', ts: 1 },
    { id: 'm-2', text: 'The keycaps panel stays off.', scope: 'keycaps', label: 'keycaps', ts: 2 },
    { id: 'm-3', text: 'Answers in Russian.', scope: 'host', ts: 3 },
  ] }));
  addFact(g, { text: 'answers in russian' });
  expect(migrateMemoryJson(legacy, g)).toEqual({ moved: 2, kept: 1 });
  expect(fs.existsSync(legacy)).toBe(false);
  expect(fs.existsSync(`${legacy}.migrated`)).toBe(true);
  const facts = readFacts(g);
  expect(facts.map((f) => f.text).sort()).toEqual(['Answers in Russian.', 'Prefers rebase over merge.', 'The keycaps panel stays off.'].map((t) => (t === 'Answers in Russian.' ? 'answers in russian' : t)).sort());
  // A fact an older host kept for a plugin still says whose it is.
  expect(facts.find((f) => f.text.startsWith('The keycaps'))!.plugin).toBe('keycaps');
  // Again: nothing to move.
  expect(migrateMemoryJson(legacy, g)).toEqual({ moved: 0, kept: 0 });
  // A file that does not parse is left where it is.
  fs.writeFileSync(legacy, '{ not json');
  expect(migrateMemoryJson(legacy, g)).toEqual({ moved: 0, kept: 0 });
  expect(fs.readFileSync(legacy, 'utf8')).toBe('{ not json');
});

test('the prompt shows at most MEMORY_PROMPT_LINES lines per scope, and says how many more there are and where', () => {
  const p = ws();
  for (let i = 0; i < MEMORY_PROMPT_LINES + 5; i++) addFact(p, { text: `fact ${String(i).padStart(3, '0')}` });
  const block = memoryPromptBlock(readFacts(p), []);
  expect(block.split('\n').filter((l) => l.startsWith('- ['))).toHaveLength(MEMORY_PROMPT_LINES);
  expect(block).toContain('+5 more — workspace_read memory/MEMORY.md (scope "project")');
});

test('the migration claims memory.json by an atomic rename: a live claim is left to its process, a dead one is taken over, and a backup is never overwritten', () => {
  const g = ws();
  const dir = ws();
  const legacy = path.join(dir, 'memory.json');
  const body = JSON.stringify({ memories: [{ id: 'm-1', text: 'Prefers rebase.', scope: 'host', ts: 1 }] });
  // Another process, alive, is migrating: this one backs off and writes nothing.
  fs.writeFileSync(`${legacy}.migrating-4242`, body);
  expect(migrateMemoryJson(legacy, g, { pid: 1, pidAlive: (p) => p === 4242 })).toEqual({ moved: 0, kept: 0 });
  expect(readFacts(g)).toEqual([]);
  expect(fs.existsSync(`${legacy}.migrating-4242`)).toBe(true);
  // That process died mid-way: the next start takes the claim over, and an earlier
  // backup stays as it was.
  fs.writeFileSync(`${legacy}.migrated`, 'the first backup');
  expect(migrateMemoryJson(legacy, g, { pid: 1, pidAlive: () => false })).toEqual({ moved: 1, kept: 0 });
  expect(fs.existsSync(`${legacy}.migrating-4242`)).toBe(false);
  expect(fs.readFileSync(`${legacy}.migrated`, 'utf8')).toBe('the first backup');
  expect(fs.readFileSync(`${legacy}.migrated-2`, 'utf8')).toBe(body);
  // Two starts at once: whoever renames first migrates; the other finds nothing.
  fs.writeFileSync(legacy, JSON.stringify({ memories: [{ id: 'm-2', text: 'Answers briefly.', scope: 'host', ts: 2 }] }));
  const first = migrateMemoryJson(legacy, g, { pid: 7, pidAlive: (p) => p === 7 });
  const second = migrateMemoryJson(legacy, g, { pid: 8, pidAlive: (p) => p === 7 || p === 8 });
  expect([first.moved, second.moved]).toEqual([1, 0]);
  expect(readFacts(g).map((f) => f.text).sort()).toEqual(['Answers briefly.', 'Prefers rebase.']);
});
