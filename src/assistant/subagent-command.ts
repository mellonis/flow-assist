// `/subagent`: what the person's line means, how a job is named, how the listing reads
// (AGENTS.md (subagent command)). Pure text in, text out; the chat starts, lists and
// stops through the conversation.
import { formatDuration } from './duration.js';
import type { EndedChild, RunningChild } from './conversation-types.js';
import { paramsText, type AgentSource } from './agent-file.js';
import type { FoundAgents } from './agent-find.js';

export type SubagentLine =
  | { kind: 'list' }
  | { kind: 'agents' }
  | { kind: 'agent'; name: string; args: string; withContext: boolean; auto: boolean }
  | { kind: 'stop'; target: string }
  | { kind: 'tell'; target: string; text: string }
  | { kind: 'start'; prompt: string; withContext: boolean; auto: boolean }
  | { kind: 'error'; text: string };

const FLAGS = ['--with-context', '--auto'] as const;

// The flags at the start of `rest`, and what follows them.
function takeFlags(text: string): { withContext: boolean; auto: boolean; rest: string } {
  let rest = text;
  let withContext = false;
  let auto = false;
  for (;;) {
    const flag = FLAGS.find((f) => rest === f || rest.startsWith(`${f} `) || rest.startsWith(`${f}\n`) || rest.startsWith(`${f}\t`));
    if (!flag) break;
    if (flag === '--auto') auto = true; else withContext = true;
    rest = rest.slice(flag.length).trimStart();
  }
  return { withContext, auto, rest };
}

// The rest of the line after `/subagent` as the person typed it: spacing and line breaks
// inside the prompt are kept, since the prompt is the work. `--with-context` and `--auto`
// count only as the first words; `stop` and `tell` as the very first word are those
// commands (a prompt that starts with either word is written another way). A first word
// that starts with `@` names an agent file: `@` alone lists them, `@name …` starts one
// with the rest of the line as its arguments.
export function parseSubagentLine(raw: string): SubagentLine {
  let rest = raw.trim();
  if (!rest) return { kind: 'list' };
  const at = /^@(\S*)(?:\s+([\s\S]*))?$/.exec(rest);
  if (at) {
    if (!at[1]) return { kind: 'agents' };
    const flags = takeFlags((at[2] ?? '').trim());
    return { kind: 'agent', name: at[1], args: flags.rest, withContext: flags.withContext, auto: flags.auto };
  }
  const stop = /^stop(?:\s+([\s\S]*))?$/i.exec(rest);
  if (stop) {
    const target = (stop[1] ?? '').trim();
    return target ? { kind: 'stop', target } : { kind: 'error', text: '/subagent stop takes a number from the list or a name — /subagent lists them' };
  }
  const tell = /^tell(?:\s+([\s\S]*))?$/i.exec(rest);
  if (tell) {
    const body = (tell[1] ?? '').trim();
    const at = body.search(/\s/);
    const target = at < 0 ? body : body.slice(0, at);
    const text = at < 0 ? '' : body.slice(at).trim();
    return target && text ? { kind: 'tell', target, text } : { kind: 'error', text: '/subagent tell takes a number from the list or a name, then the message — /subagent lists them' };
  }
  const { withContext, auto, rest: prompt } = takeFlags(rest);
  rest = prompt;
  if (!rest) return { kind: 'error', text: '/subagent needs a prompt after its flags — what should it do?' };
  return { kind: 'start', prompt: rest, withContext, auto };
}

const LABEL_WORDS = 3;
const LABEL_MAX = 24;

// A short one-line name cut from the prompt's first words, unique among `taken` (the
// conversation's live children): `-2`, `-3` after it.
export function subagentLabel(prompt: string, taken: readonly string[]): string {
  const words = prompt.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return uniqueLabel(words.slice(0, LABEL_WORDS).join('-').slice(0, LABEL_MAX).replace(/-+$/, '') || 'subagent', taken);
}

// `base`, or `base-2`, `base-3` … when a live label has it.
export function uniqueLabel(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// The running children that carry a label, in listing order, and which of them a listed
// number means: the k-th one, where k counts how many rows before it in `listed` carry the
// same label. Labels can repeat (a task the model started may share a subagent's), and a
// number must name the one row it was printed on.
function nthWithLabel(running: readonly RunningChild[], listed: readonly string[], number: number, fold: boolean): { label: string; at: number } | null {
  const label = listed[number - 1];
  if (label === undefined) return null;
  const same = (l: string): boolean => (fold ? l.toLowerCase() === label.toLowerCase() : l === label);
  const k = listed.slice(0, number - 1).filter(same).length;
  const hits = running.flatMap((c, i) => (same(c.label) ? [i] : []));
  return { label, at: hits[k] ?? -1 };
}

// The running child a `stop` names, as an index into `running`: a number is read against
// `listed`, the labels of the listing the person last saw (null when none was printed),
// so a job that ended since leaves its number unanswered instead of shifting the others;
// a name is read against the live children. -1 for none.
export function stopTargetIndex(running: readonly RunningChild[], target: string, listed: readonly string[] | null): number {
  if (/^\d+$/.test(target)) return listed ? (nthWithLabel(running, listed, Number(target), false)?.at ?? -1) : -1;
  const wanted = target.toLowerCase();
  return running.findIndex((c) => c.label.toLowerCase() === wanted);
}

// The child a `tell` names, as an index into `running`: a number is read against `listed`
// as `stopTargetIndex` reads it (it names exactly the row it was printed on), a name
// against the live children. `many` holds the numbers (as the listing counts them) of
// every child that answers to a name; a number never gets it. null for none.
export function tellTargetIndex(running: readonly RunningChild[], target: string, listed: readonly string[] | null): { at: number } | { many: number[] } | null {
  if (/^\d+$/.test(target)) {
    const hit = listed ? nthWithLabel(running, listed, Number(target), true) : null;
    return hit && hit.at >= 0 ? { at: hit.at } : null;
  }
  const lower = target.toLowerCase();
  const hits = running.flatMap((c, i) => (c.label.toLowerCase() === lower ? [i] : []));
  if (hits.length > 1) return { many: hits.map((i) => i + 1) };
  return hits.length ? { at: hits[0]! } : null;
}

const tokenText = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

// The listing: the live ones numbered (what `stop` and `tell` take), idle ones among them, then the ended ones.
// A conversation with neither says so.
export function subagentListing(running: readonly RunningChild[], ended: readonly EndedChild[], now = Date.now()): string {
  if (!running.length && !ended.length) return 'no subagents here';
  const lines: string[] = [];
  running.forEach((c, i) => {
    const state = c.status === 'delayed' ? `in ${formatDuration(Math.max(0, (c.until ?? now) - now))}` : c.status === 'idle' && c.answered ? 'answered' : c.status;
    const spent = c.status === 'working' && c.startedAt !== null ? ` · ${formatDuration(now - c.startedAt)}` : '';
    lines.push(`${i + 1} · ${c.label}${c.kind === 'task' ? ' (task)' : ''} · ${state}${spent}`);
  });
  for (const e of ended) {
    const verdict = e.outcome === 'answer' ? 'done' : e.outcome === 'failed' ? 'failed' : e.outcome === 'stopped' ? 'stopped' : e.outcome;
    lines.push(`${e.label}${e.kind === 'task' ? ' (task)' : ''} · ${verdict} · ${formatDuration(e.ms)}${e.tokens ? ` · ${tokenText(e.tokens)} tokens` : ''}`);
  }
  return lines.join('\n');
}

const sourceText = (s: AgentSource): string => (s.kind === 'plugin' ? `plugin ${s.plugin}` : s.kind);

// The agent files found, as a note. A note is drawn as markdown, where single line
// breaks join, so each agent and each error is a list item: the agent with its
// description, its parameters and where it comes from, a person's agent hidden by the
// project's marked; every file with errors as `path:line: message`. With `shell.roots`
// unset it says the project's agents are not read.
export function agentListing(found: FoundAgents): string {
  const item = (a: FoundAgents['agents'][number], extra = ''): string => `- @${a.id} — ${a.description} · ${a.params.length ? `${paramsText(a.params)} · ` : ''}${sourceText(a.source)}${extra}`;
  const blocks: string[] = [];
  const agents = [...found.agents.map((a) => item(a)), ...found.shadowed.map((a) => item(a, ' (shadowed by the project\'s agent of this name)'))];
  blocks.push(agents.length ? agents.join('\n') : 'no agents found');
  if (found.errors.length) blocks.push(found.errors.map((e) => `- ${e.path}:${e.line}: ${e.message}`).join('\n'));
  if (!found.projectRead) blocks.push('the project\'s agents are not read — shell.roots is not set');
  return blocks.join('\n\n');
}
