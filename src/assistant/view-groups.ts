// Consecutive commands fold under ONE head. A model runs a command per round and
// writes a `Next:` line before each, so five commands are five blocks with a step
// line before each — a column of grey. Consecutive console views of one turn (no
// other call between them: their `seq` are consecutive) are drawn as one line,
// `ƒ Ran 3 commands · ✓ 34 s`, which takes the place of their step lines; opened, the
// commands alone, each its own block. The narration-only messages before and between
// them are not drawn, open or folded.
//
// Pure: works on the DRAWN messages (the system prompt is not one), by index — the
// same `at` fold ids are built from.
import { clickedOpen, foldId, isOpen, type FoldState } from './folds.js';
import { isConsoleKind, type ViewRecord } from './views.js';

export interface ViewGroup { head: number; members: number[]; hidden: number[] }
export type GroupMsg = { role: string; content?: unknown; views?: unknown; toolRuns?: unknown; changes?: unknown; roundLimit?: unknown; stopped?: unknown };

const consoleOf = (m: GroupMsg): ViewRecord | null => {
  if (m.role !== 'view' || !Array.isArray(m.views) || m.views.length !== 1) return null;
  const r = m.views[0] as ViewRecord;
  return isConsoleKind(r.kind) && typeof r.seq === 'number' && typeof r.turn === 'number' ? r : null;
};
// A message a group may take in: the narration of a round that went on to a call —
// nothing answered, nothing changed, no trail, nothing about how a turn ended.
const passable = (m: GroupMsg | undefined) => !!m && m.role === 'assistant' && !String(m.content ?? '').trim()
  && !(Array.isArray(m.toolRuns) && m.toolRuns.length) && !(Array.isArray(m.changes) && m.changes.length) && !m.roundLimit && !m.stopped;

export function viewGroups(drawn: GroupMsg[]): ViewGroup[] {
  const groups: ViewGroup[] = [];
  let cur: { g: ViewGroup; last: ViewRecord; between: number[] } | null = null;
  const close = () => { if (cur && cur.g.members.length > 1) groups.push(cur.g); cur = null; };
  drawn.forEach((m, i) => {
    const rec = consoleOf(m);
    if (rec) {
      if (cur && rec.turn === cur.last.turn && rec.seq === cur.last.seq! + 1) {
        cur.g.members.push(i);
        cur.g.hidden.push(...cur.between);
        cur.between = [];
        cur.last = rec;
        return;
      }
      close();
      // The step line just before the first command is the group's too: the head
      // takes the place of all of them.
      const before = passable(drawn[i - 1]) ? [i - 1] : [];
      cur = { g: { head: i, members: [i], hidden: before }, last: rec, between: [] };
      return;
    }
    if (cur && passable(m)) { cur.between.push(i); return; }
    close();
  });
  close();
  return groups;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function groupHeadText(recs: ViewRecord[], now: number): { text: string; color?: 'warn' }[] {
  const n = recs.length;
  const running = recs.find((r) => r.phase === 'live');
  if (running) {
    const cmd = String((running.data as { command?: unknown })?.command ?? '');
    return [{ text: `Running ${n} commands · $ ${cmd} · ${Math.floor(Math.max(0, now - running.startedAt) / 1000)} s` }];
  }
  const total = recs.reduce((t, r) => t + Number((r.data as { ms?: unknown })?.ms ?? 0), 0);
  const failed = recs.filter((r) => r.phase === 'failed' || (r.data as { exitCode?: unknown })?.exitCode !== 0).length;
  return failed
    ? [{ text: `Ran ${n} commands · ` }, { text: `✗ ${failed} failed`, color: 'warn' }, { text: ` · ${secs(total)}` }]
    : [{ text: `Ran ${n} commands · ✓ ${secs(total)}` }];
}

// Open when its own id says so, or when the person opened one of its members with a
// click before the group formed around it. Derived, never stored.
export function groupOpen(folds: FoldState, g: ViewGroup): boolean {
  return isOpen(folds, foldId(g.head, 'group')) || g.members.some((at) => clickedOpen(folds, foldId(at, 'view', 0)));
}
