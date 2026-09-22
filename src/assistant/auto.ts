// The auto mode: how much of a turn runs without the person answering y/n. A long
// working session is a long series of confirmations, and there are stretches — a batch
// of edits, a clean-up — where the person wants to stop confirming for a while.
//
// It belongs to a CONVERSATION and is never saved: a restart, `/clear`, `/resume` and a
// change of task all come back to `ask`. A mode that survived a restart would be a
// standing permission nobody remembers granting.
//
// The three rungs:
//   - `ask`    — today's behaviour, and the state every conversation starts in.
//   - `reads`  — only what the host itself considers a read runs unasked. That is a
//     tool with no `write` flag, and the tools of an MCP server the person put on its
//     `readOnly` list: such a call never reaches the chat's confirmation in the first
//     place, so this rung skips no pause of its own. It is the rung the cycle passes
//     THROUGH — one keypress must not land on "every write runs" — and it is what the
//     hint line says while it is on.
//   - `all`    — a write runs without asking too, except for what can never be
//     automatic (below).
//
// Two calls are never automatic, in any mode:
//   - `run_command` — the y/n is its only guard, and the command may have been written
//     from a page or a ticket the model read a minute ago;
//   - `web_fetch` — a fetch that reaches the confirmation at all is one to a host
//     outside `web.allowlist` (that is exactly what its `write` flag tests), and a URL
//     can carry out anything the model has seen. Should that flag ever become a plain
//     `true`, this degrades to "never automatic", which is the safe direction.
// A background task is not covered here at all: it declines writes by construction —
// it is given a confirmation that always answers no, and the chat's mode never reaches
// it. Nor is the person's own `!command`: they typed it.

export type AutoMode = 'ask' | 'reads' | 'all';

// The order the key walks: ask → reads → all → ask.
export const AUTO_CYCLE: readonly AutoMode[] = ['ask', 'reads', 'all'];

export function nextAutoMode(mode: AutoMode): AutoMode {
  const at = AUTO_CYCLE.indexOf(mode);
  return AUTO_CYCLE[(at + 1) % AUTO_CYCLE.length] as AutoMode;
}

// What `/auto <arg>` asked for: a mode, `'cycle'` for the bare command (the key's own
// step), or null for a word that means nothing here.
export function autoCommand(arg: string): AutoMode | 'cycle' | null {
  const word = arg.trim().toLowerCase();
  if (!word) return 'cycle';
  if (word === 'off' || word === 'ask') return 'ask';
  if (word === 'reads' || word === 'read') return 'reads';
  if (word === 'all' || word === 'writes' || word === 'write') return 'all';
  return null;
}

// What the hint line shows — '' while the mode is `ask`, since there is nothing
// unusual to say then. `all` is called "writes" on screen: what it changes is that
// writes stop asking, and that is the word the person is looking for.
export function autoBadge(mode: AutoMode): string {
  return mode === 'reads' ? 'auto: reads' : mode === 'all' ? 'auto: writes' : '';
}

// The sentence said when the mode changes.
export function autoSaid(mode: AutoMode): string {
  if (mode === 'reads') return 'auto: reads — reads run, every write still asks';
  if (mode === 'all') return 'auto: writes — writes run without asking; run_command and an unlisted web_fetch still ask';
  return 'auto off — every write asks again';
}

// A tool the mode may never answer for. The name is the host's own (`plugin:tool`),
// the one `agentChat` resolves before it asks — a plugin that declared a tool of the
// same name gets the qualified spelling, and it is covered too.
const NEVER_AUTO = ['run_command', 'web_fetch'];
export function neverAutomatic(name: string): boolean {
  return NEVER_AUTO.some((n) => name === n || name.endsWith(`:${n}`));
}

// Does the mode answer this confirmation for the person? Only a write ever reaches
// here (the host asks about nothing else), so only `all` can say yes — and not for the
// two calls above.
export function autoConfirms(mode: AutoMode, name: string): boolean {
  return mode === 'all' && !neverAutomatic(name);
}
