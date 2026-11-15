# Canvas plugin — a model-built interface surface for flow-assist

Date: 2026-11-15
Status: reviewed (builder check complete) — awaiting approval

## Intent and why

The model walks a person through work mostly in prose: "the pipeline failed at stage
build", "4 of 7 jobs are green". A person watching a long run wants to *see* that,
not read it. flow-assist already knows how to look at state — the tracker plugin's
board is a live flowtty surface with the chat docked beside it — but today only a
plugin author can build such a surface. Nothing lets the model put something on
screen.

This project adds a **canvas**: a plugin that gives the model tools to compose a
human-facing interface out of flowtty components, and renders it as a live surface
in the plugin's side of the screen. The model does not write code and does not
mount components itself — it hands the plugin a declarative tree, the plugin paints
it with the host's own primitives, and redraws whenever the tree changes.

The canvas is also **interactive**: the tree may carry text fields, checkboxes,
selects and buttons. The person types and clicks; a press becomes a *message to the
agent* ("the person pressed «Retry failed jobs» on canvas «ci» — branch=feature-x"),
which the model answers with its own tools, y/n still guarding every write. Nothing
on the canvas executes anything by itself.

First concrete use: **draw GitLab pipelines** — fetch through the bundled `gitlab`
plugin, then draw stages and jobs as a glanceable picture instead of quoting JSON,
with a branch field and a button to check them again.

A layout worth drawing twice can be **saved as a recipe**: the tree alone, no data,
kept in the host's cache under a name — per project, or globally — so the model draws
the same panel in a future session and only refills the data.

Dozens of these can coexist: many agents (a session, its subagents, background
tasks) may each draw one or more canvases; the person flips between them.

## Goals

1. **A declarative canvas, model-composed.** A `canvas` tool group whose tools take
   a component tree in the same shape the remote-plugin protocol already uses
   (`[type, props, ...children]`), validated against a small whitelist, and rendered
   with `{ ui }` primitives. No new host APIs.
2. **Many canvases, many agents.** A registry keyed by canvas id: title, owner
   label, tree, age. Tabs in the surface; a note when something off-screen changes.
   A session sees the registry in its prompt; a subagent or background task asks for
   it with `canvas_list` (the host sends screen context to sessions only — see
   Constraints), so a canvas drawn by a child is visible to the session that started
   it, and a child can find one it did not draw.
3. **Human-facing and quiet.** The canvas is for the person to glance at. It never
   rearranges the screen on a background agent's whim, never takes the keyboard
   without being asked, and shows freshness (who drew it, how long ago) so stale
   data is obvious.
4. **Interactivity that routes through the agent.** Fields, checkboxes, selects and
   buttons; a press posts one framed message into the session (`postToChat`) and the
   model takes it from there. The canvas has no power of its own — it cannot run a
   tool, and no write escapes its y/n.
5. **Nothing can break the host.** Bad trees are rejected with a message the model
   can act on; sizes are capped; rendering is pure data → components.
6. **GitLab pipelines work end to end** with no pipeline-specific code in the
   canvas plugin.
7. **A layout can be saved and reused.** `canvas_save` keeps a tree as a named
   recipe in the host's cache (per project, with a global fallback);
   `canvas_draw({ template })` draws it again in a later session, and only the data
   is new.

## Non-goals (this version)

- The canvas performing actions itself (retrying a job, posting a comment). A press
  is a message; the model and its tools do the work.
- Domain widgets: no `pipeline`, `issue-card` or `board` component types. Only
  generic ones (see the vocabulary).
- Editing the canvas by the person (moving parts, adding nodes), export/save to a
  file, multiple windows.
- **Canvases do not survive a restart** — a canvas is live state, and its age and
  data would lie. Only *recipes* persist (see Templates); a canvas lives in the app's
  memory for the run (the plugin cannot learn the project at `setup` — see
  Constraints).
- Chat-side rendering: `liveView`/`viewRenderers` blocks keep drawing text lines;
  the canvas is not a chat block.
- Remote (other-language) plugins using the canvas, and any host `PluginUi` change
  (e.g. exposing flowtty's `ProgressBar` or `ScrollList`).
- Canvas-side data fetching. The model fetches with existing tools and redraws.
- Coexisting with another plugin's active surface (see Constraints): the person
  closes the other one first.

## Anti-goals

- **Never a substitute for doing the work.** The canvas shows what tools actually
  returned; the model must not draw progress it did not observe.
- **Never a way around the y/n.** A press cannot pre-approve or smuggle a write; it
  is a sentence in the chat, no more.
- **Never a fake "person said".** A posted press is framed as the plugin's message
  carrying the press, never as the person's own words (`postToChat`'s framing).
- **Never steals the person's screen.** A background agent drawing a canvas must
  not widen/narrow the layout or move focus in the session the person is in.
- **Never a leak path.** Canvas content is model-written text; the plugin cannot
  mask secrets (no host service for it — see Constraints), so the vocabulary is
  text-only and the tool description forbids credentials. The host's masking
  applies to chat views, not here.
- **Never a memory hazard.** A tool arg or a redraw must not be able to hang or
  bloat the process; caps are enforced before anything is stored.

## Constraints (verified in this repo, host API 2)

- A plugin's shape has `tools`, `aiTools`, `components` slots (`view` = full
  surface), `keycaps(api) → string[]` (non-empty ⇒ the surface is mounted),
  `keys`, `commands`, `screens`, `chatContext(api)`, `setup(api)`, `views`.
  `host.notify()` redraws; `host.store` is the cross-plugin channel.
- `ui` exposes React (`h`, `useState`, `useEffect`, `useRef`, `Fragment`) and only
  these flowtty components: `Box, Text, Markdown, Table, Link, ScrollBox, Select,
  ListSelect, ListMultiSelect, Checkbox, TextInput`, plus `useInput`, `isPrintable`,
  `stringWidth`. **No `ProgressBar`, `TaskList`, `ScrollList`, `Span`, `HRule`** —
  composites must be drawn from `Box`/`Text`/`Table` by the plugin itself.
- `host.open(screen)` is refused from background work (`Not opened: screens are not
  opened from background work.`) and from a session the person left. Drawing is not
  opening: a tool may update canvas data from anywhere. This is the whole reason the
  registry is data-first and the surface is state-driven.
- **A `write` tool cannot be drawn from background work and cannot be live.** The
  y/n is asked on *every* call (`askPerson`, not first-time-only), and a child that
  was not started with `write: true` runs under `always-no`, which declines *before*
  `exec`. So `canvas_draw` must be a **read** (display-only, like `reportView`):
  otherwise every redraw blocks on the person and no subagent could ever draw.
- **Screen context reaches sessions only.** `chatContext` items ride the request tail
  built when `shape.screen` is true, and `task`/`subagent`/`oneshot` turns have
  `screen: false` (children also get `screen: () => []`). A child therefore knows the
  registry only by calling `canvas_list`.
- **Typing and picking are native; clicking is not yet proven.** `PluginUi` carries
  `TextInput`, `Select`, `ListSelect`, `ListMultiSelect`, `Checkbox`; they hear
  flowtty's own input (not `host.useInputHandler`) and take `isFocused` /
  `isActive`, which the plugin gates on `hasKeyboard()` and its own focus state.
  flowtty's `Text`/`Box` accept `onClick` and `Table` accepts `onRowClick`, and
  flowtty's backend already routes button presses for the chat's own click-to-open —
  but **no bundled plugin uses a click today** (the tracker uses none, and
  `useInputHandler({ mouse: true })` is the other hosted route). So clicking needs an
  early spike; the keyboard path (Tab to a control, Enter/Space to press) is the
  guaranteed one, and the design must not depend on clicks alone.
- **`postToChat` is the model channel.** `services.postToChat(text)` (bound by the
  chat) delivers an item into the open conversation: it waits in the inbox, lands at
  a turn's end as a row framed as a *plugin's* message — never the person's words —
  and starts a follow-up turn unless `quiet`. `chatNote` looks similar but is
  display-only and never reaches the model. A press must use `postToChat`; nothing
  else wakes an agent.
- **Surfaces stack, not replace.** The host renders every plugin whose `keycaps` is
  non-empty, all in the same content box, and a plugin cannot read another plugin's
  `keycaps`. Two active surfaces are two full-height panes in one column. The canvas
  cannot detect or avoid this; "side up" in its answers means "this plugin's side is
  mounted", not "the person is looking at nothing else".
- **Nothing identifies the calling agent to a plugin.** `ToolCtx` has no
  conversation/agent id, `PluginHost` has none either. Ownership is therefore a
  label the model declares (`owner`), not a verified identity. Design accordingly:
  labels are advice, never a security boundary, and the person's own tab choice
  wins over any label.
- **No project identity at `setup`.** `host.services` has no project/cwd; only a
  tool's `ctx.workspaceProject?.()` has one. Hence canvases are in-memory for the
  run (persistence is a non-goal, not an oversight), while recipes are keyed at tool
  time, where the project is known.
- **The cache is the only durable store a plugin has.** `services.cache.get/set/clear`
  is a namespaced KV over `cache.json` in the host's state dir: `set(ns, key, value,
  ttl)` with `ttl: 0` never expires, `config.cache.enabled: false` turns it off, and
  `:cache` / `cache clear` wipes it. It has **no key listing** — a name index is the
  plugin's own job. Under `bun test` it stays in memory, so a cross-restart test is a
  unit test against the same cache object, not two boots.
- `chatContext` is read into the prompt each round; it must stay cheap (a few short
  items, no full trees).
- Tool results are capped by the host (40 000 chars by default), and every string
  in a *view record* is redacted by the host — canvas data is not a view record,
  so it bypasses that.

## Approaches

1. **Fixed widget vocabulary** (plugin owns layout): tools like
   `canvas_set({ widgets: [{ type: 'pipeline', data }] })`. Always looks decent,
   trivially reliable — but every new thing to show needs a new widget, so the
   toolkit drifts into a domain UI kit that has to know about GitLab, boards,
   deploys. Rejected.
2. **Generic component tree, model composes** — chosen. One vocabulary, validated
   and capped; the model decides layout. Flexible for any content, but the model is
   also the designer, so drift is a real risk. Mitigated with a pinch of approach 1:
   a handful of *generic* data-shaped composites (`progress`, `rows`, `tasks`) so
   the model rarely hand-shapes a bar or a column of labels, and a hard whitelist so
   it cannot reach outside the vocabulary.
3. **Fix it in the host**: let `viewRenderers` accept component trees so any tool
   can paint rich blocks in chat. Broader reach, but it is a flow-assist core change,
   chat blocks still cannot hold a live surface, and the ask is a plugin. Rejected
   for this version; the tree schema below is deliberately the remote protocol's, so
   a later host-side renderer would accept the same shape.

Placement: the plugin is **bundled** in this repo (`plugins-available/canvas/`),
next to `gitlab`, `mcp` and `repo` — it is domain-agnostic infrastructure, it must be
present wherever pipelines need drawing, and this checkout is where it can be built
and tested. The WB plugins stay in their own repo; nothing here is WB-specific.

## The how

### Tree schema

Reuses `packages/remote/src/protocol.ts`'s `Node` shape, so the vocabulary is
already familiar to the host:

```ts
type Node = [type: string, props?: Props, ...children: Array<Node | string>];
```

Whitelisted types:

| type | props (all optional unless said) | notes |
|---|---|---|
| `Box` | `flexDirection`, `gap`, `padding`, `paddingX`, `paddingY`, `width`, `height`, `flexGrow`, `border`, `overflow`, `alignItems`, `justifyContent` | layout only |
| `Text` | `color` (palette token), `bold`, `dim`, `wrap`, `truncate` | children: strings |
| `Table` | `columns` (`{ key, label, width? }`), `rows` (arrays of strings), `border`, `selectedIndex` | rows ≤ 100 |
| `ScrollBox` | `height`, `flexGrow` | wraps the body when a canvas is tall |
| `Link` | `url` | one line |
| `Markdown` | — | children: one string, ≤ 4 000 chars |

Composites, implemented by the plugin on top of the primitives (this is the "pinch"):

| type | props | draws |
|---|---|---|
| `progress` | `label`, `value` (0–100), `tone` (`ok\|warn\|error\|accent`) | label + a `████░░░░` bar + percentage, widths from `useSurfaceSize` |
| `badge` | `text`, `tone` | a one-line status pill: `● passed`, `✗ failed` |
| `rows` | `items: Array<{ label, value, tone? }>` | the label/value pairs the login panel uses |
| `tasks` | `items: Array<{ text, state: 'done'|'running'|'queued'|'failed' }>` | `✓ ● ○ ✗` list |
| `rule` | `label?` | a horizontal rule |

Interactive types — each carries a `bind` (a name unique within the canvas) which is
how its current value is read back:

| type | props | behaviour |
|---|---|---|
| `input` | `bind`, `label?`, `placeholder?`, `value?`, `width?` | one-line `TextInput`; typed text lives in the canvas's values |
| `check` | `bind`, `label`, `value?` | `Checkbox` |
| `select` | `bind`, `label?`, `options: Array<{ value, label }>`, `value?` | `Select` (dropdown over the host's `DialogHost`) |
| `button` | `label`, `action`, `tone?` | pressable; `action` is a sentence handed to the agent verbatim ("check the pipeline for this branch again") |

A button may also appear inside `tasks`/`rows` rows later; not now.

Colours are palette tokens only (`ok`, `warn`, `error`, `accent`, `dim`, `muted`),
resolved through the host theme — never literal colours, never escapes. Unknown
type, unknown prop, wrong child kind ⇒ the tool returns an error naming what it did
not understand and listing the allowed vocabulary; the canvas is left unchanged.
Unknown props on an interactive node are rejected the same way — no passthrough.

Caps, enforced before anything is stored: ≤ 400 nodes, depth ≤ 8, ≤ 100 children
per box, ≤ 2 000 chars per `Text`/`badge`/`rows` cell, ≤ 40 interactive nodes,
≤ 200 chars per value, ≤ 64 KB serialized canvas.

### Tools (group `canvas`)

Every tool here is a **read**: they change only what the person sees, never the world,
and a y/n on each redraw would both stall live updates and block every background
agent (`always-no` before `exec`). The host's own display channel does the same —
`reportView` is display-only and never confirmed.

- `canvas_draw({ canvas, title?, owner?, tree?, template? })` — create or replace.
  `tree` draws the given tree; `template` draws a saved recipe by name; both together
  mean "draw this tree, with the recipe's title" — and neither is an error. Returns
  `drew canvas «ci» (12 rows, 3 stages) — side up` / `— side down, the canvas is
  stored` (the person may be in the chat or another session). Whole-tree replacement
  on every update: the model re-sends the tree, which is small and idempotent; no
  patch language.
- `canvas_list()` — id, title, owner, age, node count, whether the plugin's side is
  mounted. This is how a subagent finds canvases (screen context is sessions-only).
- `canvas_delete({ canvas })` — remove one; if none are left the surface unmounts.
- `canvas_save({ canvas, template, scope? })` — keep this canvas's tree as a recipe
  (see Templates). `scope: 'project'` (default, needs `ctx.workspaceProject`) or
  `'global'`.
- `canvas_templates({ scope? })` — the recipes this project has and the global ones,
  with their titles and ages.
- `canvas_focus({ canvas })` — select a tab. Subject to the host's screen rules; from
  background work it answers `Not opened: …` and the canvas is still drawn.
- `canvas_open({ canvas })` — ask the host to show the plugin's side (its own
  one-action screen), same rules.

The group carries a `description` (the host shows it with the group's tools) that is
the vocabulary reference: every type, its props, its limits, and one pipeline example
tree. Tool descriptions stay short and point at the group text; `canvas_list` is named
as the way to discover canvases you did not draw, `canvas_templates` as the way to
reuse a layout.

### Templates — a layout to draw again

A recipe is **the tree and its title, nothing else**: no values, no owner, no
timestamp of any data, so nothing about it can go stale in a way that misleads. It is
kept in the plugin's cache namespace (`canvas/templates`) with `ttl: 0`, so it
survives restarts until the person clears the cache; `config.cache.enabled: false`
turns the feature off and every template tool says so.

- **Keying**: `<scope>/<name>` — `project:<path>` when the tool call had
  `ctx.workspaceProject()`, else `global`. Lookup tries the project first, then
  `global`, so a project recipe shadows a generic one of the same name.
- **Index**: the cache cannot list keys, so each scope keeps one index entry
  (`index/<scope>`) with `[{ name, title, savedAt }]`; a save rewrites it. At most 50
  recipes per scope — the 51st is refused with that sentence, not silently dropped.
- **Re-validated on load.** A recipe saved before the vocabulary changed can carry a
  prop or type the plugin no longer draws; loading runs `checkTree` again and answers
  `template «pipeline» no longer draws: Text has no prop «colour» — draw a tree
  instead`. Never a throw, never a half-drawn canvas.
- **Names** are slugs (`[a-z0-9][a-z0-9._-]{0,39}`); anything else is refused with the
  rule, because the name is half of a cache key.

### Registry and surface

- State in `host.store.canvas`: `{ canvases: Record<id, Canvas>, selectedId,
  personOpened }`, seeded in `setup`, in memory for the run (no project id is
  available at `setup`; see Constraints). `updatedAt` is drawn so a stale canvas is
  self-evident.
- `Canvas = { id, title, owner, tree, updatedAt, revision, rendered: { nodes, rows } }`
  — `rendered` counts come from validation, not from a render pass.
- **Mounting**: `keycaps` returns hints only while `personOpened` is true and at
  least one canvas exists. A background agent's `canvas_draw` does **not** set
  `personOpened`; it posts `services.showMessage('canvas «ci» updated by reviewer')`
  and leaves the layout alone (anti-goal). `canvas_open`, the plugin key, or a draw
  from the visible session (best-effort: the model is told to call `canvas_open`
  when the person asked for a canvas) sets it.
- Keys inside the surface: `[` / `]` switch tabs, `x` delete the selected canvas
  (with the host's y/n through a modal? no — a plain confirm-free delete is too
  sharp; `x` twice, like the tracker's confirm modals), `Tab` / `Shift+Tab` cycle the
  interactive nodes (see Interaction), `Esc` leaves a control and then closes the
  surface (`personOpened = false`). All registered through `host.useInputHandler`
  with priorities so the chat's field keeps its keys.
- Surface layout: header line `canvas · «title» · owner · drawn 2m ago` (dim),
  a tab strip when more than one canvas, `ScrollBox` body with the tree, footer
  keycaps from `keycaps`. Sizes from `useSurfaceSize()`; the canvas never assumes
  the terminal.

### Interaction

- **Values.** Each canvas keeps `values: Record<bind, string | boolean>`, seeded from
  the tree's `value` props. The person's edits live here, per canvas, and survive a
  redraw: `canvas_draw` replaces the tree but keeps a bind's value unless the model's
  declared `value` changed (so the model can prefill or reset deliberately). A bind
  that disappears from the tree drops its value.
- **A press is one message.** Pressing a button collects every bind on that canvas and
  posts through `services.postToChat`:

  ```
  [canvas] «ci» pressed «check again» — branch: feature-x · watch: on
  ```

  The model receives it as a plugin's message at the turn's end (inbox), never as the
  person's words, and answers with its own tools; every write still pauses on y/n.
  While a turn runs the item waits in the inbox (`postToChat` never enters a running
  turn) and the surface says `queued` so a press is never silently swallowed.
- **Focus.** `Tab` / `Shift+Tab` cycle the interactive nodes in tree order, the
  focused control takes printable keys (`isFocused` gated on `hasKeyboard()`),
  `Esc` leaves a control before it closes the surface, `Enter`/`Space` press a
  focused button. While a control has focus, the surface's own keys (`[`, `]`, `x`)
  do not fire.
- **Clicks.** The node's `Text`/`Box` gets `onClick`; whether clicks reach a plugin
  surface is the one thing the spike must settle (see Constraints). If they do not,
  the canvas ships keyboard-only and the footer says so — the design does not depend
  on the pointer.
- **What the model sees.** The posted message carries the values at press time; the
  session's `chatContext` also lists the selected canvas's current values, so a turn
  started for another reason still sees what the person typed.

### Context back to the model

The host sends screen context to sessions only, never to children. In a session,
`chatContext` returns at most 10 short items, one per canvas —
`«ci» · reviewer · 2m old · 18 nodes · side up` — plus, for the selected canvas only,
an outline (types and the first text of each row, depth-first, ≤ 30 lines) and its
current values (`branch=feature-x · watch=on`) so a session that did not draw it can
still talk about it and act on what was typed. No full trees. A subagent or
background task gets the same information by calling `canvas_list`; the group's
description says so.

### The pipelines demo (proves it, ships nothing domain-specific)

`gitlab`'s tools already return a branch's MR, its latest pipeline status and failed
jobs, plus a `glab` REST passthrough for `projects/:id/pipelines/:id/jobs`. The model
fetches, then draws:

```
[Box, {flexDirection: 'column', gap: 1},
  [badge, {text: 'failed · 2m', tone: 'error'}],
  [rows, {items: [{label: 'project', value: 'portals/frontend-services/prices-index'},
                  {label: 'commit', value: 'a3f19c2'}]}],
  [progress, {label: 'jobs passed', value: 75, tone: 'warn'}],
  [tasks, {items: [{text: 'build', state: 'done'}, {text: 'lint', state: 'done'},
                   {text: 'test:unit', state: 'running'}, {text: 'deploy:stage', state: 'queued'}]}],
  [Box, {flexDirection: 'row', gap: 2},
    [input, {bind: 'branch', label: 'branch', value: 'feature-MP-123'}],
    [check, {bind: 'watch', label: 'watch it', value: true}],
    [button, {label: 'check again', action: 'check the pipeline for this branch again'}]],
  [Link, {url: 'https://gitlab…/pipelines/1234'}]]
```

The person edits the branch, presses `check again` (or Tab-Enter), and the agent gets
`«ci» pressed «check again» — branch: feature-MP-123 · watch: on`, re-runs the
`gitlab` fetch and redraws. Nothing in the plugin knows what a pipeline is.

## What is left to the builder

- Exact prop names and their sanitisation table; how unknown props are reported (one
  message per canvas draw, not a wall of lines).
- **The click spike, first thing built**: does `onClick` on a `Text`/`Box` inside a
  plugin surface fire, and under what focus conditions? If not, try
  `useInputHandler({ mouse: true })` and hit-testing the drawn rects; if neither
  works cleanly, ship keyboard-only and say it in the footer.
- Focus order and value retention rules in practice: what `Tab` does inside a
  `ScrollBox`, whether `Esc` in a field can also close the surface, how a redraw
  mid-typing keeps the caret.
- The `ScrollBox`/focus plumbing against the host's key path — which of
  `[`/`]`/`x`/`Esc`/`Tab` collide with an open chat field or the host's own keys.
- Exact composite glyphs, bar widths and truncation rules; the tab strip's look with
  many canvases (overflow → `‹3 of 11›`).
- Whether `x`-twice deletion is a modal or a footer hint.
- `canvas_open`'s screen declaration and whether it shares the entry screen with
  `canvas_focus`.
- Template details: the index's exact shape and how a save rewrites it, the 50-cap's
  wording, and whether `canvas_save` also stores the canvas's `title`.
- Test plan: validation, caps and the press message's wording as pure unit tests
  (`bun test`, the repo's conventions); a rendering smoke test with flowtty's Test
  backend if the plugins' existing tests have one; the tool/screen/inbox rules
  covered by the host's e2e style.
- Deployment to the corporate machine's `~/flow-assist` install (copy or sync of
  `plugins-available/canvas/`), outside this repo's build.

## Calls made during the review (check these while reading)

1. **`canvas_draw` is a read, not a write.** The y/n is asked on every call, and a
   child started without `write: true` gets `always-no`, which declines before
   `exec` — a write tool would mean a y/n per redraw and no background drawing at
   all. Display-only, like `reportView`.
2. **A session sees the registry in its prompt; a child asks `canvas_list`.** Screen
   context reaches sessions only (`shape.screen`), and children get `screen: () => []`.
   Making children see it is a host change we chose not to take.
3. **Surfaces stack, they do not replace.** The host renders every plugin with a
   non-empty `keycaps` in the same content box, and no plugin can read another's. So
   the person closes the tracker's board first, and "side up" in answers means no more
   than it says.
4. **Canvases are not persisted; recipes are.** `setup` has no project id
   (`host.services` carries none); only a tool's `ctx.workspaceProject?.()` has. So a
   live canvas lives in memory for the run, while a *recipe* — tree and title only —
   goes to the plugin's cache namespace at tool time, where the project is known.
5. **A press talks to the agent, it does not act.** `postToChat` is the only channel
   that wakes a model turn, and it delivers a *plugin* message — so a click cannot
   retry a job itself, cannot pre-approve a write, and cannot pose as the person. That
   is the price of staying a plugin; direct actions would need model-side round-trip
   or a host channel.
6. **Keyboard first, mouse if the spike proves it.** No bundled plugin uses clicks
   today, so the click path is unproven; the design's press semantics work either way.
7. **Recipes are layout-only and re-validated on load.** A saved tree carries no data,
   no owner and no timestamp; it is keyed per project with a global fallback, and a
   recipe saved under an older vocabulary may be refused — with the reason — never
   half-drawn.

## Future (explicitly not designed here)

Row-level actions inside tables and task lists (a retry per row) reuse the same press
channel with a target payload; per-canvas ownership that is *verified* needs a
conversation identity the host does not expose today; a host-side renderer for the
same tree shape would let any plugin's `viewRenderers` draw rich blocks without a
canvas; a canvas could offer a "run this without asking the model" path if the host
ever exposes tool invocation to plugins.
