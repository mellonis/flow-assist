# The chat UX batch — `/theme`, the questions flow, the field fixes, the work picker

**Status:** design agreed 2026-11-17; implementation plan below.

**Spec:** this document — "Intent" through "Left to the builder" below.

---

One batch of four workstreams over the chat's own surfaces. They were chosen together
because two of them touch the same machinery (the ask flow), and shipped in one run in
the order below. Nothing here changes the model-wire, the plugin contract, or the
session format.

Tickets (GitHub issues, one per row of "Work breakdown") track them; each lands on its
own branch from `master`, tests first.

## Intent

1. **`/theme`** — the app's look is chosen in the chat: `system`, `light`, `dark`, in a
   menu where moving the cursor shows the theme applied at once. The choice outlives
   the run.
2. **The questions flow** — when the model asks, the person should see WHY it asks,
   answer several questions without fear (moving back and forth before committing), and
   see afterwards what was answered. And a question must never swallow what the person
   is in the middle of typing.
3. **The fields** — the caret moves everywhere (the `:` line today is type-at-the-end
   only), and history walking never pops suggestion menus at the person.
4. **The work picker** — one place to see and jump between everything running beside
   the chat: subagent conversations and background shells. (Terminals are a later
   group in the same panel.)

## Goals

### 1. `/theme`

- `/theme` alone opens a three-row menu over the conversation's place: `system`
  (follows the terminal), `light`, `dark`. The row in effect is marked.
- Moving onto a row applies that look **at once** — the whole screen repaints in the
  new palette, no Enter needed. Esc restores the look the app had when the menu
  opened. Enter keeps it and saves the choice (`ui.theme`, `config.local.json`).
- `/theme dark` (any of the three, Tab-completed) applies and saves directly; a bad
  argument is refused with the three words. A `note` row says what is in effect.
- The choice survives a restart and a terminal scheme change ("system" follows the
  terminal's own light/dark; a pinned `light`/`dark` does not).
- `config set ui.theme dark` works through the ordinary command and applies at once.

### 2. The questions flow

- **Why a question asks (item 2.1).** While a question is waiting for its answer, the
  narration that led into it draws **unfolded and at full ink**, not as one dim folded
  row. "The narration that led into it" is the **run of step rows immediately before
  the ask call** — the model's last stretch of "what I found / what I'm about to
  decide"; older runs of the turn stay folded and dim. The reasoning blocks stay
  folded and dim too: they are thinking, and they keep their `▸ thinking` header.
  Once the question is answered, the rows follow the normal fold rules again.
  Scope: the **session's own** `ask_user` question. A child's question routed to the
  person keeps today's block-and-answer flow (it already surfaces and its answer
  returns to the child); covering its narration in the watch view is a follow-up.
- **Several variants (item 2.2).** Already in the contract: `ask_user` carries 1–4
  questions, each with 2–4 options, `multiSelect` for several picks, and an automatic
  free-text row ("Other…"). This ticket only verifies with tests that the block draws
  and answers all of it (the multi-select ticks, the free text, the digits), and
  nothing in the new wizard below takes it away.
- **Moving between questions (item 2.3).** A call with more than one question becomes
  a small wizard inside the question box: one page per question plus a final **submit
  page**. `←`/`→` move between pages at any time; a page holds its picks and its typed
  text; going back and changing anything works until the very last Enter. The submit
  page lists every question with what it will send (or `(not answered)`) and its Enter
  is the one that submits. A call with a single question stays exactly as it is today:
  the pick (or the typed words) answers it at once. Esc still dismisses the whole
  call, and a dismissal is never consent (the tool's wording is unchanged).
- **Answered questions stand out (item 2.4).** Once answered, the kept `? … / → …`
  rows in the transcript get a ground of their own — a quiet tint distinct from
  everything else in the chat — so a scan of the transcript finds every question and
  its answer. A dismissed one keeps the tint with dim ink. Same scope: the session's
  own questions (a child's question keeps no such rows today and stays as it is).
- **The typist is never robbed (item 3).** When a question arrives while the person is
  typing (a key within the last moment, or a draft alive), the keyboard **stays with
  the field**: the person finishes the word or the sentence, and only after a short
  pause does the question block take over. The question is visible while it waits —
  the status says `? a question is waiting` — and the draft is never lost. Enter
  during the pause sends the drafted message as it does today. An **open `:` line
  holds the keys outright**: a half-written command is a long thought, so the takeover
  waits until the line is closed or run.

### 3. The fields

- **The `:` line gets a real caret (item 2.5).** Left/right, Home/End, Backspace
  anywhere in the line, word jumps — the same editing the chat field has (one shared
  reducer, single-line mode). The completion ghost and Tab walk show only when the
  caret sits at the end, as in the chat field. History recall still lands at the end.
- **The question field (item 2.5).** The check the ticket owes: type words into the
  "Other…" field and move the caret with the arrows — it must move. The field already
  goes through the shared reducer, so the ticket writes the regression test first and
  fixes whatever the test finds swallowing the arrows.
- **History is history (item 2.6).** Walking ↑/↓ through past prompts never opens the
  suggestion menu (inline ghost or the list) on the recalled line. Suggestions open on
  a content edit only — typing or pasting. Tab-walk through candidates is unchanged.
  Both fields: the chat field (where the prompt history walks) and the `:` line (where
  its own history walks) — they keep their own suggestion lists, one rule each.

### 4. The work picker

- One panel over the conversation's place, opened by a capital key (default `J` —
  "jump"; bound through `keys` like every action) and by `/work` in the chat.
- One list, two group headers: **Subagents** and **Shells**; a group with nothing in
  it says `none`. Rows:
  - a subagent conversation: `main › review · running — <its title>`, and one that
    waits on the person marked `? waiting for you`;
  - a background shell: `sh-3 · npm run dev — <owner label>`, running or ended.
- Keys: ↑/↓ move (across groups); Enter on a subagent watches it (the existing watch:
  its rows where the list is, Esc back to where the cursor was) — on a waiting one the
  picker closes and its request block takes the keyboard; Enter on a shell opens its
  output in a pager of the job's kept buffer, live while it runs. `ctrl+d` on a shell
  kills it after the picker's own y/n. The panel holds every key while it is drawn.
- Esc closes. The hint row shows the keys as glyphs (`keyCap`/`keyGlyph` — never a
  hand-written symbol).

## Non-goals

- No theme editor, no theme files, no named colour schemes beyond the three words; the
  person's `theme` colour overrides keep working as they do.
- `config set ui.theme` is enough on the `:` line; no `:`-line `/theme` twin.
- No new question kinds (booleans, ordered lists), no re-answering a question
  **after** it was submitted — the model already read that answer; the wizard covers
  the window before the last Enter only.
- No change to what the model reads (`askResult`'s wording, the wire history) beyond
  what the wizard already sends.
- A child's (`ask_parent`) question is not reworked: it already surfaces to the person
  and its answer returns to the child. Its narration staying dim in the watch view is
  a follow-up, not this batch.
- No terminal panes and no terminal group in the picker (a later feature adds the
  third group).
- The y/n confirm block keeps its own 600 ms arm; only questions get the typing grace.
- No pagination of the transcript changes beyond the ground of answered questions.

## Anti-goals

- A question must never lose what the person typed — not on a page switch, not on a
  takeover, not on a theme repaint.
- The wizard must not add keystrokes to the one-question case: a single question is
  still one key to answer.
- The suggestion menu must never appear while the person is merely remembering a
  prompt; the completion ghost must never draw under the caret when it is mid-line.
- The picker must not become a second session picker: it lists this session's work
  only, never other sessions.
- The theme menu must not leave a half-applied palette or a hidden pin: Esc restores
  the **mode** the menu opened with. `system` by its meaning follows the terminal, so
  a terminal that flipped while the menu was open leaves a different look — the
  honest reading, not a snapshotted palette; what Esc must never do is leave the menu's
  preview behind as a choice.
- No feature name or screenshot of the reference tool in the docs or commits: the
  behaviour is ours, stated as ours.

## Constraints

- The host's own UI is English throughout: hint rows, status words, panel labels,
  error lines. Comments in code: English, present tense, no history.
- A key hint is drawn with `host.keyCap(action)` / `bindingGlyph(...)` / `keyGlyph(...)`
  — never a symbol written by hand. Key comparisons use the terminal's names.
- New colours go into **all three** palettes (`modalColorDefaults`, `LIGHT_MODAL_COLORS`,
  `UNKNOWN_MODAL_COLORS`) and are drawn as `${token}`, never a literal. A window that
  paints its own ground sets its own ink.
- One modal look: `frame()` / `overlay()` from `src/views/modals.ts`; a panel holds
  every key while drawn; a modal is as tall as what it holds and scrolls otherwise.
- The chat and its key handler stay the ONE dispatcher; `chatFieldWidth`-style width
  helpers are the single source of a field's width (the ask field's reducer call must
  keep the width it is drawn with).
- TDD: a failing test first for every ticket; the host suite must pass with
  `plugins-available/` empty; `bun run typecheck && bun test ./src ./scripts ./packages`.
- A behaviour pinned in `docs/internal/agents/*` changes in the same commit as the
  code: `chat-spec.md` (rows, folds, the field, the pickers), `ask-children-spec.md`
  (the ask flow), `shell-jobs-spec.md` (the picker's shell rows). `docs/usage.md`
  gains the user-facing pages (`/theme`, the wizard, the picker). `CHANGELOG.md`
  gains an `## Unreleased` line per ticket.
- Version stays `0.1.0` in this batch: no bump, no tag — a release is the person's
  call.

## Approaches

### Theme: where the three words live

1. **A scheme override the app theme resolves through** (picked): one place answers
   "which scheme is in effect" = the configured `ui.theme` unless it says `system`,
   then the terminal's. Every place that re-resolves the palette (boot, a plugin
   joining, the terminal flipping) asks that one place; `/theme` in the picker just
   changes the answer and re-resolves in place (the palette object a plugin may hold
   is mutated, never replaced — the rule the app already follows). Why: the app
   already re-paints on a terminal scheme change; this rides the same rail, and the
   preview and the save are the same call with different arguments.
2. Two palettes swapped at render: every component would choose a palette family —
   more code at every draw and two of everything. Rejected.
3. A restart-only setting (as `theme` is today): no live preview, which is the point
   of the menu. Rejected.

Saving goes to `config.local.json` through the ordinary config path (`ui.theme` is a
plain key, applied live — no `appliesOnRestart` mark); the app's resolved
`config.theme` is never overwritten by a raw value (the existing test guards this).

### Questions: how several questions are answered

1. **Pages in the question box — one question per page + a submit page** (picked):
   the box keeps its size and its look; the person answers one thing at a time but
   sees where they are (a tab strip with ticks) and can walk back; the single-question
   case is untouched (the wizard only exists for >1). Why: the box is the surface that
   already takes the keys, and a page is the least crowded thing that still shows
   everything it must. The alternative the sketch weighed:
2. All questions stacked in one tall block, cursor on rows: fastest to scan, but a
   4-question call with long options and free-text fields cannot fit the bottom of a
   28-row terminal without scrolling inside a modal that also shows the conversation —
   it fights the layout rule ("a modal is as tall as what it holds; what does not fit
   scrolls", but here we want all questions *as* the person answers, not scrolled).
3. The ask block reopens on demand (answer one, then `/questions` to revisit): no
   screen for the whole, and a git of forgetting. Rejected.

### The lead-in above a question (item 2.1)

1. **Unfold and un-dim the run the question belongs to while it waits** (picked): a
   display-time condition (a flag into row building), not a fold-state change — the
   fold machinery keeps its global state and click exceptions untouched. Why: the
   context is already on screen where the eye is; nothing duplicates; it falls back to
   normal the moment the question ends.
2. Quote the last narration inside the question box: self-contained, but duplicates
   rows, needs truncation, and the quote goes stale as the conversation scrolls off.
3. Un-dim all steps always (drop the fold): destroys the tool-trail condensing the
   chat is built around. Rejected.

### The typist's grace (item 3)

1. **Hold the takeover while keys are fresh** (picked): the question parks (the model
   waits regardless); the status line names it; keys keep going to the field and each
   one re-arms the hold; ~600 ms of quiet hands the keyboard to the block through the
   existing claim path (with its own swallow window for keys already in flight). Why:
   it uses the arm-clock seam a test can move, changes no answering rules, and the
   only visible cost is one dim status line.
2. Split the bottom in two (field and question side by side): the layout's bottom
   place is one column; two half-width fields break the width helper rule. Rejected.
3. Make the takeover a manual step (a key to focus the question): more keystrokes to
   answer, and a question that doesn't grab is a question missed. Rejected.

### The work picker: one panel shape

1. **One list with two group headers** (picked) — one cursor, one frame of rules,
   the group rows dim; simplest to hold keys in and to extend with Terminals later.
2. A two-tab panel (Subagents | Shells): prettier at ten rows each, but adds a tab
   keybinding surface and a "which tab am I on" cost for a list that is usually 1–3
   rows per group. Rejected; the group-header list can become tabs later without
   changing the data.

## The design (the how, as decided)

### `ui.theme` and the scheme override

- Schema: `ui.theme: z.enum(['system', 'light', 'dark']).optional()` under the `ui`
  object (`src/config/schema.ts`), no mark for the model (the person's own
  appearance), applied live. Absent = `system`.
- One app-side value — "the pinned scheme" (`null` = follow the terminal) — consulted
  at all three palette resolution sites in `src/runtime/app.tsx` (boot, plugin
  rebuild, terminal scheme change). Re-resolution mutates `config.theme` in place.
- The chat reaches it like the overlay service: a host service on
  `host.services` (`setThemeMode(mode)` — additive, no HOST_API bump, the host wins
  the key), which re-resolves and notifies. The picker's Esc restores the mode the
  menu opened with; Enter saves via the config path and keeps the applied palette.
- The panel is the `PanelSpec` picker (`/model`'s pattern) with one addition to the
  panel machinery: an optional `onCursor(rowId)` hook, called from the panel key step
  and the mouse row-pick — that is the live preview seam. Rows carry `system ·
  follows the terminal`, `light`, `dark`; the current one is marked as `/model`
  marks its.

### The question wizard (`src/assistant/ask.ts`, pure)

- `AskState` keeps `questions` and gains `index` (page 0..n-1, and page n = the submit
  page when n > 1) and one draft per question `{ picked: number[]; other: string;
  caret: number; typing: boolean }` — a page holds what was typed on it, so leaving
  and returning restores text and caret. `done`/`cancelled` as today.
- Keys (single-line pages, `editorReducer` on the free-text field as today):
  `left`/`right` — pages (not while typing: there they move the caret); `up`/`down`,
  digits, space, Enter per page as today; Enter on a page saves the draft and moves to
  the next page (the last question moves to the submit page); Enter on the submit page
  submits — the tool's promise resolves then (`askResult`, unchanged wording), and the
  kept rows/journal rows are written then, one per question as today (sessions and
  journals stay format-compatible). A question with no draft is sent as `no answer
  given` (my call: an honest empty beat a forced pick).
- Free-text drafts survive everything until submit: leaving a page keeps its text and
  caret and turns `typing` off; returning to that page shows the draft on the
  "Other…" row, and Enter resumes editing at the kept caret. On a page whose draft
  has text, a printable key resumes editing and **inserts** at the caret — it never
  replaces the draft (the anti-goal).
- n === 1: no pages, no submit page — today's keys exactly.
- Drawing (`renderAsk`): the box keeps its shape; the title stays `? [i/n · ][header —
  ]question`; when n > 1 one tab strip row under the title — each page a `✓ header`
  (draft present) or `header`, the current in inverse, truncated to the box width
  (exact truncation to the builder). The submit page: each question on its own row
  (dim, `header`), its answer under it at full ink or `(not answered)` dim. Hints via
  `keyGlyph`: `←→ questions · ↑↓ move · ⏎ answer · type your own words · ⎋ dismiss`,
  and `←→ questions · ⏎ submit · ⎋ dismiss` on the submit page.
- The tool call stays out of the tool trail while it runs (as today).

### Lead-in, ground (items 2.1, 2.4)

- Row building takes an `askPending: boolean`: when set, the step rows of the current
  run draw unfolded and not dim. No fold state changes; the condition dies with the
  question.
- The answered `? / →` rows take `chat` palette tokens `askBg` (and `askFg` where the
  ground needs its own ink): all three palettes, drawn as `${askBg}`, spanning the
  message column's width per row. Overridable by a `theme` key as every token is.

### Typing grace (item 3)

- One constant (`GRACE_MS` ≈ 600) beside the ask guard, using the same `askClock`
  seam. Trigger: the history of keys — a key pressed within `GRACE_MS` before the
  question parked. While held: the block is not yet shown in the field place (the
  existing `waiting` wording appears in the status/strip, `? a question is waiting`),
  keys go to the field, every key re-arms. Quiet for `GRACE_MS` → the block takes over
  through the existing claim path (its swallow window lands after the grace). Enter
  during the grace sends the message normally (it queues behind the turn; nothing new
  in the queue rules). An open `:` line holds the keys outright — the takeover waits
  for the line to close or run. Applies to the session's own question and to a child's
  question routed to the person; the y/n confirm keeps its own arm.

### The `:` line caret and suggestions (items 2.5, 2.6)

- `CommandLineState` gains `caret`; the line edits through the shared
  `editorReducer` (single-line, the line's width), drawing a caret cell at `caret`.
  Ghost/Tab-walk only at the end of the line (the chat field's rule, one constant).
  History recall sets the caret to the end. Everything else (bang level, history,
  Tab, list) keeps its behaviour.
- The completion list/inline offer opens on a **content edit** only. History recall
  marks the field; the mark clears on the next edit. Tab-walk (`lineTab`) is
  unchanged, and the list's own keys keep working while it is open.

### The work picker

- New picker state in the assistant plugin's style (a small machine beside
  `session-picker.ts`, or `PanelSpec` extended with group rows — the builder picks
  whichever keeps the group headers and `ctrl+d` y/n simpler; the rows' data is the
  decision, not the container).
- Data: the session's live tree (`TreeNode`: label path, state, running title, the
  parked request if any) and the host job registry (`ShellJob`: `sh-N`, command line,
  owner label, running/ended, kept tail) — the same lists `ui.agentRows` and
  `shell_list` read.
- Rows and keys as in "Goals 4". Watching is the existing mechanism; the picker is
  **one-shot** — Enter opens the watch and closes the picker, and Esc from that watch
  lands where the watch's own `back` lands (the chat's tree cursor), never back into
  the picker; the picker reopens on its key. The shell output is a pager over the
  job's ring buffer (`shell.jobChars`), live while the job runs. Kill takes the
  picker's own y/n and then the job's own kill path (never a name written into a
  shell).
- `work` keyAction, default binding one capital (`J` if free — the builder checks the
  bindings table and the help page), plus `/work` in the chat commands (bare opens the
  panel). The help lists both.

## Work breakdown (tickets, in order)

1. **The `:` line caret** + the question-field caret regression test (item 2.5).
2. **Suggestions only while typing** (item 2.6).
3. **`/theme` with live preview** (item 1) — schema key, scheme override, panel hook,
   command, tests (`color-scheme.e2e`-style cell assertions + `model-switch.e2e`-style
   picker drive), `docs/usage.md`, spec touch in `chat-spec.md` if the panel hook is
   pinned there.
4. **The question wizard** (item 2.3) — pure machine first (`ask.test.ts`), then the
   block (`modals.test.ts` frames), then e2e; includes the item-2.2 verification
   tests; updates `ask-children-spec.md` and `chat-spec.md` in the same commit.
5. **The readable lead-in** (item 2.1) — display flag + `chat-spec.md` wording.
6. **The answered ground** (item 2.4) — tokens in three palettes + row painting.
7. **The typing grace** (item 3) — arm-clock tests first.
8. **The work picker** (item 4) — machine, panel, bindings, help, `shell-jobs-spec.md`
   touch, e2e.

Each: a branch from `master`, red test first, one `## Unreleased` CHANGELOG line.
Nothing in this batch bumps the version.

## Left to the builder

- The exact truncation of the tab strip and the submit page's wording when a question
  has neither pick nor text beyond `(not answered)`.
- Whether the question field's arrows need a fix at all — the regression test decides;
  if it passes as written, the ticket is the test and the `:` line.
- The picker's container (own machine vs `PanelSpec` with group rows) and whether the
  shell output pager reuses the `run_command` view's frame verbatim.
- If `J` is taken by a binding, another free capital — and the word `/work` may be
  renamed if a better one shows up, as long as help and the key hint match.

---

# Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the four workstreams above land as eight tickets: the two field fixes, `/theme`
with live preview, the question wizard with its readable lead-in and answered ground,
the typing grace, and the work picker.

**Architecture:** pure machines first — the wizard in `ask.ts`, the `:` line's caret and
suggestion rules in `commandline.ts`, the picker's rows in a new `work-panel.ts` — each
driven by the chat's one key dispatcher (`src/plugins/assistant.ts`) and drawn by
`src/views/modals.ts`. The theme pins one scheme value on the app's existing
palette-resolution rail (`src/runtime/app.tsx`); nothing else moves.

**Tech Stack:** TypeScript 7 (strict, NodeNext), Bun 1.4 (`bun test`), React 19 +
`@flowtty/react`.

**Spec:** the document above — "Intent" through "Left to the builder" (agreed
2026-11-17).

## Global Constraints

- The host's UI text is English throughout (hint rows, status words, panel labels,
  error lines); code comments are English, present tense, no history.
- A key hint is drawn with `host.keyCap(action)` / `bindingGlyph(...)` /
  `keyGlyph(...)` — never a hand-written symbol; key comparisons use terminal names.
- New colours go into all three palettes (`MODAL_COLOR_DEFAULTS`, `LIGHT_MODAL_COLORS`,
  `UNKNOWN_MODAL_COLORS` in `src/playback/theme.ts`) and are drawn as `${token}`, never
  a literal; a window that paints its own ground sets its own ink.
- One modal look: `frame()` / `overlay()` from `src/views/modals.ts`; a panel holds
  every key while it is drawn.
- The chat keeps its one key dispatcher (`useInputHandler`,
  `src/plugins/assistant.ts`); a field's width comes from its one width helper
  (`askFieldWidth`, `chatFieldWidth`, the `:` line's view width).
- TDD: a failing test first per change; the suite passes with `plugins-available/`
  empty: `bun run typecheck && bun test ./src ./scripts ./packages`.
- A behaviour pinned in `docs/internal/agents/*` changes in the same commit as the
  code; `docs/usage.md` gains its user-facing pages; `CHANGELOG.md` gains one
  `## Unreleased` line per ticket.
- Version stays `0.1.0` — no bump, no tag in this batch. Branches from `master`, one
  per ticket, stacked in the order below. Never a `Co-Authored-By` trailer.

## Review Focus

- A page the person left and came back to must submit its **last** state — a draft
  edited twice sends the second text, not the first (Task 6 test
  `the submit page sends the last state of every draft`).
- A paste into "Other…" spanning a page switch stays one line and keeps the caret
  where the person left it (Task 6 test `a page keeps its draft when the person
  leaves and returns`).
- A palette change must repaint the screen at once — cached rows keyed by palette must
  not show the old colours under a live preview (Tasks 4–5, cell-style assertions in
  `theme-mode.e2e` / `theme-command.e2e`).
- A question parked while the `:` line holds a half-written command must not steal it:
  Enter runs the command first, the block takes over only after (Task 11 test
  `an open command line holds the keys over a waiting question`).
- History recall, then Tab-walk, then typing: only typing reopens the suggestion list
  (Task 3 test `walking history never opens suggestions`).

## File map

- `src/config/schema.ts` — `ui.theme` under `ui` (Task 4).
- `src/playback/theme-mode.ts` (new) — `ThemeMode`, `THEME_MODES`, `parseThemeArg`,
  `schemeFor` (Task 4).
- `src/runtime/app.tsx` — the pinned scheme at the three palette-resolution sites and
  the `setThemeMode` service (Task 4); the `:` line's caret and list rule (Tasks 1, 3).
- `src/config/commandline.ts` — a caret through `lineView`/`lineViewWithList`; the
  list opens on a content edit only (Tasks 1, 3).
- `src/assistant/ask.ts` — the wizard machine (Task 6).
- `src/views/modals.ts` — the ask tabs strip and submit page (Task 7); the lead-in
  flag (Task 9); the answered ground (Task 10); the work panel's frame (Task 13).
- `src/plugins/assistant.ts` — `/theme` (Task 5); the typing grace (Task 11); `/work`,
  the `work` keyAction and the picker's keys (Task 13).
- `src/assistant/command-panel.ts` — `PanelSpec.onCursor` (Task 5).
- `src/assistant/work-panel.ts` (new) — the picker's rows (Tasks 12–13).
- Tests: each task names its own files below.

## Task order

Tasks 1–3 (the fields) and Task 4 (the theme seam) are independent; Tasks 6→7→8 share
the wizard machine's interfaces and are done in order; Tasks 9–11 follow Task 8 (they
touch the ask paths it owns); Tasks 12→13 share the picker's rows. One branch per
ticket; the tasks of one ticket stack.

---

### Task 1: The `:` line caret (ticket 1)

**Files:**
- Modify: `src/config/commandline.ts` (`LineView`, `lineView`, `lineViewWithList`)
- Modify: `src/runtime/app.tsx` (`CommandLineState` ~197–210, `hostFallback` ~918–1105,
  the line's draw ~1346–1365)
- Test: `src/config/__tests__/commandline.test.ts`, `src/__tests__/commandline.e2e.test.ts`

**Interfaces:**
- Consumes: flowtty's `editorReducer(state: { value, cursor }, key, { multiline: false,
  width })` → `{ kind: 'edit', state } | { kind: 'submit' } | { kind: 'cancel' } | { kind: 'noop' }`
  — the exact call `src/assistant/ask.ts`'s typing branch makes.
- Produces: `CommandLineState` gains `caret: number`. `lineView(input: string,
  caret: number, walk: TabWalk | null, complete: Complete): LineView` and
  `lineViewWithList(input: string, caret: number, walk: TabWalk | null, state:
  ListState, complete: Complete): { view: LineView; list: CompletionList | null }`
  gain the `caret` parameter; `LineView` gains `caret: number`. The completion ghost
  is drawn only when `caret === input.length` (the chat field's rule).

- [ ] **Step 1: Write the failing tests**

In `src/config/__tests__/commandline.test.ts`: `the line view keeps a caret and ghosts
only at the end` — `lineView('config set', 6, null, complete)` carries `caret: 6` and
its ghost is empty; `lineView('config set', 10, null, complete)` keeps today's ghost.

In `src/__tests__/commandline.e2e.test.ts`: `a caret mid-line edits mid-line` — open
the `:` line, type `config et`, press `home`, `right` seven times, type `s` — the line
reads `config set` (inserted mid-line, not at the end); `backspace` — `config et`
(the inserted `s` was deleted from the middle); `home`, `delete` — `onfig et` (the
start is editable too).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/config/__tests__/commandline.test.ts src/__tests__/commandline.e2e.test.ts`
Expected: FAIL — `lineView` takes the old signature; the line ignores mid-line keys.

- [ ] **Step 3: Implement the caret in `commandline.ts` and `app.tsx`**

`CommandLineState.input` stays the string; the `:` handler in `hostFallback` edits
through `editorReducer` with `{ value: input, cursor: caret }` (single-line, the
line's width), like `ask.ts`'s typing branch: `edit` → new input+caret, `submit` →
run, `cancel`/`noop` → today's fallthrough. `backspace`/append-at-end idioms are
deleted. `↑`/`↓` history recall sets `caret = input.length`. The draw places a caret
cell at `caret` (inverse cell as the chat field draws it); the ghost rides the old
path but only at the end. Tab-walk (`lineTab`) replaces the whole line and puts the
caret at the end.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run typecheck && bun test src/config src/__tests__/commandline.e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/commandline.ts src/runtime/app.tsx src/config/__tests__/commandline.test.ts src/__tests__/commandline.e2e.test.ts
git commit -m "feat: a caret in the command line, mid-line editing"
```

### Task 2: The question field's caret (ticket 1)

**Files:**
- Test: `src/__tests__/ask-user.e2e.test.ts`
- Modify (only if the test fails): wherever it finds the swallow

**Interfaces:** none new — `askKey(state: AskState, key: AskKey, width = 60)` already
routes the typed field through `editorReducer`.

- [ ] **Step 1: Write the failing (if a bug) regression test**

`the arrows move the caret inside the free-text answer` — open an `ask_user` block,
press a printable key or the "Other…" row, type `abc`, press `left`, type `X`, assert
the field reads `abXc` (frame or the state) and the caret cell sits after `X`.

- [ ] **Step 2: Run it**

Run: `bun test src/__tests__/ask-user.e2e.test.ts -t "caret"`
Expected: PASS if the arrows already work (the ticket's suspicion unconfirmed) or FAIL
naming the key that never arrives.

- [ ] **Step 3: Fix only what the test proves broken**

If it fails: find who swallows `left`/`right` before `askKey` (the claim path in
`src/plugins/assistant.ts` ~2755, the arm window, or the tree/panel cursor) and make
the typed field's keys reach `askKey` first. Nothing else changes.

- [ ] **Step 4: Run and commit**

Run: `bun run typecheck && bun test src/__tests__/ask-user.e2e.test.ts`
Then `git add -A && git commit -m "fix: the caret moves inside the question's free-text answer"` (or, if the test passed as written, `test: the question field's caret is pinned`).

### Task 3: Suggestions only while typing (ticket 2)

**Files:**
- Modify: `src/plugins/assistant.ts` (the chat field's list ~2910–3037, `listRef`)
- Modify: `src/runtime/app.tsx` (`hostFallback`'s `↑`/`↓` and Tab paths; the `:` list)
- Test: `src/config/__tests__/commandline.test.ts`, `src/__tests__/prompt-history.e2e.test.ts`

**Interfaces:**
- Produces: one rule, two call sites — a history key (`↑`/`↓`) that changes the field's
  text sets a `fromHistory` ref; while it is set, the suggestion list is not opened
  (the inline ghost is drawn only from `lineView`/`openList` as before); the next
  content edit (`editorReducer` `edit` act from typing or paste) clears it. Tab-walk
  (`lineTab`), the list's own keys, and Esc are unchanged.

- [ ] **Step 1: Write the failing tests**

`src/config/__tests__/commandline.test.ts`: `a recalled line offers no list` — with
`fromHistory` set, `lineViewWithList` returns `list: null` though the recalled text
ends in a completable word; the next edit in the same harness reopens it.

`src/__tests__/prompt-history.e2e.test.ts`: `walking history never opens suggestions`
— a past `/mod` (two candidates) is recalled with `↑`: no list rows in the frame;
typing a character then shows them.

- [ ] **Step 2: Run to see them fail**

Run: `bun test src/config/__tests__/commandline.test.ts src/__tests__/prompt-history.e2e.test.ts`
Expected: FAIL — the recalled line opens its list today.

- [ ] **Step 3: Implement the rule**

The `fromHistory` marker lives beside each field's list state (the chat's `listRef`
path and the `:` line's `list` path); both suggestion call sites (`openList` callers)
pass it and skip the open while it is set. History navigation is the only setter of
the mark; an `edit` act is its only clearer.

- [ ] **Step 4: Run and commit**

Run: `bun run typecheck && bun test src/config src/__tests__/prompt-history.e2e.test.ts src/__tests__/completion-list.e2e.test.ts src/__tests__/field-completion.e2e.test.ts`
Expected: PASS — the completion tests still green.

```bash
git add -A && git commit -m "fix: walking history never opens suggestions"
```

---

### Task 4: `ui.theme` and the pinned scheme (ticket 3)

**Files:**
- Create: `src/playback/theme-mode.ts`
- Modify: `src/config/schema.ts` (the `ui` object ~154)
- Modify: `src/runtime/app.tsx` (the three palette-resolution sites ~402–404,
  ~507–520, ~565–575; the services block ~614–617)
- Test: `src/playback/__tests__/theme-mode.test.ts`, `src/__tests__/theme-mode.e2e.test.ts`

**Interfaces:**
- Consumes: `resolveAppTheme(configTheme, plugins, config, scheme)` and
  `type ColorScheme = 'light' | 'dark' | 'unknown'` (`src/playback/theme.ts`);
  `backend.setColorScheme(scheme, bg)` and the `color-scheme.e2e.test.ts` cell-style
  idiom (`ui.backend.lastBuffer!.get(x, y).style`).
- Produces: `src/playback/theme-mode.ts` —
  `type ThemeMode = 'system' | 'light' | 'dark'`,
  `const THEME_MODES: readonly ThemeMode[]`,
  `parseThemeArg(arg: string): ThemeMode | { error: string }`,
  `schemeFor(mode: ThemeMode, terminal: ColorScheme): ColorScheme` (a pinned mode
  answers its own scheme; `system` answers the terminal's).
  Config: `ui.theme?: ThemeMode` (no mark, applied live). Service:
  `host.services.setThemeMode(mode: ThemeMode): void` — stores the pinned mode and
  re-resolves `config.theme` in place exactly as the terminal-scheme path does.

- [ ] **Step 1: Write the failing tests**

`src/playback/__tests__/theme-mode.test.ts`: `schemeFor pins and follows` —
`schemeFor('light', 'dark') === 'light'`, `schemeFor('dark', 'light') === 'dark'`,
`schemeFor('system', 'dark') === 'dark'`, `schemeFor('system', 'unknown') ===
'unknown'`; `parseThemeArg` takes the three words, refuses a fourth with the three
words in the error.

`src/__tests__/theme-mode.e2e.test.ts`: `a pinned scheme survives a terminal flip` —
boot with `opts.scheme: 'unknown'`, call `setThemeMode('light')`: the chat window's
cell style matches a light palette; then `backend.setColorScheme('dark', '#000000')`
and settle: the style is STILL light. `setThemeMode('system')` and the flip takes
effect again.

- [ ] **Step 2: Run to see them fail**

Run: `bun test src/playback/__tests__/theme-mode.test.ts src/__tests__/theme-mode.e2e.test.ts`
Expected: FAIL — no `theme-mode.ts`, no `setThemeMode`.

- [ ] **Step 3: Implement**

`theme-mode.ts` is pure (the four exports above). In `app.tsx` one `pinnedScheme:
ThemeMode | null` starts from `config.ui?.theme ?? 'system'`; everywhere the code
today asks the terminal for `scheme` it asks
`schemeFor(pinnedScheme ?? 'system', terminalScheme)` instead — the boot site, the
`rebuildFromPlugins` site, and the `useColorScheme` effect. `setThemeMode` sets
`pinnedScheme` and re-resolves `config.theme` **in place** (the delete-keys +
`Object.assign` the existing sites do; never a fresh object — a plugin may hold a
reference), then `host.notify()`. `ui.theme` is an ordinary live key: `config set
ui.theme light` applies at once through `setConfigValue`'s non-restart path, so that
path must also reach the same re-resolution (one shared helper, not two).

- [ ] **Step 4: Run the full suite**

Run: `bun run typecheck && bun test ./src ./scripts ./packages`
Expected: PASS (the existing `color-scheme.e2e` and `session.test.ts:88` guard rails
must stay green).

- [ ] **Step 5: Commit**

```bash
git add src/playback/theme-mode.ts src/config/schema.ts src/runtime/app.tsx src/playback/__tests__/theme-mode.test.ts src/__tests__/theme-mode.e2e.test.ts
git commit -m "feat: ui.theme pins the colour scheme, applied live"
```

### Task 5: `/theme` and the live-preview panel (ticket 3)

**Files:**
- Modify: `src/assistant/command-panel.ts` (`PanelSpec`)
- Modify: `src/plugins/assistant.ts` (`CHAT_COMMAND_DEFS` ~102, `runChatCommand` ~1776,
  `panelStep` ~1740, the mouse row-pick ~3251)
- Test: `src/assistant/__tests__/command-panel.test.ts`, `src/__tests__/theme-command.e2e.test.ts`
- Docs (same commit): `docs/usage.md` (`/theme` page), `CHANGELOG.md`

**Interfaces:**
- Consumes: `PanelSpec`/`panelKey`/`panelStep` (`src/assistant/command-panel.ts`, the
  `/model` case at `src/plugins/assistant.ts:1823–1864` as the pattern);
  Task 4's `THEME_MODES`, `parseThemeArg`, `host.services.setThemeMode`.
- Produces: `PanelSpec` gains `onCursor?: (id: string, index: number) => void`, called
  from `panelStep` after a cursor move and from the mouse row-pick after the cursor
  changes (additive — no HOST_API bump; `docs/plugins.md` untouched, the ctx shape
  does not change). `CHAT_COMMAND_DEFS` gains `{ name: 'theme', values: () =>
  ['system', 'light', 'dark'], description: … }` with `history: false` (a chosen
  theme is not worth recalling).

- [ ] **Step 1: Write the failing tests**

`command-panel.test.ts`: `onCursor runs as the cursor moves` — a spec with
`onCursor`, `panelKey` `down` calls it with the new row's id once; `up` at the top
does not.

`theme-command.e2e.test.ts`: `the theme menu previews and decides` — `/theme` opens
the panel over the chat (frame shows `system`, `light`, `dark`, the current marked);
`down` on `light` repaints the cell style at once (the `theme-mode.e2e` idiom); `up`
back to `system` repaints again; `escape` — the look is the one at open and
`config.local.json` holds no `ui.theme`; reopened, `down`, `return` — the look stays
and `ui.theme` is saved. Also `the theme command applies its argument` — `/theme
dark` paints dark, saves, and says one `note` row; `/theme blue` refuses listing the
three words.

- [ ] **Step 2: Run to see them fail**

Run: `bun test src/assistant/__tests__/command-panel.test.ts src/__tests__/theme-command.e2e.test.ts`
Expected: FAIL — no `onCursor`, no `/theme`.

- [ ] **Step 3: Implement**

`onCursor` in `command-panel.ts` beside `panelKey`'s cursor moves (and the chat's
`onPickRow`); it may not disturb `PanelStep`'s `run` path — preview is observation,
never a decision. The `case 'theme'` in `runChatCommand` mirrors `case 'model'`:
with an arg — `parseThemeArg`, then `setThemeMode` + save + `note`; bare —
`openPanel({ title: 'Theme', rows: () => THE THREE ROWS, onCursor: (id) =>
setThemeMode(id as ThemeMode), keys: [{ key: 'return', label: 'use', run: (id) =>
save(id) }] })`, and the panel's Esc restores the mode the panel opened with (list
what that was in the closure). Saving goes through the config path (`config set
ui.theme` semantics: `config.local.json`, live). The mark "current" is the row the
saved mode names.

- [ ] **Step 4: Run the full suite**, `bun run typecheck && bun test ./src ./scripts ./packages`, expected PASS.

- [ ] **Step 5: Commit** (code + `docs/usage.md` + `CHANGELOG.md` `## Unreleased` line)

```bash
git add -A && git commit -m "feat: /theme picks the look with the theme applied as the cursor moves"
```

---

### Task 6: The wizard machine in `ask.ts` (ticket 4)

**Files:**
- Modify: `src/assistant/ask.ts`
- Test: `src/assistant/__tests__/ask.test.ts`

**Interfaces:**
- Consumes: flowtty's `editorReducer` (as today), `AskQuestion`/`AskOption`/`AskAnswer`
  unchanged.
- Produces (Tasks 7–8 rely on these exact shapes):
  ```ts
  export interface AskDraft { cursor: number; picked: number[]; typing: boolean; text: string; caret: number }
  export interface AskState {
    questions: AskQuestion[];
    index: number;          // the page on screen; for n>1, page n is the submit page
    drafts: AskDraft[];     // one per question
    answers: AskAnswer[];   // filled at submit; askResult/askShown read it
    done: boolean;
    cancelled: boolean;
  }
  export const askPageCount = (s: AskState): number  // n>1 → n+1, else n
  export interface AskTab { label: string; answered: boolean; current: boolean }
  export function askTabs(state: AskState): AskTab[] // n>1 only; last tab is "Submit"
  export interface AskSubmitRow { title: string; answer: string }
  export function askSubmitRows(state: AskState): AskSubmitRow[]  // the submit page
  ```
  Unchanged surfaces: `askStart`, `parseAskArgs`, `askRows` (reads
  `state.drafts[state.index]`), `askKey(state, key, width = 60)`, `askResult`,
  `askShown`, `AskRow`, `AskKey`, `AskShown`.
- New wording inside existing writers: `askResult` prints `- <question> → no answer
  given` for a submitted entry with no labels and no other; `askShown` prints
  `(not answered)` for one. The dismissal wording is untouched.

- [ ] **Step 1: Write the failing tests** (in `src/assistant/__tests__/ask.test.ts`)

- `a single-question call answers in one key` — `askStart` with one 3-option
  question, `askKey` on `1` → `done`, `answers[0].labels` `['one']`; an empty
  free-text Enter answers nothing (`done: false`) as today.
- `a two-question call keeps each page's draft` — two questions; answer q1 with
  digits; on q2 open "Other…", type `abc`, press `left` (`→` page key is `right`;
  from inside typing the arrow moves the caret — leave typing via Esc first, then
  `left`), go back to q1: its pick stands; return to q2: text `abc` and the caret
  where they were left.
- `a content key on a page with a draft inserts, never replaces` — the page above,
  typed key `X` resumes typing and the text reads `abXc`.
- `the submit page sends the last state of every draft` — change q2's text on the
  second visit (replace `abc` with `rst`), reach the submit page
  (`askPageCount() - 1`), `askSubmitRows` shows q1's pick and `(not answered)`-
  free `rst` for q2, and pressing `return` (`done: true`) leaves
  `askResult(state)` carrying `rst`, not `abc`.
- `an unanswered question reads no answer given` — reach the submit page without
  touching q2; `askResult` holds `- <q2> → no answer given`; `askShown[1].answer` is
  `(not answered)`.
- `page keys do not fight the field` — while `typing`, `left`/`right` change the
  caret, not the page; on the first/last page `left`/`right` clamp (no wrap).

- [ ] **Step 2: Run to see them fail**

Run: `bun test src/assistant/__tests__/ask.test.ts`
Expected: FAIL — `drafts`, `askPageCount`, `askTabs`, `askSubmitRows` do not exist;
`answer()` still finishes on the last question.

- [ ] **Step 3: Implement the machine in `ask.ts`**

`answer()` becomes `commit` + `advance`: a commit writes the page's draft; advancing
beyond the last question lands on the submit page. `done` rises only on the submit
page's Enter (`answers` built there, one entry per question in order, empty ones
included) or, for `n === 1`, exactly today's behaviour. Page movement: `left`/`right`
when `!typing`. A content key (printable, not `0–9` shortcut keys while a list page
has rows, or a paste) on a page with non-empty `text` sets `typing: true` and inserts
at `caret`; with empty `text` it opens the field with the key in it (today). `Esc`
while `typing` leaves the field (a free-text question dismisses, as today); `Esc`
otherwise sets `done + cancelled`. Everything is one-page-safe: `n === 1` keeps every
key of today (digits answer at once; `askKey(' ')` toggles multiSelect).

- [ ] **Step 4: Run the whole ask suite and commit**

Run: `bun run typecheck && bun test src/assistant`
Expected: PASS (old ask tests still green — `askResult`/`askShown` surfaces kept).

```bash
git add src/assistant/ask.ts src/assistant/__tests__/ask.test.ts
git commit -m "feat: the ask wizard keeps every draft until the submit page"
```

### Task 7: Drawing the wizard (ticket 4)

**Files:**
- Modify: `src/views/modals.ts` (`askView` ~2768, `renderAsk` ~2867, `askBlockRows`
  ~2848)
- Test: `src/views/__tests__/modals.test.ts`

**Interfaces:**
- Consumes: Task 6's `AskState`, `askTabs`, `askSubmitRows`, `askRows`.
- Produces: the ask view model gains `tabs: AskTab[]` and `submitRows:
  AskSubmitRow[] | null`; `askBlockRows` counts the new rows so the bottom panel and
  the window keep row arithmetic right.

- [ ] **Step 1: Write the failing tests** (`src/views/__tests__/modals.test.ts`)

`the ask box draws the tabs strip and the submit page` — a two-question state renders:
the strip row with both headers, the current inverse, `✓` on the answered one; the
submit page renders each question's title dim with its answer under it at full ink
and `(not answered)` dim where empty; the hint rows read `←→ questions · ↑↓ move · ⏎
answer · type your own words · ⎋ dismiss` and `←→ questions · ⏎ submit · ⎋ dismiss`
(drawn with `keyGlyph` caps, asserted as glyphs as `modals.test.ts` already does).

- [ ] **Step 2: Run to see it fail**, `bun test src/views/__tests__/modals.test.ts`, expected FAIL (no tabs strip).

- [ ] **Step 3: Implement the drawing**

The box keeps its shape; the strip sits under the title (`n > 1` only), each tab
`✓ <header || "question N">` cut to the box width with `cutStep`/`cellWidth`. The
submit page replaces the option list. The one-question box is byte-for-byte what it
is today.

- [ ] **Step 4: Run and commit**

Run: `bun run typecheck && bun test src/views`
Then `git add -A && git commit -m "feat: the question box draws its pages and the submit page"`.

### Task 8: The wizard in the chat, and the item-2.2 verification (ticket 4)

**Files:**
- Modify: `src/plugins/assistant.ts` (the question key path ~2755 only if a key must
  reach the pages: `left`/`right` already flow to `askKey`)
- Test: `src/__tests__/ask-user.e2e.test.ts`
- Docs (same commit): `docs/internal/agents/ask-children-spec.md`,
  `docs/internal/agents/chat-spec.md`, `docs/usage.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `conversation.answerQuestion`/`setQuestion` (unchanged: `askKey`'s
  `done` now means "submitted or dismissed", the rows come from `askShown`, one per
  question); Task 6's shapes.

- [ ] **Step 1: Write the failing tests** (`src/__tests__/ask-user.e2e.test.ts`)

- `a two-question call walks pages and submits once` — scripted `ask_user` with two
  questions; the frame shows the strip; `1` answers q1 and moves; `right`, `left`,
  change the pick to `2` (the last state wins); `right` `right` to the submit page;
  `return`; kept rows show both final answers; the tool result in the model's history
  is sent ONCE and says `The user answered:` with q1's second pick. Before `return`
  the call is still pending (nothing of it in the tool trail, as today).
- `a multi-select question sends every pick` (item 2.2) — space toggles two rows,
  `return` commits; the result lists both labels.
- `the digits and the person's own words both answer` (item 2.2) — `2` answers by
  label in one key (single question); typing `my own` + `return` sends `(their own
  words) my own`.
- `Esc dismisses the whole call` — from a page and from the submit page; the result
  is the dismissal wording and the kept rows read `dismissed`.

- [ ] **Step 2: Run to see them fail**, `bun test src/__tests__/ask-user.e2e.test.ts`, expected FAIL on the new names.

- [ ] **Step 3: Implement and pin the docs**

Whatever glue the e2e proves missing (the chat already runs every key to `askKey`;
likely nothing beyond `askShown`'s per-question rows order). Then the same-commit
docs: `ask-children-spec.md` — the wizard's page model and "submit is the answer";
`chat-spec.md` — the block's strip row and the fact a dismissal is not consent;
`docs/usage.md` — answering several questions page; `CHANGELOG.md` `## Unreleased`.

- [ ] **Step 4: Run the full suite and commit**

Run: `bun run typecheck && bun test ./src ./scripts ./packages`
Expected: PASS.

```bash
git add -A && git commit -m "feat: several questions are walked page by page and answered at a submit page"
```

---

### Task 9: The readable lead-in above a pending question (ticket 5)

**Files:**
- Modify: `src/views/modals.ts` (`buildMessageRows` ~728–960: the run folding ~856–871,
  the `quiet` rule ~879/1120)
- Modify: `src/plugins/assistant.ts` (`rowOpts()` ~682)
- Test: `src/views/__tests__/modals.test.ts`
- Docs (same commit): `docs/internal/agents/chat-spec.md` ("Where the eye is left" or
  the turn-drawing section, as fits), `CHANGELOG.md`

**Interfaces:**
- Produces: the row options of `buildMessageRows` gain `askPending?: boolean`
  (display only). When it is set, the step rows of the **last run** — the run of
  consecutive steps immediately before the `ask_user` call — draw unfolded and not
  dim (`quiet: false`); every other run, all reasoning blocks and all other rows keep
  today's look. The fold machinery (`src/assistant/folds.ts`) is untouched: this is a
  display condition, not fold state.
- The flag is passed while `conv.question` is pending and cleared the moment it is
  answered (the same predicate the field-place block uses).

- [ ] **Step 1: Write the failing test** (`src/views/__tests__/modals.test.ts`)

`the run before a pending question draws open and lit` — a message model of a turn
with two step runs and an `ask_user` call (a `tools` segment) after the second:
without `askPending` both runs are folded dim rows; with `askPending: true` the
second run's step rows appear in full and at full ink while the first run stays one
dim folded row. A `reasoning` block beside them stays folded and dim.

- [ ] **Step 2: Run to see it fail**, `bun test src/views/__tests__/modals.test.ts -t "lead"`, expected FAIL.

- [ ] **Step 3: Implement** — the flag threaded into the one place that decides a
  run's `quiet` and fold: `askPending && runIsLastBeforeAsk` lifts both. The `✎`
  diff blocks and the answer rows are untouched.

- [ ] **Step 4: Run and commit** (`bun run typecheck && bun test src/views`, then
  `git add -A && git commit -m "feat: the narration that leads into a question reads at full ink while it waits"`).

### Task 10: The answered-question ground (ticket 6)

**Files:**
- Modify: `src/playback/theme.ts` (`MODAL_COLOR_DEFAULTS` ~135, `LIGHT_MODAL_COLORS`
  ~160, `UNKNOWN_MODAL_COLORS` ~164, the `chat` palette)
- Modify: `src/views/modals.ts` (the `role: 'ask'` rows ~924–933, ~1021–1022)
- Test: `src/views/__tests__/modals.test.ts`, `src/playback/__tests__/theme.test.ts`
- Docs (same commit): `docs/config.md` (the new tokens, as other chat palette keys
  are listed), `CHANGELOG.md`

**Interfaces:**
- Produces: two tokens on `theme.modals.chat`: `askBg`, `askInk`, present in all three
  palettes and drawn as `${askBg}`/`${askInk}`. A kept `? …` / `→ …` row paints them
  across the message column's width; the question row keeps its `?` gutter and the
  answer its `→`; a dismissed answer keeps the ground and dims its ink. A person's
  `theme` key overrides either token like any other.

- [ ] **Step 1: Write the failing tests**

`theme.test.ts`: `the ask ground lands in every palette` — `modalColorDefaults` for
`light`/`dark`/`unknown` each carry `askBg` and `askInk` under `chat`.

`modals.test.ts`: `answered question rows carry the ask ground` — a message model
with two `role: 'ask'` rows (one answered, one dismissed) draws both with the
`askBg` ground across the column, the answer of the dismissed one dim on `askInk`.

- [ ] **Step 2: Run to see them fail**, `bun test src/views/__tests__/modals.test.ts src/playback/__tests__/theme.test.ts`, expected FAIL.

- [ ] **Step 3: Implement** — the tokens beside `chat.userBg` in the three palettes
  (pick values that read as a quiet tint against `bg`, stated in the palette
  comments); the rows' span styles take them like `userBg` is taken for the person's
  rows (the row cache key already folds the palette in — `modals.ts` ~628).

- [ ] **Step 4: Run and commit** (`bun run typecheck && bun test src ./src/playback`, then `git add -A && git commit -m "feat: an answered question keeps a ground of its own in the transcript"`).

### Task 11: The typing grace (ticket 7)

**Files:**
- Modify: `src/assistant/child-ask-guard.ts` (add `ASK_GRACE_MS = 600` beside
  `ASK_ARM_MS`, sharing `askClock`)
- Modify: `src/plugins/assistant.ts` (the question claim path ~2604–2763, the status
  line ~2447–2450)
- Test: `src/__tests__/ask-grace.e2e.test.ts` (new, on the `helpers/scripted.ts`
  rig)
- Docs (same commit): `docs/internal/agents/ask-children-spec.md` (the guard section),
  `CHANGELOG.md`

**Interfaces:**
- Produces: the rule — when a question parks (the session's own `ask_user`, or a
  child's question routed to the person), the block takes the keyboard only when the
  last key the person pressed is older than `ASK_GRACE_MS` (600, `askClock`) **and**
  no `:` line is open. While held: the field keeps every key (each key re-arms by
  stamping `lastKeyAt`), the block is not drawn in the field place, and the
  collapsed/strip status reads `? a question is waiting`. A one-shot timer
  (`setTimeout(…, ASK_GRACE_MS)`, unref'd like every plugin timer) re-runs the claim
  check when the person goes quiet and calls `host.notify()`. The existing claim path
  (its `ASK_ARM_MS` swallow window) runs unchanged after the grace. Enter during the
  grace sends the draft normally.

- [ ] **Step 1: Write the failing tests** (`src/__tests__/ask-grace.e2e.test.ts`)

- `a question waits while the person types` — type into the field (keys stamp
  `askClock`), park a question with the clock near the last key: the field still
  shows the draft and the status reads `? a question is waiting`; a key typed now goes
  to the draft; move `askClock` past `ASK_GRACE_MS` and settle: the question block is
  up and takes the keys.
- `an open command line holds the keys over a waiting question` — open `:`, type
  `config`, park a question: no takeover at any time; `return` runs the line; then,
  past the grace, the block takes over with the `:` line's text gone as today.
- `a question parks at once when nobody is typing` — no keys within the grace, no
  draft: the block is up immediately (the current behaviour, pinned so the grace
  never delays the idle case).

- [ ] **Step 2: Run to see them fail**, `bun test src/__tests__/ask-grace.e2e.test.ts`, expected FAIL (the takeover is immediate today).

- [ ] **Step 3: Implement** — the `lastKeyAt` stamp beside the key handler's entry
  (counting keys the chat takes, as `child-ask-guard`'s `note()` does), the hold
  predicate, the status wording, the one-shot timer. No answering rule changes; the
  y/n confirm keeps its own `ownArmedAt` and does not gain a grace.

- [ ] **Step 4: Run the ask-family suite and commit**

Run: `bun run typecheck && bun test ./src/__tests__/ask-grace.e2e.test.ts ./src/__tests__/ask-user.e2e.test.ts ./src/__tests__/subagent-ask.e2e.test.ts ./src/assistant/__tests__/child-ask-guard.test.ts`
Expected: PASS.

```bash
git add -A && git commit -m "feat: a question waits out the sentence the person is typing"
```

---

### Task 12: The work picker's rows (ticket 8)

**Files:**
- Create: `src/assistant/work-panel.ts`
- Test: `src/assistant/__tests__/work-panel.test.ts`

**Interfaces:**
- Consumes: nothing but pure data (the picker maps the real registries in).
- Produces:
  ```ts
  export interface WorkSub { key: string; path: readonly string[]; state: string; asking: boolean; title?: string }
  export interface WorkJob { id: string; command: string; state: string; owner: string }
  export interface WorkRow { id: string; group: 'subagents' | 'shells'; text: string; detail?: string; tone?: 'ok' | 'warn' | 'error' }
  export function workRows(subs: readonly WorkSub[], jobs: readonly WorkJob[], now?: number): WorkRow[]
  ```
  Row shape: a subagent's `text` is its label path joined ` › `; its `detail` is its
  state (`running`, `waiting for you — <title>`, `ended — <verdict>`); `asking` makes
  the row `tone: 'warn'` and its detail `? waiting for you`. A shell's `text` is
  `<id> · <command>` (command cut to the row width by the renderer, not here), its
  `detail` `<state> — <owner>`. Ids are `sub:<key>` / `shell:<id>`. Shells follow
  subagents; ended jobs sit after running ones of their group.

- [ ] **Step 1: Write the failing tests** (`src/assistant/__tests__/work-panel.test.ts`)

`rows group subagents and shells` — a mix in produces subagents first, `sub:`/`shell:`
ids; `a waiting subagent warns` — `asking: true` → `tone: 'warn'` and the `? waiting
for you` detail; `ended shells sink below running ones` (order by `state`).

- [ ] **Step 2: Run to see them fail** (`bun test src/assistant/__tests__/work-panel.test.ts`), expected FAIL (no module).

- [ ] **Step 3: Implement** the pure mapping (no clock math beyond `now` pass-through
  into detail wording).

- [ ] **Step 4: Run and commit** (`bun test src/assistant`, then
  `git add src/assistant/work-panel.ts src/assistant/__tests__/work-panel.test.ts && git commit -m "feat: the work picker's rows"`).

### Task 13: The work picker itself (ticket 8)

**Files:**
- Modify: `src/plugins/assistant.ts` (the `keys` table ~213, `CHAT_COMMAND_DEFS` ~102,
  `runChatCommand` ~1776, the key dispatch where the panel/picker hold keys ~2831)
- Modify: `src/views/modals.ts` only if the group headers need a row style
- Test: `src/__tests__/work-picker.e2e.test.ts` (new)
- Docs (same commit): `docs/internal/agents/shell-jobs-spec.md` (the picker's shell
  rows), `docs/internal/agents/chat-spec.md` (if the key-holding order is pinned
  there), `docs/usage.md`, the help text where the keys are listed, `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 12's `workRows`/`WorkRow`; `treeRows`/`nodeState`/`stopQuestion`
  (`src/assistant/agent-tree.ts`) to map `TreeNode[]` → `WorkSub[]`; `ShellJobs`/
  `ShellJob`/`jobLine` (`src/assistant/shell-job.ts`) for `WorkJob[]` and the kill
  path; the existing watch mechanism (`Watching`, `src/assistant/watch.ts`) to open a
  subagent's rows; `PanelSpec`/`panelKey` (`src/assistant/command-panel.ts`) as the
  container unless the builder chose a dedicated machine ("Left to the builder").
- Produces: keyAction `work` in the plugin's `keys` table (default one capital — `J`
  if free after checking the bindings registry and the help page; else another free
  capital) and `/work` in `CHAT_COMMAND_DEFS` (`history` default kept).

- [ ] **Step 1: Write the failing tests** (`src/__tests__/work-picker.e2e.test.ts`)

- `the picker opens on its key and shows both groups` — with a running subagent and a
  background shell (`helpers/scripted.ts` starts one), press the `work` binding: the
  frame shows `Subagents` and `Shells` group headers and one row each; the key caps
  hint (glyphs) at the bottom; Esc closes; `/work` opens the same panel.
- `enter opens what is under the cursor` — on a subagent row: the picker closes and
  the watch is on (its rows in place of the list, `Esc` back to the chat); on a shell
  row: its output pager is up over the kept tail.
- `ctrl+d kills a shell after its own y/n` — `ctrl+d` shows the picker's confirm;
  `n` cancels (job alive); `ctrl+d`, `y` — the job ends (`JobKilledBy: 'person'`) and
  the row state follows.
- `enter on a waiting subagent lands on its request` — a child with a parked question:
  Enter closes the picker and the request block takes the keyboard.

- [ ] **Step 2: Run to see them fail** (`bun test src/__tests__/work-picker.e2e.test.ts`), expected FAIL (no `work` action, no `/work`).

- [ ] **Step 3: Implement** the panel: one list, group-header rows (`id: 'group:…'`,
  dim, no key run), rows from `workRows`; keys `return` and `ctrl+d` as above; the
  panel holds every key while drawn (like `/model`'s). The waiting subagent's Enter
  uses `offered()`/`stopQuestion` to find the block the keyboard should land on. The
  shell output is a pager over the job's kept buffer (the run_command view's frame
  reused verbatim unless a builder call says otherwise); the kill goes through the
  job registry's own kill (never a shell string). Help lists `work` and `/work`; the
  usage page shows the picker.

- [ ] **Step 4: Run the full suite and commit**

Run: `bun run typecheck && bun test ./src ./scripts ./packages`
Expected: PASS.

```bash
git add -A && git commit -m "feat: the work picker — subagents and shells in one place"
```

---

## Execution notes

- An executor works the tasks in order, ticking each step as it lands and committing
  at each task's commit step (the message is named there).
- GitHub issues: one per ticket (1–8 in "Work breakdown"), created after this plan is
  confirmed; the child-question follow-up noted in Non-goals goes into
  `docs/internal/plans/_followups.md`.
