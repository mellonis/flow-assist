# `/diff`: keyboard parity with a full diff viewer — design (issue #135)

Status: design, awaiting approval. The plan follows after this is approved.

## Intent and why

The `/diff` panel shows the working tree beside the conversation so the person can read
what changed while they type about it. Today its keyboard is three keys: `↑`/`↓` walk
files, `⏎` folds one, `Esc` closes. This ticket gives it the keyboard of a full diff
viewer — the capability set of opencode's `diff-viewer.tsx`, in flow-assist's own key
language: navigation by hunk and file, row and page scrolling, review marks, a source
switcher (branch+local / committed / working tree / last turn) with a base-branch
picker, single-file mode, fullscreen, and a help listing the keys that act here.
Nothing writes to git.

Reference behaviour: `opencode/packages/tui/src/feature-plugins/system/diff-viewer.tsx`
and `keybind.ts:45–90` (the clone beside this repo). What was taken from the reference
is the *capability list* and the source model (below), not its keys-by-letter layout and
not its scroll-primary cursor (see Approaches).

## Goals

- Every action of the reference viewer exists in the panel, bound through the plugin's
  `keys` table, drawn with `host.keyCap(action)`, overridable with `config.keys.<action>`.
- Hunk navigation across files; a visible cursor the navigation moves and `m`, `s` act on.
- Review marks (`m`): `✓` on the file row, the file folds, the mark survives the live
  refresh; `m` again reopens.
- Four sources behind `d`, with a base-branch picker for the three git ones; the header
  says what is being compared against.
- `s` shows one file with a `3 of 7` header; `f` grows the panel to the whole terminal
  and back; `?` lists the keys that act here; `q`/`Esc` close the panel.
- The footer hint row (`? see all`, `esc close`, the caps of the rest) is part of the
  deliverable.

## Non-goals

- **File tree** (`b`) — the flat list with folds covers the panel's roots; a tree is its
  own feature.
- **Split view** (`v`) — second phase together with the tree; it needs a second hunk
  layout in `modals.ts` (a second column with its own gutter) and only pays off from
  ~100 columns.
- Staging, discarding, undo — opencode has none, and flow-assist's write rules would
  want a y/n for each.
- Word-level intra-line highlighting — the reference has none either.
- A `gg` chord for "first" — flow-assist has no chord language in panels; `home` is the
  key, the action stays remappable.

## Anti-goals

- The **docked** panel must never eat a key while the field is non-empty, while a y/n or
  a question waits, or while the `:` line is open (the rules the existing `↑`/`↓`
  follow). The fullscreen shape is a different beast — see *Settled with the person*.
- A stray `q` must close the panel and never the app: the exit keys keep their two-press
  guard.
- The live refresh must never pull the view back to the cursor or resurrect a fold the
  person undid (the rules `DiffBody` and `walkDiff` hold today).
- The row display must keep its copy semantics: a drag copies code, chrome (gutters,
  headers, hints) stays out of a selection.

## Constraints (house rules this design rests on)

- **Actions are bindings, never written glyphs**: declared in the plugin's `keys`
  table (flat camelCase names, as `chatFocus`, `toEnd`), drawn with
  `host.keyCap(action)`, remapped through `config.keys`. No `HOST_API` change.
- The chat handles its keys **before** the panel can: `Esc` with a turn running stops the
  turn and leaves the panel where it is; `⏎ continue` (a limit offer) outranks a fold.
- The exit keys (Ctrl+C, Ctrl+D, Ctrl+Z) keep their two-press guard; a chord a drawn
  panel binds (`ctrl+d`, `ctrl+u`) is the panel's key while it is drawn
  (`src/runtime/exit-keys.ts` already orders this).
- Rendering stays pure in `src/views/modals.ts`; `working-tree.ts` stays the one
  read-only git exception; no tool writes to the journal.
- Tests wait with the shared `settleUntil` and their give-ups name the condition and the
  budget (`no-silent-waits` holds them to it).

## Approaches

### 1. Cursor model: walker (picked) vs scroll-primary

- **A — walker (picked).** The cursor is a visible mark on a *row of interest* (a file
  row or a hunk's first row). `↑`/`↓` move it item by item and the list scrolls it into
  view — exactly the machine the panel has today (`cursorRow` + `DiffBody.carry`), one
  granularity finer. Free scrolling (`j`/`k`, `PgUp`/`PgDn`, `ctrl+d`/`ctrl+u`, wheel)
  moves the view without moving the cursor.
- **B — scroll-primary (the reference's own).** No persistent mark: "the current file"
  is the file at the viewport top, jumps set a selection that a plain scroll clears
  (`clearPatchSelection`). `m` acts on the selection, else the top file.

A is picked because the panel already is a walker and its docked pane is small (the
whole point is reading *beside* the conversation). In B `m` depends on where the
viewport happens to stop — in twenty rows that is a guessing game — and replacing a lit
row with a computed one would regress the panel's one clear affordance. The cost of A:
`↓` walks items where opencode's `↓` scrolls a row; that is the "own key language"
part, and opencode's row scroll keeps `j`/`k`.

### 2. Key policy: the empty-field gate (picked) vs a focus state vs holding every key

- **A — the empty-field gate (picked; the ticket's rule).** A key bound to an action
  acts while the panel is drawn and the field is empty; an unbound key types into the
  field as ever; once the field is non-empty the panel is silent. **The stated cost:** a
  message cannot *start* with `m`, `s`, `f`, `d`, `q`, `?`, `j`, `k`, … while the panel
  is open — `Esc` or `q` closes it first (one keystroke). A paste is one key and never
  fires bindings.
- **B — the panel holds every key while drawn** (the picker/work-panel rule). Kills
  "type about what you see", which is why the panel docks beside the chat at all.
- **C — a focus state** (click the panel or a focus key to give it the letters). A mode
  the ticket never asks for, with its own surprises ("why did `m` type?").

### 3. Sources: extend the git walk + a turn provider (picked) vs a source interface

- **A — picked.** `workingTreeDiff` grows a base and a mode (`branch + local`,
  `committed only`, `working tree only`) — still only `git status`/`git diff`, read-only,
  and a read-only `listBaseRefs` beside it. `last turn` is a provider beside
  `src/assistant/diff.ts` that reads the change parts the conversation already keeps
  (`kind: 'change'`, the same record the `✎` blocks are drawn from) and answers the same
  `DiffSection[]` shape.
- **B — a `DiffSource` interface with four implementations in a new module.** A name
  without behaviour: two providers answering one shape is the interface.

## The how

### Actions and default bindings

Declared in the `assistant` plugin's `keys` table alongside `chat`, `work`, `details`:

| action | default | what it does |
|---|---|---|
| `diffNextHunk` / `diffPrevHunk` | `]` / `[` | cursor to the next/previous hunk start, across files |
| `diffNextFile` / `diffPrevFile` | `↓` / `↑` | cursor to the next/previous file row |
| `diffScrollDown` / `diffScrollUp` | `j` / `k` | scroll one row; the cursor does not move |
| `diffPageDown` / `diffPageUp` | `pagedown` / `pageup`, `ctrl+f` / `ctrl+b` | page (also the wheel, as today) |
| `diffHalfPageDown` / `diffHalfPageUp` | `ctrl+d` / `ctrl+u` | half a page |
| `diffFirst` / `diffLast` | `home` / `end` | cursor to the first/last item, view to the top/bottom |
| `diffMarkReviewed` | `m` | `✓` on the cursor's file, fold it, cursor to the next file |
| `diffSinglePatch` | `s` | all files ⇄ just the cursor's file, `3 of 7` header |
| `diffSource` | `d` | source dialog + base-branch picker |
| `diffFullscreen` | `f` | docked ⇄ the whole terminal |
| `diffHelp` | `?` | help: the keys that act here |
| `diffClose` | `q`, `escape` | close the panel |

Unbound in this ticket (out of scope): `v` (`diffToggleView`), `b` (`diffToggleFileTree`).
`Esc` keeps its order: a running turn is stopped first, the panel closes only from an
idle chat. `⏎` keeps folding (and `⏎ continue` keeps outranking it).

### The rows and the cursor

`diffPanelBody`'s one walk grows two things and stays the single source of truth
("a row and a key cannot disagree"):

- **Hunk rows are grouped** — the `@@` headers of `FileDiff.hunks` are the boundaries;
  a hunk's rows carry no `@@` line (as today), so navigation needs the grouping made
  explicit (`diffRowGroups` beside `diffRows` in `src/assistant/diff.ts`).
- **Items** — the rows a cursor rests on: every file row and every hunk's first row.
  The pure helpers live beside `diffPanelFileKeys`: `diffPanelItems(sections)` and the
  moves (`nextItem`/`prevItem`/`nextHunk`/`prevHunk`/`firstItem`/`lastItem`), each
  answering a cursor the chat stores.

The cursor is keyed `diffFileKey(root, path)` **plus a hunk index** (a bare file key is
file granularity — the header). After a live refresh the cursor is re-found by that
pair; a hunk that vanished leaves it on the file row (the rule "a refresh that took it
away leaves it" holds). The cursor row is drawn **lit and inverted** — the mark the file
row carries today moves to whatever row the cursor rests on; the file row keeps its fold
glyph and counts. `s` (single patch) keeps the cursor's file and counts its place
(`3 of 7`) over `diffPanelFileKeys` order.

```
│ diff · 2 files +9 −3 · vs main          ← the header: what is compared against
│ ▾ M src/views/modals.ts  +6 −2
│    12   export function renderDiffPanel(p: {
│    13 −   cursor: string | null;
│ ▍  13 +   cursor: Cursor;                  ← the cursor row (the row of interest)
│    14     wrap: number;
│ ▸ ✓ A notes.md  +3 −0                     ← reviewed: folded, marked
│ changes that are not files
│ · ABC-1 · description  +1 −1              ← not a file — its hunks, as the chat draws them
│ ? see all · esc close                     ← the hint row
```

### Review marks

`m` marks the cursor's file: a `✓` beside its fold glyph, the file folds, the cursor
advances to the next file row. `m` again on that file (reached by `n`… by `↓`/`↑`, or a
click) clears the mark and reopens it. `⏎` keeps folding alone; a marked file reopened
with `⏎` keeps its `✓` — the mark is what was *reviewed*, the fold is display.

The mark lives with the `diffCollapsed` set (keyed `diffFileKey`, per chat component):
it survives the live refresh — **including a file that changed under it** (the ticket's
rule, the same the fold follows) — and does not survive a restart. A `✓` from yesterday
would claim a reading that never happened today.

### Sources and the base

`d` opens a command panel (`openPanel`, the host's bottom-strip shape) — sources first,
the base row under them:

```
┌ Diff source ─────────────────────────┐
│  branch + local      vs main      ⏎  │
│  committed only      vs main         │
│  working tree only                   │
│  last turn                           │
│ ───────────────────────────────────  │
│  base for this repository:  main  ⏎  │ → branch picker (local + remote refs)
└──────────────────────────────────────┘
```

Git sources, per git top (each section is its own repository and keeps its own base):

| source | walk |
|---|---|
| `branch + local` (All) | `git diff <base>` — commits since base **and** local changes |
| `committed only` | `git diff <base>...HEAD` — what the branch committed |
| `working tree only` | `git diff HEAD` — staged + unstaged against the last commit |
| `last turn` | not git (below) |

Base defaults to the repository's default branch (resolving `origin/HEAD`, falling back
to `main`/`master` as the walk finds them). The picker lists local and remote branches
(`git for-each-ref`, read-only). The choice is remembered **per git top for the life of
the process** — a preference of the person's, held beside the plugin's runtime state,
and deliberately not a session entry. A repository where git cannot name a default gets
the picker and honest wording, never a silent `HEAD`.

**`last turn`** is the only non-git source: the write reports the host keeps per call
(`reportChange` → the `kind: 'change'` record — what the `✎` blocks draw, restored from
a session file just the same). The panel lists every reported change of the last
completed turn:

- a change whose **title is a path** is grouped under its git top (`gitRootOf`) and
  drawn like any file;
- a change whose **title is not a file** (`ABC-1 · description` — a plugin's write to
  something not on disk) is drawn the same way the chat draws it: its title row and its
  hunks under it (same `@@` numbering, foldable, cursor-reachable, markable), in a
  dim-headed group of its own after the git tops — `changes that are not files`. The
  hunks exist whatever the title is: a change is two texts.

The panel is the reader and draws a change WHOLE — so the record must hold it whole.
Settled with the person: `reportChange`'s capture keeps the unified diff **whole, up to
a hard cap** (`CHANGE_DIFF_MAX` — 2 MiB of diff text, the panel's own `MAX_FILE_BYTES`
scale); past the cap the record cuts and counts `hidden`, and the panel says
`… N lines not kept` where the hunks end. **The chat is untouched**: its `✎` keeps its
present display limit (its rows plus `… N more lines`) exactly as today — that cut moves
from capture into the drawing of the block (`changeMarkdown`), never into the record.

Three honest limits, said where they bite:

- it shows what write tools **reported** (`reportChange`) — a `run_command` that wrote
  files on its own is not in it;
- past the record cap the panel says `… N lines not kept`;
- a turn with no reports says `the last turn reported no file changes`.

Switching source keeps the cursor's file where it exists in the new source and drops to
the first item where it does not; marks are keyed by file and so carry across sources.

### Fullscreen and help

`f` toggles the panel between its docked split and the whole terminal drawn in the log's
full-view shape (its own frame, the same rows, the same hint row). From either shape
`q`/`Esc` close the viewer; `f` brings the other one back. While fullscreen, the view is
big and holds the keys it needs — the field takes nothing (a log-like view: you read,
then you type). The hint row keeps the caps of the actions drawn with `keyCap`.

`?` opens the help with the panel's own keys listed — every row a `keyCap` beside its
label, the keys that act *here* (the help already filters to the acting set).

### Where the code goes

- `src/plugins/assistant.ts` — actions in `keys`, the dispatcher block (extended from
  the `diffOpenRef` one), the source/base dialog, the cursor/source/mark state.
- `src/views/modals.ts` — `diffPanelBody` grows grouping + items + the cursor row;
  `DiffBody` unchanged in kind (it already scrolls the cursor row into view only when the
  cursor moved); the hint row; the fullscreen shape.
- `src/assistant/working-tree.ts` — `workingTreeDiff(roots, { base, mode })`,
  `listBaseRefs(root)`; still read-only.
- `src/assistant/diff.ts` — `diffRowGroups(diff)`; `lastTurnChanges(conv)` beside it
  (the provider); `changeMarkdown` gains the display cut the capture used to do (the
  chat's rows and its `… N more lines` stay what they draw today).
- `src/assistant/agent.ts` — `reportChange` captures the diff whole up to
  `CHANGE_DIFF_MAX`.
- `src/assistant/sessions.ts` — the record shape is unchanged; `hidden` now means
  "lines beyond the record cap" (it was "beyond the display cut").
- `CHANGELOG.md` — an Unreleased line.

### Settled with the person (builder check)

- **The record holds the change whole, the chat draws as it always has.** `last turn`'s
  hunks are the reported diff kept WHOLE up to `CHANGE_DIFF_MAX` (2 MiB of diff text);
  past it the record counts `hidden` and the panel says `… N lines not kept`. The chat's
  `✎` keeps its present rows and `… N more lines` — its display cut moves to the drawing
  of the block. A note-only variant (panel shows the 80 recorded rows plus a note) was
  the alternative and was not taken: the panel is a reader, and a `✓` must cover the
  lines it shows.
- **A change that is not a file is drawn as a diff.** Its before/after are texts, so its
  hunks exist and are drawn under its title row exactly as the chat draws them — in a
  dim-headed `changes that are not files` group after the git tops, reachable by `]`/`[`
  and markable like any file. Dropping it with a note was the alternative and was not
  taken.
- **The key policy is per shape (my call).** The empty-field gate belongs to the docked
  panel, which sits beside the live field. Fullscreen is a log-like view: while it is
  drawn its keys are its own regardless of the draft; a pending question or y/n and the
  `:` line draw over it and are answered first (the picker's rule); the draft is
  untouched by `f`. `Esc`/`q` close the viewer from either shape.

## What's left to the builder

- The exact spelling of the new bindings in the `keys` table and their deduplication
  against the host's (`end`, `escape`) in the dispatcher order.
- The command-panel rows/keys of the source dialog (the `openPanel` shape after the
  model picker's).
- How `?` reaches the help's "acting here" set from a plugin panel — consult the help
  modal's inputs in `src/views/modals.ts`; a plain modal of its own is the fallback.
- `diffRowGroups`' exact row numbering (it joins `diffRows`, which owns the `no`
  gutter) and the cursor pair's stable keying across a refresh.
- The turn boundary `lastTurnChanges` reads (the conversation's turn counter vs its
  last completed turn) — pin the exact API in the plan.

## Verification (shape; the plan pins commands)

- `bun run typecheck`, `bun test ./src ./scripts ./packages` — the suite green, with
  every new wait through the shared `settleUntil` and its label.
- `src/__tests__/diff-panel.e2e.test.ts` grows: hunk navigation across two files, the
  cursor row's mark at hunk granularity, `m` surviving a refresh and reopening, `s`'s
  `3 of 7`, `f`'s two shapes, the source dialog and base picker against scratch git
  repos (the file's existing `scratchTree`/`scratchPair`), `q` closing the panel and
  not the app, and the empty-field gate (a typed `m` types while the field is
  non-empty and marks while it is empty).
- `src/assistant/__tests__/working-tree.test.ts` grows: `base`/`mode` per mode, the
  default-base resolution, `listBaseRefs`.
- `src/__tests__/change-diff.e2e.test.ts` grows: a change over `CHANGE_DIFF_MAX` — the
  panel says `… N lines not kept` while the chat's `✎` block draws exactly the rows and
  the `… N more lines` note it draws today; a non-file change — its hunks drawn under
  its title row in the panel and reachable by `]`/`[` and `m`.
- The eyes script (`scripts/ui-frames.ts`) renders the panel in each shape for a look.
