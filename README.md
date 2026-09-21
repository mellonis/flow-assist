# flow-assist

A standalone, domain-agnostic TUI/CLI assistant host. It ships no domain logic
of its own — plugins (the bundled `gitlab` and `repo`, or your own) deliver
surfaces, commands, and LLM tool groups.

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

## Config & environment

- **Config**: `~/.config/flow-assist/config.json` — schema comes from each
  plugin's `configSchema` (see `config get`).
- **Environment**: the host reads `LLM_TOKEN` (or the variable named by
  `ai.tokenEnv`) and the optional `FLOW_ASSIST_PLUGIN_REGISTRY_URL` /
  `FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT` / `FLOW_ASSIST_PLUGIN_REGISTRY_TOKEN` — see `.env.example`.
  A plugin documents its own variables and declares them in its manifest's
  `requiredSettings`. Secrets belong in env, not in the config file.
- **Who you are**: `config set user.name <name>` (and optionally `user.login`)
  lets the assistant address you. Unset, nothing about you is sent to the LLM.
- **Reading the web** (`web_fetch`): every fetch asks you first, unless the host is
  on `web.allowlist` (`example.com`, or `*.example.com` for its subdomains); a
  background task cannot fetch a host you have not listed. Local and private
  addresses are refused unless listed. `web.maxBytes` / `web.timeoutMs` set the limits.
  The tool is on by default; `config set ai.disabledTools '["web"]'` turns it off.

## Building a single binary (retired)

```sh
bun run build:binary                          # prints a notice + type-checks; no binary is produced
```

`bun build --compile` is **retired**: the bundler emits a broken artifact with
**two React instances** ("Invalid hook call") — an upstream @flowtty 1.0.0-alpha
+ Bun bundler bug that app code cannot fix. The host therefore ships and runs as
a **Bun-executable** via `bun src/cli.ts`. The `bin` entry (`flow-assist`)
points at `src/cli.ts`, whose `#!/usr/bin/env bun` shebang makes npm link and
run it under bun. `bun run build:binary` now only explains this and type-checks.

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