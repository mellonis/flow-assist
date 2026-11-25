# Review follow-ups — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** close the three review findings left deferred on `fix/flaky-tests` (issues #134's follow-ups): the MCP reply contract's silent holes, the preload's blind `try/catch`, and the 76 test files whose waits still give up silently.

**Design (approved with the human partner, A/A/A):**

1. **MCP reply.** A reply is a non-null, non-array object that carries `result` (after `error` is handled) — anything else is a loud `not a JSON-RPC answer`. `result: null` still resolves; `fromSse` already throws when the stream ends unanswered.
2. **Preload side effects.** The hooks and `retryClock.sleep` move to `helpers/preload-hooks.ts`, whose only consumer is `bunfig.toml`'s preload list. `helpers/test-setup.ts` keeps the documentation and `nativeFetch` alone, so the 135 files that import it for the pristine fetch can no longer run a plain `bun` script into `bun:test` hooks, and no runner detection (which the environment cannot give: a child inherits `NODE_ENV=test`) and no `catch` is needed.
3. **Waits.** One shared `settleUntil(ok, budget, label?)` — `budget` is a settle count or `{ ms }`; every local waiter delegates to it, keeping its own default budget, so a give-up always names itself. A tripwire test refuses a local waiter that does not delegate.

**Tech stack:** Bun 1.4, TypeScript 7, `bun:test`, the bundled `plugins-available/mcp` plugin.

**Acceptance:** `bun run typecheck && bun test ./src ./scripts ./packages` green three times in a row, plus `cd plugins-available/mcp && bun test`.

---

## Task 1 — the MCP reply contract

- [ ] RED: in `plugins-available/mcp/src/__tests__/mcp.test.ts` add cases that must reject with `/not a JSON-RPC answer/`: `{jsonrpc, id}` only; a bare string body; an array body; `{error: null, id}`. Keep the `result: null` case green.
- [ ] Run `cd plugins-available/mcp && bun test` — the new names fail.
- [ ] In `client.ts` `request`: require a non-null, non-array object, then `'result' in message` after the `error` branch.
- [ ] Run the plugin suite green; run `bun test src/__tests__/mcp.e2e.test.ts` green.

## Task 2 — the preload's side effects leave the importable module

- [ ] RED: a new `helpers/preload-side-effects.test.ts` spawns a plain `bun` script that imports `helpers/scripted.ts` and asserts (a) it exits 0 with the current `test-setup.ts` (this passes before the change — the crash was fixed by the catch) and (b) `retryClock.sleep` is not the test no-op. (b) fails before the change: the importable module currently installs the no-op.
- [ ] Create `helpers/preload-hooks.ts` with the `retryClock.sleep` no-op and the `beforeEach`/`afterEach` bodies, imported by `bunfig.toml` after `test-setup.ts`.
- [ ] Reduce `test-setup.ts` to its documentation plus `nativeFetch`; update the header, `preload-isolation.test.ts`'s comment and `helpers/disposal.ts`'s "registered by the preload" note.
- [ ] Green: `bun test src/__tests__/helpers/ src/__tests__/signal-exit.e2e.test.ts`.

## Task 3 — one wait, one budget

- [ ] RED: in `helpers/settle-until.test.ts` add: a count budget that holds late passes; a `{ ms }` budget that gives up after the wall time and names its label; a count budget that gives up naming the label; the label defaults to the condition's source.
- [ ] Extend `settleUntil(ok, budget = 400, label?)` in `helpers/scripted.ts`.
- [ ] Green: `bun test src/__tests__/helpers/`.

## Task 4 — the sweep (69 `settleUntil` files)

- [ ] Rewrite by script, one batch of ~10 files at a time: a `n = 400` file imports the shared one and drops its definition; any other default becomes a delegating alias (`(ok, n = 100) => settleUntil(ok, n)`); an ms default becomes `(ok, ms = 3000) => settleUntil(ok, { ms })`, with the shared import aliased where the local name is kept.
- [ ] After each batch: `bun run typecheck:tests` and `bun test <the batch's files>`.
- [ ] Any give-up the conversion surfaces is a dead wait: read the test, fix the premise (fixture or clock) — never shorten the wait to hide it; record each in the ledger.

## Task 5 — the `until` variants and the tripwire

- [ ] The four `until(ui, ok, what, n)` delegate to the shared wait and re-throw with the frame appended; the two `until(ok, label, n)` delegate with their label.
- [ ] New `helpers/no-silent-waits.test.ts`: every `const settleUntil =` / `const until =` in `src/__tests__/**/*.test.ts` must reference the shared `settleUntil(` within its definition — RED on the pre-sweep tree, green after.
- [ ] `rg` gate: no `for (let i = 0; i < n && !ok(); i++)` local loop and no `while (Date.now()` wait remains in a test file.

## Task 6 — acceptance

- [ ] `bun run typecheck && bun test ./src ./scripts ./packages` three times, green each.
- [ ] `cd plugins-available/mcp && bun test` green.
- [ ] Ledger: `.superpowers/sdd/2026-11-24-flaky-tests/progress.md` gets one line per task with its commands.
