# A task's writes — a property of the agent, not of the call

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** whether a task may write files and run commands is decided by the capability of the
agent it runs as — with a `worker` default that acts like the chat itself — and never by a
workflow remembering to pass a flag.

**Architecture:** one ternary capability (`TaskWrites = 'allow' | 'ask' | 'deny'`) on the child
spec and on an agent file's header replaces the boolean `write`. The capability picks the
child's `ConfirmPolicy` (`allow-writes` / `ask` / `always-no`), the child inherits the starting
conversation's auto mode unless it is `deny`, and a `deny` child is offered no write tools.

**Tech Stack:** TypeScript 7 (strict, NodeNext), Bun 1.4 (`bun test`).

**Spec:** this document — "Intent" through "Left to the builder" below (agreed 2026-11-16).

## Intent

A conversation started by the `subagent` tool, or from an agent file, carries a write
capability: `allow`, `ask`, or `deny`. A bare task is a worker — it may write and run commands
through the same confirmation channel the chat uses, and it inherits the session's auto mode.
Read-only is an explicit narrowing for review, search, and analysis work, not the default a
caller must remember to lift.

## Goals

- The `subagent` tool takes `writes: allow | ask | deny`; a call without it runs as `ask`.
  Legacy `write: true` maps to `ask`; an explicit legacy `write: false` maps to `deny`.
- An agent file carries a `writes:` line with the same three values. Starting from an agent
  file no longer implies writes on its own; the file states the capability.
- The child conversation inherits the auto mode of the conversation that started it, capped by
  its capability: `deny` never lifts (a denied class ignores auto mode entirely), `allow` never
  asks, `ask` decides per call the way the chat does.
- A `deny` child is offered no write or execute tools at all (write_file, edit_file,
  workspace_write, run_command, shell_kill) — its model never sees them to attempt them.
- Everything above is workflow-agnostic: no agent name, prompt, config key, or default in the
  host refers to any development process or skill.

## Non-goals

- Resource patterns or command rules ("write only in `src/`", "no `git push`").
- Project-wide persisted rules ("always allow this") or a permission-request UI.
- Reworking the chat's own confirm/auto flow into a rules engine.
- The `ask_parent`/`answer_child` timeout race: a writing task routes its writes through
  confirm, where the race does not bite.

## Anti-goals

- A workflow-tailored agent profile shipped in "the" way to run one process.
- Writes shown to the model and then refused at confirm time; a denied class hides the tools
  instead.

## Constraints

- `AGENTS.md`: English for specs, plans, and code comments; comments describe the code as it
  is. Behavior changes land in `CHANGELOG.md`.
- `agents.maxAuto` keeps capping an agent file's auto mode; the capability cap and that cap
  apply together.

## Approaches

1. **A full ruleset engine** — `allow | ask | deny` per action and resource, last-match-wins,
   saved project rules, the shape opencode ships. Rejected for now: larger than the need, and
   every part of it can be added later on top of one capability field.
2. **Capability classes (chosen):** one ternary on tasks and agent files, inheritance of auto
   mode capped by the class, and tool hiding for `deny`. One source of truth in place of the
   three mechanisms that answer "may this conversation write" today: the `write` flag, the
   `auto:` line, and the confirm policy. Small, and it grows into approach 1 when a need for
   resources shows up.
3. **An agent file per workflow** — the file grants writes, with no code changes. Rejected: it
   tailors the host's behavior to one development process, which is exactly what is not
   wanted.

## Decisions (agreed with the person)

- **Default `ask` (worker).** A task is presumed to be work; the guard against unwanted writes
  is consent (confirm, or an inherited auto mode), not a silent deny. Trade-off accepted: a
  "just look at it" task can write until a confirmation stops it — declare `deny` for those.
- **Inheritance with an absolute floor.** The child starts with the parent's auto mode; `deny`
  is never lifted by an inherited grant. (opencode merges session grants after agent rules and
  last-match-wins lets them override a deny; that hole is not reproduced.)
- **One field covers files and commands.** `run_command` is confirmed on the same channel as
  writes today; one capability governs both.
- **A task cannot grant itself `allow`.** The person's yes in advance is the person's to give:
  the `subagent` tool answers a model's `writes: 'allow'` as `ask`, with a note; only an agent
  file (person-authored, `writes: allow`) or a person-started run carries `allow`.

## Left to the builder

- The exact agent-file line name (`writes:` proposed) and refusal text wording.
- Where the tool-hiding filter sits relative to `turnShape` (`src/assistant/conversation-turn.ts`).
- Test naming and placement beside the existing conversation/confirm-policy suites.

---

## Global Constraints

- Specs, implementation plans, and code comments in English; comments present-tense, no
  history (AGENTS.md, "Language rule", "Comments describe the code as it is").
- TypeScript 7 strict `NodeNext`, Bun 1.4; tests run with `bun test`.
- AGENTS.md rules stay true by the code and the tests: the rules this change touches are
  updated in the task that changes the behavior.
- Behavior changes land in `CHANGELOG.md`.
- `agents.maxAuto` (`maxAutoOf`, `src/assistant/agent-start.ts:12`) keeps capping an agent
  file's `auto:` mode; nothing here lifts that cap.

## Review Focus

- A model declaring `writes: 'allow'` about its own task must not clear the person's consent
  — it becomes `ask`, with a note saying so. (Pinned by Task 2's "a task may not grant
  itself allow".)
- `write` and `writes` given together: `writes` wins; an explicit `write: false` is `deny`,
  not the new default. (Pinned by Task 2's "writes wins over write" and the `write: false` case.)
- A grandchild inherits what the session's mode grants, and a `deny` child never does — even
  in auto `all`. (Pinned by Task 1's inheritance tests and their `deny` counterpart.)
- An agent file with `writes: allow` runs without asking, while its `auto:` line is still the
  lower of what `agents.maxAuto` allows. (Pinned by Task 3's parse tests plus the existing
  `agent-start` cap tests.)
- A write-flagged plugin tool reaching a `deny` child is declined by the policy, not dropped,
  not crashed: hiding covers the host's own tools only. (Pinned by Task 4's "always-no
  declines a write tool that was not hidden".)

---

## Implementation plan

### Task 1: `TaskWrites` and the child's policy

**Files:**
- Modify: `src/assistant/conversation-types.ts:225-237` (`ChildSpec`)
- Modify: `src/assistant/confirm-policy.ts` (new `childPolicy` next to `ConfirmPolicy`)
- Modify: `src/assistant/conversation.ts:1187-1215` (`startChild`)
- Modify: `src/loader/tools-core.ts:845` and `src/plugins/assistant.ts:2162` (call sites, mapped one-to-one to today's behavior)
- Modify: `AGENTS.md` ("A conversation starts a child of its own": the child-policy sentence; the auto-mode section: the sentence "the chat's mode never reaches it" says the new inheritance)
- Test: `src/assistant/__tests__/child-writes.test.ts` (new), `src/assistant/__tests__/confirm-policy.test.ts` (extend)

**Interfaces:**
- Consumes: `ConfirmPolicy`, `confirmFor`, `writeLine` (`src/assistant/confirm-policy.ts`), `ConversationDeps.pushLog`, `Conversation.setAutoMode(mode, save)` (`src/assistant/conversation.ts:1119`).
- Produces: `export type TaskWrites = 'allow' | 'ask' | 'deny'` in `conversation-types.ts`;
  `ChildSpec.write?: boolean` replaced by `writes?: TaskWrites` (absent reads as `'ask'`);
  `export function childPolicy(writes: TaskWrites, mayVouch: boolean, say: (line: string) => void): ConfirmPolicy`
  in `confirm-policy.ts`. Later tasks rely on all three by these names.

- [ ] **Step 1: Write the failing tests** in `src/assistant/__tests__/confirm-policy.test.ts` style (sentence names, `bun:test` — see `child-schedule.test.ts` for fixtures):

```ts
test('a deny child is given always-no read-only, whatever its auto mode', ...)
  // childPolicy('deny', true, say) toEqual({ kind: 'always-no', reason: 'read-only' })
test('an ask child that may vouch is given ask', ...)
  // childPolicy('ask', true, say) toEqual({ kind: 'ask' })
test('an allow child that may vouch is given allow-writes and its say', ...)
  // childPolicy('allow', true, say) is { kind: 'allow-writes', say }; calling it through
  // confirmFor answers every write true and calls say(writeLine(name, args)) once each
test('a task that may not vouch gets cannot-ask, whatever it asked for', ...)
  // childPolicy('allow', false, say) and childPolicy('ask', false, say) both
  // toEqual({ kind: 'always-no', reason: 'cannot-ask' })
```

and in the new `src/assistant/__tests__/child-writes.test.ts`, integration through
`fakeDeps()` (`conversation-deps.ts`) and a parent `Conversation`:

```ts
test('a task inherits the auto mode of the conversation that started it', ...)
  // parent.setAutoMode('all', false); parent.startChild({ kind: 'task', label: 'w',
  //   prompt: 'p', by: 'model', writes: 'ask' }, 'j').child.autoMode === 'all'
test('a deny child does not inherit it', ...)
  // same parent, writes: 'deny' → child.autoMode === 'ask'
test('a task without a writes field inherits like a worker', ...)
  // spec without `writes`, parent auto 'all' → child.autoMode === 'all' (the policy itself
  // is childPolicy's own tests above)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/assistant/__tests__/confirm-policy.test.ts src/assistant/__tests__/child-writes.test.ts`
Expected: FAIL (`childPolicy` is not defined; `ChildSpec` has no `writes`).

- [ ] **Step 3: Implement.** In `conversation-types.ts` add `export type TaskWrites = 'allow' | 'ask' | 'deny'`, swap `ChildSpec`'s `write?: boolean` for `writes?: TaskWrites`, and reword that field's comment line to the new shape (present tense). In `confirm-policy.ts` add `childPolicy(writes, mayVouch, say)`: `deny` → `{ kind: 'always-no', reason: 'read-only' }`; `allow` → `mayVouch ? { kind: 'allow-writes', say } : { kind: 'always-no', reason: 'cannot-ask' }`; `ask` → `mayVouch ? { kind: 'ask' } : { kind: 'always-no', reason: 'cannot-ask' }`. In `startChild` replace the `wantsWrites`/`asks` pair (lines 1196-1207) with: `const writes = spec.writes ?? 'ask'`; `const mayVouch = (!this.parent || this.policy.kind === 'ask' || this.policy.kind === 'allow-writes') && host.deps.canAsk !== false`; `const policy = childPolicy(writes, mayVouch, (line) => this.deps.pushLog(`[bg] ${line}`))`; `canAsk: policy.kind === 'ask'` in the child's deps, `policy` passed to the `Conversation` constructor as before. After the child is configured (next to `child.model`), when `writes !== 'deny'`: `child.setAutoMode(this.autoMode, false)`. Update the two call sites to the new field (`tools-core.ts:845`: today's `writes` boolean becomes `writes: writes ? 'ask' : 'deny'`; `plugins/assistant.ts:2162`: `writes: 'ask'`) — the tool's own default lands in Task 2. Reword `AGENTS.md`'s two rule sentences this changes (the child-policy sentence and the auto-mode section's inheritance), present tense, no history.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/assistant/__tests__/confirm-policy.test.ts src/assistant/__tests__/child-writes.test.ts src/assistant/__tests__/conversation.test.ts src/assistant/__tests__/child-schedule.test.ts`
Expected: PASS, the older suites included (the `ChildSpec` rename touches them).

- [ ] **Step 5: Commit**

```bash
git add src/assistant/conversation-types.ts src/assistant/confirm-policy.ts src/assistant/conversation.ts src/loader/tools-core.ts src/plugins/assistant.ts AGENTS.md src/assistant/__tests__/
git commit -m "feat: a child's writes are a capability of its agent"
```

### Task 2: the `subagent` tool's `writes` argument

**Files:**
- Modify: `src/loader/tools-core.ts:436-451` (the `subagent` schema), `:793-852` (its exec)
- Modify: `CHANGELOG.md`, `AGENTS.md` (the `subagent` paragraph of "What the model can do": the sentences saying a task is read-only unless `write: true`)
- Test: `src/loader/__tests__/tools-core-writes.test.ts` (new)

**Interfaces:**
- Consumes: `TaskWrites` (Task 1).
- Produces: `export function taskWritesOf(args: { write?: unknown; writes?: unknown }): { writes: TaskWrites | 'error'; note: string }` in `tools-core.ts` — `note: ''` when nothing needs saying. The named-agent rule is Task 3's: until it lands, a named agent still resolves to `ask` here.

- [ ] **Step 1: Write the failing tests**

```ts
test('a task with no writes argument runs as ask', ...)
  // taskWritesOf({}) → { writes: 'ask', note: '' }
test('write: true maps to ask and write: false to deny', ...)
  // taskWritesOf({ write: true }) → { writes: 'ask', ... }; taskWritesOf({ write: false }) →
  // { writes: 'deny', ... }
test('writes wins over write when both are given', ...)
  // taskWritesOf({ writes: 'deny', write: true }) → { writes: 'deny', ... }
test('an unknown writes value is an error naming the three', ...)
  // taskWritesOf({ writes: 'yes' }) → { writes: 'error', note: containing 'allow, ask, deny' }
test('a task may not grant itself allow', ...)
  // taskWritesOf({ writes: 'allow' }) → { writes: 'ask', note: non-empty }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/loader/__tests__/tools-core-writes.test.ts`
Expected: FAIL (`taskWritesOf` is not defined).

- [ ] **Step 3: Implement.** Add `taskWritesOf` with the mapping above (a `Record<TaskWrites, true>` checks membership). In the schema replace the `write` property description with two properties: `writes` (`'string'`, "Optional: allow, ask (default) or deny — whether the task may write files and run commands; ask means each one waits for the person's yes, deny makes it a read-only task") and `write` kept as the legacy boolean ("Deprecated spelling: true reads as ask, false as deny"). In the description's prose (line 439) replace "The task runs read-only by default … `write: true` lets it ask the person…" with the worker default: tasks write and run commands through the person's y/n like the chat does, and the session's auto mode answers for them; `writes: 'deny'` makes a read-only task. In the exec, replace `const writes = args.write === true || !!named` with `const mapped = taskWritesOf(args); if (mapped.writes === 'error') return mapped.note;` and keep the named-agent grant for now (`writes: named ? 'ask' : mapped.writes`; Task 3 replaces it with the file's own value); append `mapped.note` to the notes in the tool's answer. Drop "It may ask the person to approve each write" from the answer unless the resolved value is `'ask'`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/loader/__tests__/tools-core-writes.test.ts`
Expected: PASS.

- [ ] **Step 5: CHANGELOG entry and commit**

In `CHANGELOG.md`'s current section, one entry: a background task writes and runs commands through the person's y/n (the session's auto mode answers), `writes: 'deny'` narrows a task to read-only, and `write:` remains as the deprecated spelling. Reword `AGENTS.md`'s `subagent` paragraph to match.

```bash
git add src/loader/tools-core.ts src/loader/__tests__/tools-core-writes.test.ts CHANGELOG.md AGENTS.md
git commit -m "feat: subagent takes writes, defaults to a worker"
```

### Task 3: the `writes` key of an agent file

**Files:**
- Modify: `src/assistant/agent-file.ts:23-40` (`Agent`, `AGENT_KEYS`), its parser near `:108-150`
- Modify: `src/assistant/agent-start.ts` (`planAgentStart`'s result)
- Modify: `src/loader/tools-core.ts` (the named branch: `!!named` no longer implies writes)
- Modify: `AGENTS.md` (agent files: the header-key list gains `writes:`)
- Test: `src/assistant/__tests__/agent-file.test.ts`, `src/assistant/__tests__/agent-start.test.ts` (extend)

**Interfaces:**
- Consumes: `TaskWrites` (Task 1); the exec rule from Task 2 ("a named agent's `writes` wins").
- Produces: `Agent.writes: TaskWrites | null` (null when the key is omitted — a task then runs as `ask`, what an agent file grants today); `planAgentStart`'s ok-result gains `writes: TaskWrites` (the file's value or `'ask'`).

- [ ] **Step 1: Write the failing tests**

```ts
test('an agent file with writes: deny parses to deny', ...)
  // parse of a file whose header has `writes: deny` → agent.writes === 'deny'
test('an omitted writes key means ask', ...)
  // a header without the key → agent.writes === null; planAgentStart's result .writes === 'ask'
test('a writes key with an unknown value is an error naming the three', ...)
  // `writes: maybe` → { ok: false, errors: [...] } with 'allow, ask, deny' in the message
test('the start plan carries the writes of its file', ...)
  // a file with `writes: allow` → planAgentStart(...).writes === 'allow'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/assistant/__tests__/agent-file.test.ts src/assistant/__tests__/agent-start.test.ts`
Expected: FAIL on the new names (`writes` unknown key / untyped).

- [ ] **Step 3: Implement.** `AGENT_KEYS` gains `'writes'`; `Agent` gains `writes: TaskWrites | null`; the parser maps the value with the same membership check as `taskWritesOf` (import the type from `conversation-types.ts`; the error names `allow, ask, deny` and the file's 1-based line, as every other parse error does). `planAgentStart` carries `writes: agent.writes ?? 'ask'`. In `tools-core.ts`'s named branch drop the `!!named` writes shortcut in favor of Task 2's rule. `AGENTS.md`'s agent-files section lists `writes: allow | ask | deny (omitted: ask)` beside the other keys, keeping the present tense of the surrounding rules.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/assistant/__tests__/agent-file.test.ts src/assistant/__tests__/agent-start.test.ts src/loader/__tests__/tools-core-writes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/assistant/agent-file.ts src/assistant/agent-start.ts src/loader/tools-core.ts AGENTS.md src/assistant/__tests__/
git commit -m "feat: an agent file states its writes"
```

### Task 4: a `deny` child is offered no write tools; the copy says the new shape

**Files:**
- Modify: `src/assistant/conversation-turn.ts:66-80` (withhold constants) and `src/assistant/conversation.ts:1200-1206` (the child's `chatLLM` withhold merge)
- Modify: `src/assistant/confirm-policy.ts:24` (`READ_ONLY_TASK_DECLINE`)
- Modify: `src/loader/tools-shell.ts:123` (the `run_command` description sentence about tasks), `src/loader/tools-core.ts:797,842` (comment lines in the exec)
- Test: `src/assistant/__tests__/child-writes.test.ts` (extend)

**Interfaces:**
- Consumes: `ChildSpec.writes` (Task 1).
- Produces: `export const WRITE_TOOLS_WITHHELD: readonly string[] = ['write_file', 'edit_file', 'workspace_write', 'run_command', 'shell_kill']` in `conversation-turn.ts`, beside `TASK_WITHHELD`.

- [ ] **Step 1: Write the failing tests**

```ts
test('a deny child is offered no write tools', ...)
  // the fakeDeps chatLLM records its options: a `writes: 'deny'` child's withholdTools
  // contains every name of WRITE_TOOLS_WITHHELD; a worker child's does not
test('always-no declines a write tool that was not hidden', ...)
  // confirmFor(childPolicy('deny', true, say), scope)('mcp:tool', '{}', {}) resolves false
test('the read-only decline names writes, not write: true', ...)
  // READ_ONLY_TASK_DECLINE toBe the pinned sentence below
```

Pinned copy (this is the one exact sentence the spec fixes):

```ts
export const READ_ONLY_TASK_DECLINE = 'This write was declined: this task is read-only, so it may not write or run commands. If the job must change something, the conversation that started it can start it again with writes: ask (each write then waits for the person\'s yes) or an agent file. Report what you found and what you would have changed.';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/assistant/__tests__/child-writes.test.ts`
Expected: FAIL on the withheld list and the packed sentence.

- [ ] **Step 3: Implement.** Add `WRITE_TOOLS_WITHHELD` (verify the five names against the host's own tool definitions: `host-group.ts` carries `write: true` tools, `tools-shell.ts:158,186` the shell's) and merge it into the child's `withholdTools` where `turnShape(spec.kind).withholdTools` is merged (conversation.ts:1203-1205) when `spec.writes === 'deny'`. Swap in the pinned `READ_ONLY_TASK_DECLINE`. Reword the `run_command` description's task sentence and the exec comments to the capability wording (no history: the text states what the code does). Policy enforcement is unchanged — `always-no` still declines whatever a plugin writes behind a hidden name.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/assistant/__tests__/child-writes.test.ts src/assistant/__tests__/confirm-policy.test.ts src/assistant/__tests__/conversation-turn.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/assistant/conversation-turn.ts src/assistant/conversation.ts src/assistant/confirm-policy.ts src/loader/tools-shell.ts src/loader/tools-core.ts src/assistant/__tests__/
git commit -m "feat: a read-only task sees no write tools"
```
