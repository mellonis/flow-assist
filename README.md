# flow-assist

A standalone, domain-agnostic TUI/CLI assistant host. It ships no domain logic
of its own — plugins (the bundled `gitlab`, `repo` and `mcp`, or your own) deliver
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

## Quick start

```sh
bun run src/cli.ts                            # interactive TUI
bun run src/cli.ts config get                 # host config
bun run src/cli.ts plugins ls                 # enabled plugins
bun run src/cli.ts "summarize ABC-123"        # one-shot prompt
```

## Keys of the main screen

| Key | What it does |
|---|---|
| ⏎ / Esc | send a message / stop the answer (a message sent meanwhile is queued) |
| ↑ ↓ | walk what you typed |
| `/…`, `!…`, `!!…` | a chat command, a shell command, a program that needs the terminal |
| Shift+Tab | how much to confirm: the auto mode |
| Ctrl+S | the saved sessions |
| Ctrl+] | move the keyboard between the chat and a plugin's screen |
| Ctrl+\\ | fold the chat panel away and bring it back |
| ^o | open everything folded, or close it all again |
| Ctrl+V | attach the image on the clipboard |
| Ctrl+C twice | quit |

## Read more

- [docs/usage.md](docs/usage.md) — working in the chat: sessions, memory, background
  work, folds, docking, images, compaction and limits, shell commands.
- [docs/safety.md](docs/safety.md) — what the assistant may do: the y/n, the auto
  mode, the one-shot prompt, secrets, the settings guard, and their limits.
- [docs/config.md](docs/config.md) — config, scopes, the model, environment, plugins.
- [docs/plugins.md](docs/plugins.md) — writing a plugin, step by step: a notebook the
  assistant reads and writes ([examples/notes](examples/notes), run by the host's
  tests), and the rest of the contract: tools, commands, keys, screens.

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