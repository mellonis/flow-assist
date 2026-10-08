// The agent tree as rows (AGENTS.md (agent tree)): which live descendants of a conversation
// are drawn under its field, what a row says, where the cursor goes when the rows change,
// and the question that guards a stop. Pure: the chat draws what these return.
import { cutStep } from '../cells.js';
import type { PanelRow } from './command-panel.js';
import type { EndedChild, TreeNode } from './conversation-types.js';
import { formatDuration } from './duration.js';

// One drawn row. `key` is the node's conversation key ('' for the `+K more` row, which is
// not a stop of the cursor); `tone` is how the chat colours it.
export interface TreeRow { key: string; text: string; tone: 'warn' | 'work' | 'dim' }

export const AGENT_ROWS_DEFAULT = 4;
export const AGENT_ROWS_MAX = 8;

// `ui.agentRows`: how many rows the tree may take under the field. 0 draws none.
export function agentRowsOf(config: Record<string, unknown>): number {
  const v = (config.ui as { agentRows?: unknown } | undefined)?.agentRows;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= AGENT_ROWS_MAX ? v : AGENT_ROWS_DEFAULT;
}

// The wait of a delayed node, to the minute and rounded up: a row with a clock would
// redraw an idle chat.
function inTime(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60000));
  const h = Math.floor(min / 60);
  return h ? `${h}h${min % 60 ? ` ${min % 60}m` : ''}` : `${min}m`;
}

const MARK: Record<TreeNode['status'], string> = { waiting: '⏸', working: '⚙', queued: '○', delayed: '○' };
const TONE: Record<TreeNode['status'], TreeRow['tone']> = { waiting: 'warn', working: 'work', queued: 'dim', delayed: 'dim' };
// Who is kept when the rows run out: what waits for the person first, then what works.
const ATTENTION: Record<TreeNode['status'], number> = { waiting: 0, working: 1, queued: 2, delayed: 2 };

function stateOf(n: TreeNode, now: number): string {
  if (n.status === 'waiting') return 'waiting for a y/n';
  if (n.status === 'working') return n.latest || 'working';
  if (n.status === 'delayed') return `in ${inTime(Math.max(0, (n.until ?? now) - now))}`;
  return 'queued';
}

// The rows for `nodes` (tree order), at most `max` of them, each one terminal line of
// `width` cells. With more nodes than rows the last row is `+K more — /agents` and the
// kept nodes are the ones that need attention, waiting then working then the rest, each
// group in tree order and the result in tree order again; a kept node keeps its
// indentation and a cut parent is not drawn for it. `more` is K.
export function treeRows(nodes: readonly TreeNode[], max: number, width: number, now = Date.now()): { rows: TreeRow[]; more: number } {
  if (max <= 0 || !nodes.length) return { rows: [], more: 0 };
  const over = nodes.length > max;
  let kept = nodes.map((n, i) => ({ n, i }));
  if (over) {
    kept = kept.sort((a, b) => ATTENTION[a.n.status] - ATTENTION[b.n.status] || a.i - b.i).slice(0, max - 1).sort((a, b) => a.i - b.i);
  }
  const rows = kept.map(({ n }): TreeRow => {
    const task = n.kind === 'task' ? ' (task)' : '';
    const text = `${'  '.repeat(n.depth - 1)}${MARK[n.status]} ${n.label}${task} · ${stateOf(n, now)}`;
    return { key: n.key, text: cutStep(text, width), tone: TONE[n.status] };
  });
  const more = nodes.length - kept.length;
  if (over) rows.push({ key: '', text: cutStep(`+${more} more — /agents`, width), tone: 'dim' });
  return { rows, more: over ? more : 0 };
}

// Where the cursor stands after the rows changed: on the same node, else on the row
// nearest the place it left, else nowhere (null) — also when it was in the field.
export function treeCursor(prevKey: string | null, prevIndex: number, rows: readonly TreeRow[]): string | null {
  if (prevKey === null) return null;
  const stops = rows.filter((r) => r.key !== '');
  if (!stops.length) return null;
  const same = stops.find((r) => r.key === prevKey);
  if (same) return same.key;
  return stops[Math.min(Math.max(prevIndex, 0), stops.length - 1)]!.key;
}

// The question that stands in place of the cursor's row before a stop; `y` stops the node and what it started.
export function stopQuestion(node: Pick<TreeNode, 'label' | 'below'>): string {
  return `stop ${node.label}${node.below ? ` and ${node.below} below it` : ''}? y yes · n no`;
}

// `/agents`: the whole tree in the panel's rows. The live nodes first in tree order, indented,
// each with its state and the time it has spent; then the ended ones as the listing words
// them. A live row's id is its node key, an ended row's `ended:<n>`. `asking`: the key of a
// node whose stop question is up, drawn in place of that row's text.
export function agentsPanelRows(nodes: readonly TreeNode[], ended: readonly EndedChild[], now = Date.now(), asking: string | null = null): PanelRow[] {
  const rows: PanelRow[] = nodes.map((n): PanelRow => {
    if (n.key === asking) return { id: n.key, text: stopQuestion(n), tone: 'warn' };
    const task = n.kind === 'task' ? ' (task)' : '';
    const spent = n.startedAt !== null ? ` · ${formatDuration(Math.max(0, now - n.startedAt))}` : '';
    return {
      id: n.key,
      text: `${'  '.repeat(n.depth - 1)}${MARK[n.status]} ${n.label}${task}`,
      detail: `${stateOf(n, now)}${spent}`,
      ...(n.status === 'waiting' ? { tone: 'warn' as const } : {}),
    };
  });
  ended.forEach((e, i) => {
    const verdict = e.outcome === 'answer' ? 'done' : e.outcome;
    const tokens = e.tokens ? ` · ${e.tokens >= 1e6 ? `${(e.tokens / 1e6).toFixed(1)}M` : e.tokens >= 1000 ? `${Math.round(e.tokens / 1000)}k` : e.tokens} tokens` : '';
    rows.push({ id: `ended:${i}`, text: `${e.label}${e.kind === 'task' ? ' (task)' : ''}`, detail: `${verdict} · ${formatDuration(e.ms)}${tokens}` });
  });
  return rows;
}
