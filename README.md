# flow-assist

A standalone, domain-agnostic TUI/CLI assistant host. It ships no domain logic
of its own — plugins (the bundled `gitlab` and `repo`, or your own) deliver
surfaces, commands, and LLM tool groups.

![The chat reads a repository, edits its README behind a y/n, and leaves the diff in the conversation](docs/demo/host.gif)

The assistant can change things only after you say yes, and what a change did stays
in the chat as a diff. (A scripted model and an invented repository; nothing leaves
the machine.)

## Requirements

- Bun 1.3.x — `curl -fsSL https://bun.sh/install | bash`

## Install

```sh
git clone <repo-url> flow-assist
cd flow-assist
bun install
bun run build
```

## Usage

```sh
bun run src/cli.ts                            # interactive TUI
bun run src/cli.ts config get                 # host config
bun run src/cli.ts plugins ls                 # enabled plugins
bun run src/cli.ts "summarize ABC-123"        # one-shot prompt
```

The chat is saved as you go and continued on the next start, so a restart or an
update loses nothing. `/clear` starts a new session and keeps the old one;
`/resume` lists the saved sessions and `/resume <n>` opens one. Sessions live in
`sessions/` in the config directory, readable by you only (`sessions.resume: false`
starts every run empty; `sessions.keep` — how many are kept, 50 by default).

`!command` in the chat runs a shell command yourself (`!bun test src/features`):
the output lands in the conversation and the assistant sees it with your next
message, without spending a turn on it. Esc stops it. Commands start in the first
`fs.roots` directory and the directory is remembered between them, as in a
terminal (`!cd pkg`; only within the roots; variables are not kept). The assistant
can run commands too — `run_command`, in the same directory, and only after you
confirm each one (`ai.disabledTools: ["shell"]` turns it off). Limits:
`shell.timeoutMs` (120 s) and `shell.maxChars` (20000; the end of the output is kept).

## Plugins

Source lives in `plugins-available/<name>/`. Enable a plugin with

```sh
bun run src/cli.ts plugins install <name>     # symlinks plugins-enabled/<name>
```

Each plugin ships a `manifest.json` and a `shape` (commands/keys/views/surfaces/
aiTools/services/tools/configSchema). Tool groups are delivered by plugins; there
is no separate tools repo.

Plugins here: `gitlab` (glab CLI), `repo` (local clones and git) and `mcp` — the tools
of MCP servers over Streamable HTTP, each call asked about first
(`plugins-available/mcp/README.md`). A plugin's settings are set like the host's:
`config set plugins.<name>.<key> <value>`.

**Writing a plugin**: [docs/plugins.md](docs/plugins.md) builds one step by step — a
notebook the assistant reads and writes ([examples/notes](examples/notes), run by the
host's tests) — and lists the rest of the contract: tools, commands, keys, screens.

What a plugin with screens can do — a tracker plugin (it is not part of this
repository), recorded against a mock tracker:

![A tracker plugin: the board, a filter by the person the chat says you are, an issue's card](docs/demo/tracker-board.gif)

![The same plugin in the chat: an epic reviewed, a description fixed and an estimate set behind the y/n, a failed pipeline explained and retried](docs/demo/tracker-chat.gif)

## Config & environment

- **Config**: `~/.config/flow-assist/config.json` — schema comes from each
  plugin's `configSchema` (see `config get`).
- **Environment**: the host reads `LLM_TOKEN` (or the variable named by
  `ai.tokenEnv`) and the optional `FLOW_ASSIST_PLUGIN_REGISTRY_URL` /
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
- **Reading the web** (`web_fetch`): every fetch asks you first, unless the host is
  on `web.allowlist` (`example.com`, or `*.example.com` for its subdomains); a
  background task cannot fetch a host you have not listed. Local and private
  addresses are refused unless listed. `web.maxBytes` / `web.timeoutMs` set the limits.
  The tool is on by default; `config set ai.disabledTools '["web"]'` turns it off.

## Building a single binary

```sh
bun run build:binary                          # dist/flow-assist
```

The compiled host runs without Bun installed. It loads plugins from
`plugins-enabled/` in the directory it starts in, and they must be shipped **built**:
inside a compiled binary a plugin cannot import a package from disk, so a plugin
with dependencies bundles them into its `main` (docs/plugins.md, "Shipping it").
`bun src/cli.ts` — or the `flow-assist` command, whose shebang runs it under Bun —
works as well.

## Repository

- `flow-assist` — this host. Plugins are separate packages under
  `plugins-available/`, each with its own dependencies; the host imports none of them.

See [AGENTS.md](./AGENTS.md) for the project's conventions (language rule,
plugin contract, git rules).

## License

Copyright (C) 2026 flow-assist contributors.

This project is free software, licensed under the **GNU General Public
License, version 3 or (at your option) any later version** — see [LICENSE](./LICENSE).
It is distributed in the hope that it will be useful, but **WITHOUT ANY
WARRANTY**; without even the implied warranty of **MERCHANTABILITY** or
**FITNESS FOR A PARTICULAR PURPOSE**.

The GPL applies to the **host and any derivative/fork of it**: if you modify
and redistribute the host, your fork must remain GPL and preserve the
copyright/notice (see [NOTICE](./NOTICE)).

**Plug-in exception.** As an additional permission (section 7 of the GPL v3),
plug-ins that implement the documented plugin contract (a `manifest.json` +
`shape`, loaded by the host at runtime as separate works) are **not** covered
as derivative works of the host and may be licensed under **any terms**,
including proprietary ones. The bundled `gitlab` / `repo` plug-ins in this
repository are themselves licensed under GPL-3.0-or-later (each ships its own
`LICENSE`).

Full license texts: <https://www.gnu.org/licenses/>