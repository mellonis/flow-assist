# Canvas Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bundled flow-assist plugin that lets the model draw a live, interactive, human-facing interface out of a declarative component tree, with many canvases from many agents side by side.

**Architecture:** `plugins-available/canvas/` holds one plugin: a pure validation layer (`tree.ts`), an in-memory registry (`store.ts`), pure renderers that turn the tree into flowtty elements through the host's `ui` (`render.ts`, `parts.ts`), a surface component with its own focus model (`view.ts`), and the shape wiring — tools, keycaps, keys, `chatContext`, screens (`index.ts`). No host code changes: everything goes through host API 2 (`{ ui, host }`, `make(name, shape)`).

**Tech Stack:** TypeScript (repo strict), Bun test runner, React elements built with `ui.h`, flowtty components from `{ ui }`, host services `postToChat` / `showMessage` / `notify`.

**Spec:** `docs/superpowers/specs/2026-11-15-canvas-plugin-design.md`

## Global Constraints

- **No host changes.** Only host API 2 surfaces: `{ ui, host }` (plugin-api.ts), `make(name, shape)` (src/loader/plugin.ts). No new exports, no new services.
- **`canvas_draw` / `canvas_list` / `canvas_delete` are read tools** — no `write: true`, never a y/n; a press is the only thing that reaches the model, through `host.services.postToChat`.
- **Vocabulary is closed.** Allowed types only: `Box, Text, Markdown, Table, ScrollBox, Link, progress, badge, rows, tasks, rule, input, check, select, button`. Unknown type or prop ⇒ reject the whole draw, canvas unchanged.
- **Caps, enforced before storing:** ≤ 400 nodes, depth ≤ 8, ≤ 100 children per box, ≤ 2 000 chars per `Text`/`badge`/`rows` cell, ≤ 40 interactive nodes, ≤ 200 chars per value, ≤ 64 000 bytes serialized.
- **Colours are palette tokens only:** `ok`, `warn`, `error`, `accent`, `dim`, `muted`, `default`. Never a literal colour, never an escape sequence.
- **No `ProgressBar`/`TaskList`/`ScrollList`/`Span`/`HRule`** — none of them are in `PluginUi`; composites are drawn from `Box`/`Text`/`Table`.
- **Plugin imports no runtime dependency** (a plugin loaded by the compiled binary cannot resolve packages): `node:` builtins and relative files only; `z` and `make` come from the builder's args.
- **Keys are gated:** every flowtty component that hears input takes `isFocused` = `host.hasKeyboard() && (focus model says so)`. Tab never reaches flowtty — it comes through `host.useInputHandler`.
- **Surface is sized by `host.useSurfaceSize()`**, never `useTerminalSize`.
- **Comments in English, present tense**; the repo's conventions (see `plugins-available/repo`).
- Tests: `bun test`; plugin units in `plugins-available/canvas/src/__tests__/`, host e2e in `src/__tests__/canvas-plugin.e2e.test.ts`.
- **Recipes (templates) are the only durable thing.** `services.cache` (namespaced KV over `cache.json`), namespace `canvas/templates`, `ttl: 0` = never expires, no key listing (keep an index entry), off when `config.cache.enabled: false`, wiped by `cache clear`.
- **A recipe is `{ name, title, tree, savedAt }` — no values, no owner.** Keyed `<scope>/<name>`, `scope` = `project:<path>` from `ctx.workspaceProject?.()` or `global`; lookup tries the project then global. Names are slugs `[a-z0-9][a-z0-9._-]{0,39}`; ≤ 50 per scope; **re-validated with `checkTree` on load** and refused with the reason if the vocabulary moved on.

## Review Focus

1. **A canvas taller than the pane.** A 40-job pipeline must scroll inside the body and never paint over the footer or the keycaps — the expected behaviour is that every row is reachable and the header stays visible. (Task 8)
2. **Wide and non-ASCII text.** A branch name or title with CJK/emoji must be measured in terminal cells (`stringWidth`), so a bar, a tab or the header never wraps or overflows. (Tasks 5, 6, 8)
3. **A bad tree from the model.** Oversized, too deep, unknown type or unknown prop ⇒ one readable error naming the problem and the allowed vocabulary, the canvas left exactly as it was, no throw into the turn, no hang. (Task 2)
4. **Two agents, same canvas id vs. different ids.** Same id: last draw wins, the person's typed values survive, no stale canvas stays behind. Different ids: both exist, both reachable by tab keys, the registry lists both. (Tasks 3, 8)
5. **Typing when the canvas does not have the keys.** With the chat focused, the `:` line open, or a modal up, a canvas field must take no keys and the header must not claim focus. (Task 8)
6. **A recipe saved under an older vocabulary, or with the cache off.** Loading it must answer with the problem (and say the cache is off) and leave the canvas as it was — a returned user is the likeliest person to hit this. (Task 9)

---

### Task 1: Plugin skeleton that loads and does nothing

**Files:**
- Create: `plugins-available/canvas/manifest.json`
- Create: `plugins-available/canvas/package.json`
- Create: `plugins-available/canvas/tsconfig.json`
- Create: `plugins-available/canvas/src/index.ts`
- Test: `plugins-available/canvas/src/__tests__/index.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export default function buildCanvasPlugin({ config, make, z }: { config?: unknown; make: Make; z: unknown }): unknown` — the plugin builder, imported by every later task and by the host e2e test.

- [ ] **Step 1: Write the failing test**

```ts
// plugins-available/canvas/src/__tests__/index.test.ts
import { expect, test } from 'bun:test';
import buildCanvasPlugin from '../index.ts';

const fakeMake = (name: string, shape: Record<string, unknown>) => ({ name, shape });

test('the builder returns a canvas shape with no surface and no tools yet', () => {
  const plugin = buildCanvasPlugin({ make: fakeMake as never, config: {} }) as { name: string; shape: Record<string, unknown> };
  expect(plugin.name).toBe('canvas');
  expect(plugin.shape.keycaps?.()).toEqual([]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test plugins-available/canvas/src/__tests__/index.test.ts`
Expected: FAIL — `Cannot find module '../index.ts'`.

- [ ] **Step 3: Write the manifest, package and a minimal builder**

`manifest.json`:

```json
{
  "name": "canvas",
  "version": "0.1.0",
  "hostApi": 2,
  "flowtty": ">=1.0.0-alpha.37 <1.0.0-alpha.38",
  "description": "A canvas the model draws: live panels for state and pipelines",
  "tools": ["canvas"]
}
```

`package.json`: copy `plugins-available/repo/package.json`, changing `name` to `@local/canvas-plugin`. `tsconfig.json`: copy `plugins-available/repo/tsconfig.json` unchanged.

`src/index.ts` — builder returns `make('canvas', { name: 'canvas', keycaps: () => [] })`.

- [ ] **Step 4: Run the test again**

Run: `bun test plugins-available/canvas/src/__tests__/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins-available/canvas
git commit -m "feat(canvas): plugin skeleton that loads with no surface"
```

---

### Task 2: The vocabulary — validation and caps

**Files:**
- Create: `plugins-available/canvas/src/tree.ts`
- Test: `plugins-available/canvas/src/__tests__/tree.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type Node = [type: string, props?: Record<string, unknown>, ...children: Array<Node | string>];
  export type TStats = { nodes: number; deepest: number; interactive: number };
  export type TChecked = { ok: true; tree: Node; stats: TStats } | { ok: false; error: string };
  export function checkTree(tree: unknown): TChecked;
  export const LIMITS: { nodes: number; depth: number; children: number; text: number; value: number; interactive: number; bytes: number };
  export const VOCABULARY: string;   // reference text used by the tool description (Task 4)
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'bun:test';
import { checkTree, LIMITS, VOCABULARY } from '../tree.ts';

test('a valid tree passes and its stats are counted', () => {
  const r = checkTree(['Box', { flexDirection: 'column' }, ['Text', {}, 'hi'], ['button', { label: 'go', action: 'go' }]]);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.stats).toEqual({ nodes: 3, deepest: 2, interactive: 1 });
});

test('an unknown type is refused, naming it and the allowed types', () => {
  const r = checkTree(['Pipeline', {}, 'x']);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.error).toContain('Pipeline');
    expect(r.error).toContain('progress');
    expect(r.error).toContain('not drawn');
  }
});

test('an unknown prop on a known type is refused', () => {
  const r = checkTree(['Text', { colour: 'red' }, 'x']);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain('colour');
});

test('a literal colour is refused — palette tokens only', () => {
  const r = checkTree(['Text', { color: '#ff0000' }, 'x']);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain('palette');
});

test('caps hold: nodes, depth, children, text, interactive count, bytes', () => {
  const many = ['Box', {}, ...Array.from({ length: LIMITS.children + 1 }, () => ['Text', {}, 'x'] as const)];
  expect(checkTree(many).ok).toBe(false);
  let deep: unknown = ['Text', {}, 'x'];
  for (let i = 0; i < LIMITS.depth; i++) deep = ['Box', {}, deep];
  expect(checkTree(deep).ok).toBe(false);
  expect(checkTree(['Text', {}, 'x'.repeat(LIMITS.text + 1)]).ok).toBe(false);
  expect(checkTree(['button', { label: 'x'.repeat(LIMITS.value + 1), action: 'a' }]).ok).toBe(false);
  const buttons = ['Box', {}, ...Array.from({ length: LIMITS.interactive + 1 }, () => ['button', { label: 'b', action: 'a' }] as const)];
  expect(checkTree(buttons).ok).toBe(false);
  // 40 × 2 000 chars: under the node cap, over the byte cap
  const fat = ['Box', {}, ...Array.from({ length: 40 }, () => ['Text', {}, 'y'.repeat(LIMITS.text)] as const)];
  const fatCheck = checkTree(fat);
  expect(fatCheck.ok).toBe(false);
  if (!fatCheck.ok) expect(fatCheck.error).toContain('too big');
});

test('the error is one short message, not a wall: three problems are cut with a count', () => {
  const r = checkTree(['Box', {}, ['Nope', {}], ['Nope2', {}], ['Nope3', {}], ['Nope4', {}]]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.split('\n').length).toBeLessThanOrEqual(6);
});

test('the vocabulary text names every type', () => {
  for (const t of ['Box', 'Text', 'Markdown', 'Table', 'ScrollBox', 'Link', 'progress', 'badge', 'rows', 'tasks', 'rule', 'input', 'check', 'select', 'button']) {
    expect(VOCABULARY).toContain(t);
  }
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test plugins-available/canvas/src/__tests__/tree.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tree.ts`**

A table `ALLOWED: Record<string, { props: Record<string, 'string' | 'number' | 'boolean' | 'array' | 'object'>; children: 'text' | 'nodes' | 'both' }>` for every type above, plus `TONE_TOKENS = ['ok', 'warn', 'error', 'accent', 'dim', 'muted', 'default']`. `checkTree` walks depth-first, collecting problems (max 3 distinct, then `…and N more`), checks caps from `LIMITS`, and measures bytes with `JSON.stringify(tree).length`. Rejections read: `not drawn: no component «Pipeline» — the types are …`, `Text has no prop «colour» — its props are color, bold, dim, wrap, truncate`, `color must be a palette token (ok, warn, …)`.

`VOCABULARY` is the tool-facing reference: one line per type with its props, the caps in one line, the palette tokens, and one example pipeline tree (copy the one in the spec).

- [ ] **Step 4: Run the tests again**

Run: `bun test plugins-available/canvas/src/__tests__/tree.test.ts`
Expected: PASS (all six).

- [ ] **Step 5: Commit**

```bash
git add plugins-available/canvas/src/tree.ts plugins-available/canvas/src/__tests__/tree.test.ts
git commit -m "feat(canvas): the component vocabulary and its caps"
```

---

### Task 3: The registry — canvases, values, selection, outline

**Files:**
- Create: `plugins-available/canvas/src/store.ts`
- Test: `plugins-available/canvas/src/__tests__/store.test.ts`

**Interfaces:**
- Consumes: `Node`, `TStats` from `../tree.ts`.
- Produces:
  ```ts
  export type TValue = string | boolean;
  export type TCanvas = { id: string; title: string; owner: string; tree: Node; values: Record<string, TValue>; declared: Record<string, TValue>; updatedAt: number; revision: number; stats: TStats };
  export type TStore = { canvases: Map<string, TCanvas>; selectedId: string | null; personOpened: boolean; pressed: string | null };
  export function createStore(now?: () => number): TStore;
  export function drawCanvas(store: TStore, input: { id: string; title?: string; owner?: string; tree: Node; stats: TStats }): TCanvas;
  export function deleteCanvas(store: TStore, id: string): boolean;
  export function selectCanvas(store: TStore, id: string): boolean;
  export function selectedCanvas(store: TStore): TCanvas | undefined;
  export function setValue(store: TStore, id: string, bind: string, value: TValue): void;
  export function pressMessage(canvas: TCanvas, label: string): string;
  export function registryItems(store: TStore, now: () => number): Array<{ label: string; text: string }>;
  export function outline(canvas: TCanvas, max?: number): string;
  ```
- Values come from the tree's declared `value` props; `declared` remembers what the model said last time so `drawCanvas` can tell "prefill/reset" from "keep what the person typed".

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'bun:test';
import { createStore, drawCanvas, deleteCanvas, pressMessage, registryItems, selectCanvas, setValue, selectedCanvas, outline } from '../store.ts';
import { checkTree } from '../tree.ts';

const stats = { nodes: 2, deepest: 1, interactive: 1 };
const tree = ['Box', {}, ['input', { bind: 'branch', value: 'main' }], ['button', { label: 'go', action: 'check it' }]] as never;

test('draw creates a canvas, selects it and seeds values from the tree', () => {
  const store = createStore(() => 1000);
  const c = drawCanvas(store, { id: 'ci', owner: 'reviewer', tree, stats });
  expect(c.id).toBe('ci');
  expect(c.values).toEqual({ branch: 'main' });
  expect(selectedCanvas(store)?.id).toBe('ci');
  expect(c.updatedAt).toBe(1000);
});

test('redrawing keeps what the person typed, unless the model changes the declared value', () => {
  const store = createStore();
  drawCanvas(store, { id: 'ci', tree, stats });
  setValue(store, 'ci', 'branch', 'feature-x');
  drawCanvas(store, { id: 'ci', tree, stats });
  expect(store.canvases.get('ci')!.values.branch).toBe('feature-x');
  const changed = ['Box', {}, ['input', { bind: 'branch', value: 'develop' }]] as never;
  drawCanvas(store, { id: 'ci', tree: changed, stats });
  expect(store.canvases.get('ci')!.values.branch).toBe('develop');
  drawCanvas(store, { id: 'ci', tree: ['Box', {}, ['Text', {}, 'no fields']] as never, stats });
  expect(store.canvases.get('ci')!.values).toEqual({});
});

test('delete removes one; deleting the last clears the selection', () => {
  const store = createStore();
  drawCanvas(store, { id: 'a', tree, stats });
  drawCanvas(store, { id: 'b', tree, stats });
  expect(deleteCanvas(store, 'a')).toBe(true);
  expect(deleteCanvas(store, 'missing')).toBe(false);
  expect(deleteCanvas(store, 'b')).toBe(true);
  expect(selectedCanvas(store)).toBeUndefined();
});

test('two canvases coexist and select moves between them', () => {
  const store = createStore();
  drawCanvas(store, { id: 'a', tree, stats });
  drawCanvas(store, { id: 'b', tree, stats });
  expect([...store.canvases.keys()]).toEqual(['a', 'b']);
  expect(selectCanvas(store, 'a')).toBe(true);
  expect(selectedCanvas(store)?.id).toBe('a');
  expect(selectCanvas(store, 'nope')).toBe(false);
});

test('the press message carries the label and every value', () => {
  const store = createStore();
  const c = drawCanvas(store, { id: 'ci', owner: 'reviewer', tree, stats });
  setValue(store, 'ci', 'branch', 'feature-x');
  expect(pressMessage(c, 'go')).toBe('[canvas] «ci» pressed «go» — branch: feature-x');
});

test('registry items are one short line per canvas, with age and side-up', () => {
  const store = createStore(() => 1000);
  drawCanvas(store, { id: 'ci', title: 'Pipelines', owner: 'reviewer', tree, stats });
  const items = registryItems(store, () => 1000 + 120_000);
  expect(items).toHaveLength(1);
  expect(items[0]!.text).toContain('2m');
  expect(items[0]!.text).toContain('reviewer');
});

test('the outline is depth-first, capped, and mentions the bindable fields', () => {
  const store = createStore();
  const c = drawCanvas(store, { id: 'ci', tree, stats });
  const text = outline(c, 30);
  expect(text.split('\n').length).toBeLessThanOrEqual(30);
  expect(text).toContain('input branch=main');
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test plugins-available/canvas/src/__tests__/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/store.ts`**

Map-backed registry; `drawCanvas` collects `{ bind: value }` from `input`/`check`/`select` nodes (a `select`'s value is its `value` or first option), compares with `declared`, keeps live values when unchanged, then replaces `declared` and the tree, bumps `revision`, sets `selectedId` to the drawn id, clears `pressed`. `pressMessage(canvas, label)` renders `[canvas] «id» pressed «label» — bind: value · bind: value`, skipping a canvas with no values.

- [ ] **Step 4: Run again**

Run: `bun test plugins-available/canvas/src/__tests__/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins-available/canvas/src/store.ts plugins-available/canvas/src/__tests__/store.test.ts
git commit -m "feat(canvas): the canvas registry, its values and the press message"
```

---

### Task 4: Tools, screens and the model's context

**Files:**
- Create: `plugins-available/canvas/src/tools.ts`
- Modify: `plugins-available/canvas/src/index.ts`
- Test: `plugins-available/canvas/src/__tests__/tools.test.ts`
- Test: `src/__tests__/canvas-plugin.e2e.test.ts`

**Interfaces:**
- Consumes: `checkTree`, `VOCABULARY` (Task 2); `drawCanvas`, `deleteCanvas`, `selectCanvas`, `registryItems`, `outline`, `TStore` (Task 3).
- Produces:
  ```ts
  export type TToolsDeps = { store: TStore; now: () => number; notify: () => void; note: (text: string) => void; open: (screen: string, params: Record<string, unknown>) => Promise<{ ok: boolean; text: string }> | undefined };
  export function buildGroup(deps: TToolsDeps): { id: string; description: string; tools: unknown[]; exec: (name: string, args: Record<string, unknown>, ctx: unknown) => Promise<string> };
  ```
  and in the shape: `tools: [group]`, `screens: { show: { entry: true, title: 'canvas', params: {…}, tools: ['canvas_open', 'canvas_focus'], open, close } }`, `chatContext: (api) => [ ...registryItems(store, now), ...(selected ? [{ label: selected.title, text: outline(selected) }] : []) ]` — the outline carries the current values, so a session that did not draw the canvas still sees what was typed.
- `note` is bound to `host.services.showMessage` (the toast): a draw made while the surface is down says one line there.

- [ ] **Step 1: Write the failing unit tests**

```ts
import { expect, test } from 'bun:test';
import { buildGroup } from '../tools.ts';
import { createStore } from '../store.ts';

const deps = (over: Partial<Parameters<typeof buildGroup>[0]> = {}) => {
  const store = createStore(() => 5_000);
  const notes: string[] = [];
  return { store, notes, group: buildGroup({ store, now: () => 5_000, notify: () => {}, note: (t) => notes.push(t), open: async () => ({ ok: true, text: 'opened' }), ...over }) };
};

test('canvas_draw validates, stores, and answers with counts and side state', async () => {
  const { group, store } = deps();
  const out = await group.exec('canvas_draw', { canvas: 'ci', title: 'Pipelines', owner: 'reviewer', tree: ['Box', {}, ['Text', {}, 'hello']] }, {});
  expect(out).toContain('«ci»');
  expect(out).toContain('side down');
  expect(store.canvases.get('ci')!.title).toBe('Pipelines');
});

test('a bad tree is refused and the canvas is untouched', async () => {
  const { group, store } = deps();
  const before = await group.exec('canvas_draw', { canvas: 'ci', tree: ['Box', {}, ['Text', {}, 'ok']] }, {});
  expect(before).toContain('«ci»');
  const out = await group.exec('canvas_draw', { canvas: 'ci', tree: ['Pipe', {}] }, {});
  expect(out).toContain('Pipe');
  expect(store.canvases.get('ci')!.tree[2]).toEqual(['Text', {}, 'ok']);
});

test('canvas_list names every canvas with owner and age', async () => {
  const { group } = deps();
  await group.exec('canvas_draw', { canvas: 'a', owner: 'me', tree: ['Text', {}, 'x'] }, {});
  await group.exec('canvas_draw', { canvas: 'b', owner: 'you', tree: ['Text', {}, 'y'] }, {});
  const out = await group.exec('canvas_list', {}, {});
  expect(out).toContain('«a»');
  expect(out).toContain('«b»');
  expect(out).toContain('you');
});

test('canvas_delete removes and says so; the last one unmounts', async () => {
  const { group, store } = deps();
  await group.exec('canvas_draw', { canvas: 'a', tree: ['Text', {}, 'x'] }, {});
  expect(await group.exec('canvas_delete', { canvas: 'a' }, {})).toContain('deleted');
  expect(store.canvases.size).toBe(0);
  expect(await group.exec('canvas_delete', { canvas: 'a' }, {})).toContain('no canvas');
});

test('canvas_focus asks the host to open the screen; a refusal is passed on verbatim', async () => {
  const refusal = { ok: false, text: 'Not opened: screens are not opened from background work.' };
  const { group, notes } = deps({ open: async () => refusal });
  await group.exec('canvas_draw', { canvas: 'a', tree: ['Text', {}, 'x'] }, {});
  const out = await group.exec('canvas_focus', { canvas: 'a' }, {});
  expect(out).toContain('Not opened');
  expect(notes).toHaveLength(1);   // the toast the draw made, and nothing from the refusal
});

test('a draw while the surface is down says one line; a draw while it is up says nothing', async () => {
  const { group, store, notes } = deps();
  await group.exec('canvas_draw', { canvas: 'a', tree: ['Text', {}, 'x'] }, {});
  expect(notes).toEqual(['canvas «a» updated']);
  store.personOpened = true;
  await group.exec('canvas_draw', { canvas: 'a', tree: ['Text', {}, 'y'] }, {});
  expect(notes).toHaveLength(1);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test plugins-available/canvas/src/__tests__/tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools.ts` and wire it in `index.ts`**

Group `id: 'canvas'`, `description: VOCABULARY`, five tools with JSON-schema parameters. `exec` maps each name, returns strings exactly as the tests assert; `canvas_draw` returns `drew canvas «id» (N nodes) — side up|side down` and, when the surface is down, calls `note('canvas «id» updated')`. `index.ts` keeps `const store = createStore()` in `setup` (store also on `host.store.canvas`), `notify` = `host.notify`, `note` = `host.services.showMessage`, `open` = `host.open`.

- [ ] **Step 4: Write the host e2e test**

```ts
// src/__tests__/canvas-plugin.e2e.test.ts
import { expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import buildCanvasPlugin from '../../plugins-available/canvas/src/index.ts';

const boot = (model: ScriptedModel) => bootApp(model, 110, 32, (make) => [buildCanvasPlugin({ make, config: {} })]);

test('the model draws a canvas with a read tool; the answer names it and the context carries it', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'canvas_draw', args: { canvas: 'ci', title: 'Pipelines', owner: 'reviewer', tree: ['Box', {}, ['badge', { text: 'failed', tone: 'error' }]] } }],
    [{ text: 'Drawn.' }],
  );
  const ui = await boot(model);
  await ui.press('F');
  await ui.type('show me the pipeline');
  await ui.press('return');
  await settle(20);
  const toolMsgs = (model.requests[0]!.messages as Array<{ role: string; content?: unknown }>).filter((m) => m.role === 'tool');
  expect(String(toolMsgs.at(-1)?.content)).toContain('«ci»');
  // no y/n: it is a read
  expect(ui.backend.lastFrame).not.toContain('Confirm write: canvas_draw');
  // the next request carries what the person sees
  const tail = String((model.requests.at(-1) as { messages: Array<{ role: string; content?: unknown }> }).messages.at(-1)?.content ?? '');
  expect(tail).toContain('Pipelines');
});
```

- [ ] **Step 5: Run both**

Run: `bun test plugins-available/canvas/src/__tests__/tools.test.ts src/__tests__/canvas-plugin.e2e.test.ts`
Expected: PASS. If the tail assertion fails, read how `screenBlock` frames items (`src/assistant/screen-context.ts`) and assert on the framing it does produce — the label and text must both appear.

- [ ] **Step 6: Commit**

```bash
git add plugins-available/canvas/src/tools.ts plugins-available/canvas/src/index.ts plugins-available/canvas/src/__tests__/tools.test.ts src/__tests__/canvas-plugin.e2e.test.ts
git commit -m "feat(canvas): draw, list, delete, focus tools and the model's context"
```

---

### Task 5: Composites — bars, badges, rows, tasks, rules

**Files:**
- Create: `plugins-available/canvas/src/parts.ts`
- Test: `plugins-available/canvas/src/__tests__/parts.test.ts`

**Interfaces:**
- Consumes: nothing (pure strings and numbers in, strings out).
- Produces:
  ```ts
  export function bar(value: number, width: number): string;                     // '████░░░░'
  export function percentText(value: number): string;                            // '75%'
  export function taskGlyph(state: 'done' | 'running' | 'queued' | 'failed'): string; // '✓ ● ○ ✗'
  export function toneToken(tone: unknown): string;                              // 'ok' | … | 'default'
  export function fit(text: string, width: number): string;                      // truncate with '…', measured in cells
  ```
  `fit` takes a `stringWidth` function so cells, not `.length`, decide: `fit(text, width, stringWidth)`.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'bun:test';
import { bar, fit, percentText, taskGlyph, toneToken } from '../parts.ts';
const w = (s: string) => Array.from(s).reduce((n, ch) => n + (/[\u3000-\u9fff]/u.test(ch) ? 2 : 1), 0);

test('bar rounds and never exceeds its width', () => {
  expect(bar(0, 10)).toBe('░░░░░░░░░░');
  expect(bar(100, 10)).toBe('██████████');
  expect(bar(75, 10)).toBe('███████░░░');
  expect(bar(140, 10)).toBe('██████████');
  expect(bar(-3, 10)).toBe('░░░░░░░░░░');
  expect(bar(50, 0)).toBe('');
});

test('percent is a whole number', () => {
  expect(percentText(75)).toBe('75%');
  expect(percentText(33.4)).toBe('33%');
  expect(percentText(Number.NaN)).toBe('0%');
});

test('task states have one glyph each', () => {
  expect(['done', 'running', 'queued', 'failed'].map(taskGlyph)).toEqual(['✓', '●', '○', '✗']);
});

test('tones map to palette tokens and anything else to default', () => {
  expect(toneToken('error')).toBe('error');
  expect(toneToken('#f00')).toBe('default');
  expect(toneToken(undefined)).toBe('default');
});

test('fit truncates in cells, not code units', () => {
  expect(fit('abcdef', 10, w)).toBe('abcdef');
  expect(fit('abcdefghij', 6, w)).toBe('abcde…');
  expect(fit('日本語のテキスト', 5, w)).toBe('日本…');
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test plugins-available/canvas/src/__tests__/parts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/parts.ts`**

Four small pure functions plus `fit`. `bar` clamps and rounds `Math.round(value / 100 * width)`.

- [ ] **Step 4: Run again**

Run: `bun test plugins-available/canvas/src/__tests__/parts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins-available/canvas/src/parts.ts plugins-available/canvas/src/__tests__/parts.test.ts
git commit -m "feat(canvas): the composite pieces — bars, badges, rows, tasks"
```

---

### Task 6: Rendering the tree — static and composite nodes

**Files:**
- Create: `plugins-available/canvas/src/render.ts`
- Test: `plugins-available/canvas/src/__tests__/render.test.ts`

**Interfaces:**
- Consumes: `Node` (Task 2); `bar`, `fit`, `percentText`, `taskGlyph`, `toneToken` (Task 5).
- Produces:
  ```ts
  export type TUi = { h: (type: unknown, props?: Record<string, unknown>, ...children: unknown[]) => unknown; Box: unknown; Text: unknown; Markdown: unknown; Table: unknown; ScrollBox: unknown; Link: unknown };
  export type TRenderCtx = { ui: TUi; width: number; stringWidth: (s: string) => number; focusKey: string | null; hasKeyboard: boolean; values: Record<string, string | boolean>; onValue: (bind: string, value: string | boolean) => void; onPress: (label: string, action: string) => void };
  export function toElement(node: Node | string, ctx: TRenderCtx): unknown;
  ```
- `values` and the interactive branches are Task 7's; here the tree is static-only, and an interactive node renders as a placeholder line.
- Test approach: a recording fake `h` that returns `{ type, props, children }`, so the tree is asserted without a terminal; `Box`/`Text`/… are string markers in the fake `ui`.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'bun:test';
import { toElement, type TRenderCtx } from '../render.ts';

type T = { type: string; props: Record<string, unknown>; children: unknown[] };
const h = (type: unknown, props: Record<string, unknown> = {}, ...children: unknown[]): T => ({ type: String(type), props, children });
const ui = { h, Box: 'Box', Text: 'Text', Markdown: 'Markdown', Table: 'Table', ScrollBox: 'ScrollBox', Link: 'Link' };
const ctx = (over: Partial<TRenderCtx> = {}): TRenderCtx => ({ ui, width: 80, stringWidth: (s) => s.length, focusKey: null, hasKeyboard: true, values: {}, onValue: () => {}, onPress: () => {}, ...over });

test('Text keeps its props and passes tokens through', () => {
  const el = toElement(['Text', { color: 'error', bold: true }, 'hello'], ctx()) as T;
  expect(el.type).toBe('Text');
  expect(el.props).toEqual({ color: 'error', bold: true });
  expect(el.children).toEqual(['hello']);
});

test('a literal colour is never passed through', () => {
  const el = toElement(['Text', { color: '#ff0000' }, 'x'], ctx()) as T;
  expect(el.props.color).toBe('default');
});

test('progress becomes a label and a bar sized to the width', () => {
  const el = toElement(['progress', { label: 'jobs', value: 75 }], ctx({ width: 40 })) as T;
  expect(el.type).toBe('Box');
  const line = (el.children as T[])[0]!;
  const text = (line.children as T[]).map((c) => c.children?.[0] ?? c).join('');
  expect(text).toContain('jobs');
  expect(text).toContain('75%');
  expect(text).toContain('█');
});

test('progress on a narrow pane still draws one cell of bar', () => {
  const el = toElement(['progress', { label: 'jobs', value: 50 }], ctx({ width: 12 })) as T;
  expect(JSON.stringify(el)).toContain('█');
});

test('tasks and rows render one line per item, narrow panes truncated', () => {
  const el = toElement(['tasks', { items: [{ text: 'a very long job name that will not fit', state: 'done' }] }], ctx({ width: 14 })) as T;
  expect(JSON.stringify(el)).toContain('…');
  const rows = toElement(['rows', { items: [{ label: 'branch', value: 'main' }] }], ctx()) as T;
  expect(JSON.stringify(rows)).toContain('branch');
});

test('a table passes columns and rows through, capped by the tree caps', () => {
  const el = toElement(['Table', { columns: [{ key: 'a', label: 'A' }], rows: [['1']] }], ctx()) as T;
  expect(el.type).toBe('Table');
  expect(el.props.columns).toEqual([{ key: 'a', label: 'A' }]);
});

test('wide characters are measured with the injected stringWidth', () => {
  const el = toElement(['Text', { wrap: 'truncate' }, '日本語テキスト'], ctx({ width: 6, stringWidth: () => 20 })) as T;
  expect(JSON.stringify(el)).toContain('…');
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test plugins-available/canvas/src/__tests__/render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/render.ts`**

`toElement` switches on the node type: containers recurse; `Text` sanitises `color` through `toneToken` and truncates with `fit` when `wrap: 'truncate'`; `progress`/`badge`/`rows`/`tasks`/`rule` build `Box`+`Text` lines; `Table` passes `columns`/`rows`; `ScrollBox` recurses; `Link` takes `url`. The bar width is `Math.max(3, Math.min(20, width - labelWidth - 8))`. Interactive nodes are Task 7 — for now they render as static placeholders.

- [ ] **Step 4: Run again**

Run: `bun test plugins-available/canvas/src/__tests__/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins-available/canvas/src/render.ts plugins-available/canvas/src/__tests__/render.test.ts
git commit -m "feat(canvas): render the tree with flowtty components"
```

---

### Task 7: Interactive nodes and the focus model

**Files:**
- Modify: `plugins-available/canvas/src/render.ts`
- Create: `plugins-available/canvas/src/focus.ts`
- Test: `plugins-available/canvas/src/__tests__/focus.test.ts`
- Test: `plugins-available/canvas/src/__tests__/render.test.ts` (extend)

**Interfaces:**
- Consumes: `Node` (Task 2), `TRenderCtx` (Task 6), `TValue` (Task 3).
- Produces:
  ```ts
  // focus.ts — one focus key per interactive node, in tree order
  export function focusKeys(node: Node | string): string[];   // a field's bind, or 'btn:<n>' for a button
  export function nextKey(keys: string[], current: string | null, step: 1 | -1): string | null;
  export function actionOf(node: Node | string, key: string): { label: string; action: string } | null;
  ```
  `render.ts` gains `values: Record<string, TValue>` on `TRenderCtx` (the canvas's live values) and `focusKey: string | null`; the four interactive types are gated by `isFocused: ctx.hasKeyboard && ctx.focusKey === key`, take their value from `ctx.values[bind]`, and report edits through `ctx.onValue(bind, value)`; a button is `Text` with `onClick` calling the same `ctx.onPress(label, action)` the keyboard path uses.

- [ ] **Step 1: Write the failing tests**

```ts
// focus.test.ts
import { expect, test } from 'bun:test';
import { actionOf, focusKeys, nextKey } from '../focus.ts';

const tree = ['Box', {}, ['input', { bind: 'branch' }], ['Box', {}, ['check', { bind: 'watch' }], ['button', { label: 'go', action: 'check it' }]]] as never;

test('focus keys come in tree order: binds for fields, btn:<n> for buttons', () => {
  expect(focusKeys(tree)).toEqual(['branch', 'watch', 'btn:0']);
});

test('Tab wraps forward and backward; empty stays null', () => {
  expect(nextKey(['a', 'b'], null, 1)).toBe('a');
  expect(nextKey(['a', 'b'], 'a', 1)).toBe('b');
  expect(nextKey(['a', 'b'], 'b', 1)).toBe('a');
  expect(nextKey(['a', 'b'], 'a', -1)).toBe('b');
  expect(nextKey([], null, 1)).toBeNull();
});

test('a button resolves by its focus key; a field does not press', () => {
  expect(actionOf(tree, 'btn:0')).toEqual({ label: 'go', action: 'check it' });
  expect(actionOf(tree, 'branch')).toBeNull();
});
```

```ts
// render.test.ts — add
test('a field is focusable only when the canvas has the keys', () => {
  const focused = toElement(['input', { bind: 'branch', value: 'main' }], ctx({ focusKey: 'branch', values: { branch: 'main' }, hasKeyboard: true })) as T;
  expect(focused.props.isFocused).toBe(true);
  const muted = toElement(['input', { bind: 'branch' }], ctx({ focusKey: 'branch', values: { branch: 'main' }, hasKeyboard: false })) as T;
  expect(muted.props.isFocused).toBe(false);
});

test('a field reports an edit with its bind', () => {
  const seen: Array<[string, unknown]> = [];
  const el = toElement(['input', { bind: 'branch' }], ctx({ values: { branch: 'main' }, onValue: (bind, v) => seen.push([bind, v]) })) as T;
  (el.props.onChange as (v: string) => void)('feature-x');
  expect(seen).toEqual([['branch', 'feature-x']]);
});

test('a button presses through onClick and reports its action', () => {
  const seen: Array<[string, string]> = [];
  const el = toElement(['button', { label: 'check again', action: 'check it' }], ctx({ onPress: (label, action) => seen.push([label, action]) })) as T;
  (el.props.onClick as () => void)();
  expect(seen).toEqual([['check again', 'check it']]);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test plugins-available/canvas/src/__tests__/focus.test.ts plugins-available/canvas/src/__tests__/render.test.ts`
Expected: FAIL — `../focus.ts` not found; the render additions fail on props.

- [ ] **Step 3: Implement `src/focus.ts` and the interactive branches in `render.ts`**

`input` → a `Box` of `width: props.width ?? 24` around `ui.TextInput` (`frame: 'field'`, controlled `value`, `onChange`, `isFocused`). `check` → `ui.Checkbox` (`checked`, `onChange(next)`, `label`, `isFocused`). `select` → `ui.Select` (`items: options`, `value`, `onChange`, `isFocused`). `button` → `ui.Text` (`bold: true`, `color: tone`, `selectable: false`, `onClick`).

- [ ] **Step 4: Run again**

Run: `bun test plugins-available/canvas/src/__tests__/focus.test.ts plugins-available/canvas/src/__tests__/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins-available/canvas/src/focus.ts plugins-available/canvas/src/render.ts plugins-available/canvas/src/__tests__/focus.test.ts plugins-available/canvas/src/__tests__/render.test.ts
git commit -m "feat(canvas): interactive nodes and the focus cycle"
```

---

### Task 8: The surface — header, tabs, body, keys, and the press

**Files:**
- Create: `plugins-available/canvas/src/view.ts`
- Modify: `plugins-available/canvas/src/index.ts`
- Test: `src/__tests__/canvas-plugin.e2e.test.ts` (extend)

**Interfaces:**
- Consumes: `toElement` (Tasks 6–7), `focusKeys`, `nextKey`, `actionOf` (Task 7), `TStore` (Task 3), `pressMessage` (Task 3).
- Produces: `export function canvasView(api: { ui: TUi; host: { useSurfaceSize(): { width: number; height: number }; useInputHandler(opts: unknown): void; hasKeyboard(): boolean; services: Record<string, any>; notify(): void; keyCap(action: string): string } }, store: TStore): () => unknown` — a component factory for the `view` slot; and in the shape `keycaps` returning hints only while `store.personOpened && store.canvases.size > 0`.

- [ ] **Step 1: Write the failing e2e tests**

```ts
const settleUntil = async (ui: Ui, ok: () => boolean, n = 200) => { for (let i = 0; i < n && !ok(); i++) await settle(1); if (!ok()) throw new Error(`never\n${ui.backend.lastFrame}`); };
const turn = async (ui: Ui, text: string) => { await ui.press('F'); await ui.type(text); await ui.press('return'); await settle(20); };
const toPlugin = async (ui: Ui) => { ui.backend.press({ name: ']', ctrl: true }); await settle(); };

test('canvas_open mounts the surface; the person types, presses, and the agent gets one framed message', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'canvas_open', args: { canvas: 'ci' } }, { tool: 'canvas_draw', args: { canvas: 'ci', title: 'Pipelines', owner: 'reviewer', tree: [
      ['Box', { flexDirection: 'column' }, ['input', { bind: 'branch', value: 'main' }], ['button', { label: 'check again', action: 'check it' }]],
    ] } }],
    [{ text: 'Drawn.' }],
  );
  const ui = await boot(model);
  await turn(ui, 'draw the pipeline');
  await settleUntil(ui, () => ui.backend.lastFrame.includes('Pipelines'));
  await toPlugin(ui);
  await ui.press('tab');                    // focus the branch field
  await ui.type('feature-x');
  await ui.press('tab');                    // to the button
  await ui.press('return');
  await settle(10);
  const asked = model.requests.at(-1)!.messages as Array<{ role: string; content?: unknown }>;
  const last = asked.at(-1)!;
  expect(String(last.content)).toContain('pressed «check again»');
  expect(String(last.content)).toContain('branch: feature-x');
});

test('a draw while the surface is down mounts nothing — one toast says it happened', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'canvas_draw', args: { canvas: 'ci', title: 'Pipelines', tree: ['Text', {}, 'x'] } }], [{ text: 'Drawn.' }]);
  const ui = await boot(model);
  await turn(ui, 'draw it');
  expect(ui.backend.lastFrame).not.toContain('canvas · Pipelines');
  expect(ui.backend.lastFrame).toContain('canvas «ci» updated');
});

test('two canvases: ] and [ move between them, x x deletes, Esc closes the surface', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'canvas_open', args: {} },
     { tool: 'canvas_draw', args: { canvas: 'a', title: 'Alpha', tree: ['Text', {}, 'first'] } },
     { tool: 'canvas_draw', args: { canvas: 'b', title: 'Beta', tree: ['Text', {}, 'second'] } }],
    [{ text: 'Two.' }],
  );
  const ui = await boot(model);
  await turn(ui, 'draw two');
  await settleUntil(ui, () => ui.backend.lastFrame.includes('Beta'));
  await toPlugin(ui);
  await ui.press('[');
  expect(ui.backend.lastFrame).toContain('Alpha');
  await ui.press(']');
  expect(ui.backend.lastFrame).toContain('Beta');
  await ui.press('x');
  await ui.press('x');
  expect(ui.backend.lastFrame).toContain('Alpha');
  await ui.press('escape');
  expect(ui.backend.lastFrame).not.toContain('canvas · Alpha');
});

test('with the chat holding the keys, a keystroke is the chat\'s — the canvas field takes none', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'canvas_open', args: {} }, { tool: 'canvas_draw', args: { canvas: 'ci', title: 'Pipelines', tree: [
      ['Box', {}, ['input', { bind: 'branch', value: 'main' }]],
    ] } }],
    [{ text: 'Drawn.' }],
  );
  const ui = await boot(model);
  await turn(ui, 'draw it');
  await settleUntil(ui, () => ui.backend.lastFrame.includes('Pipelines'));
  // the chat still has the keys: Ctrl+] not pressed yet
  await ui.type('hello');
  expect(ui.backend.lastFrame).toContain('hello');        // the chat's field took it
  await toPlugin(ui);
  expect(ui.backend.lastFrame).toContain('Pipelines');    // the surface is up and holds the keys
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test src/__tests__/canvas-plugin.e2e.test.ts`
Expected: FAIL — the surface never appears (`canvas_open` has no screen yet).

- [ ] **Step 3: Implement `src/view.ts` and wire `screens`/`keycaps`/`keys`/`panel`**

Layout: header `Text` (dim) `canvas · «title» · owner · drawn 2m ago`, cut with `fit` to `surface.width`; tab strip when `canvases.size > 1`; `ScrollBox` with `height: surface.height - 3` wrapping `toElement`; footer hints come from `keycaps`. `useInputHandler({ mode: 'consume', priority: () => 50, mouse: true })` handles `tab`/`shift+tab` (focus cycle via `nextKey`), `return`/`space` on a focused button (`actionOf`), `[`/`]` (select), `x` twice (arm, then delete), `escape` (unfocus, else close). Press calls `host.services.postToChat(pressMessage(canvas, label))` and sets `store.pressed = 'queued'` for the footer, cleared by the next `drawCanvas`.

`index.ts`: `screens.show` (`entry: true`, `title: 'canvas'`, `params: { type: 'object', properties: { canvas: { type: 'string' } } }`, `tools: ['canvas_open', 'canvas_focus']`) whose `open` sets `store.personOpened = true` and selects when a canvas is named; `close` sets `personOpened = false`. `keys: { canvas: 'C' }` and a `components.panel` slot (always mounted) whose `useInputHandler` toggles `personOpened` on that key, so the surface can be opened while it is down.

- [ ] **Step 4: Run again**

Run: `bun test src/__tests__/canvas-plugin.e2e.test.ts`
Expected: PASS. If the tail assertion in the press test fails, print the last request and check the framing `postToChat` produced (`frameItem` in `src/assistant/conversation.ts`) — assert on the press text it carries.

- [ ] **Step 5: Run the whole suite for regressions**

Run: `bun test`
Expected: PASS. Any host test that breaks because the plugin is bundled (e.g. a home-screen or plugins-panel count) gets updated in the same commit, with a note in the commit message saying why.

- [ ] **Step 6: Commit**

```bash
git add plugins-available/canvas/src/view.ts plugins-available/canvas/src/index.ts src/__tests__/canvas-plugin.e2e.test.ts
git commit -m "feat(canvas): the surface — header, tabs, keys and the press"
```

---

### Task 9: Saved layouts — the template store and its tools

**Files:**
- Create: `plugins-available/canvas/src/templates.ts`
- Modify: `plugins-available/canvas/src/tools.ts` (add `canvas_save`, `canvas_templates`; `canvas_draw` takes `template`)
- Modify: `plugins-available/canvas/src/index.ts` (bind `cache` and `project`)
- Test: `plugins-available/canvas/src/__tests__/templates.test.ts`
- Test: `plugins-available/canvas/src/__tests__/tools.test.ts` (extend)

**Interfaces:**
- Consumes: `Node`, `checkTree` (Task 2); `TStore`, `drawCanvas`, `canvasOf`, `TValue` (Task 3); `buildGroup`, `TToolsDeps` (Task 4).
- Produces:
  ```ts
  export const TEMPLATES_NS = 'canvas/templates';
  export const GLOBAL_SCOPE = 'global';
  export const TEMPLATE_LIMIT = 50;
  export type TCache = { get(ns: string, key: string): unknown; set(ns: string, key: string, value: unknown, ttl?: number): void; enabled(): boolean };
  export type TTemplate = { name: string; title: string; tree: Node; savedAt: number };
  export type TScope = string;                       // 'global' or `project:<path>`
  export function slug(name: unknown): string | null;
  export function saveTemplate(cache: TCache, input: { scope: TScope; name: string; title: string; tree: Node; now: number }): { ok: true; key: string } | { ok: false; error: string };
  export function loadTemplate(cache: TCache, input: { scope: TScope; name: string }): { ok: true; template: TTemplate; key: string } | { ok: false; error: string };
  export function listTemplates(cache: TCache, scope: TScope): Array<{ name: string; title: string; savedAt: number; where: 'project' | 'global' }>;
  ```
  and `TToolsDeps` grows two **optional** fields — `cache?: TCache; project?: () => string | null;` — so the earlier tests keep compiling: without a cache the template tools answer `the cache is off (config.cache.enabled) — nothing can be saved`, and without a project every scope is `global`.

- [ ] **Step 1: Write the failing unit tests**

```ts
// templates.test.ts
import { expect, test } from 'bun:test';
import { listTemplates, loadTemplate, saveTemplate, TEMPLATE_LIMIT, TEMPLATES_NS } from '../templates.ts';

const fakeCache = (enabled = true) => {
  const map = new Map<string, unknown>();
  const ttls: number[] = [];
  return {
    map, ttls,
    get: (ns: string, key: string) => map.get(`${ns}/${key}`) ?? null,
    set: (ns: string, key: string, value: unknown, ttl?: number) => { map.set(`${ns}/${key}`, value); ttls.push(ttl ?? -1); },
    enabled: () => enabled,
  };
};
const tree = ['Box', {}, ['Text', {}, 'jobs']] as never;

test('a save keeps the tree and the title, never the values, and never expires', () => {
  const cache = fakeCache();
  const r = saveTemplate(cache, { scope: 'project:/w/prices', name: 'pipeline', title: 'Pipelines', tree, now: 1000 });
  expect(r).toEqual({ ok: true, key: 'project:/w/prices/pipeline' });
  const stored = cache.map.get(`${TEMPLATES_NS}/project:/w/prices/pipeline`) as Record<string, unknown>;
  expect(stored).toEqual({ name: 'pipeline', title: 'Pipelines', tree, savedAt: 1000 });
  expect(cache.ttls.every((t) => t === 0)).toBe(true);
});

test('a project recipe shadows a global one of the same name', () => {
  const cache = fakeCache();
  saveTemplate(cache, { scope: 'global', name: 'pipeline', title: 'Global', tree, now: 1 });
  saveTemplate(cache, { scope: 'project:/w/a', name: 'pipeline', title: 'Mine', tree, now: 2 });
  const found = loadTemplate(cache, { scope: 'project:/w/a', name: 'pipeline' });
  expect(found.ok && found.template.title).toBe('Mine');
  const other = loadTemplate(cache, { scope: 'project:/w/b', name: 'pipeline' });
  expect(other.ok && other.template.title).toBe('Global');
});

test('a missing recipe, a bad name, and the 51st are refused with words', () => {
  const cache = fakeCache();
  expect(loadTemplate(cache, { scope: 'global', name: 'nope' })).toEqual({ ok: false, error: 'no template «nope» — draw a tree instead' });
  expect(saveTemplate(cache, { scope: 'global', name: 'Bad Name!', title: 'x', tree, now: 1 }).ok).toBe(false);
  for (let i = 0; i < TEMPLATE_LIMIT; i++) saveTemplate(cache, { scope: 'global', name: `t${i}`, title: 'x', tree, now: 1 });
  const over = saveTemplate(cache, { scope: 'global', name: 'one-too-many', title: 'x', tree, now: 1 });
  expect(over).toEqual({ ok: false, error: `no room: ${TEMPLATE_LIMIT} templates in this scope` });
});

test('a recipe the vocabulary no longer accepts is refused with its reason', () => {
  const cache = fakeCache();
  cache.map.set(`${TEMPLATES_NS}/global/old`, { name: 'old', title: 'Old', tree: ['Pipeline', {}], savedAt: 1 });
  const r = loadTemplate(cache, { scope: 'global', name: 'old' });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain('Pipeline');
});

test('listing merges the project and the global recipes and says where each came from', () => {
  const cache = fakeCache();
  saveTemplate(cache, { scope: 'global', name: 'servers', title: 'Servers', tree, now: 1 });
  saveTemplate(cache, { scope: 'project:/w/a', name: 'pipeline', title: 'Pipelines', tree, now: 2 });
  expect(listTemplates(cache, 'project:/w/a')).toEqual([
    { name: 'pipeline', title: 'Pipelines', savedAt: 2, where: 'project' },
    { name: 'servers', title: 'Servers', savedAt: 1, where: 'global' },
  ]);
});

test('with the cache off, every template call says so', () => {
  const cache = fakeCache(false);
  expect(saveTemplate(cache, { scope: 'global', name: 'a', title: 'x', tree, now: 1 })).toEqual({ ok: false, error: 'the cache is off (config.cache.enabled) — nothing can be saved' });
  expect(loadTemplate(cache, { scope: 'global', name: 'a' }).ok).toBe(false);
  expect(listTemplates(cache, 'global')).toEqual([]);
});
```

```ts
// tools.test.ts — extend
test('canvas_save keeps the drawn layout; canvas_draw from that template draws it again', async () => {
  const { group, store } = deps({ project: () => '/w/a' });
  await group.exec('canvas_draw', { canvas: 'ci', title: 'Pipelines', tree: ['Box', {}, ['Text', {}, 'one']] }, {});
  expect(await group.exec('canvas_save', { canvas: 'ci', template: 'pipeline' }, {})).toContain('project:/w/a/pipeline');
  await group.exec('canvas_delete', { canvas: 'ci' }, {});
  const out = await group.exec('canvas_draw', { canvas: 'ci2', template: 'pipeline' }, {});
  expect(out).toContain('«ci2»');
  expect(JSON.stringify(store.canvases.get('ci2')!.tree)).toContain('one');
  expect(store.canvases.get('ci2')!.title).toBe('Pipelines');
});

test('a missing template is refused; the canvas is not created', async () => {
  const { group, store } = deps();
  const out = await group.exec('canvas_draw', { canvas: 'ci', template: 'nope' }, {});
  expect(out).toContain('no template');
  expect(store.canvases.size).toBe(0);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test plugins-available/canvas/src/__tests__/templates.test.ts plugins-available/canvas/src/__tests__/tools.test.ts`
Expected: FAIL — `../templates.ts` not found; the tool additions answer `Unknown tool`.

- [ ] **Step 3: Implement `src/templates.ts`, then extend `tools.ts` and `index.ts`**

Each scope's index lives at `index/<scope>` in the same namespace: `[{ name, title, savedAt }]`, rewritten on every save; saving a name that already exists overwrites it and does not count twice. `loadTemplate` reads `<scope>/<name>`, falls back to `global/<name>`, then `checkTree`s the stored tree and returns the refusal verbatim when it no longer draws. `listTemplates` reads both indexes, project first with project entries shadowing global ones by name. Tools: `canvas_save` answers `saved «project:/w/a/pipeline»` or the module's error; `canvas_templates` answers one line per recipe (`«pipeline» · Pipelines · 3d · project`); `canvas_draw` with `template` loads it and draws its tree, and when `tree` is given too the tree is drawn and the template only supplies the title. `index.ts` binds `cache: host.services.cache` and `project: () => ctx.workspaceProject?.() ?? null` — read per call, so a `cd` mid-session moves the scope.

- [ ] **Step 4: Run the unit tests, then the e2e suite**

Run: `bun test plugins-available/canvas/src/__tests__/templates.test.ts plugins-available/canvas/src/__tests__/tools.test.ts src/__tests__/canvas-plugin.e2e.test.ts`
Expected: PASS. Then add one e2e: a turn that draws, saves, deletes and redraws from the template, asserting the frame shows the recipe's text — cross-restart reuse is the cache's own behaviour, already covered by the host's tests.

- [ ] **Step 5: Commit**

```bash
git add plugins-available/canvas/src/templates.ts plugins-available/canvas/src/tools.ts plugins-available/canvas/src/index.ts plugins-available/canvas/src/__tests__ src/__tests__/canvas-plugin.e2e.test.ts
git commit -m "feat(canvas): save a layout as a recipe and draw it again"
```

---

### Task 10: The pipelines demo, the README, and what the model is told

**Files:**
- Create: `plugins-available/canvas/README.md`
- Modify: `plugins-available/canvas/src/tree.ts` (the `VOCABULARY` example)
- Test: `src/__tests__/canvas-plugin.e2e.test.ts` (extend)

**Interfaces:**
- Consumes: everything above. Produces: no new code surface.

- [ ] **Step 1: Write the failing demo test**

```ts
test('a pipeline is drawn from gitlab-shaped data and redrawn after a press', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'canvas_draw', args: { canvas: 'ci', title: 'Pipelines · prices-index', owner: 'main', tree: [
      ['Box', { flexDirection: 'column', gap: 1 },
        ['badge', { text: 'failed · 2m', tone: 'error' }],
        ['rows', { items: [{ label: 'commit', value: 'a3f19c2' }] }],
        ['progress', { label: 'jobs passed', value: 75, tone: 'warn' }],
        ['tasks', { items: [{ text: 'build', state: 'done' }, { text: 'test:unit', state: 'running' }] }],
        ['input', { bind: 'branch', value: 'feature-MP-123' }],
        ['button', { label: 'check again', action: 'check the pipeline for this branch again' }]],
    ] } }, { tool: 'canvas_open', args: { canvas: 'ci' } }],
    [{ text: 'Here it is.' }],
  );
  const ui = await boot(model);
  await ui.press('F');
  await ui.type('draw my pipeline');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Pipelines · prices-index'));
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('failed · 2m');
  expect(frame).toContain('75%');
  expect(frame).toContain('build');
  expect(frame).toContain('check again');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test src/__tests__/canvas-plugin.e2e.test.ts`
Expected: FAIL — the frame lacks one of the strings (a renderer or a wrap is wrong).

- [ ] **Step 3: Fix what the frame shows, then write the README**

The README is for a person who installs the plugin: what the canvas is, the tools that matter (including saving a layout as a recipe and drawing it again in a later session), the vocabulary pointer (`canvas_draw`'s group description), the caps, how a press reaches the agent, why canvases themselves are in-memory while recipes are not, and the pipeline example with a real `gitlab` call in front of it. Keep `VOCABULARY`'s example tree byte-identical to the one in the spec.

- [ ] **Step 4: Run the suite and the typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS both. `bun run typecheck` must pass with the plugin included; if `tsconfig.test.json` does not cover the plugin's tests, add its `__tests__` to that config in this commit.

- [ ] **Step 5: Commit**

```bash
git add plugins-available/canvas src/__tests__/canvas-plugin.e2e.test.ts tsconfig.test.json
git commit -m "feat(canvas): the pipeline demo, the README, and the vocabulary the model is told"
```
