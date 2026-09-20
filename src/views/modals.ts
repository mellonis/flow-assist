// Built-in modal renderers: chat, help, log — `renderChatModal`/`renderHelp`/
// `renderLogModal` and their helpers live in the HOST; a plugin's own modals stay
// in the plugin.
//
// Each renderer is a PURE function `(props) => ReactElement` — the owning plugin
// modal (assistant.chat / core.help / log.log) computes state and passes it here as
// props, so nothing reads or sets state from the render side. The port is written as
// `.ts` with explicit `h()` (createElement) calls — `tsconfig.json` includes `*.ts`
// only, so a `.tsx` view would silently bypass `bun run typecheck`.
//
// Host adaptations vs. the tracker source:
//   - tracker-agnostic: `/analyze` stripped from the hints/empty-state; `analysisAttached`
//     dropped; the title falls back to `Chat` when `currentIssueId` is null (the host
//     never sets it).
//   - THE AUTOCOMPLETE LIST (Task #20): `renderChatModal` accepts `completions
//     { matches, sel }` and draws the allowed `/`-candidate row above the input —
//     the feature the tracker renderer never had (the tracker completed in-place only).
//   - `theme` may be undefined / lack a resolved `modals` map, so every
//     `theme.modals.<name>.<prop>` read is guarded (`m = theme?.modals?.chat ?? {}`).

import { createElement as h } from 'react';
import {
  Box,
  Text,
  layoutMarkdown,
  parseInline,
  splitVisualLines,
  windowAround,
} from '@flowtty/react';

// ─── Shapes ────────────────────────────────────────────────────────────────────
// The chat message the assistant plugin hands over (role + optional fields).
interface ChatMsg {
  role: string;
  content?: string | null;
  live?: string;
  reasoning?: string;
  process?: string;
  toolRuns?: ToolRun[];
  duration?: number;
  [k: string]: unknown;
}
// One executed tool in a turn, for the persistent `▸ name (args) → outcome` trace.
interface ToolRun {
  name: string;
  args?: unknown;
  outcome: string;
  detail?: string;
}
// The assistant's task plan (the `todo` core tool). Rendered as a fixed checkbox
// block above the chat: active items (in-progress ◐ first, then pending ☐), up to
// MAX_VISIBLE, with done items condensed to a "+N pending · M done" count. Purely
// presentational — the render never mutates it (the plugin hands over a snapshot
// from todoSnapshot()).
interface PlanItem {
  id: number;
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}
// How many active (non-done) plan rows are drawn before the rest fold into a count.
const MAX_VISIBLE_PLAN = 5;
// A styled span (matches StyledSpan: text + flowtty emphasis props). We widen with
// `link`/`[k: string]` so InlineSeg (parseInline) objects fit too.
interface Span {
  text: string;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
  color?: string;
  [k: string]: unknown;
}
interface Line {
  spans: Span[];
}
// A flattened chat row (one visual line / a label / a fold header / a gap).
interface ChatRow {
  role?: string;
  // `label` is overloaded in the source: `true` marks the role-label row, or a
  // string is the reason/fold-header text (`reasoning`, `reasoning + tools`).
  label?: boolean | string;
  duration?: number;
  reasonHeader?: boolean;
  open?: boolean;
  reason?: boolean;
  toolRunsHdr?: boolean;
  toolRun?: boolean;
  spans?: Span[];
  gap?: boolean;
}
// The slash-command autocomplete state the assistant plugin computes.
interface Completions {
  matches: string[];
  sel: number;
}
// The theme config subtree (`f.config.theme`) — a free-form object. Only `modals`
// (the per-surface palette) and a few flat keys are read. Typed loosely so a missing/
// deep-absent key degrades to Flowtty defaults instead of throwing on `undefined`.
interface Theme {
  // `modals` holds BOTH flat shared palette keys (bg/border/borderBg, read by
  // renderHelp directly) and nested surface palettes (`.chat`, `.log`).
  modals?: Record<string, unknown>;
  error?: string;
  [k: string]: unknown;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const spin = (ms: number) => SPINNER[Math.floor(ms / 120) % SPINNER.length];
const fmtSec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
// A plural for the counters: the one / few / many forms.
const pluralNs = (n: number, one: string, few: string, many: string): string => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return `${n} ${few}`;
  return `${n} ${many}`;
};

// ─── Markdown → styled lines (GFM tables handled before layoutMarkdown) ────────
// layoutMarkdown does not understand GFM pipe tables (their rows collapse into one
// line with literal `|`), so a table block is re-written into column-aligned lines
// that it then leaves alone. Each cell runs through parseInline, so bold/code/emoji
// inside a cell render like the rest of the text.
function parseTableRow(line: string): string[] {
  const parts = line.split('|');
  if (parts[0]?.trim() === '') parts.shift();
  if (parts[parts.length - 1]?.trim() === '') parts.pop();
  return parts.map((s) => s.trim());
}
const cellSegs = (t: unknown): Span[] => parseInline(String(t ?? '')) as unknown as Span[];
const segWidth = (segs: Span[]) => segs.reduce((n, s) => n + [...s.text].length, 0);
function tableBlockAt(lines: string[], i: number, wrap: number): { lines: Line[]; end: number } | null {
  if (i + 1 >= lines.length) return null;
  const header = lines[i];
  const sepRow = lines[i + 1];
  if (!header.includes('|')) return null;
  if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(sepRow) || !sepRow.includes('-')) return null;
  let end = i;
  const rows: string[][] = [];
  while (end < lines.length && lines[end].includes('|') && lines[end].trim() !== '') {
    rows.push(parseTableRow(lines[end]));
    end++;
  }
  if (rows.length < 2) return null;
  const body = rows.slice(0, 1).concat(rows.slice(2));
  const cols = Math.max(1, ...body.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) widths[c] = Math.max(...body.map((r) => segWidth(cellSegs(r[c]))));
  let totalW = widths.reduce((a, b) => a + b, 0) + (cols - 1) * 2 + 2;
  for (let guard = 0; guard < 1000 && totalW > wrap; guard++) {
    const widest = widths.indexOf(Math.max(...widths));
    widths[widest] = Math.max(3, widths[widest] - 1);
    totalW = widths.reduce((a, b) => a + b, 0) + (cols - 1) * 2 + 2;
  }
  const padTo = (segs: Span[], w: number): Span[] => {
    const cur = segWidth(segs);
    if (cur > w) {
      let need = w;
      const out: Span[] = [];
      for (const s of segs) {
        if (need <= 0) break;
        const take = s.text.slice(0, need);
        out.push({ ...s, text: take });
        need -= take.length;
      }
      return out;
    }
    return [...segs, { text: ' '.repeat(w - cur) }];
  };
  const renderRow = (r: unknown[]): Line => {
    const out: Span[] = [];
    for (let c = 0; c < cols; c++) {
      out.push(...padTo(cellSegs(r[c]), widths[c]));
      if (c < cols - 1) out.push({ text: '  ' });
    }
    return { spans: out };
  };
  const out: Line[] = [];
  out.push(renderRow(body[0] ?? []));
  out.push({ spans: [{ text: ' ' }, ...widths.map((w) => ({ text: '-'.repeat(w), dim: true })).flatMap((s, ci) => (ci ? [{ text: '  ' }, s] : [s]))] });
  for (let r = 1; r < body.length; r++) out.push(renderRow(body[r] ?? []));
  return { lines: out, end };
}

export function mdLines(text: string | null | undefined, wrap: number): Line[] {
  if (!text) return [{ spans: [] }];
  try {
    const hasTable = text.includes('|');
    const lines = text.split('\n');
    const out: Line[] = [];
    let i = 0;
    while (i < lines.length) {
      const tbl = hasTable ? tableBlockAt(lines, i, wrap) : null;
      if (tbl) {
        for (const l of tbl.lines) out.push({ spans: l.spans });
        i = tbl.end;
      } else {
        const run: string[] = [];
        while (i < lines.length && !(hasTable && tableBlockAt(lines, i, wrap))) { run.push(lines[i]); i++; }
        if (run.some((s) => s.trim() !== '')) for (const line of layoutMarkdown(run.join('\n'), wrap)) out.push(line as Line);
      }
    }
    // Quiet the `###`-heading noise: layoutMarkdown renders them as dim-`###` + bold
    // colored text. Replace the hashes with a soft `▍` marker instead.
    return out.map((r) => {
      const sp = r.spans || [];
      const isHeading = sp.length >= 1 && /^#{1,6}\s*$/.test(sp[0].text || '') && sp.some((s) => s.bold);
      if (!isHeading) return r;
      const rest = sp.slice(1).filter((s) => (s.text ?? '') !== '');
      return { spans: [{ text: '▍ ', dim: true, color: rest[0]?.color }, ...rest] };
    });
  } catch {
    return [{ spans: [{ text }] }];
  }
}

// ─── Multiline input field with caret ─────────────────────────────────────────
// splitVisualLines gives visual lines (wrapped by width) but not the caret position.
// inputVisualRows finds the visual line + column the codepoint caret index falls into
// and returns rows: exactly one with `{ before, caret, after }`, the rest blank caret.
// Each row is already ≤ fieldW cells, so rendering as-is matches measurement.
export function inputVisualRows(input: string, cur: number, fieldW: number): { before: string; caret: string; after: string }[] {
  const lines = splitVisualLines(input || '', 'wrap', Math.max(1, fieldW)) as { text: string; lineNum: number | null }[];
  if (!lines.length) lines.push({ text: '', lineNum: null });
  // Codepoint-start of each visual line in the input. splitVisualLines splits by '\n'
  // and by width; segments of one physical paragraph are contiguous, and between
  // paragraphs (lineNum becomes non-zero) there was exactly one '\n'.
  let para = lines[0]?.lineNum ?? 1;
  let paraStart = 0;
  let paraLen = 0;
  const start: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ownPara = lines[i].lineNum;
    if (ownPara != null && ownPara !== para) {
      paraStart += paraLen + 1;
      para = ownPara;
      paraLen = 0;
    }
    start[i] = paraStart + paraLen;
    paraLen += lines[i].text.length;
  }
  let caretLi = lines.length - 1;
  let caretOff = Array.from(lines[lines.length - 1].text).length;
  for (let li = 0; li < lines.length; li++) {
    const s = start[li];
    const e = s + lines[li].text.length;
    const last = li === lines.length - 1;
    if (cur < e || (last && cur >= s)) {
      caretLi = li;
      caretOff = Math.max(0, Math.min(lines[li].text.length, cur - s));
      break;
    }
  }
  return lines.map((line, li) => {
    if (li !== caretLi) return { before: line.text, caret: '', after: '' };
    const chars = Array.from(line.text);
    const cg = chars[caretOff];
    return {
      before: chars.slice(0, caretOff).join(''),
      caret: cg !== undefined ? cg : ' ',
      after: chars.slice(caretOff + (cg !== undefined ? 1 : 0)).join(''),
    };
  });
}

// ─── Chat rows ─────────────────────────────────────────────────────────────────
// Flatten messages into one list of visual rows: a role label, markdown content
// lines, a reasoning/tool fold, a persistent tool-run trace, and gaps. The chat then
// scrolls line-by-line without pushing the input off-screen on a long answer.
function toolRunText(run: ToolRun, wrap: number): Span {
  const a = run.args && typeof run.args === 'object'
    ? Object.keys(run.args as Record<string, unknown>)
        .filter((k) => (run.args as Record<string, unknown>)[k] != null && (run.args as Record<string, unknown>)[k] !== '')
        .map((k) => {
          const v = (run.args as Record<string, unknown>)[k];
          // Array/list values (e.g. `todo`'s `todos`) must not String() to
          // "[object Object]" — render a readable count instead.
          if (Array.isArray(v)) {
            const n = v.length;
            return n === 1 ? '[1 item]' : `[${n} items]`;
          }
          if (typeof v === 'object') {
            try { return JSON.stringify(v).slice(0, 40); } catch { return '{…}'; }
          }
          return String(v);
        })
        .join(', ')
    : '';
  const info = [run.name, a ? `(${a})` : ''].filter(Boolean).join(' ');
  let text = `▸ ${info} → ${run.outcome}`;
  if ((run.outcome === 'error' || run.outcome === 'declined') && run.detail) {
    text += ` — ${String(run.detail).slice(0, 60)}`;
  }
  return { text: text.slice(0, Math.max(20, (wrap || 80) - 1)), dim: true };
}

function chatRows(messages: ChatMsg[], wrap: number, showReasoning: boolean): ChatRow[] {
  const rows: ChatRow[] = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    const role = m.role;
    // The system prompt (instructions + task context) is CONTEXT, not conversation —
    // it is not drawn in history (as a system prompt in Claude Code). It stays
    // role:'system' in the API; here it is just not rendered. See/replace via
    // /refresh-context.
    if (role === 'system') continue;
    const reasoning = String(m.reasoning ?? '').trim();
    const process = String(m.process ?? '').trim();
    const live = String(m.live ?? '').trim();
    const hasR = !!reasoning;
    const hasP = !!process;
    const hasL = !!live;
    if (role === 'assistant' && (hasR || hasP || hasL)) {
      const label = (hasR && hasP) ? 'reasoning + tools' : (hasR ? 'reasoning' : 'tool calls');
      rows.push({ role, reasonHeader: true, open: !!showReasoning, label });
      const bodyLines = mdLines([reasoning, process, live].filter(Boolean).join('\n\n'), wrap);
      const shown = showReasoning ? bodyLines : bodyLines.slice(-2);
      for (const line of shown) rows.push({ role, reason: true, spans: line.spans });
      rows.push({ gap: true });
    }
    rows.push({ role, label: true, duration: role === 'assistant' ? m.duration : undefined });
    const text = String(m.content ?? '');
    for (const line of mdLines(text, wrap)) rows.push({ role, spans: line.spans });
    const runs = Array.isArray(m.toolRuns) ? m.toolRuns : [];
    if (runs.length) {
      rows.push({ role, toolRunsHdr: true });
      for (const run of runs) rows.push({ role, toolRun: true, spans: [toolRunText(run as ToolRun, wrap)] });
    }
    if (mi < messages.length - 1) rows.push({ gap: true });
  }
  return rows;
}

// ─── Chat modal (pure render) ──────────────────────────────────────────────────
// The wide chat: nearly all the terminal width (with an inset from the frame), so
// markdown answers unroll to the width and wrap grows automatically. The message list
// anchors to the bottom (fresh answers always visible); `scroll > 0` lifts the window
// to earlier rows. Each message is a role label (You/Assistant/Context) + wrapped
// content. Palette: theme.modals.chat. The user's messages get a full-width background
// bubble (Text carries no background, so the role-user rows wrap in a full-width Box);
// if the last user question scrolls off, a dim sticky dump pins it at the top edge.
export function renderChatModal({
  width,
  height,
  theme,
  messages,
  input,
  streaming,
  error,
  scroll = 0,
  currentIssueId,
  toolLabel = '',
  showReasoning = false,
  cursor = 0,
  escArmed = false,
  pendingConfirm = null,
  elapsed = 0,
  emptyNotice = '',
  toolCount = 0,
  completions = null,
  bgCount = 0,
  todo = null,
}: {
  width: number;
  height: number;
  theme: Theme | undefined;
  messages: ChatMsg[];
  input: string;
  streaming: boolean;
  error?: string | null;
  scroll?: number;
  currentIssueId?: unknown;
  toolLabel?: string;
  showReasoning?: boolean;
  cursor?: number;
  escArmed?: boolean;
  pendingConfirm?: { name: string; args?: string | unknown } | null;
  elapsed?: number;
  emptyNotice?: string;
  toolCount?: number;
  completions?: Completions | null;
  bgCount?: number;
  todo?: PlanItem[] | null;
}) {
  const boxW = Math.min(width - 4, Math.max(90, Math.floor(width * 0.88)));
  const boxH = Math.min(Math.floor(height * 0.82), height - 4);
  const wrap = Math.max(20, boxW - 6);
  const m = (theme?.modals?.chat ?? {}) as Record<string, string | undefined>;
  // `bg` = a background-task result injected into the chat (postToChat) — it is NOT
  // the user's own message, so render it under a dim "Background" label (no bubble).
  const labelOf = (msg: ChatMsg) => (msg.role === 'user' ? 'You' : msg.role === 'system' ? 'Context' : msg.role === 'bg' ? 'Background' : 'Assistant');
  const colorOf = (msg: ChatMsg) => (msg.role === 'user' ? 'green' : msg.role === 'system' ? 'dim' : msg.role === 'bg' ? 'dim' : 'cyan');
  const errorH = error ? 1 : 0;
  const statusH = 1;
  const fieldW = Math.max(20, boxW - 4);
  const fieldRows = inputVisualRows(input, cursor, fieldW);
  const caretLi = Math.max(0, fieldRows.findIndex((r) => r.caret !== ''));
  const MAX_INPUT_LINES = 5;
  const visible = windowAround(fieldRows, caretLi, MAX_INPUT_LINES).items;
  const inputH = visible.length;
  // The todo plan block (above the message list): in-progress items first, then
  // pending, capped at MAX_VISIBLE_PLAN active rows; done items are counted, not
  // listed. `todoH` is its height — subtracted from `available` so the message
  // window's scroll budget still lines up w/ the visible area.
  const planList = (todo ?? []) as PlanItem[];
  // Rendered in STABLE insertion (id) order — never re-sorted by status. Reordering
  // keyed children makes React `insertBefore` a node that is already attached to the
  // same parent, and @flowtty/core's host `insertChild` aborts yoga (`Aborted()`).
  // The status is still visible via the checkbox glyph (☐/◐/☑), so sorting adds
  // nothing but the crash. Items only ever get appended or removed, never moved.
  const planActive = planList.filter((t) => t.status !== 'done');
  const planShown = planActive.slice(0, MAX_VISIBLE_PLAN);
  const planDone = planList.filter((t) => t.status === 'done').length;
  const planHidden = planActive.length - planShown.length;
  const planSummary = [
    planHidden > 0 ? `+${planHidden} pending` : '',
    planDone > 0 ? `· ${planDone} done` : '',
  ].filter(Boolean).join(' ');
  const todoH = planList.length ? planShown.length + (planSummary ? 1 : 0) + 1 : 0;
  // Real gap rows between the column's children (gap:1 between each pair). Each
  // OPTIONAL child (error, completion row, plan) adds one gap beyond its own height;
  // the 2 base gaps cover the always-present message-window↔status↔input links.
  // Before, the plan's gap was not counted, so `available` was one row too generous
  // and the newest message row slid under the plan block.
  const completionsH = completions && completions.matches.length ? 1 : 0;
  const gaps = (error ? 1 : 0) + completionsH + (planList.length ? 1 : 0) + 2;
  const available = Math.max(2, boxH - 2 - 2 - errorH - statusH - completionsH - inputH - todoH - gaps);
  const rows = chatRows(messages, wrap, showReasoning);
  const total = rows.length;
  let lastUserKey = -1;
  for (let i = 0; i < rows.length; i++) if (rows[i].role === 'user' && rows[i].label) lastUserKey = i;
  let lastUserText = '';
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    if (messages[mi]?.role === 'user') { lastUserText = String(messages[mi].content ?? '').trim(); break; }
  }
  const capacity = available;
  const baseMax = Math.max(0, total - capacity);
  const baseScr = Math.min(Math.max(0, scroll), baseMax);
  const baseStart = Math.max(0, total - capacity - baseScr);
  const pinned = lastUserKey >= 0 && (lastUserKey < baseStart || lastUserKey >= baseStart + capacity);
  const viewN = pinned ? capacity - 1 : capacity;
  const maxScroll = Math.max(0, total - viewN);
  const scr = Math.min(Math.max(0, scroll), maxScroll);
  const start = Math.max(0, total - viewN - scr);
  const win = rows.slice(start, start + viewN);
  const userBg = m.userBg;
  const userStyle = userBg ? { width: '100%', backgroundColor: userBg } : null;
  const confirmAsk = pendingConfirm
    ? {
        name: pendingConfirm.name,
        args: typeof pendingConfirm.args === 'string'
          ? (pendingConfirm.args.length > 120 ? `${pendingConfirm.args.slice(0, 120)}…` : pendingConfirm.args)
          : JSON.stringify(pendingConfirm.args ?? ''),
      }
    : null;

  return h(
    Box,
    {
      position: 'absolute',
      top: 0,
      left: 0,
      width,
      height,
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: undefined,
      zIndex: 10,
    },
    h(
      Box,
      {
        border: 'double',
        backgroundColor: m.bg,
        borderBackgroundColor: m.borderBg,
        borderColor: m.border,
        borderTitle: `Chat about ${currentIssueId ?? ''}`.replace(/\s+$/, ''),
        width: boxW,
        height: boxH,
        padding: 1,
        flexDirection: 'column',
        gap: 1,
        overflow: 'hidden',
      },
      h(Box, { flexGrow: 1, flexShrink: 1, flexDirection: 'column', overflow: 'hidden' },
        win.length
          ? null
          : h(Text, { dim: true }, 'Ask about this task — /compact compresses the history, /refresh-context shows the context.'),
        pinned
          ? h(Box, { key: 'chat-sticky', ...(userStyle || { backgroundColor: undefined, width: '100%' }) },
              h(Text, { dim: true }, `You: ${lastUserText.length > 40 ? `${lastUserText.slice(0, 40)}…` : lastUserText || '…'}`))
          : null,
        win.map((row, i) => {
          const key = `chat-${start + i}`;
          if (row.gap) return h(Box, { key, height: 1 });
          if (row.reasonHeader) return h(Text, { key, dim: true, color: 'magenta' }, row.open ? `▾ ${row.label}` : `▸ ${row.label} · ^r`);
          if (row.reason) return h(Box, { key, flexDirection: 'row' },
            (row.spans || []).map((s, j) => h(Text, { key: j, dim: true, bold: s.bold, underline: s.underline, color: s.color }, String(s.text ?? ''))));
          if (row.toolRunsHdr) return h(Text, { key, dim: true, color: 'magenta' }, '▾ tool calls');
          if (row.toolRun) return h(Box, { key, flexDirection: 'row' },
            (row.spans || []).map((s, j) => h(Text, { key: j, dim: true }, String(s.text ?? ''))));
          if (row.label) {
            const label = h(Text, { bold: true, color: colorOf(row as ChatMsg) }, labelOf(row as ChatMsg));
            if (row.role === 'assistant' && row.duration) {
              return h(Box, { key, flexDirection: 'row' }, label, h(Text, { dim: true }, ` · ${fmtSec(row.duration)}`));
            }
            return (row.role === 'user' && userStyle) ? h(Box, { key, ...userStyle }, label) : h(Text, { key, bold: true, color: colorOf(row as ChatMsg) }, labelOf(row as ChatMsg));
          }
          if (row.spans && row.spans.length) {
            const inner = row.spans.map((s, j) => h(Text, { key: j, bold: s.bold, dim: s.dim, underline: s.underline, color: s.color }, String(s.text ?? '')));
            return h(Box, { key, flexDirection: 'row', ...((row.role === 'user' && userStyle) ? userStyle : {}) }, inner);
          }
          return h(Box, { key, height: 1 });
        }),
      ),
      error ? h(Text, { color: 'red' }, `⚠ ${error}`) : null,
      h(Text, (emptyNotice && !streaming && !toolLabel && !escArmed) ? { color: 'yellow' } : { dim: true },
        escArmed
          ? 'Enter Esc again to exit'
          : (streaming || toolLabel)
            ? `${spin(elapsed)} ${fmtSec(elapsed)}${toolCount ? ` · ${toolCount} tool call${toolCount === 1 ? '' : 's'}` : ''}${toolLabel ? ` · ${toolLabel}` : ''}`
            : emptyNotice
              ? `⚠ ${emptyNotice}`
              : (`↑↓ scroll · ^r reasoning · /refresh-context · /compact · /clear${bgCount > 0 ? ` · ${bgCount} in background` : ''}`)),
      // Slash-command autocomplete (Task #20): the `/`-candidate row, highlighted at
      // `sel`. Tab cycles the highlight (handled in the plugin); a new prefix restarts.
      completions && completions.matches.length
        ? h(Box, { flexDirection: 'row', width: '100%', gap: 1 },
            completions.matches.map((cand, i) =>
              h(Text, { key: cand, ...(i === completions.sel ? { inverse: true } : { dim: true }) }, `/${cand}`)))
        : null,
      // The task plan sits ABOVE the input (not above the messages) — the newest
      // answer stays pinned just above it, so a growing plan never hides it. Its
      // height (todoH) is accounted for in `available`.
      planList.length
        ? h(Box, { key: 'plan', flexDirection: 'column', width: '100%', flexShrink: 0 },
            h(Text, { dim: true, color: 'magenta' }, '▾ plan'),
            planShown.map((t) =>
              h(Box, { key: `plan-${t.id}`, flexDirection: 'row' },
                h(Text, { color: t.status === 'in_progress' ? 'yellow' : undefined },
                  t.status === 'done' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'),
                h(Text, { dim: true }, ` ${t.id} · `),
                h(Text, { wrap: 'truncate', color: t.status === 'in_progress' ? 'yellow' : undefined }, t.text))),
            planSummary ? h(Text, { dim: true, color: 'yellow' }, planSummary) : null,
          )
        : null,
      // The input field group (the y/n confirm block or the multiline input box).
      h(Box, { flexDirection: 'column', width: '100%' },
        confirmAsk
          ? h(Box, { flexDirection: 'column', width: '100%', gap: 1, border: 'single', paddingX: 1, borderColor: 'yellow', backgroundColor: m.bg },
              h(Text, { bold: true, color: 'yellow' }, `⚠ Confirm write: ${confirmAsk.name}`),
              h(Text, { dim: true, wrap: 'truncate' }, confirmAsk.args),
              h(Text, { color: theme?.error }, 'Press y to confirm · n to decline · Esc to cancel'))
          : (streaming && !input)
            ? h(Text, { dim: true }, '…')
            : visible.map((row, i) => {
                if (row.caret === '') return h(Text, { key: i, wrap: 'truncate' }, row.before);
                const isEmpty = input === '';
                return h(Box, { key: i, flexDirection: 'row' },
                  row.before ? h(Text, { wrap: 'truncate' }, row.before) : null,
                  h(Text, { inverse: true }, row.caret),
                  isEmpty
                    ? h(Text, { wrap: 'truncate', dim: true }, 'Type a question · ⏎ send · /cmd · Esc Esc exit')
                    : row.after ? h(Text, { wrap: 'truncate', dim: true }, row.after) : null);
              }),
      ),
    ),
  );
}

// ─── Log modal (pure render) ───────────────────────────────────────────────────
export function renderLogModal({
  width,
  height,
  theme,
  logs,
  logModalRows,
  logScroll,
}: {
  width: number;
  height: number;
  theme: Theme | undefined;
  logs: string[];
  logModalRows: number;
  logScroll: number;
}) {
  const m = (theme?.modals?.log ?? {}) as Record<string, string | undefined>;
  const total = logs.length;
  const maxScroll = Math.max(0, total - logModalRows);
  const scroll = Math.min(logScroll, maxScroll);
  const start = Math.max(0, total - logModalRows - scroll);
  const visible = logs.slice(start, start + logModalRows);
  const title = total
    ? `Session log (${start + 1}–${start + visible.length} / ${total})`
    : 'Session log';
  return h(Box, {
    position: 'absolute',
    top: 0,
    left: 0,
    width,
    height,
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: undefined,
    zIndex: 10,
  },
    h(Box, {
      border: 'double',
      backgroundColor: m.bg,
      borderBackgroundColor: m.borderBg,
      borderColor: m.border,
      borderTitle: title,
      width: Math.floor(width * 0.7),
      height: Math.floor(height * 0.7),
      padding: 1,
      flexDirection: 'column',
      overflow: 'hidden',
    },
      visible.length
        ? visible.map((line, index) => h(Text, { key: start + index, wrap: 'truncate', color: m.text }, line))
        : h(Text, { color: m.text }, 'No actions yet'),
    ),
  );
}

// ─── Help modal (pure render) ──────────────────────────────────────────────────
export function renderHelp({
  width,
  height,
  theme,
  helpOpen,
  helpText,
}: {
  width: number;
  height: number;
  theme: Theme | undefined;
  helpOpen: boolean;
  helpText: string;
}) {
  if (!helpOpen) return null;
  const m = (theme?.modals ?? {}) as unknown as Record<string, string | undefined>;
  return h(Box, {
    position: 'absolute',
    top: 0,
    left: 0,
    width,
    height,
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: undefined,
    zIndex: 10,
  },
    h(Box, {
      border: 'double',
      backgroundColor: m.bg,
      borderBackgroundColor: m.borderBg,
      borderColor: m.border,
      borderTitle: 'Help — commands',
      width: Math.min(60, width - 8),
      padding: 1,
      flexDirection: 'column',
      gap: 1,
    },
      helpText.split('\n').map((line, i) => h(Text, { key: i, dim: true }, line)),
      h(Text, { dim: true }, 'Esc / Enter / q — close'),
    ),
  );
}

// ─── Reminder banner (pure render) ─────────────────────────────────────────────
// The `remind` tool's delivery: a centered, top-most banner instead of the bottom
// toast. `core.reminder` gates on `services.reminder` (null → not rendered) and
// calls this with the active text. It is a FLOATING panel (like keycaps), not a
// blocking modal — it only consumes Esc/Enter to dismiss, and sits above the
// modals/keycaps (zIndex 20 > 10). Palette: theme.modals (like the other modals).
export function renderReminder({
  width,
  height,
  theme,
  text,
}: {
  width: number;
  height: number;
  theme: Theme | undefined;
  text: string;
}) {
  const m = (theme?.modals ?? {}) as Record<string, string | undefined>;
  // Size to the text (with a small inset), clamped to the terminal; a short note
  // stays small, a long one wraps rather than growing off-screen.
  const w = Math.min(Math.max(40, [...text].length + 8), width - 8);
  return h(Box, {
    position: 'absolute',
    top: 0,
    left: 0,
    width,
    height,
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: undefined,
    zIndex: 20,
  },
    h(Box, {
      border: 'double',
      backgroundColor: m.bg,
      borderBackgroundColor: m.borderBg,
      borderColor: m.border,
      borderTitle: 'reminder',
      width: w,
      padding: 1,
      flexDirection: 'column',
      gap: 1,
    },
      h(Text, { wrap: 'wrap' }, text ?? ''),
      h(Text, { dim: true }, 'Esc / Enter — dismiss'),
    ),
  );
}