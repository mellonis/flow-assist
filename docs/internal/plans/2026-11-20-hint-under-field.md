# The hint row under the field, the tree gone, the panel as the one door

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The hint row moves under the field, the tree block under the field is deleted
(the work strip is the one place for live subagents/tasks/shells, opened by `↓` and closed
by `↑` on its first row), and the hint carries the count and who waits.

**Architecture:** A column reorder and a deletion in `src/views/modals.ts`, the plugin's
tree-cursor machinery dropped from `src/plugins/assistant.ts`, one flag added to the
shared panel machinery (`command-panel.ts`) for the `↑`-closes gesture, and one badge
fed by the chat's own subtree in `assistant.ts`. No new module.

**Tech Stack:** TypeScript 7, Bun 1.4, React 19 via `@flowtty/react`, `bun test`.

**Status:** design agreed 2026-11-20; implementation plan below. Branch: `feature-hint-under-field` from `master`.

**Spec:** this document — "Intent" through "Left to the builder" below. The living specs it
edits are `docs/usage.md` (the user manual) and `docs/internal/agents/ask-children-spec.md`
(the agent tree).

---

## Intent

One gesture for background work, and a field strip that reads top-down the way a person
builds it: what is happening, what is left to do, what I am typing, what my keys do.

1. **The hint row sits under the field** — the last row inside the chat box, never moved
   by a growing plan. Its content is unchanged.
2. **The tree block under the field is gone.** The chat's own live subagents, tasks and
   background shells are inspected in the work strip (`↓` on an empty field), which
   already exists. The hint carries the count and the way in: `↓ N in background`, plus
   `· K waiting` when a subagent of this chat waits on the person.
3. **`↑` on the work strip's first row closes it** — the mirror of `↓` opening it.

## Design (agreed)

- **Order inside the box, top to bottom:** conversation · `⚠ error` · plan · queue line ·
  field (its `⏎ send · …` placeholder inline on the empty field's own row) · **hint row**
  (the last row of the strip) · ~~tree~~ · stacked `/diff`.
- **The hint row moves; it does not change.** Live turn status, armed-Esc prompt,
  shell-directory prefix, `/diff` keys, `[auto]` badge, `⏸ N`/`● N`, `ctx` — all keep
  their content and their right-hand placement. Only its position is new.
- **The count badge** keeps its wording `N in background`. When this chat's subtree has
  work to show, the badge becomes `↓ N in background` (N = the work strip's rows, the same
  number `↓` opens on), and `· K waiting` is appended in the warn colour when K is the
  subagents of this chat parked on a y/n or a question. With no work of this chat's, the
  badge stays the registry-wide `N in background` it is today (tasks of other sessions,
  sessions left running).
- **The tree block, its cursor and its keys are deleted.** `↑`/`↓` walk, `x` stop,
  `y`/`n`, the `+K more — /agents` row, the cursor following a node, "Esc back from a
  watch lands on the row": all go. `Esc` back from a watch lands on the field; re-entering
  the work is `↓`.
- **The work strip stays as it is** (`/work`, `J`, `↓`; `←`/`→` tabs; `⏎` watch;
  `^d` kill/stop with its y/n question), plus the one new key: **`↑` on the first row
  closes it**; deeper, `↑` only moves the cursor. `Esc` closes from any row.
- **`/agents` stays** — the whole tree, ended nodes included, in the conversation's place.
  The strip lists live work only.
- **`ui.agentRows` is removed** (the block it sized is gone).

## Global Constraints

- UI strings, code comments and docs in **English** (AGENTS.md, language rule).
- **Never write a key's glyph by hand in a hint** — use `keyGlyph(...)` / `CAP` (AGENTS.md).
- The **hint row and the field never give way**; the plan does (docs invariant, kept).
- Suite green from the host root: `bun run typecheck && bun test ./src ./scripts ./packages`.
- Docs updated in the same commit as the code that changes them (AGENTS.md).
- Conventional commits (`feat:`, `fix:`, `docs:`); each task on its own commit.

## Review Focus

- A long plan in a short box: the hint row must stay drawn (one row) while the plan gives
  way — pinned in Task 1.
- A queued message during a turn: the queue line stays above the field, the hint below it,
  neither squeezed — pinned in Task 1.
- `↓` on a chat with no live work: nothing opens and the badge does not advertise `↓` —
  pinned in Task 2.
- A waiting subagent with the strip closed: the badge says `· K waiting` in warn, and the
  strip's row says `? waiting for you` — pinned in Task 2.
- `↑` on a deeper row of the strip: it moves the cursor and must not close — pinned in
  Task 4.

---

## Task 1: The hint row moves under the field

**Files:**
- Modify: `src/views/modals.ts` — the hint block (comment at 2074 through 2151) moves to
  after the field group (2193–2260), before the tree block (2261).
- Test: `src/views/__tests__/modals.test.ts`

**Interfaces:**
- Consumes: `renderChatModal` props as they are today.
- Produces: nothing new; the column order `… plan → queue → field → hint`.

- [ ] **Step 1: Write the failing test** — in `src/views/__tests__/modals.test.ts`:

```ts
test('the hint row is the last row inside the box, under the field; the plan is above the field', async () => {
  const backend = new TestBackend(100, 24);
  const handle = await render(h(renderChatModal, {
    ...baseChat, width: 100, messages: [],
    todo: [{ id: 't1', text: 'one', status: 'pending' }],
  }), backend);
  const rows = backend.lastFrame.split('\n');
  const hint = rows.findIndex((r) => r.includes('history · wheel'));
  const field = rows.findIndex((r) => r.includes('send ·'));
  const plan = rows.findIndex((r) => r.includes('▾ plan'));
  const border = rows.findLastIndex((r) => r.includes('╰'));
  expect(plan).toBeGreaterThan(0);
  expect(field).toBeGreaterThan(plan);
  expect(hint).toBeGreaterThan(field);
  expect(hint).toBeLessThan(border); // inside the box, the last row before the border
  handle.unmount();
});
```

- [ ] **Step 2: Run it — expect FAIL** (`hint` above `field` today):
  `bun test src/views/__tests__/modals.test.ts -t "hint row is the last row"`
- [ ] **Step 3: Move the block** — cut the hint JSX (the `pager ? … : watch ? … : h(Box,{
  flexDirection:'row', …})` children incl. `⏸/●`, `autoBadge`, `contextBadge`) out of its
  place after `error`, and paste it as the last child of the column, after the field
  group and before the tree block. Update the comment above it to say where it sits
  ("the last row inside the box: the field keeps the keys, this says what they are").
- [ ] **Step 4: Run the suite** — `bun test src/views/__tests__/modals.test.ts`:
  expect PASS, including the plan tests (369–440) and the bg-count tests (459–486).
- [ ] **Step 5: Commit** — `git commit -m "feat: the hint row sits under the field"`.

## Task 2: The badge names the door and who waits

**Files:**
- Modify: `src/views/modals.ts` (props `bgDoor`, `bgWaiting`; the badge string),
  `src/plugins/assistant.ts` (compute and pass them).
- Test: `src/views/__tests__/modals.test.ts`, and a new
  `src/__tests__/work-hint.e2e.test.ts`.

**Interfaces:**
- Produces: `renderChatModal` props `bgDoor = 0: number` (this chat's work rows —
  `workRowsOf(conv).length`) and `bgWaiting = 0: number` (live subagent nodes of this
  chat with `status === 'waiting' || status === 'asks'`, shells excluded). The badge
  text is
  `${bgDoor > 0 ? keyGlyph('down') + ' ' : ''}${bgDoor > 0 ? bgDoor : bgCount} in background${bgWaiting ? ` · ${bgWaiting} waiting` : ''}`,
  drawn with `color: m.warn` when `bgWaiting > 0`, else dim. The number is the door's
  count while the door has work (a resting idle subagent exists with `bgCount` 0), the
  registry-wide count otherwise.

- [ ] **Step 1: Write the failing tests**:

```ts
test('the bg badge names the ↓ door and counts its rows when this chat has work', async () => { /* bgCount: 0, bgDoor: 2 → toContain('↓ 2 in background') */ });
test('a waiting subagent says so in warn beside the count', async () => { /* bgCount: 2, bgDoor: 2, bgWaiting: 1 → toContain('· 1 waiting'); the cell's fg is the warn colour */ });
test('with no work of this chat the badge stays the plain registry count', async () => { /* bgCount: 1, bgDoor: 0 → toContain('1 in background'); not.toContain('↓') */ });
```

- [ ] **Step 2: Run them — expect FAIL** (props and wording do not exist).
- [ ] **Step 3: Implement** — add the two props with defaults, build the string as above
  in the hint's left cell; in `assistant.ts` compute
  `bgDoor: workRowsOf(conv).length > 0` and
  `bgWaiting: conv.tree().filter((n) => !n.shell && (n.status === 'waiting' || n.status === 'asks')).length`
  beside `bgCount` (3762) and pass them in `chatProps`.
- [ ] **Step 4: Write the e2e test** — `work-hint.e2e.test.ts`: boot the scripted app,
  start a subagent that parks on a y/n (`ask_parent` after the pause), and
  `settleUntil(() => hintRow(frameOf(ui)).includes('waiting'))`; expect
  `↓ 1 in background · 1 waiting` on the hint row; press `↓` and expect the strip's row
  `? waiting for you`; `Esc`. Reuse the boot/ask helpers from `work-picker.e2e.test.ts`
  and copy the `hintRow` helper from `attention.e2e.test.ts:31` (it finds the row by
  `history · wheel`).
- [ ] **Step 5: Run** — `bun test src/views/__tests__/modals.test.ts src/__tests__/work-hint.e2e.test.ts src/__tests__/subagent.e2e.test.ts src/__tests__/attention.e2e.test.ts src/__tests__/view-memory.e2e.test.ts`:
  all PASS (the old `N in background` substrings survive the new wording).
- [ ] **Step 6: Commit** — `git commit -m "feat: the hint names the ↓ work door and who waits"`.

## Task 3: The tree block under the field is removed

**Files:**
- Modify: `src/views/modals.ts` (the `tree` prop at 1774; `chatRoom`'s `treeRows`
  at 1629/1675–1699; `treeBudget`/`TREE_LIST_MIN` 1690–1700; `treeShown`/`room` 1942–1945;
  `treeKeys` 1967 and its hint branch 2117–2119; the block itself 2261–2276; the
  `treeRows` mention in `stripRows` and the 1702 comment).
- Modify: `src/plugins/assistant.ts` (imports at 42; `TreeSel`/`NO_TREE_SEL` 186 and
  630–635; every `setTreeSel` site — 975, 996, 1015, 1704, 1923, 2768, 2948, 2982,
  3175–3211; `treeNow`/`treeStops` 2816–2840 and `shownTree` 3785–3798; the `↓` door at
  3272 keeps its guard `workRowsOf(conv).length`).
- Modify: `src/assistant/agent-tree.ts` — delete `agentRowsOf`, `AGENT_ROWS_DEFAULT`,
  `AGENT_ROWS_MAX` and `treeRows` + their helpers; **keep** `agentsPanelRows`,
  `stopQuestion`, `treeCursor` (used by `/agents`).
- Test: `src/views/__tests__/modals.test.ts` (delete the tree block at 1328–~1420 and the
  `treeBudget` import), `src/assistant/__tests__/agent-tree.test.ts` (delete the
  `treeRows`/`agentRowsOf` tests), `git mv src/__tests__/subagent-tree.e2e.test.ts
  src/__tests__/agents-panel.e2e.test.ts`.

**Interfaces:**
- Consumes: `agentsPanelRows`, `stopQuestion`, `treeCursor` — unchanged.
- Produces: no `tree` prop; no `treeRows`/`treeBudget`/`agentRowsOf`; `Review Focus`
  numbers still come from Task 2's badge.

- [ ] **Step 1: Delete the under-field tests, keep `/agents`** — from
  `subagent-tree.e2e.test.ts` remove these twenty tests (everything before the `/agents`
  block), then `git mv` the file to `agents-panel.e2e.test.ts` and fix its header comment
  (it no longer describes rows under the field). Removed tests, verbatim names:

  1. `a held subagent shows its row under the field, with its latest step`
  2. `a subagent that waits for a y/n is marked ⏸ and, with more nodes than rows, kept before the working ones`
  3. `a grandchild is indented under its parent`
  4. `ui.agentRows 0 draws no rows`
  5. `with a child's y/n block drawn the rows are hidden, and they return after the answer`
  6. `in a 12-row bottom panel no tree row is drawn and the list keeps its rows`
  7. `every chat row stays one terminal line at a narrow width` *(keep: it asserts on chat
     rows, not the tree — move it to `chat.e2e.test.ts` if it boots a child only for the rows)*
  8. `the tree rows are entered from a watch's Esc-back; ↑ on the first row and Esc go back, and the field then takes text`
  9. `the ↓ that ends a history walk, or follows a cleared history entry, does not also open the panel; a draft and shell mode keep ↓` *(keep the `↓`-door assertions: move them to `work-picker.e2e.test.ts`, drop the history-walk-around-rows part)*
  10. `x then y stops the node as the person and journals it so; x then n does not; a node stops what it started` *(covered by the strip's `^d` + `y` — `work-picker.e2e`)*
  11. `a key typed in the rows reaches neither the field nor the model, and Esc there is not the turn's stop or the exit arm`
  12. `the cursor stays on its node when another above goes idle, moves to the nearest when its own is stopped, and the field has the keys when none is left`
  13. `the cursor moves to the nearest row when the node under it is stopped and others are left`
  14. `a stop question stays up when its node goes idle, and y ends the idle node`
  15. `a stop question is dropped when the task it was for has ended`
  16. `the `+K more` row is never a stop of the cursor`
  17. `with the cursor in the rows a child's y/n is not answerable: the notice line, y answers nothing, and after Esc the block is armed afresh`
  18. `x then y with a child's request waiting stops the node and approves nothing`
  19. `an own y/n that arrives while the cursor is in the rows takes the keys, and the cursor does not come back`
  20. `the chat collapsed and opened again has the cursor in the field`

- [ ] **Step 2: Run the renamed file — expect FAIL** (it still boots the old tree).
- [ ] **Step 3: Remove the views side** — delete the `tree` prop, `treeShown`, the
  second `chatRoom` measure (`room` becomes `base`), `treeKeys`, the hint's tree branch,
  the tree block, `treeBudget`/`TREE_LIST_MIN`, and `treeRows` out of `chatRoom`'s
  signature, `treeBlock`, `planShape` and `stripRows`.
- [ ] **Step 4: Remove the plugin side** — delete `treeNow`, `treeStops`, `treeSelRef`,
  `setTreeSel`, `NO_TREE_SEL`, the whole `treeSelRef.current.at !== null` key block, the
  watch's `back` field and its "land on the row" branch (Esc lands on the field), the
  `shownTree` construction, the `tree` prop passing, and the `agentRowsOf`/`treeRows`
  imports. Where a key used `treeSelRef` as a guard (`2768`, `2948`, `2982`), drop the
  guard.
- [ ] **Step 5: Remove the pure code** — `agentRowsOf`, `AGENT_ROWS_*`, `treeRows` and its
  private helpers in `agent-tree.ts`; drop their tests in `agent-tree.test.ts` and the
  `treeBudget` tests in `modals.test.ts`.
- [ ] **Step 6: Migrate tests that awaited a row** — in `subagent-question.e2e.test.ts`
  (206, 242), `subagent-tell.e2e.test.ts` (70) and any other `frameOf(ui).includes('⚙ …')`
  wait: replace with the door —
  `await ui.press('down'); await settleUntil(() => frameOf(ui).includes('<label>')); await ui.press('escape');`
  (the field must be empty at that point; it is in these flows).
- [ ] **Step 7: Run** — `bun run typecheck && bun test ./src ./scripts ./packages`: PASS.
- [ ] **Step 8: Commit** — `git commit -m "feat: the work strip is the one place for background work; the tree block goes"`.

## Task 4: `↑` on the strip's first row closes it

**Files:**
- Modify: `src/assistant/command-panel.ts` (`PanelSpec` + `panelKey`),
  `src/plugins/assistant.ts` (`openWork` passes the flag; the strip's view carries it),
  `src/views/modals.ts` (`CommandPanelView` + the strip's hint), and the plugin's
  `panel` view mapping at 3690.
- Test: `src/assistant/__tests__/command-panel.test.ts`,
  `src/__tests__/work-picker.e2e.test.ts`.

**Interfaces:**
- Produces: `PanelSpec.upAtTopCloses?: boolean`; `CommandPanelView.upAtTopCloses?: boolean`.
  `panelKey` returns `{ state }` with the same close as Esc when
  `key.name === 'up' && top.upAtTopCloses && cursor === 0` (pop one if nested, else the
  panel is gone). The strip's hint shows
  `${keyGlyph('up')} close · ${keyGlyph('down')} pick` while the cursor is on the first row
  of a list with more than one row, and `↑↓ pick` otherwise.

- [ ] **Step 1: Failing unit test** — in `command-panel.test.ts`:

```ts
test('↑ on the first row closes a panel that says so; deeper it only moves', () => {
  const spec = { title: 'W', rows: () => [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }], upAtTopCloses: true };
  expect(panelKey(panelStart(spec), { name: 'up' }).state).toBeNull();
  const deeper = { ...panelStart(spec), cursor: 1 };
  expect(panelKey(deeper, { name: 'up' }).state?.cursor).toBe(0);
});
```

- [ ] **Step 2: Failing e2e test** — in `work-picker.e2e.test.ts`:

```ts
test('↑ on the first row closes the strip; a deeper ↑ only moves; Esc closes anywhere', async () => {
  /* open with ↓; press ↑ → the strip's frame is gone and the chat's field is back;
     open again, ↓ once (second row), ↑ → the strip is still up and the cursor is on row one;
     ↓ once more, Esc → closed */
});
```

- [ ] **Step 3: Run both — expect FAIL.**
- [ ] **Step 4: Implement** — the flag in `PanelSpec`/`panelKey`, `openWork` passes
  `upAtTopCloses: true`, the view mapping carries it, `renderCommandPanel`'s hint splits
  the `↑↓ pick` token on the first row as above (use `keyGlyph('up')`/`keyGlyph('down')`,
  never hand-written glyphs).
- [ ] **Step 5: Run** — `bun test src/assistant/__tests__/command-panel.test.ts src/__tests__/work-picker.e2e.test.ts`: PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat: ↑ on the work strip's first row closes it"`.

## Task 5: Docs and CHANGELOG

**Files:**
- Modify: `docs/usage.md` — rewrite "### The live subagents under the field" (≈318–355)
  as "### Background work: the hint and the work strip": the badge `↓ N in background`
  (and `· K waiting`), `↓` opens, `↑` on the first row or `Esc` closes, `⏎` watch, `^d`
  kill/stop, `Esc` back from a watch goes to the field; delete the `ui.agentRows`
  paragraph (337) and the `+3 more — /agents` sentence; say `/agents` is the full list.
- Modify: `docs/internal/agents/ask-children-spec.md` — the "agent tree" section (116–150):
  the rows are no longer drawn under the field; `treeRows`/`treeBudget`/`ui.agentRows`
  gone; `Conversation.tree()` feeds `/agents` and the work strip; the stop question and
  the cursor belong to `/agents` only.
- Modify: `CHANGELOG.md` — under `Unreleased`: hint row under the field; the tree block
  removed (the work strip is the one place; `↓` opens, `↑` closes from the first row); the
  hint's `N in background` names the door and says `K waiting`; `ui.agentRows` removed.
- Test: `src/__tests__/docs.test.ts` may assert documented key names — run it.

- [ ] **Step 1: Edit the three documents** as above, present tense (no "used to").
- [ ] **Step 2: Run** — `bun test src/__tests__/docs.test.ts` and
  `bun run typecheck`: PASS.
- [ ] **Step 3: Commit** — `git commit -m "docs: the hint under the field and the work strip as the one door"`.

---

## Left to the builder

- Exact wording of the rewritten docs section; keep the existing voice.
- Whether the `tools` ui-frames scenario gains a `--color` checkpoint (optional, no test).
- Whether the renamed `agents-panel.e2e.test.ts` keeps its `boards` guest fixture (only
  /agents tests remain; drop what is unused).
