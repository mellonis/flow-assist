// The assistant's task plan — the checkbox list the `todo` tool edits and the chat
// draws as `▾ plan`.
//
// A plan belongs to a CONVERSATION, never to the process: module-level state would
// let `/clear` start a new conversation under the old plan, a
// background task's nested run write into the plan of the chat that started it, and
// one test's plan bleed into the next test's. `createPlan()` makes one; whoever owns the
// conversation holds it and hands it to the tool through the tool context
// (`ctx.plan`). In-memory only — it is a scratchpad for the turn at hand, not the
// cross-session `memory` file.
export type TodoStatus = 'pending' | 'in_progress' | 'done';
export interface TodoItem {
  id: number;
  text: string;
  status: TodoStatus;
}

export interface Plan {
  // A defensive copy for a renderer: nothing outside mutates the plan's items.
  snapshot(): TodoItem[];
  // Empties the plan; ids start again from 1 (a fresh plan has no stale ids).
  reset(): void;
  // Puts back a plan saved with a session (a restart must not lose it).
  load(items: { id: number; text: string; status: string }[]): void;
  // The `todo` tool. Returns the text the model reads; calls `notify` after a change.
  exec(args: Record<string, unknown>, notify?: () => void): string;
}

// The checkbox glyph + a status word, so the tool output and the render speak the
// same vocabulary. pending → ☐, in_progress → ◐ (half-filled — "working on it"),
// done → ☑.
export const todoGlyph = (s: TodoStatus) => (s === 'done' ? '☑' : s === 'in_progress' ? '◐' : '☐');
const todoWord = (s: TodoStatus) => (s === 'done' ? 'done' : s === 'in_progress' ? 'in progress' : 'pending');

// Normalizes a status string from the `todo` tool (and engines that say
// "completed" like Claude Code's TodoWrite) into the trio the model uses.
function normalizeTodoStatus(v: unknown): TodoStatus {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'done' || s === 'completed' || s === 'complete') return 'done';
  if (s === 'in_progress' || s === 'in-progress' || s === 'inprogress' || s === 'working' || s === 'running') return 'in_progress';
  return 'pending';
}

export function createPlan(): Plan {
  let items: TodoItem[] = [];
  let nextId = 1;

  // The plan for the LLM: in-progress items first (the active work), then pending,
  // then done, each with its id so `start|complete|uncomplete <id>` targets
  // precisely. Unlike the capped block on screen, this lists EVERY item — the model
  // needs the full set to reason about the plan.
  const render = (): string => {
    if (!items.length) return 'Plan is empty — add items with todo action=add.';
    const order: TodoStatus[] = ['in_progress', 'pending', 'done'];
    const sorted = [...items].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    return sorted.map((t) => `${todoGlyph(t.status)} ${t.id} · ${t.text}`).join('\n');
  };

  // Which item a mutating action targets. Accepts `id` (a small int) OR `text` — the
  // model thinks about items by their content (e.g. the number "73"), not by the
  // internal id, so targeting by text removes the list→match→id hop that otherwise
  // pushes it to narrate the status in prose instead of calling the tool. Text
  // matches exact, then case-insensitive, then a substring ("73" ↔ "item 73").
  const resolve = (args: Record<string, unknown>): { idx: number } | { error: string } => {
    if (args.id != null && args.id !== '') {
      const id = Number(args.id);
      if (!Number.isNaN(id)) {
        const idx = items.findIndex((t) => t.id === id);
        return idx === -1 ? { error: `Plan item ${id} not found.` } : { idx };
      }
    }
    const text = String(args.text ?? '').trim();
    if (!text) return { error: 'id or text is required — which plan item.' };
    const cmp = (t: TodoItem) => t.text.trim();
    let idx = items.findIndex((t) => cmp(t) === text);
    if (idx === -1) idx = items.findIndex((t) => cmp(t).toLowerCase() === text.toLowerCase());
    if (idx === -1) idx = items.findIndex((t) => cmp(t).toLowerCase().includes(text.toLowerCase()));
    return idx === -1 ? { error: `Plan item "${text}" not found.` } : { idx };
  };

  const reset = () => { items = []; nextId = 1; };

  return {
    snapshot: () => items.map((t) => ({ ...t })),
    reset,
    load(saved) {
      items = (Array.isArray(saved) ? saved : [])
        .filter((t) => t && Number.isInteger(t.id) && typeof t.text === 'string')
        .map((t) => ({ id: t.id, text: t.text, status: normalizeTodoStatus(t.status) }));
      nextId = items.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    },
    exec(args, notify) {
      const action = String(args.action ?? '').trim();
      if (action === 'list') return render();
      if (action === 'set') {
        // Full-replace (like TodoWrite): the model passes the ENTIRE desired list and
        // the plan is rewritten wholesale — not a delta, so it always reflects the
        // complete state the model intends. Existing items keep their id (matched by
        // exact text) so targeting stays stable across updates; new texts get fresh
        // ids; texts dropped from the list vanish. An EMPTY list is a valid plan —
        // "nothing left": the same as `clear`, so a finished task leaves no stale
        // `▾ plan`.
        const arr = Array.isArray(args.todos) ? (args.todos as Array<Record<string, unknown>>) : [];
        const prev = new Map(items.map((t) => [t.text, t.id]));
        const next: TodoItem[] = [];
        for (const raw of arr) {
          const text = String(raw?.text ?? '').trim();
          if (!text) continue;
          next.push({ id: prev.get(text) ?? nextId++, text, status: normalizeTodoStatus(raw?.status) });
        }
        items = next;
        if (!next.length) nextId = 1;
        notify?.();
        if (!next.length) return 'Plan cleared.';
        return `Plan set to ${next.length} items: ${render().split('\n').join(', ')}`;
      }
      if (action === 'add') {
        // A whole batch may be added in ONE call (`items` — an array of texts), so the
        // model lays out a 20-item plan as one `todo add` rather than 20 parallel
        // calls. Falls back to a single `text`. The result lists the new items with
        // their ids so the model knows what to target later.
        const texts: string[] = Array.isArray(args.items)
          ? (args.items as unknown[]).map((s) => String(s).trim()).filter(Boolean)
          : [];
        if (!texts.length) {
          const t = String(args.text ?? '').trim();
          if (!t) return 'text is required — the plan item to add.';
          texts.push(t);
        }
        const created = texts.map((text) => {
          const item: TodoItem = { id: nextId++, text, status: 'pending' };
          items.push(item);
          return item;
        });
        notify?.();
        const active = items.filter((t) => t.status !== 'done').length;
        if (created.length === 1) return `Plan: ${created[0]!.id} · ${created[0]!.text} (${active} active).`;
        return `Added ${created.length}: ${created.map((i) => `${i.id} · ${i.text}`).join(', ')} (${active} active).`;
      }
      if (action === 'start' || action === 'complete' || action === 'uncomplete') {
        const hit = resolve(args);
        if ('error' in hit) return hit.error;
        const t = items[hit.idx]!;
        t.status = action === 'start' ? 'in_progress' : action === 'complete' ? 'done' : 'pending';
        notify?.();
        return `${todoGlyph(t.status)} ${t.id} · ${t.text} (${todoWord(t.status)}).`;
      }
      if (action === 'update') {
        const id = Number(args.id);
        const text = String(args.text ?? '').trim();
        if (!text) return 'text is required — the new item text.';
        const item = items.find((t) => t.id === id);
        if (!item) return `Plan item ${id} not found.`;
        item.text = text;
        notify?.();
        return `Plan ${id} updated: ${text}.`;
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
