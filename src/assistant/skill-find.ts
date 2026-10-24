// Where skills are, read at the moment of the call (no cache). The places are those of the
// agent files, with a directory per skill, `<name>/SKILL.md`:
//
// - the project's: `<project>/.flow-assist/skills/<name>/`, `<project>` being the git top
//   level of the shell's directory (else the directory itself). Read only inside
//   `shell.roots`, by real path: a skill that is a link out of the roots is refused, and
//   with no roots set nothing is read at all.
// - the person's: `skills/<name>/` in the directory the host keeps its settings in.
// - a plugin's: the directories its `manifest.json` lists under `skills`, paths inside the
//   plugin's directory. Named `<plugin>/<name>`.
//
// A project skill and a person's of one name: the project's is offered, the person's is
// kept as shadowed. A skill with errors is never offered; its errors are returned. A
// SKILL.md over the cap is an error, never cut.
import fs from 'node:fs';
import path from 'node:path';
import { hostStateDir } from '../config/load.js';
import { readPluginManifest } from '../loader/compat.js';
import { isLinkOut, type FindAgentsInput } from './agent-find.js';
import { parseSkillFile, skillDirHashCached, SKILL_CAP, SKILL_FILE, type Skill, type SkillError, type SkillSource } from './skill-file.js';
import { gitRootOf } from './sessions.js';
import { realOf, shellRoots, within } from './shell.js';

export const PROJECT_SKILLS_DIR = path.join('.flow-assist', 'skills');

export interface FoundSkill extends Skill {
  id: string; // what `/skill` takes: the name, or `<plugin>/<name>` for a plugin's
  plugin: string | null; // the plugin's name, for a plugin's skill
  shadowed: boolean; // a person's skill hidden by a project skill of its name
}
export interface FailedSkill {
  id: string;
  path: string;
  source: SkillSource;
  errors: SkillError[];
}
export interface FoundSkills {
  skills: FoundSkill[]; // offered: project first, then the person's, then plugins'
  shadowed: FoundSkill[];
  failed: FailedSkill[];
  errors: SkillError[]; // every failed skill's errors, flat
  projectRead: boolean; // false — `shell.roots` is unset, so no project skill is read
  projectDir: string | null;
  personDir: string;
}
export type FindSkillsInput = Omit<FindAgentsInput, 'personDir'> & { personDir?: string };

export function findSkills({ config, cwd, plugins = [], personDir = path.join(hostStateDir(), 'skills') }: FindSkillsInput): FoundSkills {
  const out: FoundSkills = { skills: [], shadowed: [], failed: [], errors: [], projectRead: true, projectDir: null, personDir };
  const fail = (id: string, file: string, source: SkillSource, errors: SkillError[]) => {
    out.failed.push({ id, path: file, source, errors });
    out.errors.push(...errors);
  };
  const refuse = (id: string, file: string, source: SkillSource, message: string) => fail(id, file, source, [{ path: file, line: 1, message }]);
  const idTaken = (id: string) => out.skills.some((s) => s.id === id);

  // One skill directory. `allow` says why its real path may not be read (null — it may).
  // A directory with no SKILL.md is not a skill and is passed over.
  const load = (dir: string, source: SkillSource, idOf: (name: string) => string, allow: (real: string) => string | null): FoundSkill | null => {
    const file = path.join(dir, SKILL_FILE);
    const name = path.basename(dir);
    const id = idOf(name);
    const realDir = realOf(dir);
    try { if (!fs.statSync(realDir).isDirectory()) return null; } catch { return null; }
    if (!fs.existsSync(file)) return null;
    const why = allow(realDir);
    if (why) { refuse(id, file, source, why); return null; }
    const realFile = realOf(file);
    if (!within(realFile, realDir)) { refuse(id, file, source, `${SKILL_FILE} is a link out of the skill's directory — not read`); return null; }
    let bytes: Buffer;
    try {
      const st = fs.statSync(realFile);
      if (!st.isFile()) return null;
      if (st.size > SKILL_CAP) { refuse(id, file, source, `${SKILL_FILE} is larger than ${SKILL_CAP / 1024} KiB`); return null; }
      bytes = fs.readFileSync(realFile);
    } catch (e) {
      refuse(id, file, source, `${SKILL_FILE} cannot be read: ${(e as Error).message}`);
      return null;
    }
    const parsed = parseSkillFile(file, bytes, source, name, realDir);
    if (!parsed.ok) { fail(id, file, source, parsed.errors); return null; }
    const hashed = skillDirHashCached(realDir);
    if (!hashed.ok) { refuse(id, file, source, hashed.message); return null; }
    return {
      ...parsed.skill, hash: hashed.hash, files: hashed.files, bytes: hashed.bytes,
      id, plugin: source.kind === 'plugin' ? source.plugin : null, shadowed: false,
    };
  };
  const subdirs = (dir: string): string[] => {
    try { return fs.readdirSync(dir).sort().map((n) => path.join(dir, n)); } catch { return []; }
  };

  // The project's.
  const roots = shellRoots(config).map(realOf);
  const realCwd = realOf(path.resolve(cwd));
  const base = gitRootOf(realCwd) ?? realCwd;
  const projectDir = path.join(base, PROJECT_SKILLS_DIR);
  out.projectDir = projectDir;
  const project: SkillSource = { kind: 'project' };
  if (!roots.length) out.projectRead = false;
  else if (isLinkOut(projectDir, roots)) refuse('.flow-assist/skills', projectDir, project, 'the skills directory is a link out of shell.roots — not read');
  else if (roots.some((r) => within(realOf(projectDir), r))) {
    for (const dir of subdirs(projectDir)) {
      const s = load(dir, project, (n) => n, (real) => (roots.some((r) => within(real, r)) ? null : 'the skill is a link out of shell.roots — not read'));
      if (s) out.skills.push(s);
    }
  }

  // The person's.
  const person: SkillSource = { kind: 'person' };
  for (const dir of subdirs(personDir)) {
    const s = load(dir, person, (n) => n, () => null);
    if (!s) continue;
    if (idTaken(s.id)) { s.shadowed = true; out.shadowed.push(s); } else out.skills.push(s);
  }

  // The plugins'.
  for (const plugin of plugins) {
    const manifest = readPluginManifest(plugin.dir);
    const listed = manifest?.skills;
    if (listed === undefined) continue;
    const source: SkillSource = { kind: 'plugin', plugin: plugin.name };
    const manifestFile = path.join(plugin.dir, 'manifest.json');
    if (!Array.isArray(listed) || !listed.every((p) => typeof p === 'string' && p)) {
      refuse(`${plugin.name}/`, manifestFile, source, '"skills" is not a list of directories inside the plugin');
      continue;
    }
    const realPlugin = realOf(plugin.dir);
    for (const p of listed as string[]) {
      const dir = path.resolve(plugin.dir, path.basename(p) === SKILL_FILE ? path.dirname(p) : p);
      if (!fs.existsSync(path.join(dir, SKILL_FILE))) {
        refuse(`${plugin.name}/${path.basename(dir)}`, path.join(dir, SKILL_FILE), source, `"${p}" has no ${SKILL_FILE}`);
        continue;
      }
      const s = load(dir, source, (n) => `${plugin.name}/${n}`, (real) => (within(real, realPlugin) && real !== realPlugin ? null : `"${p}" is outside the plugin's directory`));
      if (!s) continue;
      if (idTaken(s.id)) refuse(s.id, path.join(dir, SKILL_FILE), source, `another directory of the plugin already has the skill name «${s.name}»`);
      else out.skills.push(s);
    }
  }
  return out;
}

export type ResolvedSkill =
  | { ok: true; skill: FoundSkill }
  | { ok: false; reason: 'unknown' | 'ambiguous' | 'broken'; message: string; candidates?: string[] };

// The skill `/skill <name>` means: the exact name (a project's, a person's, or a plugin's
// `<plugin>/<name>`), else a plugin skill's short name when exactly one carries it.
export function resolveSkill(raw: string, found: Pick<FoundSkills, 'skills' | 'failed'>): ResolvedSkill {
  const name = raw.trim();
  const exact = found.skills.find((s) => s.id === name);
  if (exact) return { ok: true, skill: exact };
  const broken = (id: string): ResolvedSkill => ({ ok: false, reason: 'broken', message: `skill ${id} has errors — /skill shows them` });
  if (found.failed.some((f) => f.id === name)) return broken(name);
  const shorts = found.skills.filter((s) => s.source.kind === 'plugin' && s.name === name);
  if (shorts.length === 1) return { ok: true, skill: shorts[0]! };
  if (shorts.length > 1) {
    const ids = shorts.map((s) => s.id);
    return { ok: false, reason: 'ambiguous', message: `${name} names more than one skill — use ${ids.join(' or ')}`, candidates: ids };
  }
  const brokenShort = found.failed.find((f) => f.source.kind === 'plugin' && f.id.endsWith(`/${name}`));
  if (brokenShort) return broken(brokenShort.id);
  return { ok: false, reason: 'unknown', message: `no skill named ${name} — /skill lists them` };
}
