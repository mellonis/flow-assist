# The Bottom Row at the Border Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the chat frame the bottom row (the key hint, the working status, the pager's keys, a watched child's status) hugs the frame's bottom border, and the one empty row is above it — uniformly in every state.

**Architecture:** Two lines of layout in `src/views/modals.ts` — the frame loses its bottom padding (that row was the empty row under the hint) and the `field-strip` gains a `gap: 1` between the field's place and the bottom row (a `null` first child renders as one child, so no gap appears in the no-field states). The height counters (`chatRoom`, `pendingChatRows`) move one row from "the frame's border and padding" into "the strip", keeping their totals equal to what is drawn.

**Tech Stack:** Bun 1.4.x, flowtty (`@flowtty/react`), `bun test` with `TestBackend` rendering.

**Spec:** `~/Developer/mellonis-workspace/flowtty-things/docs/flow-assist-hint-row-swap-design-2026-11-22.md`

## Global Constraints

- The full suite must land on the known base failure set — 3 reproducible `leave-busy.e2e` failures (`two subagents ask…`, `the conversation's own y/n comes first…`, `a pager open when the settings y/n is asked…`) plus the load-flaky `mcp.e2e` (up to 7), `start-cwd.e2e`, `tools-shell` — **nothing new**.
- `chatRoom()` and `pendingChatRows()` are the measures the keys and the panel layout read; they must agree with `renderChatModal` row for row after the change.
- Where a comment states the 2026-11 decision "the field and its hint are ONE child with no gap", rewrite the comment — the code must not lie.
- Test names in the repo are English sentences (`name.test.ts` next to the code). Commits: `feat:`/`fix:`/`docs:`/`test:` with a lowercase prose sentence, as the log shows.

## Review Focus

- A y/n or question box open: the empty row goes between the box and the bottom row; the box's own hint (`y yes · n no`, `⏎ send`) must read as the box's, and the box must not be clipped. (Task 1, Cases D/G)
- The field's place empty — the pager, a watched child: exactly ONE empty row above the bottom row (the frame's own gap), never two; flowtty's `gap` must not add a row beside a `null` child. (Task 1, Cases C/F)
- A multi-row draft (Shift+⏎): exactly one empty row between the last typed row and the bottom row whatever the field's height. (Task 1, Case E)
- A completion list open under the prompt: the empty row is between the list and the bottom row — the list keeps its rows and never touches the border. (Task 1, Case E's structure covers it; the gap lives in the strip, above the bottom row regardless of what the field's place holds)
- The `/diff` stacked panel on a narrow terminal: the frame's last child, now truly at the frame's bottom; `chatRoom().split`'s `stripRows` must leave it its rows. (Task 1, the `/diff` tests in the suite)

---

### Task 1: The swap — the render, the counting, the tests

**Files:**
- Modify: `src/views/modals.ts` — the chat frame Box in `renderChatModal` (~line 2558), the `field-strip` Box (~2627), `chatRoom` (~2154-2200), `pendingChatRows` (~3495)
- Modify: `src/views/__tests__/modals.test.ts` — the two cases at ~480-522 reworked; five new cases near them

**Interfaces:**
- Consumes: nothing from earlier work.
- Produces: the observed line order — the bottom row is the frame's last row above the border, exactly one empty row above it, in every state. `chatRoom().besides`/`split` and `pendingChatRows()` keep their names and meanings; only their numbers move.

- [ ] **Step 1: Rework the two existing cases and write the failing ones**

The two cases at `modals.test.ts:480-522` currently assert "the hint is the last content row, the rows under it to the border are blank" and every row under the hint is frame sides only. That is exactly what reverses. Rework both tails to:

```ts
const hint = rows.findIndex((r) => r.includes('history · wheel'));   // the second case: '3s · compact' / 'an answer is coming'
const field = rows.findIndex((r) => r.includes('send ·'));
const border = rows.findLastIndex((r) => r.includes('╰'));
expect(plan).toBeGreaterThan(0);
expect(queue).toBeGreaterThan(plan);
expect(field).toBeGreaterThan(queue);
expect(hint).toBe(border - 1);   // the bottom row hugs the border
expect(rows.slice(field + 1, hint).map((r) => r.replace(/│/g, '').trim())).toEqual(['']);   // one empty row above it
```

New cases, in the same file's render style (`TestBackend`, `h(renderChatModal, {...baseChat, ...})`):

```ts
// C
test("the pager keys hug the border with the frame's one empty row above them", async () => {
  // baseChat + pager: { title: 'docs', rows: ['a line'] }
  const keys = rows.findLastIndex((r) => r.includes('Esc close'));
  expect(keys).toBe(border - 1);
  expect(rows[keys - 1].replace(/│/g, '').trim()).toBe('');
});

// D
test('with a y/n box up the empty row stands between the box and the key hint', async () => {
  // baseChat + pendingConfirm: { name: 'write_file', args: '{"path":"a.ts"}' }  (ConfirmAsk)
  const hint = rows.findLastIndex((r) => r.includes('history · wheel'));
  const boxHint = rows.findIndex((r) => r.includes('Press y to confirm'));
  expect(hint).toBe(border - 1);
  expect(boxHint).toBeLessThan(hint - 1);   // the box's own hint stays in the box
  expect(rows[hint - 1].replace(/│/g, '').trim()).toBe('');
});

// E
test('with a multi-row draft the one empty row still stands between the field and the hint', async () => {
  // baseChat + input: 'top row\nlong draft line' (cursor at the end)
  const hint = rows.findLastIndex((r) => r.includes('history · wheel'));
  expect(hint).toBe(border - 1);
  expect(rows[hint - 1].replace(/│/g, '').trim()).toBe('');
  expect(rows[hint - 2]).toContain('long draft line');   // still exactly one empty row
});

// F
test("a watched child's status hugs the border, its notice above it, one empty row above that", async () => {
  // baseChat + watch: { path: ['outer'], rows: [], state: '⚙ read_file(a.ts)', ended: false, ask: null, notice: '⏸ 1 waiting' }
  const status = rows.findLastIndex((r) => r.includes('x stop · Esc back'));
  const notice = rows.findLastIndex((r) => r.includes('⏸ 1 waiting'));
  expect(status).toBe(border - 1);
  expect(notice).toBe(status - 1);                         // the notice and the status stay together
  expect(rows[notice - 1].replace(/│/g, '').trim()).toBe('');   // the one empty row above them
});

// G
test("a question's rows are counted exactly: at pendingChatRows height the block stands whole", async () => {
  const confirm = { name: 'write_file', args: '{"path":"a.ts"}' };
  const height = pendingChatRows({ width: 80, confirm });
  // TestBackend(80, height), baseChat at width: 80, height, pendingConfirm: confirm (imported from '../modals.js')
  expect(backend.lastFrame).toContain('Press y to confirm');   // the box is not clipped
});
```

- [ ] **Step 2: Run to verify the new assertions fail**

Run: `bun test src/views/__tests__/modals.test.ts`
Expected: FAIL — the hint rows sit one row above the border (`hint` is `border - 2`), and the rows between field and hint are `[]`, not `['']`.

- [ ] **Step 3: Implement the swap in `src/views/modals.ts`**

Four edits, no behavior beyond them:

1. The chat frame Box (`renderChatModal`, the one with `border: 'round'` and `padding: 1`): `padding: 1` → `paddingX: 1, paddingTop: 1` (flowtty supports per-side padding; nothing else gets padding-bottom). Comment: the bottom row goes to the frame's edge, the empty row above it is the strip's.
2. The `field-strip` Box: add `gap: 1`, and rewrite the surrounding comment ("ONE child of the column, with no gap between the two — the column's gap separates pieces, never a field from its own legend") to say the opposite: the empty row between the field's place and the hint is deliberate (2026-11-22, by request), and with the field's place `null` (the pager, a plain watch) there is no gap — the frame's own gap above the strip is the one empty row.
3. `chatRoom`: `const fieldStrip = fieldPlace + 1;` becomes

   ```ts
   // The field's place is drawn or not exactly as the render decides (`renderChatModal`):
   // the pager and a plain watch leave it null, and the gap then does not exist.
   const stripHolds = !(pager || (watch && !confirmAsk && !watch.question));
   const fieldStrip = stripHolds ? fieldPlace + 2 : (watch?.notice ? 2 : 1);
   ```

   and every count of the frame's own rows says 3 now (border 2 + top padding 1): the comment "the frame's border and padding take 4 rows more" and its `boxH - 4` become `boxH - 3`.
4. `pendingChatRows`: `4 + parts.reduce(...)` becomes `3 + …` — its `parts` already treat the block and the status row as separate pieces with a gap between them (`parts.length - 1` gaps), which matches the render exactly now instead of overcounting by one.

- [ ] **Step 4: Run to verify the cases pass**

Run: `bun test src/views/__tests__/modals.test.ts`
Expected: PASS (all of the file).

- [ ] **Step 5: Sweep the e2e needles and run the suite**

Run: `bun test ./src ./scripts ./packages 2>&1 | grep -E '^\(fail\)' | sort -u`
Expected at first: some e2e needles that predicted the hint adjacent to the field now fail (`subagent-ask.e2e`, `jump-to-end.e2e`, `work-hint.e2e`, `chat-modes.e2e` are the likely ones — their lookups are anchor-based and mostly loose, re-pin only what actually fails). Re-pin to the new geometry; do not loosen a needle into skipping rows.
Then run the suite again and compare to the Global Constraints base set: nothing new fails.

- [ ] **Step 6: Commit**

```bash
git add src/views/modals.ts src/views/__tests__/modals.test.ts src/__tests__
git commit -m "feat: the bottom row hugs the border and the empty row stands above it"
```

---

### Task 2: The docs

**Files:**
- Modify: `docs/usage.md` — § "The hint row and the work strip" (~lines 327-342)
- Modify: `CHANGELOG.md` — `## Unreleased`

**Interfaces:**
- Consumes: Task 1's line order.
- Produces: nothing further.

- [ ] **Step 1: Rewrite the geometry sentences in `docs/usage.md`**

"The hint row is the last row of the field's strip, under the line you type in" → it is the strip's last row **at the frame's bottom edge**, with one empty row between it and the line you type in. Walk the section (~327-342) for other "under it" phrasing about the hint (e.g. the question-state line "its hint row staying under it") and make them say the empty row honestly. Key lists and behaviors in the section are unchanged.

- [ ] **Step 2: Add the `CHANGELOG.md` Unreleased entry**

Lead sentence, bolded, in the voice of the entries above it:

> **The key hint and the empty row trade places.** The row that names the keys sits on the frame's bottom edge, and the one empty row that stood under it now stands above it — between the line you type and the hint. The same in every state: the pager's keys and a watched child's status hug the edge too.

- [ ] **Step 3: Run the suite once more**

Run: `bun test ./src ./scripts ./packages 2>&1 | tail -5`
Expected: the base failure set from Global Constraints, nothing new (docs cannot move tests, this is the final confirmation).

- [ ] **Step 4: Commit**

```bash
git add docs/usage.md CHANGELOG.md
git commit -m "docs: the hint row at the frame's edge, the empty row above it"
```
