# Config & environment

Where settings live, how to set them, and the environment variables flow-assist reads.
What the assistant may change on its own is on [safety.md](safety.md), "What the
assistant may set or save".

## Settings and environment

- **Config**: `~/.config/flow-assist/config.json` — schema comes from each
  plugin's `configSchema` (see `config get`).
- **Setting a value**: `config set <key> <value>` saves it to `config.local.json`;
  inside the app, `:config set --session <key> <value>` changes it for that run only —
  nothing is written, and the next start has the saved value again. Either way a
  running app uses it at once where it can; a key read only at start (`ui.mouse`, `ui.hover`, the
  model's endpoint, `ai.disabledTools`) waits for the next one and says so.
  Tab completes a key from the whole schema, set or not (`agents.maxAuto`, `ai.taskRounds`), and
  the values of an enum or a boolean key. A key that holds a map (`keys`, `theme`) completes as
  itself, not by the names inside it.
  `config unset <key>` removes a saved value (`:config unset --session <key>` only the
  one for this run). `config get <key>` says where the value comes from: `session`,
  `local` (`config.local.json`), `config` (`config.json`) or `default`.
- **The look**: `ui.theme` is `system` (the default), `light` or `dark`. `system` follows
  the terminal's own light/dark scheme as it changes (macOS switches it by itself and
  the terminal follows); `light` and `dark` pin one whatever the terminal says. It is
  read live: `:config set ui.theme dark` in the running app repaints it at once; a value
  written into `config.local.json` from outside a running app is read at the next start —
  there is no file watcher. See [usage.md](usage.md), "The look". The key is the
  person's — the assistant has no mark for it. The chat's own colours live at
  `theme.modals.chat`: `accent`, `shell`, `assistantAccent`, `userBg` (the person's
  messages), `bgAccent`/`bgBg` (a background result), `askBg`/`askInk` (a kept question
  and the answer it got), `fieldBg`, `warn`, `ok`, `add`/`del` (a diff row: what came in,
  what went out — the `✎` block, a diff the assistant writes and the `/diff` panel alike)
  with `addBg`/`delBg` (the ground those rows sit on), and `idleBorder`. A `theme` record
  cannot set a per-modal token — a value at `theme.modals.chat.<key>` is inert (it nests
  one level down); `config.plugins.chat.colors` is the path.
- **The model**: by default an OpenAI-compatible chat-completions API —
  `config set ai.baseUrl <url>`, `config set ai.model <id>`, the token in
  `LLM_TOKEN`. For Anthropic's own Messages API:

  ```sh
  flow-assist config set ai.provider anthropic
  flow-assist config set ai.model <model-id-your-endpoint-serves>
  export ANTHROPIC_API_KEY=…                           # or ai.tokenEnv names another variable
  ```

  `ai.baseUrl` then defaults to `https://api.anthropic.com/v1`; a base URL of your own
  (a proxy) includes the `/v1` too — requests go to `<ai.baseUrl>/messages`. The
  tools, the system prompt and the turn so far are cached between requests, the
  context meter counts the cached part, and the model's thinking shows in the chat as one
  `▸ thought` fold per round, where the model thought it (`^o` opens them all).
  `ai.maxTokens` caps one answer, and the ceiling is sent to the provider as
  `max_tokens` on this wire, on the OpenAI-compatible one, and on the compaction
  request. It resolves as `ai.maxTokens`, else the model's own
  `ai.models.<id>.maxTokens`, else the room its window leaves after what the
  conversation last sent —
  `min(32 000, max(1 024, floor(window × 0.99) − input − 1 024))`.
  A provider that refuses the field by name is asked once more without it (the
  OpenAI-compatible wire) or at 8 192 (this one), and the refusal is remembered for
  the run. Thinking counts against the ceiling:
  `config set ai.thinking '{"adaptive":true}'` asks the model to think as much as it
  sees fit and shows a summary of it; a fixed `'{"budgetTokens":4096}'` is for older
  models only (the current ones refuse it), and a budget that leaves the answer less
  than 1024 tokens under the ceiling is lowered (the log says so at start; a ceiling
  that shrinks with the window lowers it silently later in the conversation).
  Unset, the model thinks as it does by default and its thinking is not shown.
- **Environment**: the host reads `LLM_TOKEN` (or the variable named by
  `ai.tokenEnv`; `ANTHROPIC_API_KEY` with `ai.provider anthropic`) and the optional `FLOW_ASSIST_PLUGIN_REGISTRY_URL` /
  `FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT` / `FLOW_ASSIST_PLUGIN_REGISTRY_TOKEN` — see `.env.example`.
  A plugin documents its own variables and declares them in its manifest's
  `requiredSettings`. Secrets belong in env, not in the config file.
- **Where `.env` is read from**: Bun loads `.env` from the **directory you start
  the app in** — the current working directory, which is the install directory
  only when you start it from there (and never the config directory). This holds
  for `bun run src/cli.ts`, the linked `flow-assist` command and a compiled binary
  alike. So a `.env` in the install directory (next to `.env.example`) is found
  only when you start the app from there; started from a project, the app sees no
  `LLM_TOKEN` and no plugin token (a tracker's, say). To have the tokens wherever
  you start it, export them in your shell profile instead (`export LLM_TOKEN=…` in
  `~/.zshrc`), or start the app from the directory that holds the `.env`.
- **Who you are**: `config set user.name <name>` (and optionally `user.login`)
  lets the assistant address you. Unset, nothing about you is sent to the LLM.
- **Agent files**: `agents.maxAuto` (`ask`, `reads` or `all`; `reads` when unset) is the
  highest auto mode an agent file may run in — its own `auto:` line says what it asks for,
  and the lower of the two applies. Only you can set it; the assistant cannot. See
  [usage.md](usage.md), "Agent files".
- **Project instructions**: each `AGENTS.md` between the shell's directory and its
  `shell.roots` entry rides in the system prompt — see
  [usage.md](usage.md), "Project instructions". `project.instructionsCap` says how
  many bytes of each file are read (32 768 when unset; `0` — no cut, the files ride
  whole). A file under the cap is never touched; one over it is cut at a line
  boundary and the cut is said — a note in the prompt with how many lines were left
  out, and the chat's note naming the cap. How big your instructions are is your
  editorial call; only you can set the key, and the assistant cannot. The chat names
  the chain's share of the context window when it grows large, and `/context` shows
  it as `instructions`.
- **Reading the web** (`web_fetch`): `web.allowlist`, `web.maxBytes` and
  `web.timeoutMs` — see [safety.md](safety.md), "Reading the web".

## Models and roles

Work asks for a model by **role**, and each machine says what a role runs on: an agent
file or a background job names `fast` or `deep`, and your config maps the name to a model
id here. The model ids an endpoint serves are yours; a name travels, an id does not.

```sh
flow-assist config set ai.model default-model        # what the chat runs
flow-assist config set ai.roles.fast small-model     # model: fast in an agent file
flow-assist config set ai.roles.deep big-model       # model: deep — a big context
flow-assist config set ai.models.small-model '{"contextWindow":64000}'
flow-assist config set ai.models.default-model '{"contextWindow":200000}'
flow-assist config set ai.models.big-model '{"contextWindow":512000}'
```

- **`ai.model`** is a model id — the one the chat runs when nothing else says. It is
  never read as a role.
- **`ai.roles`** maps a role (`fast`, `deep` — a name you choose) to a model id on this
  machine. An agent file's `model:` line and the `subagent` tool's `model` argument name
  a role, never a model id (see [usage.md](usage.md), "Which model it runs").
- **`ai.models.<id>.contextWindow`**, in tokens, is what one model can hold — the API
  cannot be asked for it. A model not named there uses `ai.contextWindow` (200 000
  otherwise). The window is what the context meter (`ctx N%`), the automatic compaction
  and the recall measure against: the window of the model the work runs, so a subagent on
  `deep` counts against its 512 000, not the chat's 200 000.
- **`ai.models.<id>.maxTokens`**, in tokens, is that model's own answer ceiling: the
  longest answer one request on it may get. `ai.maxTokens`, when set, is over everything;
  with neither set, the ceiling is the room the model's window leaves. Name it for a
  model whose output cap is smaller than the derived ceiling, and the provider is not
  asked for more than it takes. Set both in one call:
  `flow-assist config set ai.models.big-model '{"contextWindow":512000,"maxTokens":16000}'`.
- **A model id with a dot** cannot be a key path — every config key is a dot path, so
  `config set ai.models.big-model.v2.contextWindow 512000` reads `big-model` and `v2` as
  two keys and is refused (`unknown key`). Set the whole catalogue in one call instead:
  `flow-assist config set ai.models '{"big-model.v2":{"contextWindow":512000}}'`, or write
  it in `config.json`.

Each conversation runs one model: the session's own if you chose one in the chat with
`/model` (it lives in that session's file, not here), what its role resolved to when it
started (a subagent or task with no role runs the model of the conversation that started
it), else `ai.model`, else whatever the endpoint serves by default. `/model` names a role
or an id of `ai.models` — or `default` to go back to `ai.model` — and writes nothing to
the config: a session that chose its own model keeps it while `ai.model` changes under it
(see [usage.md](usage.md), "The model this conversation runs"). A role this machine does
not define is not an error: the work runs on the conversation's model and one note says so
(`role "deep" is not defined (ai.roles) — using the conversation's model`). A model id
your endpoint does not serve is its own error at the first request — the host cannot know
which ids an endpoint runs.

All three keys sit under `ai`, the model's own leash: only you can set them (see
[safety.md](safety.md), "What the assistant may set or save"), and `config get` /
`config set` treat them like any other key under `ai`.

## Plugins

Source lives in `plugins-available/<name>/`. Enable a plugin with

```sh
bun run src/cli.ts plugins install <name>     # symlinks plugins-enabled/<name>
bun run src/cli.ts plugins install ./notes-0.1.0.tar.gz          # a plugin archive
bun run src/cli.ts plugins install https://…/notes-0.1.0.tar.gz  # or its https URL
```

An archive is what `plugin:publish` packs: one top-level `<name>/` with the plugin's
`manifest.json`. It is unpacked into `plugins-available/` and enabled; one with a
link, a `..` or anything outside that directory is refused before a byte is written.
A newer archive replaces one installed from an archive; a plugin you checked out is
never overwritten.

A plugin loads only when you trust it. `plugins install` trusts what it installs; a
plugin put into `plugins-enabled/` another way — a link you made by hand, an installer
script that unpacks and links — is named on the start screen as `not trusted —
flow-assist plugins trust <name>` until you run that. An installer script that unpacks
each version into the same `plugins-available/<name>` and links
`../plugins-available/<name>` keeps a plugin trusted across updates; a plugin new to it
needs one `plugins trust`. A link that now leads somewhere else shows both places, and
`plugins trust` asks before it trusts the new one (`--yes` answers for you). The first
start after upgrading trusts everything already enabled, once, and the start screen
lists it. `plugins ls` marks an untrusted plugin, and `plugins remove` forgets the
trust. In the app, `:plugins` lists them, disables and enables one (its link waits in
`plugins-enabled/.disabled/`, still installed; a disable forgets the trust, so an enabled
plugin waits for `y` or `plugins trust`; `plugins install` enables it again too),
restarts one in another language and trusts one (docs/usage.md, "Plugins:
`:plugins`"). See
[safety.md](safety.md), "Plugins and memory changed behind the app's back".

```sh
bun run src/cli.ts plugins trust <name>       # trust a plugin in plugins-enabled/
```

Each plugin ships a `manifest.json` and a `shape` (commands/keys/views/surfaces/
aiTools/services/tools/configSchema). Tool groups are delivered by plugins; there
is no separate tools repo.

Plugins here: `gitlab` (glab CLI), `repo` (local clones and git) and `mcp` — the tools of
MCP servers, reached over Streamable HTTP or started as a command (Safari's
`safaridriver --mcp`), each call asked about first (`plugins-available/mcp/README.md`). A
plugin's settings are set like the host's: `config set plugins.<name>.<key> <value>` —
`config set` knows a plugin's keys only where the plugin declares a `configSchema`; one
that declares none keeps its settings hand-edited in `config.local.json` (the `canvas`
plugin is one). `repo`
reads and writes only inside `plugins.repo.roots`, and without it inside the shell's
`shell.roots`; it also carries the skill `repo/change-discipline`, rules for a code
change from the ticket to the merge request (docs/usage.md, "Skills"). A config that
still sets the roots as `fs.roots` works for one more
release, and the log (`L`) says where to move it.

Writing one: [plugins.md](plugins.md).
