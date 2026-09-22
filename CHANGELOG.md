# Changelog

What each version of flow-assist brought, newest first. The version is the one in
`package.json` (and `hostVersion()`, which a test keeps equal to it).

## Unreleased

- **An MCP server can be a command now, not only a URL.** `config set
  plugins.mcp.servers.safari.command /usr/bin/safaridriver` and `… .args '["--mcp"]'`
  give the assistant Safari's 17 tools — the tabs, the page, a screenshot — and any
  other server that speaks MCP over stdin and stdout works the same way; `env` passes
  it variables, `${VAR}` and all. The process starts with the assistant and is stopped
  when it ends: on `:quit`, on Ctrl+C, on SIGTERM, and when a one-shot command has done
  its work. One that does not answer the handshake in time is stopped and skipped, as
  an unreachable URL is; one that dies is not restarted, and its calls then say which
  server it was and what it last wrote to stderr. Tools a browser offers carry no
  read-only claim, so even a `trusted` server asks before every call — Safari holds
  your logged-in sessions.
- **The installed binary finds its plugins from any directory.** Started as
  `./kit/flow-assist` from somewhere else, it looked for `plugins-enabled/` in the
  working directory, found none, and ran with the host's own tools only — saying
  nothing. It now looks beside itself (following a link to the binary), and the
  working directory is only the last resort. A `.env` beside the binary is read too,
  and never overrides a variable already set in the environment. When no plugin is
  enabled, the start screen, the log, `plugins ls` and a one-shot prompt say which
  directory was searched.
- **`tools_load` takes a group's name among `names`.** `tools_load({ names: ["web"] })`
  was refused as "not in the list" by an error that listed `web` as a group; it now
  loads the group. A tool of the same name still wins.

- **Show the assistant an image.** Drag a screenshot onto the terminal (or paste its
  path — quoted, `\ `-escaped, several at once), type `/image <path>`, or press Ctrl+V
  for the image on the clipboard (an empty Cmd+V paste does the same; macOS uses
  pngpaste or osascript, Linux wl-paste or xclip). The image becomes an `[Image #N]`
  token in your message: Backspace takes it away whole, the numbers go on for the
  whole conversation, and ↑ brings a message back with its images. It is sent as an
  image part (OpenAI-compatible) and stays in the model's view until `/compact` or
  `/clear`. PNG, JPEG, GIF and WebP, told apart by their bytes; up to 5 MB and 4 a
  message (`ai.images.maxBytes`, `ai.images.maxPerMessage`) — a larger one is refused
  with the reason, never shrunk. The session keeps the file's path and hash, not the
  picture; after a restart it is read again, and a file gone or changed is said in
  the chat and the text goes without it. `ctx N%` counts an image by its pixels. A
  model that cannot take images: `config set ai.images.enabled false`; when a provider
  refuses one, the chat quotes it once and names that command.

- **A turn stopped with Esc stays stopped.** The next message used to be answered
  together with the stopped one — the model went back to the work the person had
  interrupted, because to it the stopped question was still waiting. Now the model's
  history records the turn as stopped and not to be resumed unless asked, and keeps
  the tool calls that finished before Esc (a write that landed is no longer forgotten).
  A turn that fails is recorded the same way, as a failure, so asking to try again
  works as expected.
- **Your message is shown as you typed it.** A message written over several lines
  (⌥⏎, ⇧⏎ or `\`⏎) was drawn as one line, an indent was lost and `- a` became a
  bullet; now every line, blank line and leading space is kept, nothing is read as
  markdown, and a drag copies it back with its line breaks. What the model was sent
  never changed.

- **Tools on demand.** A request no longer carries the full definition of every
  enabled tool. It carries the core tools (`todo`, `ask_user`, `memory`, …) in full and
  an index of the rest — each tool's name and one line, grouped by plugin — and the
  model loads what a task needs with `tools_load`, by name or by group. A loaded tool
  stays for the rest of the conversation: it is saved with the session, kept through
  `/compact`, and `/clear` empties the set. A call to a tool that was not loaded is
  answered with an error that says how to load it. `ctx N%` and `/context` count
  what is actually sent. `config set ai.toolLoading all` goes back to the full list.

- **`/fullscreen [on|off]`** — the chat takes the whole terminal instead of a
  centred window, and its text wraps at the full width;
  `config set plugins.assistant.fullscreen true` starts it that way.

- **Readable on a light terminal theme.** The chat, the log, the help, the reminder and
  the keycaps panel paint a dark ground of their own; their text now takes the
  palette's `text` colour instead of the terminal's foreground, which on a light theme
  was black on black. Needs flowtty 1.0.0-alpha.16.
- **Text being selected with the mouse is readable on a light theme.** The selection
  used to vanish there: dark text on a dark band. The band now takes the colour of the
  text under it. Needs flowtty 1.0.0-alpha.18.
- **Follows the terminal between light and dark, while it runs.** The windows, the
  chat and the keycaps panel take a light or a dark palette by the terminal's scheme
  and repaint when it switches (macOS does at sunset and sunrise); a terminal that
  does not say gets its own background and ink. A plugin's colours written as
  `${token}` follow too. The person's `config.theme` wins over every scheme. Needs
  flowtty 1.0.0-alpha.17.
- **`ft.useSurfaceSize()`** — the room a plugin's surface has between the title bar
  and the command line. A surface sized by the terminal was four rows too tall and
  pushed the command line off the screen.

## 0.1.0 — 2026-09-22

The first version: a terminal assistant host that knows no company and no system,
with everything specific delivered by plugins.

- **Plugins** register surfaces, commands, keys, tool groups for the model, config
  schema, and the two chat hooks — what the screen is about, and a reload after a
  write. Installed from a package registry, from an archive (`plugins install
  ./notes-0.1.0.tar.gz` or its https URL — checked before it is unpacked, and never
  over a checked-out plugin), or linked from a repository of their own; a published
  plugin ships its build (`files` in its package.json names what goes).
  Bundled: `repo` (read the configured clones; branch, commit, push), `gitlab`
  (merge requests through `glab`), `mcp` (tools from MCP servers).
- **The chat**: an LLM agent loop over an OpenAI-format API, with a y/n pause before
  every write; what a write changed stays in the chat as a diff, and is never sent
  back to the model. Streaming with a status line that says what happens now,
  a queue while an answer is written, `ask_user` questions, a plan (`todo`), memory,
  reminders, background tasks, `/compact`, `/context`, `/copy`, sessions that survive
  a restart (`/resume`), `!command` and shell mode, `run_command` behind the y/n,
  `web_fetch` with an allowlist and private addresses refused.
- **The screen**: a start screen, a command line (`:`) with inline completion, help,
  the log, keycaps, mouse wheel, and drag-to-copy through the terminal's clipboard.
- **Distribution**: runs with `bun src/cli.ts`, or as a compiled binary with built
  plugins beside it.
