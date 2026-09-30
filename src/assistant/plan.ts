// The assistant's task plan — the checkbox list the `todo` tool edits and the chat
// draws as `▾ plan`, in the plan's own order.
//
// A plan belongs to a CONVERSATION, never to the process: module-level state would
// let `/clear` start a new conversation under the old plan, a
// background task write into the plan of the chat that started it, and
// one test's plan bleed into the next test's. `createPlan()` makes one; whoever owns the
// conversation holds it and hands it to the tool through the tool context
// (`ctx.plan`). In-memory only — it is a scratchpad for the turn at hand, not the
// cross-session `memory` file.
import { checkboxMarker } from '@flowtty/react';

export type TodoStatus = 'pending' | 'in_progress' | 'done';
export interface TodoItem {
  // A stable handle the plan gives an item when it is created: `t1`, `t2`, … in the
  // order of creation, never reused within the plan and started again by a new one.
  // It is what the model names an item by — never a place on the screen, which moves.
  id: string;
  text: string;
  status: TodoStatus;
}

export interface Plan {
  // A defensive copy for a renderer: nothing outside mutates the plan's items.
  snapshot(): TodoItem[];
  // Empties the plan; ids start again from t1 (a fresh plan has no stale ids).
  reset(): void;
  // Puts back a plan saved with a session (a restart must not lose it). A saved plan
  // may carry numeric ids: `5` reads as `t5`.
  load(items: { id: number | string; text: string; status: string }[]): void;
  // The `todo` tool. Returns the text the model reads; calls `notify` after a change.
  exec(args: Record<string, unknown>, notify?: () => void): string;
}

// The plan's markers are flowtty's checkbox glyphs (`checkboxMarker`, frame `none`):
// pending is an empty box, done a checked one, in progress the partial box — some of
// the item is done. The screen and the text the model reads use the same three.
const checkboxState = (s: TodoStatus) => (s === 'done' ? true : s === 'in_progress' ? 'mixed' as const : false);
export const todoMarker = (s: TodoStatus): { text: string; color?: string } => checkboxMarker(checkboxState(s), 'none');
export const todoGlyph = (s: TodoStatus) => todoMarker(s).text;
const todoWord = (s: TodoStatus) => (s === 'done' ? 'done' : s === 'in_progress' ? 'in progress' : 'pending');

// One item as the model reads it: marker, id, text, state in words.
const describeItem = (t: TodoItem) => `${todoGlyph(t.status)} ${t.id} · ${t.text} (${todoWord(t.status)})`;

// The whole plan as the model reads it — the `todo` tool's `list` and the system
// prompt's plan block alike: every item, in the plan's own order, by its id. Grouping
// by state would show the items in an order the person does not see.
export function describePlan(items: readonly TodoItem[]): string {
  return items.map(describeItem).join('\n');
}

// What a tool round carries when the turn is working and the plan does not say on
// what: items are pending and none is in progress. `null` when the plan has nothing
// to mark (empty, one already in progress, or every item done).
export function planReminder(plan: Plan): string | null {
  const items = plan.snapshot();
  if (!items.some((t) => t.status === 'pending') || items.some((t) => t.status === 'in_progress')) return null;
  return PLAN_REMINDER;
}
export const PLAN_REMINDER = 'Plan: no item is in progress. Mark the one you are working on now with todo start (by its id or text), and complete it when it is done.';

// Normalizes a status string from the `todo` tool (and engines that say
// "completed" like Claude Code's TodoWrite) into the trio the model uses.
function normalizeTodoStatus(v: unknown): TodoStatus {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'done' || s === 'completed' || s === 'complete') return 'done';
  if (s === 'in_progress' || s === 'in-progress' || s === 'inprogress' || s === 'working' || s === 'running') return 'in_progress';
  return 'pending';
}

// An id as the model or a saved session gives it: `t3`, or a bare `3` / `"3"` (a
// saved plan's numeric id, a model that names one by its number). `null` for anything
// else.
function normalizeId(v: unknown): string | null {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? `t${v}` : null;
  const s = String(v ?? '').trim().toLowerCase();
  const m = /^t?(\d+)$/.exec(s);
  return m && Number(m[1]) > 0 ? `t${Number(m[1])}` : null;
}
const idNumber = (id: string) => Number(id.slice(1));

export function createPlan(): Plan {
  let items: TodoItem[] = [];
  let nextId = 1;
  const newId = () => `t${nextId++}`;

  const render = (): string => (items.length ? describePlan(items) : 'Plan is empty — add items with todo action=add.');

  // Which item a mutating action targets: by `id` when one is given, else by `text` —
  // exactly, then ignoring case. Never by a fragment: "33" must not find "item 32 and
  // 33", and a number the model read somewhere is not an item.
  const resolve = (args: Record<string, unknown>): { idx: number } | { error: string } => {
    if (args.id != null && args.id !== '') {
      const id = normalizeId(args.id);
      const idx = id ? items.findIndex((t) => t.id === id) : -1;
      return idx === -1 ? { error: `Plan item ${String(args.id)} not found.\n${render()}` } : { idx };
    }
    const text = String(args.text ?? '').trim();
    if (!text) return { error: 'id or text is required — which plan item.' };
    let idx = items.findIndex((t) => t.text.trim() === text);
    if (idx === -1) idx = items.findIndex((t) => t.text.trim().toLowerCase() === text.toLowerCase());
    return idx === -1 ? { error: `Plan item "${text}" not found.\n${render()}` } : { idx };
  };

  const reset = () => { items = []; nextId = 1; };

  return {
    snapshot: () => items.map((t) => ({ ...t })),
    reset,
    load(saved) {
      items = [];
      for (const t of Array.isArray(saved) ? saved : []) {
        const id = t ? normalizeId(t.id) : null;
        if (!id || typeof t.text !== 'string' || items.some((x) => x.id === id)) continue;
        items.push({ id, text: t.text, status: normalizeTodoStatus(t.status) });
      }
      nextId = items.reduce((m, t) => Math.max(m, idNumber(t.id)), 0) + 1;
    },
    exec(args, notify) {
      const action = String(args.action ?? '').trim();
      if (action === 'list') return render();
      if (action === 'set') {
        // Full-replace (like TodoWrite): the model passes the ENTIRE desired list and
        // the plan is rewritten wholesale. An item whose text is already in the plan
        // (ignoring case) keeps its id; a new text gets the next id. A list that keeps
        // no item is a NEW plan and its ids start from t1. An EMPTY list is a valid plan — "nothing
        // left": the same as `clear`, so a finished task leaves no stale `▾ plan`.
        const arr = Array.isArray(args.todos) ? (args.todos as Array<Record<string, unknown>>) : [];
        const wanted = arr
          .map((raw) => ({ text: String(raw?.text ?? '').trim(), status: normalizeTodoStatus(raw?.status) }))
          .filter((t) => t.text);
        // Matched as `resolve` matches text: exactly first, then ignoring case — a
        // re-cased item is the same item.
        const left = [...items];
        const keep = (text: string): string | undefined => {
          let at = left.findIndex((t) => t.text === text);
          if (at === -1) at = left.findIndex((t) => t.text.toLowerCase() === text.toLowerCase());
          return at === -1 ? undefined : left.splice(at, 1)[0]!.id;
        };
        const kept = wanted.map((t) => keep(t.text));
        if (kept.every((id) => id === undefined)) nextId = 1;
        const next: TodoItem[] = [];
        for (const [i, t] of wanted.entries()) {
          next.push({ id: kept[i] ?? newId(), text: t.text, status: t.status });
        }
        items = next;
        if (!next.length) nextId = 1;
        notify?.();
        if (!next.length) return 'Plan cleared.';
        return `Plan set to ${next.length} items:\n${render()}`;
      }
      if (action === 'add') {
        // A whole batch may be added in ONE call (`items` — an array of texts), so the
        // model lays out a 20-item plan as one `todo add` rather than 20 parallel
        // calls. Falls back to a single `text`. The result is the whole plan, so the
        // model sees the new items' ids and where they stand.
        const texts: string[] = Array.isArray(args.items)
          ? (args.items as unknown[]).map((s) => String(s).trim()).filter(Boolean)
          : [];
        if (!texts.length) {
          const t = String(args.text ?? '').trim();
          if (!t) return 'text is required — the plan item to add.';
          texts.push(t);
        }
        if (!items.length) nextId = 1;
        for (const text of texts) items.push({ id: newId(), text, status: 'pending' });
        notify?.();
        return `Added ${texts.length}. Plan:\n${render()}`;
      }
      if (action === 'start' || action === 'complete' || action === 'uncomplete') {
        const hit = resolve(args);
        if ('error' in hit) return hit.error;
        const t = items[hit.idx]!;
        t.status = action === 'start' ? 'in_progress' : action === 'complete' ? 'done' : 'pending';
        notify?.();
        return `${describeItem(t)}.`;
      }
      if (action === 'update') {
        const text = String(args.text ?? '').trim();
        if (!text) return 'text is required — the new item text.';
        const id = normalizeId(args.id);
        const item = id ? items.find((t) => t.id === id) : undefined;
        if (!item) return `Plan item ${String(args.id ?? '')} not found — update needs the item's id.\n${render()}`;
        item.text = text;
        notify?.();
        return `${describeItem(item)}.`;
      }
      if (action === 'remove') {
        const hit = resolve(args);
        if ('error' in hit) return hit.error;
        const removed = items[hit.idx]!;
        items = items.filter((t) => t.id !== removed.id);
        notify?.();
        return `Plan item ${removed.id} (${removed.text}) removed.`;
      }
      if (action === 'clear') {
        reset();
        notify?.();
        return 'Plan cleared.';
      }
      return 'action is required — list|set|add|start|complete|uncomplete|update|remove|clear.';
    },
  };
}
