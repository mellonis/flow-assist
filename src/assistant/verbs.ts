// The word the status line says while the model works: one picked at random for each
// request, drawn with the running-tool shimmer. It said `thinking…` or `writing…`,
// and "writing" read as a promise of text that was not there yet. The phase is still
// told apart — by colour, magenta while the model thinks (no token yet, reasoning,
// working out a call), the assistant's accent while its text arrives — and the word is
// one per request: a round keeps the verb it started with, the next round gets
// another. Pure: the chat picks and holds it; `ui.verbs` replaces the list.

export const VERBS: readonly string[] = [
  'Pondering', 'Brewing', 'Tinkering', 'Mulling', 'Weaving', 'Noodling', 'Percolating',
  'Conjuring', 'Simmering', 'Musing', 'Churning', 'Crafting', 'Puzzling', 'Sketching',
  'Whittling', 'Distilling', 'Mustering', 'Kneading', 'Untangling', 'Stewing',
  'Ruminating', 'Marinating', 'Tuning', 'Assembling', 'Sifting', 'Forging', 'Hatching',
  'Scheming', 'Fiddling', 'Wrangling',
];

// The list a person asked for (`ui.verbs`), when it holds any word; else the host's.
export function verbList(config: { ui?: { verbs?: unknown } } | undefined): readonly string[] {
  const own = config?.ui?.verbs;
  const words = Array.isArray(own) ? own.filter((w): w is string => typeof w === 'string' && !!w.trim()).map((w) => w.trim()) : [];
  return words.length ? words : VERBS;
}

// One verb for the next request. Never the one just shown, when there is another to
// pick: a new round should read as one. `rand` is `Math.random` unless a test says.
export function pickVerb(list: readonly string[], prev = '', rand: () => number = Math.random): string {
  const pool = list.length > 1 ? list.filter((w) => w !== prev) : list;
  if (!pool.length) return VERBS[0]!;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))]!;
}
