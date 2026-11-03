// `!command &`: a line whose last character is an unquoted `&` starts a background shell
// (./shell-job.ts) instead of a command that is waited for. Only that trailing `&` counts:
// `&&`, a `\&`, a `&` inside quotes, a `&` in the middle (`a & b`) and a redirection such as
// `2>&1 &`'s own `>&` and a `&` inside a `#` comment are left to the shell as a plain `!command`.

// The command with its trailing `&` taken off, or null when the line is not one.
export function backgroundCommand(line: string): string | null {
  const text = line.replace(/\s+$/, '');
  if (!text.endsWith('&')) return null;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  // Whether the last `&` is a bare operator: the scan reaches it outside quotes and unescaped.
  let bare = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    bare = false;
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (ch === '\\' && quote === '"') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    // A `#` that starts a word begins a comment: an `&` after it is part of the comment.
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]!))) return null;
    bare = ch === '&';
  }
  if (!bare || quote) return null;
  const before = text.slice(0, -1);
  if (/[&|<>]$/.test(before)) return null; // `&&`, `|&`, `>&`
  const command = before.replace(/\s+$/, '');
  return command ? command : null;
}
