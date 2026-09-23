# Changelog

What each version of flow-assist brought, newest first. The version is the one in
`package.json` (and `hostVersion()`, which a test keeps equal to it).

## Unreleased

- **A turn reads in the order it happened, and nothing it wrote jumps away.** A turn
  used to be laid out by kind — what the assistant said, then every diff, then the
  answer — so text that turned out to come before a tool call moved up above all the
  diffs of the turn. With a tall diff it left the screen, and the chat looked as if
  text had been lost or a file written twice. Now what it said, each diff and the
  answer stand in the order they came, and a round's text stays where it was drawn:
  dim, with a spinner beside it, until it is known to be the answer, which then gets
  its `ƒ`. What it said between tool calls folds to one quiet line per stretch —
  a diff or a command ends a stretch — showing the latest thing it said and how many
  steps there were (`▸ Now the tests.  (3 steps)`, no count for one); a click opens
  that stretch where it stands, `^o` opens them all. `/notes open` shows every step in
  the normal colour. The `Next: …` lines the assistant writes before a tool call are
  never shown. `/notes fold` and `/notes hidden` are gone — a config that still says
  either reads as the default — and so is the separate step line above the answer.
  Sessions keep the new order; older ones still open. A round whose text and tool call
  arrived together could also be lost, depending on how the network split the reply;
  it is kept now.

- **Scrolling the chat is about twice as fast.** The app ran React's development
  build — Bun leaves `NODE_ENV` unset, and React takes that as "development", with
  checks and bookkeeping on every render. `flow-assist` and `bun src/cli.ts` now run
  the production build unless `NODE_ENV` says otherwise, and `bun run build:binary`
  compiles only the production build into the binary.

- **A scroll step redraws only what moved.** Every wheel step or PgUp used to
  re-render every row near the screen and paint the scrollbar twice; now a small step
  re-renders nothing and the bar moves with the rows. Needs flowtty 1.0.0-alpha.22.

- **Two flow-assist processes no longer silently clobber one session.** A session
  held by a live chat now has an ownership lock: a second process starting up, or
  `/resume`, leaves a session another live instance holds alone (starts or stays on
  its own, with a note naming the lock file) instead of continuing it and racing
  the first process's saves; a lock whose owner is gone (or a corrupt lock file
  older than five seconds) is taken over. And a save that finds the file changed on
  disk since it last read or wrote it — an older host with no lock, a hand edit —
  no longer overwrites that change: it saves the conversation as a new session
  instead, so nothing is lost either way. The check is not the rev counter alone
  (a hand edit that leaves it untouched, or two rev-less writes from an old enough
  host, would slip past that) but the file's own size and modified time too — taken
  with a stat before a resumed or continued session's content is read, never after,
  so a write landing in between is caught rather than quietly recorded as seen.

- **A tool call with broken arguments no longer breaks the conversation for good.** A
  reply cut off mid-argument used to be stored as it arrived and run as `{}` anyway —
  every later message then failed the same way, since the provider rejects a history
  carrying invalid JSON, and `/clear` was the only way out. It's now refused at the
  call (the model is told why, and asked to call it again) and repaired if it's
  already sitting in a saved session.

- **A command shows its output while it runs: one line in the chat that a click opens to its last lines, and that stays — as you left it — once it ends.** The person's own `!command` too — its block still shows where it ran, and where a `cd` inside it left the conversation's directory.

- **A finished command, folded, is one line saying how it ended:** `✓ 4.2 s`, `✗ exit 1`, `stopped`, `timed out`.

- **Consecutive commands fold under one line,** `Ran 3 commands · ✓ 34.0 s`, **and open into their own blocks.**

- **Plugins: `viewRenderers` and `ctx.liveView`** — a tool can show a block of its own and update it while it runs. See `docs/plugins.md`.

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

- **The tests no longer write into your memory, or empty your cache.** If you found
  the same fact in `/memory` over and over — "This repo prefers rebase over merge",
  thirty-odd times — nobody stored it thirty-odd times: the host's own test suite did,
  once per run. A test that booted the assistant and let it use its `memory` tool named
  no file of its own, so the entry landed in `~/.config/flow-assist/memory.json`, and
  the same went for `cache.json`, which a test emptied and rewrote. Under a test run
  the host now keeps what it writes for itself in a temporary directory, the cache
  keeps its store in memory, and each booted test gets a memory file of its own.
  Nothing already stored was touched: `/memory` lists what you have and
  `/memory forget <number>` or `/memory forget all` removes it — your file, your call.

- **The assistant is told how to write a memory, and the host holds it to it.** Every
  stored fact is sent with every later request, across `/clear` and across restarts,
  so a sloppy one is paid for forever. The `memory` tool now asks for one durable fact
  per entry — a preference, a convention, a name — in a short sentence that stands on
  its own, never the state of a task, a number that will change or a secret; and to
  update the entry that already says it instead of adding a near-copy. Three of those
  the host enforces rather than hopes for: the same fact in other spacing or case is
  refused, naming the entry it duplicates; an entry over 300 characters is refused with
  its length; and past 100 entries it refuses and names the oldest, so the memory
  cannot quietly grow into every future request. Each refusal says what to do instead,
  and `/memory` stays your own way to see and prune the list.

- **Click what you want to read.** Everything the chat folds answered to one key, and
  it opened EVERYTHING at once: to read the output of one command you unfolded the
  whole conversation and folded it back. Now a click opens the block under it — the
  `▸ N tools` line of a turn, the quiet line of narration, a command's
  `… N lines cut` — and a click anywhere inside an open block closes it again. A drag
  is still a selection: only a press and a release on one cell, with no drag between
  them, counts as a click, so copying text out of an open block never folds it. A
  block opens at its FIRST row, where reading starts, instead of dropping you at its
  end; closing one leaves the line you were on where it was. Nothing else on the
  screen became clickable. The key is now **`^o`** and it is the master switch: with
  anything folded it opens everything, pressed again it closes everything, and either
  way the blocks you clicked go back to following it — so there is always one
  keypress back to a screen you can describe. It is a bound action at last
  (`config set keys.details <key>` moves it, and every hint draws the key you bound);
  `^r`, which it used to be, still works and is in no hint any more.

- **A long tool trail is no longer a sheet of grey.** A turn that ran to the round
  limit printed one dim line per tool call — dozens of them — and what you needed,
  that the turn had ended without an answer, was somewhere in the middle. Consecutive
  calls of the same tool are now one line with a count (`read_file ×12`; the arguments
  are in the log, `L`), an open trail shows its last twelve lines with
  `… N earlier calls` above them (click that to see the rest), and the folded summary
  says what each tool cost in calls. When a turn stops because it ran out of rounds,
  it says so where the answer would be, in the warn colour:
  `stopped after 64 rounds — no answer; say "continue" to carry on`. A write that
  happened and a call that failed still each keep a line of their own — that is how
  you know why an answer is thin.

- **What a write changed reads like a diff again.** The block carried a dim `diff`
  label row under a line that already said this was a change to a file (and a
  `console` row under the `$ command` line that said it better) — both are gone, while
  the fence keeps its language, which is what colours a diff green and red. The `✎`
  title is a title now: plain text with the path in the chat's accent colour and
  `· +N −M` quietly beside it, instead of a fragment of inline code. And every row
  carries **the line it is in the FILE** — a context or added row its number in the
  new file, a removed row its number in the old one, counted again per hunk — so the
  `@@ -1,3 +1,3 @@` row could go. The numbers are chrome: dim, right-aligned, and out
  of a selection, so a drag still copies the code alone.

- **What you were reading is never taken away.** While a round streamed, its text was
  drawn as the answer — the chat could not know yet whether the round would end with a
  tool call — and when it did, the paragraph you were halfway through was
  reclassified as narration and vanished into the line above. A blink, and a lost
  sentence. A line that starts `Next:` is now narration from its first characters and
  is never drawn as answer text; a round that turns out to carry tool calls keeps
  whatever of its text was already on screen, dimmed where it stands, instead of
  disappearing. The answer is only ever added to.

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
