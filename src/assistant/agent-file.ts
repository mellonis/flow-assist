// An agent file: a named subagent described in a Markdown file (AGENTS.md (agent
// files)). A header between two `---` lines of plain `key: value` lines, then the body,
// which is the agent's prompt. The reader is our own and small: every error names the
// file and the 1-based line it stands on, and a file with any error is not an agent.
//
//   description: one line, required
//   params:      comma-separated names, a trailing `?` marks an optional one, optional
//                ones only after the required ones; the body spells one `{{name}}`
//   tools:       comma-separated tool group ids
//   skills:      comma-separated skill names, loaded into the agent's first message when it starts
//   auto:        ask | reads | all (omitted: ask)
//
// An unknown or repeated key is an error, a `{{name}}` the header does not declare is
// an error, and so is a declared parameter the body never uses. Single braces in the
// body are left alone.
import { createHash } from 'node:crypto';
import path from 'node:path';

export type AgentSource = { kind: 'project' } | { kind: 'person' } | { kind: 'plugin'; plugin: string };
export type AgentAuto = 'ask' | 'reads' | 'all';
export interface AgentParam { name: string; optional: boolean }
export interface Agent {
  name: string; // the file name without `.md`
  description: string;
  params: AgentParam[];
  tools: string[] | null; // null — the key is omitted
  skills: string[]; // the skills preloaded at the start, in order; [] — the key is omitted
  auto: AgentAuto;
  body: string;
  path: string;
  source: AgentSource;
  hash: string; // sha-256 of the file's bytes, hex
}
export interface AgentError { path: string; line: number; message: string }
export type ParsedAgent = { ok: true; agent: Agent } | { ok: false; errors: AgentError[] };

export const AGENT_KEYS = ['description', 'params', 'tools', 'skills', 'auto'] as const;
export const AGENT_AUTOS: readonly AgentAuto[] = ['ask', 'reads', 'all'];
const NAME = /^[A-Za-z0-9-]+$/;
// A skill's name: `name`, or `<plugin>/<name>` (the grammar of a skill id).
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
const PARAM = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A placeholder stays on one line: a `{{ … }}` that spans lines is body text, not a parameter.
const PLACEHOLDER = /\{\{([^{}\n]*)\}\}/g;

export const agentHash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

// The file name without its `.md`; null when the name does not end in it.
export function agentNameOf(file: string): string | null {
  const base = path.basename(file);
  return base.endsWith('.md') ? base.slice(0, -3) : null;
}

export function parseAgentFile(file: string, content: string | Uint8Array, source: AgentSource = { kind: 'person' }): ParsedAgent {
  const text = (typeof content === 'string' ? content : Buffer.from(content).toString('utf8')).replace(/^﻿/, '');
  const errors: AgentError[] = [];
  const err = (line: number, message: string) => errors.push({ path: file, line, message });

  const name = agentNameOf(file);
  if (name === null || !NAME.test(name)) err(1, `the file name «${path.basename(file)}» is not an agent name — letters, digits and - before .md`);

  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') {
    err(1, 'the file does not start with a header — the first line is ---');
    return { ok: false, errors };
  }
  const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (close < 0) {
    err(1, 'the header is not closed — a second --- line ends it');
    return { ok: false, errors };
  }

  const seen = new Map<string, { line: number; value: string }>();
  for (let i = 1; i < close; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/.exec(raw);
    if (!m) { err(i + 1, `expected "key: value", found «${raw.trim()}»`); continue; }
    const key = m[1]!;
    if (!(AGENT_KEYS as readonly string[]).includes(key)) { err(i + 1, `unknown key "${key}" — the keys are ${AGENT_KEYS.join(', ')}`); continue; }
    if (seen.has(key)) { err(i + 1, `duplicate key "${key}" (first on line ${seen.get(key)!.line})`); continue; }
    seen.set(key, { line: i + 1, value: m[2]! });
  }

  const description = seen.get('description');
  if (!description) err(1, 'missing key "description"');
  else if (!description.value) err(description.line, 'description is empty');

  const params: AgentParam[] = [];
  const paramsAt = seen.get('params');
  if (paramsAt && paramsAt.value) {
    let optionalSeen = false;
    for (const part of paramsAt.value.split(',')) {
      const item = part.trim();
      const optional = item.endsWith('?');
      const word = optional ? item.slice(0, -1).trimEnd() : item;
      if (!PARAM.test(word)) { err(paramsAt.line, `malformed parameter name «${item}» — letters, digits and _, not starting with a digit`); continue; }
      if (params.some((p) => p.name === word)) { err(paramsAt.line, `parameter "${word}" is declared twice`); continue; }
      if (optional) optionalSeen = true;
      else if (optionalSeen) err(paramsAt.line, `required parameter "${word}" follows an optional one`);
      params.push({ name: word, optional });
    }
  }

  let tools: string[] | null = null;
  const toolsAt = seen.get('tools');
  if (toolsAt) {
    tools = [];
    for (const part of toolsAt.value.split(',')) {
      const id = part.trim();
      if (!id && !toolsAt.value.trim()) continue;
      if (!id || /\s/.test(id)) { err(toolsAt.line, `malformed tool group «${id}»`); continue; }
      if (!tools.includes(id)) tools.push(id);
    }
  }

  const skills: string[] = [];
  const skillsAt = seen.get('skills');
  if (skillsAt && skillsAt.value) {
    for (const part of skillsAt.value.split(',')) {
      const id = part.trim();
      if (!SKILL_NAME.test(id)) { err(skillsAt.line, `malformed skill name «${id}» — a name, or plugin/name`); continue; }
      if (skills.includes(id)) { err(skillsAt.line, `skill "${id}" is named twice`); continue; }
      skills.push(id);
    }
  }

  let auto: AgentAuto = 'ask';
  const autoAt = seen.get('auto');
  if (autoAt) {
    if ((AGENT_AUTOS as readonly string[]).includes(autoAt.value)) auto = autoAt.value as AgentAuto;
    else err(autoAt.line, `auto is «${autoAt.value}» — ask, reads or all`);
  }

  // The body's placeholders, each on its own line.
  const used = new Set<string>();
  for (let i = close + 1; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(PLACEHOLDER)) {
      const word = m[1]!.trim();
      if (!PARAM.test(word)) { err(i + 1, `malformed placeholder «${m[0]}»`); continue; }
      used.add(word);
      if (!params.some((p) => p.name === word)) err(i + 1, `{{${word}}} is not declared in params`);
    }
  }
  if (paramsAt) for (const p of params) if (!used.has(p.name)) err(paramsAt.line, `parameter "${p.name}" is never used in the body`);

  if (errors.length || name === null || !description) return { ok: false, errors };
  const body = lines.slice(close + 1).join('\n').replace(/^\s*\n/, '').trimEnd();
  return { ok: true, agent: { name, description: description.value, params, tools, skills, auto, body, path: file, source, hash: agentHash(typeof content === 'string' ? Buffer.from(content, 'utf8') : content) } };
}

// The body with every `{{name}}` replaced by its value; a name with none (an optional
// parameter left out) is the empty string. One pass: a value is never read for
// placeholders again.
export function fillPrompt(agent: Pick<Agent, 'body'>, values: Readonly<Record<string, string>>): string {
  return agent.body.replace(PLACEHOLDER, (_, inner: string) => (Object.hasOwn(values, inner.trim()) ? values[inner.trim()] : undefined) ?? '');
}

// `<ticket> [branch]`: the parameters as the listing shows them.
export const paramsText = (params: readonly AgentParam[]): string => params.map((p) => (p.optional ? `[${p.name}]` : `<${p.name}>`)).join(' ');
