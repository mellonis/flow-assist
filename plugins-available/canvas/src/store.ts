// The canvas registry: every live canvas, the person's values, the selection, and
// the short model-facing lines — one chat-context item per canvas and a
// depth-first outline of one canvas. A canvas is live state, in memory for the
// run; its `updatedAt` makes staleness self-evident.
// `drawCanvas` is a whole-tree replace: the model re-sends the tree, so a bind's
// value survives a redraw while the model's declared `value` is unchanged — that
// is how the model prefills or resets a field deliberately — and a bind that
// disappears from the tree drops its value with it.
import type { Node, TStats } from './tree.ts';

export type TValue = string | boolean;
export type TCanvas = { id: string; title: string; owner: string; tree: Node; values: Record<string, TValue>; declared: Record<string, TValue>; updatedAt: number; revision: number; stats: TStats };
export type TStore = { canvases: Map<string, TCanvas>; selectedId: string | null; personOpened: boolean; pressed: string | null };

// The clock a store was given, kept apart from the store object itself: the store
// is the plain record the host's store slice holds, and a test wants its own clock.
const clocks = new WeakMap<TStore, () => number>();

export function createStore(now?: () => number): TStore {
  const store: TStore = { canvases: new Map(), selectedId: null, personOpened: false, pressed: null };
  clocks.set(store, now ?? Date.now);
  return store;
}

const isPlainRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// A node as the reader sees it: the second element is the props only when it is a
// plain object — the same reading checkTree uses.
const readNode = (arr: unknown[]): { props: Record<string, unknown>; children: unknown[] } => {
  const second = arr[1];
  const hasProps = second !== undefined && second !== null && isPlainRecord(second);
  const children = (hasProps ? arr.slice(2) : [second, ...arr.slice(2)]).filter((c) => c !== undefined && c !== null && c !== false);
  return { props: hasProps ? (second as Record<string, unknown>) : {}, children };
};

// The declared values a tree carries, one per input/check/select node, in tree
// order: an input's `value` (empty when absent), a check's (unchecked when
// absent), a select's `value` or its first option's value.
const collectDeclared = (node: Node): Record<string, TValue> => {
  const declared: Record<string, TValue> = {};
  const walk = (n: unknown): void => {
    if (!Array.isArray(n)) return;
    const type = typeof n[0] === 'string' ? n[0] : null;
    const { props, children } = readNode(n);
    const bind = typeof props.bind === 'string' ? props.bind : null;
    if (type === 'input' && bind !== null) {
      declared[bind] = typeof props.value === 'string' ? props.value : '';
    } else if (type === 'check' && bind !== null) {
      declared[bind] = typeof props.value === 'boolean' ? props.value : false;
    } else if (type === 'select' && bind !== null) {
      const options = Array.isArray(props.options) ? props.options : [];
      const firstOption = options.length > 0 && isPlainRecord(options[0]) ? options[0].value : undefined;
      let value: TValue = '';
      if (typeof props.value === 'string') value = props.value;
      if (value === '' && typeof firstOption === 'string') value = firstOption;
      declared[bind] = value;
    }
    for (const c of children) walk(c);
  };
  walk(node);
  return declared;
};

// Draw a canvas, or replace it whole. A redraw keeps a bind's live value while
// the declared value is unchanged; a changed one takes effect (a deliberate
// prefill or reset); a vanished bind drops its value. `select: false` — a draw that
// may not take the person's screen, a background agent's — leaves the person's
// interaction state alone: the selection it found (unless nothing is selected yet,
// because a surface with canvases never sits with none selected) and the press queued
// in `pressed` (the footer's `press queued`). Only a draw that takes the screen is the
// answer the queued press waits for — its redraw clears the hint.
export function drawCanvas(store: TStore, input: { id: string; title?: string; owner?: string; tree: Node; stats: TStats; select?: boolean }): TCanvas {
  const declared = collectDeclared(input.tree);
  const existing = store.canvases.get(input.id);
  const values: Record<string, TValue> = {};
  for (const [bind, d] of Object.entries(declared)) {
    const kept = existing !== undefined && existing.declared[bind] === d ? existing.values[bind] : undefined;
    values[bind] = kept !== undefined ? kept : d;
  }
  const canvas: TCanvas = {
    id: input.id,
    title: input.title ?? existing?.title ?? '',
    owner: input.owner ?? existing?.owner ?? '',
    tree: input.tree,
    values,
    declared,
    updatedAt: (clocks.get(store) ?? Date.now)(),
    revision: existing === undefined ? 1 : existing.revision + 1,
    stats: input.stats,
  };
  store.canvases.set(input.id, canvas);
  if (input.select !== false || store.selectedId === null) store.selectedId = input.id;
  if (input.select !== false) store.pressed = null;
  return canvas;
}

// Deleting the selected canvas selects the first remaining one in insertion
// (first-draw) order, so the surface keeps showing a canvas; with none left the
// selection is null and the person's side goes down — a side with no canvas has
// nothing to show, and leaving it up would let the next draw mount it unasked. A
// pending press is cleared only when it was the deleted canvas's — another canvas's
// press keeps waiting.
export function deleteCanvas(store: TStore, id: string): boolean {
  const had = store.canvases.delete(id);
  if (!had) return false;
  if (store.pressed === id) store.pressed = null;
  if (store.selectedId === id) store.selectedId = store.canvases.keys().next().value ?? null;
  if (store.canvases.size === 0) store.personOpened = false;
  return true;
}

export function selectCanvas(store: TStore, id: string): boolean {
  if (!store.canvases.has(id)) return false;
  store.selectedId = id;
  return true;
}

export function selectedCanvas(store: TStore): TCanvas | undefined {
  return store.selectedId === null ? undefined : store.canvases.get(store.selectedId);
}

// The person's edits land here, per canvas, and survive a redraw.
export function setValue(store: TStore, id: string, bind: string, value: TValue): void {
  const canvas = store.canvases.get(id);
  if (canvas !== undefined) canvas.values[bind] = value;
}

// A value as the model reads it in a line: booleans as on/off, strings as is.
const valueText = (v: TValue): string => v === true ? 'on' : v === false ? 'off' : v;

// The one message a button press posts to the chat: the framed line with every
// bind's value at press time, in tree order; a canvas with no values carries
// just the press.
export function pressMessage(canvas: TCanvas, label: string): string {
  const base = `[canvas] «${canvas.id}» pressed «${label}»`;
  const entries = Object.entries(canvas.values);
  if (entries.length === 0) return base;
  return `${base} — ${entries.map(([bind, v]) => `${bind}: ${valueText(v)}`).join(' · ')}`;
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// The age as the model reads it — seconds, minutes, hours or days, floored, so it
// only grows; under a second it is `now`. The surface's header reads it too, so the
// two never disagree about how old a canvas is.
export const formatAge = (ms: number): string => {
  if (ms < SECOND_MS) return 'now';
  if (ms < MINUTE_MS) return `${Math.floor(ms / SECOND_MS)}s`;
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h`;
  return `${Math.floor(ms / DAY_MS)}d`;
};

const REGISTRY_MAX_ITEMS = 10;

// One canvas as the model reads it in a line: id, title, owner, age, node count, and
// whether the plugin's side is up. `registryItems` is the chat context's capped list of
// these lines; the `canvas_list` tool answers with every one of them, uncapped.
export function canvasLine(store: TStore, canvas: TCanvas, now: number): string {
  const parts: string[] = [`«${canvas.id}»`];
  if (canvas.title !== '') parts.push(canvas.title);
  if (canvas.owner !== '') parts.push(canvas.owner);
  parts.push(`${formatAge(now - canvas.updatedAt)} old`);
  parts.push(`${canvas.stats.nodes} nodes`);
  parts.push(store.personOpened ? 'side up' : 'side down');
  return parts.join(' · ');
}

// One chat-context item per canvas, in draw order: id, title, owner, age, node
// count, and whether the plugin's side is up. The list stays within ten items —
// the design's cap, the host's context budget being shared with every other
// plugin — so over the cap it keeps the first nine and ends in one `… N more`
// marker, the host's own truncation shape, naming the canvases it did not list.
export function registryItems(store: TStore, now: () => number): Array<{ label: string; text: string }> {
  const canvases = [...store.canvases.values()];
  const shown = canvases.length > REGISTRY_MAX_ITEMS ? REGISTRY_MAX_ITEMS - 1 : canvases.length;
  const items: Array<{ label: string; text: string }> = [];
  for (const c of canvases.slice(0, shown)) {
    items.push({ label: `Canvas: «${c.id}»`, text: canvasLine(store, c, now()) });
  }
  if (canvases.length > REGISTRY_MAX_ITEMS) items.push({ label: 'Canvas', text: `… ${canvases.length - shown} more` });
  return items;
}

const OUTLINE_TEXT_CAP = 60;
const DEFAULT_OUTLINE_LINES = 30;

// One line per node, depth-first, indented by depth: the type, and what the model
// needs of it — a bindable node its current value (`input branch=main`,
// `check watch=on`), a button its label, a text node its first text. Cut to
// `max` lines, one ellipsis line for what did not fit.
export function outline(canvas: TCanvas, max: number = DEFAULT_OUTLINE_LINES): string {
  const lines: string[] = [];
  const walk = (n: unknown, depth: number): void => {
    if (!Array.isArray(n)) return;
    const type = typeof n[0] === 'string' ? n[0] : '?';
    const { props, children } = readNode(n);
    let line = `${'  '.repeat(depth - 1)}${type}`;
    if (type === 'input' || type === 'check' || type === 'select') {
      if (typeof props.bind === 'string') line += ` ${props.bind}=${valueText(canvas.values[props.bind] ?? '')}`;
    } else if (type === 'button') {
      if (typeof props.label === 'string') line += ` «${props.label}»`;
    } else if (type === 'badge' && typeof props.text === 'string') {
      line += ` ${props.text}`;
    } else {
      const firstText = children.find((c) => typeof c === 'string');
      if (typeof firstText === 'string' && firstText !== '') {
        line += ` ${firstText.length > OUTLINE_TEXT_CAP ? `${firstText.slice(0, OUTLINE_TEXT_CAP)}…` : firstText}`;
      }
    }
    lines.push(line);
    for (const c of children) walk(c, depth + 1);
  };
  walk(canvas.tree, 1);
  if (lines.length <= max) return lines.join('\n');
  return [...lines.slice(0, max - 1), `… ${lines.length - (max - 1)} more`].join('\n');
}
