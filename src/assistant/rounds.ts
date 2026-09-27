// What bounds one turn of the chat. Two limits, either of which ends a turn — the turn
// then closes with the host's line saying where it stopped, and the chat offers
// ⏎ continue:
// - `ai.maxRounds` — how many requests (rounds) one turn may take: a guard against a
//   loop that never ends, set high enough for long ordinary work (150). 0 is no round
//   cap, and then the token budget is what bounds a turn.
// - `ai.maxTurnTokens` — how many tokens the turn's requests may spend together (2M),
//   from the usage each request reports: its prompt less the part read from the
//   provider's cache (a long loop re-reads its prefix from the cache every round, which
//   is not new work), plus its answer. 0 is no budget; a provider that reports no usage
//   is bounded by the rounds alone.
// Both are the person's own settings (under `ai`, which the model may not set). A caller
// with its own reason (a background task) passes less. A module with no imports, so the
// config's notes (src/loader/tools-core.ts) can name the defaults.
export const MAX_ROUNDS_DEFAULT = 150;
export const MAX_TURN_TOKENS_DEFAULT = 2_000_000;

const wholeOrDefault = (n: unknown, dflt: number): number => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : dflt);

export function maxRoundsOf(ai: unknown): number {
  return wholeOrDefault((ai as { maxRounds?: unknown } | undefined)?.maxRounds, MAX_ROUNDS_DEFAULT);
}

export function maxTurnTokensOf(ai: unknown): number {
  return wholeOrDefault((ai as { maxTurnTokens?: unknown } | undefined)?.maxTurnTokens, MAX_TURN_TOKENS_DEFAULT);
}
