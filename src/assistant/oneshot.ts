// The one-shot prompt's conversation (`flow-assist "<prompt>"`, AGENTS.md "CLI"): what it
// is handed, and what the end of its one turn means on the command line.
import { hostDeps } from './host-deps.js';
import { redactSecrets } from './secrets.js';
import { ONESHOT_WITHHELD } from './conversation-turn.js';
import type { ConversationDeps, TurnEnd } from './conversation-types.js';
import type { HostServices } from '../runtime/services.js';

// Headless: nobody to ask (`canAsk: false`), no screen, no sessions directory — so no
// session file, no journal, no lock — and no App to redraw. The services are the host's
// own (`createServices`), whose `chatLLM` applies the config's limits, tool loading,
// result cap, image limits and endpoint, as the chat's does. No `current` and no
// settings-file service: the guard never asks here. Every run of the model it makes
// withholds `ONESHOT_WITHHELD`, the turn's own and each a tool starts through
// `ctx.chatLLM` alike: a nested run offered `background` or `remind` could leave work
// or a timer running after the answer prints.
export function oneShotDeps(config: Record<string, unknown>, services: HostServices): ConversationDeps & { canAsk: false } {
  return {
    ...hostDeps({
      config: () => config,
      services: () => services as unknown as Record<string, unknown>,
      notify: () => {},
      sessionsDir: () => null,
      lockToken: '',
      canAsk: false,
      withhold: ONESHOT_WITHHELD,
    }),
    canAsk: false,
  };
}

// What the one-shot prints and how it exits, from how its turn ended — decided by the
// outcome, never by whether an answer has text (a failed turn can leave cut text in the
// list):
// - an answer: the answer on stdout, exit 0 — a turn that ended with reasoning and no
//   text prints an empty line;
// - a limit (`ai.maxRounds`, `ai.maxTurnTokens`): said on stderr, exit 2;
// - a failure: the error on stderr, as the command line prints any error, exit 1;
// - nothing sent (`end` null: an empty prompt): said on stderr, exit 1.
// A settings file changed on disk during the run (`settingsChanged`) adds one line after
// these and never changes the exit code: the change is not applied (src/config/load.ts,
// the guard). Every stderr line passes `redactSecrets`, as every line the chat shows
// does: a provider's error and a tool's arguments can carry a secret.
// Nothing in a one-shot stops its turn; a signal ends the process.
export const SETTINGS_CHANGED_LINE = 'settings file changed outside flow-assist — not applied';
export interface OneShotOutcome { out?: string; err?: string; code: 0 | 1 | 2 }
export function oneShotOutcome(end: TurnEnd | null, answer: string, settingsChanged = false): OneShotOutcome {
  const said = turnOutcome(end, answer);
  if (!settingsChanged) return said;
  return { ...said, err: `${said.err ?? ''}${redactSecrets(SETTINGS_CHANGED_LINE)}\n` };
}
function turnOutcome(end: TurnEnd | null, answer: string): OneShotOutcome {
  if (!end) return { err: 'flow-assist: the prompt is empty — flow-assist "your request"\n', code: 1 };
  if (end.outcome === 'answer' || end.outcome === 'empty') return { out: `${answer}\n`, code: 0 };
  if (end.outcome === 'limit' && end.limit) return { err: `${redactSecrets(limitLine(end.limit))}\n`, code: 2 };
  return { err: `${redactSecrets(end.error ?? `the turn ended: ${end.outcome}`)}\n`, code: 1 };
}

// The limit a turn stopped at, as the journal's export says it.
export function limitLine(limit: NonNullable<TurnEnd['limit']>): string {
  const what = limit.by === 'tokens' ? `${limit.turnTokens ?? 0} tokens (ai.maxTurnTokens)` : `${limit.rounds} rounds (ai.maxRounds)`;
  return `flow-assist: stopped after ${what} — no answer${limit.lastStep ? `; last step: ${limit.lastStep}` : ''}`;
}
