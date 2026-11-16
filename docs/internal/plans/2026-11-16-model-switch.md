# `/model` — the session's model, chosen in the chat

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/model` in the chat picks the model the current session runs — saved with the session, never touching the config — and the frame's title says what that model is.

**Architecture:** The plumbing landed with PR #123 — `Conversation.model`, `effectiveModel()`, `contextWindow()`, and the request's `withModel(llmOpts(ai), c.model)`. This adds the person's side: a `model` field in the session file, two pure choosers over `ai.roles`/`ai.models` in `model-roles.ts`, the `/model` command, a command panel to pick from, and the model on the frame's title.

**Tech Stack:** TypeScript 7 (strict, NodeNext), Bun 1.4 (`bun test`), React 19 + `@flowtty/react`.

**Spec:** this document — "Intent" through "Left to the builder" below (agreed 2026-11-16).

---

followup to [#120](https://github.com/mellonis/flow-assist/issues/120) (the models plan,
`2026-11-15-agent-models.md`, landed as PR #123). The issue's "Not this" cut a per-session
switch; the requirement was for one. This is the "different design" that plan said nothing
here blocks.

## Intent

The selection is the session's — it takes precedence over `ai.model` and never rewrites the
config: the selection applies to the current session and does not change the configuration.
(This is the behaviour opencode ships as its `/models` — the one provenance note in this
document; the product docs state it as ours.)

## Goals

- `/model` alone opens a panel over the conversation's place; `/model <name>` sets it
  directly. The panel lists what the config knows: `default (<ai.model>)` first, then the
  roles — `deep → big-model · 512k` — then the ids of `ai.models` no role names, each with its
  window. The row the session runs now is marked.
- `<name>` is a role or a model id **of the catalogue** (`ai.models`, plus
  `default`): the person's own vocabulary — unlike the `subagent` tool and an agent file's
  `model:`, nothing keeps them from naming an id. A name neither `ai.roles` nor `ai.models`
  knows is refused with a pointer to the list (`no model or role "<name>" here (/model
  lists them)`), so a typo never becomes a provider error at the first request.
- The choice is the conversation's model: `Conversation.model`, so `effectiveModel()`, the
  window (`ctx N%`, `/context`, auto-compaction, recall) and every child's inheritance
  follow with no further changes. It is fixed for a turn in flight: the model reaches the
  request once per turn (`withModel(llmOpts(ai), c.model)` at `runTurn`), so a switch lands
  on the next turn.
- The selection is saved in the session file (`model`, with `summary`), and comes back with
  `/resume`, a picker open and a restart's continue. A session without the field runs
  `ai.model`, as every session does today.
- The frame's title says the model after the name: `ƒ Flow Assist (big-model)`.
- The switch is said in the chat — one `note` row — and `/model` alone changes nothing.

## Non-goals

- Not the model's to set: `ai` is the leash, `config_set` refuses it. The person types it.
- No picker above the chat, no app-wide keybind, no model in the hint row (it carries the
  running tool or verb and the mode badges), no change to `/agents`.
- Agent files and the `subagent` tool stay on roles only. `/model` writes no role anywhere.
- Compaction stays on the conversation's model (see "Known edge").
- One-shot prompt, background tasks and the session picker's rows: unchanged.

## Known edge (my call)

Compaction runs on the conversation's model, so a session switched DOWN while its history is
big can fail to compact — the summary request sends the whole history (`foldIntoHandoff`).
Today the provider's error is what the person sees; the `keep`-tail followup
(`_followups.md`) is the real fix. Do not move compaction onto `ai.model`: one conversation
runs one model, and `/compact` is part of that conversation.

## Approaches

- **A — a picker over what the config knows: roles first, then `ai.models` ids. Chosen.**
  It is opencode's shape, and the window beside each row is what the person is actually
  choosing between. Cost: the picker is only as good as the `ai.models` catalogue.
- B — roles only: the session names a role, re-resolved at each start, so a change to
  `ai.roles` moves every session. More portable, but "run this once on the cheap one"
  would need a role made up for it.
- C — no picker, `/model <name>` typed only: cheapest, and loses not having to remember the
  names.

## The how, as decided

- The command joins `CHAT_COMMAND_DEFS` (`src/plugins/assistant.ts`) with `values` in its
  function form (`default` first, then the roles, then the ids — a list that follows the
  config), and is kept in ↑ like `/notes`.
- **`/model` bare opens the chat's command panel** (`PanelSpec` /
  `renderCommandPanel` — `/agents` and `/mcp`'s own machinery, which already stands in the
  conversation's place under the session picker's rules: it holds every key, Esc closes,
  `/clear` / `/new` / `/resume` / `/sessions` drop it). Rows are what `modelRows` returns;
  `return` sets the row under the cursor. Far less code than a picker of its own, and the
  same look.
- The model is on the frame's title: `ƒ Flow Assist (<model>)`, and after ` · ` still come
  the watch's path, the pager's block or the chat's subject.
- Rows, tests and wording follow the host's rules: neutral ids in tests
  (`small-model`/`big-model`), `keyGlyph`/`bindingGlyph` for the keys in hints, one look
  with the other host modals.

## Left to the builder

Tests — named per task below. Nothing else is open.

---

## Global Constraints

- **No endpoint's real model id in tests, source or docs.** Ids: `small-model`,
  `default-model`, `big-model`, `unlisted-model`, `other-model`; roles: `fast`, `deep`.
- Agent files and the `subagent` tool name a ROLE (`fast`); `/model` and the config name ids.
- Comments are English, present tense, describing the code as it is — never how it got
  there ("used to", "no longer", "now does X").
- Commits: Conventional Commits, English, GPG-signed (`git commit -S`); never a
  `Co-Authored-By` trailer, never `--force`, never `gpgconf --kill gpg-agent`.
- `HOST_API` unchanged; nothing under `ai` gains a mark (`config_set` refuses the switch).
- A key is drawn through `keyGlyph` / `host.keyCap(keys[action])`, never spelled by hand.
- `bun run typecheck && bun test ./src ./scripts ./packages` is the gate. Known flakes
  (they pass alone, or fail the same way on `master`): `mcp.e2e`, `tools-shell`,
  `start-cwd`, `subagent-ask`, `leave-busy`, `subagent-question`, `subagent-tree`,
  `subagent-agent-start`, `shell-job` under load.
- Work docs go to `docs/internal/plans/` — never `docs/superpowers/`.
- Work happens on a new branch off updated `master`, in a worktree (`superpowers:using-git-worktrees` at execution time).

## Review Focus

- **A session's id that later leaves `ai.models`** — it keeps running that id and its window
  falls back (`ai.contextWindow`, else 200000); the host never refuses it, the endpoint
  decides. → Task 1's `a session records the model it runs …` + the window assertion.
- **A switch made while a turn runs** — the turn in flight keeps the model it started with;
  the next turn takes the new one. → Task 2's `a switch while an answer streams …`.
- **A session file with no `model`** — an older host's, or one the person reset: it runs
  `ai.model` and the request carries no `model` key at all. → Task 1's `a session with no
  model …`.
- **A name neither role nor catalogue id** — refused at the command with the list, nothing
  set, no row claimed done. → Task 2's `an unknown name is refused …`.
- **A role and an id of the same name** — the role wins (the person's vocabulary), and what
  is stored is the id it resolves to. → Task 2's pure test `a role wins over an id …`.

---

## Task 1 — the session's model

**Files:**
- Modify: `src/assistant/sessions.ts` (the `Session` interface ~:70, the reader ~:425-452)
- Modify: `src/assistant/conversation-session.ts` (`snapshotSession` :91, `applySession` :327)
- Test: `src/__tests__/session-model.rig.test.ts` (new)

**Interfaces:**
- Consumes: `Conversation.model` / `effectiveModel()` (PR #123).
- Produces: `Session.model?: string` — the model id the session runs, absent when it runs
  `ai.model`; `snapshotSession` writes it from `Conversation.model`, `applySession` reads it
  back into `Conversation.model`.

- [ ] **Step 1: Write the failing tests** in `src/__tests__/session-model.rig.test.ts`:

```ts
test('a session records the model it runs, and opening it back brings it', async () => {
  const rig = await conversationRig(model, { ai: { model: 'default-model', models: { 'big-model': { contextWindow: 512000 } } } });
  rig.conv.model = 'big-model';
  await rig.conv.send('hello');
  const id = rig.conv.sessionId!;
  rig.fresh();
  rig.open(id);
  expect(rig.conv.model).toBe('big-model');
  await rig.conv.send('again');
  expect(model.requests.at(-1)?.model).toBe('big-model');
});

test('a session with no model runs ai.model, and the request carries no model key', async () => {
  const rig = await conversationRig(model, { ai: { model: 'default-model' } });
  await rig.conv.send('hello');
  expect(rig.conv.model).toBeUndefined();
  expect(Object.hasOwn(model.requests.at(-1)!, 'model')).toBe(false);
});

test('a model the catalogue does not name still runs, on the window ai.contextWindow stands for', async () => {
  const rig = await conversationRig(model, { ai: { model: 'default-model', contextWindow: 90000 } });
  rig.conv.model = 'unlisted-model';
  await rig.conv.send('hello');
  expect(model.requests.at(-1)?.model).toBe('unlisted-model');
  expect(rig.conv.contextWindow()).toBe(90000);
});
```

(The request body is `model.requests.at(-1)` — `rig.sent(i)` is the messages, not the body;
`subagent-model.rig.test.ts` reads the same field the same way.)

- [ ] **Step 2: Run them to see them fail** — `bun test ./src/__tests__/session-model.rig.test.ts`,
  expecting the first to fail on `rig.conv.model` being dropped by the save/open round-trip.

- [ ] **Step 3: Implement the field.** `Session` gains, beside `summary`:
  `model?: string; // the model id this session runs; absent — ai.model`. In the reader
  (`loadSession`'s returned object) `model: typeof s.model === 'string' && s.model ? s.model : undefined`,
  beside `autoMode`'s. In `snapshotSession`, `...(c.model ? { model: c.model } : {})`, beside
  the `autoMode` line. In `applySession`, `c.model = s.model ?? undefined;` beside
  `c.setAutoMode(...)`.

- [ ] **Step 4: Run the tests to see them pass**, then the neighbours —
  `bun test ./src/__tests__/subagent-model.rig.test.ts ./src/assistant/__tests__/model-roles.test.ts`
  and `bun run typecheck`.

- [ ] **Step 5: Commit** — `feat(sessions): a session records the model it runs`.

## Task 2 — `/model <name>` and the chooser

**Files:**
- Modify: `src/assistant/model-roles.ts`
- Modify: `src/plugins/assistant.ts` (`CHAT_COMMAND_DEFS` :105, the `case 'mode'` switch ~:1621)
- Test: `src/assistant/__tests__/model-roles.test.ts`, `src/__tests__/session-model.rig.test.ts`,
  `src/__tests__/model-switch.e2e.test.ts` (new)

**Interfaces:**
- Consumes: `modelWindow(ai, id)` (PR #123), `Session.model` (Task 1).
- Produces, in `model-roles.ts` (pure, `ai` first — the same input `roleStart` takes):
  - `type ModelRow = { name: string; model: string | null; label: string; window?: number }`
    — `name` is what the person selects (`default` | a role | an id), `model` the id it runs
    (null — the `default` row, back to `ai.model`), `label` what is read
    (`default (default-model)`, `deep → big-model`, `big-model`), `window` the catalogue's.
  - `modelRows(ai: unknown): ModelRow[]` — `default` first (its label names `baseModel(ai)`),
    then one row per role (`ai.roles`, in the order the keys come), then ids of `ai.models`
    no role maps to. A role and an id of the same name appear once, as the role's row; the
    rows are what a panel draws, not the whole vocabulary a name may come from.
  - `modelChoice(ai: unknown, name: unknown): { model: string | null } | { error: string }`
    — `default` → `{ model: null }` (clear the session's own); a role → its id; any id of
    `ai.models` → itself, an id a role maps to included; anything else →
    `{ error: 'no model or role "<name>" here (/model lists them)' }`.
    A role wins over an id of the same name.

- [ ] **Step 1: Write the failing tests** in `src/assistant/__tests__/model-roles.test.ts`
  (the file's existing `ai` fixtures): `modelChoice` resolves `fast` to `small-model`, a
  catalogue id to itself, `default` to `{ model: null }`, an unknown name to an error naming
  the list, and a role of the same name as an id wins; `modelRows` puts `default` first,
  carries each row's window, lists `unlisted-model`'s id only when `ai.models` names it,
  lists a role's id once, and its labels read `default (default-model)` for the reset,
  `deep → big-model` for a role's row, `big-model` for a bare id's.

- [ ] **Step 2: Run to see them fail** — `bun test ./src/assistant/__tests__/model-roles.test.ts`
  (the two functions do not exist).

- [ ] **Step 3: Implement `modelRows` and `modelChoice`** in `src/assistant/model-roles.ts`,
  beside `roleStart` — one walk of `ai.roles`/`ai.models` each, no I/O.

- [ ] **Step 4: The command.** `CHAT_COMMAND_DEFS` gains
  `{ name: 'model', description: 'the model this conversation runs', values: () => modelRows(ai).map((r) => ({ value: r.name, label: r.label })) }`
  (`ai` is read where the command is registered — `chatCommandDefs` reads config for
  `/resume`'s values the same way; match `Command.values`'s function form as the file
  already uses it). The switch gains, beside `case 'mode'`:

```ts
case 'model': {
  // Whose model this conversation runs. The config defines the names; the choice is the
  // session's and is saved with it, never written back to the config.
  const name = arg.trim();
  setField('');
  const ai = conv.deps.config().ai;
  if (!name) {
    // Where things stand. Task 3 opens the panel in this branch's place.
    conv.pushNote(`model: ${conv.effectiveModel() ?? 'the provider\'s default'} · /model <name> to change`);
    host.notify();
    return;
  }
  const got = modelChoice(ai, name);
  if ('error' in got) { setError(got.error); return; }
  conv.model = got.model ?? undefined; // `null` — back to ai.model
  conv.save();
  const row = modelRows(ai).find((r) => r.name === name);
  conv.pushNote(`model: ${row?.label ?? name}`);
  host.notify();
  return;
}
```

  `baseModel` and `effectiveModel()` are already there. The note is the row's own label:
  `model: big-model` for an id, `model: deep → big-model` for a role, `model: default
  (default-model)` for the reset. The bare branch's comment describes what the code does
  now ("said where things stand") — the plan's `Task 3 …` line is a marker for the next
  task and must not be written into the code.

- [ ] **Step 5: The end-to-end tests** in `src/__tests__/model-switch.e2e.test.ts`, on the
  scripted model and `bootApp`'s `ai`: typing `/model deep` says `model: deep → big-model`
  and the next request carries `big-model`; `/model default` clears it and the request falls
  back; `/model nope` prints the error and changes nothing; `/model deep` while an answer
  streams (a `hold`) leaves the running turn's request on the old model and the next turn on
  the new one (Review Focus).

- [ ] **Step 6: Run the tests and typecheck, commit** —
  `bun test ./src/assistant/__tests__/model-roles.test.ts ./src/__tests__/session-model.rig.test.ts ./src/__tests__/model-switch.e2e.test.ts`
  then `bun run typecheck`; `feat(chat): /model names the model this conversation runs`.

## Task 3 — the panel, and the model on the frame

**Files:**
- Modify: `src/plugins/assistant.ts` (the `case 'model'` bare branch, `renderChatModal`'s props)
- Modify: `src/views/modals.ts` (`renderChatModal`'s `borderTitle` :1906-1908)
- Test: `src/__tests__/model-switch.e2e.test.ts`

**Interfaces:**
- Consumes: `modelRows` (Task 2), `PanelSpec` / `openPanel` (`src/assistant/command-panel.ts`,
  already bound in the chat at `:1543`), `Conversation.effectiveModel()`.
- Produces: `renderChatModal` gains `model?: string` — the id the frame's title names.

- [ ] **Step 1: Write the failing tests** in `src/__tests__/model-switch.e2e.test.ts`: `/model`
  opens the panel titled `Model`, its rows are `default (default-model)`, `deep → big-model`,
  `fast → small-model` in that order with their windows; `return` on `deep` sets and closes;
  `esc` closes changing nothing; and the chat's frame reads `ƒ Flow Assist (default-model)`,
  `ƒ Flow Assist (big-model)` after a switch.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement.** The bare `/model` branch calls
  `openPanel({ title: 'Model', rows: () => modelRows(ai).map((r) => ({ id: r.name, text: r.label, detail: r.window ? short(r.window) : undefined, tone: r.model === (conv.model ?? null) ? 'ok' : undefined })), keys: [{ key: 'return', label: 'use', run: onPick }] })`
  — the marked row is the one the person's choice names (`default` when the session runs
  `ai.model`), `short` is `src/assistant/context-meter.ts`'s, `onPick` the same set path
  `/model <name>` takes (share it as one local function the case's branch calls, not a
  copy). The frame's
  title: `renderChatModal` gains `model` and every branch of `borderTitle` becomes
  `` `${ASSISTANT_MARK} Flow Assist${model ? ` (${model})` : ''}` `` with its ` · …` tail
  after it; the chat passes `conv.effectiveModel()`.

- [ ] **Step 4: Run the tests and typecheck, commit** —
  `bun test ./src/__tests__/model-switch.e2e.test.ts ./src/__tests__/chat-context.e2e.test.ts`
  (the title's other holders), then `bun run typecheck`;
  `feat(chat): a panel to pick the session's model, and the model on the frame`.

## Task 4 — the pages

**Files:**
- Modify: `docs/usage.md`, `docs/config.md`, `AGENTS.md`, `CHANGELOG.md`

- [ ] **Step 1: Write.** `docs/usage.md` — "Which model it runs" gains a `/model` paragraph
  (the panel, `<name>` as a role or a catalogue id, saved with the session, `/model default`
  to go back, the config never touched) and a line on the one edge: a big history compacted
  on a smaller model may not fit its window (`/compact` then fails at the provider; the
  `keep`-tail followup is the fix). `docs/config.md` — a line in "Models and roles" on the
  switch and that it writes nothing. `AGENTS.md` — the chat's command list gains
  `/model`, and the `(models)` bullet grows its first clause: a session's own model (set by
  `/model`, saved in the session file) else `ai.model` else the provider's default; the
  frame's title names it. `CHANGELOG.md` — one entry under Unreleased, first, in the file's
  voice.

- [ ] **Step 2: `bun test ./src/__tests__/docs.test.ts` and `bun run typecheck`, commit** —
  `docs: a session's model, chosen in the chat`.
