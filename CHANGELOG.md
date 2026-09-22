# Changelog

What each version of flow-assist brought, newest first. The version is the one in
`package.json` (and `hostVersion()`, which a test keeps equal to it).

## Unreleased

- **The command line can be copied at last.** A drag over `:` picked up nothing: the
  whole bottom row was marked "not text", which is right for the prompt and the
  completion offered after the caret and wrong for the command you typed — so a long
  `config set plugins.mcp.servers.safari.readOnly …` could not be taken out to be
  fixed or shared. Dragging over it now copies exactly what you typed: no `: ` in
  front of it, nothing of the greyed-out offer after the caret, nothing of the `⇥ a · b`
  candidates beside it, and nothing of the hints or the message that have that row when
  the line is closed. The drag stays on its row, so it picks up nothing of the screen
  above either. The chat's own field is unchanged for now — its caret and placeholder
  sit in the middle of the text, which needs its own answer.

- **One line instead of the folded notes: what it is doing now.** Between tool calls
  the assistant writes prose, and every answer carried a dim `▸ notes` header with the
  last two lines of it — a header for text that is mostly noise, with the one thing
  worth seeing, what it is about to do, hidden inside the fold. In its place there is
  now one quiet line: the last thing it said it is doing, cut to the width. It changes
  only on a finished sentence and at most once a second, so it settles instead of
  flickering, and the answer's own text never appears in it. `^r` still shows
  everything it said, word for word, and a drag over the answer copies the answer, not
  the line. A turn that said nothing on the way draws no line at all. The assistant is
  also asked for less: before a tool call, one short line starting `Next:` and nothing
  else — so there is one sentence per step and far less to fold. If you preferred the
  old look, `config set plugins.assistant.notes fold` brings it back, `open` shows the
  narration unfolded and `hidden` puts none of it on the screen once it has been
  written; `/notes [step|fold|open|hidden]` changes it for the conversation you are in.

- **A command you confirmed shows what it printed.** You said yes to a `run_command`,
  it ran on your machine, and all you saw of it was one dim line under `^r` — while
  your own `!command` shows its whole output. It now leaves the same block in the chat:
  the `$ command` line, what it printed, and `exit 0 · 1.2 s · ~/dir` under it. The
  last 20 lines stand there (`config set plugins.assistant.runOutputLines 40` for
  more), with `… N lines cut · ^r for all` when there was more and `^r` showing all of
  it. A command you declined leaves nothing — it never ran; one that failed shows what
  it printed before it died, with its exit code. The block is yours alone: the
  assistant reads the output through the tool's own result and is never sent a copy of
  it, so the conversation does not pay for it twice. Under it, a tool can now describe
  how its result should be SHOWN and the host draws the block — the first of several
  kinds to come.

- **The status line times the thing that is running, and says what the turn costs.** A
  turn that ran a build sat at `3m 12s`, which told you nothing about what was
  happening. The seconds are now the running thing's: a tool's while it runs
  (`⚙ run_command $ bun test… 8.1s`), the assistant's current round when none does, and
  they start again with the next tool. The turn's own total stays where it is read
  afterwards — the quiet line under the finished answer — and that line now also says
  what the turn cost: `· 12.4 s · ▸ 3 tools · 3.1k tok`, the tokens the provider
  reported for it, on the status line as it runs and under the answer when it is done.
  A provider that reports nothing shows no figure, never a guess.

- **Answering the assistant's question: just type, and the field is a real field.** A
  question with options used to take typing only after you walked to its "Other…" row;
  any printable character now opens the free-text field with that character already in
  it, while `1`–`9` still pick an option (the hint line says so). And that field is the
  chat's own editor at last: a visible caret, caret motion by character and word,
  Home/End, the kill bindings — and a paste goes in at the caret, where it used to be
  dropped entirely, so a path or a ticket's text can finally be given as an answer. It
  is one line, so a pasted line break becomes a space. Esc still leaves the field for
  the list, and Esc on the list still dismisses the question.

- **Stop confirming for a while: `⇧⇥` and `/auto`.** A long working session is a long
  series of y/n. Shift+Tab steps the chat through three modes — ask (where every
  conversation starts), `auto: reads` (only what the assistant itself reads runs
  unasked, every write still stops) and `auto: writes` (a write runs too) — and
  `/auto reads|all|off` says the same in words. The mode is on the hint line the whole
  time it is on, while an answer is coming as much as between turns, and it belongs to
  the conversation alone: a restart, `/clear`, `/resume` and a change of task all put it
  back to asking, and it is never written to the session file. Two things are never
  automatic, whatever the mode: `run_command`, whose y/n is its only guard, and a
  `web_fetch` to a host that is not on `web.allowlist`. A background task declines
  writes as before, and your own `!command` is unaffected. What ran without being asked
  about is still shown — the `✎` diff block and the tool trail are unchanged.

- **Tell the assistant which of a server's tools only read.** `config set
  plugins.mcp.servers.safari.readOnly '["list_tabs","page_info"]'` — the tools of that
  MCP server you have checked yourself, by the names the server uses; each of them runs
  without a confirmation. It is your claim, and it stands on its own: `trusted` is the
  other, narrower one ("I believe this server's own `readOnlyHint`"), and a server that
  makes no claims at all — a browser's does not — could not be helped by it. Everything
  else is unchanged: still a y/n, still declined in a background task. A name the server
  does not offer is said once in the log at start, so a typo does not sit there quietly
  doing nothing.

- **The running tool's name carries a band of light**, instead of the whole word
  changing colour four times a second, which read as blinking. Needs flowtty
  1.0.0-alpha.21.

- **The chat stays quick however long the conversation is.** Typing grew slower with
  every turn — a keystroke took 13 ms in a fresh chat, 75 ms after 40 questions and
  144 ms after 80, and an answer arriving paid the same for every word it wrote, so a
  long conversation stuttered as it came in. The conversation now lays out only the
  rows on screen, and a keystroke costs the same at any length. Needs flowtty
  1.0.0-alpha.20.

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
