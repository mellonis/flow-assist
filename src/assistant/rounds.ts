// How many rounds one turn may take (`ai.maxRounds`): a guard against a loop that
// never ends, set high enough for long ordinary work. A caller with its own reason
// (a background task) passes less. A module of its own, with no imports, so the
// config's notes (src/loader/tools-core.ts) can name the default.
export const MAX_ROUNDS_DEFAULT = 150;

export function maxRoundsOf(ai: unknown): number {
  const n = (ai as { maxRounds?: unknown } | undefined)?.maxRounds;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : MAX_ROUNDS_DEFAULT;
}
