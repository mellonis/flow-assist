// Which agent files the person has started. A project's agent file is somebody else's
// instructions and the model can write files, so the host keeps, in its own state
// (`agents.accepted.json`, 0600), the content hash of each project or person file as the
// person last started it: the key is the source and the file's real path, the value the
// hash of its bytes (`Agent.hash`). A file with no record, or with another hash, is new or
// changed. A plugin's file follows the plugin (it is found only while the plugin is
// installed, trusted and enabled), so it has no record.
//
// Only the person's start writes a record: a host process started from a command the
// model runs (`FLOW_ASSIST_MODEL_SHELL=1`, src/config/load.ts) writes none. Like the other
// records this stops the accident, not intent: a command that rewrites the record forges
// it. A record that cannot be read trusts nothing; the next write keeps it beside the
// new one.
import fs from 'node:fs';
import path from 'node:path';
import { hostStateDir, inModelShell } from '../config/load.js';
import { paramsText, type Agent } from './agent-file.js';
import type { AutoMode } from './auto.js';

export const agentTrustPath = (): string => path.join(hostStateDir(), 'agents.accepted.json');

// `<source>:<real path>` -> the accepted hash.
type AgentRecord = { files: Record<string, string> };
type Recorded = Pick<Agent, 'path' | 'source' | 'hash'>;

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const realOr = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const keyOf = (a: Recorded): string => `${a.source.kind}:${realOr(a.path)}`;

function readRecord(): { unreadable: boolean; rec: AgentRecord } {
  let raw: string;
  try { raw = fs.readFileSync(agentTrustPath(), 'utf8'); } catch (e) {
    return { unreadable: (e as NodeJS.ErrnoException).code !== 'ENOENT', rec: { files: {} } };
  }
  try {
    const v = JSON.parse(raw) as unknown;
    if (!isMap(v) || !isMap(v.files) || Object.values(v.files).some((h) => typeof h !== 'string')) return { unreadable: true, rec: { files: {} } };
    return { unreadable: false, rec: { files: v.files as Record<string, string> } };
  } catch { return { unreadable: true, rec: { files: {} } }; }
}

// Whether the model may start this agent: a plugin's always (the plugin's trust decided
// it was found), a project's or a person's only when its current hash is recorded.
export function agentTrusted(agent: Recorded): boolean {
  if (agent.source.kind === 'plugin') return true;
  const { unreadable, rec } = readRecord();
  return !unreadable && rec.files[keyOf(agent)] === agent.hash;
}

// The same check as `agentTrusted` against one read of the record, for a caller that
// asks about many agents at once.
export function trustedNow(): (agent: Recorded) => boolean {
  const { unreadable, rec } = readRecord();
  return (agent) => agent.source.kind === 'plugin' || (!unreadable && rec.files[keyOf(agent)] === agent.hash);
}

// A record exists for the file under another hash.
export function agentChanged(agent: Recorded): boolean {
  if (agent.source.kind === 'plugin') return false;
  const { unreadable, rec } = readRecord();
  const was = rec.files[keyOf(agent)];
  return !unreadable && was !== undefined && was !== agent.hash;
}

// The person started this agent file with this content. False when nothing was written:
// a plugin's file (no record), a process the model's command started, a failed write.
export function recordAgentStart(agent: Recorded): boolean {
  if (agent.source.kind === 'plugin' || inModelShell()) return false;
  const { unreadable, rec } = readRecord();
  rec.files[keyOf(agent)] = agent.hash;
  const file = agentTrustPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (unreadable) {
      try { fs.renameSync(file, `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`); } catch { /* gone meanwhile */ }
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

// What the person is asked before the first start of a project agent file: the file, what
// it will be allowed (its tool groups, its auto mode after the cap) and what it takes.
export function agentTrustRequest(agent: Pick<Agent, 'description' | 'path' | 'tools' | 'params' | 'body'>, id: string, mode: AutoMode, changed: boolean): { title: string; line: string; hint: string } {
  return {
    title: `⚠ ${changed ? `@${id} changed since you last started it` : `@${id} is a project file you have not started`} — start it? (y/n)`,
    line: [
      `@${id} — ${agent.description}`,
      `file: ${agent.path}`,
      `tool groups: ${agent.tools ? ['core', ...agent.tools.filter((g) => g !== 'core')].join(', ') : 'every group'}`,
      `auto mode: ${mode}`,
      `parameters: ${agent.params.length ? paramsText(agent.params) : 'none'}`,
      `prompt: ${plural(agent.body.split('\n').length, 'line')}, ${plural(agent.body.length, 'character')}`,
    ].join('\n'),
    hint: 'y starts it and remembers this content · n starts nothing',
  };
}
