// The chat's ↑/↓ prompt history (pure; the chat owns the list, the session saves its
// last 100 as `prompts`).
//
// Every line the person submits goes in — a message, a `/command`, a `!command` or
// `!!command` (kept as `!cmd`/`!!cmd`, see encodeBangLine/decodeBangLine below, and
// recalling it turns the matching bang level back on) — so ↑ repeats a command as
// readily as a question. Commands used to be left out, and
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

// A `!command`/`!!command` history/session line encodes the chat field's bang LEVEL
// (1 shell mode, 2 interactive) as that many leading `!`, with the trimmed command
// text right after. A level-1 `cmd` that itself starts with `!` (a shell negation,
// `! grep -q x f`) gets a disambiguating space before it — `! !cmd` — since `cmd` is
// always trimmed and so can never start with a space otherwise: without it, `!` +
// `!cmd` reads back as `!!cmd`, indistinguishable from a level-2 entry (`decodeBangLine`
// checks the PREFIX `!!`, not what follows it, so a level-1 line whose text merely
// happens to start with a space after its own `!` would still be misread as level 2).
export function encodeBangLine(level: 1 | 2, cmd: string): string {
  if (level === 2) return `!!${cmd}`;
  return cmd.startsWith('!') ? `! ${cmd}` : `!${cmd}`;
}

// The inverse: the level a stored line was run at, and its command text with the
// level's bang(s) — and, at level 1, the disambiguating space if one is there —
// stripped back off.
export function decodeBangLine(raw: string): { level: 0 | 1 | 2; cmd: string } {
  if (raw.startsWith('!!')) return { level: 2, cmd: raw.slice(2) };
  if (raw.startsWith('!')) {
    const rest = raw.slice(1);
    return { level: 1, cmd: rest.startsWith(' ') ? rest.slice(1) : rest };
  }
  return { level: 0, cmd: raw };
}
