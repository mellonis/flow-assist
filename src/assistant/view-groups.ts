// Consecutive commands fold under ONE head. A model runs a command per round and
// writes a `Next:` line before each, so five commands are five blocks — a column of
// grey. Consecutive console views of one turn (no other call between them: their
// `seq` are consecutive) are drawn as one line, `ƒ Ran 3 commands · ✓ 34 s`; opened,
// the commands alone, each its own block. The messages before and between them that
// hold only the plan of the next command (a round whose only text was its `Next:`
// line) are taken in too — the head says what ran, which is what the plan said would.
// Groups form only in the `step` notes mode, and a message that says more — a step of
// its own, a call, a change, reasoning — is never folded into one.
//
// Pure: works on the DRAWN messages (the system prompt is not one), by index — the
// same `at` fold ids are built from.
import { clickedOpen, foldId, isOpen, type FoldState } from './folds.js';
import { isPlanOnly, shownText, type NotesMode, type TurnPart } from './step.js';
import { isConsoleKind, sanitizeViewText, type ViewRecord } from './views.js';

export interface ViewGroup { head: number; members: number[]; hidden: number[] }
export type GroupMsg = { role: string; content?: unknown; parts?: unknown; reasoning?: unknown; views?: unknown; roundLimit?: unknown; stopped?: unknown };

const consoleOf = (m: GroupMsg): ViewRecord | null => {
  if (m.role !== 'view' || !Array.isArray(m.views) || m.views.length !== 1) return null;
  const r = m.views[0] as ViewRecord;
  return isConsoleKind(r.kind) && typeof r.seq === 'number' && typeof r.turn === 'number' ? r : null;
};
// A part that stays out of a group: a change, a call (one a command's block does not
// already show), or a step that says more than its plan — a step that is nothing but
// the `Next:` line the prompt asks for before a call is the plan of the command the
// group's head names, and goes under the head with it.
const drawsPart = (p: unknown) => {
  const part = p as TurnPart | null;
  if (!part || typeof part !== 'object') return false;
  if (part.kind === 'change' || part.kind === 'tools') return true;
  const text = String((part as { text?: unknown }).text ?? '');
  return part.kind === 'text' && !!shownText(text) && !isPlanOnly(text);
};
// A message a group may take in: the round of a command that said nothing but its
// plan — nothing answered, no step of its own, no call, no change, nothing about how a
// turn ended, no reasoning (its own block).
const passable = (m: GroupMsg | undefined) => !!m && m.role === 'assistant' && !String(m.content ?? '').trim()
  && !(Array.isArray(m.parts) && m.parts.some(drawsPart)) && !String(m.reasoning ?? '').trim()
  && !m.roundLimit && !m.stopped;

// Groups form only in `step`: `open` draws everything in full and folds nothing.
export function viewGroups(drawn: GroupMsg[], notes: NotesMode): ViewGroup[] {
  if (notes !== 'step') return [];
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
      // A silent round just before the first command is the group's too: the head
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

// The text is drawn straight into chat rows (never through `frameView`, which
// sanitizes what it frames) — `sanitizeViewText` here is the same defence in depth,
// against a command line embedded verbatim from the tool's own data. The success
// mark is `✓` in the `ok` colour, same as a block's own tail (console-view.ts).
export function groupHeadText(recs: ViewRecord[], now: number): { text: string; color?: 'warn' | 'ok' }[] {
  const n = recs.length;
  const running = recs.find((r) => r.phase === 'live');
  const sanitize = (parts: { text: string; color?: 'warn' | 'ok' }[]) => parts.map((p) => ({ ...p, text: sanitizeViewText(p.text) }));
  if (running) {
    const cmd = String((running.data as { command?: unknown })?.command ?? '');
    return sanitize([{ text: `Running ${n} commands · $ ${cmd} · ${Math.floor(Math.max(0, now - running.startedAt) / 1000)} s` }]);
  }
  const total = recs.reduce((t, r) => t + Number((r.data as { ms?: unknown })?.ms ?? 0), 0);
  const failed = recs.filter((r) => r.phase === 'failed' || (r.data as { exitCode?: unknown })?.exitCode !== 0).length;
  return sanitize(failed
    ? [{ text: `Ran ${n} commands · ` }, { text: `✗ ${failed} failed`, color: 'warn' }, { text: ` · ${secs(total)}` }]
    : [{ text: `Ran ${n} commands · ` }, { text: '✓', color: 'ok' }, { text: ` ${secs(total)}` }]);
}

// Open when its own id says so, or when the person opened one of its members with a
// click before the group formed around it. Derived, never stored.
export function groupOpen(folds: FoldState, g: ViewGroup): boolean {
  return isOpen(folds, foldId(g.head, 'group')) || g.members.some((at) => clickedOpen(folds, foldId(at, 'view', 0)));
}

// A head click's effect on the WHOLE group — never a plain `toggleFold` on the
// group's own id alone, which cannot see a member's own exception and so cannot
// reliably flip what `groupOpen` reads (the same `FoldState` is reachable by two
// click orders that need opposite answers; only the group's own current reading,
// not a fold id in isolation, can decide which way this click goes). Closing drops
// every member's own exception too — a reopened group starts folded, not reopening
// whatever a person had individually clicked before it closed. Only the group's own
// id and its members' view ids are ever touched; every other block's exception
// stands exactly as it was.
export function toggleGroup(folds: FoldState, g: ViewGroup): FoldState {
  const except = new Set(folds.except);
  const groupId = foldId(g.head, 'group');
  // Add or remove `id` from the exception set so `isOpen` reads it as `open`.
  const setId = (id: string, open: boolean) => { if (open === folds.open) except.delete(id); else except.add(id); };
  if (groupOpen(folds, g)) {
    for (const at of g.members) except.delete(foldId(at, 'view', 0));
    setId(groupId, false);
  } else {
    setId(groupId, true);
  }
  return { open: folds.open, except };
}
