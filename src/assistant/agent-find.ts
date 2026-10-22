// Where agent files are, read at the moment of the call (no cache: the file is read at
// each start — AGENTS.md (agent files)). Three places:
//
// - the project's: `<project>/.flow-assist/agents/*.md`, `<project>` being the git top
//   level of the shell's directory (else the directory itself). Read only inside
//   `shell.roots`, by real path, as the project instructions are: a file that is a link
//   out of the roots is refused, a file over the instructions' cap is an error, and
//   with no roots set nothing is read at all.
// - the person's: `agents/*.md` in the directory the host keeps its settings in.
// - a plugin's: the files its `manifest.json` lists under `agents`, paths inside the
//   plugin's directory. Named `<plugin>/<name>`.
//
// A project agent and a person's of one name: the project's is offered, the person's
// is kept as shadowed. A file with errors is never offered; its errors are returned.
import fs from 'node:fs';
import path from 'node:path';
import { hostStateDir } from '../config/load.js';
import { readPluginManifest } from '../loader/compat.js';
import { INSTRUCTIONS_CAP } from './project-instructions.js';
import { gitRootOf } from './sessions.js';
import { realOf, shellRoots, within } from './shell.js';
import { agentNameOf, parseAgentFile, type Agent, type AgentError, type AgentSource } from './agent-file.js';

export const PROJECT_AGENTS_DIR = path.join('.flow-assist', 'agents');

export interface FoundAgent extends Agent {
  id: string; // what `@` takes: the name, or `<plugin>/<name>` for a plugin's
}
export interface FailedAgent {
  id: string;
  path: string;
  source: AgentSource;
  errors: AgentError[];
}
export interface FoundAgents {
  agents: FoundAgent[]; // offered, project first, then the person's, then plugins'
  shadowed: FoundAgent[]; // a person's agent hidden by a project agent of its name
  failed: FailedAgent[];
  errors: AgentError[]; // every failed file's errors, flat
  projectRead: boolean; // false — `shell.roots` is unset, so no project agent is read
  projectDir: string | null; // where the project's agents are looked for
  personDir: string;
}
// A plugin that may offer agents: loaded, enabled, trusted and compatible.
export interface PluginAgentSource { name: string; dir: string }
export interface FindAgentsInput {
  config: Parameters<typeof shellRoots>[0];
  cwd: string; // the shell's directory
  plugins?: readonly PluginAgentSource[];
  personDir?: string;
}

export function findAgents({ config, cwd, plugins = [], personDir = path.join(hostStateDir(), 'agents') }: FindAgentsInput): FoundAgents {
  const out: FoundAgents = { agents: [], shadowed: [], failed: [], errors: [], projectRead: true, projectDir: null, personDir };
  const fail = (id: string, file: string, source: AgentSource, errors: AgentError[]) => {
    out.failed.push({ id, path: file, source, errors });
    out.errors.push(...errors);
  };
  const refuse = (id: string, file: string, source: AgentSource, message: string) => fail(id, file, source, [{ path: file, line: 1, message }]);
  const idTaken = (id: string) => out.agents.some((a) => a.id === id);

  // One file: read through the checks and parsed; `allow` says why a real path may not
  // be read (null — it may).
  const load = (file: string, source: AgentSource, idOf: (name: string) => string, allow: (real: string) => string | null): FoundAgent | null => {
    const name = agentNameOf(file) ?? path.basename(file);
    const id = idOf(name);
    const real = realOf(file);
    const why = allow(real);
    if (why) { refuse(id, file, source, why); return null; }
    let bytes: Buffer;
    try {
      const st = fs.statSync(real);
      if (!st.isFile()) return null; // a directory, a FIFO — never read
      if (st.size > INSTRUCTIONS_CAP) { refuse(id, file, source, `the file is larger than ${INSTRUCTIONS_CAP / 1024} KiB`); return null; }
      bytes = fs.readFileSync(real);
    } catch (e) {
      refuse(id, file, source, `the file cannot be read: ${(e as Error).message}`);
      return null;
    }
    const parsed = parseAgentFile(file, bytes, source);
    if (!parsed.ok) { fail(id, file, source, parsed.errors); return null; }
    return { ...parsed.agent, id };
  };
  const mdFiles = (dir: string): string[] => {
    try { return fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort().map((n) => path.join(dir, n)); } catch { return []; }
  };

  // The project's.
  const roots = shellRoots(config).map(realOf);
  const realCwd = realOf(path.resolve(cwd));
  const base = gitRootOf(realCwd) ?? realCwd;
  const projectDir = path.join(base, PROJECT_AGENTS_DIR);
  out.projectDir = projectDir;
  const project: AgentSource = { kind: 'project' };
  if (!roots.length) out.projectRead = false;
  else if (roots.some((r) => within(realOf(projectDir), r))) {
    for (const file of mdFiles(projectDir)) {
      const a = load(file, project, (n) => n, (real) => (roots.some((r) => within(real, r)) ? null : 'the file is a link out of shell.roots — not read'));
      if (a) out.agents.push(a);
    }
  }

  // The person's.
  const person: AgentSource = { kind: 'person' };
  for (const file of mdFiles(personDir)) {
    const a = load(file, person, (n) => n, () => null);
    if (!a) continue;
    if (idTaken(a.id)) out.shadowed.push(a); else out.agents.push(a);
  }

  // The plugins'.
  for (const plugin of plugins) {
    const manifest = readPluginManifest(plugin.dir);
    const listed = manifest?.agents;
    if (listed === undefined) continue;
    const source: AgentSource = { kind: 'plugin', plugin: plugin.name };
    const manifestFile = path.join(plugin.dir, 'manifest.json');
    if (!Array.isArray(listed) || !listed.every((p) => typeof p === 'string' && p)) {
      refuse(`${plugin.name}/`, manifestFile, source, '"agents" is not a list of paths inside the plugin');
      continue;
    }
    const realDir = realOf(plugin.dir);
    for (const p of listed as string[]) {
      const file = path.resolve(plugin.dir, p);
      const a = load(file, source, (n) => `${plugin.name}/${n}`, (real) => (within(real, realDir) && real !== realDir ? null : `"${p}" is outside the plugin's directory`));
      if (!a) continue;
      if (idTaken(a.id)) refuse(a.id, file, source, `another file of the plugin already has the agent name «${a.name}»`);
      else out.agents.push(a);
    }
  }
  return out;
}

export type Resolved =
  | { ok: true; agent: FoundAgent }
  | { ok: false; reason: 'unknown' | 'ambiguous' | 'broken'; message: string; candidates?: string[] };

// The agent `@<name>` means: the exact name (a project's, a person's, or a plugin's
// `<plugin>/<name>`), else a plugin agent's short name when exactly one carries it.
export function resolveAgent(raw: string, found: Pick<FoundAgents, 'agents' | 'failed'>): Resolved {
  const name = raw.replace(/^@/, '');
  const exact = found.agents.find((a) => a.id === name);
  if (exact) return { ok: true, agent: exact };
  const broken = (id: string): Resolved => ({ ok: false, reason: 'broken', message: `@${id} has errors in its file — /subagent @ shows them` });
  if (found.failed.some((f) => f.id === name)) return broken(name);
  const shorts = found.agents.filter((a) => a.source.kind === 'plugin' && a.name === name);
  if (shorts.length === 1) return { ok: true, agent: shorts[0]! };
  if (shorts.length > 1) {
    const ids = shorts.map((a) => a.id);
    return { ok: false, reason: 'ambiguous', message: `@${name} names more than one agent — use ${ids.map((i) => `@${i}`).join(' or ')}`, candidates: ids };
  }
  const brokenShort = found.failed.find((f) => f.source.kind === 'plugin' && f.id.endsWith(`/${name}`));
  if (brokenShort) return broken(brokenShort.id);
  return { ok: false, reason: 'unknown', message: `no agent named @${name} — /subagent @ lists them` };
}
