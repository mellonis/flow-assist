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

import { askRows, type AskRow, type AskState } from '../assistant/ask.js';
import { createElement as h, useEffect, useRef, useState } from 'react';
import {
  Box,
  ScrollBox,
  Text,
  layoutMarkdown,
  splitVisualLines,
  windowAround,
  type ScrollBoxHandle,
  type ScrollMetrics,
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
  // The first content row of a message: it carries the speaker's marker.
  first?: boolean;
  // The quiet line under an answer: how long it took and which tools ran.
  meta?: boolean;
  runs?: ToolRun[];
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

// ─── Markdown → styled lines ──────────────────────────────────────────────────
// flowtty's layoutMarkdown does the whole layout, GFM tables included; the host
// only softens the heading marker below.
export function mdLines(text: string | null | undefined, wrap: number): Line[] {
  if (!text) return [{ spans: [] }];
  try {
    const out = layoutMarkdown(text, wrap) as Line[];
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
    // The caret stays at the END of a line when a newline follows it (the next row
    // starts a new paragraph) — that is also what lets it stand on a blank line,
    // whose start equals its end. Only at a soft wrap does it open the next row.
    const newlineFollows = !last && start[li + 1] > e;
    if (cur < e || (cur === e && newlineFollows) || (last && cur >= s)) {
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

// Every content row is indented by a two-cell gutter: the speaker's marker sits in
// it on a message's first row (`› ` for the person, `◆ ` for a background result),
// so text lines up whoever is speaking and no role label is needed.
const GUTTER = 2;
// The assistant's mark: on its answers, and signing the chat's frame.
export const ASSISTANT_MARK = 'ƒ';
// The key the hints name for a newline. Alt+Enter is what a terminal really sends
// as a distinguishable key (ESC + CR → `return` with `meta`). Shift+Enter is NOT:
// without the kitty keyboard protocol most terminals send a bare CR for it, and
// when one does send CSI-u, flowtty's decoder (alpha.6) names it 'csi-u', not
// `return` + `shift`. The handler still accepts `shift`, for the day that lands.
export const NEWLINE_KEY = 'Alt+⏎';

// `todo ×2, memory` — the tools of a turn, in the order first used.
function toolSummary(runs: ToolRun[]): string {
  const count = new Map<string, number>();
  for (const r of runs) count.set(r.name, (count.get(r.name) ?? 0) + 1);
  return [...count].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
}

// The rows of ONE message. Laying markdown out is the expensive part of drawing the
// chat, and the whole conversation is handed to the scroll box on every frame — so
// the rows are remembered per message object. The chat replaces a message when it
// changes and never mutates one (see the `setMessages` updaters), which makes the
// object itself the right key: only the message that is streaming is laid out again.
const rowCache = new WeakMap<ChatMsg, Map<string, ChatRow[]>>();
function messageRows(m: ChatMsg, last: boolean, wrap: number, showReasoning: boolean): ChatRow[] {
  const key = `${wrap}:${showReasoning ? 1 : 0}:${last ? 1 : 0}`;
  let byKey = rowCache.get(m);
  if (!byKey) rowCache.set(m, (byKey = new Map()));
  let rows = byKey.get(key);
  if (!rows) byKey.set(key, (rows = buildMessageRows(m, last, wrap, showReasoning)));
  return rows;
}

function chatRows(messages: ChatMsg[], wrap: number, showReasoning: boolean): ChatRow[] {
  return messages.flatMap((m, mi) => messageRows(m, mi === messages.length - 1, wrap, showReasoning));
}

function buildMessageRows(m: ChatMsg, last: boolean, wrap: number, showReasoning: boolean): ChatRow[] {
  const rows: ChatRow[] = [];
  const inner = Math.max(10, wrap - GUTTER);
  {
    const role = m.role;
    // The system prompt (instructions + task context) is CONTEXT, not conversation —
    // it is not drawn in history (as a system prompt in Claude Code). It stays
    // role:'system' in the API; here it is just not rendered. See/replace via
    // /refresh-context.
    if (role === 'system') return rows;
    const reasoning = String(m.reasoning ?? '').trim();
    const process = String(m.process ?? '').trim();
    const live = String(m.live ?? '').trim();
    const hasR = !!reasoning;
    const hasP = !!process;
    const hasL = !!live;
    // Text streaming with no reasoning and no tool round behind it IS the answer
    // arriving: it is drawn as content, not folded under a "tool calls" header.
    const liveIsAnswer = hasL && !hasR && !hasP;
    if (role === 'assistant' && (hasR || hasP)) {
      // What the model said on the way: its thinking, and its notes between tool calls.
      const label = (hasR && hasP) ? 'thinking + notes' : (hasR ? 'thinking' : 'notes');
      rows.push({ role, reasonHeader: true, open: !!showReasoning, label });
      const bodyLines = mdLines([reasoning, process, live].filter(Boolean).join('\n\n'), inner);
      const shown = showReasoning ? bodyLines : bodyLines.slice(-2);
      for (const line of shown) rows.push({ role, reason: true, spans: line.spans });
      rows.push({ gap: true });
    }
    const text = String(m.content ?? '') || (liveIsAnswer ? live : '');
    mdLines(text, inner).forEach((line, li) => rows.push({ role, spans: line.spans, first: li === 0 }));
    const runs = (Array.isArray(m.toolRuns) ? m.toolRuns : []) as ToolRun[];
    const duration = role === 'assistant' && Number(m.duration) >= 1000 ? m.duration : undefined;
    // One quiet line under the answer; ^r unfolds the calls themselves.
    if (runs.length || duration) rows.push({ role, meta: true, duration, runs });
    if (runs.length && showReasoning) for (const run of runs) rows.push({ role, toolRun: true, spans: [toolRunText(run, inner)] });
    if (!last) rows.push({ gap: true });
  }
  return rows;
}

// ─── The conversation: a scroll box, anchored to its bottom ───────────────────
// flowtty's <ScrollBox> takes whatever height the column leaves and follows new
// rows until the person scrolls up; PgUp/PgDn and the wheel are its own. Before
// 1.0.0-alpha.7 this view added up the heights of everything around the messages
// (error, status, plan, queue, input field, question block, the gaps between them)
// to know how many rows fit, and sliced the list by hand — every block added to the
// chat was one more term to forget, and twice was.
// Below this many rows the conversation keeps every row for itself.
const MIN_ROWS_TO_PIN = 4;
function ChatMessages({ messages, wrap, showReasoning, palette: m, errorColor }: {
  messages: ChatMsg[];
  wrap: number;
  showReasoning: boolean;
  palette: Record<string, string | undefined>;
  errorColor?: string;
}) {
  const box = useRef<ScrollBoxHandle>(null);
  const [view, setView] = useState<{ top: number; height: number } | null>(null);
  const see = (x: ScrollMetrics) => setView((v) => (v && v.top === x.scrollTop && v.height === x.viewportHeight ? v : { top: x.scrollTop, height: x.viewportHeight }));
  // A message the person sends brings the view back to the bottom, wherever they had
  // scrolled to: they want to see the answer to what they just asked.
  const asked = messages.reduce((n, x) => n + (x.role === 'user' ? 1 : 0), 0);
  useEffect(() => { box.current?.scrollToEnd(); }, [asked]);

  const rows = chatRows(messages, wrap, showReasoning);
  let lastUserKey = -1;
  for (let i = 0; i < rows.length; i++) if (rows[i]!.role === 'user' && rows[i]!.first) lastUserKey = i;
  let lastUserText = '';
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    if (messages[mi]?.role === 'user') { lastUserText = String(messages[mi]!.content ?? '').trim(); break; }
  }
  // Every row is one terminal line, so a row's index is its line in the content. The
  // last question is pinned above the box while it is scrolled out of view. (Pinning
  // takes a row from the box, which only moves its top further down — so it cannot
  // flip back and forth.)
  // …and only while the conversation has rows to spare: on a short screen the pin
  // would take the one row the newest answer has. `room` is the box's height with the
  // pin's own row given back, so the decision does not depend on its own outcome.
  const wasPinned = useRef(false);
  const room = (view?.height ?? 0) + (wasPinned.current ? 1 : 0);
  const pinned = !!view && room >= MIN_ROWS_TO_PIN && lastUserKey >= 0 && (lastUserKey < view.top || lastUserKey >= view.top + view.height);
  wasPinned.current = pinned;

  // Who is speaking is said by a marker in the gutter and by the ground under the
  // message — not by a label. The person's marker is the input field's own prompt.
  const groundOf = (role?: string) => (role === 'user' ? m.userBg : role === 'bg' ? m.bgBg : undefined);
  const gutter = (row: ChatRow) => {
    if (row.first && row.role === 'user') return h(Text, { bold: true, color: m.accent }, '› ');
    if (row.first && row.role === 'bg') return h(Text, { bold: true, color: m.bgAccent }, '◆ ');
    // ƒ — F for Flow, and a function. A narrow code point every monospace font has;
    // ∮ reads well as "a loop" but is East-Asian-ambiguous width, and flowtty counts
    // one cell per code point, so it would shift the row in some terminals.
    if (row.first && row.role === 'assistant') return h(Text, { bold: true, color: m.assistantAccent }, `${ASSISTANT_MARK} `);
    return h(Text, null, ' '.repeat(GUTTER));
  };

  // The pinned question is a row of its own, not an overlay on the scroll box: in
  // flowtty 1.0.0-alpha.7 an absolute child of a <ScrollBox> is not drawn when any
  // ancestor has padding (this modal does).
  const sticky = pinned
    ? h(Box, { key: 'chat-sticky', flexDirection: 'row', flexShrink: 0, width: '100%', backgroundColor: m.userBg },
        h(Text, { bold: true, dim: true, color: m.accent }, '› '),
        h(Text, { dim: true, wrap: 'truncate' }, lastUserText.length > 60 ? `${lastUserText.slice(0, 60)}…` : lastUserText || '…'))
    : null;
  return h(Box, { flexGrow: 1, flexShrink: 1, flexDirection: 'column' }, sticky, h(ScrollBox, { ref: box, anchor: 'bottom', flexGrow: 1, flexShrink: 1, flexDirection: 'column', onScroll: (_o: number, x: ScrollMetrics) => see(x), onMetrics: see },
    rows.length
      ? null
      : h(Text, { dim: true }, `Ask anything. ⏎ sends, ${NEWLINE_KEY} starts a new line, / opens the commands.`),
    rows.map((row, i) => {
      const key = `chat-${i}`;
      if (row.gap) return h(Box, { key, height: 1, flexShrink: 0 });
      if (row.reasonHeader) return h(Text, { key, dim: true, color: 'magenta' }, `${' '.repeat(GUTTER)}${row.open ? '▾' : '▸'} ${row.label}`);
      if (row.reason) return h(Box, { key, flexDirection: 'row', flexShrink: 0 },
        h(Text, null, ' '.repeat(GUTTER)),
        (row.spans || []).map((s, j) => h(Text, { key: j, dim: true, bold: s.bold, underline: s.underline, color: s.color }, String(s.text ?? ''))));
      if (row.toolRun) return h(Box, { key, flexDirection: 'row', flexShrink: 0 },
        h(Text, null, ' '.repeat(GUTTER)),
        (row.spans || []).map((s, j) => h(Text, { key: j, dim: true }, String(s.text ?? ''))));
      if (row.meta) {
        const runs = row.runs ?? [];
        const wrote = runs.some((r) => r.outcome === 'applied');
        const failed = runs.some((r) => r.outcome === 'error' || r.outcome === 'declined');
        return h(Box, { key, flexDirection: 'row', flexShrink: 0 },
          h(Text, null, ' '.repeat(GUTTER)),
          row.duration ? h(Text, { dim: true }, `${fmtSec(row.duration)}${runs.length ? ' · ' : ''}`) : null,
          runs.length ? h(Text, { dim: !failed, color: failed ? errorColor : wrote ? m.warn : m.ok }, `${showReasoning ? '▾' : '▸'} ${runs.length} tool${runs.length === 1 ? '' : 's'}${wrote ? ' ✎' : ''}: `) : null,
          runs.length ? h(Text, { dim: true }, `${toolSummary(runs)}${showReasoning ? '' : ' · ^r'}`) : null);
      }
      const ground = groundOf(row.role);
      const groundStyle = ground ? { width: '100%', backgroundColor: ground } : {};
      if (row.spans && row.spans.length) {
        const inner = row.spans.map((s, j) => h(Text, { key: j, bold: s.bold, dim: s.dim, underline: s.underline, color: s.color }, String(s.text ?? '')));
        return h(Box, { key, flexDirection: 'row', flexShrink: 0, ...groundStyle }, gutter(row), inner);
      }
      // A blank line inside a message keeps the message's ground.
      return h(Box, { key, height: 1, flexShrink: 0, ...groundStyle });
    }),
  ));
}

// ─── Chat modal (pure render) ──────────────────────────────────────────────────
// The wide chat: nearly all the terminal width (with an inset from the frame), so
// markdown answers unroll to the width. The conversation is <ChatMessages> above — a
// scroll box that takes the rows the rest of the column leaves; under it sit the
// error, the status line, the plan, the queue line and the field (or the question /
// y-n block that replaces it). Palette: theme.modals.chat.
export function renderChatModal({
  width,
  height,
  theme,
  messages,
  input,
  streaming,
  error,
  currentIssueId,
  toolLabel = '',
  showReasoning = false,
  cursor = 0,
  escArmed = false,
  pendingConfirm = null,
  pendingQuestion = null,
  queued = [],
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
  currentIssueId?: unknown;
  toolLabel?: string;
  showReasoning?: boolean;
  cursor?: number;
  escArmed?: boolean;
  pendingConfirm?: { name: string; args?: string | unknown } | null;
  pendingQuestion?: AskState | null;
  // Messages sent while an answer was coming; they go out, in order, when the turn ends.
  queued?: string[];
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
  const fieldW = Math.max(20, boxW - 4 - GUTTER); // the prompt lives in the gutter
  const fieldRows = inputVisualRows(input, cursor, fieldW);
  const caretLi = Math.max(0, fieldRows.findIndex((r) => r.caret !== ''));
  const MAX_INPUT_LINES = 5;
  const visible = windowAround(fieldRows, caretLi, MAX_INPUT_LINES).items;
  // No heights are added up here: the conversation is a scroll box that takes what
  // the column leaves, so the plan, the queue line, the field and the question block
  // (each `flexShrink: 0`) simply take their own rows.
  // The todo plan block: in-progress items first, then pending, capped at
  // MAX_VISIBLE_PLAN active rows; done items are counted, not listed.
  // An open question takes the plan's room: the person is answering, not planning.
  const planList = (pendingQuestion ? [] : (todo ?? [])) as PlanItem[];
  // What is in progress comes first, then what is pending, each in insertion order
  // (the sort is stable): the cap below cuts from the END, so the items being worked
  // on are the last to fall off the screen. Needs flowtty ≥ 1.0.0-alpha.5 — before
  // it, re-ordering keyed children aborted Yoga and the plan was pinned to insertion
  // order.
  const planActive = planList
    .filter((t) => t.status !== 'done')
    .sort((a, b) => Number(b.status === 'in_progress') - Number(a.status === 'in_progress'));
  const planShown = planActive.slice(0, MAX_VISIBLE_PLAN);
  const planDone = planList.filter((t) => t.status === 'done').length;
  const planHidden = planActive.length - planShown.length;
  const planSummary = [
    planHidden > 0 ? `+${planHidden} pending` : '',
    planDone > 0 ? `· ${planDone} done` : '',
  ].filter(Boolean).join(' ');
  // Inline completion: the part of the suggested command not typed yet, drawn
  // right after the caret, and the other candidates named beside it. Only while the
  // caret is at the end of a one-line `/command` — there is nothing to continue
  // from the middle of a word.
  const suggestion = completions?.matches[completions.sel] ?? '';
  const atEnd = cursor >= Array.from(input).length;
  const ghost = suggestion && atEnd && !input.includes('\n') ? suggestion.slice(input.length - 1) : '';
  const others = completions && atEnd ? completions.matches.filter((_, i) => i !== completions.sel) : [];
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
        border: 'round',
        backgroundColor: m.bg,
        borderBackgroundColor: m.borderBg,
        borderColor: m.border,
        borderTitle: currentIssueId ? `${ASSISTANT_MARK} Flow Assist · ${currentIssueId}` : `${ASSISTANT_MARK} Flow Assist`,
        width: boxW,
        height: boxH,
        padding: 1,
        flexDirection: 'column',
        gap: 1,
        overflow: 'hidden',
      },
      h(ChatMessages, { messages, wrap, showReasoning, palette: m, errorColor: theme?.error }),
      error ? h(Text, { color: 'red' }, `⚠ ${error}`) : null,
      h(Text, (emptyNotice && !streaming && !toolLabel && !escArmed) ? { color: 'yellow' } : { dim: true },
        escArmed
          ? 'Enter Esc again to exit'
          : (streaming || toolLabel)
            ? `${spin(elapsed)} ${fmtSec(elapsed)}${toolCount ? ` · ${toolCount} tool call${toolCount === 1 ? '' : 's'}` : ''}${toolLabel ? ` · ${toolLabel}` : ''} · Esc stops`
            : emptyNotice
              ? `⚠ ${emptyNotice}`
              : (`↑↓ history · wheel or PgUp/PgDn scroll · ^r details · / commands${bgCount > 0 ? ` · ${bgCount} in background` : ''}`)),
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
      queued.length
        ? h(Box, { flexDirection: 'row', width: '100%' },
            h(Text, { bold: true, color: m.warn }, `⏎ queued${queued.length > 1 ? ` (${queued.length})` : ''}: `),
            h(Text, { wrap: 'truncate', color: m.warn }, `${queued[0]!.replace(/\s+/g, ' ').slice(0, Math.max(10, wrap - 40))}${queued.length > 1 ? ' …' : ''}`),
            h(Text, { dim: true }, ' · Esc takes it back'))
        : null,
      // The input field group (the y/n confirm block or the multiline input box).
      h(Box, { flexDirection: 'column', width: '100%' },
        pendingQuestion
          ? renderAsk(pendingQuestion, m.bg, wrap)
          : confirmAsk
          ? h(Box, { flexDirection: 'column', width: '100%', gap: 1, border: 'round', paddingX: 1, borderColor: 'yellow', backgroundColor: m.bg },
              h(Text, { bold: true, color: 'yellow' }, `⚠ Confirm write: ${confirmAsk.name}`),
              h(Text, { dim: true, wrap: 'truncate' }, confirmAsk.args),
              h(Text, { color: theme?.error }, 'Press y to confirm · n to decline · Esc to cancel'))
          : h(Box, { flexDirection: 'column', width: '100%', backgroundColor: m.fieldBg },
              visible.map((row, i) => {
                // The prompt marks the field's first line; it dims while an answer is
                // coming, when ⏎ queues instead of sending.
                const prompt = h(Text, { bold: !streaming, dim: streaming, color: m.accent }, visible[i] === fieldRows[0] ? '› ' : ' '.repeat(GUTTER));
                // A blank line is a real '' — flowtty ≥ 1.0.0-alpha.5 gives an empty Text
                // its row (it used to collapse, which is how "two newlines" vanished).
                if (row.caret === '') return h(Box, { key: i, flexDirection: 'row' }, prompt, h(Text, { wrap: 'truncate' }, row.before));
                // The caret sits ON the first suggested character, as a shell's
                // autosuggestion does, so what was typed and what is offered read as one
                // word: `/co` + `mpact`. The offer is the accent colour, dimmed; the
                // other candidates follow, and ⇥ says which key takes them.
                const offer = ghost
                  ? [h(Text, { key: 'g0', inverse: true, dim: true, color: m.accent }, ghost[0]),
                     h(Text, { key: 'g1', dim: true, color: m.accent }, ghost.slice(1))]
                  : [h(Text, { key: 'c', inverse: true }, row.caret)];
                return h(Box, { key: i, flexDirection: 'row' },
                  prompt,
                  row.before ? h(Text, { wrap: 'truncate' }, row.before) : null,
                  ...offer,
                  others.length ? h(Text, { wrap: 'truncate', dim: true }, `  ⇥ ${others.join(' · ')}`) : null,
                  input === ''
                    ? h(Text, { wrap: 'truncate', dim: true }, streaming ? ' an answer is coming — ⏎ queues your next message' : ` ⏎ send · ${NEWLINE_KEY} new line · Esc Esc close`)
                    // Text after the caret is the person's own text — drawn like the rest
                    // of it. It used to take the placeholder's dim and went grey whenever
                    // the caret moved back.
                    : row.after ? h(Text, { wrap: 'truncate' }, row.after) : null);
              })),
      ),
    ),
  );
}

function renderAsk(state: AskState, bg: string | undefined, wrap: number) {
  const q = state.questions[state.index]!;
  const many = state.questions.length > 1 ? `${state.index + 1}/${state.questions.length} · ` : '';
  const rows = askRows(state);
  const mark = (r: AskRow) => (q.multiSelect && !r.other ? (r.picked ? '[x]' : '[ ]') : r.active ? ' ❯ ' : '   ');
  const hint = state.typing
    ? '⏎ submit · Esc back to the list'
    : q.multiSelect
      ? '↑↓ move · Space toggle · ⏎ confirm · Esc dismiss'
      : '↑↓ move · ⏎ or a digit to answer · Esc dismiss';
  return h(Box, { flexDirection: 'column', width: '100%', border: 'round', paddingX: 1, borderColor: 'cyan', backgroundColor: bg },
    h(Text, { bold: true, color: 'cyan', wrap: 'wrap' }, `? ${many}${q.header ? `${q.header} — ` : ''}${q.question}`),
    ...rows.map((r, i) => h(Box, { key: i, flexDirection: 'column' },
      h(Text, { bold: r.active, inverse: r.active && !state.typing, wrap: 'truncate' }, `${mark(r)} ${i + 1}. ${r.label}`),
      r.description ? h(Text, { dim: true, wrap: 'truncate' }, `       ${r.description.slice(0, Math.max(10, wrap - 8))}`) : null)),
    state.typing
      ? h(Box, { flexDirection: 'row' }, h(Text, null, '     › '), h(Text, { wrap: 'truncate' }, state.text), h(Text, { inverse: true }, ' '))
      : null,
    h(Text, { dim: true }, hint));
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