// The `canvas` tool group: draw, save, templates, list, delete, focus, open — and the
// screen the two navigation tools open. A self-contained factory over its deps (the
// registry, the clock, the host's cache, its redraw, its toast and its screen opener),
// so the group is testable without an app and imports nothing from the host.
//
// Every tool here is a READ: `canvas_save` writes only into the plugin's own store —
// the host's cache, the app's scratchpad, as `memory` is — so it is reversible (the
// person can clear the cache) and changes nothing outside the app, which is why it asks
// no y/n; a canvas changes only what the person sees, never the world, and a y/n on
// each redraw would stall live updates and block every background agent (the design's
// "canvas_draw is a read, not a write"). None carries `write`.
//
// The group's `description` is the vocabulary the model composes trees against: the
// types, their props, the caps, the palette, one example. Tool descriptions stay short
// and point at it.
import { checkTree, VOCABULARY } from './tree.ts';
import { canvasLine, deleteCanvas, drawCanvas, formatAge, selectCanvas } from './store.ts';
import { CACHE_OFF, GLOBAL_SCOPE, listTemplates, loadTemplate, saveTemplate } from './templates.ts';
import type { TCache, TScope, TTemplate, TTemplateLine } from './templates.ts';
import type { TStore } from './store.ts';

export type TToolsDeps = {
  store: TStore;
  now: () => number;
  notify: () => void;
  note: (text: string) => void;
  open: (screen: string, params: Record<string, unknown>) => Promise<{ ok: boolean; text: string }> | undefined;
  // The host's cache, where a saved layout lives. Absent, the template tools answer
  // that the cache is off — the feature is the cache.
  cache?: TCache;
  // The project a template call works in, when the caller knows it better than the
  // call's ctx does. A test names it; the app reads `ctx.workspaceProject` per call,
  // so a `cd` mid-session moves the scope the way the person expects.
  project?: () => string | null;
};

// The screen the navigation tools open: the plugin's one screen, `show`, which takes
// the canvas to put up. The surface — a later part of the plugin — is what actually
// draws it; the tools only ask.
export const SHOW_SCREEN = 'show';

// The canvas a call names: a non-empty string, trimmed. Anything else names nothing.
const canvasOf = (raw: unknown): string => typeof raw === 'string' ? raw.trim() : '';

// An optional label (a title, an owner): a string with words in it, or nothing.
const labelOf = (raw: unknown): string | undefined => typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;

// A canvas nobody drew, said the same way by a tool and by the screen's own refusal.
export const missingCanvas = (id: string): string => `no canvas «${id}» — canvas_list names the ones there are`;

// Whether the call may take the person's screen. The host hands `askUser` to a session
// only: a task, a subagent and a one-shot turn get none (the host's turn shapes,
// src/assistant/conversation-turn.ts), so a ctx carrying it is a session's and a draw
// from one is the person's own. Best effort by design — a caller with a bare ctx reads
// as background work, and the only cost is that its draw keeps the selection.
const selectsScreen = (ctx: unknown): boolean =>
  typeof (ctx as { askUser?: unknown } | null | undefined)?.askUser === 'function';

// The scope a template call works in: the project the call was made in, under
// `project:<path>`, else `global`. Read per call — a `cd` mid-session moves it — and a
// caller that names its own project (a test) wins over the call's ctx.
const scopeOf = (deps: TToolsDeps, ctx: unknown): TScope => {
  const project = typeof deps.project === 'function'
    ? deps.project()
    : typeof (ctx as { workspaceProject?: unknown } | null | undefined)?.workspaceProject === 'function'
      ? (ctx as { workspaceProject: () => string | null }).workspaceProject()
      : null;
  const path = typeof project === 'string' ? project.trim() : '';
  return path === '' ? GLOBAL_SCOPE : `project:${path}`;
};

// The scope a template tool is asked for: `project` (the default — where the call was
// made) or `global` (everywhere). Anything else is not a scope, and the refusal names
// the two a person may type.
const scopeChoiceOf = (raw: unknown): 'project' | 'global' | null => {
  if (raw === undefined || raw === null) return 'project';
  return raw === 'project' || raw === 'global' ? raw : null;
};
const notAScope = (raw: unknown): string => `«${typeof raw === 'string' ? raw : ''}» is not a scope — use project or global`;

// One recipe as a listing reads it: its name, its title when it has one, its age, and
// the scope it came from.
const templateLine = (template: TTemplateLine, now: number): string => {
  const parts: string[] = [`«${template.name}»`];
  if (template.title !== '') parts.push(template.title);
  parts.push(formatAge(now - template.savedAt));
  parts.push(template.where);
  return parts.join(' · ');
};

export function buildGroup(deps: TToolsDeps) {
  const draw = (args: Record<string, unknown>, ctx: unknown): string => {
    const id = canvasOf(args.canvas);
    if (!id) return 'not drawn: name the canvas — canvas is its id, a short word like ci';
    // A recipe supplies the tree and the title. A tree sent beside it wins and the
    // recipe supplies only the title — the same layout redrawn with today's data.
    const recipeName = typeof args.template === 'string' ? args.template.trim() : '';
    const loaded = recipeName === '' ? undefined : deps.cache === undefined
      ? { ok: false as const, error: CACHE_OFF }
      : loadTemplate(deps.cache, { scope: scopeOf(deps, ctx), name: recipeName });
    if (loaded !== undefined && !loaded.ok) return `canvas «${id}» is unchanged — ${loaded.error}`;
    const recipe = loaded !== undefined && loaded.ok ? loaded.template : undefined;
    const rawTree = args.tree ?? recipe?.tree;
    if (rawTree === undefined) return `not drawn: canvas «${id}» needs a tree — [type, props?, ...children]; the group text has the vocabulary and an example`;
    // The gate: a refused tree never reaches the store, so the canvas on the person's
    // side is left exactly as it was.
    const checked = checkTree(rawTree);
    if (!checked.ok) return `canvas «${id}» is unchanged — ${checked.error}`;
    const title = labelOf(args.title) ?? labelOf(recipe?.title);
    const owner = labelOf(args.owner);
    const canvas = drawCanvas(deps.store, {
      id,
      ...(title === undefined ? {} : { title }),
      ...(owner === undefined ? {} : { owner }),
      tree: checked.tree,
      stats: checked.stats,
      // A background agent's draw must not yank the person off the canvas they read.
      select: selectsScreen(ctx),
    });
    deps.notify();
    // The person may be in the chat or another session: one line says the canvas moved.
    if (!deps.store.personOpened) deps.note(`canvas «${id}» updated`);
    const where = deps.store.personOpened ? 'side up' : 'side down';
    return `drew canvas «${id}» (${canvas.stats.nodes} nodes) — ${where}`;
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

  // Only a session's focus moves the person's tabs: the host refuses a background open
  // anyway (screens.ts), and a subagent must not re-tab a screen it cannot show. A
  // session selects before it asks, so the canvas it asked for is the one selected even
  // when the open waits for the turn's end.
  const focus = async (args: Record<string, unknown>, ctx: unknown): Promise<string> => {
    const id = canvasOf(args.canvas);
    if (!id) return 'no canvas named — canvas is the id canvas_list names';
    if (!deps.store.canvases.has(id)) return missingCanvas(id);
    if (selectsScreen(ctx)) {
      selectCanvas(deps.store, id);
      deps.notify();
    }
    return show(id);
  };

  const open = async (args: Record<string, unknown>): Promise<string> => {
    const id = canvasOf(args.canvas);
    if (!id) return 'no canvas named — canvas is the id canvas_list names';
    if (!deps.store.canvases.has(id)) return missingCanvas(id);
    return show(id);
  };

  // A save keeps the tree and the title the canvas has now, never the values the
  // person typed: a recipe is a shape, and the canvas drawn from it carries the data.
  // `scope: 'global'` keeps it for every project; the default is this call's project.
  const save = (args: Record<string, unknown>, ctx: unknown): string => {
    const id = canvasOf(args.canvas);
    if (!id) return 'not saved: name the canvas — canvas is its id';
    const choice = scopeChoiceOf(args.scope);
    if (choice === null) return notAScope(args.scope);
    const canvas = deps.store.canvases.get(id);
    if (canvas === undefined) return missingCanvas(id);
    const name = typeof args.template === 'string' ? args.template.trim() : '';
    if (name === '') return 'not saved: name the recipe — template is a slug like pipeline';
    if (deps.cache === undefined) return CACHE_OFF;
    const scope = choice === 'global' ? GLOBAL_SCOPE : scopeOf(deps, ctx);
    const saved = saveTemplate(deps.cache, { scope, name, title: canvas.title, tree: canvas.tree, now: deps.now() });
    return saved.ok ? `saved «${saved.key}»` : saved.error;
  };

  // The recipes this project has and the global ones, one line each: what a draw can
  // name, and how old it is. `scope: 'global'` narrows the list to the global ones.
  const templates = (args: Record<string, unknown>, ctx: unknown): string => {
    const choice = scopeChoiceOf(args.scope);
    if (choice === null) return notAScope(args.scope);
    // The app always hands a cache (a proxy over the host); a disabled one is the real
    // "off", and the store answers an empty list for it — so ask the switch here.
    if (deps.cache === undefined || !deps.cache.enabled()) return CACHE_OFF;
    const lines = listTemplates(deps.cache, choice === 'global' ? GLOBAL_SCOPE : scopeOf(deps, ctx));
    if (lines.length === 0) return 'no templates yet — canvas_save keeps a drawn canvas as one';
    const now = deps.now();
    return lines.map((line) => templateLine(line, now)).join('\n');
  };

  return {
    id: 'canvas',
    description: VOCABULARY,
    tools: [
      {
        type: 'function',
        function: {
          name: 'canvas_draw',
          description: 'Draw a canvas, or replace it whole: the person sees it. canvas — its id (a short word like ci); title, owner — optional labels; tree — [type, props?, ...children] (the group text has the vocabulary and an example) or template — a saved recipe\'s name (canvas_templates lists them), drawn with its tree and title. A tree sent beside a template wins and the recipe supplies the title. A bind\'s value the person typed survives a redraw while you send the same `value`; send a different `value` to prefill or reset it. Display only: nothing outside the app changes. A tree that breaks the vocabulary is refused and the canvas is left as it was.',
          parameters: {
            type: 'object',
            properties: {
              canvas: { type: 'string', description: 'The canvas id — a short name, e.g. ci.' },
              title: { type: 'string', description: 'A title the person reads above the canvas.' },
              owner: { type: 'string', description: 'Who the canvas is for or from — a person, an agent.' },
              tree: { type: 'array', description: 'The tree: [type, props?, ...children], a child a node or a string.' },
              template: { type: 'string', description: 'The name of a saved recipe to draw — canvas_templates names them.' },
            },
            required: ['canvas'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'canvas_save',
          description: 'Keep a drawn canvas as a recipe — its tree and its title, never the values the person typed — so canvas_draw can draw it again, in this session or a later one. canvas — the canvas to keep; template — the recipe\'s name (lower-case letters, digits and . _ -); scope — \'project\' (the default) or \'global\'. Saving an existing name replaces it. The recipe is kept in the host\'s cache — the plugin\'s own store, as memory is: nothing outside the app changes, the person can clear it, and no y/n is asked.',
          parameters: {
            type: 'object',
            properties: {
              canvas: { type: 'string', description: 'The canvas id — canvas_list names them.' },
              template: { type: 'string', description: 'The recipe name — a slug like pipeline.' },
              scope: { type: 'string', enum: ['project', 'global'], description: '\'project\' (the default) keeps it for this project; \'global\' for every project.' },
            },
            required: ['canvas', 'template'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'canvas_templates',
          description: 'The saved recipes — one line each: name, title, age, and whether it is this project\'s or global. canvas_draw with `template` draws one; a project recipe shadows a global one of the same name. scope — \'project\' (the default) or \'global\'.',
          parameters: {
            type: 'object',
            properties: {
              scope: { type: 'string', enum: ['project', 'global'], description: '\'project\' (the default) lists this project\'s recipes and the global ones it does not shadow; \'global\' lists only the global ones.' },
            },
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
          description: 'Select a canvas and ask the host to show the person\'s side on it. canvas — its id. Only a session\'s call moves the selection: background work opens nothing, and the answer says why.',
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
    exec: async (name: string, args: Record<string, unknown>, ctx: unknown): Promise<string> => {
      if (name === 'canvas_draw') return draw(args, ctx);
      if (name === 'canvas_save') return save(args, ctx);
      if (name === 'canvas_templates') return templates(args, ctx);
      if (name === 'canvas_list') return list();
      if (name === 'canvas_delete') return remove(args);
      if (name === 'canvas_focus') return focus(args, ctx);
      if (name === 'canvas_open') return open(args);
      throw new Error(`Unknown tool: ${name}`);
    },
  };
}
