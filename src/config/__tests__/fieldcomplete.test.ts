// The chat field's completion: a `/command` and its argument, and a path in shell
// mode. Pure — the directory listing is injected, so nothing here reads the machine
// but the one test that lists a temp directory of its own.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realOf } from '../../assistant/shell';
import { lineTab, lineView, type TabWalk } from '../commandline';
import { completePath, completeSlash, listDirectory, type PathDeps } from '../fieldcomplete';

type Entry = { name: string; dir: boolean };
const tree: Record<string, Entry[]> = {
  '/w': [
    { name: 'snake-project', dir: true }, { name: 'sandbox', dir: true }, { name: 'README.md', dir: false },
    { name: '.git', dir: true }, { name: 'a b.txt', dir: false }, { name: 'out', dir: true, link: true },
  ],
  '/w/snake-project': [{ name: 'src', dir: true }],
  '/home/me': [{ name: 'proj', dir: true }],
};
// `out` is a link that leads out of the root.
const deps: PathDeps = { cwd: '/w', roots: ['/w'], home: '/home/me', list: (d) => tree[d] ?? null, real: (p) => (p === '/w/out' ? '/elsewhere/out' : p) };

test('a path completes the last word, relative to the shell directory; a directory gets a trailing slash', () => {
  const c = completePath('cd sn', deps);
  expect(c).toMatchObject({ head: 'sn', best: 'snake-project/', candidates: ['snake-project/'] });
  // Through the line: Tab takes it.
  expect(lineTab('cd sn', null, (t) => completePath(t, deps)).input).toBe('cd snake-project/');
  expect(lineView('cd sn', null, (t) => completePath(t, deps)).ghost).toBe('ake-project/');
  // A file has no slash.
  expect(completePath('cat RE', deps).best).toBe('README.md');
});

test('several candidates: sorted, the first offered, the rest listed; a typed prefix narrows them', () => {
  expect(completePath('ls s', deps).candidates).toEqual(['sandbox/', 'snake-project/']);
  expect(completePath('ls sa', deps).candidates).toEqual(['sandbox/']);
  // A line ending in a space completes an EMPTY word: every visible entry.
  expect(completePath('cat ', deps).candidates).toEqual(['README.md', 'a\\ b.txt', 'sandbox/', 'snake-project/']);
});

test('hidden entries are offered only when the word starts with a dot', () => {
  expect(completePath('ls ', deps).candidates).not.toContain('.git/');
  expect(completePath('ls .', deps).candidates).toEqual(['.git/']);
});

test('a word with directories is completed at its last segment; ~ is the home directory', () => {
  expect(completePath('cat snake-project/s', deps).best).toBe('snake-project/src/');
  expect(completePath('ls ~/pr', { ...deps, roots: [] }).best).toBe('~/proj/');
});

test('nothing outside the roots is offered — a parent, or a link that leads out', () => {
  // `out` is inside `/w` by name and outside it by real path.
  expect(completePath('ls o', deps).candidates).toEqual([]);
  expect(completePath('ls ', deps).candidates).not.toContain('out/');
  // The parent directory is outside the root: no entries of it.
  expect(completePath('ls ../', { ...deps, list: () => [{ name: 'x', dir: true }] }).candidates).toEqual([]);
  // With no roots configured, anywhere goes.
  expect(completePath('ls o', { ...deps, roots: [] }).candidates).toEqual(['out/']);
});

test('a name with a space is escaped, and the escaped word is read as one word', () => {
  expect(completePath('cat a', deps).best).toBe('a\\ b.txt');
  expect(completePath('cat a\\ b', deps)).toMatchObject({ head: 'a\\ b', best: 'a\\ b.txt' });
});

test('a directory that cannot be listed offers nothing', () => {
  expect(completePath('ls nowhere/', deps).candidates).toEqual([]);
});

test('a second Tab after a unique directory walks into it', () => {
  const complete = (t: string) => completePath(t, deps);
  let input = 'cd sn';
  let walk: TabWalk | null = null;
  ({ input, walk } = lineTab(input, walk, complete));
  expect(input).toBe('cd snake-project/');
  ({ input, walk } = lineTab(input, walk, complete));
  expect(input).toBe('cd snake-project/src/');
});

test('listDirectory + realOf on a real directory: a symlink out of the root is not offered', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-complete-')));
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-complete-out-')));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'file.txt'), '');
  fs.symlinkSync(elsewhere, path.join(root, 'out'));
  fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'inner'));
  const real: PathDeps = { cwd: root, roots: [root], list: listDirectory, real: realOf };
  // The link INTO the root is a directory (its target is), the link out is gone.
  expect(completePath('ls ', real).candidates).toEqual(['file.txt', 'inner/', 'sub/']);
  expect(listDirectory(root)).toEqual(expect.arrayContaining([{ name: 'out', dir: true, link: true }, { name: 'sub', dir: true, link: false }]));
  expect(listDirectory(path.join(root, 'file.txt'))).toBeNull();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(elsewhere, { recursive: true, force: true });
});

const defs = [
  { name: 'compact' }, { name: 'context' }, { name: 'copy' }, { name: 'resume', values: () => [{ value: '1', label: 'hello there' }, { value: '2', label: 'fix the tests' }] },
  { name: 'notes', values: ['step', 'open'] }, { name: 'mode', values: ['panel', 'window', 'full'] },
];

test('a slash command completes by name, in the declared order; a bare slash lists them all', () => {
  expect(completeSlash('/co', defs)).toMatchObject({ head: 'co', best: 'compact', candidates: ['compact', 'context', 'copy'] });
  expect(completeSlash('/', defs).candidates).toEqual(defs.map((d) => d.name));
  // Not a command: nothing.
  expect(completeSlash('hello', defs).candidates).toEqual([]);
  expect(completeSlash('/zzz', defs).candidates).toEqual([]);
});

test('after the command its argument completes from the declared values; a prefix narrows them', () => {
  expect(completeSlash('/notes ', defs)).toMatchObject({ head: '', best: 'step', candidates: ['step', 'open'] });
  expect(completeSlash('/notes o', defs)).toMatchObject({ head: 'o', best: 'open', candidates: ['open'] });
  // The whole word typed: nothing is left to offer.
  expect(completeSlash('/notes step', defs)).toMatchObject({ head: 'step', best: 'step', candidates: ['step'] });
  // The values are the FIRST argument's; a second word gets nothing.
  expect(completeSlash('/notes step x', defs).candidates).toEqual([]);
  // A command with no values, or an unknown one, offers nothing for its argument.
  expect(completeSlash('/copy ', defs).candidates).toEqual([]);
  expect(completeSlash('/zzz ', defs).candidates).toEqual([]);
  // Through the line: `/notes ` + Tab → `/notes step`, and again → `/notes open`.
  const complete = (t: string) => completeSlash(t, defs);
  const first = lineTab('/notes ', null, complete);
  expect(first.input).toBe('/notes step');
  expect(lineTab(first.input, first.walk, complete).input).toBe('/notes open');
});

test('values from a function carry labels: the offered one is said beside the field, the others beside their word', () => {
  const complete = (t: string) => completeSlash(t, defs);
  const c = completeSlash('/resume ', defs);
  expect(c.candidates).toEqual(['1', '2']);
  expect(c.labels).toEqual({ '1': 'hello there', '2': 'fix the tests' });
  const v = lineView('/resume ', null, complete);
  expect(v).toEqual({ ghost: '1', label: 'hello there', others: ['2 fix the tests'] });
  // Walking: the field holds `/resume 2`, and its label is said.
  const first = lineTab('/resume ', null, complete);
  const second = lineTab(first.input, first.walk, complete);
  expect(second.input).toBe('/resume 2');
  expect(lineView(second.input, second.walk, complete)).toEqual({ ghost: '', label: 'fix the tests', others: ['1 hello there'] });
  // A function that throws offers nothing.
  expect(completeSlash('/x ', [{ name: 'x', values: () => { throw new Error('no'); } }]).candidates).toEqual([]);
});
