// The `canvas` tool group: draw, list, delete, focus, open — and the screen the two
// navigation tools open. A self-contained factory over its deps (the registry, the
// clock, the host's redraw, its toast and its screen opener), so the group is testable
// without an app and imports nothing from the host.
//
// Every tool here is a READ: a canvas changes only what the person sees, never the
// world, and a y/n on each redraw would stall live updates and block every background
// agent (the design's "canvas_draw is a read, not a write"). None carries `write`.
//
// The group's `description` is the vocabulary the model composes trees against: the
// types, their props, the caps, the palette, one example. Tool descriptions stay short
// and point at it.
import { checkTree, VOCABULARY } from './tree.ts';
import { deleteCanvas, drawCanvas, selectCanvas } from './store.ts';
import type { TCanvas, TStore } from './store.ts';

export type TToolsDeps = {
  store: TStore;
  now: () => number;
  notify: () => void;
  note: (text: string) => void;
  open: (screen: string, params: Record<string, unknown>) => Promise<{ ok: boolean; text: string }> | undefined;
};

// The screen the navigation tools open: the plugin's one screen, `show`, which takes
// the canvas to put up. The surface — a later part of the plugin — is what actually
// draws it; the tools only ask.
export const SHOW_SCREEN = 'show';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// An age as the model reads it — the same units and floor as the context's items, so
// the list and what the person sees never disagree about how old a canvas is.
const age = (ms: number): string => {
  if (ms < SECOND_MS) return 'now';
  if (ms < MINUTE_MS) return `${Math.floor(ms / SECOND_MS)}s`;
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h`;
  return `${Math.floor(ms / DAY_MS)}d`;
};

const side = (store: TStore): string => store.personOpened ? 'side up' : 'side down';

// A canvas as a list line: id, title, owner, age, node count and whether the person's
// side is up — the shape the context's items use, for EVERY canvas. `registryItems`
// caps at ten because the chat's context budget is shared with every other plugin; a
// tool's answer is not that budget, and `canvas_list` is how a session finds a canvas
// it did not draw.
const canvasLine = (store: TStore, canvas: TCanvas, now: number): string => {
  const parts: string[] = [`«${canvas.id}»`];
  if (canvas.title !== '') parts.push(canvas.title);
  if (canvas.owner !== '') parts.push(canvas.owner);
  parts.push(`${age(now - canvas.updatedAt)} old`, `${canvas.stats.nodes} nodes`, side(store));
  return parts.join(' · ');
};

// The canvas a call names: a non-empty string, trimmed. Anything else names nothing.
const canvasOf = (raw: unknown): string => typeof raw === 'string' ? raw.trim() : '';

// An optional label (a title, an owner): a string with words in it, or nothing.
const labelOf = (raw: unknown): string | undefined => typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;

// A canvas nobody drew, said the same way by a tool and by the screen's own refusal.
export const missingCanvas = (id: string): string => `no canvas «${id}» — canvas_list names the ones there are`;

export function buildGroup(deps: TToolsDeps) {
  const draw = (args: Record<string, unknown>): string => {
    const id = canvasOf(args.canvas);
    if (!id) return 'not drawn: name the canvas — canvas is its id, a short word like ci';
    if (args.tree === undefined) return `not drawn: canvas «${id}» needs a tree — [type, props?, ...children]; the group text has the vocabulary and an example`;
    // The gate: a refused tree never reaches the store, so the canvas on the person's
    // side is left exactly as it was.
    const checked = checkTree(args.tree);
    if (!checked.ok) return `canvas «${id}» is unchanged — ${checked.error}`;
    const title = labelOf(args.title);
    const owner = labelOf(args.owner);
    const canvas = drawCanvas(deps.store, {
      id,
      ...(title === undefined ? {} : { title }),
      ...(owner === undefined ? {} : { owner }),
      tree: checked.tree,
      stats: checked.stats,
    });
    deps.notify();
    // The person may be in the chat or another session: one line says the canvas moved.
    if (!deps.store.personOpened) deps.note(`canvas «${id}» updated`);
    return `drew canvas «${id}» (${canvas.stats.nodes} nodes) — ${side(deps.store)}`;
  };

  const list = (): string => {
    if (deps.store.canvases.size === 0) return 'no canvas is drawn yet — canvas_draw draws one';
    const now = deps.now();
    return [...deps.store.canvases.values()].map((canvas) => canvasLine(deps.store, canvas, now)).join('\n');
  };

  const remove = (args: Record<string, unknown>): string => {
    const id = canvasOf(args.canvas);
    if (!id) return 'no canvas named — canvas is the id canvas_list names';
    if (!deleteCanvas(deps.store, id)) return missingCanvas(id);
    deps.notify();
    const left = deps.store.canvases.size;
    if (left === 0) return `deleted canvas «${id}» — it was the last one, so the person's side is down`;
    return `deleted canvas «${id}» — ${left} ${left === 1 ? 'canvas' : 'canvases'} left`;
  };

  // The host's answer is a sentence already (`Opened canvas:show — canvas «ci».`, or why
  // not) and is handed back as it is: a refusal from background work is the model's to
  // read, not the tool's to reword.
  const show = async (id: string): Promise<string> => {
    const opened = await deps.open(SHOW_SCREEN, { canvas: id });
    return opened?.text ?? `Not opened: this host cannot open a screen — canvas «${id}» is still drawn`;
  };

  // Selecting before the ask is deliberate: a refused open (background work opens
  // nothing) still moves the person's tabs when they next look.
  const focus = async (args: Record<string, unknown>): Promise<string> => {
    const id = canvasOf(args.canvas);
    if (!id) return 'no canvas named — canvas is the id canvas_list names';
    if (!selectCanvas(deps.store, id)) return missingCanvas(id);
    deps.notify();
    return show(id);
  };

  const open = async (args: Record<string, unknown>): Promise<string> => {
    const id = canvasOf(args.canvas);
    if (!id) return 'no canvas named — canvas is the id canvas_list names';
    if (!deps.store.canvases.has(id)) return missingCanvas(id);
    return show(id);
  };

  return {
    id: 'canvas',
    description: VOCABULARY,
    tools: [
      {
        type: 'function',
        function: {
          name: 'canvas_draw',
          description: 'Draw a canvas, or replace it whole: the person sees it. canvas — its id (a short word like ci); title, owner — optional labels; tree — [type, props?, ...children] (the group text has the vocabulary and an example). Display only: nothing outside the app changes. A tree that breaks the vocabulary is refused and the canvas is left as it was.',
          parameters: {
            type: 'object',
            properties: {
              canvas: { type: 'string', description: 'The canvas id — a short name, e.g. ci.' },
              title: { type: 'string', description: 'A title the person reads above the canvas.' },
              owner: { type: 'string', description: 'Who the canvas is for or from — a person, an agent.' },
              tree: { type: 'array', description: 'The tree: [type, props?, ...children], a child a node or a string.' },
            },
            required: ['canvas', 'tree'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'canvas_list',
          description: 'The canvases that are drawn right now — id, title, owner, age, node count and whether the person\'s side is up. How you find a canvas another session drew: the screen context is sent to sessions only, never to a child.',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: {
          name: 'canvas_delete',
          description: 'Remove a canvas; removing the last one takes the person\'s side down. canvas — its id. Display only.',
          parameters: {
            type: 'object',
            properties: { canvas: { type: 'string', description: 'The canvas id — canvas_list names them.' } },
            required: ['canvas'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'canvas_focus',
          description: 'Select a canvas and ask the host to show the person\'s side on it. canvas — its id. The host may refuse (background work opens nothing): the answer says why and the canvas stays drawn and selected.',
          parameters: {
            type: 'object',
            properties: { canvas: { type: 'string', description: 'The canvas id — canvas_list names them.' } },
            required: ['canvas'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'canvas_open',
          description: 'Ask the host to show the person\'s side with a canvas — when they asked to see one. canvas — its id. Same rules as canvas_focus.',
          parameters: {
            type: 'object',
            properties: { canvas: { type: 'string', description: 'The canvas id — canvas_list names them.' } },
            required: ['canvas'],
          },
        },
      },
    ],
    exec: async (name: string, args: Record<string, unknown>, _ctx: unknown): Promise<string> => {
      if (name === 'canvas_draw') return draw(args);
      if (name === 'canvas_list') return list();
      if (name === 'canvas_delete') return remove(args);
      if (name === 'canvas_focus') return focus(args);
      if (name === 'canvas_open') return open(args);
      throw new Error(`Unknown tool: ${name}`);
    },
  };
}
