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
  `config unset <key>` removes a saved value (`:config unset --session <key>` only the
  one for this run). `config get <key>` says where the value comes from: `session`,
  `local` (`config.local.json`), `config` (`config.json`) or `default`.
- **The model**: by default an OpenAI-compatible chat-completions API —
  `config set ai.baseUrl <url>`, `config set ai.model <id>`, the token in
  `LLM_TOKEN`. For Anthropic's own Messages API:

  ```sh
  flow-assist config set ai.provider anthropic
  flow-assist config set ai.model claude-sonnet-5      # or claude-opus-5-5, …
  export ANTHROPIC_API_KEY=…                           # or ai.tokenEnv names another variable
  ```

  `ai.baseUrl` then defaults to `https://api.anthropic.com/v1`; a base URL of your own
  (a proxy) includes the `/v1` too — requests go to `<ai.baseUrl>/messages`. The
  tools, the system prompt and the turn so far are cached between requests, the
  context meter counts the cached part, and the model's thinking shows in the chat's thinking fold (`^o`).
  `ai.maxTokens` caps one answer (8192 by default; that API requires a cap, and
  thinking counts against it). `config set ai.thinking '{"adaptive":true}'` asks the
  model to think as much as it sees fit and shows a summary of it; a fixed
  `'{"budgetTokens":4096}'` is for older models only (the current ones refuse it), and
  a budget that leaves the answer less than 1024 tokens under `ai.maxTokens` is lowered
  (the log says so at start).
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
- **Reading the web** (`web_fetch`): `web.allowlist`, `web.maxBytes` and
  `web.timeoutMs` — see [safety.md](safety.md), "Reading the web".

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
trust. See
[safety.md](safety.md), "Plugins and memory changed behind the app's back".

```sh
bun run src/cli.ts plugins trust <name>       # trust a plugin in plugins-enabled/
```

Each plugin ships a `manifest.json` and a `shape` (commands/keys/views/surfaces/
aiTools/services/tools/configSchema). Tool groups are delivered by plugins; there
is no separate tools repo.

Plugins here: `gitlab` (glab CLI), `repo` (local clones and git) and `mcp` — the tools
of MCP servers, reached over Streamable HTTP or started as a command (Safari's
`safaridriver --mcp`), each call asked about first
(`plugins-available/mcp/README.md`). A plugin's settings are set like the host's:
`config set plugins.<name>.<key> <value>`. `repo` reads and writes only inside
`plugins.repo.roots`, and without it inside the shell's `shell.roots`. A config that
still sets the roots as `fs.roots` works for one more
release, and the log (`L`) says where to move it.

Writing one: [plugins.md](plugins.md).
