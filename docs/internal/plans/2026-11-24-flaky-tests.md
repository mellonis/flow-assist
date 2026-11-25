# Flaky host suite — implementation plan (issue #134)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make `bun run typecheck && bun test ./src ./scripts ./packages` a real gate — three consecutive green runs, or an explicit per-test quarantine with reason and a targeted retry.

**Architecture:** the flakes come from three cross-cutting leaks in the TEST harness, not from per-test bugs: (1) a process-global `globalThis.fetch` whose "restore" convention re-installs leaked mocks through the whole process; (2) tests that gate on one plane (model, file, drawn frame) and act on another with no wait between; (3) `settle`-hops that silently give up, and apps that outlive their test because `unmount()` never stops work. Tasks 1–3 close the leaks at their seams; Tasks 4–8 fix the per-name races the diagnoses pinned; Task 9 is the acceptance run.

**Tech Stack:** Bun 1.4, TypeScript 7, React 19 + `@flowtty/react`, `bun:test`; bundled plugin `plugins-available/mcp`.

**Spec:** GitHub issue `mellonis/flow-assist#134` ("Fix the flaky tests in the host suite"), plus the pinned diagnoses:
`.superpowers/sdd/2026-11-24-flaky-tests/diag-fetch-chain.md` and
`.superpowers/sdd/2026-11-24-flaky-tests/diag-ask-clock.md`.

## Global Constraints

- Code comments in English; the fix is in tests and one plugin — comments describe the code as it is.
- Never paper over with a global `--retry`. Quarantine, if any, is per test NAME with a written reason and exactly one targeted retry (`test.retry(2)` on that test only).
- Tests never reach the real network. The `mcp` fixtures are in-process `Bun.serve` on 127.0.0.1.
- A test must leave the process as it found it: `globalThis.fetch`, spawned children, and bootstrapped apps all restored/disposed before the next test runs.
- Gates run from the repo root: `bun run typecheck && bun test ./src ./scripts ./packages`. The suite is load-sensitive: judge a fix by repeated runs (the gates below say how many).

## Review Focus

1. **A future test file that leaks a mock must not re-poison the chain** — Task 1's seam test asserts `globalThis.fetch === nativeFetch` after any install/restore cycle, so the convention has a tripwire.
2. **An app whose test FAILS still must not outlive it** — afterEach disposal runs on failure too; Task 1's test covers the throw path (a failing test cannot ship, so the disposal is invoked from a test that simulates the failure path) and Task 9's full runs sample it.
3. **JSON-RPC replies with `result: null` or an empty 204 body are VALID** — Task 3's validation must accept them (the client's existing empty-body semantics) and its tests pin `result: null` explicitly.
4. **A condition wait must terminate loudly, and slowly must not mean wrongly** — Task 7's `settleUntil` asserts its condition on give-up with the condition's own text; the budget stays generous for full-suite load.
5. **Fixes must hold in the poisoned tail of a full run** — each task's gate names the poisoned pair/run it must survive; Task 9 is three consecutive full-suite runs.

---

### Task 1: The pristine-fetch seam and per-test disposal

**Files:**
- Modify: `src/__tests__/helpers/test-setup.ts` (the `bunfig.toml` preload)
- Modify: `src/__tests__/helpers/scripted.ts`
- Test: `src/__tests__/helpers/fetch-seam.test.ts` (new)

**Interfaces:**
- Produces: `export const nativeFetch: typeof fetch` in `src/__tests__/helpers/test-setup.ts` — the real `fetch`, snapshotted at preload time, before any test module loads.
- Produces: `ScriptedModel.install()` restores `globalThis.fetch` to `nativeFetch`; `bootApp(...)` returns its handle with `close(): Promise<void>` that unmounts the app AND reaches the registry's `closeAll('exit')` path (`src/assistant/registry.ts:465–505`) so children stop and turns abort.
- Produces: `helpers/scripted.ts` auto-disposes every app a test bootstrapped, in an `afterEach` it registers itself (registration once, at module load).

- [ ] **Step 1: Write the failing tests** in `src/__tests__/helpers/fetch-seam.test.ts`:
  (a) after a ScriptedModel install→restore cycle `globalThis.fetch` is `nativeFetch`;
  (b) after `bootApp(...)` and `close()`, a child's `run_command`-style job is stopped (assert via the app handle state the helper exposes, e.g. `handle.closed === true`) and `globalThis.fetch` is `nativeFetch`.
- [ ] **Step 2: Run `bun test src/__tests__/helpers/fetch-seam.test.ts` — expect FAIL** (no `nativeFetch` export yet; `close` undefined).
- [ ] **Step 3: Implement.** `test-setup.ts`: snapshot and export `nativeFetch` before anything else. `scripted.ts`: capture/restore through `nativeFetch`; `bootApp`'s handle gains `close()` (unmount + the registry close the exit hook performs); register a module-level `afterEach` disposing every app the current test bootstrapped.
- [ ] **Step 4: Run the file — expect PASS**, then `bun test src/__tests__/subagent-ask.e2e.test.ts` (unchanged behaviour expected).
- [ ] **Step 5: Commit** `feat(tests): the pristine fetch seam and per-test app disposal`.

### Task 2: The leaker and the capture sweep

**Files:**
- Modify: `src/__tests__/max-tokens.e2e.test.ts:45,69,77,104,114,137`
- Modify: every test file using the `const realFetch = globalThis.fetch` convention (mechanical sweep to `nativeFetch` + one import line)

**Interfaces:**
- Consumes: `nativeFetch` (Task 1).

- [ ] **Step 1: Reproduce RED** — `bun test src/__tests__/max-tokens.e2e.test.ts src/__tests__/mcp.e2e.test.ts` — expect the 7 mcp failures (diag-fetch-chain.md).
- [ ] **Step 2: Fix `max-tokens.e2e.test.ts`** so every restore lands on `nativeFetch` (its `finally` blocks currently restore to the post-install mock).
- [ ] **Step 3: Sweep the convention** — `const realFetch = globalThis.fetch` → `import { nativeFetch } from './helpers/test-setup.js'` + `const realFetch = nativeFetch` in every test file (mechanical, `replaceAll` per file; keep each file's own `afterEach` shape).
- [ ] **Step 4: Gates** — the poisoned pair from Step 1 is GREEN; `bun test src/__tests__/max-tokens.e2e.test.ts src/__tests__/chat.e2e.test.ts src/__tests__/mcp.e2e.test.ts` GREEN; `bun run typecheck` clean.
- [ ] **Step 5: Commit** `fix(tests): a leaked fetch mock cannot be captured as the real one`.

### Task 3: The MCP client validates the JSON-RPC answer

**Files:**
- Modify: `plugins-available/mcp/src/client.ts:105–135`
- Test: the `mcp` plugin's own test file for the client (add a case beside its existing protocol tests)

**Interfaces:**
- Consumes: nothing. Produces: `createProtocol.request` throws `TrackerApiError`-style protocol error naming the answer when a 2xx body is not a JSON-RPC reply (no `id` match and neither `result` nor `error`).

- [ ] **Step 1: failing test** — a 2xx body without `result`/`error`/`id` rejects with a message naming the protocol mismatch; `result: null` and a 204/empty body still resolve (the client's existing semantics).
- [ ] **Step 2: run — FAIL.**
- [ ] **Step 3: implement** the validation at `client.ts:105-108` (today: "any 2xx body without `result` resolves as `undefined`").
- [ ] **Step 4: run — PASS**; then `bun test src/__tests__/mcp.e2e.test.ts` ×2 (the real-HTTP fixture tests must stay green — they answer real JSON-RPC).
- [ ] **Step 5: commit** `fix(mcp): a handshake that is not a JSON-RPC answer is a loud failure`.

### Task 4: mcp.e2e hardening (defence)

**Files:**
- Modify: `src/__tests__/mcp.e2e.test.ts` (:156, :183, :265 and the `sleep(50)`/one-shot `settle()` reads)

- [ ] **Step 1:** the 401 test awaits the manager's `start()`/`ready` promise instead of `sleep(150)` then asserts `asked === 1`.
- [ ] **Step 2:** `sleep(50)`/single-`settle()` reads of `model.requests.at(-1)`/`lastFrame` become `settleUntil(cond)` polls (the pattern `diff-panel.e2e.test.ts:15` uses); `index(i)`/`sent(i)` (:156, :265) optional-chain and assert with the missing request named.
- [ ] **Step 3: gate** — `bun test src/__tests__/mcp.e2e.test.ts` ×3 GREEN.
- [ ] **Step 4: commit** `test(mcp): the e2e waits on conditions, not on elapsed hops`.

### Task 5: the ask-family cross-plane waits (names A, B)

**Files:**
- Modify: `src/__tests__/subagent-ask.e2e.test.ts:185–186, 215–216`

- [ ] **Step 1: RED** — `bun test src/__tests__/subagent-ask.e2e.test.ts` until "two subagents ask…" fails (8/8 historically) — that is the failing test; name the assertion (`fs.existsSync(a!.file)`).
- [ ] **Step 2:** before `:186` add `await settleUntil(() => fs.existsSync(a!.file));` (the pattern at `:196`).
- [ ] **Step 3:** at `:215` wait for `parent done` in the frame (combined with the child-block wait), then assert `:216`.
- [ ] **Step 4: gate** — the file GREEN ×4 consecutive runs.
- [ ] **Step 5: commit** `test(subagent): the ask fixture waits on the plane it asserts`.

### Task 6: the pager fixtures (name C)

**Files:**
- Modify: `src/__tests__/leave-busy.e2e.test.ts:330–350`
- Modify: `src/__tests__/subagent-requests-keys.e2e.test.ts:95–130`

- [ ] **Step 1: RED** — `bun test src/__tests__/leave-busy.e2e.test.ts` shows "a pager open…" failing 5/5; run `subagent-requests-keys.e2e.test.ts` until the TypeError (`rows[-1]`) shows.
- [ ] **Step 2:** after the model-side wait, `await settleUntil(() => rowsOf(ui).some(r => r.includes('seq 1 300 ·')))`; assert the row exists (turn the `rows[at]!` crash into a named assertion), click THAT row, then `await settleUntil(() => frame.includes('the wheel scroll · Esc close'))` before asserting. Same anchoring for the `+ 1 command` group click and the `settle(6)`s in requests-keys' `open()`.
- [ ] **Step 3: gate** — both files GREEN ×4.
- [ ] **Step 4: commit** `test(pager): the click targets the drawn record row, not the status label`.

### Task 7: `settleUntil` must not give up quietly; picker and save waits (names E, F)

**Files:**
- Modify: `src/__tests__/helpers/scripted.ts` (`settleUntil`)
- Modify: `src/__tests__/leave-busy.e2e.test.ts` (`pickerFrame` `settle(3)`, `saved(...)` reads at :74/:107/:111-119)

- [ ] **Step 1: failing test** (in `fetch-seam.test.ts` or a small sibling): `settleUntil` gives up → throws naming the condition (drive with an impossible condition).
- [ ] **Step 2: implement** — assert on give-up (the condition's predicate text in the message); budget generous (keep 400 iterations).
- [ ] **Step 3:** `pickerFrame`/`pick` wait on drawn picker rows instead of `settle(3)`; `saved(dir, …)` asserts go behind `settleUntil(() => saved(...)?.messages.some(...))` (the 250 ms save debounce — `src/assistant/conversation-session.ts:304–309`). The same debounce is behind `model-switch.e2e.test.ts:59` (counts session state files before the save lands): await the save before counting.
- [ ] **Step 4: gate** — `leave-busy.e2e` GREEN ×4; the suite's ask-family files GREEN.
- [ ] **Step 5: commit** `test(harness): a wait that gives up says what it waited for`.

### Task 8: the shell/cwd family (`start-cwd`, `shell.e2e`, `loader/tools-shell`)

**Files:**
- Modify: `src/__tests__/start-cwd.e2e.test.ts:39, 62–76` (both weak predicates), the toast read at `:69`
- Modify: `src/__tests__/shell.e2e.test.ts:251–253, 269–292`
- Modify: `src/loader/__tests__/tools-shell.test.ts:89–99, 114–130`

**Interfaces:**
- Consumes: `nativeFetch` / `close()` (Task 1); `settleUntil` asserting on give-up (Task 7).
- Diagnosis: `.superpowers/sdd/2026-11-24-flaky-tests/diag-shell-cwd.md`.

- [ ] **Step 1: RED under load** — `bun test src/__tests__/start-cwd.e2e.test.ts` in a loop with two concurrent workers until the live-row failure shows (`:76` receives `! pwd · <1s`); that is the failing test.
- [ ] **Step 2:** replace both weak predicates (`:39`, `:72`) with the done-row form
  `await settleUntil(() => /pwd · (?:✓|✗)/.test(ui.backend.lastFrame))` — or the
  row-content form the assertion then reads; and make the toast read (`:69`) a
  content wait (or boot with `toastMs: 10_000`, the `skills-agents.e2e.test.ts:39` way).
- [ ] **Step 3:** `shell.e2e` deny test: await content
  (`resultOf('run_command').includes('Unknown tool: run_command') && resultOf('config_set').includes(READ_ONLY_TASK_DECLINE)`)
  instead of `requests.length === 5`; quiesce the producing test (:251–253) with
  `await settleUntil(() => ui.backend.lastFrame.includes('Made it.'))` before unmount.
- [ ] **Step 4:** `tools-shell`: the gate-file handshake for the chunk test
  (`printf a; while [ ! -f <gate> ]; do sleep 0.02; done; printf b`; the test creates
  the gate after it observes the `'a'` state, then awaits `{ text: 'ab', exitCode: 0 }`);
  and inject `found` into the description test via
  `runCommandDescription(config, ['git','bun'], start)` (`:119`) keeping one tolerant
  live-probe assertion.
- [ ] **Step 5: gates** — the three files GREEN ×4 each; `start-cwd.e2e` GREEN in one
  loaded loop (two concurrent workers, 5 runs).
- [ ] **Step 6: commit** `test(shell): the fixtures wait on content, the chunks on a gate`.

### Task 9: the acceptance run

- [ ] **Step 1:** `bun run typecheck && bun test ./src ./scripts ./packages` — three consecutive runs, all green. Every failure goes through the quarantine protocol (per name, reason, one targeted retry) — recorded in the issue. The one honest quarantine candidate going in is `tools-shell.test.ts`'s chunk-boundary name (it asserts a time-based pipe boundary; diag-shell-cwd.md) — only if Task 8's gate handshake does not hold it green.
- [ ] **Step 2:** report to issue #134: what was fixed, what (if anything) is quarantined and why; close it.
