# Chat activity groups & a bright steer answer — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a message steered in mid-turn gets a bright `→`-marked answer, and the chat's
activity between two bright rows folds into one collapsible line with per-kind counts and
levelled expansion, as opencode does.

**Architecture:** the data change is one field — `ChatMsg.midTurn`, set where a queued
message is delivered mid-turn (the same site that journals `midTurn: true`). Everything
else is renderer work in `src/views/modals.ts`: rows learn `steerAnswer`, flat rows get
split into activity groups at every non-groupable row, and a group carries one collapsed
summary line whose members are themselves collapsible record rows. No view of the
conversation's data changes outside the renderer.

**Tech Stack:** TypeScript (strict), React/inflow-style TUI (`@flowtty/*`), Bun tests
(`bun test`, `TestBackend` frame assertions).

**Spec:** `~/Developer/mellonis-workspace/flowtty-things/docs/flow-assist-chat-groups-design-2026-11-21.md`
— the plan argues from the spec; executors read both.

## Global Constraints

- Gutter is two cells (`GUTTER` in `modals.ts`); every new mark (`→`) keeps that column.
- `ƒ` stays unique to the turn's answer — no second `ƒ` anywhere (an existing
  `ƒ Ran N commands` head is retired in Task 4, not reused).
- An answer to a mid-turn-delivered message is `→ ` on its first row and plain bright on
  the rest; the turn's own last text keeps `ƒ` and is never also `→`.
- A non-dim row (`›`, `ƒ`, `→`, `◆`, `✎` change title, a dim `hostAsk`) ends the group
  that precedes it. Nothing of the person's, and nothing waiting on the person, is ever
  hidden inside a collapsed group.
- Narration (the model's step text that answers nothing) is dim inside a group: not a
  record line, not counted in the group's label, not a group break.
- Comments and UI strings in English, present tense, describing the code as it is.
- Conventional commits (`feat:` …); the doc/CHANGELOG entry for a behaviour lands in the
  same commit as the code that makes it true.
- Suite gate per task: `bun run typecheck && bun test ./src ./scripts ./packages` — the
  task's own focused files must be green; the known pre-existing failures elsewhere do not
  grow.

## Review Focus

- A group never swallows a bright row: with a `→` answer or `ƒ` answer inside a stretch,
  both the summary line that precedes and the summary line that follows show their own
  counts; the bright rows stay visible collapsed — pinned in Task 1 & Task 2.
- A steer the model answers by ending the turn there: that text carries `ƒ`, not `→` —
  pinned in Task 1.
- A live group shows a canned busy line and a spinner while anything inside runs, and
  repaints as items finish — pinned in Task 2.
- A failed or interactive console block keeps `✗`, `✎`, `‼` on its collapsed record line
  and on the collapsed group's line — pinned in Task 3 & Task 4.
- `✎ path · +N −M` change titles are bright, so a write-heavy run splits into several
  short groups; the groups still contain their own tool calls — pinned in Task 2.

---

### Task 1: `midTurn` on a delivered message, and the `→` bright steer answer

**Files:**
- Modify: `src/assistant/conversation-types.ts` — `ChatMsg` gains `midTurn?: boolean`.
- Modify: `src/assistant/conversation-turn.ts:360-363` — the row push for mid-turn-delivered
  queued messages sets `midTurn: true`, mirroring the `midTurn: true` journal line two
  lines above.
- Modify: `src/views/modals.ts` — `ChatRow` gains `steerAnswer?: boolean`; `buildMessageRows`
  (`:750`) marks the steer's answer rows and draws them bright; `drawRow`/`gutter`
  (`:1026-1060`) draws `→ ` the way `askAnswer` draws it (`:1048`).
- Test: `src/__tests__/queue-mid-turn.rig.test.ts` (existing file for this boundary),
  `src/views/__tests__/modals.test.ts`.

**Interfaces:**
- Consumes: `ChatMsg` rows as they already reach the renderer; `rowOpts` unchanged.
- Produces: `ChatRow.steerAnswer?: boolean` (true only on the first row of the steer's
  answer); `ChatMsg.midTurn?: boolean` — all later tasks read it.

**Rules (from the spec's "Rows and marks", verbatim in effect):**
The steer's answer is the LAST text written after the mid-turn-delivered message and
before either the turn's answer or the person's next message. One mark per steer. The
turn's own last text is `ƒ`, never `→`. Narration before the answer's text (`Смотрю.`,
`щас гляну`) stays `quiet`.

- [ ] **Step 1: Write the failing tests**

In `src/views/__tests__/modals.test.ts`, three tests with these names and content:

```ts
test('a message steered in mid-turn gets the answer mark on the last text before the turn settles', () => {
  // build: user(midTurn) , assistant message with live=false, parts = [run(tool), run(text "Смотрю."), run(tool), run(text "Ответ на вопрос.")), answer content "Итог"]
  // frame assertions: a row `→  Ответ на вопрос.` exists (marker + text), no `→ ` on `Смотрю.`, and the frame's answer row still starts `ƒ `
});
test('a steer answered by ending the turn there keeps ƒ and gets no →', () => {
  // build: user(midTurn), assistant message whose LAST text is the steer's answer (no later tool run)
  // frame assertions: that text row starts `ƒ `, and no row contains `→ `
});
test('a dim hostAsk row does not join the steer answer', () => {
  // build: user(midTurn) followed by the host ask row shape Modals draws for `hostAsk`
  // frame assertions: no `→ ` anywhere
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/views/__tests__/modals.test.ts -t "steer"`
Expected: FAIL — no `→` mark exists, rows come out `quiet`.

- [ ] **Step 3: Implement the mark**

`ChatMsg.midTurn?: boolean` (comment: present tense, "a queued message delivered mid-turn").
In `conversation-turn.ts` the queued-message row push becomes
`now.map((m): ChatMsg => ({ role: 'user', content: m.text, midTurn: true }))`.

In `buildMessageRows`, for each message: find the last `role === 'assistant'` message
after a `midTurn` user row and before the turn's answer/next user row, take its last text
run with no `steerAnswer`-unfriendly case per the Rules, and set `steerAnswer: true` on
its first row and draw its rows unquiet. Share one helper with the `lead` path
(`modals.ts:850`): `leadRun` currently sets `lead` when `o.askPending && lead`; a steer's
answer is the same "this text is for the person" fact, so the two join as one predicate
deciding which rows are not `quiet`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/views/__tests__/modals.test.ts`
Expected: PASS (new tests green, existing tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/assistant/conversation-types.ts src/assistant/conversation-turn.ts src/views/modals.ts src/views/__tests__/modals.test.ts
git commit -m "feat: a steered-in message's answer is bright and marked →"
```

---

### Task 2: Activity groups — one collapsible line per dim stretch

**Files:**
- Modify: `src/views/modals.ts` — after `rowsPerDrawn`/`buildMessageRows` produce their
  `ChatRow[]`, split into groups and render the collapsed summary row.
- Test: `src/views/__tests__/modals.test.ts` (grouping lives in the same render).

**Interfaces:**
- Consumes: `ChatRow` from Task 1 (with `steerAnswer`, `quiet`, `step`, `toolRun`,
  `reason`, `consoleMark`, `role`, `gap`).
- Produces: `ChatRow.group?: { id: string; counts: GroupCounts; durationMs?: number; busy?: boolean; marks: string }` set on ONE summary row standing where the group begins; `GroupCounts = Record<'command'|'read'|'edit'|'tool'|'thought', number>`.

**Rules (from the spec's "Groups", in effect):**
A group is a maximal run of consecutive rows that are dim and belong to the work —
`quiet` step text of any kind, `toolRun` call rows, `reason` thought rows, console block
rows, and `gap` rows inside such a stretch. One groupable `gap` never opens a new group
and never ends one. A row that is bright, or a `hostAsk`, ends the group before it. Counts
follow opencode's grammar from `activity-summary.ts`: `command` (`run_command` and console
blocks), `read` (`read_file`, `list_dir`), `edit` (writes/edits), `tool` (the rest),
`thought`; rendered `N X` singular/plural, joined `", "`, plus ` · <duration>` from the
stretch's own times when any, plus the worst marks inside (`✗`, `✎`, `‼`) as a run's fold
line already does.

- [ ] **Step 1: Write the failing tests**

In `src/views/__tests__/modals.test.ts`:

```ts
test('a stretch of dim rows collapses to one line counting its tools and thoughts', () => {
  // build: assistant message with parts [thought body, tool, tool, thought body, tool] and answer text
  // frame: one line `▸ + 2 thoughts, 3 tools` (opencode's fixed kind order: command, edit, thought, read, tool) and NOT the individual call rows
  // after the toggle the members are visible again
});
test('a bright row ends the group that precedes it and the next dim row starts a new one', () => {
  // build: dim run, user row, dim run with a steer answer marked, dim run
  // frame: the summary before the user row counts only its own members; the one after counts only the ones after the bright rows
  // and the same for an `✎ path · +N −M` change title in the middle: two short groups, neither hides the title row
});
test('a group with a live item shows a busy line with a spinner while it runs', () => {
  // build: message with `live: "..."` inside the stretch (m.live) and one running tool (view record phase live)
  // frame: summary line ends in the running item's wording (opencode's "Running X…" rule) and has no `+` counts while busy
});
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `bun test src/views/__tests__/modals.test.ts -t "collapses to one line"`
Expected: FAIL — today's rows show `▸ N tools: …` and a `thought` header instead.

- [ ] **Step 3: Implement the grouping**

Pure helpers next to `buildMessageRows` in `modals.ts` (no new module; the file already
owns row construction):
- `groupableRow(r: ChatRow): boolean` — the membership list above.
- `splitGroups(rows: ChatRow[]): { summary: ChatRow; members: ChatRow[] }[]` — max runs of
  `groupableRow` separated by the rest; a 1-row group still gets a summary line.
- `groupCounts(members: ChatRow[]): GroupCounts` — read each member's kind
  (`toolRun`'s `runs` for tool names and `reason` for thought; console block rows →
  `command`). Recomputed on every draw like `rows()` in a panel; nothing cached.
- `groupLabel(counts, durationMs, marks, busy)` — the exact string form; `busy` truthy →
  the wording of the item still running (`busyLabel` rule).

Rendering: the summary row keeps the existing gutter fold marker `▸`/`▾` and draws the
label in `m.text` with `dim: true`; it is a `foldLine` of a fold id `group:<first member's id>`
so the existing click path (`foldAt`/`onClick`, `assistant.ts`) and `^o` toggle it.
Expansion here is Task 2's level: clicking or `^o` shows the members exactly as today's
`notes: 'open'` rows are shown — nothing record-collapsed yet (that is Task 3).

- [ ] **Step 4: Run to verify**

Run: `bun test src/views/__tests__/modals.test.ts` and `bun test src/__tests__/chat-modes.e2e.test.ts src/__tests__/work-picker.e2e.test.ts`
Expected: PASS on the new tests; existing tests adjusted only where they pinned the old
`▸ N tools: name` / `▸ thought` rows — say which and why in the commit body.

- [ ] **Step 5: Commit**

```bash
git add src/views/modals.ts src/views/__tests__/modals.test.ts
git commit -m "feat: one collapsible line counts a stretch's tools and thoughts"
```

---

### Task 3: Levelled disclosure — group → record rows → record body

**Files:**
- Modify: `src/views/modals.ts` — record rows for a group's members: a thought, a tool
  call, a console block; each collapsed to one line and expandable to its body in place.
- Test: `src/views/__tests__/modals.test.ts` and the touched e2e files.

**Interfaces:**
- Consumes: the groups and their members from Task 2.
- Produces: `ChatRow.record?: { id: string; kind: 'thought' | 'tool' | 'console'; title: string; status?: string; marks?: string }`, one per member row the group lists (its body rows are the member rows the renderer already knows).

**Rules:** every record is collapsed to one line by default when the group opens:
`thought: <reasoningSummary title>` (already computed at `modals.ts:862`),
`⌁ <tool name> · <duration or status>` for a call (the exact command line for `command`
kind, cut to width), `! <command line> · <status>` for a console block, keeping `‼`/`✗`/`✎`
marks and `consoleMark`'s live colour. A click or `⏎` on the record line expands just that
member's body in place (thought body text; the call's args + result; the console's output
tail — the blocks `modals.ts` already lays out via `blockRows`/`pagerTitle`); clicking
again collapses. Narration text rows are not records: they stay dim rows between records
in the expanded group.

- [ ] **Step 1: Write the failing tests**

```ts
test('an open group shows one record line per tool call and per thought', () => {
  // frame: `▸ thought: ...`, `▸ ⌁ git_status`, `▸ ! echo "..."`, and NOT the body text of the thought, nor the console output
  // and the console record keeps its state marks: a run that failed reads `▸ ! echo "..." · ✗`, an interactive one `▸ ! ... · ‼`
});
test('a record expands to its own body and collapses again', () => {
  // simulate the record line's click (the same `foldAt`/`onClick` route existing folds use)
  // frame: the body rows appear under that record only; the other records stay one line
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/views/__tests__/modals.test.ts -t "record"`
Expected: FAIL.

- [ ] **Step 3: Implement record rows and their disclosure**

Keep the group's `fold` id as the outer fold (Task 2's), the record ids as
`<group id>:<n>` so each record is its own fold inside. Rendering schema already has
`foldLine`/`fold` for exactly this nesting; reuse it rather than inventing a second
disclosure model. `pagerTitle` (`:1534`) learns record ids so a body opened in the pager
titles itself (`thought`, `tool call`, `output`).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/views/__tests__/modals.test.ts`, then the e2e set that touches folds
(`bun test src/__tests__/chat-modes.e2e.test.ts src/__tests__/subagent-watch.e2e.test.ts`)
Expected: PASS; any fixed-up old expectations named and explained.

- [ ] **Step 5: Commit**

```bash
git add src/views/modals.ts src/views/__tests__/modals.test.ts
git commit -m "feat: an activity group opens into one line per record"
```

---

### Task 4: Console blocks fold into the group, `ƒ Ran N commands` heads retire

**Files:**
- Modify: `src/views/modals.ts` (`groupHeadText`, `:678` usage rows),
  `src/assistant/view-groups.ts` (kept, but the head rows it contributes are no longer
  drawn when an activity group covers them).
- Modify: `docs/usage.md`, `CHANGELOG.md` (same commit).
- Test: `src/views/__tests__/modals.test.ts`, the e2e files that pinned the `ƒ Ran N
  commands` head.

**Interfaces:**
- Consumes: Task 2's group row and `command` count kind.
- Produces: nothing new; the summary's `command` count covers console blocks.

**Rules:** consecutive console blocks do not draw their own `ƒ Ran N commands` group head
any more — the activity group's `N commands` count is that fact, and the summary keeps the
worst state marks (`✗`, `✎`, `‼`) a head used to show. `viewGroups`/`groupHeadText` stay
for the pager's block rows (`blockRows`'s `…:group` ids and `pagerTitle`), only the chat's
drawn head row goes away.

- [ ] **Step 1: Write the failing test** — a stretch with two console blocks collapses to
  one summary line `+ 2 commands` with no `Ran` row anywhere in the frame; the summary
  still shows a failed run's `✗`.
- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/views/__tests__/modals.test.ts -t "commands"`
Expected: FAIL — the frame still draws `ƒ Ran 2 commands …`.
- [ ] **Step 3: Implement** — stop pushing the head rows in the chat's row builder when
  the stretch they cover becomes a group; leave `viewGroups` untouched as a function.
- [ ] **Step 4: Run and fix the pinned tests** — name each test whose `ƒ Ran N commands`
  expectation changes and why.
- [ ] **Step 5: Commit**

```bash
git add src/views/modals.ts src/assistant/view-groups.ts docs/usage.md CHANGELOG.md
git commit -m "feat: console blocks fold into the activity group, the Ran head goes away"
```

---

## Left to the builder

- The exact width behaviour of the summary line at <80 columns (drop `· duration` first,
  then the counts right-to-left) — a test at one narrow width is enough.
- Whether a group that ends the conversation keeps its summary line when the chat scrolls
  old rows out — out of scope, the scroll box owns that.
- Whether `^o` opening everything should open group bodies one level or all the way
  (default: exactly one level, matching the pointer's single click).
