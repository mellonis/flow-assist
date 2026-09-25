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

A message sent while an answer is still coming waits its turn (`⏎ queued`) and goes
out when the answer ends; ↑ on an empty field takes the last one back to edit. Esc or
Ctrl+C stops the answer on the first press — then the waiting messages come back into
the field instead of being sent, and so they do when a request fails. ↑/↓ walk
everything you typed, `/commands` and `!commands` included, and the history is saved
with the session. Ctrl+C (or Ctrl+D on an empty field) quits and Ctrl+Z suspends only
when pressed twice: the first press says `^c again to exit`.

**Click what you want to read.** Everything the chat folds — a turn's tool calls, what
it said between them, a command's capped output — opens where you click it: on its fold line to
open it, anywhere inside it to close it again. A block opens at its first row, so a
long one starts where it starts; a drag is still a selection and never folds anything.
`^o` is the same thing for the whole screen: with anything folded it opens everything,
pressed again it closes everything (`config set keys.details <key>` moves it; `^r`
works too).

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

**The chat sits beside what you are looking at.** By default it is a panel docked to
the right of a plugin's screen — a board and the conversation about it, both in view —
and the plugin's screen is laid out in the rest, as on a smaller terminal. On a terminal
under 120 columns the panel goes to the bottom by itself, and on one too short for both
(under 19 rows) the chat is drawn as a window until the terminal grows again. A question
or a y/n from the assistant is always shown whole: a bottom panel grows to fit it, and
where that would squeeze the plugin's screen out, the chat is a window until you answer.
**Ctrl+]** moves the keyboard between the chat and the plugin; the side that has it is
marked (the panel's frame, or the title bar, in the accent colour), and a click in
either side gives it the keyboard too. With the plugin at the keys the chat goes on
answering in its panel. **Ctrl+\\** folds the panel away and brings it back: on the
right it goes, and a running turn's spinner, seconds and word move to the plugin's
bottom row; at the bottom it keeps one row saying the same. Esc Esc in the chat folds
it the same way and hands the keyboard to the plugin; `F` or Ctrl+] brings it back.
Folding the chat away is not an answer: a y/n or a question the assistant is waiting on
stays open, the folded chat says `? waiting for you`, and it is there again when the
chat comes back (Esc still says no, or dismisses the question).
Both keys are the host's before any plugin's — a plugin that takes every key cannot
keep you from the chat — and both can be moved (`config set keys.chatFocus <key>`,
`keys.chatCollapse`) to another chord: Ctrl or Alt held, or an F-key. A key that types
would be taken from every field, so it is refused (the log says so) and the default
kept. They do nothing while the `:` line is open.

`/mode window` puts the chat in a window over the screen instead, and Esc Esc closes
it; `/mode full` gives it the whole terminal — code, tables and diffs get every
column; `/mode panel` docks it again. That is for the session; from the start:
`config set plugins.assistant.mode window` (or `full`). Where the panel goes and how
big it is: `plugins.assistant.panel.side` (`right` or `bottom`) and
`plugins.assistant.panel.size` (percent of the width on the right, 35 by default; of
the height at the bottom, 40). A config that still says
`plugins.assistant.fullscreen: true` is read as `mode: full`.

To show the assistant an image — a screenshot, a mock, a diagram — drag the file onto
the terminal (or paste its path), type `/image <path>`, or press Ctrl+V (Cmd+V where
the terminal passes it on) for the image on the clipboard. It becomes an `[Image #1]`
token in your message, and Backspace takes the token away whole. PNG, JPEG, GIF and
WebP, up to 5 MB (`ai.images.maxBytes`) and 4 a message (`ai.images.maxPerMessage`);
a bigger one is refused, never shrunk. The session keeps the file's path and hash, not
the picture, and reads it again after a restart. A tool that fetched images itself —
the screenshots attached to an issue — can show them to the assistant too, under the
same limits; the chat shows one `▣ shot.png · 400×300` row per image under the call,
never the image, and nothing the assistant reads can make the host open a file or a
URL as an image. A model that cannot take images: `config set ai.images.enabled false`.

Bulky things — an image, a `!command`'s output, a large tool result — are sent to the
model in full in the turn they arrive in, and later as a one-line stub naming an id
(`[$ brew update — exit 0 · 24.7 s · 120 lines — recall("out:7d41e0aa")]`) that the
assistant reads again with its `recall` tool when it needs the content; the screen and
the session keep everything. Stubbing happens in batches, once the context passes half
the window (`ai.recall.threshold`) or every ten turns (`ai.recall.everyTurns`), so the
provider's prompt cache is missed rarely; `/context` says how many items are stubbed.
`config set ai.recall.enabled false` sends everything in full every time.

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
The assistant moves the directory itself with its `cd` tool — "go to the project" —
without a y/n, since it runs nothing, and only inside `shell.roots` (with no roots set
it cannot move at all).

Wherever the directory is — at the start, after `!cd`, `cd` or a command's own `cd` —
the assistant is given the project's own rules: every `AGENTS.md` from that directory
up to the `shell.roots` entry holding it, outermost first and the nearest last, so the
nearer file wins where two disagree. They go into its instructions as a section of
their own, each file under its path, read again whenever the directory moves; a line
in the chat says which files were picked up (`Project instructions: ~/src/app/
AGENTS.md`). A file over 32 KiB is cut at a line, with a note saying how many lines
were left out. Nothing outside `shell.roots` is read — with no roots set, nothing is.

`!!command` is for a program that needs the terminal — a prompt, `git add -p`, `top`,
a login flow (`!!npm login`); or press `!` again on the still-empty line once already
in shell mode (Backspace steps back the same way, one bang at a time). The chat steps
aside and the program has the whole terminal, keys included (Esc and Ctrl+C are the
program's); when it ends the chat comes back as it was. What the program printed is
recorded with `script` — colours taken out, a progress bar in its last state — and
lands as the command's line, marked `interactive`, like any `!command`'s; then,
whenever something was recorded, the assistant is asked at once to look at it: what
happened, whether anything went wrong, what next. That ask is drawn dim: it is the
app's, not yours. A full-screen program (`vim`, `less`, `top`) leaves nothing behind
once it closes, and without `script` on PATH nothing is recorded at all — then the
line says how it ended and the assistant is not asked. Whatever the program echoes —
a value you type at a prompt that shows it back — is part of the recording: it goes
to the assistant and is saved with the session (a password prompt echoes nothing).
Like `!`, it is refused while an answer is coming.

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
still sets the roots as `fs.roots` works for one more
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