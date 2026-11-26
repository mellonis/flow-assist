// What a write changed, drawn as a unified diff in the chat.
//
// A tool that edits something knows what it looked like before and after; it hands
// both to the host through `ctx.reportChange` and the host turns them into the block
// the chat keeps in the turn, where the write happened. The host cannot know how to read a file, an issue
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

// The record keeps the change whole up to `CHANGE_DIFF_MAX_BYTES` of diff, so a reader
// can walk all of it; the chat draws the first `CHANGE_DRAW_MAX_LINES` kept lines. The
// two caps are separate on purpose: what a session keeps is bounded by bytes, what the
// chat draws by rows.
export const CHANGE_DIFF_MAX_BYTES = 2 * 1024 * 1024;
export const CHANGE_DRAW_MAX_LINES = 80;

// What the chat stores and draws — the diff already made, never the two texts, so a
// session file holds the change's own lines and not two copies of a whole file.
export interface ChangeView {
  title: string;
  // Unified hunks (`@@ … @@`, then ` `/`-`/`+` lines), kept whole up to `CHANGE_DIFF_MAX_BYTES`.
  diff: string;
  added: number;
  removed: number;
  // Diff lines the record did not keep — past the byte cap.
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
// NUL is not drawn line by line. The diff is kept whole up to `CHANGE_DIFF_MAX_BYTES`:
// the cut ends on a line boundary, and what it drops is all that `hidden` counts.
export function changeView(c: Change): ChangeView | null {
  const title = String(c.title ?? '').trim() || 'change';
  const before = String(c.before ?? ''), after = String(c.after ?? '');
  if (before === after) return null;
  if (before.includes('\u0000') || after.includes('\u0000')) return { title, diff: '', added: 0, removed: 0, hidden: 0 };
  const d = unifiedDiff(before, after, { maxLines: Number.MAX_SAFE_INTEGER });
  const all = d.diff ? d.diff.split('\n') : [];
  const utf8 = new TextEncoder();
  const kept: string[] = [];
  let bytes = 0;
  for (const line of all) {
    const next = bytes + utf8.encode(line).length + (kept.length ? 1 : 0);
    if (next > CHANGE_DIFF_MAX_BYTES) break;
    bytes = next;
    kept.push(line);
  }
  return { title, ...d, diff: kept.join('\n'), hidden: d.hidden + (all.length - kept.length) };
}

// What the `✎` line says after the path: how much went in and how much came out. The
// path itself is not part of it — the chat draws the title as a title, the path in its
// accent colour and this dim beside it. The header is plain text, not markdown, so
// the path never takes on the code style inline-code backticks would give it.
export function changeCounts(v: ChangeView): string {
  return v.diff || v.added || v.removed ? `· +${v.added} −${v.removed}` : '· binary, not shown';
}

// What the `/diff` panel's file row says after the path: `· +N −M` in `changeCounts`'
// wording, or why the file is not drawn at all. A cut record keeps its counts — its
// hunks draw, and a note row under them says how much was not kept. The argument is
// the fields the answer needs rather than a `FileDiff`: `working-tree.ts` imports this
// module, so a type import back would close a cycle, and this module stays
// dependency-free.
export function fileDiffCounts(f: { added: number; removed: number; note?: 'binary' | 'too large' | 'cut' }): string {
  if (f.note === 'binary') return '· binary, not shown';
  if (f.note === 'too large') return '· too large, not shown';
  return `· +${f.added} −${f.removed}`;
}

// The diff as far as the chat draws it — the first `CHANGE_DRAW_MAX_LINES` kept lines.
// `changeMarkdown` lays these out, and everything that reads the numbers of a drawn row
// walks these same rows: a gutter sized from the whole record would move when a record
// keeps more.
export function drawnDiff(v: ChangeView): string {
  return v.diff ? v.diff.split('\n').slice(0, CHANGE_DRAW_MAX_LINES).join('\n') : '';
}

// The markdown the chat lays out for one change: the hunks in a ```diff fence, which
// is what colours a diff green and red. The fence is longer than any backtick run in
// the drawn lines, so a changed Markdown file cannot close it early. Only the first
// `CHANGE_DRAW_MAX_LINES` kept lines are drawn; the note counts everything past them —
// kept lines the draw does not take, and lines the record did not keep. Empty for a
// change with nothing to draw and nothing to count (a binary file) — the title line
// then stands alone. A cut that left only the `@@` header draws no rows but still
// carries its note; a change never draws as a silent hole.
export function changeMarkdown(v: ChangeView): string {
  const all = v.diff ? v.diff.split('\n') : [];
  const text = drawnDiff(v);
  const rows = diffRows(text);
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const n = Math.max(0, all.length - CHANGE_DRAW_MAX_LINES) + v.hidden;
  const more = n ? `\n… ${n} more line${n === 1 ? '' : 's'}` : '';
  if (!rows.length) return more.slice(1);
  return `${fence}diff\n${rows.map((r) => r.text).join('\n')}\n${fence}${more}`;
}

// The number each diff line carries in the FILE — the one thing a diff row is missing
// when the reader wants to go and look at it. flowtty can number a fenced block's own
// rows, but on a diff that counts diff lines (1, 2, 3…), which nobody wants to read;
// the numbers have to come from the hunk header, and they are the reason the `@@` row
// itself can go: it exists to say where in the file one is, and these say it per row.
//
// A context or an added row takes its number in the NEW file, a removed row its number
// in the OLD one; every hunk starts counting again from its own header. A hunk header
// gets '' — it is not a line of the file — and so does anything that is neither, which
// is how a diff that could not be read line by line stays harmless.
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
export function diffLineNumbers(diff: string): string[] {
  let oldNo = 0, newNo = 0;
  return (diff ? diff.split('\n') : []).map((line) => {
    const at = HUNK_HEADER.exec(line);
    if (at) { oldNo = Number(at[1]); newNo = Number(at[2]); return ''; }
    if (line.startsWith('+')) return String(newNo++);
    if (line.startsWith('-')) return String(oldNo++);
    if (line.startsWith(' ')) { oldNo++; return String(newNo++); }
    return '';
  });
}

// The change as it is DRAWN: every line with the number it has in the file, and the
// `@@` rows left out — they exist to say where in the file one is, and the numbers say
// that per row. The hunks stay whole in `ChangeView.diff`, which is what a session
// keeps and what these numbers are read from: the header is their only source.
export function diffRows(diff: string): { text: string; no: string }[] {
  const nums = diffLineNumbers(diff);
  return (diff ? diff.split('\n') : [])
    .map((text, i) => ({ text, no: nums[i] ?? '' }))
    .filter((r) => !HUNK_HEADER.test(r.text));
}

// The hunks as one group each — what a walk rests a cursor on: a hunk's first row.
// A `@@` header starts a group and its rows are `diffRows`' rows under that header;
// rows before the first header are no hunk's and are dropped.
export function diffRowGroups(diff: string): Array<Array<{ text: string; no: string }>> {
  const texts: string[] = [];
  for (const line of diff ? diff.split('\n') : []) {
    if (HUNK_HEADER.test(line)) texts.push(line);
    else if (texts.length) texts[texts.length - 1] += '\n' + line;
  }
  // Each group keeps its own header while the numbers are read from it — `diffRows`
  // drops the header's row and keeps the rest, as it does for a whole diff.
  return texts.map((text) => diffRows(text));
}
