// What a write changed, drawn as a unified diff in the chat.
//
// A tool that edits something knows what it looked like before and after; it hands
// both to the host through `ctx.reportChange` and the host turns them into the block
// the chat keeps under the answer. The host cannot know how to read a file, an issue
// or a comment — the tool can — so the tool reports and the host only diffs.
//
// The diff is for the PERSON: it never reaches the model's history. The model wrote
// the new text itself, and sending it back as a diff would only fill the context.
//
// Pure: no fs, no clock. The line diff is an LCS over what is left once the common
// head and tail are cut off, so an edit in a big file costs the edited region only;
// a region too big to compare cell by cell is shown as removed-then-added.

// What a tool reports: `title` names the thing (a path, `ABC-1 · description`).
export interface Change {
  title: string;
  before: string;
  after: string;
}

// What the chat stores and draws — the diff already made, never the two texts, so a
// session file holds the lines shown and not two copies of a whole file.
export interface ChangeView {
  title: string;
  // Unified hunks (`@@ … @@`, then ` `/`-`/`+` lines), already cut to `maxLines`.
  diff: string;
  added: number;
  removed: number;
  // Diff lines not shown because of `maxLines`.
  hidden: number;
}

type Op = { kind: ' ' | '-' | '+'; text: string; a: number; b: number };

// Lines of a text; a final newline does not make an empty last line.
function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Above this many cells the middle is not compared line by line.
const MAX_CELLS = 4_000_000;

function lineOps(a: string[], b: string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ops: Op[] = [];
  for (let i = 0; i < head; i++) ops.push({ kind: ' ', text: a[i]!, a: i, b: i });
  const ma = a.slice(head, a.length - tail);
  const mb = b.slice(head, b.length - tail);
  const n = ma.length, m = mb.length;
  if (n * m > MAX_CELLS) {
    ma.forEach((text, i) => ops.push({ kind: '-', text, a: head + i, b: head }));
    mb.forEach((text, j) => ops.push({ kind: '+', text, a: head + n, b: head + j }));
  } else {
    // lcs[i][j]: the longest common run of ma[i..] and mb[j..].
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i]![j] = ma[i] === mb[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) { ops.push({ kind: ' ', text: ma[i]!, a: head + i, b: head + j }); i++; j++; }
      // Removals first, as `diff -u` writes them.
      else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { ops.push({ kind: '-', text: ma[i]!, a: head + i, b: head + j }); i++; }
      else { ops.push({ kind: '+', text: mb[j]!, a: head + i, b: head + j }); j++; }
    }
  }
  for (let k = 0; k < tail; k++) {
    const ai = a.length - tail + k, bi = b.length - tail + k;
    ops.push({ kind: ' ', text: a[ai]!, a: ai, b: bi });
  }
  return ops;
}

export interface DiffOpts {
  // Unchanged lines kept around each change.
  context?: number;
  // Diff lines drawn at most (hunk headers included); the rest is counted in `hidden`.
  maxLines?: number;
}

// `@@ -a,b +c,d @@` hunks of the change; empty when nothing changed.
export function unifiedDiff(before: string, after: string, { context = 3, maxLines = 80 }: DiffOpts = {}): Omit<ChangeView, 'title'> {
  const ops = lineOps(linesOf(before), linesOf(after));
  const added = ops.filter((o) => o.kind === '+').length;
  const removed = ops.filter((o) => o.kind === '-').length;
  if (!added && !removed) return { diff: '', added, removed, hidden: 0 };
  // Group the changed ops with `context` lines around them into hunks.
  const hunks: [number, number][] = [];
  ops.forEach((o, k) => {
    if (o.kind === ' ') return;
    const from = Math.max(0, k - context), to = Math.min(ops.length - 1, k + context);
    const last = hunks[hunks.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else hunks.push([from, to]);
  });
  const out: string[] = [];
  for (const [from, to] of hunks) {
    const part = ops.slice(from, to + 1);
    const aLen = part.filter((o) => o.kind !== '+').length;
    const bLen = part.filter((o) => o.kind !== '-').length;
    // A side with no lines names the line BEFORE the hunk, as `diff -u` does.
    const aStart = aLen ? part[0]!.a + 1 : part[0]!.a;
    const bStart = bLen ? part[0]!.b + 1 : part[0]!.b;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const o of part) out.push(`${o.kind}${o.text}`);
  }
  const shown = out.slice(0, Math.max(1, maxLines));
  return { diff: shown.join('\n'), added, removed, hidden: out.length - shown.length };
}

// The view of one reported change, or null when nothing changed. A text holding a
// NUL is not drawn line by line.
export function changeView(c: Change, opts: DiffOpts = {}): ChangeView | null {
  const title = String(c.title ?? '').trim() || 'change';
  const before = String(c.before ?? ''), after = String(c.after ?? '');
  if (before === after) return null;
  if (before.includes('\u0000') || after.includes('\u0000')) return { title, diff: '', added: 0, removed: 0, hidden: 0 };
  return { title, ...unifiedDiff(before, after, opts) };
}

// The markdown the chat lays out for one change: a header line, then the hunks in a
// ```diff fence (flowtty colours it). The fence is longer than any backtick run in the
// diff, so a changed Markdown file cannot close it early.
export function changeMarkdown(v: ChangeView): string {
  const counts = v.diff || v.added || v.removed ? ` · +${v.added} −${v.removed}` : ' · binary, not shown';
  const header = `✎ \`${v.title.replace(/`/g, "'")}\`${counts}`;
  if (!v.diff) return header;
  const longest = Math.max(0, ...(v.diff.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const more = v.hidden ? `\n… ${v.hidden} more line${v.hidden === 1 ? '' : 's'}` : '';
  return `${header}\n${fence}diff\n${v.diff}\n${fence}${more}`;
}
