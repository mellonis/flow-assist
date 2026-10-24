import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentTrustPath, skillChanged, skillKeyOf, skillTrusted, trustedSkillsNow } from '../agent-trust.ts';
import { skillsFinderOf } from '../conversation-turn.ts';
import { SKILL_CAP } from '../skill-file.ts';
import { findSkills, resolveSkill } from '../skill-find.ts';

const made: string[] = [];
const tmp = (p: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(agentTrustPath(), { force: true }); });

const doc = (description: string, body = 'do it') => `---\ndescription: ${description}\n---\n${body}\n`;
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };

function world() {
  const root = tmp('fa-skills-root-');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'src', 'deep'), { recursive: true });
  const personDir = path.join(tmp('fa-skills-person-'), 'skills');
  return { root, proj, personDir, config: { shell: { roots: [root] } } };
}
const projectSkill = (w: ReturnType<typeof world>, name: string, text: string) => write(path.join(w.proj, '.flow-assist', 'skills', name, 'SKILL.md'), text);

test('the project, the person and a plugin each offer their skills, with the fields the later tasks read', () => {
  const w = world();
  projectSkill(w, 'build', doc('builds'));
  write(path.join(w.proj, '.flow-assist', 'skills', 'build', 'refs', 'a.md'), 'ref');
  write(path.join(w.personDir, 'notes', 'SKILL.md'), '---\ndescription: takes notes\nlicense: MIT\n---\nbody');
  const plug = tmp('fa-skills-plug-');
  write(path.join(plug, 'manifest.json'), JSON.stringify({ name: 'tk', skills: ['skills/ticket'] }));
  write(path.join(plug, 'skills', 'ticket', 'SKILL.md'), doc('a ticket'));
  const found = findSkills({ config: w.config, cwd: path.join(w.proj, 'src', 'deep'), plugins: [{ name: 'tk', dir: plug }], personDir: w.personDir });
  expect(found.skills.map((s) => [s.id, s.source, s.plugin])).toEqual([
    ['build', { kind: 'project' }, null],
    ['notes', { kind: 'person' }, null],
    ['tk/ticket', { kind: 'plugin', plugin: 'tk' }, 'tk'],
  ]);
  const [build, notes, ticket] = found.skills;
  expect(build).toMatchObject({ name: 'build', description: 'builds', body: 'do it', files: 2, dir: path.join(w.proj, '.flow-assist', 'skills', 'build'), shadowed: false, notes: [] });
  expect(build!.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(notes!.notes).toEqual(['license']);
  expect(ticket).toMatchObject({ name: 'ticket', description: 'a ticket', dir: path.join(plug, 'skills', 'ticket') });
  expect(found.projectRead).toBe(true);
  expect(found.errors).toEqual([]);
});

test('a directory without SKILL.md is passed over, a plugin entry without one is an error', () => {
  const w = world();
  fs.mkdirSync(path.join(w.proj, '.flow-assist', 'skills', 'empty'), { recursive: true });
  const plug = tmp('fa-skills-plug-');
  write(path.join(plug, 'manifest.json'), JSON.stringify({ skills: ['skills/none'] }));
  fs.mkdirSync(path.join(plug, 'skills', 'none'), { recursive: true });
  const found = findSkills({ config: w.config, cwd: w.proj, plugins: [{ name: 'tk', dir: plug }], personDir: w.personDir });
  expect(found.skills).toEqual([]);
  expect(found.failed.map((f) => f.id)).toEqual(['tk/none']);
});

test('the project wins a name; the person\'s is kept as shadowed and flagged', () => {
  const w = world();
  projectSkill(w, 'same', doc('the project\'s'));
  write(path.join(w.personDir, 'same', 'SKILL.md'), doc('the person\'s'));
  const found = findSkills({ config: w.config, cwd: w.proj, personDir: w.personDir });
  expect(found.skills.map((s) => [s.id, s.description])).toEqual([['same', 'the project\'s']]);
  expect(found.shadowed.map((s) => [s.id, s.source.kind, s.shadowed])).toEqual([['same', 'person', true]]);
});

test('with shell.roots unset no project skill is read, and the result says so', () => {
  const w = world();
  projectSkill(w, 'build', doc('builds'));
  write(path.join(w.personDir, 'notes', 'SKILL.md'), doc('notes'));
  const found = findSkills({ config: {}, cwd: w.proj, personDir: w.personDir });
  expect(found.projectRead).toBe(false);
  expect(found.skills.map((s) => s.id)).toEqual(['notes']);
});

test('a project skill that is a link out of the roots, or whose SKILL.md is, is refused', () => {
  const w = world();
  const outside = tmp('fa-skills-outside-');
  write(path.join(outside, 'away', 'SKILL.md'), doc('away'));
  fs.mkdirSync(path.join(w.proj, '.flow-assist', 'skills'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'away'), path.join(w.proj, '.flow-assist', 'skills', 'away'));
  write(path.join(outside, 'file.md'), doc('file'));
  fs.mkdirSync(path.join(w.proj, '.flow-assist', 'skills', 'linked'));
  fs.symlinkSync(path.join(outside, 'file.md'), path.join(w.proj, '.flow-assist', 'skills', 'linked', 'SKILL.md'));
  const found = findSkills({ config: w.config, cwd: w.proj, personDir: w.personDir });
  expect(found.skills).toEqual([]);
  expect(found.failed.map((f) => [f.id, f.errors[0]!.message])).toEqual([
    ['away', 'the skill is a link out of shell.roots — not read'],
    ['linked', "SKILL.md is a link out of the skill's directory — not read"],
  ]);
});

test('a link out of the skill directory among its files makes the skill an error', () => {
  const w = world();
  projectSkill(w, 'leaky', doc('leaky'));
  const outside = tmp('fa-skills-outside-');
  write(path.join(outside, 'x'), 'x');
  fs.symlinkSync(path.join(outside, 'x'), path.join(w.proj, '.flow-assist', 'skills', 'leaky', 'x'));
  const found = findSkills({ config: w.config, cwd: w.proj, personDir: w.personDir });
  expect(found.skills).toEqual([]);
  expect(found.errors[0]!.message).toMatch(/x is a link out of the skill's directory/);
});

test('errors name path:line; a SKILL.md over the cap is an error and is never cut; others still load', () => {
  const w = world();
  projectSkill(w, 'broken', '---\nname: other\ndescription: d\n---\nb');
  projectSkill(w, 'huge', doc('huge', 'x'.repeat(SKILL_CAP)));
  projectSkill(w, 'fine', doc('fine'));
  const found = findSkills({ config: w.config, cwd: w.proj, personDir: w.personDir });
  expect(found.skills.map((s) => s.id)).toEqual(['fine']);
  const base = path.join(w.proj, '.flow-assist', 'skills');
  expect(found.errors).toEqual([
    { path: path.join(base, 'broken', 'SKILL.md'), line: 2, message: "name «other» differs from the directory's name «broken»" },
    { path: path.join(base, 'huge', 'SKILL.md'), line: 1, message: 'SKILL.md is larger than 32 KiB' },
  ]);
});

test('a plugin\'s skills: a bad list, a path outside the plugin, a duplicate name', () => {
  const w = world();
  const plug = tmp('fa-skills-plug-');
  write(path.join(plug, 'manifest.json'), JSON.stringify({ skills: ['skills/a', '../elsewhere', 'other/a', 'skills/b/SKILL.md'] }));
  write(path.join(plug, 'skills', 'a', 'SKILL.md'), doc('a'));
  write(path.join(plug, 'skills', 'b', 'SKILL.md'), doc('b'));
  write(path.join(plug, 'other', 'a', 'SKILL.md'), doc('a again'));
  write(path.join(plug, '..', `${path.basename(plug)}-elsewhere`, 'SKILL.md'), doc('x'));
  const bad = tmp('fa-skills-plug-');
  write(path.join(bad, 'manifest.json'), JSON.stringify({ skills: 'nope' }));
  const found = findSkills({ config: w.config, cwd: w.proj, plugins: [{ name: 'tk', dir: plug }, { name: 'bad', dir: bad }], personDir: w.personDir });
  expect(found.skills.map((s) => s.id)).toEqual(['tk/a', 'tk/b']);
  expect(found.failed.map((f) => f.id).sort()).toEqual(['bad/', 'tk/a', 'tk/elsewhere']);
  expect(found.errors.map((e) => e.message).sort()).toEqual([
    '"../elsewhere" has no SKILL.md',
    '"skills" is not a list of directories inside the plugin',
    'another directory of the plugin already has the skill name «a»',
  ].sort());
});

test('a plugin skill that is a link out of the plugin is refused', () => {
  const w = world();
  const plug = tmp('fa-skills-plug-');
  const outside = tmp('fa-skills-outside-');
  write(path.join(outside, 'SKILL.md'), doc('out'));
  fs.symlinkSync(outside, path.join(plug, 'away'));
  write(path.join(plug, 'manifest.json'), JSON.stringify({ skills: ['away'] }));
  const found = findSkills({ config: w.config, cwd: w.proj, plugins: [{ name: 'tk', dir: plug }], personDir: w.personDir });
  expect(found.skills).toEqual([]);
  expect(found.errors[0]!.message).toBe('"away" is outside the plugin\'s directory');
});

test('a skill is read at each call: an edit beside the body changes the hash', () => {
  const w = world();
  projectSkill(w, 'build', doc('builds'));
  const read = () => findSkills({ config: w.config, cwd: w.proj, personDir: w.personDir }).skills[0]!.hash;
  const first = read();
  expect(read()).toBe(first);
  write(path.join(w.proj, '.flow-assist', 'skills', 'build', 'scripts', 'run.sh'), 'echo');
  expect(read()).not.toBe(first);
});

test('resolveSkill: exact, a unique plugin short name, ambiguity, broken, unknown', () => {
  const w = world();
  projectSkill(w, 'build', doc('builds'));
  projectSkill(w, 'bad', '---\n---\n');
  const mk = (name: string) => {
    const plug = tmp('fa-skills-plug-');
    write(path.join(plug, 'manifest.json'), JSON.stringify({ skills: ['s/ticket', 's/solo', 's/broken'] }));
    write(path.join(plug, 's', 'ticket', 'SKILL.md'), doc('t'));
    if (name === 'one') write(path.join(plug, 's', 'solo', 'SKILL.md'), doc('solo'));
    if (name === 'one') write(path.join(plug, 's', 'broken', 'SKILL.md'), 'nope');
    return { name, dir: plug };
  };
  const found = findSkills({ config: w.config, cwd: w.proj, plugins: [mk('one'), mk('two')], personDir: w.personDir });
  const id = (r: ReturnType<typeof resolveSkill>) => (r.ok ? r.skill.id : `${r.reason}: ${r.message}`);
  expect(id(resolveSkill('build', found))).toBe('build');
  expect(id(resolveSkill('one/ticket', found))).toBe('one/ticket');
  expect(id(resolveSkill('solo', found))).toBe('one/solo');
  expect(id(resolveSkill('ticket', found))).toBe('ambiguous: ticket names more than one skill — use one/ticket or two/ticket');
  expect(id(resolveSkill('bad', found))).toMatch(/^broken/);
  expect(id(resolveSkill('broken', found))).toMatch(/^broken/);
  expect(id(resolveSkill('missing', found))).toBe('unknown: no skill named missing — /skill lists them');
});

test('trust: a project or person skill is trusted only at its recorded directory hash; a plugin\'s always', () => {
  const w = world();
  projectSkill(w, 'build', doc('builds'));
  const read = () => findSkills({ config: w.config, cwd: w.proj, personDir: w.personDir }).skills[0]!;
  const s = read();
  expect(skillTrusted(s)).toBe(false);
  expect(skillChanged(s)).toBe(false);
  fs.mkdirSync(path.dirname(agentTrustPath()), { recursive: true });
  fs.writeFileSync(agentTrustPath(), JSON.stringify({ files: { [skillKeyOf(s)]: s.hash } }));
  expect(skillKeyOf(s)).toBe(`skill:${s.dir}`);
  expect(skillTrusted(s)).toBe(true);
  expect(trustedSkillsNow()(s)).toBe(true);
  write(path.join(s.dir, 'refs', 'new.md'), 'added later');
  const edited = read();
  expect(skillTrusted(edited)).toBe(false);
  expect(skillChanged(edited)).toBe(true);
  expect(skillTrusted({ dir: '/x', hash: 'h', source: { kind: 'plugin' } })).toBe(true);
  // an agent record of the same path does not trust the skill
  fs.writeFileSync(agentTrustPath(), JSON.stringify({ files: { [`project:${s.dir}`]: edited.hash } }));
  expect(skillTrusted(edited)).toBe(false);
  fs.writeFileSync(agentTrustPath(), 'not json');
  expect(skillTrusted(s)).toBe(false);
});

test('skillsFinderOf reads the conversation\'s config, directory and plugin service at each call', () => {
  const w = world();
  projectSkill(w, 'build', doc('builds'));
  const plug = tmp('fa-skills-plug-');
  write(path.join(plug, 'manifest.json'), JSON.stringify({ skills: ['s/t'] }));
  write(path.join(plug, 's', 't', 'SKILL.md'), doc('t'));
  let cwd = w.proj;
  const c = { deps: { config: () => w.config, services: () => ({ agentPlugins: () => [{ name: 'tk', dir: plug }] }) }, shell: { cwd: () => cwd } };
  const find = skillsFinderOf(c as never);
  expect(find().skills.map((s) => s.id)).toEqual(['build', 'tk/t']);
  cwd = w.root; // not a project: the git top level is the directory itself
  expect(find().skills.map((s) => s.id)).toEqual(['tk/t']);
});

test('a plugin entry that only ends in SKILL.md is not taken for the file form', () => {
  const w = world();
  const plug = tmp('fa-skills-plug-');
  write(path.join(plug, 'manifest.json'), JSON.stringify({ skills: ['skills/MYSKILL.md'] }));
  write(path.join(plug, 'skills', 'MYSKILL.md', 'SKILL.md'), doc('inner'));
  const found = findSkills({ config: w.config, cwd: w.proj, plugins: [{ name: 'tk', dir: plug }], personDir: w.personDir });
  expect(found.skills).toEqual([]);
  expect(found.errors[0]!.message).toMatch(/not a skill name/); // read as the directory it is, not as skills/
});

test('a skill directory over the bound is an error record', () => {
  const w = world();
  projectSkill(w, 'big', doc('big'));
  for (let k = 0; k < 256; k++) write(path.join(w.proj, '.flow-assist', 'skills', 'big', `f${k}`), 'x');
  const found = findSkills({ config: w.config, cwd: w.proj, personDir: w.personDir });
  expect(found.skills).toEqual([]);
  expect(found.errors[0]!.message).toBe('the directory holds more than 256 files');
});

test('skillsFinderOf offers the plugins its service lists and no others', () => {
  const w = world();
  const mk = (n: string) => { const d = tmp('fa-skills-plug-'); write(path.join(d, 'manifest.json'), JSON.stringify({ skills: ['s/t'] })); write(path.join(d, 's', 't', 'SKILL.md'), doc(n)); return d; };
  const listed = mk('listed');
  mk('disabled');
  const c = (services: object) => ({ deps: { config: () => w.config, services: () => services }, shell: { cwd: () => w.proj } });
  expect(skillsFinderOf(c({ agentPlugins: () => [{ name: 'ok', dir: listed }] }) as never)().skills.map((s) => s.id)).toEqual(['ok/t']);
  expect(skillsFinderOf(c({}) as never)().skills).toEqual([]);
});
