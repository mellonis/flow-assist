import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostStateDir } from '../../config/load.ts';
import { findAgents, resolveAgent } from '../agent-find.ts';

const made: string[] = [];
const tmp = (p: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const doc = (description: string, body = 'do it') => `---\ndescription: ${description}\n---\n${body}\n`;
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };

// A project inside a root: `<root>/proj` is a git repository (a `.git` directory).
function world() {
  const root = tmp('fa-agents-root-');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'src', 'deep'), { recursive: true });
  const personDir = path.join(tmp('fa-agents-person-'), 'agents');
  return { root, proj, personDir, config: { shell: { roots: [root] } } };
}
const projectFile = (w: ReturnType<typeof world>, name: string, text: string) => write(path.join(w.proj, '.flow-assist', 'agents', `${name}.md`), text);

test('the project, the person and a plugin each offer their agents; the project is found from a subdirectory', () => {
  const w = world();
  projectFile(w, 'build', doc('builds'));
  write(path.join(w.personDir, 'notes.md'), doc('takes notes'));
  const plug = tmp('fa-agents-plug-');
  write(path.join(plug, 'manifest.json'), JSON.stringify({ name: 'tk', agents: ['agents/ticket.md'] }));
  write(path.join(plug, 'agents', 'ticket.md'), doc('a ticket'));
  const found = findAgents({ config: w.config, cwd: path.join(w.proj, 'src', 'deep'), plugins: [{ name: 'tk', dir: plug }], personDir: w.personDir });
  expect(found.agents.map((a) => [a.id, a.source])).toEqual([
    ['build', { kind: 'project' }],
    ['notes', { kind: 'person' }],
    ['tk/ticket', { kind: 'plugin', plugin: 'tk' }],
  ]);
  expect(found.agents[2]).toMatchObject({ name: 'ticket', description: 'a ticket' });
  expect(found.projectRead).toBe(true);
  expect(found.errors).toEqual([]);
});

test('with no git top level the shell directory itself is the project', () => {
  const root = tmp('fa-agents-nogit-');
  write(path.join(root, '.flow-assist', 'agents', 'here.md'), doc('here'));
  const found = findAgents({ config: { shell: { roots: [root] } }, cwd: root, personDir: path.join(root, 'none') });
  expect(found.agents.map((a) => a.id)).toEqual(['here']);
});

test('the project wins a name; the person\'s is kept as shadowed', () => {
  const w = world();
  projectFile(w, 'same', doc('the project\'s'));
  write(path.join(w.personDir, 'same.md'), doc('the person\'s'));
  write(path.join(w.personDir, 'other.md'), doc('only the person\'s'));
  const found = findAgents({ config: w.config, cwd: w.proj, personDir: w.personDir });
  expect(found.agents.map((a) => [a.id, a.description])).toEqual([['same', 'the project\'s'], ['other', 'only the person\'s']]);
  expect(found.shadowed.map((a) => [a.id, a.source.kind])).toEqual([['same', 'person']]);
});

test('with shell.roots unset no project agent is read, and the result says so', () => {
  const w = world();
  projectFile(w, 'build', doc('builds'));
  write(path.join(w.personDir, 'notes.md'), doc('notes'));
  const found = findAgents({ config: {}, cwd: w.proj, personDir: w.personDir });
  expect(found.projectRead).toBe(false);
  expect(found.agents.map((a) => a.id)).toEqual(['notes']);
});

test('a project place outside the roots is not read', () => {
  const w = world();
  projectFile(w, 'build', doc('builds'));
  const other = tmp('fa-agents-other-');
  const found = findAgents({ config: { shell: { roots: [other] } }, cwd: w.proj, personDir: w.personDir });
  expect(found.agents).toEqual([]);
});

test('a link out of the roots is refused, as the project instructions refuse it', () => {
  const w = world();
  const outside = write(path.join(tmp('fa-agents-out-'), 'evil.md'), doc('planted'));
  fs.mkdirSync(path.join(w.proj, '.flow-assist', 'agents'), { recursive: true });
  fs.symlinkSync(outside, path.join(w.proj, '.flow-assist', 'agents', 'evil.md'));
  projectFile(w, 'fine', doc('fine'));
  const found = findAgents({ config: w.config, cwd: w.proj, personDir: w.personDir });
  expect(found.agents.map((a) => a.id)).toEqual(['fine']);
  expect(found.errors).toEqual([{ path: path.join(w.proj, '.flow-assist', 'agents', 'evil.md'), line: 1, message: expect.stringContaining('link out of shell.roots') }]);
  expect(resolveAgent('evil', found)).toMatchObject({ ok: false, reason: 'broken' });
});

test('a whole agents directory that is a link out of the roots is not read', () => {
  const w = world();
  const outside = tmp('fa-agents-outdir-');
  write(path.join(outside, 'evil.md'), doc('planted'));
  fs.mkdirSync(path.join(w.proj, '.flow-assist'), { recursive: true });
  fs.symlinkSync(outside, path.join(w.proj, '.flow-assist', 'agents'));
  expect(findAgents({ config: w.config, cwd: w.proj, personDir: w.personDir }).agents).toEqual([]);
});

test('a file over the instructions\' cap is an error, not a cut prompt', () => {
  const w = world();
  projectFile(w, 'huge', doc('big', 'x'.repeat(33 * 1024)));
  const found = findAgents({ config: w.config, cwd: w.proj, personDir: w.personDir });
  expect(found.agents).toEqual([]);
  expect(found.errors[0]).toMatchObject({ line: 1, message: expect.stringContaining('larger than 32 KiB') });
});

test('a file with errors is not offered; its errors name path and line', () => {
  const w = world();
  const bad = projectFile(w, 'bad', '---\ndescription: d\nbogus: 1\n---\nbody');
  projectFile(w, 'good', doc('good'));
  write(path.join(w.proj, '.flow-assist', 'agents', 'notes.txt'), 'not an agent');
  const found = findAgents({ config: w.config, cwd: w.proj, personDir: w.personDir });
  expect(found.agents.map((a) => a.id)).toEqual(['good']);
  expect(found.errors).toEqual([{ path: bad, line: 3, message: expect.stringContaining('unknown key "bogus"') }]);
  expect(found.failed.map((f) => f.id)).toEqual(['bad']);
});

test('the person\'s place is the host\'s settings directory unless one is given', () => {
  const file = write(path.join(hostStateDir(), 'agents', 'fa-default-place.md'), doc('from the default place'));
  try {
    const found = findAgents({ config: {}, cwd: os.tmpdir() });
    expect(found.personDir).toBe(path.join(hostStateDir(), 'agents'));
    expect(found.agents.find((a) => a.id === 'fa-default-place')?.path).toBe(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('a plugin listing a path outside its directory is an error, even through a link', () => {
  const plug = tmp('fa-agents-plug-');
  const outside = write(path.join(tmp('fa-agents-out-'), 'x.md'), doc('outside'));
  fs.symlinkSync(outside, path.join(plug, 'linked.md'));
  write(path.join(plug, 'manifest.json'), JSON.stringify({ agents: ['../escape.md', 'linked.md', 'inside.md'] }));
  write(path.join(plug, 'inside.md'), doc('inside'));
  write(path.join(path.dirname(plug), 'escape.md'), doc('escape'));
  const found = findAgents({ config: {}, cwd: os.tmpdir(), plugins: [{ name: 'tk', dir: plug }], personDir: path.join(plug, 'none') });
  expect(found.agents.map((a) => a.id)).toEqual(['tk/inside']);
  expect(found.errors.map((e) => e.message)).toEqual([
    expect.stringContaining('"../escape.md" is outside the plugin\'s directory'),
    expect.stringContaining('"linked.md" is outside the plugin\'s directory'),
  ]);
  fs.rmSync(path.join(path.dirname(plug), 'escape.md'), { force: true });
});

test('a plugin\'s agents list that is not a list of paths is an error', () => {
  const plug = tmp('fa-agents-plug-');
  write(path.join(plug, 'manifest.json'), JSON.stringify({ agents: 'a.md' }));
  const found = findAgents({ config: {}, cwd: os.tmpdir(), plugins: [{ name: 'tk', dir: plug }], personDir: path.join(plug, 'none') });
  expect(found.errors).toEqual([{ path: path.join(plug, 'manifest.json'), line: 1, message: expect.stringContaining('not a list of paths') }]);
});

test('only the plugins handed over offer agents (a disabled one is not handed over)', () => {
  const plug = tmp('fa-agents-plug-');
  write(path.join(plug, 'manifest.json'), JSON.stringify({ agents: ['a.md'] }));
  write(path.join(plug, 'a.md'), doc('a'));
  const none = findAgents({ config: {}, cwd: os.tmpdir(), plugins: [], personDir: path.join(plug, 'none') });
  expect(none.agents).toEqual([]);
});

test('the files are read at each call: an edit between two calls is seen by the second', () => {
  const w = world();
  const file = projectFile(w, 'live', doc('first'));
  const call = () => findAgents({ config: w.config, cwd: w.proj, personDir: w.personDir });
  const one = call();
  fs.writeFileSync(file, doc('second'));
  const two = call();
  expect(one.agents[0]!.description).toBe('first');
  expect(two.agents[0]!.description).toBe('second');
  expect(two.agents[0]!.hash).not.toBe(one.agents[0]!.hash);
  fs.unlinkSync(file);
  expect(call().agents).toEqual([]);
});

test('resolveAgent: exact, plugin-qualified, a unique short name, an ambiguous one, unknown, a file with errors', () => {
  const w = world();
  projectFile(w, 'build', doc('builds'));
  projectFile(w, 'broken', '---\nnope\n---\nx');
  const mk = (name: string, files: Record<string, string>) => {
    const dir = tmp('fa-agents-plug-');
    write(path.join(dir, 'manifest.json'), JSON.stringify({ agents: Object.keys(files) }));
    for (const [f, text] of Object.entries(files)) write(path.join(dir, f), text);
    return { name, dir };
  };
  const a = mk('alpha', { 'ticket.md': doc('alpha ticket'), 'only-a.md': doc('only a'), 'bad-a.md': '---\nnope\n---\nx' });
  const b = mk('beta', { 'ticket.md': doc('beta ticket') });
  const found = findAgents({ config: w.config, cwd: w.proj, plugins: [a, b], personDir: w.personDir });
  const id = (r: ReturnType<typeof resolveAgent>) => (r.ok ? r.agent.id : `${r.reason}`);
  expect(id(resolveAgent('build', found))).toBe('build');
  expect(id(resolveAgent('@build', found))).toBe('build');
  expect(id(resolveAgent('alpha/ticket', found))).toBe('alpha/ticket');
  expect(id(resolveAgent('only-a', found))).toBe('alpha/only-a');
  const amb = resolveAgent('ticket', found);
  expect(amb).toMatchObject({ ok: false, reason: 'ambiguous', candidates: ['alpha/ticket', 'beta/ticket'] });
  expect(id(resolveAgent('nope', found))).toBe('unknown');
  expect(id(resolveAgent('broken', found))).toBe('broken');
  expect(id(resolveAgent('bad-a', found))).toBe('broken');
});
