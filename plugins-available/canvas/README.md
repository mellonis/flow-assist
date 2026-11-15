# canvas

A panel the assistant draws: state and pipelines as a picture on your side of the
screen, instead of prose in the chat.

    plugins install canvas

Restart the assistant afterwards: plugins are loaded at start.

The assistant hands the plugin a tree of components — a status pill, a progress bar, a
table, a field, a button — and the plugin paints it with the host's own primitives,
redrawing whole whenever the tree changes. Nothing in it knows what a pipeline, a board
or a ticket is: the model fetches with the tools it has and draws what it got. What is
on the canvas is what a tool returned.

Ask for one ("draw the pipeline for this branch"), or press `C` — `config.keys.canvas`.
The key does nothing until there is a canvas to show, and the footer names it only once
your side is up.

## What you see

The header says where you are and how old the picture is:
`canvas · «Pipelines · prices-index» · reviewer · drawn 2m ago`. A strip of tabs appears
while more than one canvas is drawn, `[ the selected one ]` in brackets. Below it is the
tree, in a box that scrolls while your side holds the keyboard (`Ctrl+]`, or a click on
it) — a tree taller than the pane is not squeezed to fit.

| key | |
|---|---|
| `C` | open or close your side (`config.keys.canvas`) |
| `[` `]` | the previous / next canvas |
| `Tab` `⇧Tab` | move the focus through the fields, checkboxes, selects and buttons |
| `⏎` `Space` | press the focused button |
| `x` `x` | delete the selected canvas — the second `x` confirms it |
| `Esc` | leave the focused control; again, close your side |

A canvas the assistant draws from the background — a task, a subagent — never takes your
screen: your side stays up and on the tab you chose, and while the side is down one toast
says `canvas «ci» updated`. Deleting the last canvas takes the side down.

## The tools

| tool | |
|---|---|
| `canvas_draw` | create or replace a canvas whole: `canvas` (its id, `ci`), `title`, `owner`, and the `tree` — or `template`, a saved recipe by name. A read: no y/n, and nothing outside the app changes |
| `canvas_list` | every canvas there is — id, title, owner, age, nodes, whether the side is up. How a subagent finds one it did not draw |
| `canvas_save` | keep a drawn layout as a recipe: `canvas`, `template` (its name), `scope` |
| `canvas_templates` | the recipes this project has and the global ones, with their titles and ages |
| `canvas_delete` | remove one |
| `canvas_focus` | select a canvas and ask the host to show your side on it |
| `canvas_open` | the same, under the name the assistant uses when you ask to see one |

Both open your screen only from a session: a task or a subagent can draw and list
canvases, but the host refuses to open a screen from background work.

The vocabulary — every type and its props, the caps, the palette tokens, a whole
example — is the `canvas` group's description, shown to the assistant when it loads the
group's tools. The types: `Box`, `Text`, `Markdown`, `Table`, `ScrollBox`, `Link`, the
composites `progress`, `badge`, `rows`, `tasks`, `rule`, and the live controls `input`,
`check`, `select`, `button`. A tree that names a type or a prop outside it, a literal
colour or a broken shape is refused with one message naming what was wrong — up to three
problems, then a count — and the canvas you are looking at is left as it was.

The caps, enforced before anything is drawn: 400 nodes, depth 8, 100 children per node,
2000 characters of text, 200 characters per value, 40 live controls, 64 KB of tree. A
bind (the name a field's value is read back by) is one per control, non-empty, unique in
the canvas, never starting with `btn:`.

The palette is named tones (`ok`, `warn`, `error`, `accent`, `dim`, `muted`, `default`)
resolved by the host theme. Any of them can be overridden with a named colour, but by
hand: the plugin declares no settings schema, so `config set` refuses
`plugins.canvas.colors` — put it in `config.local.json` instead (in the config directory,
`~/.config/flow-assist/` by default); a settings file edited outside the app is applied
once you answer the host's `changed outside flow-assist — apply? (y/n)`:

    {"plugins": {"canvas": {"colors": {"error": "red", "accent": "cyan"}}}}

## A press is a message

The canvas has no power of its own: a button cannot run a tool, and a press cannot
pre-approve a write. Pressing one collects every value on that canvas and posts **one
message to the assistant**, framed as the plugin's:

    [canvas] «ci» pressed «check again» — branch: feature-MP-123 · watch: on
    action: check the pipeline for this branch again

That last line is the button's own sentence, handed over verbatim. The assistant reads
the whole thing as a message from a plugin, never as your words, and answers with its
own tools — every write still stops at the y/n. While a turn is already running the
press waits in the inbox (it cannot cut into the answer) and the footer says
`press queued` until the redraw the answer brings. A redraw keeps what you typed into a
field, so the assistant sees your edits and you do not retype them.

`Tab` to a button and `⏎` is the path this version is tested for. A click on a button is
wired to the same press, but it is not promised yet.

## Recipes — the same layout in a later session

A layout worth drawing twice is a **recipe**: `canvas_save` keeps the canvas's tree and
title under a name, and `canvas_draw({ canvas, template })` draws it again. A recipe is
the tree as it was drawn — the layout *and* the words in it: a badge's `failed · 2m`, a
commit hash, a task's state, a field's declared value. Only what the person typed into a
field is not kept. So a recipe alone replays the data of the day it was saved: when the
data has moved, send a fresh `tree` beside `template` — the tree wins and the recipe
supplies the title. A `template` whose name no longer resolves refuses the draw before a
tree beside it is read, and the canvas stays as it was.

- `scope: 'project'` (the default) keeps it for the project the call was made in;
  `scope: 'global'` for every project. A project's recipe shadows a global one of the
  same name.
- A name is a slug — lower-case letters, digits and `.` `_` `-`, up to 40, starting with
  a letter or a digit. A scope keeps 50 recipes; the 51st is refused, not dropped.
- A saved recipe is checked against the vocabulary again when it is drawn: one saved
  before a component changed is refused with the reason — never half-drawn.

Canvases themselves are **not** kept: a canvas is live state, and its data and its age
are true only for the run it was drawn in. A recipe is the plugin's own stored copy of
that tree, so it goes in the host's cache and stays across restarts until the cache is
cleared — `:clear`, or `:clear-cache`. `config.cache.enabled: false` turns the recipe
tools off and they say so; drawing, listing and opening keep working, and `:cache on`
switches caching back on (`:cache` alone reports it — it flushes nothing).

## Pipelines

The bundled `gitlab` plugin is all the domain knowledge there is. The assistant asks it
for the branch's merge request and its latest pipeline — `gitlab_mr_status` gives the
status and the failed jobs — and for every job of that pipeline through its REST
passthrough, `glab_api` with `projects/:id/pipelines/:id/jobs`. Then it draws what came
back:

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

You change the branch, press `check again`, and the assistant gets
`«ci» pressed «check again» — branch: feature-x · watch: on`, fetches again and redraws
with the jobs as they are now. Nothing in this plugin knows what a pipeline is; any
other tool the assistant has is drawn the same way.

## What the assistant remembers of it

A session sees one line per canvas in what it is told about your screen — id, title,
owner, age, nodes, whether the side is up; past ten canvases one more line says how many
are not listed. For the selected canvas it also sees the outline — one line per node, up
to 30 and then `… N more` — with the current value of every bind the outline reaches, so
a session that did not draw it can still talk about it and act on what you typed. A task
or a subagent is told nothing about the screen: it calls `canvas_list`.

## Settings

| key | |
|---|---|
| `config.keys.canvas` | the key that opens your side, `C` by default |
| `config.plugins.canvas.colors` | the palette: `{"accent": "cyan", "error": "red"}`, laid over the plugin's tones — by hand in `config.local.json` (above) |

## Not yet

Clicks are unproven (above); canvases do not survive a restart (only recipes do); the
canvas fetches nothing itself — the assistant does, and redraws; no actions inside a
`Table` or `tasks` row; and another plugin's side shares the same box with the canvas's —
both draw into it, so close one when the canvas wants the room.
