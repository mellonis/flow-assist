// A conversation's work: a turn with the model, `/compact`, the y/n a write waits on and
// the settings-file guard's own. Functions over a Conversation, which holds the state;
// its methods call them, and the chat answers their events (AGENTS.md, "The chat").
import path from 'node:path';
import type { ChatMessage, compactConversation } from './agent.js';
import { autoConfirms } from './auto.js';
import { short as shortTokens } from './context-meter.js';
import { llmOpts } from './llm-endpoint.js';
import { shellAutoRun } from './shell.js';
import { configSetLine } from '../config/commands.js';
import { RESTART_NOTE, parseValue, type ConfigChange } from '../config/load.js';
import type { PendingConfirm } from './conversation-types.js';
import type { Conversation } from './conversation.js';

// A plain object holding every enumerable service, inherited ones included.
// `for…in` walks the prototype chain, which is exactly what a spread does not.
export function allServices(services: object): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const key in services) flat[key] = (services as Record<string, unknown>)[key];
  return flat;
}

// The command of a `run_command` call, so the y/n block can show the line itself
// rather than its JSON. null — some other tool, or arguments that do not parse.
export function shellCommandOf(name: string, args: string): string | null {
  if (name !== 'run_command' && !name.endsWith(':run_command')) return null;
  try {
    const a = JSON.parse(args) as { command?: unknown; cwd?: unknown };
    if (typeof a.command !== 'string') return null;
    return typeof a.cwd === 'string' && a.cwd.trim() ? `${a.command}   # in ${a.cwd}` : a.command;
  } catch {
    return null;
  }
}

// The line a `config_set` call stands for — the `config set` command the person would
// have typed — so the y/n block reads the same as the CLI rather than as JSON. null —
// some other tool, or arguments that do not parse. Only the host's own tool: a plugin's
// tool of the same name is registered qualified (`mcp:config_set`) and keeps its
// arguments on the block, or a line would hide what it really sends.
export function configLineOf(name: string, args: string): string | null {
  if (name !== 'config_set') return null;
  try {
    const a = JSON.parse(args) as { key?: unknown; value?: unknown; scope?: unknown };
    if (typeof a.key !== 'string' || (a.scope !== 'session' && a.scope !== 'saved')) return null;
    return configSetLine(a.key, typeof a.value === 'string' ? parseValue(a.value) : a.value, a.scope);
  } catch {
    return null;
  }
}

// The y/n pause on a write: agentChat calls it for a tool with a write flag, and it
// waits for the chat's key.
export function confirmWrite(c: Conversation, journalId: string) {
  return (name: string, argsStr: unknown, info?: { input?: string; inputId?: string; hostShell?: boolean; id?: string }) => new Promise<boolean>((resolve) => {
    // The one place a confirmation may be answered without the person:
    // the auto mode (src/assistant/auto.ts), which only `all` ever lets
    // say yes, never for an unlisted web_fetch or config_set, and for
    // run_command only while the person's `shell.autoRun` is on and the
    // call is the host's own shell tool (`info.hostShell`) — the key read
    // here, at the call, so a value set mid-session holds at once. It
    // answers BEFORE anything on screen moves — a call that does not
    // pause must not close the `/context` panel the person is reading.
    // Nothing here relaxes what agentChat asks about: a tool with no
    // write flag never reaches this function, and the trail and the ✎
    // diff block still show what ran.
    if (autoConfirms(c.autoMode, name, { autoRun: shellAutoRun(c.deps.config() as { shell?: unknown }), hostShell: info?.hostShell === true })) {
      c.journalTo(journalId, { t: 'confirm', ...(info?.id ? { id: info.id } : {}), name, answer: 'yes', by: 'auto' });
      resolve(true);
      return;
    }
    const args = typeof argsStr === 'string' ? argsStr : JSON.stringify(argsStr ?? '');
    const command = shellCommandOf(name, args);
    const line = configLineOf(name, args);
    // The tool whose earlier result the call takes as its input — the
    // block says where a command's stdin comes from.
    const input = info?.input ? `${info.input}${info.inputId ? ` (${info.inputId})` : ''}` : undefined;
    // The answer goes into the journal as it is given.
    const answered = (ok: boolean, by: 'person' | 'stop' | 'reset' = 'person') => {
      c.journalTo(journalId, { t: 'confirm', ...(info?.id ? { id: info.id } : {}), name, answer: ok ? 'yes' : 'no', by });
      resolve(ok);
    };
    const request: PendingConfirm = { name, args, ...(command != null ? { command } : {}), ...(line != null ? { line } : {}), ...(input ? { input } : {}) };
    c.confirm = { name, args, ...(input ? { input } : {}), resolve: answered };
    c.mirror.setPendingConfirm(request);
    // The chat: the /context panel and a pager close — the y/n is what the person must see.
    c.emit({ type: 'confirm', request });
    c.deps.notify();
  });
}

// ── Compaction ── /compact and the automatic one alike: the model's view becomes
// a handoff (`compactConversation`) that REPLACES the previous summary, which it
// was shown to carry forward. What the PERSON sees stays — the conversation above
// is theirs to scroll (wiping it down to the last message instead would read as
// /clear); a note marks where the model's view now begins, one row with how big
// that view was and is now (the reading `ctx N%` shows), `auto` when nobody
// asked, and the summary folded under it.
export async function foldIntoHandoff(c: Conversation, history: ChatMessage[], signal: AbortSignal): ReturnType<typeof compactConversation> {
  const ai = (c.deps.config().ai ?? {}) as Record<string, any>;
  const result = await c.deps.compact(history, { ...llmOpts(ai), signal, previous: c.summary });
  if (!signal.aborted && result.incomplete) c.deps.pushLog(`[compact] no usable handoff after a retry: ${result.incomplete}`);
  return result;
}
export function markCompacted(c: Conversation, before: number, summary: string, incomplete: string | undefined, auto: boolean): void {
  const after = c.contextReading().used;
  const sizes = before > 0 && after > 0 ? ` · ~${shortTokens(before)} → ~${shortTokens(after)} tokens` : '';
  const kept = incomplete ? ' · incomplete, previous kept' : '';
  const note = `── compacted${auto ? ' · auto' : ''}${sizes}${kept} ──`;
  c.journal({ t: 'compact', summary, note, ...(auto ? { auto: true } : {}) });
  c.mirror.setMessages((cur) => [...cur, { role: 'note', content: note, summary }]);
}

// A settings file changed outside the host (src/config/load.ts, the guard) is
// put to the person as a y/n of its own, in the confirmation's place: yes lays
// it on the running config, no keeps it off until restart. Never answered by
// the auto mode — it does not go through `confirmWrite`. A stop or a reset that
// closes it answers nothing: the next check asks again. Asked between a round's
// results and the next request (`beforeRequest` waits for it), after a
// `!command` and after a turn — never over another pending y/n or question.
// The y/n sits in the conversation's one confirmation slot, so a write's y/n and this one
// never stand together; it closes no panel, and the auto mode never answers it.
export function askConfigChanges(c: Conversation): Promise<void> {
  if (c.configAsk) return c.configAsk;
  const svc = (c.deps.services() as { configChanges?: { check(): ConfigChange[]; apply(ch: ConfigChange): { applied: string[]; restart: string[] }; decline(ch: ConfigChange): string | null } }).configChanges;
  if (!svc || c.confirm || c.question) return Promise.resolve();
  const changes = svc.check();
  if (!changes.length) return Promise.resolve();
  const run = (async () => {
    for (const change of changes) {
      const answer = await new Promise<boolean | null>((resolve) => {
        c.confirm = { name: 'config', args: '', resolve: (ok, by = 'person') => resolve(by === 'person' ? ok : null) };
        c.mirror.setPendingConfirm({ name: 'config', args: '', title: `⚠ ${change.file} changed outside flow-assist — apply? (y/n)`, line: change.lines.join('\n'), whole: true, hint: `y applies it now · n puts the accepted settings back and keeps the change beside the file` });
        c.deps.notify();
      });
      if (answer === null) break;
      if (answer) {
        const r = svc.apply(change);
        c.pushNote(`Applied ${change.file}: ${[...r.applied, ...r.restart.map((k) => `${k} (${RESTART_NOTE})`)].join(', ')}.`);
      } else {
        const kept = svc.decline(change);
        c.pushNote(`Put the accepted ${change.file} back${kept ? ` — the change is kept in ${path.basename(kept)}` : ''}.`);
      }
    }
  })().finally(() => { c.configAsk = null; });
  c.configAsk = run;
  return run;
}
