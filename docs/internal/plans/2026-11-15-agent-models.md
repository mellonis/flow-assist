# Models: roles in the config, a role in an agent file and on the `subagent` tool

Issue: [#120](https://github.com/mellonis/flow-assist/issues/120). Branch
`feat/agent-models`, from `master` (`c111d0b`).

Today one model serves the whole process: `ai.model`, read by `llmOpts(config.ai)` in
`src/assistant/llm-endpoint.ts` and spread into every request the host makes. A
mechanical job — read a file, write a ticket — pays the deep model's price, and an agent
file cannot say otherwise without naming a model id, which binds the file to one machine.

This plan adds three things and one rule:

- `ai.models.<id>.contextWindow` — what a model can hold, by model id.
- `ai.roles.<role>` — the model id a name means on this machine.
- `model:` in an agent file, and `model` on the `subagent` tool — always a ROLE.
- A conversation runs one model id, and its window follows it.

The rule: **an agent file and the tool speak roles; the config speaks model ids.** A
role the machine does not define degrades to the conversation's model with one note,
the way an unknown tool group already degrades.

## The contract this plan builds

- **Resolution.** A conversation's model is `conversation.model` (a child's role,
  resolved at its start through `ai.roles`), else `ai.model`, else nothing — and
  nothing means the provider's own default, exactly as today.
- **Inheritance.** A child started without a role runs its parent's model. The parent's
  model is materialised on the child at its start, so a task started by a subagent that
  runs `coder-mini` runs `coder-mini` too.
- **`ai.model` is never read as a role.** It is a model id; a role that resolved to
  itself would be a circle.
- **An unknown role is not an error.** The agent or the task runs on the conversation's
  model, and the chat says `role "fast" is not defined (ai.roles) — using the
  conversation's model` (the tool's answer carries the same line, so the model knows
  what it got).
- **The window follows the model.** `Conversation.contextWindow()` reads the window of
  the conversation's own model: `ai.models.<id>.contextWindow`, else `ai.contextWindow`,
  else 200 000. `ctx N%`, `/context`, the automatic compaction and the recall threshold
  all read it through that one method, so they follow without further changes.
- **Compaction runs on the conversation's model.** The summary is written from the whole
  history, so a model with a smaller window cannot compact a larger conversation. That
  stays out of scope here; `_followups.md` records the `keep` tail it needs (opencode's
  `compaction.keep`: the newest N tokens kept verbatim beside the summary).
- **Nothing is the model's to set.** Both keys live under `ai`, the model's own leash
  (`src/config/schema.ts`, `LEASH_ROOTS`): no marks, no `config_set`, only the person.
- **No `HOST_API` change.** Everything here is the host's own: the plugin contract, the
  shape, `host.open`, the manifest — none of it moves.
- **No new UI surface.** `/agents` names a child's model when it differs from the
  chat's; the journal's start line carries it. The status line is untouched.
- **A session does not record its model.** A saved session re-runs on `ai.model` at the
  next start, like the endpoint it was written against. Only a child carries a model of
  its own, and it lives as long as the child.
- **A run with no conversation of its own** — the one-shot prompt, a plugin's
  `services.chatLLM` — keeps `ai.model`: nothing there names a role.

## File structure

New:

- `src/assistant/model-roles.ts` — the whole resolution, pure.
- `src/assistant/__tests__/model-roles.test.ts` — the resolution, the schema's shape.
- `src/__tests__/subagent-model.rig.test.ts` — a conversation, a role, the requests.

Modified:

- `src/assistant/llm-endpoint.ts` — `withModel`.
- `src/config/schema.ts` — `ai.models`, `ai.roles`.
- `src/assistant/conversation.ts` — `model`, `effectiveModel()`, `contextWindow()`,
  `startChild`, `tree()`.
- `src/assistant/conversation-turn.ts` — the two `llmOpts` sites, `agentStarterOf`.
- `src/assistant/conversation-types.ts` — `ChildSpec.model`, `TreeNode.model`.
- `src/assistant/agent-file.ts` — `model:` in the header.
- `src/assistant/agent-model.ts` — the role in `planAgentStart`, the note.
- `src/assistant/agent-tree.ts` — a model in `/agents`.
- `src/loader/tools-core.ts` — the tool's `model` argument and its note.
- `src/plugins/assistant.ts` — the person's `/subagent @agent` start, the `/agents` panel.
- `docs/usage.md`, `docs/config.md`, `AGENTS.md`, `CHANGELOG.md`,
  `docs/internal/plans/_followups.md`.

## Task 1 — The catalogue and the one resolution

**Files:** `src/assistant/model-roles.ts` (new), `src/assistant/llm-endpoint.ts`,
`src/assistant/__tests__/model-roles.test.ts` (new).

**Test first** (`model-roles.test.ts`):

```ts
import { describe, expect, test } from 'bun:test';
import { baseModel, modelWindow, roleModel, roleStart } from '../model-roles.ts';
import { withModel, llmOpts } from '../llm-endpoint.ts';
import { DEFAULT_CONTEXT_WINDOW } from '../context-meter.ts';
import { hostConfigSchema } from '../../config/schema.ts';

const ai = { model: 'coder-medium', roles: { fast: 'coder-mini' }, models: { 'coder-mini': { contextWindow: 256_000 }, coder: { contextWindow: 512_000 } }, contextWindow: 300_000 };

describe('roles', () => {
  test('a role is the model id ai.roles names for it', () => {
    expect(roleModel(ai, 'fast')).toBe('coder-mini');
    expect(roleModel(ai, '  fast  ')).toBe('coder-mini');
  });
  test('a role nothing defines has no model', () => {
    expect(roleModel(ai, 'deep')).toBeUndefined();
    expect(roleModel(ai, '')).toBeUndefined();
    expect(roleModel(ai, undefined)).toBeUndefined();
  });
  test('ai.model is a model id, never read as a role', () => {
    expect(baseModel({ model: 'fast', roles: { fast: 'coder-mini' } })).toBe('fast');
    expect(baseModel({})).toBeUndefined();
  });
  test('a start that asks for a role gets the model, or one note', () => {
    expect(roleStart(ai, 'fast')).toEqual({ model: 'coder-mini' });
    expect(roleStart(ai, 'deep')).toEqual({ note: 'role "deep" is not defined (ai.roles) — using the conversation\'s model' });
    expect(roleStart(ai, '')).toEqual({});
  });
});

describe('the window', () => {
  test('a model in the catalogue has its own', () => {
    expect(modelWindow(ai, 'coder')).toBe(512_000);
    expect(modelWindow(ai, 'coder-mini')).toBe(256_000);
  });
  test('a model the catalogue does not name falls back to ai.contextWindow', () => {
    expect(modelWindow(ai, 'gpt-x')).toBe(300_000);
    expect(modelWindow(ai, undefined)).toBe(300_000);
  });
  test('with neither, 200k — and a nonsense value is no value', () => {
    expect(modelWindow({}, undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(modelWindow({ models: { x: { contextWindow: 0 } }, contextWindow: -1 }, 'x')).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

describe('withModel', () => {
  test('a conversation on its own model overrides ai.model, and nothing else', () => {
    const base = llmOpts({ model: 'coder-medium', maxTokens: 4096 });
    expect(withModel(base, 'coder-mini')).toMatchObject({ model: 'coder-mini', maxTokens: 4096 });
    expect(withModel(base, 'coder-mini').provider).toBe(base.provider);
  });
  test('no model of its own leaves the options as they are', () => {
    const base = llmOpts({ model: 'coder-medium' });
    expect(withModel(base, undefined)).toBe(base);
  });
});

describe('the schema', () => {
  test('takes the catalogue and the roles', () => {
    const parsed = hostConfigSchema.parse({ ai: { models: { coder: { contextWindow: 512_000 } }, roles: { fast: 'coder-mini' } } });
    expect(parsed.ai?.models).toEqual({ coder: { contextWindow: 512_000 } });
    expect(parsed.ai?.roles).toEqual({ fast: 'coder-mini' });
  });
  test('refuses a window that is not a positive integer', () => {
    expect(hostConfigSchema.safeParse({ ai: { models: { coder: { contextWindow: 0 } } } }).success).toBe(false);
    expect(hostConfigSchema.safeParse({ ai: { models: { coder: { contextWindow: 1.5 } } } }).success).toBe(false);
  });
});
```

**Run it** — it fails: the module does not exist.

**Implement** `src/assistant/model-roles.ts`:

```ts
// What a model is and what it can hold (`config.ai`): the window of each model id, the
// roles a person defines, and the one place a role becomes a model id. A conversation
// runs ONE model id; an agent file and the `subagent` tool ask for a ROLE, so a file that
// travels between machines names `fast` and the machine says what that runs on
// (AGENTS.md (models)). Pure: `config.ai` in, values out.
import { DEFAULT_CONTEXT_WINDOW } from './context-meter.js';

interface AiConfig {
  model?: unknown;
  contextWindow?: unknown;
  models?: Record<string, { contextWindow?: unknown } | undefined>;
  roles?: Record<string, unknown>;
}

const asAi = (ai: unknown): AiConfig => (ai && typeof ai === 'object' ? (ai as AiConfig) : {});
const name = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const positive = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};

// `ai.model` as written — a model id, never a role.
export function baseModel(ai: unknown): string | undefined {
  return name(asAi(ai).model);
}

// The model id a role runs on this machine, or undefined when `ai.roles` does not define
// it (the start then degrades: the conversation's model, and one note).
export function roleModel(ai: unknown, role: unknown): string | undefined {
  const key = name(role);
  return key ? name(asAi(ai).roles?.[key]) : undefined;
}

// The window of a model id: its own entry in `ai.models`, else `ai.contextWindow` for a
// model the catalogue does not name, else 200k. A conversation measures against the
// window of the model it runs — `ctx N%`, the automatic compaction, the recall threshold.
export function modelWindow(ai: unknown, model: string | undefined): number {
  const cfg = asAi(ai);
  const id = name(model);
  return positive(id ? cfg.models?.[id]?.contextWindow : undefined) ?? positive(cfg.contextWindow) ?? DEFAULT_CONTEXT_WINDOW;
}

// What a start that asked for a role gets: the model id, or the line the chat and the
// tool say when the role is not defined here. The work goes on either way.
export function roleStart(ai: unknown, role: unknown): { model?: string; note?: string } {
  const key = name(role);
  if (!key) return {};
  const model = roleModel(ai, key);
  return model ? { model } : { note: `role "${key}" is not defined (ai.roles) — using the conversation's model` };
}
```

And in `llm-endpoint.ts`, beside `llmOpts`:

```ts
// The same options on another model: a conversation that runs a model of its own (a
// child's role) overrides what `ai.model` says, and everything else stays.
export function withModel(opts: LlmOpts, model: string | undefined): LlmOpts {
  return model ? { ...opts, model } : opts;
}
```

**Run** the test file; then `bun run typecheck`.

**Commit:** `feat(models): a catalogue of windows, roles, and the one place a role becomes a model`

## Task 2 — The two keys in the config

**Files:** `src/config/schema.ts`.

Inside `ai`, after `model: z.string().optional(),` add:

```ts
    // What a role draws on (`src/assistant/model-roles.ts`):
    // `models.<id>.contextWindow` is one model's window — the API cannot be asked for it,
    // and the meter, the automatic compaction and the recall threshold measure against the
    // window of the model a conversation runs; `roles.<name>` is the model id an agent
    // file's `model:` or the subagent tool's `model` means here. `ai.contextWindow` is the
    // window of a model the catalogue does not name (200000 otherwise).
    models: z.record(z.string(), z.object({ contextWindow: z.number().int().positive() }).partial()).optional(),
    roles: z.record(z.string(), z.string()).optional(),
```

**Test** — the two `describe('the schema')` cases in Task 1's file, run again.

**Then** the notes the model reads (`KEY_DEFAULTS` in `src/loader/tools-core.ts`, beside
`'ai.provider'`), so `config_schema` explains both keys without printing a value:

```ts
  'ai.roles': 'what a name an agent file or the subagent tool asks for runs on: config set ai.roles.fast coder-mini makes model: fast in an agent file mean coder-mini here. Roles travel between machines, model ids do not — a role this machine does not define runs the agent on the conversation\'s model and says so',
  'ai.models': 'what a model can hold, by model id: config set ai.models.coder \'{"contextWindow":512000}\'. The API cannot be asked for it, and the meter, the automatic compaction and the recall threshold measure against the window of the model a conversation runs. A model not named here uses ai.contextWindow (200000 otherwise)',
```

**Note:** both keys sit under `ai`, which `isLeashKey` already covers; do **not** add a
mark to either, and `src/config/__tests__/marks.test.ts` must keep passing (it walks the
host schema and refuses a mark under the leash).

**Run:** `bun test ./src/assistant/__tests__/model-roles.test.ts ./src/config/__tests__/marks.test.ts ./src/loader/__tests__/tools.test.ts`

**Commit:** `feat(config): ai.models and ai.roles — a window per model and a name for a model`

## Task 3 — A conversation runs its own model, and its window follows it

**Files:** `src/assistant/conversation.ts`, `src/assistant/conversation-turn.ts`.

`Conversation` gains a field beside its other model-side state (near `agent`/`label`):

```ts
  // The model this conversation's requests carry: its own (a child's role, resolved at
  // the start) or `ai.model`; undefined is the provider's own default.
  model: string | undefined = undefined;
```

and, beside `contextWindow()`:

```ts
  // The model a request of this conversation carries — its own, else `ai.model`.
  effectiveModel(): string | undefined { return this.model ?? baseModel(this.deps.config().ai); }
  contextWindow(): number { return modelWindow(this.deps.config().ai, this.effectiveModel()); }
```

(replace the old one-liner `contextWindow()`, and import `baseModel`, `modelWindow` from
`./model-roles.js`; `DEFAULT_CONTEXT_WINDOW` stops being imported there — check for other
uses in the file first.)

`conversation-turn.ts`, line ~274 (the turn's request) and line ~813
(`foldIntoHandoff`): `llmOpts(ai)` → `withModel(llmOpts(ai), c.model)`. Nothing else in
either call changes: the chat's service merges the caller's options last, so this one key
is the whole override. Import `withModel` beside `llmOpts`.

**Test** (`src/__tests__/subagent-model.rig.test.ts`, new — Task 3's half):

```ts
// A conversation runs one model and measures against that model's window; a child runs
// the model its role names. A conversation on the scripted model, no App.
import { afterEach, expect, test } from 'bun:test';
import { closeRigs, conversationRig } from './helpers/conversation';
import { ScriptedModel } from './helpers/scripted';

afterEach(closeRigs);

const AI = {
  model: 'coder-medium',
  contextWindow: 300_000,
  models: { 'coder-medium': { contextWindow: 262_000 }, 'coder-mini': { contextWindow: 256_000 }, coder: { contextWindow: 512_000 } },
  roles: { fast: 'coder-mini', deep: 'coder' },
};

test('a conversation runs ai.model and measures against that model\u2019s window', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: AI });
  model.script([{ text: 'ok' }]);
  await rig.conv.send('hi');
  expect(model.requests.at(-1)?.model).toBe('coder-medium');
  expect(rig.conv.effectiveModel()).toBe('coder-medium');
  expect(rig.conv.contextWindow()).toBe(262_000);
});

test('a model the catalogue does not name falls back to ai.contextWindow', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: { model: 'other-model', contextWindow: 300_000 } });
  expect(rig.conv.effectiveModel()).toBe('other-model');
  expect(rig.conv.contextWindow()).toBe(300_000);
});
```

**Run** — the first fails on `262_000` (today it is `300_000`, read from
`ai.contextWindow`).

**Commit:** `feat(models): a conversation runs one model, and its window follows it`

## Task 4 — `model:` in an agent file

**Files:** `src/assistant/agent-file.ts`, `src/assistant/__tests__/agent-file.test.ts`.

- The header comment above the code gains a line, after `auto`:
  `//   model:       a role from ai.roles — never a model id, so the file travels`
- `Agent` gains `model?: string` (a role name as written).
- `AGENT_KEYS` becomes `['description', 'params', 'tools', 'skills', 'auto', 'model']`.
- Parse it beside `auto`:

```ts
  // A role, not a model id: the file stays portable, and `ai.roles` says what it runs on.
  let model: string | undefined;
  const modelAt = seen.get('model');
  if (modelAt) {
    const value = modelAt.value.trim();
    if (value) model = value; else err(modelAt.line, 'model is empty — a role name from ai.roles');
  }
```

and in the returned agent `...(model ? { model } : {})`.

**Tests** (add to `agent-file.test.ts`, following that file's helpers): a file with
`model: fast` parses to `agent.model === 'fast'`; a file without it has `model`
undefined; `model:` with nothing after it is an error naming line 1-based and saying
`role name`.

**Run:** `bun test ./src/assistant/__tests__/agent-file.test.ts`

**Commit:** `feat(agents): an agent file names a role, never a model`

## Task 5 — A start resolves the role, and the tool takes one

**Files:** `src/assistant/agent-model.ts`, `src/assistant/agent-start.ts` (unchanged —
leave it), `src/assistant/conversation-types.ts`, `src/assistant/conversation.ts`,
`src/loader/tools-core.ts`, `src/assistant/conversation-turn.ts` (`agentStarterOf`),
`src/plugins/assistant.ts`, `src/assistant/__tests__/agent-model.test.ts`,
`src/__tests__/subagent-model.rig.test.ts`, `src/__tests__/subagent-agent-start.e2e.test.ts`.

1. `ChildSpec` gains, with a line of its own:

```ts
// `model`: the model id the child runs, resolved from its role at the start (absent: the
// conversation's own).
export interface ChildSpec { …; model?: string; … }
```

2. `startChild` sets it right after `child.agent = spec.agent ?? null;`:

```ts
    // A child without a role of its own runs its parent's model, materialised here so a
    // task started by a subagent runs what that subagent runs.
    child.model = spec.model ?? this.effectiveModel();
```

3. `AgentStarter` gains `ai?: () => unknown`; `agentStarterOf` answers it with
   `() => c.deps.config().ai`. `planAgentStart`'s call object gains `model?: string`, and
   after the trust checks:

```ts
  // The call's role wins over the file's; a role nothing defines is one note, and the
  // agent runs on the conversation's model.
  const started = roleStart(starter.ai?.() ?? {}, call.model?.trim() || agent.model);
```

`AgentStartPlan`'s ok-branch gains `model?: string; roleNote: string` (`roleNote` is
`started.note ?? ''`, `model` spread in only when resolved).

4. `tools-core.ts`, the `subagent` tool:

- the definition gains, after `args`:

```ts
          model: { type: 'string', description: 'Optional: a ROLE from ai.roles (e.g. "fast", "deep") — the model the work runs on. Roles are defined by the person; a model id here is not one. Costs the person pays for, so name one only when the work needs it (a big context, a cheap mechanical job).' },
```

- `CoreCtx` gains `config?: Record<string, unknown>;` (the ctx carries the host config
  through `allServices`, so nothing has to be wired).
- in the `subagent` case: `const role = String(args.model ?? '').trim();` and pass it into
  the plan: `planAgentStart(starter, { agent: agentName, args: args.args, prompt: task, model: role })`.
- after `named`, resolve what the child gets:

```ts
        // The plan resolved the file's role (or the call's, which wins); a plain task
        // resolves the call's alone. A role nothing defines leaves the model absent, and
        // the note says so in the answer.
        const started = named
          ? { model: named.model as string | undefined, note: named.roleNote }
          : roleStart((ctx as CoreCtx).config?.ai, role);
```

- the schedule's spec gains `...(started.model ? { model: started.model } : {})`, and the
  answer joins the note where it already joins the absent groups:

```ts
        const notes = [...(named ? [absentGroupsNote(named.id, named.absent), named.note] : []), started.note ?? ''].filter(Boolean).join('\n');
```

then the returned line starts with `${notes ? `${notes}\n` : ''}` as it does today.

5. `plugins/assistant.ts`, the person's start (line ~1988): beside `groups`/`mode`:

```ts
                  const started = roleStart(conv.deps.config().ai, agent.model);
```

the `begin({…})` spec gains `...(started.model ? { model: started.model } : {})`, and the
notes join gains `started.note ?? ''`. Import `roleStart` from
`../assistant/model-roles.js`.

**Tests.**

`agent-model.test.ts` (pure): a starter whose `ai()` answers the catalogue —
- an agent file with `model: fast` → `plan.model === 'coder-mini'`, `plan.roleNote === ''`;
- the call's `model: 'deep'` over an agent file that says `fast` → `plan.model === 'coder'`;
- an unknown role → `plan.model` undefined, `plan.roleNote` the one sentence;
- no role anywhere → no `model`, no `note`.

`subagent-model.rig.test.ts` (rig):
- an agent file with `model: fast`, started by the model through the tool: the child's
  requests carry `model: 'coder-mini'` (`model.requests` filtered by `firstUser`, as
  `subagent-agent-model.rig.test.ts` does), the session's still `coder-medium`, and
  `[...rig.conv.children][0].contextWindow()` is 256 000;
- the tool's `model: 'fast'` on a PLAIN task → the same;
- an unknown role on a plain task → the tool's answer (`rig.journal()`'s `call` event)
  contains `role "nope" is not defined`, and the child's requests carry `coder-medium`;
- a child with no role → inherits `coder-medium`.

`subagent-agent-start.e2e.test.ts` (the person's typed path): one more case — a project
agent file with `model: fast`, trusted, started with `/subagent @id`, and the child's
requests carry `coder-mini` (follow the file's existing helper for writing and trusting a
project agent file and for reading requests).

**Run:** `bun test ./src/assistant/__tests__/agent-model.test.ts ./src/__tests__/subagent-model.rig.test.ts ./src/__tests__/subagent-agent-start.e2e.test.ts ./src/__tests__/subagent-agent-model.rig.test.ts`

**Commit:** `feat(agents): a role in the file and on the subagent tool, resolved where it starts`

## Task 6 — Whose model it is, on screen and in the journal

**Files:** `src/assistant/conversation-types.ts`, `src/assistant/conversation.ts`,
`src/assistant/agent-tree.ts`, `src/plugins/assistant.ts`,
`src/assistant/__tests__/agent-tree.test.ts`, `src/__tests__/subagent-model.rig.test.ts`.

1. `TreeNode` gains `model?: string`; `tree()` spreads it:
   `...(child.model ? { model: child.model } : {})`.
2. `agentsPanelRows` gains a sixth parameter `chatModel?: string`, and the row's detail
   gains the model when it is not the chat's:

```ts
  const model = n.model && n.model !== chatModel ? ` · ${n.model}` : '';
  … detail: `${stateOf(n, now)}${spent}${model}`,
```

3. Its call site (`plugins/assistant.ts:1876`) passes `conv.effectiveModel()` last.
4. The journal: `startChild`'s `subagent` start line and `task-start` line gain
   `...(child.model ? { model: child.model } : {})`.

**Tests:** in `agent-tree.test.ts` — a node with `model: 'coder-mini'` and
`chatModel: 'coder-medium'` reads `· coder-mini` in the detail; with the same model as
the chat, nothing is added; the ended rows are unchanged. In the rig test — the journal's
`subagent` start line carries `model: 'coder-mini'`.

**Run:** `bun test ./src/assistant/__tests__/agent-tree.test.ts ./src/__tests__/subagent-model.rig.test.ts`

**Commit:** `feat(agents): /agents and the journal name the model a child runs`

## Task 7 — The pages

**Files:** `AGENTS.md`, `docs/usage.md`, `docs/config.md`, `CHANGELOG.md`,
`docs/internal/plans/_followups.md`.

- **`AGENTS.md`** — the durable rules, in the host's own voice:
  - under "Config & environment", after `ai.images`/`ai.recall`: what `ai.models` and
    `ai.roles` are, that `ai.model` is a model id and never a role, and that everything
    under `ai` is the person's (the leash);
  - in "A conversation has a kind" (or beside it): a conversation's model — its own,
    else `ai.model`, else the provider's default; a child inherits its parent's; the
    window is the conversation's model's, and `contextWindow()` is the one place it is
    read, so the meter, the automatic compaction and the recall threshold follow;
  - compaction runs on the conversation's model, and why (the whole history goes into
    the summary request), pointing at the followup;
  - "Agent files": the `model:` line, a role only;
  - "What the model can do (the `core` tool group)"'s `subagent` bullet: the `model`
    argument, a role, the call's role winning over the file's, and an undefined role
    degrading with the same note;
  - the agent tree / `/agents` bullet: a child's model shown when it differs from the
    chat's;
  - the journal's event list: `subagent` and `task-start` carry `model`.
- **`docs/config.md`** — a new `## Models and roles` section after "Settings and
  environment": the three keys, a worked example (the trio this was written for —
  cheap, default, deep), the window rule, that a role the machine lacks degrades, and
  that `config get`/`config set` treat both keys like any other under `ai` (the person's
  only).
- **`docs/usage.md`** — in "Agent files", "### The file" gains the `model:` line, and a
  short "### Which model it runs" (or a paragraph in "### What it may do") says: a role,
  what `ai.roles` is, inheritance, the note when the role is missing, and the price
  argument. "### The live subagents under the field" / `/agents` says the model is named
  when it differs. Also the `subagent` tool's `model` in "The assistant starts one".
- **`CHANGELOG.md`** — one entry under the unreleased version, in the file's voice.
- **`docs/internal/plans/_followups.md`** — an entry: "Compaction on a role of its own",
  the gap (the summary request sends the whole history, so a smaller window cannot
  compact a larger conversation), and what it needs (a `keep` tail kept verbatim beside
  the summary, as opencode's `compaction.keep`, then the compaction model may be a role
  with a check that the tail fits its window).

**Run:** `bun run typecheck` (docs touch nothing compiled, but the tree must stay green).

**Commit:** `docs: models, roles, and the window a conversation measures against`

## Verification

From the worktree, in this order:

1. `bun run typecheck`
2. `bun test ./src ./scripts ./packages` — the full suite (~13 min). Known flakes,
   unrelated: `mcp`, `tools-shell`, `start-cwd`, `subagent-ask`, `leave-busy`,
   `subagent-question`, `subagent-tree` — a flake is re-run, never "fixed" by weakening
   an assertion.
3. Read the diff with the contract above in hand: every request the host makes carries
   the conversation's model; the window has one reader; no key under `ai` carries a mark.
4. A manual look with the real endpoint (the person's three models): an agent file with
   `model: fast` and `/agents` showing `coder-mini` while the chat says nothing.

Then a PR against `master`, and — after the merge — the binary rebuilt
(`bun run test:binary`, `bun run build:binary`, `rm` the installed file before `cp`,
never in place).

## Risks, and what is deliberately not here

- **The provider's model name is the person's.** A typo in `ai.roles.fast` is an API
  error at the child's first request, not a host refusal: the host cannot know which
  model ids an endpoint serves. The note covers the one case it can know — a role that
  is not defined at all.
- **Compaction on a smaller model** — out of scope, the followup above. A child on a
  256k model with a 300k history would have its summary request refused by the provider;
  a task that large is the person's cue to give it the deep role.
- **No `/model`, no picker, no model in the status line** — the model is the person's
  config, per agent file and per call. A per-session switch is a different design (a
  session field, the picker, `/model`), and nothing here blocks it.
- **`ai.model` stays a model id.** Reading it as a role too would make a role named like
  a model id ambiguous, and `ai.model` is what every existing config already holds.
