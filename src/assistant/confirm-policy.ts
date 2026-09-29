// Who answers a write's y/n, for every path to the model: one closed set of policies and
// the one function that turns a policy into the `confirmWrite` a run is handed
// (AGENTS.md, "A path to the model that cannot ask the person declines writes").
import type { AgentOpts } from './agent.js';
import { autoConfirms, neverAutomatic } from './auto.js';
import { runMark, shellAutoRun } from './shell.js';
import { sanitizeViewText } from './views.js';
import { configSetLine } from '../config/commands.js';
import { parseValue } from '../config/load.js';
import type { PendingConfirm } from './conversation-types.js';
import type { Conversation } from './conversation.js';

export type ConfirmWrite = NonNullable<AgentOpts['confirmWrite']>;

export type ConfirmPolicy =
  | { kind: 'ask' }                                            // the auto mode first, then a y/n the person answers in the chat
  | { kind: 'always-no' }                                      // every write declined, journaled `by: 'background'`; no driver uses it yet
  | { kind: 'none' }                                           // nobody to ask: no confirmWrite at all, so agentChat declines before the call starts
  | { kind: 'allow-writes'; say: (line: string) => void }      // `--allow-writes`: what the auto mode may answer with `shell.autoRun` on, each write said
  | { kind: 'caller'; confirm: ConfirmWrite };                 // a plugin tool's own confirmation, journaled `by: 'plugin'`

// Where a policy's answers are journaled: the conversation, the journal id of the turn or
// nested run the call belongs to (`journalTo` follows it into a fork), and a background
// task's label, which tags its lines and makes its answers `by: 'background'`.
export interface ConfirmScope { conv: Conversation; journalId: string; task?: string }

// The `confirmWrite` a run is handed, or none. `none` returns nothing on purpose:
// agentChat then declines every write before it starts, with no `onToolStart` and no
// `confirm` line — the one rule for a run that cannot ask.
export function confirmFor(policy: ConfirmPolicy, scope: ConfirmScope): ConfirmWrite | undefined {
  const { conv, journalId } = scope;
  const tag = scope.task ? { task: scope.task } : {};
  const answered = (name: string, info: { id?: string } | undefined, ok: boolean, by: 'background' | 'plugin') =>
    conv.journalTo(journalId, { t: 'confirm', ...(info?.id ? { id: info.id } : {}), name, answer: ok ? 'yes' : 'no', by, ...tag });
  switch (policy.kind) {
    case 'ask':
      return askPerson(conv, journalId);
    case 'always-no':
      return (name, _args, info) => { answered(name, info, false, 'background'); return false; };
    case 'none':
      return undefined;
    case 'allow-writes':
      // The person's yes given in advance, to what the chat's auto mode may answer with
      // `shell.autoRun` on — never `config_set`, an unlisted `web_fetch` or a plugin's
      // `run_command` (`neverAutomatic` with both consents) — and each write it lets
      // through is said as it runs.
      return (name, args, info) => {
        if (neverAutomatic(name, { autoRun: true, hostShell: !!info?.hostShell })) return false;
        policy.say(writeLine(name, args));
        return true;
      };
    case 'caller':
      return async (name, args, info) => {
        const ok = !!(await policy.confirm(name, args, info));
        answered(name, info, ok, scope.task ? 'background' : 'plugin');
        return ok;
      };
    default: {
      const exhaustive: never = policy;
      return exhaustive;
    }
  }
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
export function askPerson(c: Conversation, journalId: string): ConfirmWrite {
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
    c.drawConfirm(request);
    // The chat: the /context panel and a pager close — the y/n is what the person must see.
    c.emit({ type: 'confirm', request });
    c.deps.notify();
  });
}

// A write as `--allow-writes` says it on stderr: the command line of a `run_command`,
// else the tool and its arguments. The line is the flag's only safeguard, so it is
// cleaned as a view's text is (`sanitizeViewText`: no escape code, a carriage return a
// line break) and each line after the first is marked too — a command cannot erase
// its own line or pass a line of its own off as other output.
export function writeLine(name: string, argsText: string): string {
  const command = shellCommandOf(name, argsText);
  const text = sanitizeViewText(command !== null ? `${runMark()} ${command}` : `${name} ${argsText}`);
  return text.split('\n').map((line, i) => (i ? `[write]   ${line}` : `[write] ${line}`)).join('\n');
}
