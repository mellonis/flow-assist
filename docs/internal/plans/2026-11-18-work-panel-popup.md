# The Work Panel Popup — Design and Implementation Plan

## Design

### Intent

Checking "what is running" costs too many keystrokes: the person reaches for `J` or
`/work`, gets a near-fullscreen list (the shared command-panel box is 82% of the
terminal), and scans two group headers for the one row that matters. A keystroke the
hand already knows — `↓` on an empty prompt — should open a glance panel: a compact
strip pinned to the bottom of the chat, subagents and shells on their own tabs, acting
on a row and gone.

The `↓` slot is not free: on an empty field it today steps into the tree rows under the
field when children exist (`src/plugins/assistant.ts:3188-3195`). That path goes away —
it is a narrower door to a subset of the same rows (see Approaches).

### Goals

- **`↓` on an empty field opens the work panel.** "Empty" is the exact predicate the
  tree handoff uses today: no text in the field, no history line shown, `!` level 0.
  When there is no work at all (no subagents, no shells) the key stays silent.
- **The panel is a bottom strip over the chat**: fixed 12 rows tall, its list window
  scrolling, its bottom edge flush with the chat area's bottom (the `:` line below the
  chat stays visible and alive). It covers the input field and the tail of the
  transcript; the draft is untouched underneath. Nothing else on screen moves.
- **Subagents and Shells are tabs**, `← →` switch, each tab showing its count
  (`Subagents (3)`, `Shells (2)`). The cursor starts on the tab's first row after a
  switch. An empty tab draws the strip's dim `none` message — no row at all — and
  `←`/`→` still switch out of it.
- **`ctrl+d` stops a subagent** after the same named-row y/n the shell kill uses — the
  question stands in place of the row it is about, `y` answers the row it names.
- All three doors stay one panel: `↓`, `J`, `/work`.

### Non-goals

- Terminals or any other work kind (a third tab later; `WorkRow.group` keeps its union).
- Reworking `/model`, `/theme`, `/mcp` — they keep the window look.
- Per-tab cursor memory — the tab's first row is the landing rule (see Approaches).
- The tree rows' display under the field, the watch's `back` rule, or any ask/child
  behaviour: the tree-row key holder stays reachable exactly where it is today (a
  watch's Esc lands the cursor there), only its `↓` door is replaced.

### Constraints

- Host UI text English; comments English, present tense, no history. Key hints drawn
  with the glyph helpers (`keyGlyph`/`keyCap`), never hand-written symbols.
- TDD; the suite passes with `plugins-available/` empty
  (`bun run typecheck && bun test ./src ./scripts ./packages`).
- Docs true same-commit (`docs/usage.md`, the agent-spec pages, `AGENTS.md` checked).
- Version stays `0.1.0`. No `Co-Authored-By` trailer.
- The host's modal vocabulary: the strip is a variant of the shared command panel's
  look (`frame`/border idiom), not a window of its own.

### Approaches

**Where the panel sits.**
1. *Bottom strip overlaying the chat (chosen).* A glance panel must not move what the
   person is reading; the field is covered while the panel is up and the draft is
   whole when it closes. The question block already shows "the field's place" can be
   handed over without disturbing the transcript.
2. *Grow the bottom panel like a question block (rejected).* Twelve rows of growth
   shoves the transcript and the eye-landing rules around every time the panel opens.
3. *Centered content-sized window (rejected).* Content-sized height flickers as work
   starts and ends; the person asked for a fixed height, and the bottom is where the
   eye already is.

**How tabs ride the panel machine.**
1. *Plugin-side active tab + additive seams (chosen):* the picker keeps one `tab` in
   its closure; `rows()` serves that tab's rows; two `PanelKeyDef`s (`left`, `right`)
   switch tabs; `PanelSpec` gains `look?: 'window' | 'bottom'` and
   `tabs?: () => { label: string; current: boolean }[]` (read at every draw, like
   `rows`), `PanelKeyDef` gains `reset?: boolean` (after the key runs, the cursor lands
   on the first runnable row — the `panelStart` rule). `workRows` stays pure and keeps
   its `group` field; the picker filters.
2. *A tab machine inside `PanelSpec` with per-tab cursors (rejected):* shared-machine
   risk (`/model`, `/theme`, `/mcp` ride it) bought for a convenience.
3. *Two nested panels (rejected):* Esc would walk back through tabs instead of closing.

### Decided hows

- **Door predicate** (at the current handoff's place, `assistant.ts:3188-3195`):
  `inputRef.current === '' && histAt.current === null && bangLevelRef.current === 0`
  AND `workRows(...)` is non-empty over the session's subtree. It disarms an Esc-Esc
  arm like the handoff did (the round-4 pin holds) and does not stamp the grace. The
  history walk is untouched; an accepted edge: ↑↑ then ↓↓ back to the empty line, one
  more `↓` opens the panel.
- **Geometry**: box height exactly 12 rows — border 2 + tab strip 1 + 8-row list
  window + hint 1, no padding, no gaps — capped to the chat box's height (a shorter box
  gives the strip its whole height and the list window shrinks). Width =
  `chatBoxWidth(width, fullscreen)`. Bottom edge flush with the chat box's bottom border
  row (the area's bottom row in full mode, where the box is the area). Scrolling: the
  existing `ScrollBox` cursor window; wheel/PgUp/PgDn.
- **Tab strip**: the question wizard's strip idiom (`cutStep` labels, current tab
  inverse, the gap outside the inverse). Counts in the labels.
- **Hint row**: `Esc close · ←→ tabs · ↑↓ pick · ⏎ open · ^d stop/kill`, glyphs via the
  helpers. The way out comes first: the row is cut at the frame's width, and what falls
  off a narrow strip must never be the way out. `←→ tabs` is synthesized only when BOTH
  arrow keys are declared, so a panel that withholds them (the stop question's keys)
  never names an arrow that does nothing; `↑↓ pick` stays, since it still moves. A
  notice (the stop/kill question's context line, a panel `notice`) takes the hint row's
  place while it is up.
- **Rows and actions** (unchanged apart from tabs): sub rows `path › …` + state,
  `? waiting for you` = `offeredWithin` (in it or below it); shell rows `id · cmd` —
  `<state> — <owner>`; ended rows sink per tab. `⏎` opens (watch / jump to the waiting
  request / shell output). The stop/kill question names its row and stays a no-op while
  the registry no longer holds the job or the node (`killPending`'s shape, one for
  each kind).
- **Fetch-if-empty note**: `usage.md:431-433`'s parked wording (`y`/`n`/`ctrl+d`
  "wherever the cursor is", false on the old group rows) dissolves — this panel emits
  no group rows, every row the cursor can rest on is actionable. Tidy the sentence
  while the page is being rewritten.

### Left to the builder

- Flow layout inside the strip (one Box vs two).
- Whether the count is dropped from a label at 0 or shown as `(0)`.
- The exact stop route for a subagent row — reuse the tree rows' `x stop` call
  (`stopQuestion` + the node's stop) verbatim; only its question wording is shared
  with the shell kill.

---

# The Work Panel Popup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `↓` on an empty prompt opens the work panel as a fixed-height bottom strip
with Subagents/Shells tabs, and `ctrl+d` stops a subagent as it kills a shell.

**Architecture:** The picker in `src/plugins/assistant.ts` (`openWork`) swaps the `↓`
tree-rows handoff for `openWork()` behind the same predicate, serves one tab's rows at
a time (filtering `workRows` by `group`), and gains `left`/`right` key defs. The shared
command panel (`src/assistant/command-panel.ts` + `renderCommandPanel` in
`src/views/modals.ts`) grows two additive seams — `look` geometry and a `tabs` strip —
and a `reset` cursor rule on a key def. `PanelState` is untouched.

**Tech Stack:** Bun 1.4 / TypeScript strict (NodeNext), React 19 + `@flowtty/react`,
bun test.

**Spec:** `docs/internal/plans/2026-11-18-work-panel-popup.md` (the Design section
above).

## Global Constraints

- UI text and comments English; comments present tense, no history. Key hints drawn
  with `keyGlyph`/`keyCap`-style helpers only — never hand-written symbols.
- TDD: a failing test first per change; `bun run typecheck && bun test ./src ./scripts
  ./packages` passes with `plugins-available/` empty (machine flake families on this
  box: mcp-*, the settings-pager y/n, the session y/n order, `two subagents ask`,
  `x then y with a child's request…`, the loader async builder, `run_command` view
  fill — name them, do not chase).
- Docs true same-commit: `docs/usage.md`, `docs/internal/agents/*.md`, `AGENTS.md`
  checked every task. One `CHANGELOG.md` entry under `## Unreleased` for the whole
  change (lands with Task 3).
- Version stays `0.1.0` — no bump, no tag. No `Co-Authored-By` trailer.
- `PanelSpec`/`PanelKeyDef` changes are additive; no `HOST_API` bump; `panelStart`'s
  header-skip and every other panel's window look stay as they are.

## Review Focus

1. `↓` with the field just emptied through a bang step (`!!` cleared to empty) or
   mid-recall must not open the panel — only the exact door predicate does (Task 1:
   `a bang step or a recall keeps the down-arrow away from the panel`).
2. History walk back to the empty line then one more `↓` opens the panel — accepted
   and pinned so it is never a surprise regression (Task 1: the door test's companion
   assertion).
3. A terminal shorter than the strip: the box caps to the area height and the hint row
   survives (Task 2: the frame pin on a short terminal).
4. The stop question survives the row's world changing under it — the node ended
   between `ctrl+d` and `y`: the question stands, `y` is a no-op (Task 3: `a subagent
   that ended under the question is not stopped twice`).
5. Esc-Esc armed, then `↓`: the arm is gone and one Esc in the panel means close
   (Task 1, retargeting the exit-keys pin that rides the old handoff).

---

### Task 1: The `↓` door

**Files:**
- Modify: `src/plugins/assistant.ts:3188-3195` (the tree-rows handoff branch becomes
  the work door)
- Test: `src/__tests__/work-picker.e2e.test.ts`, `src/__tests__/exit-keys.e2e.test.ts`
- Possibly re-route setups in: `src/__tests__/subagent-watch.e2e.test.ts`,
  `src/__tests__/subagent-tree.e2e.test.ts`,
  `src/__tests__/subagent-requests-keys.e2e.test.ts` (the "cursor in the rows" cases —
  today they press `↓` from the empty field)
- Docs: `docs/internal/agents/ask-children-spec.md` (the handoff clause, ~:81),
  `docs/usage.md` (the work-picker page's door sentence)

**Interfaces:**
- Consumes: the existing `openWork()` closure and `workRows` non-emptiness (same
  subtree walk `openWork`'s `rows()` does).
- Produces: nothing named — behaviour only.

- [ ] **Step 1: Write the failing tests** in `src/__tests__/work-picker.e2e.test.ts`:
  `a down-arrow on an empty field opens the work panel` (boot with one subagent and one
  shell; type nothing; `ui.press('down')`; assert the panel frame is up and `⏎ open`'s
  hint row is drawn; then `ui.press('escape')` and assert the panel is gone) and
  `no work — the down-arrow stays silent` (a boot with no children and no jobs;
  `ui.press('down')`; assert no panel, and the field is still empty). In the first
  test, add the accepted-edge assertion: after `ui.press('up')` twice and `ui.press('down')`
  back to the empty line, one more `down` opens the panel. Add
  `a bang step or a recall keeps the down-arrow away from the panel`: step the bang
  level up with `!` on the empty field and press `down` while it is up — no panel
  (then step it back and the door works again); recall a history line with `up`,
  press `down` first — the field walks the history, no panel.
- [ ] **Step 2: Run the tests to verify they fail**
  Run: `bun test src/__tests__/work-picker.e2e.test.ts`
  Expected: FAIL — `down` steps into the tree rows / nothing opens.
- [ ] **Step 3: Replace the handoff branch** at `src/plugins/assistant.ts:3188-3195`
  with the door: same predicate (`inputRef.current === '' && histAt.current === null &&
  bangLevelRef.current === 0`), plus a work-exists check (any row of `workRows` over
  `conv`'s subtree — do not build the panel's rows twice; a small closure helper both
  `openWork` and the door use is fine). Fires `openWork()`, calls `disarmEsc()`, stamps
  nothing (a holder takes over, like the handoff did). The tree-row key holder
  machinery is untouched — only this entry is gone.
- [ ] **Step 4: Run the tests to verify they pass**
  Run: `bun test src/__tests__/work-picker.e2e.test.ts`
  Expected: PASS.
- [ ] **Step 5: Re-route and keep the dependent tests green**
  Run: `bun test src/__tests__/exit-keys.e2e.test.ts src/__tests__/subagent-watch.e2e.test.ts src/__tests__/subagent-tree.e2e.test.ts src/__tests__/subagent-requests-keys.e2e.test.ts`
  The exit-keys pin ("↓ disarms the arm") must keep passing with the new door (Step 3
  disarms). Any test that placed "the cursor in the rows" by pressing `↓` re-routes to
  the surviving way in (a sub row's `⏎` watch, Esc back to the tree rows) — change
  setups only, never the assertions. Expected: PASS.
- [ ] **Step 6: Docs** — `docs/internal/agents/ask-children-spec.md`'s clause that the
  `↓` steps into the tree rows now says the `↓` opens the work panel and the tree rows
  are entered from a watch's Esc-back; `docs/usage.md`'s work-picker page names the
  `↓` door. Then `bun run typecheck`.
- [ ] **Step 7: Commit**
  ```bash
  git add -A
  git commit -m "feat: the down arrow on an empty field opens the work panel"
  ```

### Task 2: The bottom strip look and the tab-strip plumbing

**Files:**
- Modify: `src/assistant/command-panel.ts` (`PanelSpec`, `PanelKeyDef`)
- Modify: `src/views/modals.ts` (`CommandPanelView` at :2425, `renderCommandPanel` at
  :2436)
- Modify: `src/plugins/assistant.ts:3607-3609` (the view literal carries the new
  fields through)
- Test: `src/views/__tests__/modals.test.ts`, `src/assistant/__tests__/command-panel.test.ts`
- Docs: `docs/internal/agents/chat-spec.md` (the panel-machine page gains the `look`
  seam and the strip line)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces (Task 3 consumes, exact names):
  - `PanelSpec.look?: 'window' | 'bottom'` (static; default `'window'` — every other
    panel is unchanged).
  - `PanelSpec.tabs?: () => Array<{ label: string; current: boolean }>` (read at every
    draw, like `rows`).
  - `PanelKeyDef.reset?: boolean` (after the key's `run` returns without opening a
    nested panel, the cursor lands on the first row a key can run on — `panelStart`'s
    rule).
  - `CommandPanelView.look?: 'window' | 'bottom'` and
    `CommandPanelView.tabs?: Array<{ label: string; current: boolean }>` (carried at
    the view literal, `assistant.ts:3607-3609`).

- [ ] **Step 1: Write the failing tests.** In `src/views/__tests__/modals.test.ts`,
  `the bottom look is a fixed 12-row strip at the chat's bottom` — render
  `renderChatModal` (the ask/panel path) or `renderCommandPanel` directly with a view
  whose `look: 'bottom'` and `tabs: [{ label: 'Subagents (2)', current: true },
  { label: 'Shells (1)', current: false }]`, at 100×40 and at 100×12: assert the drawn
  box is exactly 12 rows tall flush with the bottom (12 = the terminal's height on the
  short case takes the whole area), the tab strip row is just under the top border
  with the current tab inverse, the hint row `Esc close · ←→ tabs · ↑↓ pick · ⏎ open · ^d
  stop/kill` is just above the bottom border, and a `notice` replaces the
  hint row. In `src/assistant/__tests__/command-panel.test.ts`, `a key marked reset
  lands the cursor on the first runnable row` — a panel whose rows begin with a group
  row; a `reset: true` key presses; the cursor is on the first non-group row; a key
  without the flag leaves the cursor where it was.
- [ ] **Step 2: Run the tests to verify they fail**
  Run: `bun test src/views/__tests__/modals.test.ts src/assistant/__tests__/command-panel.test.ts`
  Expected: FAIL — `look`/`tabs`/`reset` do not exist.
- [ ] **Step 3: Implement the seams.** `command-panel.ts`: the three additive fields,
  `panelKey` honoring `reset` after `run` (both the bare-name and the chord path,
  using the `panelStart` first-runnable rule; a `run` that answers a nested panel is
  not a reset). `modals.ts` `renderCommandPanel`: when `panel.look === 'bottom'`, the
  box is `height: Math.min(12, height)` × `chatBoxWidth(width, fullscreen)`, `padding:
  0`, `gap: 0`, pinned to the bottom of the overlay (the border plus strip plus an
  8-row `ScrollBox` list window plus the hint row = 12), the list window
  `windowAround(lines, cursor, 8)`, and the message/notice takes the hint row. The
  strip draws only when `panel.tabs?.length` (the wizard's strip idiom: `cutStep`
  labels, current inverse, the gap outside the inverse). `'window'` is byte-for-byte
  today's draw. The view literal at `assistant.ts:3607-3609` carries `look` and `tabs`.
- [ ] **Step 4: Run the tests to verify they pass** (same command as Step 2), then
  `bun test src/__tests__/theme-command.e2e.test.ts src/__tests__/work-picker.e2e.test.ts`
  (the other panels and the pickers stay green).
- [ ] **Step 5: Docs** — `docs/internal/agents/chat-spec.md`'s panel-machine section:
  one line for `look` (a `bottom` panel is a strip over the chat's bottom, its message
  row replaces the hint) and one for `tabs`/`reset`. Then `bun run typecheck`.
- [ ] **Step 6: Commit**
  ```bash
  git add -A
  git commit -m "feat: a command panel can be a bottom strip with tabs"
  ```

### Task 3: The picker on tabs, and `ctrl+d` stops a subagent

**Files:**
- Modify: `src/plugins/assistant.ts` (`openWork`, ~:1800-1930; the view literal need
  not change again)
- Test: `src/__tests__/work-picker.e2e.test.ts`, `src/assistant/__tests__/work-panel.test.ts`
  (only if `workRows` changes — it should not)
- Docs: `docs/usage.md` (the picker page: tabs, counts, stop), 
  `docs/internal/agents/shell-jobs-spec.md` (shell rows on the Shells tab),
  `AGENTS.md` (checked; the `J`/`/work` and panel lines), `CHANGELOG.md` (ONE entry
  under `## Unreleased` for this change)

**Interfaces:**
- Consumes: Task 2's `PanelSpec.look`/`tabs`, `PanelKeyDef.reset`, `CommandPanelView`
  fields; `workRows`/`WorkRow.group` (`src/assistant/work-panel.ts`); `stopQuestion`
  and the tree rows' `x stop` route; `killPending`'s pure-read shape.
- Produces: nothing further named.

- [ ] **Step 1: Write the failing tests** in `src/__tests__/work-picker.e2e.test.ts`:
  - `the tabs split the work; ←→ switch and the counts follow` — boot with two
    subagents and one shell; open with `down`; the strip reads `Subagents (2)`,
    `Shells (1)`; the list shows only sub rows; `right` moves to `Shells (1)` (inverse
    follows) and the list shows the shell row; `left` is back; the cursor is each
    tab's first row after a switch; a tab with nothing draws the dim `none` message,
    and the arrows still switch out of it.
  - `ctrl+d stops a subagent after its question, and y names it` — `ctrl+d` on a sub
    row: the question replaces that row's text and names the sub; `y` stops the node
    (the row goes to its ended state / the node is stopped in the rig) and the panel
    closes or refreshes per the shell-kill precedent; `ctrl+d` on the question
    cancels.
  - `a subagent that ended under the question is not stopped twice` — the node ends
    while the question is up (the rig ends it), `y` is a no-op and the row reflects
    the ended state (the `killPending` shape for nodes).
  - `the panel is the bottom strip` — a frame assertion: the box sits at the bottom,
    12 rows, hint row as pinned (may live in Task 2's fixture instead if the frame
    shape is already covered there — one of the two must hold it).
- [ ] **Step 2: Run the tests to verify they fail**
  Run: `bun test src/__tests__/work-picker.e2e.test.ts`
  Expected: FAIL — group rows are still drawn, no tabs, `ctrl+d` on a sub row is a
  no-op.
- [ ] **Step 3: Implement in `openWork`.** A `tab` closure (`'subagents' | 'shells'`;
  opens on Subagents, or Shells when there are no sub rows and there is work);
  `rows()` filters `workRows(...)` by `r.group === tab` and emits NO group rows — an
  empty tab emits NO rows at all and the spec's `empty: 'none'` draws the dim message;
  the
  `look: 'bottom'` and `tabs: () => …` fill (labels `Subagents (N)`/`Shells (N)` from
  the same filter's lengths); two key defs `{ key: 'left' | 'right', label: 'tabs',
  reset: true, run: () => { tab = …; return undefined; } }`; `ctrl+d` on a `sub:` row
  goes through `stopQuestion` naming that sub and the node's stop — the same route the
  tree rows' `x` takes — with the question's existence checked at every draw like
  `killPending` (a node gone under the question: the question stands, `y` is a no-op).
  Every declared key runs on an empty tab too, on no row (`id: null`), the tab keys
  included. The hint is Task 2's pinned row; the per-row question text keeps the
  tree's own words.
- [ ] **Step 4: Run the tests to verify they pass**
  Run: `bun test src/__tests__/work-picker.e2e.test.ts src/assistant/__tests__/work-panel.test.ts src/assistant/__tests__/command-panel.test.ts`
  Expected: PASS. Then `bun run typecheck` and the focused fan-out:
  `bun test src/__tests__/subagent-tree.e2e.test.ts src/__tests__/exit-keys.e2e.test.ts src/__tests__/ask-grace.e2e.test.ts`.
- [ ] **Step 5: Docs and CHANGELOG** — `docs/usage.md`'s picker page rewritten as one
  page: the `↓` door (Task 1's sentence revisited if needed), the strip, the tabs and
  their counts, `⏎ open`, `ctrl+d` stop/kill with the named-row question (this also
  dissolves the parked "wherever the cursor is" wording — the panel has only
  actionable rows now); `docs/internal/agents/shell-jobs-spec.md`: shell rows live on
  the Shells tab; `AGENTS.md` check (its `J` the work picker / panel lines — fix if
  stale, else note "AGENTS.md unchanged, checked" in the report); `CHANGELOG.md` ONE
  entry under `## Unreleased`.
- [ ] **Step 6: Commit**
  ```bash
  git add -A
  git commit -m "feat: the work panel is a bottom strip with Subagents and Shells tabs"
  ```
