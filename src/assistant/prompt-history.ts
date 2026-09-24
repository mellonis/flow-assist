// The chat's ↑/↓ prompt history (pure; the chat owns the list, the session saves its
// last 100 as `prompts`).
//
// Every line the person submits goes in — a message, a `/command`, a `!command` (a
// line run in shell mode is kept as `!cmd`, and recalling it turns shell mode back on)
// — so ↑ repeats a command as readily as a question. Commands used to be left out, and
// `/notes step` had to be typed again every time. Two lines are not kept: the same
// line twice in a row, and a command whose definition says `history: false` — one
// whose argument may carry a secret, since the history is written to the session file.

// What the history needs to know of a command: its name and whether it opts out.
export type HistoryCommand = { name: string; history?: boolean };

// Whether a submitted line may be kept. A `/word` naming a command that says
// `history: false` may not; anything else may — an unknown command included, so a typo
// can be fixed with ↑.
export function keptInHistory(line: string, commands: readonly HistoryCommand[]): boolean {
  if (!line.startsWith('/')) return true;
  const name = line.slice(1).split(/\s+/)[0]!.toLowerCase();
  return commands.find((c) => c.name === name)?.history !== false;
}

// Appends `line` unless it is empty or the entry just before it. Returns whether it did.
export function pushHistory(history: string[], line: string): boolean {
  if (!line || history.at(-1) === line) return false;
  history.push(line);
  return true;
}
