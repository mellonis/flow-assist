# `/diff` Keyboard Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `/diff` panel the keyboard of a full diff viewer — hunk/file navigation, review marks, four sources with a base-branch picker, single-file mode, fullscreen and a key help — with nothing ever writing to git.

**Architecture:** The panel keeps one walk (`diffPanelBody` in `src/views/modals.ts`) as the single source of rows, items and the cursor; the chat's dispatcher gains one block of key actions (bindings from the plugin's `keys` table). Sources are two providers answering the same `DiffSection[]`: `working-tree.ts` grows a base and three modes (read-only git), a new `src/assistant/turn-diff.ts` maps the turn's recorded write reports. The change record keeps a reported diff whole (up to a byte cap) so the panel reads it as a reader; the chat's `✎` keeps its display limit unchanged, applied at draw time.

**Tech Stack:** TypeScript 7 (strict, NodeNext), Bun 1.4, React 19 + `@flowtty/react`, zod 4. Tests: `bun test`; fixture repos are real `git` in temp dirs.

**Spec:** `docs/internal/plans/2026-11-25-diff-viewer.md` (this plan argues from it; executors read both).

## Global Constraints

- Code comments and docs in English; the host's UI strings in English.
- Hints never spell a key by hand: actions are in the plugin's `keys` table and drawn with `host.keyCap(action)` / the caps the chat passes to the render.
- No `HOST_API` bump; no new plugin-contract surface.
- Every test wait goes through the shared `settleUntil(ok, budget, label)` (`src/__tests__/helpers/scripted.ts`); a silent give-up fails `no-silent-waits`.
- `git` use stays read-only: `git status`, `git diff`, `git for-each-ref`, `git symbolic-ref` only — in `working-tree.ts` and `turn-diff.ts` and their tests.
- Fixture repos name their branch explicitly (`git init -q -b main`), or the test reads `git symbolic-ref --short HEAD` and pins that: a `vs <ref>` string never depends on the machine's `init.defaultBranch`.
- Tests never touch a person's files: fixture repos are `git init` under `os.tmpdir()` (the existing `scratchTree`/`scratchPair` pattern), and every conversation test boots with its own temp sessions dir.
- Verdict commands after each task: `bun run typecheck` and that task's test file(s) green.
- Commits are conventional (`feat(diff): …`, `test(diff): …`); no `Co-Authored-By` trailer.

## Review Focus

1. **A live refresh under the cursor.** A walk that finds the file gone or a hunk gone must leave the cursor on that file's row or clear it — never crash, never yank the view back to the cursor ("the refresh must not pull the panel back"). Test: `diff-panel.e2e.test.ts` — "a refresh that takes the cursor's file leaves the panel where the person reads" (Task 6/1 to pin).
2. **The empty-field gate and letters.** With the panel drawn and the field empty, a bound letter acts (`m`, `q`, `j`); the same keystroke types into the field once a draft exists or while a y/n, a question or the `:` line waits. Test: `diff-panel.e2e.test.ts` — "the panel takes its keys only from an empty field" (Task 6, 7).
3. **Exit keys and Esc order.** `ctrl+d`/`ctrl+u` are the panel's half-page while it is drawn and never arm the app's exit; `Esc` stops a running turn first and closes the panel only from an idle chat; `q` closes the panel and never the app. Test: `diff-panel.e2e.test.ts` — "ctrl+d pages the panel and never arms the exit" and the existing Esc-stops test (Task 6, 10).
4. **Git wrinkles.** A nested repository gets its own section and its own base; a repository whose default branch cannot be resolved draws honest wording and offers the picker — `branch-local` never silently falls back to `HEAD`. Tests: `working-tree.test.ts` (Task 3), `diff-panel.e2e.test.ts` — "a repository with no default branch says so and offers the picker" (Task 9).
5. **The record cap and the chat's look.** A change over `CHANGE_DIFF_MAX_BYTES` draws `… N lines not kept` in the panel while the chat's `✎` block renders byte-for-byte what it rendered before this work (rows and `… N more lines`). Tests: `diff.test.ts` + `change-diff.e2e.test.ts` (Task 2).

## File Structure

- `src/assistant/diff.ts` (modify) — `diffRowGroups(diff)`; the record keeps a change's diff whole up to `CHANGE_DIFF_MAX_BYTES`; `changeMarkdown` applies the chat's display cut (`CHANGE_DRAW_MAX_LINES`) at draw time.
- `src/assistant/working-tree.ts` (modify) — `DiffMode`, `workingTreeDiff(roots, { base, mode })`, `defaultBaseRef`, `listBaseRefs`; `DiffSection` gains `base` and `kind`. Still the one read-only git exception.
- `src/assistant/turn-diff.ts` (create) — `lastTurnChanges(messages)`: the turn's recorded write reports as `DiffSection[]`, path titles grouped by git top, other titles in a `reported` section. Pure: no React, no git.
- `src/views/modals.ts` (modify) — `DiffCursor`, `diffPanelItems`, `diffFileMove`/`diffHunkMove`/`diffFirstItem`/`diffLastItem`; `diffPanelBody` draws one walk (hunk-grouped rows, the cursor row lit at hunk granularity, reviewed marks, the `changes that are not files` group, the source tail, the single-patch header, the hint row); a full-screen frame shape for the viewer.
- `src/plugins/assistant.ts` (modify) — the `keys` table actions, the dispatcher block (gates per the spec), the viewer state (cursor, source, per-top bases, reviewed, single, fullscreen), the source dialog (`openPanel`), `?` → the help modal, `f` → the fullscreen overlay.
- Tests: `src/assistant/__tests__/diff.test.ts`, `src/assistant/__tests__/working-tree.test.ts`, `src/assistant/__tests__/turn-diff.test.ts` (new), `src/views/__tests__/modals.test.ts`, `src/__tests__/diff-panel.e2e.test.ts`, `src/__tests__/change-diff.e2e.test.ts`.

---

### Task 1: The walk's groups, items and moves (pure)

**Files:**
- Modify: `src/assistant/diff.ts`
- Modify: `src/assistant/working-tree.ts` (one field: `FileDiff.key?: string` — the stable key part of a file, defaulting to `path`; a reported change's index key sets it. `diffPanelItems` and the body key by `diffFileKey(root, f.key ?? f.path)`.)
- Modify: `src/views/modals.ts` (next to `diffPanelFileKeys`)
- Test: `src/assistant/__tests__/diff.test.ts`, `src/views/__tests__/modals.test.ts`

**Interfaces:**
- Consumes: `diffRows(diff)` and `FileDiff`/`DiffSection` (existing).
- Produces (later tasks rely on these exact names):
  - `diffRowGroups(diff: string): Array<Array<{ text: string; no: string }>>` — one array per `@@` group, rows as `diffRows` returns them (`@@` rows dropped).
  - `type DiffCursor = { fileKey: string; hunk: number }` — `hunk: -1` is the file's own row; `hunk >= 0` is that hunk's first row (`diffFileKey(root, path)` from `working-tree.ts` keys `fileKey`).
  - `diffPanelItems(sections: DiffSection[], collapsed: ReadonlySet<string>): DiffCursor[]` — every cursor row in drawn order: a file's item, then its hunks' items; a folded file and a file with a `note` contribute their file item only.
  - `diffFileMove(items: DiffCursor[], at: DiffCursor | null, step: number): DiffCursor | null` — the next/previous item with `hunk === -1`; from `null`, `step > 0` takes the first and `step < 0` the last; clamped at both ends (a move past the end stays put).
  - `diffHunkMove(items: DiffCursor[], at: DiffCursor | null, step: number): DiffCursor | null` — the same over items with `hunk >= 0`; when there are none, returns `at` unchanged.
  - `diffFirstItem(items: DiffCursor[]): DiffCursor | null`, `diffLastItem(items: DiffCursor[]): DiffCursor | null`.

- [ ] **Step 1: Write the failing tests**

`src/assistant/__tests__/diff.test.ts` — `diffRowGroups splits hunks at their @@ headers` (a two-hunk diff text → two groups; each group's rows carry the file's line numbers and no `@@` row; the first group's first row `no` is the first line of hunk 1).

`src/views/__tests__/modals.test.ts` — `diffPanelItems walks file rows and hunk starts in drawn order` (two files, one with two hunks, one folded by key → `[f1, f1h0, f1h1, f2]`), `diffFileMove walks file rows and clamps at the ends`, `diffHunkMove walks hunk starts across files` (from `f1`'s row `step 1` → `f1h0`; from `f1h1` → `f2h0`; `step 1` from the last hunk stays), `diffFirstItem and diffLastItem are the ends of the list`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/assistant/__tests__/diff.test.ts src/views/__tests__/modals.test.ts`
Expected: FAIL — `diffRowGroups is not a function` / `diffPanelItems is not a function`.

- [ ] **Step 3: Implement the helpers**

`diffRowGroups` splits `diffRows`' input at `@@` lines before `diffRows` flattens it (a `@@` line starts a group; the numbers come from `diffLineNumbers`, which `diffRows` already uses). `DiffCursor` + the four move helpers go in `modals.ts` beside `diffPanelFileKeys`, filter-and-clamp as their signatures say; `diffPanelItems` mirrors `diffPanelBody`'s row order (sections in order, files in order, a file item then its hunk items) and skips the hunks of a folded or `note`d file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/assistant/__tests__/diff.test.ts src/views/__tests__/modals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/assistant/diff.ts src/views/modals.ts src/assistant/__tests__/diff.test.ts src/views/__tests__/modals.test.ts
git commit -m "feat(diff): hunk groups, cursor items and the walk's moves"
```

### Task 2: The record keeps the change whole; the chat draws as it always has

**Files:**
- Modify: `src/assistant/diff.ts`
- Test: `src/assistant/__tests__/diff.test.ts`, `src/__tests__/change-diff.e2e.test.ts`

**Interfaces:**
- Consumes: `Change`, `ChangeView`, `unifiedDiff`, `changeMarkdown` (existing).
- Produces: `CHANGE_DIFF_MAX_BYTES = 2 * 1024 * 1024`, `CHANGE_DRAW_MAX_LINES = 80` (exported from `src/assistant/diff.ts`); `ChangeView.hidden` now means "diff lines the record did not keep" (it was "lines past the draw cut"); `changeMarkdown(v)` draws the first `CHANGE_DRAW_MAX_LINES` kept lines and appends `… N more lines`, `N = (kept lines − 80) + v.hidden`. No other consumer changes.

- [ ] **Step 1: Write the failing tests**

`src/assistant/__tests__/diff.test.ts`:
- `a reported change is recorded whole and counts only what the cap drops` — `changeView` of a 200-line rewrite keeps `diff` with 200 lines (not 80) and `hidden === 0`; a synthetic change whose diff text is over `CHANGE_DIFF_MAX_BYTES` (one giant line, so the line-boundary cut drops the rest) has `hidden > 0` and a `diff` slice ending at the last whole line kept.
- `changeMarkdown keeps the chat's rows and note unchanged` — for a 200-line change, `changeMarkdown` shows the first 80 lines and `… 120 more lines`; for a change with `hidden: 7` the note reads `… ${80-past + 7} more lines` exactly as before this work.

`src/__tests__/change-diff.e2e.test.ts` — `the ✎ block keeps its rows and note` (an existing-style write of a >80-line edit: the block draws rows up to the old limit and one `… N more lines` row; pin the exact strings already asserted in that file today — this test must fail only because the record now holds more).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/assistant/__tests__/diff.test.ts src/__tests__/change-diff.e2e.test.ts`
Expected: FAIL — `changeView` keeps 80 lines today.

- [ ] **Step 3: Implement `changeView` whole-keep and the display cut**

`changeView` calls `unifiedDiff(before, after, { maxLines: Number.MAX_SAFE_INTEGER })` and then cuts the joined text at `CHANGE_DIFF_MAX_BYTES` on a line boundary, counting the dropped lines into `hidden`. `changeMarkdown(v)` splits the kept `diff` at line ends, draws `lines.slice(0, CHANGE_DRAW_MAX_LINES)` and appends `… N more lines` with `N = lines.length - CHANGE_DRAW_MAX_LINES + v.hidden` (a negative first term clamped to 0). Update the `ChangeView` doc comments: the record holds the diff whole up to the cap; `hidden` is past the cap.

- [ ] **Step 4: Run the tests to verify they pass, and the two suites that draw a change**

Run: `bun test src/assistant/__tests__/diff.test.ts src/__tests__/change-diff.e2e.test.ts src/__tests__/journal.e2e.test.ts`
Expected: PASS (journal `/export` now exports the whole recorded diff — any string it pins grows with it; update those pins to the whole diff, never shorter).

- [ ] **Step 5: Commit**

```bash
git add src/assistant/diff.ts src/assistant/__tests__/diff.test.ts src/__tests__/change-diff.e2e.test.ts src/__tests__/journal.e2e.test.ts
git commit -m "feat(diff): keep a reported change whole in the record; the chat keeps its cut"
```

### Task 3: working-tree sources — a base and three modes

**Files:**
- Modify: `src/assistant/working-tree.ts`
- Test: `src/assistant/__tests__/working-tree.test.ts`

**Interfaces:**
- Consumes: the existing walk (`git status`/`git diff` read-only, `realOf`/`within`, `gitRootOf`).
- Produces (Task 4, 5, 9 rely on these):
  - `export type DiffMode = 'branch-local' | 'committed' | 'worktree'` (default `'branch-local'`).
  - `workingTreeDiff(roots: string[], opts?: { base?: string | ((root: string) => string | undefined); mode?: DiffMode }): Promise<WorkingTreeDiff>` — per git top: `branch-local` = `git diff -- <base>` (local changes and commits since base), `committed` = `git diff <base>...HEAD`, `worktree` = `git diff HEAD`; untracked files stay `A` in `branch-local`/`worktree` and are absent in `committed`. `base` is one ref for every top, or a lookup per top. With `opts.base` omitted (or answering `undefined` for a top), that top uses its own `defaultBaseRef` result; when that is null the section is answered with `base: ''` and no files (the panel words it — Task 5).
  - `DiffSection` gains `base: string` (the label the header prints after `vs ` — the chosen ref, or `HEAD`) and `kind?: 'tree' | 'reported'` (absent means `'tree'`).
  - `defaultBaseRef(root: string): Promise<string | null>` — `git symbolic-ref --short refs/remotes/origin/HEAD` (its tail after `origin/`), else `main` when that ref exists, else `master` when it exists, else `null`.
  - `listBaseRefs(root: string): Promise<{ local: string[]; remote: string[] }>` — `git for-each-ref --format=%(refname:short) refs/heads` and `… refs/remotes` (as read-only as the walk).

- [ ] **Step 1: Write the failing tests**

`src/assistant/__tests__/working-tree.test.ts`, on scratch repos:
- `each mode is one walk against its own base` — a repo with a commit on `main`, a second commit on a branch, and an uncommitted edit: `branch-local` (base `main`) shows the edit and the branch commit, `committed` (base `main`) shows only the branch commit, `worktree` shows only the edit; each section's `base` is the label (`main`, `main`, `HEAD`).
- `a nested repository is its own top with its own base` (existing file's nested fixture extended with `opts`).
- `defaultBaseRef resolves the default branch and admits when it cannot` — `origin/HEAD` pointing at `origin/main` → `main`; no such ref and only `master` → `master`; neither → `null`.
- `listBaseRefs lists local and remote branches` (a repo with a `feature` branch and an `origin/other` remote ref).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/assistant/__tests__/working-tree.test.ts`
Expected: FAIL — `workingTreeDiff` takes no `opts`.

- [ ] **Step 3: Implement the modes, the base and the two read helpers**

One `git diff` call per top with the mode's arguments (above) replacing the fixed one; `git status` stays the file list (the modes filter it: `committed` drops untracked). `defaultBaseRef` and `listBaseRefs` are the same spawn discipline as the walk (`GIT_TIMEOUT_MS`, never throw — a failure answers `null`/empty).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/assistant/__tests__/working-tree.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/assistant/working-tree.ts src/assistant/__tests__/working-tree.test.ts
git commit -m "feat(diff): working-tree sources — a base ref and three modes"
```

### Task 4: The turn's reports as a source (`turn-diff.ts`)

**Files:**
- Create: `src/assistant/turn-diff.ts`
- Test: `src/assistant/__tests__/turn-diff.test.ts` (new)

**Interfaces:**
- Consumes: `ChatMsg` (`src/assistant/conversation-types.ts`), `TurnPart`/`turnSegments` (`src/assistant/step.ts`), `ChangeView` (Task 2's shape), `gitRootOf` (`src/assistant/sessions.ts`), `realOf`.
- Produces (Task 5, 6, 9 rely on this):
  - `lastTurnChanges(messages: readonly ChatMsg[]): DiffSection[]`
  - The last turn is the messages **after** the last `role === 'user' && !midTurn` message (the message that started the turn; a queued message delivered mid-turn is not a boundary). Its `kind: 'change'` parts are the reports, oldest first. No reports → `[]` (the panel words it).
  - A change whose title starts with `~/` or `/` is a **path change**: `FileDiff.path` = the title as given, `status` = `A` when `before === ''`, `D` when `after === ''`, else `M`; `root` = `gitRootOf(realOf(expanded)) ?? realOf(expanded)`; grouped per root.
  - Every other title is a **reported change** (not a file): `FileDiff.path` = the title, `key` = `'\u0000' + index` (index among the reported changes of that turn — a title may repeat), `hunks` = its diff, `status` as above, all in one section `{ root: '', kind: 'reported', base: '' }`.
  - `FileDiff` gains `note?: 'binary' | 'too large' | 'cut'` and `hidden?: number`: a change whose record was cut (Task 2's `change.hidden > 0`) carries `note: 'cut'` and `hidden` = the lines the record did not keep.
  - Section `base` for path sections: `''` (the header says `last turn`, not a ref).

- [ ] **Step 1: Write the failing tests**

`src/assistant/__tests__/turn-diff.test.ts` (plain `ChatMsg[]` fixtures, no app):
- `the last turn's reports become sections` — a turn with two path changes in one repo and one elsewhere → two `tree` sections, roots by `gitRootOf`, `base: ''`.
- `a title that is not a path is drawn, not dropped` — `ABC-1 · description` lands in the single `reported` section with its hunks and key `\u00000`.
- `a queued message mid-turn is not a boundary` — a `midTurn: true` user message inside the turn keeps the earlier reports in the same turn's list.
- `status comes from the texts` — empty `before` → `A`, empty `after` → `D`, else `M`.
- `no reports answers no sections` — `[]`, never a section claiming a clean tree.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/assistant/__tests__/turn-diff.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement `lastTurnChanges`**

Walk `messages` from the end to the boundary, collect the `parts` of kind `'change'` (or `turnSegments(parts)` change segments), reverse to oldest first, map per the rules above. Pure and synchronous; no clock, no git spawn except `gitRootOf` (which is path work).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/assistant/__tests__/turn-diff.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/assistant/turn-diff.ts src/assistant/__tests__/turn-diff.test.ts
git commit -m "feat(diff): the last turn's write reports as a diff source"
```

### Task 5: The panel draws it — one walk, the cursor row, the source tail

**Files:**
- Modify: `src/views/modals.ts` (`DiffPanelView`, `diffPanelBody`, `renderDiffPanel`, `DiffBody` unchanged in kind)
- Test: `src/views/__tests__/modals.test.ts`, `src/__tests__/diff-panel.e2e.test.ts`

**Interfaces:**
- Consumes: Task 1's `DiffCursor`/`diffPanelItems`/`diffRowGroups`, Task 3's `DiffSection.base`/`kind`, Task 4's `reported` section.
- Produces (Task 6–10 rely on this):
  - `DiffPanelView` gains `source: 'branch-local' | 'committed' | 'worktree' | 'turn'`, `reviewed: ReadonlySet<string>` (file keys), `single: boolean`, `caps: Record<string, string>` (action name → what `host.keyCap` answered); `cursor` becomes `DiffCursor | null`.
  - `diffPanelBody(p)` takes `items: DiffCursor[]` (computed by the caller with `diffPanelItems`) and answers `{ rows, cursorRow, itemRows }` — `itemRows[i]` is the drawn row of `items[i]`, `-1` when it is not drawn (one walk, so a row and a key cannot disagree).
  - `renderDiffPanel` gains `bodyRef?: { scrollBy(rows: number): void; scrollPage(pages: number): void }` — the one channel from the chat's key handler to the list's scroll (the cursor's own scroll stays `DiffBody.carry`'s, on cursor moves only). `scrollPage(±1)` is a viewport, `scrollBy(±n)` rows.
  - The cursor row is drawn lit and inverted (`accent` + `inverse` — the mark the file row carried) wherever it rests: a file row or a hunk's first row.
  - A reviewed file's lead is `▸ ✓ M path`/`▾ ✓ M path` (fold glyph, `✓`, status, path).
  - Section header tail: `vs <base>` for `branch-local`, `vs <base> — committed only` for `committed`, `vs HEAD — working tree only` for `worktree`, `last turn` for `turn` (the words live in `modals.ts`).
  - The `reported` section draws its header `changes that are not files` (dim) and its rows `· <title>  +A −R` (no status letter), hunks under them as any file's.
  - `single: true` draws one file — the cursor's file, falling back to the first — under the header `diff · 3 of 7 · vs <tail>` (the place of that file in `diffPanelItems`' file order, over the count of files).
  - No-hunks and cap notes stay as they are (`binary`/`too large — not shown`) plus one new note row under a `reported`-source file whose record was cut: `… N lines not kept` (the renderer draws `FileDiff.note === 'cut'` with `FileDiff.hidden`; Task 4's provider sets them).
  - The hint row under the body, from `caps`: `${up}${down} file · ${prevH}${nextH} change · ${mark} reviewed · ${single} one file · ${source} source · ${full} full · ${help} see all · ${esc} close` — every glyph a cap from `caps`, the labels plain words.

- [ ] **Step 1: Write the failing tests**

`src/views/__tests__/modals.test.ts`:
- `the body's rows and items agree` — for a two-file section (one folded), `itemRows[i]` is the row of `rows[itemRows[i]]` for every drawn item and `-1` for the folded file's hunks.
- `the cursor row is lit wherever it rests` — a hunk cursor lights that hunk's first row; a file cursor lights the file row.
- `the source tail names what is compared` — the four tails as pinned above.
- `a reported change is drawn like the chat draws it` — the `changes that are not files` header, `· ABC-1 · description  +1 −1`, its hunks with gutter numbers.
- `single shows one file and counts its place` — `diff · 3 of 7 · vs main`.
- `the hint row carries the caps` — the rendered hint contains `? see all` and `esc close` when `caps` maps the actions to `?` and `Esc`, and no hand-spelled key when `caps` is empty.

`src/__tests__/diff-panel.e2e.test.ts` — `the panel header says what it compares against` (the pinned `vs main` string over the existing scratch repo).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/views/__tests__/modals.test.ts src/__tests__/diff-panel.e2e.test.ts`
Expected: FAIL — `DiffPanelView.cursor` is a string today and the tail is `vs HEAD`.

- [ ] **Step 3: Implement the render**

Extend `diffPanelBody` per the Interfaces block; `DiffBody` needs no change (it already scrolls `cursorRow` into view only when the cursor moved). The `single` header replaces the per-section header line; the reported group goes after the tree sections in walk order. Keep the copy semantics unchanged (chrome `selectable: false`, code rows selectable).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/views/__tests__/modals.test.ts src/__tests__/diff-panel.e2e.test.ts`
Expected: PASS (the e2e that pinned `cursor: string`-era strings are updated to the new lead/tail wording — never weakened).

- [ ] **Step 5: Commit**

```bash
git add src/views/modals.ts src/views/__tests__/modals.test.ts src/__tests__/diff-panel.e2e.test.ts
git commit -m "feat(diff): the panel — cursor rows, source tails, reported changes, hint row"
```

### Task 6: The keys and the dispatcher — navigation

**Files:**
- Modify: `src/plugins/assistant.ts` (the `keys` table, the diff state, the dispatcher block near `diffOpenRef`)
- Test: `src/__tests__/diff-panel.e2e.test.ts`

**Interfaces:**
- Consumes: Task 1 moves, Task 5's `DiffPanelView`/`diffPanelBody(items)`, `isKey`/`canonicalBinding` (`src/playback/keys.ts`), `host.keys`, `host.keyCap`.
- Produces (Tasks 7–10 extend this block):
  - The `keys` table gains (defaults; `config.keys.<action>` moves any):
    `diffNextHunk: ']'`, `diffPrevHunk: '['`, `diffNextFile: 'down'`, `diffPrevFile: 'up'`, `diffScrollDown: 'j'`, `diffScrollUp: 'k'`, `diffPageDown: 'pagedown'`, `diffPageUp: 'pageup'`, `diffHalfPageDown: 'ctrl+d'`, `diffHalfPageUp: 'ctrl+u'`, `diffFirst: 'home'`, `diffLast: 'end'`, `diffMarkReviewed: 'm'`, `diffSinglePatch: 's'`, `diffSource: 'd'`, `diffFullscreen: 'f'`, `diffHelp: '?'`, `diffClose: 'q'`.
    (`end` is `toEnd`'s binding too: the dispatcher decides, the panel's block runs first while the panel is drawn. `escape` closes as today and gets no action name.)
  - State: `diffCursor`/`diffCursorRef: DiffCursor | null`, kept in the same ref+state pair the file cursor used.
  - The dispatcher block (as today: after the picker's, before `isKey(host.keys.sessions)`): while `diffOpenRef.current && (diffShownRef.current || …placeholder for Task 10's fullscreen)`, and the field is empty and no y/n, question or `:` line wants the keyboard, match **only** the panel's own bindings with `isKey(host.keys[action], key)`; every other key falls through. The cursor moves (`diffNextHunk`/`diffPrevHunk`/`diffNextFile`/`diffPrevFile`/`diffFirst`/`diffLast`) call the Task 1 helpers on `diffPanelItems(diffSectionsRef.current, diffCollapsedRef.current)`. `diffClose` closes the viewer on `q`; `escape` keeps its stop-a-turn order (the existing comment and code stay) and closes the panel from an idle chat. The scroll actions use Task 5's `bodyRef`: `diffScrollDown`/`diffScrollUp` → `scrollBy(±1)`, `diffHalfPageDown`/`diffHalfPageUp` → `scrollBy(±half a viewport)` (the handle's metrics) or `scrollPage(±0.5)` if it takes fractions — pin `scrollBy` rows and compute the half in the handler; `diffPageDown`/`diffPageUp` fall through to the list as they do today (the actions exist for rebinding and forward to `scrollPage(±1)` when the fall-through would not reach them). The cursor is re-resolved after a refresh (`same fileKey + hunk → same cursor; the file row when the hunk is gone; null when the file is gone; and the refresh never scrolls unless the cursor moved` — the existing `DiffBody.carry` rule).
  - `caps` for the render: `Object.fromEntries(actions.map((a) => [a, host.keyCap(a)]))`.

- [ ] **Step 1: Write the failing tests**

`src/__tests__/diff-panel.e2e.test.ts` (scratch repos; multi-hunk fixture: one file edited at two places):
- `] and [ walk hunks across files` — from the panel's first cursor position, `]` lights `+` rows of hunk 1, then hunk 2, then the second file's first hunk; `[` walks back; the drawn frame shows the lit row each time.
- `up and down walk the file rows` — the cursor lands on each file's row, clamped at the ends.
- `j and k scroll without moving the cursor` — the cursor row's file stays lit while the frame's rows change.
- `home and end go to the ends of the diff`.
- `the panel takes its keys only from an empty field` — with the panel drawn, `j` scrolls (no `j` in the field); type `a`, then `j` types into the field and nothing scrolls.
- `ctrl+d pages the panel and never arms the exit` — one `ctrl+d` press while the panel is drawn moves the rows and the frame carries no `again to exit` arm.
- `a refresh that takes the cursor's file leaves the panel where the person reads` — delete the cursor's file on disk, wait for the walk, the cursor clears and the viewport top row stays.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/__tests__/diff-panel.e2e.test.ts`
Expected: FAIL — `]` does nothing.

- [ ] **Step 3: Implement the keys block**

Per the Interfaces block. The gate string in one place: the existing conditions (`fieldEmpty()`, `!conv.confirm && !conv.question`, the `:` line closed) plus `(diffShownRef.current || diffFullRef.current)`; `escape` keeps its stop-a-turn order (the existing comment and code stay).

- [ ] **Step 4: Run the tests to verify they pass and the suite around them**

Run: `bun test src/__tests__/diff-panel.e2e.test.ts src/__tests__/chat.e2e.test.ts`
Expected: PASS (the chat's own keys — history `↑`/`↓`, the work panel's `↓` — behave as before when the panel is closed).

- [ ] **Step 5: Commit**

```bash
git add src/plugins/assistant.ts src/__tests__/diff-panel.e2e.test.ts
git commit -m "feat(diff): the viewer's keys — hunk and file navigation over one walk"
```

### Task 7: Review marks (`m`) and the fold (`⏎`, click)

**Files:**
- Modify: `src/plugins/assistant.ts`, `src/views/modals.ts` (only if the reviewed lead needs a word)
- Test: `src/__tests__/diff-panel.e2e.test.ts`

**Interfaces:**
- Consumes: Task 5's `reviewed` set + lead, Task 6's dispatcher block and moves.
- Produces: `diffReviewed`/`diffReviewedRef: ReadonlySet<string>` (file keys) in the same ref+state pair as `diffCollapsed`; `diffMarkReviewed` marks the cursor's file, folds it, and moves the cursor to the next file row (`diffFileMove(..., +1)`, clamped); on a reviewed file it clears the mark and reopens the fold. `⏎` (when the chat is idle and `conv.continueOffer` is absent, as today) and a click keep folding alone; a marked file reopened by `⏎` keeps its `✓`. The set survives the live refresh (it is keyed by file) and is dropped with the chat (per-process in effect; it is not persisted).

- [ ] **Step 1: Write the failing test**

`src/__tests__/diff-panel.e2e.test.ts`:
- `m marks a file reviewed, folds it and steps on` — the drawn lead for the cursor's file becomes `✓`, the file's hunks are gone from the rows, the cursor lights the NEXT file row.
- `m again reopens the file and clears the mark`.
- `the mark survives a refresh` — write a change to a reviewed file's neighbour, wait for the walk, the `✓` stays.
- `return folds without touching the mark` — `⏎` on a reviewed file's row reopens its hunks and leaves `✓` drawn.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/__tests__/diff-panel.e2e.test.ts`
Expected: FAIL — `m` types into the field panel.

- [ ] **Step 3: Implement `diffMarkReviewed` and the mark's rendering**

Per the Interfaces block (`setDiffReviewed` the same way `setDiffCollapsed` is paired with its ref; `host.notify()` after).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/__tests__/diff-panel.e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/assistant.ts src/views/modals.ts src/__tests__/diff-panel.e2e.test.ts
git commit -m "feat(diff): review marks — a ✓ that survives the refresh"
```

### Task 8: Single-file mode (`s`)

**Files:**
- Modify: `src/plugins/assistant.ts`
- Test: `src/__tests__/diff-panel.e2e.test.ts`

**Interfaces:**
- Consumes: Task 5's `single` render (`diff · 3 of 7 · vs <tail>`).
- Produces: `diffSingle`/`diffSingleRef: boolean` (the same ref+state pair discipline). `diffSinglePatch` toggles it. Entering: the cursor keeps its file (or takes the first item's file when it has none) and the view scrolls to it; leaving: the cursor stays on that file and the view scrolls to it. In single mode the moves act within the one shown file as they do across files (`diffNextFile` steps to the next file and shows *it* — the mode follows the cursor).

- [ ] **Step 1: Write the failing tests**

`src/__tests__/diff-panel.e2e.test.ts` (the two-file scratch repo):
- `s shows one file and counts its place` — `s` draws `diff · 2 of 2 · vs main` for the second file and only its rows.
- `s again gives the whole list back`, the cursor still on that file's row.
- `down keeps stepping through the files in single mode` — from `diff · 1 of 2 · vs main`, pressing `↓` draws `diff · 2 of 2 · vs main` and that file's rows.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/__tests__/diff-panel.e2e.test.ts`
Expected: FAIL — `s` is unbound.

- [ ] **Step 3: Implement `diffSinglePatch`**

Per the Interfaces block; the single file is the cursor's file per `diffPanelItems`' file order, and the header counts that place over the number of files with `hunk === -1` in `items`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/__tests__/diff-panel.e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/assistant.ts src/__tests__/diff-panel.e2e.test.ts
git commit -m "feat(diff): single-file mode with its 3 of 7 header"
```

### Task 9: The source dialog and the base picker (`d`)

**Files:**
- Modify: `src/plugins/assistant.ts` (`openPanel` dialog; `diffSourceRef: DiffMode | 'turn'`, `diffBaseRef` map)
- Test: `src/__tests__/diff-panel.e2e.test.ts`

**Interfaces:**
- Consumes: `openPanel`/`PanelSpec` (`src/assistant/command-panel.ts` — rows with `kind: 'group'`, `keys: [{ key: 'return', label: 'use', run }]`, a panel opened over a panel and `Esc` back), Task 3's `listBaseRefs`/`workingTreeDiff` opts, Task 4's `lastTurnChanges`.
- Produces:
  - `diffSourceRef = ui.useRef<DiffMode | 'turn'>('branch-local')` and `diffBaseRef = ui.useRef(new Map<string, string>())` — the base per git top, for the life of the process (a preference of the person's, not session state).
  - The walk: `diffSourceRef.current === 'turn'` → `lastTurnChanges(convRef.current!.messages)` (notes its `hidden` as Task 5's `'cut'`); else `workingTreeDiff([diffScope()], { base: (root) => diffBaseRef.current.get(root), mode: diffSourceRef.current })`.
  - The `d` dialog (`PanelSpec`): title `Diff source`; rows — the four sources (`source:branch-local` `branch + local`, `source:committed` `committed only`, `source:worktree` `working tree only`, `source:turn` `last turn`, each `detail` a plain phrase: `commits and local changes`, `commits since the base`, `uncommitted changes`, `what write tools reported`), then — only for a git source — a group row `base` and one row per section root (`base:<root>`, text `base · <ref>` when there is one top and `base · <root tail> · <ref>` when several; `<ref>` is `diffBaseRef`'s value, else `defaultBaseRef`'s, else `not picked`).
  - A base row opens a second panel over the first: title `Base branch`; rows from `listBaseRefs(root)` — group `local`, the local branches; group `remote`, the remote refs. `return` sets `diffBaseRef.current.set(root, ref)`, drops both panels, rewalks. `Esc` goes back to the source panel.
  - Choosing a source rewalks, keeps the cursor's file where the new source has it and clears it where it does not; the cursor falls to the first item of the new source.

- [ ] **Step 1: Write the failing tests**

`src/__tests__/diff-panel.e2e.test.ts` (scratch repo with two branches and an `origin/other` remote ref):
- `d switches sources` — `d`, `return` on `committed only` draws `vs main — committed only` and hides the uncommitted edit; `working tree only` draws `vs HEAD — working tree only` and only the edit.
- `the base picker moves the comparison` — `d`, down to a `base` row, `return`, choose `master` on the picker → the header draws `vs master` and the walk is against it; the choice survives closing and reopening `/diff` in the same run.
- `a repository with no default branch says so and offers the picker` — a fresh `git init -q -b main` with zero commits in: the panel draws the row `pick a base to compare against` (which the test asserts verbatim; the render adds the `diffSource` cap beside it, never spelled in the test), never `vs HEAD` for `branch-local`.
- `last turn draws the turn's reports` — with a scripted write earlier in the run, `d` → `last turn` draws its file row and hunks; a change over the record cap draws `… N lines not kept`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/__tests__/diff-panel.e2e.test.ts`
Expected: FAIL — `d` is unbound.

- [ ] **Step 3: Implement the dialog and the walk's mode**

Per the Interfaces block. The panels are `openPanel` specs like the model picker's (`reset: false`, cursor on the current source). Reuse one `refreshDiff`/`walkDiff` pair: the mode and base read at walk time from the refs, so a picker's choice needs no second wiring.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/__tests__/diff-panel.e2e.test.ts src/assistant/__tests__/working-tree.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/assistant.ts src/__tests__/diff-panel.e2e.test.ts
git commit -m "feat(diff): the source dialog, the base picker and the last-turn source"
```

### Task 10: Fullscreen (`f`), help (`?`) and closing

**Files:**
- Modify: `src/plugins/assistant.ts`, `src/views/modals.ts` (the frame shape)
- Test: `src/__tests__/diff-panel.e2e.test.ts`

**Interfaces:**
- Consumes: Task 5's `renderDiffPanel`, `frame`/`overlay` (`src/views/modals.ts`, the log/help shape), `host.store.help.setHelpModal` (the `core` help modal — the help "already lists the keys that act here"), Task 6's dispatcher gate.
- Produces:
  - `diffFull`/`diffFullRef: boolean`. `diffFullscreen` (`f`) toggles it while `/diff` is open.
  - Fullscreen draw: the chat's return wraps `renderChat` and, while `diffOpenRef.current && diffFullRef.current`, an `overlay(width, height)` + `frame(m, 'Diff', …)` holding the same body and hint row at the terminal's size (zIndex under the reminder's 20 — the help-modal's shape, `renderHelp` as the model). The chat's frame, field and split are not drawn inside it; the draft is untouched by the toggle.
  - The keyboard in fullscreen is the same dispatcher block (the gate's "drawn" is `diffShownRef.current || diffFullRef.current`) **regardless of the draft** — the fullscreen view holds its keys while it is drawn. A pending y/n, a question or the `:` line sit above it (the ask block draws over the overlay at a higher zIndex) and are answered first; nothing else may.
  - `?` (`diffHelp`) opens the help modal: `(host.store as { help?: { setHelpModal?: (o: boolean) => void } }).help?.setHelpModal?.(true)`.
  - `q` and `escape` close the viewer from either shape (`closeDiff` clears `diffFullRef` too); `escape` keeps stopping a running turn first (existing order); `q` while a turn runs closes the panel and never the app.
  - `ACTION_LABELS` (`src/views/modals.ts`) grows the diff actions' labels (English, plain: `next change`, `previous change`, `next file`, `previous file`, `scroll down`, `scroll up`, `page down`, `page up`, `half page down`, `half page up`, `to the first change`, `to the last change`, `mark reviewed`, `one file / all files`, `diff source`, `full screen`, `the diff panel`, `close the diff panel`).

- [ ] **Step 1: Write the failing tests**

`src/__tests__/diff-panel.e2e.test.ts`:
- `f grows the panel to the terminal and back` — `f` draws the framed `Diff` over the terminal (the header row near the frame's top and no chat field row); `f` again restores the split with the field.
- `the fullscreen keeps its keys while a draft exists` — `f`, type `x` (nothing types into any field — the frame shows no field), `m` still marks.
- `a question drawn over the fullscreen is answered first` — with the panel fullscreen and a y/n pending (`Confirm write: …`), `y` answers it (the write's row lands in the chat behind) and the fullscreen stays up.
- `? opens the help and q closes the viewer` — `?` draws the Help frame; `Esc` closes the help; `q` closes the viewer entirely (the chat is back).
- `while the : line is open the panel takes nothing` — `:` with the panel drawn: the command line is up and `m` types nothing into the panel (the loader's own rule; the panel gets no key).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/__tests__/diff-panel.e2e.test.ts`
Expected: FAIL — `f`/`?`/`q` do nothing.

- [ ] **Step 3: Implement the overlay, the help call and the close**

Per the Interfaces block. The overlay is drawn in the chat's own return (a Fragment of `renderChat` and the overlay), so the `:` line and the app's chrome keep their order above it; the ask block's rows are the ones the chat already draws for a pending question/y/n, given `overlay`'s wrapper and a higher zIndex while fullscreen.

- [ ] **Step 4: Run the tests to verify they pass and the exits are sane**

Run: `bun test src/__tests__/diff-panel.e2e.test.ts src/__tests__/chat.e2e.test.ts`
Expected: PASS (the app's own exits — `q`, the arm keys — behave as before).

- [ ] **Step 5: Commit**

```bash
git add src/plugins/assistant.ts src/views/modals.ts src/__tests__/diff-panel.e2e.test.ts
git commit -m "feat(diff): fullscreen, the help of the keys that act, and the viewer's door"
```

### Task 11: CHANGELOG, the eyes, acceptance

**Files:**
- Modify: `CHANGELOG.md`, `scripts/ui-frames.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: an Unreleased CHANGELOG entry (the panel's keyboard, marks, sources, single, fullscreen, the help; the record keeps a reported change whole — the chat unchanged), and `scripts/ui-frames.ts` frames for the panel docked (a cursor on a hunk), single-file, fullscreen and the source dialog.

- [ ] **Step 1: Write the entry and the frames**

The CHANGELOG line follows its neighbours' voice (English, past tense, no issue numbers). The frames script gains fixtures per its existing pattern (a scratch repo like the tests').

- [ ] **Step 2: Run the frames for a look**

Run: `bun run scripts/ui-frames.ts` (the file's own filter for the new frames)
Expected: the four frames render; no row wraps or spills its box (eyeball).

- [ ] **Step 3: Acceptance — the verdict rule**

Run: `bun run typecheck`, then `bun test ./src ./scripts ./packages` three times consecutively.
Expected: typecheck clean; all three runs green with the same counts (the flaky-tests campaign's rule: one green run is not evidence).

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md scripts/ui-frames.ts
git commit -m "docs(diff): the /diff keyboard — changelog and frames"
```
