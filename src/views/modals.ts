// Built-in modal renderers: chat, help, log — the host's own. A plugin's modals
// (a tracker's relation, tags, filters…) are the plugin's.
//
// Each renderer is a PURE function `(props) => ReactElement` — the owning plugin
// modal (assistant.chat / core.help / log.log) computes state and passes it here as
// props, so nothing reads or sets state from the render side. The file is written as
// `.ts` with explicit `h()` (createElement) calls — `tsconfig.json` includes `*.ts`
// only, so a `.tsx` view would silently bypass `bun run typecheck`.
//
//   - The chat's title names what the person's screens show — the labels of the
//     plugins' `chatContext` items (`services.chatContext`) — when there are any.
//   - `renderChatModal` accepts `completions { matches, sel }` and completes a
//     `/`-command inside the field.
//   - `theme` may be undefined / lack a resolved `modals` map, so every
//     `theme.modals.<name>.<prop>` read is guarded (`m = theme?.modals?.chat ?? {}`).

import { askRows, type AskRow, type AskState } from '../assistant/ask.js';
import { autoBadge, type AutoMode } from '../assistant/auto.js';
import { VERBS } from '../assistant/verbs.js';
import { answerText, cellWidth, cutStep, readParts, runMarks, runRowText, shownText, turnSegments, type NotesMode } from '../assistant/step.js';
import { isClicked, isOpen, foldId, type FoldState } from '../assistant/folds.js';
import { imageTokenRanges, splitTokens } from '../assistant/images.js';
import { markText, type ImageMark } from '../assistant/tool-images.js';
import { changeCounts, changeMarkdown, diffRows, type ChangeView } from '../assistant/diff.js';
import { VIEW_CAPS, frameView, isConsoleKind, type ViewRecord, type ViewRenderers } from '../assistant/views.js';
import { groupHeadText, groupOpen, viewGroups, type GroupMsg, type ViewGroup } from '../assistant/view-groups.js';
import { renderConsole } from '../assistant/console-view.js';
import { CELL_FREE, CELL_FULL, CONTEXT_WARN_AT, GRID_COLS, GRID_ROWS, contextFootnote, contextGrid, contextHeading, contextLegend, tokensBadge, type ContextReading, type GridCell } from '../assistant/context-meter.js';
import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react';
import { wrapText } from '@flowtty/core';
import { bindingGlyph, keyGlyph } from '../playback/keys.js';
import {
  Box,
  ScrollBox,
  ScrollList,
  Shimmer,
  Text,
  layoutMarkdown,
  layoutMarkdownDetailed,
  caretPosition,
  inputRows,
  stringWidth,
  windowAround,
  type ScrollBoxHandle,
  type ScrollMetrics,
  type WrapContinuation,
} from '@flowtty/react';

// ─── Shapes ────────────────────────────────────────────────────────────────────
// The chat message the assistant plugin hands over (role + optional fields).
interface ChatMsg {
  role: string;
  content?: string | null;
  // The round being written now, before anyone knows whether it is the answer.
  live?: string;
  // The round being written carries a tool call: it is a step, not the answer.
  liveQuiet?: boolean;
  // What happened before it, in order: the steps (the text of each round that went
  // on to call a tool) and the changes the writes reported (src/assistant/step.ts).
  parts?: unknown;
  reasoning?: string;
  // The turn ran out of rounds after this many, with no answer.
  roundLimit?: number;
  duration?: number;
  stopped?: boolean;
  // The cap of the key that stopped the turn when it was not Esc (`^c`). A session
  // saved before it has none and reads `stopped (Esc)`, as it did.
  stoppedBy?: string;
  // The blocks a tool asked the host to draw (role 'view'): a command's output.
  views?: ViewRecord[];
  [k: string]: unknown;
}
// One executed tool in a turn, for the persistent `▸ name (args) → outcome` trace.
interface ToolRun {
  name: string;
  args?: unknown;
  outcome: string;
  detail?: string;
  // The images the call returned, drawn as one row each under its line (`▣ shot.png
  // · 400×300`) — the mark, never the image (src/assistant/tool-images.ts).
  images?: ImageMark[];
}
// The assistant's task plan (the `todo` core tool). Rendered as a fixed checkbox
// block above the chat: active items (in-progress ◐ first, then pending ☐), up to
// MAX_VISIBLE, with done items condensed to a "+N pending · M done" count. Purely
// presentational — the render never mutates it (the plugin hands over a snapshot
// of its own plan, `planRef.current.snapshot()`).
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
// A laid-out row as flowtty's `layoutMarkdown` gives it. Besides the spans it says
// what a drag-selection needs (flowtty ≥ 1.0.0-alpha.15): `continues` — the row's text
// carries on in the row below (a soft wrap), so a copy rejoins them into the line that
// was written; `chrome` — how many leading spans are frame (a code block's `│ `, a
// quote's bar), painted but never copied; `frame` — the whole row is frame (a fence
// label).
interface Line {
  spans: Span[];
  continues?: WrapContinuation;
  chrome?: number;
  frame?: true;
}
// Where the conversation is on the terminal and how far it is scrolled: the cells a
// mouse key is reported in, so a click can be turned into the row under it. `pinned`
// says the last question is painted over the top row, which a click must not read as
// the row beneath it.
export interface Viewport {
  top: number;
  height: number;
  left: number;
  width: number;
  scrollTop: number;
  pinned: boolean;
  // The list is resting at the END of the conversation, following it as it grows.
  // Rows a fold adds are then all above the reader, and staying at the bottom IS
  // keeping their place — nothing must scroll.
  atEnd: boolean;
}

// A flattened chat row (one visual line / a label / a fold header / a gap).
interface ChatRow {
  role?: string;
  // The foldable block this row belongs to (src/assistant/folds.ts), when a click on
  // it acts: the fold line of a folded block opens it, and any row of an OPEN block
  // closes it. A row without one is not clickable — a plain answer, the person's own
  // message, the chrome.
  fold?: string;
  // The turn ended because the loop ran out of rounds. It stands where the answer
  // would be, in the warn colour: a wall of grey tool lines with nothing under it
  // said nothing about why.
  limit?: boolean;
  // The `✎ path · +N −M` line over a change. Not markdown: the path is drawn in the
  // chat's accent and the counts dim, which is what a title looks like.
  changeTitle?: boolean;
  // A row the model wrote on the way (a step, or a round not yet known to be the
  // answer): drawn where it happened, dim.
  quiet?: boolean;
  // The first row of the round being written: a live mark in the gutter, never the
  // answer's `ƒ`.
  liveMark?: boolean;
  // `label` is overloaded in the source: `true` marks the role-label row, or a
  // string is the reason/fold-header text (`reasoning`, `reasoning + tools`).
  label?: boolean | string;
  // The first content row of a message: it carries the speaker's marker.
  first?: boolean;
  // A view that is not a command draws no `$`.
  plainGutter?: boolean;
  // The quiet line under an answer: how long it took, which tools ran, what it cost.
  meta?: boolean;
  runs?: ToolRun[];
  duration?: number;
  tokens?: number;
  stopped?: boolean;
  stoppedBy?: string;
  reasonHeader?: boolean;
  open?: boolean;
  reason?: boolean;
  // The one dim row a folded run of steps is: its newest step and how many there
  // are. Chrome: never copied by a drag, and cut to one row rather than wrapped.
  step?: boolean;
  // A group's head: the `ƒ` in the gutter, chrome like a folded run's row.
  groupHead?: boolean;
  toolRunsHdr?: boolean;
  toolRun?: boolean;
  spans?: Span[];
  gap?: boolean;
  // What a drag-selection needs of a content row — see `Line`.
  continues?: WrapContinuation;
  chrome?: number;
  frame?: true;
}
// The slash-command autocomplete state the assistant plugin computes.
// What the field's completion draws (`lineView` in src/config/commandline.ts): the
// untyped rest of the offer after the caret, what its label says, the other candidates.
interface Completion {
  ghost: string;
  label?: string;
  others: string[];
}

// `text` cut to `max` cells from the LEFT, an ellipsis marking the cut — for a path,
// whose tail is the part that says where one is.
export function cutFromLeft(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `…${chars.slice(chars.length - Math.max(0, max - 1)).join('')}`;
}
// The theme config subtree (`host.config.theme`) — a free-form object. Only `modals`
// (the per-surface palette) and a few flat keys are read. Typed loosely so a missing/
// deep-absent key degrades to Flowtty defaults instead of throwing on `undefined`.
interface Theme {
  // `modals` holds BOTH flat shared palette keys (bg/border/borderBg, read by
  // renderHelp directly) and nested surface palettes (`.chat`, `.log`).
  modals?: Record<string, unknown>;
  error?: string;
  [k: string]: unknown;
}

// The full-screen layer every host modal is centred on. It paints nothing of its
// own; `backdrop: 'dim'` (flowtty ≥ 1.0.0-alpha.11) restyles the cells ALREADY
// painted under it — characters and colours stay, the screen behind the modal steps
// back. Dim is a flag on a cell, not an opacity, so a modal over a modal (a reminder
// over the chat) never darkens anything twice.
const overlay = (width: number, height: number, zIndex = 10) => ({
  position: 'absolute' as const,
  top: 0,
  left: 0,
  width,
  height,
  flexDirection: 'column' as const,
  justifyContent: 'center' as const,
  alignItems: 'center' as const,
  backdrop: 'dim' as const,
  zIndex,
});

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const spin = (ms: number) => SPINNER[Math.floor(ms / 120) % SPINNER.length];
// A band of light travels along the running tool's label — movement says "still
// working" where a static label reads as "stuck". The whole label changing colour
// four times a second would read as blinking; the band moves instead,
// and the label keeps one colour. The gradient is the chat's own accents, brightest at
// the band's leading edge; the window's own ink stands in for white, which vanished on
// a light ground.
const TOOL_PULSE = (m: Record<string, string | undefined>) => [m.text ?? 'white', 'cyanBright', m.accent ?? 'cyan'];
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
      // The marker is decoration — out of a copy (`chrome`), where `##` would have been
      // copied. It is narrower than the hashes, so the row's `textWidth` now overshoots
      // its text by a cell or two; that is harmless, because the chat draws a row's
      // text in a box exactly as wide as the spans, and flowtty keeps the join inside
      // the box (a wrapped heading's copy is tested).
      return { ...r, spans: [{ text: '▍ ', dim: true, color: rest[0]?.color }, ...rest], chrome: 1 };
    });
  } catch {
    return [{ spans: [{ text }] }];
  }
}

// ─── A block the HOST built: the fence is ours, so its label row is noise ──────
// flowtty draws a dim language label over every fenced block. Over a block the host
// wrote itself that row says nothing: `diff` sits under a line that already says this
// is a change to a file, `console` under the `$ command` line that says it better. The
// language stays ON the fence — it is what colours a diff green and red — and the row
// it produces is left out here, where the host's own markdown is laid out.
//
// `src` says, per row, which line of the fenced block it came from (−1 for a row that
// is not code at all): a long line is hard-wrapped into several rows, and both the
// line numbers of a diff and the click target of a folded console block have to know
// where one source line ends and the next begins.
function blockLines(md: string, width: number): { lines: Line[]; src: number[] } {
  let laid: { lines: Line[]; codeBlocks: { startLine: number; endLine: number }[] };
  try {
    laid = layoutMarkdownDetailed(md, Math.max(1, width)) as unknown as typeof laid;
  } catch {
    return { lines: [{ spans: [{ text: md }] }], src: [-1] };
  }
  const block = laid.codeBlocks[0];
  const lines: Line[] = [];
  const src: number[] = [];
  let at = 0;
  laid.lines.forEach((line, i) => {
    if (!block || i < block.startLine || i >= block.endLine) { lines.push(line); src.push(-1); return; }
    if (i === block.startLine) return; // the label row: ours, and not worth a row
    lines.push(line);
    src.push(at);
    // A row that says its text carries on below is the same source line as the next.
    if (!line.continues) at++;
  });
  return { lines, src };
}

// A one-row title, cut from the LEFT when it does not fit: the end of a path is what
// names the file, and the beginning of a long one is the part nobody reads.
function cutHead(text: string, width: number): string {
  const chars = Array.from(text);
  if (width <= 0) return '';
  if (chars.length <= width) return text;
  return width === 1 ? '…' : `…${chars.slice(chars.length - width + 1).join('')}`;
}

// One change, as the chat draws it: a title of its own — plain text, the path in the
// accent colour — over the hunks in a ```diff fence carrying the FILE's line numbers.
// The numbers are chrome: dim, right-aligned in a narrow gutter before the `│ `, and
// out of a selection, so a drag copies the code alone.
function changeLines(v: ChangeView, inner: number): Line[] {
  const title: Line = {
    spans: [{ text: '✎ ' }, { text: cutHead(v.title, Math.max(8, inner - changeCounts(v).length - 3)), accent: true }, { text: ` ${changeCounts(v)}`, dim: true }],
  };
  const md = changeMarkdown(v);
  if (!md) return [title];
  const rows = diffRows(v.diff);
  const width = Math.max(1, ...rows.map((r) => r.no.length));
  const { lines, src } = blockLines(md, inner - width - 1);
  const numbered = lines.map((line, i) => {
    const at = src[i] ?? -1;
    // Only the row a source line STARTS on takes its number; a wrapped continuation
    // keeps the gutter's width and nothing in it.
    const first = at >= 0 && (i === 0 || (src[i - 1] ?? -1) !== at);
    const no = first ? (rows[at]?.no ?? '') : '';
    if (at < 0) return line;
    return { ...line, spans: [{ text: `${no.padStart(width)} `, dim: true }, ...line.spans], chrome: (line.chrome ?? 0) + 1 };
  });
  return [title, ...numbered];
}

// ─── The trail of tool calls ──────────────────────────────────────────────────
// One line per call earns nothing once there are more than a handful: a turn that ran
// to the round limit printed dozens of them and the screen was a sheet of grey. So
// consecutive calls of the same tool that ENDED the same way are one line with a count
// — a different argument is not a different line, the arguments are in the log. A call
// that failed keeps a line of its own with its reason: that is how a person knows why
// an answer is thin, and it is the one thing the grey was hiding.
// A call that returned images keeps a line of its own too: its marks are what the
// person looks for, and a count would hide them.
export function condenseRuns(runs: readonly ToolRun[]): { run: ToolRun; n: number }[] {
  const out: { run: ToolRun; n: number }[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && last.run.name === run.name && last.run.outcome === run.outcome && !run.images?.length && !last.run.images?.length) last.n++;
    else out.push({ run, n: 1 });
  }
  return out;
}

// The rows under a call's line, one per image it returned: dim, indented under the
// `▸`, and one terminal row like every other.
function imageMarkRows(run: ToolRun, wrap: number): Span[] {
  return (run.images ?? []).map((m) => ({ text: cutStep(`  ${markText(m)}`, Math.max(20, (wrap || 80) - 1)), dim: true }));
}
// How many lines of an open trail stand before the rest fold into `… N earlier calls`.
export const TRAIL_ROWS = 12;

// ─── The person's own text, as typed ───────────────────────────────────────────
// What the person wrote is not markdown written for rendering: in markdown a single
// line break is a soft one, so two typed lines were drawn as one, an indented command
// lost its indent and `- a` became a bullet. It is laid out as the field laid it out
// while they typed (`inputRows`): every line break kept, blank lines and leading
// spaces too, a line wider than the chat cut at the column. A cut drops nothing, so
// the row before it carries `continues` with `dropped: ''` — a drag rejoins the line
// exactly — while a line break the person typed is left a line break in the copy.
//
// `images` — the numbers of the images the message carried: their `[Image #N]` tokens
// are spans of their own marked `token`, which the view draws in the accent colour.
// They are the person's text all the same, and copy as written.
export function typedLines(text: string | null | undefined, wrap: number, images: readonly number[] = []): Line[] {
  const value = String(text ?? '');
  const rows = inputRows(value, Math.max(1, wrap));
  const tokens = images.length ? imageTokenRanges(value, (n) => images.includes(n)) : [];
  return rows.map((row, i) => {
    const line: Line = { spans: row.text ? splitTokens(row.text, row.start, tokens).map((p) => (p.token ? { text: p.text, token: true } : { text: p.text })) : [] };
    if (rows[i + 1]?.continuation) line.continues = { dropped: '', textWidth: stringWidth(row.text) };
    return line;
  });
}

// ─── Multiline input field with caret ─────────────────────────────────────────
// The field's visual rows, exactly one of them carrying the caret as
// `{ before, caret, after }`. The geometry is flowtty's (`inputRows` +
// `caretPosition`, ≥ 1.0.0-alpha.8) — the same functions its editor reducer moves
// the caret with, so what up/down do and what is drawn cannot drift apart. `cur` is a
// UTF-16 index into `input` resting on a grapheme-cluster boundary; the column is
// counted in display width, the grid's unit, so the caret cell holds a whole emoji
// and a wide one takes two columns.
export const CHAT_FIELD_MIN = 20;
// The field's width for a terminal `width` columns wide — shared with the key
// handler, which needs it for up/down across wrapped rows. `fullscreen` (`/fullscreen`,
// config.plugins.assistant.fullscreen): the window is the whole terminal, no margins.
export function chatBoxWidth(width: number, fullscreen = false): number {
  return fullscreen ? width : Math.min(width - 4, Math.max(90, Math.floor(width * 0.88)));
}
export function chatFieldWidth(width: number, fullscreen = false): number {
  return Math.max(CHAT_FIELD_MIN, chatBoxWidth(width, fullscreen) - 4 - GUTTER);
}
// The width everything inside the window is laid out in — the conversation's rows and
// the blocks that take the field's place (the question, `/context`). Shared with the
// key handler, which needs it for the question's own field.
export function chatWrapWidth(width: number, fullscreen = false): number {
  return Math.max(20, chatBoxWidth(width, fullscreen) - 6);
}
// `start` — where the row begins in `input`, so a piece of it can be matched against
// ranges of the whole value (the image tokens).
export function inputVisualRows(input: string, cur: number, fieldW: number): { before: string; caret: string; after: string; start: number }[] {
  const w = Math.max(1, fieldW);
  const rows = inputRows(input || '', w, cur);
  const at = caretPosition(input || '', cur, w);
  return rows.map((r, i) => {
    if (i !== at.row) return { before: r.text, caret: '', after: '', start: r.start };
    const chars = Array.from(r.text);
    return { before: chars.slice(0, at.col).join(''), caret: chars[at.col] ?? ' ', after: chars.slice(at.col + 1).join(''), start: r.start };
  });
}


// ─── Chat rows ─────────────────────────────────────────────────────────────────
// Flatten messages into one list of visual rows: a role label, markdown content
// lines, a reasoning/tool fold, a persistent tool-run trace, and gaps. The chat then
// scrolls line-by-line without pushing the input off-screen on a long answer.
function toolRunText(run: ToolRun, wrap: number, n = 1): Span {
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
  // A run that stands for several of its kind names the tool and the count and
  // nothing else: the arguments differed, and it is the shape of the turn that the
  // line is there to show.
  const info = n > 1 ? `${run.name} ×${n}` : [run.name, a ? `(${a})` : ''].filter(Boolean).join(' ');
  let text = `▸ ${info} → ${run.outcome}`;
  // A group shares its outcome, so one reason stands for all of it: a call that
  // failed is how a person knows why an answer is thin, count or no count.
  if ((run.outcome === 'error' || run.outcome === 'declined') && run.detail) {
    text += ` — ${String(run.detail).slice(0, 60)}`;
  }
  // One terminal row, cut by the cells it takes — a wide character counts two.
  return { text: cutStep(text, Math.max(20, (wrap || 80) - 1)), dim: true };
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
// The caps the chat's hints name. They come from the one glyph dictionary
// (`keyGlyph`), so a key reads the same here, in the footer and on the keycaps panel
// — spelling them out by hand here instead would mix `⏎`, `Enter` and `Space` for
// keys drawn elsewhere as ⏎ ␣.
// These keys are the chat's own and are not remappable; an action that IS bound
// through `config.keys` must be drawn with `host.keyCap(action)` instead.
const CAP = {
  enter: keyGlyph('return'),
  esc: keyGlyph('escape'),
  tab: keyGlyph('tab'),
  space: keyGlyph(' '),
  upDown: `${keyGlyph('up')}${keyGlyph('down')}`,
  page: `${keyGlyph('pageup')}/${keyGlyph('pagedown')}`,
  // `details` is NOT here: it is a bound action (`config.keys.details`), so its cap is
  // drawn from the binding and handed in as a prop — the rule for every key a person
  // can remap.
  auto: keyGlyph({ name: 'tab', shift: true }),
  backspace: keyGlyph('backspace'),
  image: keyGlyph({ name: 'v', ctrl: true }),
} as const;
// Alt+Enter: ⌥⏎ on a Mac, Alt+⏎ elsewhere.
export const NEWLINE_KEY = keyGlyph({ name: 'return', meta: true });

// `todo ×2, memory` — the tools of a turn, in the order first used, with what each of
// them cost in calls. The line is ONE terminal row like every other, so a turn of
// fifty tools ends in `…` rather than wrapping: what is worth reading there is which
// tools carried the turn, and those are the ones named first.
function toolSummary(runs: ToolRun[], width = 0): string {
  const count = new Map<string, number>();
  for (const r of runs) count.set(r.name, (count.get(r.name) ?? 0) + 1);
  const parts = [...count].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
  const all = parts.join(', ');
  if (!width || Array.from(all).length <= width) return all;
  const kept: string[] = [];
  let used = 0;
  for (const part of parts) {
    const cost = Array.from(part).length + (kept.length ? 2 : 0);
    if (used + cost > width - 3) break;
    kept.push(part);
    used += cost;
  }
  return `${kept.join(', ')}${kept.length ? ', ' : ''}…`;
}

// The rows of ONE message. Laying markdown out is the expensive part of drawing the
// chat, and the whole conversation is handed to the scroll box on every frame — so
// the rows are remembered per message object. The chat replaces a message when it
// changes and never mutates one (see the `setMessages` updaters), which makes the
// object itself the right key: only the message that is streaming is laid out again.
const rowCache = new WeakMap<ChatMsg, Map<string, ChatRow[]>>();

// What the rows of a message depend on besides the message itself. `at` is its place
// among the messages that are DRAWN — the id of every block it owns (folds.ts).
export interface RowOpts {
  wrap: number;
  folds: FoldState;
  viewLines: number;
  notes: NotesMode;
  // The cap of whatever opens a block now, drawn from the binding and never spelled
  // here (`^o`, or what `config.keys.details` says instead).
  detailsKey: string;
  // Every renderer the chat can draw a view with — the host's own `console` and each
  // plugin's, qualified by its name (src/loader/registry.ts's collectViewRenderers).
  renderers: ViewRenderers;
  // The clock a live view's seconds are read against, once per frame.
  now: number;
  palette: Record<string, string | undefined>;
  onViewFail?: (kind: string, why: string) => void;
}

function messageRows(m: ChatMsg, at: number, last: boolean, o: RowOpts): ChatRow[] {
  const views = (Array.isArray(m.views) ? m.views : []) as ViewRecord[];
  // A live view's seconds are part of its rows: without them in the key a cached
  // `12 s` stands still through a silent `sleep 30`. A finished view's time is in
  // its data, so it adds nothing.
  const clock = views.filter((v) => v.phase === 'live').map((v) => Math.floor((o.now - v.startedAt) / 1000)).join(',');
  // Everything the rows depend on is in the key — which of this message's blocks are
  // open as much as the width, and how the narration is drawn — or a message would
  // keep the rows it was first laid out with, and a click would move nothing.
  // A run of steps and a stretch of calls are numbered within their message, and a
  // message may hold several — bits for each, up to the number it could hold (one per
  // part, and the live round).
  const blocks = Array.from({ length: (Array.isArray(m.parts) ? m.parts.length : 0) + 1 }, (_b, n) => n);
  const open = [
    isOpen(o.folds, foldId(at, 'thinking')) ? 1 : 0,
    isOpen(o.folds, foldId(at, 'summary')) ? 1 : 0,
    ...blocks.map((n) => (isOpen(o.folds, foldId(at, 'steps', n)) ? 1 : 0)),
    ...blocks.map((n) => (isOpen(o.folds, foldId(at, 'tools', n)) ? 1 : 0)),
    ...blocks.map((n) => (isClicked(o.folds, foldId(at, 'calls', n)) ? 1 : 0)),
    ...views.map((_v, vi) => (isOpen(o.folds, foldId(at, 'view', vi)) ? 1 : 0)),
  ].join('');
  // The global fold flag on its own: a view open because it was CLICKED and a view
  // open because EVERYTHING is (`^o`) both read `isOpen` as open, but the two draw
  // different amounts of text (a click's capped tail vs. `^o`'s "all of it kept") —
  // without this bit in the key, whichever was cached first would stick.
  // The whole palette, not just `ok`/`warn`: `frameView` resolves whatever token a
  // renderer names (`accent`, `shell`, `text`, a plugin's own…), so a scheme change
  // that moved any of them — not only the two console-tail colours — must still miss
  // the cache.
  const key = `${o.wrap}:${open}:${o.folds.open ? 1 : 0}:${last ? 1 : 0}:${o.viewLines}:${o.notes}:${o.detailsKey}:${at}:${clock}:${Object.values(o.palette).join(',')}`;
  let byKey = rowCache.get(m);
  if (!byKey) rowCache.set(m, (byKey = new Map()));
  let rows = byKey.get(key);
  if (!rows) byKey.set(key, (rows = buildMessageRows(m, at, last, o)));
  return rows;
}

// The rows each DRAWN message contributes — the group head counted with its first
// member, a member of a folded group and every message a group took in contributing
// none. One walk, so the rows drawn and the rows a click or an anchor counts agree.
// `chatRows`, `rowAnchor` and `anchorRow` below all read this instead of each walking
// the messages on its own, which is what keeps grouping decided in exactly one place.
function rowsPerDrawn(messages: ChatMsg[], o: RowOpts): ChatRow[][] {
  const drawn = messages.filter((m) => m.role !== 'system');
  const byAt = new Map<number, { g: ViewGroup; open: boolean }>();
  for (const g of viewGroups(drawn as GroupMsg[], o.notes)) {
    const open = groupOpen(o.folds, g);
    for (const at of [...g.members, ...g.hidden]) byAt.set(at, { g, open });
  }
  return drawn.map((m, at) => {
    const last = at === drawn.length - 1;
    const inGroup = byAt.get(at);
    if (!inGroup) return messageRows(m, at, last, o);
    const out: ChatRow[] = [];
    if (inGroup.g.head === at) {
      const recs = inGroup.g.members.map((i) => (drawn[i]!.views as ViewRecord[])[0]!);
      out.push({ role: 'assistant', first: true, step: true, groupHead: true, fold: foldId(at, 'group'),
        spans: groupHeadText(recs, o.now).map((s) => ({ text: s.text, ...(s.color ? { color: o.palette[s.color] } : { dim: true }) })) });
    }
    if (inGroup.open && inGroup.g.members.includes(at)) out.push(...messageRows(m, at, last, o));
    else if (!inGroup.open && inGroup.g.members.at(-1) === at && !last) out.push({ gap: true });
    return out;
  });
}

// The whole conversation as rows. The system prompt is not drawn and is not counted
// either: it is unshifted onto the list again with every question, and an id that
// moved with it would carry a click's exception to another message.
export function chatRows(messages: ChatMsg[], o: RowOpts): ChatRow[] {
  return rowsPerDrawn(messages, o).flat();
}

// The `ViewGroup` a `…:group` fold id names — built from the SAME `viewGroups` call
// `rowsPerDrawn` makes (the drawn messages, the current notes mode), so the click
// handler that resolves a head's id and the render that drew it can never disagree
// about which members that click folds. `undefined` for anything else, group ids
// that no longer form one included (a message arriving mid-click, say).
export function viewGroupFor(messages: ChatMsg[], o: RowOpts, id: string): ViewGroup | undefined {
  const m = /^(\d+):group$/.exec(id);
  if (!m) return undefined;
  const at = Number(m[1]);
  const drawn = messages.filter((msg) => msg.role !== 'system');
  return viewGroups(drawn as GroupMsg[], o.notes).find((g) => g.head === at);
}

// The first row of a block, so opening one can put it at the top of the screen: the
// fold line itself, with its body under it. −1 when the block is not on the list.
export function firstFoldRow(rows: readonly ChatRow[], id: string): number {
  return rows.findIndex((r) => r.fold === id);
}

// Where a row sits, said in a way that survives a fold opening or closing: which
// message it belongs to, and how far into that message's rows it is. The key is
// clamped, so a row that a fold has taken away resolves to the nearest one left.
export function rowAnchor(messages: ChatMsg[], o: RowOpts, row: number): { at: number; within: number } {
  const per = rowsPerDrawn(messages, o);
  let seen = 0;
  for (let at = 0; at < per.length; at++) {
    const n = per[at]!.length;
    if (row < seen + n) return { at, within: row - seen };
    seen += n;
  }
  return { at: Math.max(0, per.length - 1), within: 0 };
}

// The same place, counted again over rows laid out with another fold state — what the
// list has to be scrolled to for the person to keep reading the line they were on.
export function anchorRow(messages: ChatMsg[], o: RowOpts, anchor: { at: number; within: number }): number {
  const per = rowsPerDrawn(messages, o);
  let seen = 0;
  for (let at = 0; at < per.length; at++) {
    const n = per[at]!.length;
    if (at === anchor.at) return seen + Math.min(anchor.within, Math.max(0, n - 1));
    seen += n;
  }
  return seen;
}

function buildMessageRows(m: ChatMsg, at: number, last: boolean, o: RowOpts): ChatRow[] {
  const { wrap, folds, viewLines, notes, detailsKey } = o;
  const rows: ChatRow[] = [];
  const inner = Math.max(10, wrap - GUTTER);
  {
    const role = m.role;
    // A block a tool described and a renderer draws (src/assistant/views.ts): a
    // message of its own, so it reads where it happened. A `!command` carries one too,
    // on the person's ground. Every row is the block's fold line — folded it is ONE
    // row and a click there opens it; open, a click anywhere on it closes it.
    if (role === 'view' || (role === 'shell' && Array.isArray(m.views) && m.views.length)) {
      const views = (m.views ?? []) as ViewRecord[];
      views.forEach((v, vi) => {
        const id = foldId(at, 'view', vi);
        const open = isOpen(folds, id);
        // A block a CLICK opened shows its capped tail, same as any other click; the
        // GLOBAL key (`^o`) means "open everything IN FULL" — every view kept its
        // whole text (VIEW_CAPS.lines is the cap at collection, so this is never
        // actually unbounded), so `^o for all` is true rather than a hint that opens
        // a second, still-capped state.
        const framed = frameView(v, o.renderers, {
          width: inner, folded: !open, live: v.phase === 'live', failed: v.phase === 'failed',
          elapsedMs: Math.max(0, o.now - v.startedAt), lines: o.folds.open ? VIEW_CAPS.lines : viewLines, moreKey: detailsKey,
        }, o.palette, o.onViewFail);
        framed.forEach((line, li) => rows.push({
          role, spans: line.spans, first: vi === 0 && li === 0, fold: id,
          ...(line.chrome ? { chrome: line.chrome } : {}),
          ...(isConsoleKind(v.kind) ? {} : { plainGutter: true }),
        }));
      });
      if (views.length && !last) rows.push({ gap: true });
      return rows;
    }
    // The system prompt (instructions + task context) is CONTEXT, not conversation —
    // it is not drawn in history (as a system prompt in Claude Code). It stays
    // role:'system' in the API; here it is just not rendered. `/context` says how
    // much room it takes.
    if (role === 'system') return rows;
    if (role === 'assistant') {
      // A turn in TIME ORDER (src/assistant/step.ts): its reasoning, then its parts as
      // they happened — the text of each round that went on to call a tool (a step)
      // and each change a write reported — then the round being written now, then the
      // answer. Nothing a round drew ever moves: a step dims where it stands, or folds
      // into the row of its run, and the answer is only ever added to.
      const row = (line: Line, extra: Partial<ChatRow> = {}): ChatRow => ({ role, spans: line.spans, continues: line.continues, chrome: line.chrome, frame: line.frame, ...extra });
      const reasoning = String(m.reasoning ?? '').trim();
      if (reasoning) {
        // Its own block: folded to a header in `step` (a click or the key opens it),
        // and always open in `open`, where nothing folds.
        const id = foldId(at, 'thinking');
        const foldable = notes !== 'open';
        const opened = !foldable || isOpen(folds, id);
        rows.push({ role, reasonHeader: true, open: opened, label: 'thinking', ...(foldable ? { fold: id } : {}) });
        if (opened) for (const line of mdLines(reasoning, inner)) rows.push(row(line, { reason: true, ...(foldable ? { fold: id } : {}) }));
        rows.push({ gap: true });
      }
      const live = shownText(String(m.live ?? ''));
      // A round known to carry a tool call is a step already, streaming or not: it
      // joins its run where it stands rather than waiting for the round to end.
      const liveStep = m.liveQuiet === true && !!live;
      const parts = [...readParts(m.parts), ...(liveStep ? [{ kind: 'text' as const, text: live }] : [])];
      // Calls: one quiet line (`▸ 2 tools: read_file ×2`) that opens to the trail, a
      // line per call. A command a block already shows is not among them — its block
      // is (the chat leaves it out).
      const trail = (n: number, runs: ToolRun[]) => {
        const toolsId = foldId(at, 'tools', n);
        const opened = isOpen(folds, toolsId);
        rows.push({ role, meta: true, runs, open: opened, fold: toolsId });
        if (!opened) return;
        const condensed = condenseRuns(runs);
        // The open trail is capped: the LAST calls are the ones a person is looking
        // for, and what came before them is one line that opens the rest. A stretch of
        // sixty calls is thirteen rows, not sixty. The cap holds whatever the global
        // state is: only a click on that line lifts it.
        const callsId = foldId(at, 'calls', n);
        const earlier = isClicked(folds, callsId) ? 0 : Math.max(0, condensed.length - TRAIL_ROWS);
        if (earlier) rows.push({ role, toolRun: true, fold: callsId, spans: [{ text: `… ${earlier} earlier call${earlier === 1 ? '' : 's'}`, dim: true }] });
        for (const { run, n: times } of condensed.slice(earlier)) {
          rows.push({ role, toolRun: true, fold: toolsId, spans: [toolRunText(run, inner, times)] });
          for (const mark of imageMarkRows(run, inner)) rows.push({ role, toolRun: true, fold: toolsId, spans: [mark] });
        }
      };
      const segs = turnSegments(parts);
      for (const [si, seg] of segs.entries()) {
        if (seg.kind === 'change') {
          // What a write changed: always open (not foldable) — it is the part of the
          // turn the person most needs to see. The hunks are laid out as markdown, so
          // the ```diff fence is coloured, wrapped and copied like any other; the
          // title and the line numbers are the chat's own.
          changeLines(seg.change, inner).forEach((line, li) => rows.push(row(line, li === 0 ? { changeTitle: true } : {})));
          rows.push({ gap: true });
          continue;
        }
        if (seg.kind === 'tools') {
          trail(seg.n, seg.runs);
          rows.push({ gap: true });
          continue;
        }
        const id = foldId(at, 'steps', seg.n);
        if (notes === 'step' && !isOpen(folds, id)) {
          // The run folded: ONE dim row where it began, saying the newest step and
          // how many there are. Chrome — the host's account of what was said. Its
          // marks say what happened inside without a click: `✗` a call failed or was
          // declined, `✎` a write ran that showed no diff.
          const marks = runMarks(seg.calls, segs[si + 1]?.kind === 'change');
          const markSpans: Span[] = [
            ...(marks.failed ? [{ text: ' ✗', mark: 'failed' }] : []),
            ...(marks.wrote ? [{ text: ' ✎', mark: 'wrote' }] : []),
          ];
          const markWidth = markSpans.reduce((w, sp) => w + cellWidth(sp.text), 0);
          rows.push({ role, step: true, fold: id, spans: [{ text: runRowText(seg.steps, Math.max(4, inner - markWidth)) }, ...markSpans] });
        } else {
          // Every step in full, where it happened: dim in `step` (a click on any of
          // its rows folds the run again), the normal colour in `open`. Under each,
          // the calls it made: in `step` a line per call, part of the run; in `open`
          // the trail line the calls have anywhere else.
          seg.steps.forEach((text, si) => {
            if (si) rows.push({ gap: true, ...(notes === 'step' ? { fold: id } : {}) });
            for (const line of mdLines(text, inner)) rows.push(row(line, notes === 'step' ? { quiet: true, fold: id } : {}));
            const calls = seg.calls[si];
            if (!calls) return;
            if (notes === 'step') {
              for (const { run, n } of condenseRuns(calls.runs)) {
                rows.push({ role, toolRun: true, fold: id, spans: [toolRunText(run, inner, n)] });
                for (const mark of imageMarkRows(run, inner)) rows.push({ role, toolRun: true, fold: id, spans: [mark] });
              }
            } else trail(calls.n, calls.runs);
          });
        }
        rows.push({ gap: true });
      }
      // The round being written, while nobody knows yet what it is: in full, dim, a
      // live mark in the gutter and never the answer's `ƒ` — a round that turns out
      // to carry a tool call must not have been drawn as the answer.
      if (live && !liveStep) mdLines(live, inner).forEach((line, li) => rows.push(row(line, { quiet: true, ...(li === 0 ? { liveMark: true } : {}) })));
      // A turn that ran out of rounds says so where the answer would be: a dim line
      // under the field would instead be hidden by a wall of grey tool lines.
      const answer = answerText(String(m.content ?? ''));
      if (Number(m.roundLimit) > 0 && !answer) {
        rows.push({ role, limit: true, first: true, spans: [{ text: cutStep(`stopped after ${Number(m.roundLimit)} rounds — no answer; say "continue" to carry on`, inner) }] });
      }
      // The answer, exactly as written — the rows the round was drawn with while it
      // streamed (a `Next:` it held reflows by a word), now in the normal colour
      // under `ƒ`.
      if (answer) mdLines(answer, inner).forEach((line, li) => rows.push(row(line, { first: li === 0 })));
    } else if (role === 'note' && typeof m.summary === 'string') {
      // /compact's note: ONE separator row, the summary the model now sees folded
      // under it (a click or the key opens it). A note saved before carries the
      // summary in its text and is drawn as it always was, below.
      const id = foldId(at, 'summary');
      const opened = isOpen(folds, id);
      rows.push({ role, first: true, fold: id, spans: [{ text: cutStep(String(m.content ?? ''), Math.max(1, inner - 10)) }, { text: ` ${opened ? '▾' : '▸'} summary`, dim: true }] });
      if (opened) for (const line of mdLines(m.summary, inner)) rows.push({ role, spans: line.spans, continues: line.continues, chrome: line.chrome, frame: line.frame, fold: id });
    } else {
      const text = String(m.content ?? '');
      // The person's message is drawn as typed. A background result and a
      // `!command`'s block keep markdown: the first is the model's writing, the second
      // the host's own (a ```console fence under the command).
      const images = Array.isArray(m.images) ? (m.images as unknown[]).filter((n): n is number => typeof n === 'number') : [];
      // The host's own ask sent as the person's message (after an interactive
      // `!!command`) is theirs in the conversation but not their words: it steps back,
      // dim, gutter and all.
      const hostAsk = role === 'user' && m.hostAsk === true;
      (role === 'user' ? typedLines(text, inner, images) : mdLines(text, inner)).forEach((line, li) => rows.push({ role, spans: line.spans, first: li === 0, continues: line.continues, chrome: line.chrome, frame: line.frame, ...(hostAsk ? { quiet: true } : {}) }));
    }
    const duration = role === 'assistant' && Number(m.duration) >= 1000 ? m.duration : undefined;
    // What the turn cost, where it is read after the fact — the status line said it
    // while the turn ran.
    const tokens = role === 'assistant' && Number(m.tokens) > 0 ? Number(m.tokens) : undefined;
    // One quiet line under the answer: how long the turn took, whether it was
    // stopped, what it cost. The calls are in the turn, where they were made.
    const stopped = role === 'assistant' && m.stopped === true;
    const stoppedBy = stopped && typeof m.stoppedBy === 'string' && m.stoppedBy ? m.stoppedBy : undefined;
    if (duration || stopped || tokens) rows.push({ role, meta: true, duration, tokens, runs: [], stopped, ...(stoppedBy ? { stoppedBy } : {}) });
    // One blank row between messages — not two after a block that ends in its own,
    // and none for a message that drew nothing at all (a round whose only text was
    // its `Next:` line).
    if (!last && rows.length && !rows.at(-1)!.gap) rows.push({ gap: true });
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
function ChatMessages({ messages, rowOpts, palette: m, errorColor, onViewport, scrollTo, keysActive = true, wheel }: {
  messages: ChatMsg[];
  // Whether PgUp/PgDn (and the wheel) reach the list through its own input: not while a
  // docked chat has given the keyboard to the plugin — those keys are the plugin's then.
  keysActive?: boolean;
  // Filled with a function that scrolls the list by a wheel step, for the chat's own
  // handler to call with the wheel over the list while the list does not hear it.
  wheel?: { current: ((up: boolean) => void) | null };
  rowOpts: RowOpts;
  palette: Record<string, string | undefined>;
  errorColor?: string;
  // Where the conversation is on the screen and how far it is scrolled, so the owner
  // of the state can work out which ROW a click landed on. A callback, not a read of
  // the render: the view reports its geometry, the chat does the arithmetic.
  onViewport?: (v: Viewport) => void;
  // A row the list should be scrolled to once the rows have changed — how a block
  // that opens puts its first row at the top of the screen, and how one that closes
  // leaves the eye on the line it was on. The nonce is what makes a repeat ask again.
  scrollTo?: { row: number; n: number } | null;
}) {
  const { wrap, viewLines, notes } = rowOpts;
  const box = useRef<ScrollBoxHandle>(null);
  const [view, setView] = useState<{ top: number; height: number } | null>(null);
  // The ask that has not been carried out yet, and the last one that was: a ref, so
  // asking again costs no render and a repaint never repeats an old ask.
  const wanted = useRef<{ row: number; n: number } | null>(null);
  const done = useRef(-1);
  if (scrollTo && scrollTo.n !== done.current) wanted.current = scrollTo;
  const rect = useRef<{ top: number; height: number; left: number; width: number } | null>(null);
  const pinnedRef = useRef(false);
  const tell = (scrollTop: number, atEnd: boolean) => {
    const r = rect.current;
    if (r) onViewport?.({ ...r, scrollTop, pinned: pinnedRef.current, atEnd });
  };
  const metrics = useRef<ScrollMetrics | null>(null);
  if (wheel) {
    wheel.current = (up: boolean) => {
      const x = metrics.current;
      if (!x) return;
      // The box counts its offset from the bottom (it is anchored there).
      const top = Math.max(0, Math.min(x.maxScrollTop, x.scrollTop + (up ? -3 : 3)));
      box.current?.scrollTo(x.maxScrollTop - top);
    };
  }
  const see = (x: ScrollMetrics) => {
    metrics.current = x;
    setView((v) => (v && v.top === x.scrollTop && v.height === x.viewportHeight ? v : { top: x.scrollTop, height: x.viewportHeight }));
    // The metrics are fresh HERE — the box has just measured the rows a fold added or
    // took away — so this is where an ask can be turned into an offset the box
    // understands (it counts from the bottom) without guessing at the new height.
    const want = wanted.current;
    if (want) {
      wanted.current = null;
      done.current = want.n;
      box.current?.scrollTo(Math.max(0, x.maxScrollTop - want.row));
      return;
    }
    tell(x.scrollTop, x.scrollTop >= x.maxScrollTop);
  };
  // A message the person sends brings the view back to the bottom, wherever they had
  // scrolled to: they want to see the answer to what they just asked. Rows appearing
  // ABOVE the view — a block opening — is not that, and must never trip it.
  const asked = messages.reduce((n, x) => n + (x.role === 'user' || x.role === 'shell' ? 1 : 0), 0);
  useEffect(() => { box.current?.scrollToEnd(); }, [asked]);

  const rows = chatRows(messages, rowOpts);
  let lastUserKey = -1;
  for (let i = 0; i < rows.length; i++) if (rows[i]!.role === 'user' && rows[i]!.first) lastUserKey = i;
  let lastUserText = '';
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    // The pin is one row: a question typed over several lines is shown on one there.
    if (messages[mi]?.role === 'user') { lastUserText = String(messages[mi]!.content ?? '').replace(/\s+/g, ' ').trim(); break; }
  }
  // Every row is one terminal line, so a row's index is its line in the content. The
  // last question is pinned over the box's top row while it is scrolled out of view —
  // but only while the conversation has rows to spare: on a short screen the pin
  // would cover the one row the newest answer has.
  const pinned = !!view && view.height >= MIN_ROWS_TO_PIN && lastUserKey >= 0 && (lastUserKey < view.top || lastUserKey >= view.top + view.height);
  // The pin is painted OVER the box's top row, so a click there lands on the pin and
  // not on the row under it — what the chat is told, so it leaves that row alone.
  pinnedRef.current = pinned;

  // Who is speaking is said by a marker in the gutter and by the ground under the
  // message — not by a label. The person's marker is the input field's own prompt.
  // A `!command` is the person's own action, so it sits on the person's ground.
  const groundOf = (role?: string) => (role === 'user' || role === 'shell' ? m.userBg : role === 'bg' ? m.bgBg : undefined);
  // The gutter is frame, never copied: a drag across an answer returns its text
  // without the `ƒ ` (or `› `, `$ `, `◆ `) in front of it.
  const gutter = (row: ChatRow) => h(Box, { selectable: false, flexShrink: 0 }, marker(row));
  const marker = (row: ChatRow) => {
    if (row.first && row.role === 'user') return row.quiet ? h(Text, { dim: true, color: m.accent }, '› ') : h(Text, { bold: true, color: m.accent }, '› ');
    // Same colour as the shell-mode prompt below — a command reads as one thing
    // from the `! ` it was typed with to the `$ ` its result appears under. A
    // `view` is a command the MODEL ran and the person confirmed: the same `$ ` in
    // the same colour, on no ground of its own, so whose command it was is still
    // told apart at a glance. A view that is not a command (`plainGutter`, e.g. a
    // plugin's own block) draws no `$` — it falls through to the blank gutter below.
    if (row.first && (row.role === 'shell' || row.role === 'view') && !row.plainGutter) return h(Text, { bold: true, color: m.shell }, '$ ');
    if (row.first && row.role === 'bg') return h(Text, { bold: true, color: m.bgAccent }, '◆ ');
    // A note is the HOST speaking to the person (what /memory found, what /clear kept).
    // It is not part of the conversation and is never sent to the model.
    if (row.first && row.role === 'note') return h(Text, { dim: true }, '· ');
    // ƒ — F for Flow, and a function. A narrow code point every monospace font has;
    // ∮ reads well as "a loop" but is East-Asian-ambiguous width — flowtty reads it as
    // one cell, so it would shift the row in a terminal that draws it two cells wide.
    if (row.first && row.role === 'assistant') return h(Text, { bold: true, color: m.assistantAccent }, `${ASSISTANT_MARK} `);
    // The round being written: nobody knows yet whether it is the answer, so it gets
    // a live mark instead of the answer's `ƒ`.
    if (row.liveMark) return h(Text, { dim: true, color: m.assistantAccent }, `${spin(rowOpts.now) ?? '·'} `);
    return h(Text, null, ' '.repeat(GUTTER));
  };

  // A row's text in a box of its own, beside the gutter — the box flowtty's
  // `<Markdown>` draws a row as, so the layout's selection marks mean the same here:
  // `wrapContinues` rejoins a soft-wrapped paragraph into one line on copy (without
  // it every row pastes as its own line), and the leading `chrome` spans (a code
  // block's bar) are painted but never copied.
  const content = (row: ChatRow, span: (s: Span, j: number) => ReactNode) =>
    h(Box, { flexDirection: 'row', flexShrink: 0, wrapContinues: row.continues }, (row.spans || []).map(span));
  // A row that is frame from edge to edge (a fence label) leaves the selection WHOLE —
  // its blank cells to the right included, or a copy returns it as an empty line.
  const frameRow = (row: ChatRow) => (row.frame === true ? { selectable: false } : {});

  // An absolute child of a scroll box is an overlay: it stays put while the rows move
  // under it, so pinning does not shift what the person is reading. Needs flowtty
  // ≥ 1.0.0-alpha.9 — before it an overlay vanished under a padded ancestor (this
  // modal has padding).
  const sticky = pinned
    // Painted over the rows, so a drag would pick it up in place of the row under it.
    ? h(Box, { key: 'chat-sticky', position: 'absolute', top: 0, left: 0, width: '100%', flexDirection: 'row', backgroundColor: m.userBg ?? m.bg, selectable: false },
        h(Text, { bold: true, dim: true, color: m.accent }, '› '),
        h(Text, { dim: true, wrap: 'truncate' }, lastUserText.length > 60 ? `${lastUserText.slice(0, 60)}…` : lastUserText || '…'))
    : null;
  // One row of the conversation. `<ScrollList>` calls it only for the rows near the
  // screen, so a long conversation costs what a short one costs.
  const renderRow = (row: ChatRow, i: number) => {
      const key = `chat-${i}`;
      if (row.gap) return h(Box, { key, height: 1, flexShrink: 0 });
      if (row.reasonHeader) return h(Text, { key, dim: true, color: 'magenta', selectable: false }, `${' '.repeat(GUTTER)}${row.open ? '▾' : '▸'} ${row.label}`);
      // A group's head is a one-row line like a folded run — chrome, cut to one row —
      // but it carries several spans (`Ran 3 commands · ✗ 1 failed · 34.0 s`) and the
      // `ƒ ` mark a run's row never draws: a span's own colour (the failed count's warn) wins
      // over the line's forced dim, or a red count would read as grey.
      if (row.step && row.groupHead) return h(Box, { key, flexDirection: 'row', flexShrink: 0, selectable: false },
        gutter(row),
        h(Box, { flexDirection: 'row', flexShrink: 1, overflow: 'hidden' },
          (row.spans || []).map((s, j) => h(Text, {
            key: j, dim: s.dim, color: s.color, wrap: 'truncate',
          }, String(s.text ?? '')))));
      // A folded run of steps. Chrome, like the `N tools` line and the gutter: a drag
      // across the answer returns what the model SAID, never the host's one-line
      // account of it. It is cut to the width above, and truncated here as well so
      // that it can never take a second row — the whole conversation is laid out one
      // terminal line per row.
      if (row.step) return h(Box, { key, flexDirection: 'row', flexShrink: 0, selectable: false },
        h(Text, null, ' '.repeat(GUTTER)),
        h(Box, { flexDirection: 'row', flexShrink: 1, overflow: 'hidden' },
          (row.spans || []).map((s, j) => h(Text, {
            key: j, wrap: 'truncate',
            ...(s.mark === 'failed' ? { color: errorColor } : s.mark === 'wrote' ? { color: m.warn } : { dim: true }),
          }, String(s.text ?? '')))));
      if (row.reason) return h(Box, { key, flexDirection: 'row', flexShrink: 0, ...frameRow(row) },
        gutter(row),
        content(row, (s, j) => h(Text, { key: j, dim: true, bold: s.bold, underline: s.underline, color: s.color, selectable: j < (row.chrome ?? 0) ? false : undefined }, String(s.text ?? ''))));
      if (row.toolRun) return h(Box, { key, flexDirection: 'row', flexShrink: 0 },
        h(Text, null, ' '.repeat(GUTTER)),
        (row.spans || []).map((s, j) => h(Text, { key: j, dim: true, wrap: 'truncate' }, String(s.text ?? ''))));
      // The turn ran out of rounds: said in the warn colour, where the answer it never
      // wrote would have been. Chrome — it is the host's account of the turn, not
      // something the model said.
      if (row.limit) return h(Box, { key, flexDirection: 'row', flexShrink: 0, selectable: false },
        h(Text, { bold: true, color: m.assistantAccent }, `${ASSISTANT_MARK} `),
        h(Text, { color: m.warn, wrap: 'truncate' }, String(row.spans?.[0]?.text ?? '')));
      if (row.meta) {
        const runs = row.runs ?? [];
        const wrote = runs.some((r) => r.outcome === 'applied');
        const failed = runs.some((r) => r.outcome === 'error' || r.outcome === 'declined');
        // How long it took and which tools ran — about the answer, not part of it.
        return h(Box, { key, flexDirection: 'row', flexShrink: 0, selectable: false },
          h(Text, null, ' '.repeat(GUTTER)),
          row.duration ? h(Text, { dim: true }, `${fmtSec(row.duration)}${runs.length || row.stopped ? ' · ' : ''}`) : null,
          row.stopped ? h(Text, { color: m.warn }, `stopped (${row.stoppedBy ?? CAP.esc})${runs.length ? ' · ' : ''}`) : null,
          runs.length ? h(Text, { dim: !failed, color: failed ? errorColor : wrote ? m.warn : m.ok }, `${row.open ? '▾' : '▸'} ${runs.length} tool${runs.length === 1 ? '' : 's'}${wrote ? ' ✎' : ''}: `) : null,
          // The summary is a row like any other: cut it to what is left of the width,
          // or a turn of fifty tools takes a second line and the list's arithmetic
          // (one terminal line per row) is wrong.
          runs.length ? h(Text, { dim: true, wrap: 'truncate' }, `${toolSummary(runs, Math.max(10, wrap - 30))}${row.open || !rowOpts.detailsKey ? '' : ` · ${rowOpts.detailsKey}`}`) : null,
          // What the turn cost the provider — the turn's, not the conversation's.
          row.tokens ? h(Text, { dim: true }, `${row.duration || runs.length || row.stopped ? ' · ' : ''}${tokensBadge(row.tokens)}`) : null);
      }
      const ground = groundOf(row.role);
      const groundStyle = ground ? { width: '100%', backgroundColor: ground } : {};
      if (row.spans && row.spans.length) {
        return h(Box, { key, flexDirection: 'row', flexShrink: 0, ...groundStyle, ...frameRow(row) }, gutter(row),
          content(row, (s, j) => h(Text, {
            key: j,
            bold: s.bold,
            // A note is the host's; what the model wrote on the way stays where it
            // was drawn but steps back, so the answer under it is what the eye lands on.
            dim: s.dim || row.role === 'note' || row.quiet === true,
            underline: s.underline,
            color: s.token || s.accent ? m.accent : s.color,
            selectable: j < (row.chrome ?? 0) ? false : undefined,
          }, String(s.text ?? ''))));
      }
      // A blank line inside a message keeps the message's ground.
      return h(Box, { key, height: 1, flexShrink: 0, ...groundStyle });
  };

  const scroll = {
    ref: box, anchor: 'bottom' as const, isActive: keysActive, flexGrow: 1, flexShrink: 1, flexDirection: 'column' as const,
    onScroll: (_o: number, x: ScrollMetrics) => see(x), onMetrics: see,
    // Where the conversation sits on the terminal, in the coordinates a mouse key is
    // reported in — so a click can be turned into the row under it.
    onLayout: (r: { top: number; height: number; left: number; width: number }) => {
      const had = rect.current;
      if (had && had.top === r.top && had.height === r.height && had.left === r.left && had.width === r.width) return;
      rect.current = { top: r.top, height: r.height, left: r.left, width: r.width };
      tell(view?.top ?? 0, view === null);
    },
  };
  // Nothing said yet: the box holds the invitation instead of rows.
  if (!rows.length) {
    return h(ScrollBox, scroll,
      h(Text, { dim: true, selectable: false }, `Ask anything. ${CAP.enter} sends, ${NEWLINE_KEY} starts a new line, / opens the commands, !command runs one in the shell.`));
  }
  // Every chat row is exactly ONE terminal line (the pin's arithmetic relies on it),
  // which is what lets the list lay out only the rows in view: the content is exactly
  // as tall as the conversation, so anchoring, the scrollbar and the metrics the pin
  // reads stay exact. Laying out every row of a long conversation on every keystroke
  // was what made typing slower the longer the chat got.
  return h(ScrollList<ChatRow>, {
    ...scroll,
    items: rows,
    // Rows are rebuilt (and cached) per message; a row's place in the conversation is
    // what identifies it, as it did when every row was a child with a `chat-i` key.
    keyOf: (_row: ChatRow, i: number) => `chat-${i}`,
    rowHeight: 1,
    renderItem: renderRow,
  }, sticky);
}

// ─── Chat modal (pure render) ──────────────────────────────────────────────────
// The wide chat: nearly all the terminal width (with an inset from the frame), so
// markdown answers unroll to the width. The conversation is <ChatMessages> above — a
// scroll box that takes the rows the rest of the column leaves; under it sit the
// error, the status line, the plan, the queue line and the field (or the question /
// y-n block that replaces it). Palette: theme.modals.chat.
// What the plan block shows: in progress first, then pending, each in insertion order
// (the sort is stable): the cap cuts from the END, so the items being worked on are the
// last to fall off the screen. Needs flowtty ≥ 1.0.0-alpha.5 — before it, re-ordering
// keyed children aborted Yoga and the plan was pinned to insertion order. Done items are
// counted, not listed.
function planView(list: PlanItem[]): { shown: PlanItem[]; summary: string } {
  const active = list
    .filter((t) => t.status !== 'done')
    .sort((a, b) => Number(b.status === 'in_progress') - Number(a.status === 'in_progress'));
  const shown = active.slice(0, MAX_VISIBLE_PLAN);
  const done = list.filter((t) => t.status === 'done').length;
  const hidden = active.length - shown.length;
  const summary = [hidden > 0 ? `+${hidden} pending` : '', done > 0 ? `· ${done} done` : ''].filter(Boolean).join(' ');
  return { shown, summary };
}
// How many rows the whole plan block takes: its `▾ plan` head, the items shown, the
// summary line.
const planBlockRows = (plan: { shown: PlanItem[]; summary: string }) =>
  plan.shown.length || plan.summary ? 1 + plan.shown.length + (plan.summary ? 1 : 0) : 0;
// The plan on ONE row, for a chat with too few rows for the whole block: `plan 2/3 ·`
// and the item being worked on — the one in progress, else the first pending — counted
// by its place in the plan.
export function planLine(list: PlanItem[]): { head: string; text: string; inProgress: boolean } {
  let at = list.findIndex((t) => t.status === 'in_progress');
  if (at < 0) at = list.findIndex((t) => t.status === 'pending');
  if (at < 0) return { head: `plan ${list.length}/${list.length} · `, text: 'all done', inProgress: false };
  return { head: `plan ${at + 1}/${list.length} · `, text: list[at]!.text, inProgress: list[at]!.status === 'in_progress' };
}
// How the plan is drawn in a chat column of `rows` rows, `others` of which everything but
// the conversation and the plan takes (the gaps between those pieces included). The
// field never gives up a row and the conversation keeps at least one, so the plan is
// what gives way: whole when it fits, ONE row when that fits, else not drawn at all.
export function planFit(rows: number, others: number, full: number): 'full' | 'line' | 'none' {
  if (full === 0) return 'none';
  // The conversation's row and the gap the plan brings with it.
  const room = rows - others - 1 - 1;
  return full <= room ? 'full' : room >= 1 ? 'line' : 'none';
}

export function renderChatModal({
  width,
  height,
  theme,
  messages,
  input,
  streaming,
  error,
  subject,
  toolLabel = '',
  phase = 'writing',
  verb = '',
  folds = { open: false, except: new Set<string>() },
  detailsKey = '^o',
  onViewport,
  scrollTo = null,
  cursor = 0,
  escArmed = false,
  armedHint = '',
  stoppable = true,
  bangLevel = 0,
  shellCwd = '',
  autoMode = 'ask',
  pendingConfirm = null,
  pendingQuestion = null,
  queued = [],
  elapsed = 0,
  emptyNotice = '',
  toolCount = 0,
  turnTokens = 0,
  viewLines = VIEW_CAPS.folded,
  notes = 'step',
  viewRenderers = { console: renderConsole },
  now = Date.now(),
  onViewFail,
  completion = null,
  bgCount = 0,
  contextBadge = '',
  contextWarn = false,
  contextPanel = null,
  contextCacheLine = '',
  contextRecallLine = '',
  todo = null,
  fullscreen = false,
  docked = false,
  focused = true,
  wheel,
  escWord = 'close',
  imageNumbers = [],
  imagesOn = false,
}: {
  width: number;
  height: number;
  theme: Theme | undefined;
  messages: ChatMsg[];
  input: string;
  streaming: boolean;
  error?: string | null;
  subject?: string | null; // the labels of what is on screen, joined
  toolLabel?: string;
  // What the model is doing while no tool runs — see the status line.
  phase?: 'thinking' | 'writing';
  // The word the line says for it — one per model request (src/assistant/verbs.ts).
  verb?: string;
  // What is open and what is folded (src/assistant/folds.ts): the global state plus
  // the blocks a click has made an exception of. The chat owns it.
  folds?: FoldState;
  // The cap of the key that opens a block, from its binding (`config.keys.details`).
  detailsKey?: string;
  // The conversation's place on the terminal and how far it is scrolled — what turns
  // a click's cell into a row.
  onViewport?: (v: Viewport) => void;
  // Put this row at the top of the conversation once the rows have changed.
  scrollTo?: { row: number; n: number } | null;
  cursor?: number;
  escArmed?: boolean;
  // An armed Ctrl+C / Ctrl+D / Ctrl+Z says so (`^c again to exit`) where Esc's arm is
  // said — over a running turn's status too, since Ctrl+Z arms while one runs.
  armedHint?: string;
  // Whether Esc has something to stop — not once the run was stopped and still has
  // not let go (a tool that ignores its signal): the status line then drops `Esc stops`.
  stoppable?: boolean;
  // The field's bang level (assistant.ts owns the state machine): 0 normal, 1 shell
  // mode (prompt `! `, Enter runs the text as a command), 2 interactive mode (prompt
  // `!!`, Enter hands the terminal over) — both non-zero levels in the shell colour.
  bangLevel?: 0 | 1 | 2;
  // The shell's directory, `~`-shortened, as the hint row starts in shell mode — so
  // where `!` / `!!` will run is seen while the command is typed, not only in the
  // block after it ran. Drawn at a non-zero bang level only.
  shellCwd?: string;
  // How much of a turn runs without a y/n (src/assistant/auto.ts). Drawn beside the
  // context badge, in the warn colour, in every state the hint row can be in: the
  // person must be able to see it while the answer they did not confirm is arriving.
  autoMode?: AutoMode;
  // `command`: a run_command call — shown whole and wrapped, since the person is
  // deciding on exactly that line.
  pendingConfirm?: { name: string; args?: string | unknown; command?: string } | null;
  pendingQuestion?: AskState | null;
  // Messages sent while an answer was coming; they go out, in order, when the turn ends
  // (a stopped or failed turn puts them back into the field). ↑ on an empty field takes
  // the LAST one back, so the last one is what the line shows.
  queued?: string[];
  // The seconds of what is running NOW — a tool while one runs, the model's round
  // otherwise. The turn's own total is on the finished answer's quiet line.
  elapsed?: number;
  emptyNotice?: string;
  toolCount?: number;
  // What the provider has reported this TURN costing (0 — nothing reported, and no
  // figure is drawn: an invented one would be worse than none).
  turnTokens?: number;
  // How many lines a block a CLICK opens shows (`plugins.assistant.runOutputLines`);
  // `^o` (the global fold key) opens every block in full, past this cap.
  viewLines?: number;
  // How the text written between tool calls is drawn (`plugins.assistant.notes`,
  // `/notes` for the conversation): each run of steps folded to one row, or every
  // step in full (src/assistant/step.ts).
  notes?: NotesMode;
  // Every renderer the chat can draw a view with — the host's own `console` by
  // default, and each plugin's, qualified by its name (services.viewRenderers).
  viewRenderers?: ViewRenderers;
  // The clock a live view's seconds are read against, once per frame.
  now?: number;
  // A renderer that cannot draw a kind — missing, throws, or returns something odd.
  onViewFail?: (kind: string, why: string) => void;
  completion?: Completion | null;
  bgCount?: number;
  // `ctx 12%` (assistant/context-meter.ts); yellow once it is time to /compact.
  contextBadge?: string;
  contextWarn?: boolean;
  // `/context`: the reading to draw as a panel in the field's place (null — closed).
  contextPanel?: ContextReading | null;
  // The last request's cache breakdown, in the provider's own words
  // (`assistant/context-meter.ts`' `cacheLine`) — '' draws nothing (the panel is
  // closed, or nothing has been sent yet).
  contextCacheLine?: string;
  // How many bulky items go as stubs, and how many `recall` brought back this turn
  // (`assistant/recall.ts`' `recallLine`) — '' draws nothing.
  contextRecallLine?: string;
  todo?: PlanItem[] | null;
  // The window takes the whole terminal — title bar and footer too — instead of a
  // centred 88% × 82% over the dimmed screen. The overlay already spans the
  // terminal from its first row, so the window only has to be as big.
  fullscreen?: boolean;
  // Docked beside the plugin's screen (the `panel` mode): the window is the panel, laid
  // out where the host put it — not an overlay — and its frame says whether it has the
  // keyboard (the accent colour) or the plugin has.
  docked?: boolean;
  focused?: boolean;
  wheel?: { current: ((up: boolean) => void) | null };
  // What a second Esc does to the chat: `close` the window, or `collapse` the panel.
  escWord?: 'close' | 'collapse';
  // The numbers of the conversation's images: an `[Image #N]` in the field with one of
  // them behind it is an attachment, drawn in the accent colour. Typed by hand with
  // nothing behind it, the same text is just text.
  imageNumbers?: number[];
  // Attaching is on (`ai.images.enabled`): the hint names the key that pastes an image.
  imagesOn?: boolean;
}) {
  const boxW = chatBoxWidth(width, fullscreen);
  const boxH = fullscreen ? height : Math.min(Math.floor(height * 0.82), height - 4);
  const wrap = chatWrapWidth(width, fullscreen);
  const m = (theme?.modals?.chat ?? {}) as Record<string, string | undefined>;
  const fieldW = chatFieldWidth(width, fullscreen); // the prompt lives in the gutter
  const fieldRows = inputVisualRows(input, cursor, fieldW);
  const tokens = imageNumbers.length ? imageTokenRanges(input, (n) => imageNumbers.includes(n)) : [];
  // The field's own text, a token among it drawn as an attachment. Not dim: in the field
  // dim means "offered, not yours yet".
  const typed = (text: string, from: number, key: string) =>
    splitTokens(text, from, tokens).map((p, j) => h(Text, { key: `${key}${j}`, wrap: 'truncate', ...(p.token ? { color: m.accent } : {}) }, p.text));
  const caretLi = Math.max(0, fieldRows.findIndex((r) => r.caret !== ''));
  const MAX_INPUT_LINES = 5;
  const visible = windowAround(fieldRows, caretLi, MAX_INPUT_LINES).items;
  // The conversation is a scroll box that takes what the column leaves, so the plan,
  // the queue line, the field and the question block (each `flexShrink: 0`) take their
  // own rows. Heights are added up for one thing only: whether the plan fits whole.
  // The todo plan block: in-progress items first, then pending, capped at
  // MAX_VISIBLE_PLAN active rows; done items are counted, not listed.
  // An open question takes the plan's room: the person is answering, not planning.
  const planList = (pendingQuestion ? [] : (todo ?? [])) as PlanItem[];
  const { shown: planShown, summary: planSummary } = planView(planList);
  // Inline completion: the part of the offer not typed yet, drawn right after the
  // caret, what its label says, and the other candidates named beside it. Only while
  // the caret is at the end of a one-line field — there is nothing to continue from
  // the middle of a word.
  const atEnd = cursor >= input.length && !input.includes('\n');
  const ghost = atEnd ? completion?.ghost ?? '' : '';
  const label = atEnd ? completion?.label ?? '' : '';
  const others = atEnd ? completion?.others ?? [] : [];
  const confirmAsk = pendingConfirm ? confirmView(pendingConfirm) : null;
  // What the field's place holds: the question, `/context`, the y/n, or the field.
  const fieldPlace = pendingQuestion
    ? askBlockRows(pendingQuestion, wrap)
    : contextPanel
    ? contextPanelRows(contextPanel, wrap, contextCacheLine, contextRecallLine)
    : confirmAsk
    ? confirmBlockRows(confirmAsk, wrap)
    : visible.length;
  // Everything in the column but the conversation and the plan — the error, the hint
  // row, the queue line, the field's place — each with the gap above it. The frame's
  // border and padding take 4 rows.
  const besides = [error ? textRows(`⚠ ${error}`, boxW - 4) : 0, 1, queued.length ? 1 : 0, fieldPlace]
    .filter((n) => n > 0).reduce((a, n) => a + n + 1, 0);
  const planShape = planFit(boxH - 4, besides, planBlockRows({ shown: planShown, summary: planSummary }));
  const oneLine = planShape === 'line' ? planLine(planList) : null;

  return h(
    Box,
    docked ? { width, height, flexDirection: 'column' } : overlay(width, height),
    h(
      Box,
      {
        border: 'round',
        backgroundColor: m.bg,
        // The window paints its own ground, so it sets its own ink too: text with no
        // color of its own inherits it (flowtty ≥ 1.0.0-alpha.16). Left to the
        // terminal's foreground, a light terminal theme drew black on black.
        color: m.text,
        borderBackgroundColor: m.borderBg,
        borderColor: docked ? (focused ? m.accent : m.idleBorder) : m.border,
        // What is on screen, after the name — cut to the border, never wrapped.
        borderTitle: subject ? cutStep(`${ASSISTANT_MARK} Flow Assist · ${subject}`, Math.max(0, boxW - 4)) : `${ASSISTANT_MARK} Flow Assist`,
        width: boxW,
        height: boxH,
        padding: 1,
        flexDirection: 'column',
        gap: 1,
        overflow: 'hidden',
        // A drag that starts in the chat stays in it — inside the frame, never onto the
        // border or the screen behind. The conversation is a scope of its own (a
        // <ScrollBox> is one), so a drag there stays in the conversation.
        selectionScope: true,
      },
      h(ChatMessages, { messages, rowOpts: { wrap, folds, viewLines, notes, detailsKey, renderers: viewRenderers, now, palette: m, onViewFail }, palette: m, errorColor: theme?.error, onViewport, scrollTo, keysActive: focused, wheel }),
      error ? h(Text, { color: 'red' }, `⚠ ${error}`) : null,
      // The hint on the left, how full the model's context is on the right — it stays
      // put while the hint changes, and turns yellow when it is time to /compact.
      // Chrome, not conversation: out of every selection.
      h(Box, { flexDirection: 'row', width: '100%', flexShrink: 0, selectable: false },
      h(Box, { flexGrow: 1, flexShrink: 1, overflow: 'hidden' },
      (!escArmed && !armedHint && (streaming || toolLabel))
        // Working: what is happening NOW is the bright part. A tool that is running
        // pulses through the accent colours; with none running the model is either
        // thinking (waiting for its first token, reasoning, working out the next tool
        // call) or writing (its text is arriving) — never the name of the last tool.
        // The seconds are that running thing's, not the turn's: a turn that runs a
        // build sat at `3m 12s`, which says nothing about what is happening now. What
        // the turn has cost so far stands beside them, when the provider says.
        ? h(Box, { flexDirection: 'row', overflow: 'hidden' },
            h(Text, { dim: true, wrap: 'truncate' }, `${spin(elapsed)} ${fmtSec(elapsed)}${toolCount ? ` · ${toolCount} tool call${toolCount === 1 ? '' : 's'}` : ''}${turnTokens ? ` · ${tokensBadge(turnTokens)}` : ''} · `),
            toolLabel
              // `Shimmer` takes the label as a string and colours it per character, so
              // it is the label itself that is handed over, not a styled child.
              ? h(Box, { overflow: 'hidden' }, h(Shimmer, { color: m.accent ?? 'cyan', highlight: TOOL_PULSE(m), width: 4, interval: 70, direction: 'ltr', running: true, children: toolLabel }))
              // No tool: the request's own word, with the tool's shimmer — the colour
              // says which phase, magenta while the model thinks, the assistant's
              // accent while its text arrives.
              : h(Box, { overflow: 'hidden' }, h(Shimmer, {
                  color: phase === 'thinking' ? 'magenta' : (m.assistantAccent ?? 'green'),
                  highlight: TOOL_PULSE(m), width: 4, interval: 70, direction: 'ltr', running: true,
                  children: `${verb || VERBS[0]}…`,
                })),
            stoppable ? h(Text, { dim: true, wrap: 'truncate' }, ` · ${CAP.esc} stops`) : null)
        : h(Text, (emptyNotice && !streaming && !toolLabel && !escArmed && !armedHint) ? { color: 'yellow', wrap: 'truncate' } : { dim: true, wrap: 'truncate' },
        armedHint
          ? armedHint
          : escArmed
          ? `${CAP.esc} again to ${escWord === 'collapse' ? 'collapse' : 'exit'}`
          : emptyNotice
              ? `⚠ ${emptyNotice}`
              // `⇧⇥ auto` goes LAST of the keys: the row is cut at the window's width,
              // and a hint that has been there all along must not be the one to fall
              // off for a newcomer. The mode itself is stated beside the row, not in
              // it, so nothing about the mode is lost to the cut.
              // A hint for an action nobody has a key for is not shown at all — a key
              // on screen is an instruction, and `config.keys.details: []` disables it.
              // In shell mode the row starts with the shell's directory — where the
              // command will run — cut from the left when long, so its tail stays; the
              // field's own row says what ⏎ does there, this one the other keys.
              : bangLevel && shellCwd
              ? (() => { const rest = [`${CAP.tab} path`, `${CAP.upDown} history`].join(' · '); return `${cutFromLeft(shellCwd, Math.max(8, wrap - rest.length - 3))} · ${rest}`; })()
              : ([`${CAP.upDown} history`, `wheel or ${CAP.page} scroll`, detailsKey && `${detailsKey} details`, '/ commands',
                  imagesOn && `${CAP.image} image`, `${CAP.auto} auto`, bgCount > 0 && `${bgCount} in background`].filter(Boolean).join(' · ')))),
      // A sibling of the hint, not part of it: the left cell is the hint OR the status
      // of a running turn, and the mode has to stay on screen through both.
      autoBadge(autoMode) ? h(Text, { color: m.warn, bold: true }, `  ${autoBadge(autoMode)}`) : null,
      contextBadge ? h(Text, contextWarn ? { color: 'yellow' } : { dim: true }, `  ${contextBadge}`) : null),
      // The task plan sits ABOVE the input (not above the messages) — the newest
      // answer stays pinned just above it, so a growing plan never hides it. In a chat
      // with too few rows for it (a small docked panel) it gives way first: ONE row,
      // `plan 2/3 · <item>`, cut to the width, and whole again once there is room. The
      // field never shrinks and the conversation keeps a row (`planFit`).
      oneLine
        ? h(Box, { key: 'plan', flexDirection: 'row', width: '100%', flexShrink: 0, overflow: 'hidden' },
            h(Text, { dim: true, color: 'magenta', wrap: 'truncate' }, `▸ ${oneLine.head}`),
            h(Text, { wrap: 'truncate', color: oneLine.inProgress ? 'yellow' : undefined }, oneLine.text))
        : planShape === 'full'
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
        ? h(Box, { flexDirection: 'row', width: '100%', flexShrink: 0 },
            h(Text, { bold: true, color: m.warn }, `${CAP.enter} queued${queued.length > 1 ? ` (${queued.length})` : ''}: `),
            h(Text, { wrap: 'truncate', color: m.warn }, `${queued.length > 1 ? '… ' : ''}${queued.at(-1)!.replace(/\s+/g, ' ').slice(0, Math.max(10, wrap - 40))}`),
            // ↑ takes it back only from an empty field (in a draft it moves the caret),
            // so it is offered only there.
            input ? null : h(Text, { dim: true }, ` · ${keyGlyph('up')} takes it back`))
        : null,
      // The input field group (the y/n confirm block or the multiline input box). It
      // never shrinks: in a small panel the plan gives way (`planFit`), the field and
      // its hint keep their rows.
      h(Box, { flexDirection: 'column', width: '100%', flexShrink: 0 },
        pendingQuestion
          ? renderAsk(pendingQuestion, m.bg, wrap)
          : contextPanel
          ? renderContextPanel(contextPanel, m.bg, wrap, contextCacheLine, contextRecallLine)
          : confirmAsk
          ? h(Box, { flexDirection: 'column', width: '100%', gap: 1, border: 'round', paddingX: 1, borderColor: 'yellow', backgroundColor: m.bg },
              h(Text, { bold: true, color: 'yellow' }, confirmAsk.title),
              confirmAsk.command != null
                ? h(Text, { wrap: 'wrap' }, confirmAsk.command)
                : h(Text, { dim: true, wrap: 'truncate' }, confirmAsk.args),
              h(Text, { color: theme?.error, selectable: false }, confirmAsk.hint))
          // The field is where the person types — its caret, prompt and placeholder are
          // not text to copy, and a drag over it must not pick them up.
          : h(Box, { flexDirection: 'column', width: '100%', backgroundColor: m.fieldBg, selectable: false },
              visible.map((row, i) => {
                // The prompt marks the field's first line; it dims while an answer is
                // coming, when ⏎ queues instead of sending. A non-zero bang level swaps
                // both the glyph and the colour — `! ` or `!!` in m.shell, the same
                // colour at both levels — so the field itself says what Enter will do,
                // the way Claude Code's bash mode does. Every glyph is exactly GUTTER
                // (2) columns wide (`!!` has no trailing space) so a wrapped command's
                // continuation rows still line up under the first.
                const bangGlyph = bangLevel === 2 ? '!!' : bangLevel === 1 ? '! ' : '› ';
                const prompt = h(Text, { bold: !streaming, dim: streaming, color: bangLevel ? m.shell : m.accent }, visible[i] === fieldRows[0] ? bangGlyph : ' '.repeat(GUTTER));
                // A blank line is a real '' — flowtty ≥ 1.0.0-alpha.5 gives an empty Text
                // its row; a collapsed one instead is how "two newlines" would vanish.
                if (row.caret === '') return h(Box, { key: i, flexDirection: 'row' }, prompt, row.before ? typed(row.before, row.start, 'b') : h(Text, { wrap: 'truncate' }, ''));
                // The caret sits ON the first suggested character, as a shell's
                // autosuggestion does, so what was typed and what is offered read as one
                // word: `/co` + `mpact`. The offer is the accent colour, dimmed; the
                // other candidates follow, and ⇥ says which key takes them.
                const caretAt = row.start + row.before.length;
                const offer = ghost
                  ? [h(Text, { key: 'g0', inverse: true, dim: true, color: m.accent }, ghost[0]),
                     h(Text, { key: 'g1', dim: true, color: m.accent }, ghost.slice(1))]
                  : [h(Text, { key: 'c', inverse: true, ...(tokens.some((t) => t.start <= caretAt && caretAt < t.end) ? { color: m.accent } : {}) }, row.caret)];
                return h(Box, { key: i, flexDirection: 'row' },
                  prompt,
                  ...(row.before ? typed(row.before, row.start, 'b') : []),
                  ...offer,
                  // The offered candidate's label (a session's title beside its
                  // number): said, dim, never part of the text.
                  label ? h(Text, { wrap: 'truncate', dim: true }, ` ${label}`) : null,
                  others.length ? h(Text, { wrap: 'truncate', dim: true }, `  ${CAP.tab} ${others.join(' · ')}`) : null,
                  input === ''
                    ? h(Text, { wrap: 'truncate', dim: true }, bangLevel === 2
                        ? ` ${CAP.enter} run with the terminal · ${CAP.backspace} on empty back to !`
                        : bangLevel === 1
                        ? ` ${CAP.enter} run · ! again gets the terminal · ${CAP.backspace} on empty leaves ! mode`
                        : streaming ? ` an answer is coming — ${CAP.enter} queues your next message` : ` ${CAP.enter} send · ${NEWLINE_KEY} new line · ${CAP.esc} ${CAP.esc} ${escWord}`)
                    // Text after the caret is the person's own text — drawn like the rest
                    // of it, never the placeholder's dim, or it would grey out whenever
                    // the caret moved back.
                    : row.after ? typed(row.after, caretAt + row.caret.length, 'a') : null);
              })),
      ),
    ),
  );
}

// ─── The chat, collapsed ──────────────────────────────────────────────────────
// A docked chat folded away still says what its turn is doing: on the plugin's bottom
// row when the panel was on the right, on the one row a bottom panel keeps. The same
// facts as the chat's own status line — the spinner, the seconds of what runs now, the
// tool or the request's word with the same shimmer — and the key that brings it back.
// Null when nothing runs. A y/n or a question the turn is waiting on wins over all of
// it: folding the chat away is not an answer, and the person is the one holding it up.
export function renderChatStatus({ theme, streaming, toolLabel = '', phase = 'writing', verb = '', elapsed = 0, keyHint = '', waiting = false }: {
  theme: Theme | undefined;
  streaming: boolean;
  toolLabel?: string;
  phase?: 'thinking' | 'writing';
  verb?: string;
  elapsed?: number;
  // `^] chat` — from the binding, empty when it is unbound.
  keyHint?: string;
  // A y/n or a question is pending.
  waiting?: boolean;
}) {
  const m = (theme?.modals?.chat ?? {}) as Record<string, string | undefined>;
  if (waiting) {
    return h(Text, { key: 'chat-status', color: m.warn, wrap: 'truncate', selectable: false }, `? waiting for you${keyHint ? ` · ${keyHint}` : ''}`);
  }
  if (!streaming && !toolLabel) return null;
  return h(Box, { key: 'chat-status', flexDirection: 'row', flexShrink: 0, selectable: false },
    h(Text, { dim: true }, `${spin(elapsed)} ${fmtSec(elapsed)} · `),
    h(Shimmer, {
      color: toolLabel ? (m.accent ?? 'cyan') : phase === 'thinking' ? 'magenta' : (m.assistantAccent ?? 'green'),
      highlight: TOOL_PULSE(m), width: 4, interval: 70, direction: 'ltr', running: true,
      children: toolLabel || `${verb || VERBS[0]}…`,
    }),
    keyHint ? h(Text, { dim: true }, ` · ${keyHint}`) : null);
}

// The collapsed chat's status as the App draws it on the plugin's footer row: a
// component that redraws ITSELF as the seconds tick, reading the chat's latest status
// through `read` — so a running turn does not redraw the whole App, the plugin's
// surface with it, several times a second. `live` false (a status that does not change
// by itself: waiting on the person) sets no timer. Module-level, so its type is stable
// and it is never mounted anew.
function LiveStatus({ read, live }: { read: () => ReactNode; live: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick((n) => n + 1), 120);
    return () => clearInterval(t);
  }, [live]);
  return (read() ?? null) as never;
}
export const liveChatStatus = (read: () => ReactNode, live: boolean) => h(LiveStatus, { key: 'chat-status', read, live });

// The one row a collapsed bottom panel keeps: the chat's name, and either its running
// turn's status or how to bring it back.
export function renderChatStrip({ width, theme, status, keyHint = '', unread = 0 }: {
  width: number;
  theme: Theme | undefined;
  status: ReactNode;
  keyHint?: string;
  unread?: number;
}) {
  const m = (theme?.modals?.chat ?? {}) as Record<string, string | undefined>;
  return h(Box, { width, height: 1, flexDirection: 'row', backgroundColor: m.bg, overflow: 'hidden', selectable: false },
    h(Text, { bold: true, color: m.assistantAccent }, ` ${ASSISTANT_MARK} `),
    h(Text, { bold: true }, 'Flow Assist'),
    unread ? h(Text, { color: m.bgAccent }, ` · ◆ ${unread} new`) : null,
    status
      ? [h(Text, { key: 'sep', dim: true }, ' · '), status]
      : keyHint ? h(Text, { dim: true, wrap: 'truncate' }, ` · ${keyHint}`) : null);
}

// `/context` — the window as a field of cells beside a legend, in the field's place
// like a write confirmation: a look at the conversation, not a message in it. The
// colours only tell the parts apart; the legend carries the same glyph in the same
// colour, so it reads without them too (each row names its part).
const PART_COLORS: Record<string, string> = {
  instructions: 'cyan', tools: 'magenta', memory: 'yellow', plan: 'green', summary: 'blue', 'on screen': 'greenBright', messages: 'white', images: 'cyanBright',
};
function renderContextPanel(r: ContextReading, bg: string | undefined, wrap: number, cacheLine = '', recallLine = '') {
  const cells = contextGrid(r);
  const warn = r.ratio >= CONTEXT_WARN_AT;
  const gridRows = Array.from({ length: GRID_ROWS }, (_, y) => cells.slice(y * GRID_COLS, (y + 1) * GRID_COLS));
  const cell = (c: GridCell, i: number) => h(Text, c.label ? { key: i, color: PART_COLORS[c.label] } : { key: i, dim: true }, `${c.glyph} `);
  const grid = h(Box, { flexDirection: 'column', flexShrink: 0 },
    gridRows.map((row, y) => h(Box, { key: y, flexDirection: 'row' }, row.map(cell))));
  const legend = h(Box, { flexDirection: 'column', flexShrink: 1 },
    contextLegend(r).map((l, i) => h(Box, { key: i, flexDirection: 'row' },
      h(Text, l.label ? { color: PART_COLORS[l.label] } : { dim: true }, `${l.label ? CELL_FULL : CELL_FREE} `),
      h(Text, { wrap: 'truncate' }, l.text))));
  // The grid is 40 cells wide; beside it the legend needs ~26. Narrower — stack them.
  const sideBySide = wrap >= GRID_COLS * 2 + 30;
  return h(Box, { flexDirection: 'column', width: '100%', gap: 1, border: 'round', paddingX: 1, borderColor: warn ? 'yellow' : undefined, backgroundColor: bg },
    h(Box, { flexDirection: 'row' },
      h(Text, { bold: true }, 'Context  '),
      h(Text, warn ? { color: 'yellow' } : {}, contextHeading(r))),
    h(Box, { flexDirection: sideBySide ? 'row' : 'column', gap: sideBySide ? 3 : 1 }, grid, legend),
    h(Text, { dim: true, wrap: 'truncate' }, contextFootnote(r)),
    cacheLine ? h(Text, { dim: true, wrap: 'truncate' }, cacheLine) : null,
    recallLine ? h(Text, { dim: true, wrap: 'truncate' }, recallLine) : null,
    h(Text, { dim: true, wrap: 'truncate', selectable: false }, `/compact summarises · /clear starts over · window: ai.contextWindow · ${CAP.esc} / ${CAP.enter} close`));
}

// The question's free-text row: its prompt, indented under the options, and the width
// the field is drawn in. The key handler is given the same width, so what the caret
// does and what is drawn cannot drift apart (the chat's field keeps `chatFieldWidth`
// for the same reason).
const ASK_PROMPT = '     › ';
export const askFieldWidth = (wrap: number) => Math.max(10, wrap - ASK_PROMPT.length - 2);

// The question block's pieces, shared by its render and by the count of its rows
// (`pendingChatRows`), so the two cannot drift apart.
function askView(state: AskState, wrap: number) {
  const q = state.questions[state.index]!;
  const many = state.questions.length > 1 ? `${state.index + 1}/${state.questions.length} · ` : '';
  // The hint says the rule the list itself cannot: the digits pick, and anything else
  // typed starts an answer in the person's own words.
  const hint = state.typing
    ? `${CAP.enter} submit · ${CAP.esc} back to the list`
    : q.multiSelect
      ? `${CAP.upDown} move · ${CAP.space} toggle · ${CAP.enter} confirm · type your own words · ${CAP.esc} dismiss`
      : `${CAP.upDown} move · ${CAP.enter} or a digit to answer · type your own words · ${CAP.esc} dismiss`;
  return {
    q,
    title: `? ${many}${q.header ? `${q.header} — ` : ''}${q.question}`,
    rows: askRows(state),
    hint,
    // The field is an editor, so it has a caret of its own to draw — wherever it is in
    // the text, not always at the end.
    fieldRows: state.typing ? inputVisualRows(state.text, state.caret, askFieldWidth(wrap)) : [],
  };
}

// The y/n block's pieces, the same way.
function confirmView(c: { name: string; args?: string | unknown; command?: string }) {
  return {
    title: `⚠ Confirm write: ${c.name}`,
    command: c.command != null ? `$ ${c.command.length > 1000 ? `${c.command.slice(0, 1000)}…` : c.command}` : null,
    args: typeof c.args === 'string'
      ? (c.args.length > 120 ? `${c.args.slice(0, 120)}…` : c.args)
      : JSON.stringify(c.args ?? ''),
    hint: `Press y to confirm · n to decline · ${CAP.esc} to cancel`,
  };
}

// How many rows a wrapping text takes at `width` columns, as a Text lays it out.
const textRows = (text: string, width: number) => Math.max(1, wrapText(text, Math.max(1, width), 'wrap').length);

// How many rows the chat needs to show a pending question or y/n WHOLE, in a frame
// `width` columns wide that fills its area (a docked panel): the frame and its padding,
// one row of conversation, the status row, the plan and the queue line when they are
// up, the block — and the gaps between them. 0 when nothing is pending. The App grows a
// bottom panel to it, and draws the chat as a window while it is pending when even that
// would leave the plugin less than its least (src/runtime/panel-layout.ts).
export function pendingChatRows({ width, question, confirm, todo, queued = 0 }: {
  width: number;
  question?: AskState | null;
  confirm?: { name: string; args?: string | unknown; command?: string } | null;
  todo?: PlanItem[] | null;
  queued?: number;
}): number {
  if (!question && !confirm) return 0;
  const wrap = chatWrapWidth(width, true);
  const block = question ? askBlockRows(question, wrap) : confirmBlockRows(confirmView(confirm!), wrap);
  const planRows = question ? 0 : planBlockRows(planView(todo ?? []));
  const parts = [1, 1, planRows, queued ? 1 : 0, block].filter((n) => n > 0);
  // The frame's border and padding, the parts, a gap between each two.
  return 4 + parts.reduce((a, b) => a + b, 0) + parts.length - 1;
}

// The rows of the blocks that take the field's place, counted from the pieces their
// renders draw. Inside a block: its border and its paddingX, two columns each side.
function askBlockRows(state: AskState, wrap: number): number {
  const v = askView(state, wrap);
  const inner = wrap - 2;
  return 2 + textRows(v.title, inner) + v.rows.reduce((n, r) => n + 1 + (r.description ? 1 : 0), 0) + v.fieldRows.length + textRows(v.hint, inner);
}
function confirmBlockRows(v: ReturnType<typeof confirmView>, wrap: number): number {
  const inner = wrap - 2;
  // Three pieces with a gap between each.
  return 2 + 1 + 1 + (v.command != null ? textRows(v.command, inner) : 1) + 1 + textRows(v.hint, inner);
}
function contextPanelRows(r: ContextReading, wrap: number, cacheLine: string, recallLine = ''): number {
  const legend = contextLegend(r).length;
  const body = wrap >= GRID_COLS * 2 + 30 ? Math.max(GRID_ROWS, legend) : GRID_ROWS + 1 + legend;
  // The heading, the grid with its legend, the footnote, the cache line, the recall
  // line, the hint — a gap between each two — inside a border.
  const parts = [1, body, 1, cacheLine ? 1 : 0, recallLine ? 1 : 0, 1].filter((n) => n > 0);
  return 2 + parts.reduce((a, b) => a + b, 0) + parts.length - 1;
}

function renderAsk(state: AskState, bg: string | undefined, wrap: number) {
  const { q, title, rows, hint, fieldRows } = askView(state, wrap);
  const mark = (r: AskRow) => (q.multiSelect && !r.other ? (r.picked ? '[x]' : '[ ]') : r.active ? ' ❯ ' : '   ');
  return h(Box, { flexDirection: 'column', width: '100%', border: 'round', paddingX: 1, borderColor: 'cyan', backgroundColor: bg },
    h(Text, { bold: true, color: 'cyan', wrap: 'wrap' }, title),
    ...rows.map((r, i) => h(Box, { key: i, flexDirection: 'column' },
      h(Text, { bold: r.active, inverse: r.active && !state.typing, wrap: 'truncate' }, `${mark(r)} ${i + 1}. ${r.label}`),
      r.description ? h(Text, { dim: true, wrap: 'truncate' }, `       ${r.description.slice(0, Math.max(10, wrap - 8))}`) : null)),
    state.typing
      ? h(Box, { flexDirection: 'column' }, fieldRows.map((row, i) =>
          h(Box, { key: `f${i}`, flexDirection: 'row' },
            h(Text, null, i === 0 ? ASK_PROMPT : ' '.repeat(ASK_PROMPT.length)),
            h(Text, { wrap: 'truncate' }, row.before),
            row.caret !== '' ? h(Text, { inverse: true }, row.caret) : null,
            h(Text, { wrap: 'truncate' }, row.after))))
      : null,
    h(Text, { dim: true, selectable: false }, hint));
}

// One look for every host modal: the chat's — a round frame in the modal palette, a
// plain title, a quiet hint line at the bottom. A modal that draws its own frame
// instead doubles up, so one product looks like two.
const frame = (m: Record<string, string | undefined>, title: string, extra: Record<string, unknown>) => ({
  border: 'round' as const,
  backgroundColor: m.bg,
  // Its own ink on its own ground, as in the chat.
  color: m.text,
  borderBackgroundColor: m.borderBg,
  borderColor: m.border,
  borderTitle: title,
  paddingX: 1,
  flexDirection: 'column' as const,
  overflow: 'hidden' as const,
  // A drag inside the window stays inside it: never onto its border, never onto the
  // dimmed screen behind.
  selectionScope: true,
  ...extra,
});

// ─── Log modal (pure render) ───────────────────────────────────────────────────
// What a line is decides how loud it is: a failure is red, a background task's line
// carries the background's colour, the model-round bookkeeping is dim, and the time
// stamp is always quiet so the message is what the eye lands on.
function logLine(line: string, m: Record<string, string | undefined>, errorColor?: string) {
  const at = /^(\d\d:\d\d:\d\d) ([\s\S]*)$/.exec(line);
  const stamp = at ? at[1] : '';
  const text = at ? at[2]! : line;
  const failed = /error|failed|⚠|denied|declined/i.test(text);
  const quiet = /^\[round \d+\]/.test(text);
  const color = failed ? errorColor ?? 'red' : /^\[bg\]/.test(text) ? 'magenta' : text.startsWith('⏰') ? 'yellow' : m.text;
  return [
    stamp ? h(Text, { key: 's', dim: true }, `${stamp} `) : null,
    h(Text, { key: 't', wrap: 'truncate', dim: quiet, color }, text),
  ];
}

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
  const more = total > visible.length;
  const title = more ? `Log · ${start + 1}–${start + visible.length} of ${total}` : total ? `Log · ${total}` : 'Log';
  return h(Box, overlay(width, height),
    // As tall as what it holds: a fixed frame would leave two lines sitting in a box made for forty.
    h(Box, frame(m, title, { width: Math.max(40, Math.floor(width * 0.7)), paddingY: 1, gap: 1 }),
      h(Box, { flexDirection: 'column' },
        visible.length
          ? visible.map((line, index) => h(Box, { key: start + index, flexDirection: 'row' }, logLine(line, m, theme?.error)))
          : h(Text, { dim: true }, 'Nothing has happened yet — tool calls, background tasks and errors land here.')),
      h(Text, { dim: true, selectable: false }, `${more ? `${CAP.upDown} ${CAP.page} scroll · Home/End · ` : ''}${CAP.esc} close`),
    ),
  );
}

// ─── Help modal (pure render) ──────────────────────────────────────────────────
// Two things a person asks of :help — which KEYS work, and which COMMANDS exist. It
// listed commands only (the keys were nowhere), listed the host's commands twice (the
// second time with `undefined` for a description), truncated what it said, put a
// blank row under every entry, and on an ordinary terminal ran off both ends of the
// screen with no way to scroll.
interface HelpCommand { name: string; usage?: string; aliases?: string[]; description?: string }

// One entry per command a person can TYPE: keyed by the bare name (a plugin's
// `core:quit` and the host's `quit` are the same word), the described one winning.
export function helpEntries(commands: HelpCommand[]): { usage: string; description: string }[] {
  const byName = new Map<string, HelpCommand>();
  for (const c of commands) {
    const bare = c.name.includes(':') ? c.name.slice(c.name.lastIndexOf(':') + 1) : c.name;
    const had = byName.get(bare);
    if (!had || (!had.description && c.description)) byName.set(bare, { ...c, name: bare });
  }
  return [...byName.values()]
    .filter((c) => c.description)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => {
      const alias = (c.aliases ?? []).filter((a) => a !== c.name).join(', ');
      return { usage: `${c.usage ?? c.name}${alias ? `  (${alias})` : ''}`, description: String(c.description) };
    });
}

// What an action does, in words. The host's own are named here; a plugin's action is
// read from its name (`boardPicker` → "board picker").
const ACTION_LABELS: Record<string, string> = {
  commandLine: 'command line', quit: 'quit', back: 'back / close', prev: 'previous', next: 'next',
  open: 'open', openBrowser: 'open in the browser', clearCache: 'flush the cache', chat: 'talk to the assistant', log: 'the log',
};
// Keys the HOST acts on from anywhere. Everything else in the key map belongs to a
// plugin's own screen (`prev`/`next`/`open`/`openBrowser` are shared bindings the host
// merely defines a default for) — listed separately, because on the start screen they
// do nothing and a key in a help list is an instruction.
const HOST_ACTIONS = ['chat', 'commandLine', 'log', 'back', 'quit'];
const actionLabel = (action: string) => ACTION_LABELS[action] ?? action.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

export function renderHelp({
  width,
  height,
  theme,
  helpOpen,
  commands = [],
  keys = {},
}: {
  width: number;
  height: number;
  theme: Theme | undefined;
  helpOpen: boolean;
  commands?: HelpCommand[];
  keys?: Record<string, string[]>;
}) {
  if (!helpOpen) return null;
  const m = (theme?.modals ?? {}) as unknown as Record<string, string | undefined>;
  const boxW = Math.min(84, width - 8);
  const inner = boxW - 4;
  const bound = Object.entries(keys).map(([action, binding]) => ({ action, cap: bindingGlyph(binding), label: actionLabel(action) })).filter((k) => k.cap);
  const capW = Math.max(0, ...bound.map((k) => stringWidth(k.cap)));
  const anywhere = HOST_ACTIONS.map((a) => bound.find((k) => k.action === a)).filter((k): k is (typeof bound)[number] => !!k);
  const inPlugins = bound.filter((k) => !HOST_ACTIONS.includes(k.action));
  const keyRow = (k: (typeof bound)[number]) => h(Box, { key: `k-${k.action}`, flexDirection: 'row', flexShrink: 0 },
    h(Text, { bold: true, color: 'cyan' }, `  ${k.cap}${' '.repeat(Math.max(0, capW - stringWidth(k.cap)))}  `),
    h(Text, null, k.label));
  const entries = helpEntries(commands);
  // The usage column is as wide as most usages need; one longer than that (`config
  // [get <key>|set …]`) takes a row of its own and its description goes beneath.
  const usageW = Math.min(26, Math.max(0, ...entries.map((e) => stringWidth(e.usage))));
  // −2: the scrollbar takes the last column, and a space keeps the text off it.
  const descW = Math.max(20, inner - usageW - 5);
  const heading = (text: string) => h(Text, { key: `h-${text}`, bold: true, color: m.border }, text);
  return h(Box, overlay(width, height),
    h(Box, frame(m, 'Help', { width: boxW, maxHeight: height - 4, paddingY: 1, gap: 1 }),
      // Everything scrolls as one page: PgUp/PgDn and the wheel are the scroll box's own.
      // The scrollbar is how a person learns the list goes on below the frame.
      h(ScrollBox, { flexGrow: 1, flexShrink: 1, flexDirection: 'column', scrollbar: true },
        heading('Keys — anywhere'),
        anywhere.map(keyRow),
        h(Box, { key: 'gap0', height: 1, flexShrink: 0 }),
        inPlugins.length ? heading("Keys — on a plugin's own screen") : null,
        inPlugins.map(keyRow),
        inPlugins.length ? h(Box, { key: 'gap1', height: 1, flexShrink: 0 }) : null,
        heading('Commands — type : first'),
        entries.map((e) => (stringWidth(e.usage) > usageW
          ? h(Box, { key: `c-${e.usage}`, flexDirection: 'column', flexShrink: 0 },
              h(Text, { bold: true, wrap: 'truncate' }, `  ${e.usage}`),
              h(Box, { marginLeft: usageW + 4, width: descW }, h(Text, { dim: true, wrap: 'wrap' }, e.description)))
          : h(Box, { key: `c-${e.usage}`, flexDirection: 'row', flexShrink: 0 },
              h(Text, { bold: true }, `  ${e.usage}${' '.repeat(Math.max(0, usageW - stringWidth(e.usage)))}  `),
              h(Box, { width: descW }, h(Text, { dim: true, wrap: 'wrap' }, e.description)))))),
      h(Text, { dim: true, selectable: false }, `${CAP.page} or the wheel scroll · ${CAP.esc} close`),
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
  const w = Math.min(Math.max(40, stringWidth(text) + 8), width - 8);
  // Above the other modals: a reminder may fire while the chat is open.
  return h(Box, overlay(width, height, 20),
    h(Box, {
      // Round, like every other window — it was the one double frame on screen.
      border: 'round',
      backgroundColor: m.bg,
      color: m.text,
      borderBackgroundColor: m.borderBg,
      borderColor: m.border,
      borderTitle: 'reminder',
      width: w,
      padding: 1,
      flexDirection: 'column',
      gap: 1,
      selectionScope: true,
    },
      h(Text, { wrap: 'wrap' }, text ?? ''),
      h(Text, { dim: true, selectable: false }, `${CAP.esc} / ${CAP.enter} — dismiss`),
    ),
  );
}