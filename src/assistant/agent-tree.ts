// The agent tree as `/agents` lists it (ask-children-spec.md (agent tree)): `agentsPanelRows` —
// the live nodes, then the ones that ended, each with its state — and `stopQuestion`, what
// the panel asks before a stop. Pure: the panel draws what these return.
import type { PanelRow } from './command-panel.js';
import type { EndedChild, TreeNode } from './conversation-types.js';
import { formatDuration } from './duration.js';

// The wait of a delayed node, to the minute and rounded up: a row with a clock would
// redraw an idle panel.
function inTime(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60000));
  const h = Math.floor(min / 60);
  return h ? `${h}h${min % 60 ? ` ${min % 60}m` : ''}` : `${min}m`;
}

// A background shell is drawn with a mark of its own.
const SHELL_MARK = '○';
const MARK: Record<TreeNode['status'], string> = { waiting: '⏸', asks: '?', working: '⚙', queued: '○', delayed: '○', idle: '◦' };
// How a row is coloured: what waits on the person is the warn colour, what works the work
// one, the rest dim.
type TTone = 'warn' | 'work' | 'dim';
const TONE: Record<TreeNode['status'], TTone> = { waiting: 'warn', asks: 'warn', working: 'work', queued: 'dim', delayed: 'dim', idle: 'dim' };
const toneOf = (n: TreeNode): TTone => (n.status === 'idle' && n.answered ? 'warn' : TONE[n.status]);

// A shell's time, to the minute and rounded down: `<1m`, `4m`, `1h 2m` — a row with a seconds
// clock would redraw an idle panel.
function spanOf(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60000);
  if (min < 1) return '<1m';
  const h = Math.floor(min / 60);
  return h ? `${h}h${min % 60 ? ` ${min % 60}m` : ''}` : `${min}m`;
}
// What a background shell says of itself after its id and command: how it runs or ended, and
// how many lines it has printed.
function shellState(n: TreeNode): string {
  const sh = n.shell!;
  const how = sh.running ? `running ${spanOf(sh.ms)}` : sh.state.replace(/^killed \(.*\)$/, 'killed');
  return how;
}
const linesText = (n: number): string => `${n} ${n === 1 ? 'line' : 'lines'}`;
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

function stateOf(n: TreeNode, now: number): string {
  if (n.shell) return shellState(n);
  if (n.status === 'waiting') return 'waiting for a y/n';
  if (n.status === 'asks') return 'asks its parent';
  if (n.status === 'working') return n.latest || 'working';
  if (n.status === 'delayed') return `in ${inTime(Math.max(0, (n.until ?? now) - now))}`;
  if (n.status === 'idle') return n.answered ? 'answered' : 'idle';
  return 'queued';
}

// What a node does, with its mark: the words of its row after the label. The watch's hint
// row says the same (ask-children-spec.md (watching a child)).
export function nodeState(n: TreeNode, now = Date.now()): string {
  return `${n.shell ? SHELL_MARK : MARK[n.status]} ${stateOf(n, now)}`;
}

// How a listing words the end of a child: an answer is `done`, the rest by their name.
export function endedVerdict(outcome: string): string {
  return outcome === 'answer' ? 'done' : outcome;
}

// The question that stands in place of a row before a stop; `y` stops the node and what it started.
export function stopQuestion(node: Pick<TreeNode, 'label' | 'below'> & { kind?: TreeNode['kind'] }): string {
  if (node.kind === 'shell') return `kill ${node.label}? y yes · n no`;
  return `stop ${node.label}${node.below ? ` and ${node.below} below it` : ''}? y yes · n no`;
}

// An ended shell as `/agents` lists it: its words are the job's own (`exited 0`, `killed (person)`).
export interface EndedShell { id: string; command: string; state: string; ms: number; lines: number }

// `/agents`: the whole tree in the panel's rows. The live nodes first in tree order, indented,
// each with its state and the time it has spent; then the ended ones as the listing words
// them. A live row's id is its node key, an ended row's `ended:<n>`. `asking`: the key of a
// node whose stop question is up, drawn in place of that row's text. `chatModel`: the model
// the conversation itself sends — a node running another names it in its detail.
export function agentsPanelRows(nodes: readonly TreeNode[], ended: readonly EndedChild[], now = Date.now(), asking: string | null = null, endedShells: readonly EndedShell[] = [], chatModel?: string): PanelRow[] {
  const rows: PanelRow[] = nodes.map((n): PanelRow => {
    if (n.key === asking) return { id: n.key, text: stopQuestion(n), tone: 'warn' };
    if (n.shell) {
      return {
        id: n.key,
        text: `${'  '.repeat(n.depth - 1)}${SHELL_MARK} ${n.label} · ${oneLine(n.shell.command)}`,
        detail: `${shellState(n)} · ${linesText(n.shell.lines)}`,
        ...(toneOf(n) === 'warn' ? { tone: 'warn' as const } : {}),
      };
    }
    const task = n.kind === 'task' ? ' (task)' : '';
    const spent = n.startedAt !== null ? ` · ${formatDuration(Math.max(0, now - n.startedAt))}` : '';
    const model = n.model && n.model !== chatModel ? ` · ${n.model}` : '';
    return {
      id: n.key,
      text: `${'  '.repeat(n.depth - 1)}${MARK[n.status]} ${n.label}${task}`,
      detail: `${stateOf(n, now)}${spent}${model}`,
      ...(toneOf(n) === 'warn' ? { tone: 'warn' as const } : {}),
    };
  });
  ended.forEach((e, i) => {
    const verdict = endedVerdict(e.outcome);
    const tokens = e.tokens ? ` · ${e.tokens >= 1e6 ? `${(e.tokens / 1e6).toFixed(1)}M` : e.tokens >= 1000 ? `${Math.round(e.tokens / 1000)}k` : e.tokens} tokens` : '';
    rows.push({ id: `ended:${i}`, text: `${e.label}${e.kind === 'task' ? ' (task)' : ''}`, detail: `${verdict} · ${formatDuration(e.ms)}${tokens}` });
  });
  // The shells that ended and are not rows above (opened, or ended by the person), as the
  // ended children are: their output opens in the pager.
  for (const e of endedShells) {
    rows.push({ id: `endedjob:${e.id}`, text: `${SHELL_MARK} ${e.id} · ${oneLine(e.command)}`, detail: `${e.state.replace(/^killed \(.*\)$/, 'killed')} · ${formatDuration(e.ms)} · ${linesText(e.lines)}` });
  }
  return rows;
}
