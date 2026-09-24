# flow-assist

A standalone, domain-agnostic TUI/CLI assistant host. It ships no domain logic
of its own — plugins (the bundled `gitlab` and `repo`, or your own) deliver
surfaces, commands, and LLM tool groups.

![The chat reads a repository, edits its README behind a y/n, and leaves the diff in the conversation](docs/demo/host.gif)

The assistant can change things only after you say yes — one write at a time, or a
stretch of them at once if you turn the confirmations off for a while — and what a
change did stays in the chat as a diff. (A scripted model and an invented repository;
nothing leaves the machine.)

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

**Click what you want to read.** Everything the chat folds — a turn's tool calls, what
it said between them, a command's capped output — opens where you click it: on its fold line to
open it, anywhere inside it to close it again. A block opens at its first row, so a
long one starts where it starts; a drag is still a selection and never folds anything.
`^o` is the same thing for the whole screen: with anything folded it opens everything,
pressed again it closes everything (`config set keys.details <key>` moves it; `^r`,
the key it used to be, still works).

A turn reads in the order it happened: what the assistant said, the diff of the
file it changed, what it said next, the answer. Its text stays where it was written —
dim, with a spinner beside it, until it is known to be the answer, which then gets the
`ƒ`. What it said between tool calls folds to one quiet line per stretch, where that
stretch began: the latest thing it said, and how many steps there were
(`▸ Now the tests.  (3 steps)`); a click opens that stretch, with the calls each step
made, `^o` opens them all. Calls made without a word are a line of their own, where
they were made (`▸ 2 tools: read_file ×2`).
`/notes open` leaves every step on screen in the normal colour — for the current
conversation; `/notes step` goes back. To have it that way from the start:
`config set plugins.assistant.notes open`.

`/fullscreen` gives the chat the whole terminal instead of a window over the
screen — code, tables and diffs get every column; `/fullscreen off` brings the
window back. To have it that way from the start:
`config set plugins.assistant.fullscreen true`.

To show the assistant an image — a screenshot, a mock, a diagram — drag the file onto
the terminal (or paste its path), type `/image <path>`, or press Ctrl+V (Cmd+V where
the terminal passes it on) for the image on the clipboard. It becomes an `[Image #1]`
token in your message, and Backspace takes the token away whole. PNG, JPEG, GIF and
WebP, up to 5 MB (`ai.images.maxBytes`) and 4 a message (`ai.images.maxPerMessage`);
a bigger one is refused, never shrunk. The session keeps the file's path and hash, not
the picture, and reads it again after a restart. A model that cannot take images:
`config set ai.images.enabled false`.

`!command` in the chat runs a shell command yourself (`!bun test src/features`): it is
one folded line while it runs (`bun test src/features · 3 s`) and stays folded, its tail
settled, once it ends (`· ✓ 4.2 s`); the output lands in the conversation and the
assistant sees it with your next message, without spending a turn on it. Esc stops it.
Commands start in the first `shell.roots` directory (`config set shell.roots
'["~/src/app"]'`) and the directory is remembered
between them, as in a terminal (`!cd pkg`; only within the roots; variables are not
kept). The assistant can run commands too — `run_command`, in the same directory and
drawn the same live way, and only after you confirm each one (`ai.disabledTools:
["shell"]` turns it off); several in a row fold under one head, `Ran N commands`, that
opens into each command's own block. A click on a command's line opens its last
`runOutputLines` lines (`plugins.assistant.runOutputLines`); `^o` opens it, and
everything else folded, in full. Limits:
`shell.timeoutMs` (120 s) and `shell.maxChars` (20000; the end of the output is kept).

Shift+Tab — or `/auto reads|all|off` — says how much you want to confirm while you
work: `auto: reads` leaves every write asking, `auto: writes` lets writes run without
the y/n, and the chat's hint line says which is on for as long as it is. It belongs to
the conversation you are in: a restart, `/clear`, `/resume` and a new task all go back
to asking, and nothing about it is saved. Two things always ask, whatever you set —
`run_command`, and reading a page from a host that is not on `web.allowlist`. What ran
is still shown: the ✎ diff and the tool trail are the same either way.

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

Each plugin ships a `manifest.json` and a `shape` (commands/keys/views/surfaces/
aiTools/services/tools/configSchema). Tool groups are delivered by plugins; there
is no separate tools repo.

Plugins here: `gitlab` (glab CLI), `repo` (local clones and git) and `mcp` — the tools
of MCP servers, reached over Streamable HTTP or started as a command (Safari's
`safaridriver --mcp`), each call asked about first
(`plugins-available/mcp/README.md`). A plugin's settings are set like the host's:
`config set plugins.<name>.<key> <value>`. `repo` reads and writes only inside
`plugins.repo.roots`, and without it inside the shell's `shell.roots`. A config that
still sets the roots as `fs.roots`, the key both used to share, works for one more
release, and the log (`L`) says where to move it.

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
works as well. Both run React's production build, unless `NODE_ENV` is set to
something else; the binary is built with it and always does.

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