# Changelog

What each version of flow-assist brought, newest first. The version is the one in
`package.json` (and `hostVersion()`, which a test keeps equal to it).

## Unreleased

- **`:plugins`: the plugins, their states and what you can do to them.** `:plugins` on
  the `:` command line lists every plugin with its version, its state — `active`,
  `starting…`, `skipped: <why>`, `missing settings: …`, `not trusted`, `disabled` — and
  what it brings (tool groups, tools, keys). It works with the chat closed, which makes
  it the place to look when a plugin is broken; `/plugins` in the chat opens the same
  list in the chat's frame. ⏎ shows a plugin's details (its ranges, why it was skipped,
  its settings with the missing ones marked), `t` its tools, `r` restarts a plugin in
  another language, `d` disables or enables one — disabled, its tools leave the
  assistant at once and its screens and keys go at the next restart; its link waits in
  `plugins-enabled/.disabled/`, still installed, `plugins ls` says `disabled`, and its
  trust is forgotten, so enabled again it waits for `y` — and `y` trusts one, showing
  where its link leads (both places when it moved) and waiting for a second `y`. Every
  plugin the list loads is checked for trust again and loaded from where it was trusted:
  a link a command moved meanwhile loads nothing.
  Installing, removing and updating stay `flow-assist plugins …`.
  **For plugin authors:** nothing to change; the person can now disable your plugin
  while the app runs (docs/plugins.md, "Where a plugin lives").
- **A tool a plugin takes away is gone for the rest of the run.** A plugin that dropped
  a tool while the app ran (a server turned off or gone) left it callable by its name: a
  model that had seen it could still run it. Now such a call never runs, and the model is
  told why — `<tool> is gone — <plugin> removed it`. After `/mcp remove`, a call from the step already running is told the
  server was removed by you, not that it came back and should be called again.
  **For plugin authors:** a tool group may say for itself why its tools went, with
  `gone: () => string | null` (docs/plugins.md); your `exec` is no longer called for a
  tool you took away — an older host with the same API number still calls it, so keep
  answering there. The host API number is unchanged.
- **The examples show what a plugin can do now.** `examples/notes`' command is
  `notebook`, marked `chat: true`, so it answers `/notebook` in the chat with a note as
  well as `:notebook` on the command line (the chat's own `/notes` keeps its name); its
  block's `✎` marker is `chrome`, so a drag copies the note alone; and its `file` key
  says why it carries no mark for the model. `examples/remote-login` writes who signed
  in to `host.store`, which the app's other plugins read. docs/plugins.md, its wire
  transcript and `@flow-assist/remote`'s README match them, and a test holds both
  examples' manifests to this host. **For plugin authors:** nothing changes in the
  contract; copy from the examples again if you started from them.
- **The bundled `gitlab` and `repo` plugins declare no dependencies.** Their stale
  flowtty alpha.2 and zod devDependencies and their lockfiles are gone: their sources
  import only Node's modules, and `repo`'s tests take zod from the host's checkout, as
  `mcp`'s do.
- **flowtty 1.0.0-alpha.37: Shift+Enter starts a new line.** The TTY backend asks the
  terminal for the kitty keyboard protocol, so in kitty, Ghostty, WezTerm, foot,
  Alacritty and iTerm2 3.5+ Shift+Enter is its own key and breaks the line; the hints
  name it first, `⇧⏎/⌥⏎ new line`, since Terminal.app still sends it as Enter. Alt+Enter
  and backslash-then-Enter work as before; docs/usage.md says which works where. In
  those terminals Esc arrives at once, and Ctrl+[, Ctrl+I and Ctrl+M are keys of their
  own rather than Esc, Tab and Enter — nothing in the host was bound to them. A
  `ScrollBox` around a focusable flowtty field reveals it only when a click moves
  flowtty's own focus onto that field — Tab goes to the host in a plugin's screen, not
  to flowtty — and while the focused field grows; mounting and auto-focus move
  nothing, and a scroll the person made is never undone.
  **For plugin authors:** declare `"flowtty": ">=1.0.0-alpha.37 <1.0.0-alpha.38"` — a
  manifest still declaring the alpha.36 range is refused as incompatible. The host
  API number is unchanged.

- **A plugin loads only when you trust it, and a memory the app did not write is not
  sent.** A command could leave something the app trusts at its next start — a link in
  `plugins-enabled/`, which runs with the app's rights, or a file in the assistant's
  `memory/`, which rides in every later request. Now the app records what it put there
  itself. A plugin in `plugins-enabled/` that you did not install or trust is not
  loaded; the start screen and the log say `not trusted — flow-assist plugins trust
  <name>`. `plugins install` trusts what it installs, the new `plugins trust <name>`
  trusts a plugin linked by hand or by an installer script, `plugins remove` forgets
  it, and `plugins ls` marks an untrusted one. Trust is the plugin's name and where its
  link leads, so updating it in place keeps it. A link that now leads elsewhere shows
  both places on the start screen, and `plugins trust` shows both and asks first
  (`--yes` answers for you). A plugin's name is letters, digits, `.`, `_` and `-`; any
  other entry is refused. A plugin the assistant installs is not trusted until you run
  `plugins trust`, whatever was trusted under that name before; a link that is gone is
  forgotten at the next start, though where it led is kept, so a link put back
  elsewhere still shows both places and asks. `plugins install` from your terminal
  says `installed and trusted`.
  A memory fact changed or added outside the app is left out of every request, of a
  plugin's list and of `MEMORY.md`, and shown in `/memory` as `changed outside
  flow-assist` together with the line a request would carry for it; `/memory accept <n>`
  (or `all`, which is only what that listing showed) sends it again as the listing
  showed it, and refuses if the file changed since. A memory record deleted while the
  app runs sends no fact until the next start, and the chat says so. A `memory.json` that turns up after the first start is moved into files as
  before, but its facts wait for `/memory accept` too.
  The first start after upgrading — with no record yet — trusts the plugins already
  enabled and accepts the facts already stored, once, and the start screen names the
  plugins; a plugins or memory directory first met after that starts with nothing
  trusted; a deleted record makes the next start a first start again, and its screen
  says so. A record that cannot be read trusts nothing, and the start screen says how
  to go on. From a command the assistant runs, `plugins trust` is refused and nothing
  is recorded. Like the settings guard, this stops accidents, not a command set on
  getting round it — docs/safety.md says where it stops.
  **For installer scripts:** one that unpacks each version into the same
  `plugins-available/<name>` and links `../plugins-available/<name>`, without the binary,
  keeps an updated plugin trusted; a plugin new to that install needs
  `flow-assist plugins trust <name>` once.
- **A background run and the one-shot prompt read the project's instructions once per
  directory.** Both built the `## Project instructions` section through a closure that
  walked the directory and reread every `AGENTS.md` again before every round, even when
  the shell had not moved — up to twelve reads for a twelve-round task, and a file
  edited mid-task could change the prompt under a running round. They now read it once
  when their shell's directory is set and keep it until `cd` moves it, the same rule
  the chat's own reading follows.
- **A block scrolled to its top starts under the pinned question, not behind it.** A
  run of steps, a command's output, a trail of calls or the reasoning, opened to its
  first row, landed that row on the very top of the conversation — where the pinned
  question is painted over it once the list is tall enough to pin. The rule is the
  same for every kind of block; closing one still leaves the eye on the exact screen
  row it was on.
- **The screen is drawn at once.** The app waited for every plugin before its first
  frame — a plugin in another language until its process had started and answered, the
  `mcp` plugin until every server had — which cost one and a half to three seconds at
  every start, more with a slow server. Now it draws straight away (about 0.2 s here),
  and the start screen says what is still on its way, `starting: tutor, mcp…`,
  until each has joined or failed. A plugin that joins brings everything with it — its
  line on the start screen and the key that leads in, its keys, screens, commands and
  tools — without a restart and without touching the chat; one that fails is a
  `[plugins] skip …` line in the log, as before. An MCP server's tools join as it
  answers. A message sent before then runs with the tools there are, and gets the new
  ones from its next step; a write among them still asks. A plugin that joins late takes
  its place in the enabled order, and a tool name the model already has stays with its
  tool: a late plugin's tool of the same name is offered as `<plugin>:<name>`, said in
  the log. What a plugin's process writes to stderr while it starts goes to the log
  (`L`), no longer to the terminal after the app ends. Quitting while a plugin is still
  starting stops its process too. The plugins also load side by side rather than one
  after another. `/mcp restart` of a server whose entry is invalid (both `url` and
  `command`, say) now says why in the log instead of nothing. The one-shot prompt (`flow-assist "…"`) still
  waits for every plugin and server before it asks the model.
  **For plugin authors:** a builder that waits on someone — a server, a process —
  returns at once and sets `ready`, a promise that settles when it is done waiting; the
  app names the plugin as starting until then, and the one-shot prompt waits for it. Its
  tools join through `toolsChanged`, which now reaches a turn already running from its
  next round. An addition: the host API number is unchanged.

- **flowtty 1.0.0-alpha.35.** A wheel flick over a run of identical reports in one
  read is now one `wheelup` / `wheeldown` key with a `count` — the run's length,
  absent for a lone notch — instead of one key per notch. `ScrollBox` and
  `ScrollList` scroll `wheelStep × count` on their own; the chat's own wheel path,
  taken while a docked chat is not focused, honors `count` too.
  **For plugin authors:** declare `"flowtty": ">=1.0.0-alpha.35 <1.0.0-alpha.36"` — a
  manifest still declaring the alpha.34 range is refused as incompatible. The host
  API number is unchanged.
- **What the assistant said between its tool calls opens in the conversation, however
  long.** A click on a folded run of steps taller than the conversation put it in the
  pager, in the conversation's place, until Esc; now it opens where it is, read beside
  the rest. The pager stays for a command's output, a trail of calls, the reasoning and
  a `/compact` summary.
- **Back to the end of the conversation in one step.** Scrolled up — or with a long
  answer resting at its first line — a `↓` sits in the conversation's bottom-right
  corner, `↓ new` once something has arrived since. A click on it or End brings the
  conversation to its end (with text after the caret in a draft, End still moves the caret);
  `config set keys.toEnd <key>` moves the key.
- **`stopped (Esc)` is the last line of its turn.** A turn stopped while a command's
  block (or another tool's view) was the newest thing in it drew the label above that
  block. The label now stands under everything the turn did — a call that was still
  running at Esc and finished included, its ✎ above the label when it wrote. The same
  holds for a failed turn and one that stopped at `ai.maxRounds`.
- **The caret stands where you are, after a CJK character or an emoji too.** In the
  chat's field the caret was drawn one cell off for every wide character before it;
  the session picker's rename and filter fields could draw it on half of an emoji. The
  pinned question and the y/n block's capped text are cut between characters, never
  through an emoji.
- **A colon typed or pasted into the `:` line stays.** `:config set ai.baseUrl
  https://…` kept `https//…`: every `:` typed while the line was open was dropped, and
  a paste did not reach the line at all. Now `:` opens the line when it is closed and
  is a character once something is typed (on an empty line it still does nothing); a
  paste goes in whole, its line breaks as spaces.
- **Typing and scrolling in a long conversation are lighter.** A key typed into the
  field no longer draws the conversation above it again — the rows in view are left
  as they are, while an answer is being written too — and a wheel step draws only the
  rows that come into view.
- **`:perf` says how fast the app answers.** Every frame is counted by the input that
  led to it — typing, the wheel, another key or click, or none (a redraw) — and `:perf`
  reports the median, p95 and slowest wait from the input to the screen for each, over
  the last 200 frames, into the log, with the p95s in the toast. A frame slower than
  50 ms leaves one line in the log with what it cost, at most one a second (the slow
  frames in between are counted into the next line).
- **flowtty 1.0.0-alpha.34.** Scrolling and typing in a long conversation are
  lighter: a re-render no longer re-applies the layout of every box it touched, only
  of the boxes whose layout changed, so a wheel flick or a keystroke no longer lays
  the whole visible part of the conversation out again.
  **For plugin authors:** declare `"flowtty": ">=1.0.0-alpha.34 <1.0.0-alpha.35"` — a
  manifest still declaring the alpha.33 range is refused as incompatible. The host
  API number is unchanged.
- The README is short; the manual lives in docs/usage.md, docs/safety.md and
  docs/config.md.
- **What a click acts on shows it under the pointer.** A fold line in the chat — a
  turn's `▸ N tools`, a folded run of steps, the thinking header, a command's line and
  its `… N lines cut` — is underlined while the pointer is over it, the look flowtty
  gives its own pickers; the answer, your message and an open block's text never
  change. The session picker's rows and a command panel's (`/mcp`) are underlined the
  same way, and a click on one puts the cursor there (⏎ still opens). A plugin's
  flowtty pickers underline their rows too. Moving the pointer redraws only the row it
  enters and the one it leaves. On with the mouse; `config set ui.hover false` keeps
  the mouse without the motion reports (takes effect on restart).
- **flowtty 1.0.0-alpha.33.** A box can take a click itself (`onClick`), and
  flowtty's pickers do: a click on a plugin's list row moves the highlight there, on a
  multi-select row or a checkbox toggles it, on a dropdown opens it. Such a press is
  taken before any key handler, so the host tells the chat where it landed itself — a
  click on a plugin's list in the docked layout still moves the keyboard to the plugin.
  A remote plugin's list or dropdown sent without an `id` no longer throws when clicked
  or moved through: nothing holds its value, so the change goes nowhere. Two new key
  names, the pointer moving and leaving the window, get short caps.
  **For plugin authors:** declare `"flowtty": ">=1.0.0-alpha.33 <1.0.0-alpha.34"` — a
  manifest still declaring the alpha.31 range is refused as incompatible. The host
  API number is unchanged.
- **The assistant reacts when background work comes back.** A background task's result
  waits until the answer being written ends — it never cuts into a turn — then lands in
  the chat, and the assistant takes it up: in one turn for everything that came back
  together, or in the turn of a message you had queued, which it reads with them. A
  draft in the field stays put and a closed chat still gets the turn (with `◆ N new` and
  a notification); a y/n or a question waiting for you holds the results until you
  answer, and a turn you stop — or one that stopped at a limit, keeping its `⏎ continue`
  — lands them without a new turn.
  `config set ai.backgroundFollowUp false` keeps them as messages only.
- **Known secrets never reach the assistant or the records.** Every token the app
  knows — the variables the config names (`${VAR}`, `ai.tokenEnv`), any variable whose
  name says it is a token, key, secret, password or cookie, a credential written into
  the config — is replaced by `‹secret NAME›` in tool results, command output (streamed,
  a token split across chunks included, and base64 or URL-encoded forms too), views, the
  assistant's answer, what a plugin says in the chat (notes, `/mcp`'s list, toasts) and
  the log, before it is sent, drawn, saved or journaled. An MCP header that names a
  variable counts as it is sent.
- **The assistant's commands start without your tokens.** `run_command` starts with every
  secret variable the app knows taken out of its environment and says which, by name,
  once per conversation; `shell.passEnv` (yours to set, never the assistant's) lists
  the ones a command may see. Your own `!command` keeps the whole environment. Like the
  redaction, this stops accidental exposure, not a command written to find a token
  (docs/safety.md says how one could); running commands unasked stays your trust decision.
- **A settings file changed behind the app's back is asked about, not applied.** The
  app remembers the settings it accepted; a change to `config.local.json` or
  `config.json` it did not make — a command's, another terminal's, an edit while it
  was off — leaves it on the accepted settings, and the chat asks `… changed outside
  flow-assist — apply? (y/n)` with the keys that changed. Yes applies it; no puts the
  accepted settings back and keeps the change beside the file as `.rejected-<time>`,
  so a restart or a crash never brings it in. A one-shot prompt or a `config` command
  refuses a changed file and says why. A `flow-assist config set` the assistant runs as
  a command writes the file but still waits for your yes.
- **A shell run is marked by how it ran, not by `$`.** The console block, the y/n and
  the tool trail for `run_command`, the pager and `/export` now draw `!` for an
  ordinary run and `‼` for an interactive `!!` one — the same two characters the
  field's own prompt already used at bang level 1/2 — so the screen and what the model
  is told (the recall stub, the `--allow-writes` stderr line) always agree.
- **An MCP server that is not there at start is tried again, not dropped for the run.**
  A server that fails to connect — a gateway that answered 502 just then, an IDE not open
  yet — or drops later (refused, reset, a gateway's 502/503/504, a process that exits;
  a call that times out or gets another 5xx or a 404 stays that call's error while the
  server answers a ping, and a session the server forgot is started anew and the call
  made again) is tried again in
  the background after 5 s, 15 s and 60 s, then
  every 5 minutes. When it answers, its tools join at your next message with no restart,
  and the chat says `[mcp] <name> connected — N tools`. A 401 or 403 is not tried again:
  the reason says it is the token. A server started as a command that exits is started
  again the same way.
- **`/mcp` shows the MCP servers and changes them from the chat.** A list in the
  conversation's place — each server's transport, state (`connected · 23 tools`,
  `failed — HTTP 502 · retrying in 12 s`, `disabled`) and read-only count — with keys to
  disable or enable one at once, restart it or see its tools; `:mcp` says it in a line.
  `/mcp disable|enable <name>` is saved (`--session` for this run only), `/mcp restart`
  tries now, `/mcp add <name> <url | command…>` and `/mcp remove <name>` edit
  `config.local.json`, `/mcp tools <name>` lists a server's tools. Headers and env are
  never taken from the chat — they hold secrets; `config set` sets them.
- **For plugin authors:** a command with `chat: true` is also the chat's `/name`; it may
  say a note (`ctx.say`), open a panel with keys of its own (`ctx.openPanel`) and
  complete every word of its argument (`complete(words)`). `host.services.chatNote` (a
  note drawn with the plugin's name), `setConfig` and `unsetConfig` (the plugin's own
  settings only) are new services.
- **For plugin authors:** a plugin whose tool groups change while the app runs sets
  `tools` on its plugin object and calls `toolsChanged()`, handed to its builder.
- **The session picker can move a session into the current project (`^p`).** Its state
  file and journal move under the current project's mirror directory, its `project`
  field is rewritten, and an empty source directory is cleaned up. Refused for a
  session another process holds, this chat's own open one ("switch away first"), or
  one already in this project.
- **`/cd <dir>` moves the shell's directory yourself, without asking the assistant.**
  It follows `!cd`'s own rule (free to go anywhere with no `shell.roots` configured,
  held to them by the real path otherwise), Tab completes to directories inside the
  roots only, `/cd` alone goes back to the starting directory, and `/cd -` to the one
  before the last move.
- **The shell starts where you started flow-assist, not always in the first root.**
  Started inside a project already under a `shell.roots` entry, commands, the project's
  own `AGENTS.md`, the session and every memory fact now land in that project, not in
  the root's — started outside every root, the first one still takes over, and the chat
  says so once at start-up. `/clear` and `/new` return to that same starting directory,
  and a background task now starts where its parent conversation's shell currently is,
  never at that default.
- **The assistant has a workspace of its own per project.** Drafts, notes, plans and
  findings it was asked to keep go to `artifacts/` in the project's agent workspace
  (`projects/` in the config directory, under a mirror of the project's path), written
  with `workspace_write` and read back with `workspace_read` / `workspace_list`. A write
  there asks no y/n — nothing of yours is touched — and is shown in the chat as a change
  naming its path and kept in the session's journal; nothing outside the workspace can
  be reached through these tools, a link included, and a file read back is the
  assistant's own earlier note, never your instruction. The `repo` plugin's `write_file`,
  refused outside its roots, now names the workspace as the place for a draft.
  `/workspace` lists this project's workspace and `/workspace <path>` shows a file of it
  in the chat — to you only, it is not sent to the assistant.
- **The memory is kept per project, as files, and only its index is sent.** Each fact
  the assistant remembers is a file of its own — `memory/<id>.md` with a name, a
  description and a type — in the agent workspace of the conversation's project, or in
  the global one for what holds everywhere (`scope: "project" | "global"`, project by
  default), with `memory/MEMORY.md` indexing them. The system prompt carries that index,
  a line per fact, framed as the assistant's own earlier notes rather than your
  instructions; it reads a fact in full when its line matters. A fact written in one
  project never reaches another's prompt. `/memory` lists this project's facts and every
  project's, and `/memory forget project|global|all` empties either. The memory an older
  version kept in `memory.json` moves into the global workspace on the first start —
  once; the old file is kept as `memory.json.migrated` — and a note says how many facts
  moved, so ones that belong to a single project can be moved there.
- **The plan is drawn in its own order, with checkboxes and no numbers, and says what
  is being worked on.** Items used to be listed by state with a number beside each —
  numbers the assistant and you read differently, and a new plan could start at 6. Now
  the plan keeps its order, shows flowtty's checkboxes (☐ pending, ⊟ in progress, ☑ done)
  and no numbers; the assistant names items by an id of their own (`t1`, `t2`, …, new
  for each plan) or by their text. When it works with nothing marked in progress, it is
  reminded once in the turn to mark the item it is on.
- **The session list says what each session is doing.** A word on each row: `this chat ·
  working` while an answer or a command runs in this chat, `in use elsewhere` for one
  another flow-assist process has open, and `done` for a session whose last answer came
  while the chat was closed and has not been seen since — opening the chat on it, or
  opening it in the chat, marks it seen.
- **Sessions are kept per project.** A session belongs to the project it started in —
  the git repository holding the shell's directory at its first message, when it lies
  inside the `shell.roots` entry holding that directory (a root that is a whole
  workspace keeps each repository a project of its own); that root when no repository
  lies between it and the directory; outside every root the nearest repository — and its
  files live under a mirror of that path, `sessions/Users/me/app/<id>.json` with its
  journal beside it. A start continues the current project's newest session, and in a
  project with none yet starts a new one and says where the others are; `/sessions`
  opens on the current project's sessions and Tab shows every session, grouped under
  each project's path; `/resume` numbers the current project's only. `sessions.keep`
  (50) counts per project. Sessions saved by an older version load where they are, as
  sessions with no project, and are never moved.
- **A plugin that asks the model something no longer lets it write.** A plugin's
  `chatLLM` — and a remote plugin's `host.chatLLM` — ran every write the model called
  without asking you. Now each write there is declined unless the plugin asks you
  itself (a JS plugin passes its own `confirmWrite`; a remote plugin cannot, so its
  writes are always declined).
- **A one-shot prompt no longer runs writes without asking.** `flow-assist "<prompt>"`
  has nobody to answer a y/n, yet it ran every write the model called — a command, a
  file edit, a tracker change — so one instruction planted in a page or a ticket it read
  was a command run on your machine. It now declines each write and the model is told
  you can do it in the chat; reads run as before. `flow-assist --allow-writes "<prompt>"`
  lets writes run, each said on stderr as it runs; `config_set` and a `web_fetch`
  outside `web.allowlist` are still declined.
- **`tools_load`'s `group` accepts a tool's own name.** A `group` that names no group
  is read the way `names` already reads one: a tool's own name, qualified
  (`<group>:<name>`) or bare, loads that tool instead of erroring, and the answer says
  it loaded the tool.
- **A recovered tool trail is yellow, not red.** The trail's header and a folded run's
  `✗` mark now take red only when a failed call was never followed by a later,
  successful call of the same tool; a failure the model went on to retry
  successfully draws yellow instead. A write shows as `✎` in whichever of these
  colours applies — it no longer turns the trail yellow on its own.
- **`ctx N%` climbs with a long turn instead of jumping once at the end.** Each round
  of a turn already reported its usage; now the reading is drawn from it right away,
  so you see the context fill up round by round rather than only when the answer
  arrives. A provider that reports no usage still shows the estimate.
- **A message you send while the assistant works reaches it after the current step.**
  It used to wait for the whole turn to end, so a correction arrived after the work it
  meant to steer. Now it goes in between two rounds of tool calls, as your message, and
  the assistant carries on with it in view; the line over the field says `reaches the
  model after this step`, ↑ still takes it back until then, and ⇥ on the empty field
  holds it for the end of the turn instead.
- **Long work is no longer cut off at 64 rounds, and carrying on is one key.** A turn
  may take 150 rounds (`ai.maxRounds`; 0 is no cap) and spend 2,000,000 tokens across its
  requests (`ai.maxTurnTokens`, counting each prompt without the part read from the
  provider's cache, plus the answer; 0 is no budget) — whichever comes first ends it.
  The chat then says where it stopped — `stopped after 150 rounds (ai.maxRounds) —
  ⏎ continue · last: <the last call>` — and Enter on the empty field sends "continue", so
  you no longer type it.
- **A tool call the model writes as text is asked for again instead of ending the
  turn.** Some models now and then write their call as text in the answer — DSML,
  `<tool_call>`, `<function_calls>` — so nothing runs and the turn stops on raw markup.
  The chat now tells the model once that its call was written as text (naming the tools
  it has when it named one that does not exist) and gives it another round; the screen
  shows a dim `tool call written as text — asked again` in place of the markup, and the
  markup is never kept in the conversation. A second such answer in a row ends the turn.
- **The chat compacts the conversation by itself before it overflows.** Before a request
  that would pass 80% of the context window, the chat folds the conversation into a
  handoff first — the same as `/compact`, with its row marked `── compacted · auto ──` —
  and then sends. It happens between two requests, never between a tool call and its
  result, so a long turn can compact in its middle and carry on from where it was.
  `ai.autoCompact.threshold` moves the point (0.5 to 0.95 of `ai.contextWindow`), and
  `config set ai.autoCompact.enabled false` leaves compaction to `/compact` alone.
- **`/compact` writes a handoff for the model that goes on, not a reply to you.** The
  summary comes in fixed sections — the goal, what is done (with commits, paths and the
  commands that worked), what is in progress and its exact next step, the open
  decisions, the facts learned — with no question to you and no pleasantries, so the
  assistant keeps its place after a compaction. It is made from the whole conversation
  rather than its last thirty messages, and it replaces the previous summary instead of
  piling up after it: the model is shown the old one and carries forward what still
  holds. A summary that comes back without the sections, or far too short for what it
  replaces, is asked for once more; if that fails too the old summary is kept with the
  new text and the `── compacted ──` row says `incomplete, previous kept`. Tool-call text
  a model wrote by mistake (`<tool_call>`, DSML and the like) never reaches the summary.
- **A command block keeps the whole command.** The command a person or the model ran
  is kept whole, up to 16 KiB rather than the old 300 characters, its own line breaks
  included: a folded row still cuts it (reserving room for the duration and the
  outcome first), but the opened block never does, wrapping each of its lines across
  its own rows instead — up to 40 of them, past which a dim note stands in for the
  rest, so a long command can never push the output or the outcome out of the block.
- **Interactive mode (`!!`) draws as one glyph, and a command's marker says how it
  ran.** `‼` (U+203C) replaces the two-character `!!` in the prompt and on a running
  interactive command's own gutter marker. Every command's marker is dim while it
  runs, then turns green on exit 0 or the error colour otherwise.
- **Every session keeps a journal of everything that happened in it.** Beside the
  saved session, `sessions/<id>.log.jsonl` records each row you saw; each tool call
  when it starts, the y/n you answered, and when it ends, with its whole arguments and
  result (not the cut the model was given — and for a tool that frames its answer, such
  as an MCP server's, the data behind the frame); the calls of the background tasks
  it started, under each task's name; each `/compact` with its summary — line by line
  as it happens, so a crash loses nothing, and never trimmed: a long session's
  beginning is no longer lost. A command — yours or the assistant's — is recorded
  when it starts, with its whole output as it arrives (up to 8 MiB per command, more
  than the screen and the assistant keep), and its exit when it ends. A journal lives exactly as long as its session;
  `sessions.journalDays` (0 by default) removes one not written to for that many
  days, and the session says so in a note. `/export [path]` turns it into a markdown
  document to read — each tool call folded with its arguments and result, the
  summaries in place — in the shell's directory unless you name a path, never over a
  file that is there. The saved session itself counts its limit of 400 in messages of
  the conversation: the blocks of the commands the assistant ran have a smaller limit
  of their own (100), so a session that runs many commands no longer loses what was
  said twice as fast. The model's side of it is cut where a turn begins, never between
  a tool call and its result — a cut there left a session the Anthropic API refused on
  the next message after a restart.
- **Commands can run without asking, when you say so twice.** `config set shell.autoRun
  true` together with `/auto all` (or ⇧⇥ to `all`) lets the assistant's `run_command` run
  without the y/n; the hint line then says `auto: writes + commands`. Either alone
  changes nothing, `web_fetch` and `config_set` still ask, a plugin's tool of the same
  name still asks, and the assistant can never set the key itself. It is read as each
  command is asked about, so `:config set --session shell.autoRun true` (or `unset`)
  holds at once. What ran is still shown.
- **A setting can be changed for one run, and the assistant may change a few itself.**
  `:config set --session <key> <value>` changes a setting for the running app only:
  nothing is written, and the next start has the saved value again. `config set` still
  saves, and now either kind is used at once where the app reads the setting as it
  goes (the status line's words, the panel's side); a key read only at start — the
  mouse, the model's endpoint (`ai.provider`, `ai.baseUrl`, `ai.tokenEnv`, which change
  together), `ai.disabledTools` — waits for the next start and says it `takes effect on
  restart`. `config unset` takes a value back the same way, and `:config unset --session`
  drops only the one for this run. `config get` says where a value comes from — `session`,
  `local`, `config` or `default` (the CLI on stderr, so `| jq` still reads the bare
  value). The assistant gets `config_set`, but only for keys marked as its to change —
  the status line's words, the mouse, whether the chat continues the last conversation,
  where the chat opens and which side its panel docks on, the keycaps panel — never
  its model, token, tools, the shell's or the web's reach or a plugin's roots. You
  confirm each change as the `config set` line you would have typed, `/auto` never
  answers it, and asked about any other key it gives you the command instead. A plugin
  marks its own keys with `modelMaySet` / `modelMaySave` (and `appliesOnRestart` for one
  it reads at start), handed to its builder beside `z`; it is an addition, so the host
  API is still 2.
- **The assistant no longer promises to act on background results by itself.** The
  `background` tool told the model a result is "analyzed when idle", so it promised
  things like "when they report, I will save each into a file" — but by default a
  result only lands in the chat and reaches the model with the person's next message;
  nothing happened until the person wrote again. The tool now describes what happens:
  the result appears in the chat, the model sees it on its next turn, a turn per
  result needs `ai.backgroundFollowUp: true`, and the next answer opens with what came
  back. `config_schema` lists `ai.backgroundFollowUp` and says the same from the config
  side.
- **A list of tool names sent as a string loads those tools.** The answer to a call of
  a tool that was not loaded showed the fix as prose — `call tools_load with names
  ["write_file"] first` — and a model copied the list into the call as a string. The
  host read that string as one name, brackets included, answered `Not in the list:
  ["write_file"]`, which reads as "write_file does not exist", and the model gave up on a
  tool it had. Now a `names` string that parses as JSON is read as that list or name
  first, and the hints show the call itself as JSON: `call tools_load with {"names":
  ["write_file"]} first`, and a big group's refusal says `load the ones you need with
  {"names": [...]}`. A name that still looks like a list is explained, with the call to
  make instead.
- **A plugin can measure text as the screen draws it.** `ui.stringWidth(text)` is
  flowtty's own width function, the one the host sizes its columns with: a CJK character,
  an emoji, a flag or a joined emoji takes two cells. A plugin that sized a column from a
  name or a tag by its `.length` drew it a cell short for each such character; measured
  with this, it fits. It is an addition, so the host API is still 2: a plugin that must
  also run on an earlier host checks that `ui.stringWidth` is there.
- **Emoji and wide characters are measured as the screen draws them.** The chat's
  one-row lines — a folded run of steps, a tool call's line, the tools summary, the
  title naming what is on screen, a change's file name, the directory in the `!` hint
  row — and the usage column of the text-only help measured a flag, a skin-tone emoji or
  a family emoji as several characters, so a line that fitted was cut early, a cut could
  leave half of one behind, and the help's columns came out uneven. A tool's block (a
  plugin's view) and the start screen's plugin descriptions counted an emoji or a CJK
  character as one, so a line ran past its block and a description wrapped too soon.
  Each such character now takes the two cells it is drawn in.
- **`null` on an optional key reads as left out at every level, not only the top.** A
  client that sends `null` for a field it left blank was already fine on a top-level
  parameter; the same `null` inside an object parameter, or on a key matched by
  `patternProperties`, was refused as a wrong type. Now any optional key sent as `null`
  is read as omitted wherever it sits in `properties`, `patternProperties` or array
  items (not behind `$ref`, `anyOf`/`oneOf`/`allOf` or an `additionalProperties`
  schema). A required key sent as `null` is still refused, at every level, and so is a
  `null` array item the item schema does not allow. The tool itself still receives the
  `null` as sent.
- **A long answer stops at its first line, not its last.** The conversation followed an
  answer to its end, so a long one scrolled past its own beginning and was read by going
  back up to find where it started. Now it follows only while the answer fits: once the
  answer's first line would leave the top, the conversation stops with that line right
  under the pinned question and the rest grows below — PgDn or the wheel reads on, and at
  the end the conversation follows again. A short answer, a person who had scrolled up,
  and a message sent next are as before; a background result landing under an answer
  being read does not move it.
- **Sessions have a picker, titles, and a way to start a new one on purpose.** `/sessions`
  (or Ctrl+S, from any screen; `config set keys.sessions <key>` moves it) lists every saved
  session newest first — its title, when it was last used, its size, and whether another
  flow-assist process has it open — and typing filters by the title and by the words of
  the conversation itself. From the list, ⏎ opens a session (the one you are in is saved
  first), Ctrl+N starts a new one, Ctrl+R renames and Ctrl+X deletes after a y/n; a
  session open in another process is neither opened, renamed nor deleted. A session is
  named by the first line you wrote, and `/title <text>` renames it; the name is kept in
  the session's file. `/new` starts a fresh session and leaves the current one as it was,
  so a restart before you say anything continues it — where `/clear` also marks it done.
- **A block taller than the chat's window opens in a pager, not into the
  conversation.** A click on a command's output, a turn's tool calls, its steps,
  its thinking or a /compact summary that would not fit the conversation's rows opens that block alone in
  the conversation's place inside the chat's frame — docked, as a window or full — everything the block kept, every call of a long trail —
  with its own scroll (PgUp/PgDn, the wheel); a drag copies from it, nothing typed
  there reaches the field or the model, and Esc brings the conversation back exactly
  where it was, the block still folded. A block that fits opens inline as before, and
  `^o` still opens everything inline. A folded command that printed more than a click
  shows now says how much it holds (`· 40 lines`, or `· last 200 of 300 lines` when
  only the tail was kept). A y/n or a question arriving closes the pager.
- **The assistant can hand a tool's result to a command instead of re-typing it.**
  Asked how many non-breaking spaces a text holds, the model had the text in a tool's
  result and no way to give it to a command but to write it out again as an argument —
  which turns every non-breaking space into a plain one. `run_command` now takes
  `stdinFrom`, the id of an earlier tool call (or the id a recall stub names): the
  command reads that call's data on its stdin exactly as the tool returned it —
  before the host's own tag, before the cut a long result gets, and for an MCP server's
  tool without the frame and the clip the `mcp` plugin puts around it for the model —
  and the confirmation shows where it comes from, `stdin: result of search (call_3)`.
  An id that names no call, a call that failed, or a result that is not text is an
  error before the confirmation, and nothing runs. A cut or framed result keeps its
  data beside what the model is sent (up to a million characters), so this still works after a
  restart. **For plugin authors:** a tool may return `{ text, raw }` — `text` what the
  model reads, `raw` the bare data a later command may read as its stdin, `null` for
  none.
- **Loading a big tool group whole no longer sits in every later request unread.**
  Loading a 26-tool group and a 17-tool group for five tools actually used once cost
  the conversation ~60k tokens of unused schemas on every round after, up from ~6k. A
  group of more than 12 tools now shows its cost in the tool index (about how many
  tokens loading it whole would add to every later request) and `tools_load` no
  longer loads such a group whole by name alone — it answers with that group's own
  index instead, so the model asks for the tools it actually needs. Naming tools
  individually still always works, at any group size.
- **A tool call with the wrong arguments is told what is wrong, not run with a key
  quietly `undefined`.** Before a tool runs, the host checks the call against the
  tool's own declared schema: a required parameter it left out, a value of the wrong
  type, a key it misspelled. A mismatch never reaches the tool — the model reads one
  line back naming it (unknown `code` — did you mean `issueCode`? when a required
  parameter is missing and an unrecognized one sits right beside it) instead of the
  tool failing on the wire for a reason it cannot see. A call that already
  matches goes through exactly as sent. **For plugin authors:** your tool's declared
  `parameters` is now enforced — a tool that read a key it never listed in
  `properties` must add it, and a schema silent on `additionalProperties` now treats
  any key not listed as unknown; opt out with `additionalProperties: true`.
- **The assistant enters a project and reads its rules.** Wherever the shell's
  directory is set — at the start, after `!cd`, or by the assistant's new `cd` tool
  ("go to the project": relative or absolute, only inside `shell.roots`, no y/n since
  it runs nothing) — every `AGENTS.md` from that directory up to its `shell.roots`
  entry reaches the assistant as a "Project instructions" section of its system
  prompt, outermost first and the nearest last, each file under its path and cut at
  32 KiB, quoted as the repository's words, which never override yours. It is read
  again whenever the directory moves, the assistant sees it from its very next
  request, a move inside the same project leaves it unchanged, and a line in the chat
  says which files were picked up. A background task and a one-shot prompt read it
  for their own directory too. Nothing outside `shell.roots` is read; with no roots
  set, nothing is, and `cd` is refused. Under a root that is itself a link, `cd ..`
  and run_command's `cwd` now work from a directory a command left by its real path.
- **A plugin can be a separate process, in any language.** The host talks to it over
  JSON-RPC 2.0, one message per line, on its stdin and stdout — or through a shared
  socket several hosts connect to at once (`connect: "unix:<name>"`, started with
  `run … --serve <path>` the first time something needs it): the host draws, the
  plugin describes its whole screen and sends it again whenever it changes
  (docs/plugins.md, "A plugin in another language"). Either way the process runs
  under a restarting supervisor: a crash brings it back after a backoff that
  lengthens each time another restart fails quickly, and gives up for good after
  enough failures in a row. `flow-assist plugins ls` marks the plugin `(remote)`.
  `@flow-assist/remote` speaks the protocol for a plugin written in TypeScript
  (`runPlugin`), including its `--serve` branch, and `examples/remote-login` is a
  sign-in form built on it. **For plugin authors:** nothing changes for a plugin in
  the host's own process; the host API number is unchanged.
- **flowtty 1.0.0-alpha.31.** A wide glyph — an emoji in the chat, a CJK character —
  used to draw as two blank cells until the row was selected: the grid counted one
  cell per code point and backed the cursor up one column after painting it, so the
  next cell landed on its right half. It now gets the two cells it takes: paint
  reserves the second one and nothing overlaps it. `stringWidth` measures grapheme
  clusters — a flag, a skin-tone emoji, a ZWJ sequence are 2, not the sum of their
  parts — and on macOS Terminal.app, which draws each code point of a cluster on its
  own, the backend measures per code point instead; there is nothing to configure.
  Five of the host's own columns counted UTF-16 units where the padded text can carry
  non-ASCII — a plugin's name and its entry key on the start screen, the start
  screen's own door keys, and a key cap and a command's usage in `:help` — and now
  measure `stringWidth` instead, so a wide name or a remapped key still lines up its
  column; the reminder banner's width, sized the same code-point way, is fixed too,
  so a reminder full of wide glyphs sizes to what it needs instead of wrapping early.
  **For plugin authors:** declare `"flowtty": ">=1.0.0-alpha.31 <1.0.0-alpha.32"` — a
  manifest still declaring the alpha.28 range is refused as incompatible. The host
  API number is unchanged.
- **An MCP server's own guidance now reaches the assistant.** `initialize`'s
  `instructions` — how a server's data is shaped, its vocabulary, what to check before
  trusting it — becomes its tool group's own description: one line under the group's
  heading in the `tools_load` index, and the full text once the group's tools are
  loaded or sent in full, trusted the way a tool's own description is. **For plugin
  authors:** a tool group may set `description` for guidance beyond its tools' own
  (docs/plugins.md, "Tools for the model").
- **A tool can show the assistant images it fetched itself.** The screenshots attached
  to an issue, a design, a chart: a tool that has them returns them beside its text,
  and the assistant sees them — inside the tool result on Anthropic's API, in a
  message right after the tool's results on an OpenAI-compatible one — under the same
  limits as your own attachments (`ai.images.maxBytes` per image, `ai.images.maxPerMessage`
  per result, refused with a note and never shrunk; with `ai.images.enabled false` the
  text goes and a note says the images did not). The chat shows one row per image
  under the call, `▣ shot.png · 400×300`, never the image; the images stay in the
  conversation as attachments do — in full until a batch stubs them, then as a stub
  `recall` reads again — and the session keeps a ref into the host's own image store
  (`images/` in the config directory, the oldest pruned past 200), never the bytes.
  Your rule stands: nothing the assistant reads can make the host open a file or a URL
  as an image. On Anthropic's API a recalled image now goes inside its tool result as
  well. **For plugin authors:** return `{ text, images: [{ bytes | base64, name }] }`
  and mark the tool `returnsImages: true` (docs/plugins.md, "A tool can return
  images"); an undeclared tool's images are dropped with a note. The host API number
  is unchanged.
- **Bulky content is sent once, then as a stub the assistant can recall.** An attached
  image, the output of a `!command` and a tool result over 4 KB stay in the model's
  history for good and used to ride every later request in full — a screenshot re-sent
  with every message. Each now goes in full in the turn it arrives in and, from a later
  batch on, as one line naming an id — `[$ brew update — exit 0 · 24.7 s · 120 lines —
  recall("out:7d41e0aa")]` — that the new `recall` core tool reads again for one turn,
  an image as an image. Ids are hashes of the content, so identical content shares one
  and they survive `/compact`, `/resume` and a restart; the screen and the session
  keep everything in full. Stubbing happens in batches (every eligible item at once
  when the context passes `ai.recall.threshold`, half the window, or every
  `ai.recall.everyTurns` turns, 10), since replacing old content costs one prompt-cache
  miss. `/context` says how many items are stubbed and how many were recalled this
  turn. `ai.recall.enabled: false` sends everything in full, as before; `ai.recall.
  minChars` is the size that makes a tool result bulky. **For plugin authors:** a
  tool's `ctx` gains `attachImage({ ref, url })` — an image to send beside the result in
  the rounds that follow — and a large result of yours may reach the model as a stub
  on later turns; what the tool returned is unchanged.
- **The chat's field completes more than a command's name, and shell mode says where
  it runs.** In `!` and `!!` mode the hint row under the field starts with the shell's
  directory (`~`-shortened, cut from the left when long), so `!cd` is seen to take
  effect before the next command. Tab there completes the word being typed as a path
  under that directory, as a shell does — a unique match filled in, a directory with
  its `/` (Tab again walks into it), several walked in turn with the others named
  beside the field; hidden entries only for a word that starts with `.`, nothing
  outside `shell.roots` by real path (a link that leads out is not offered). A chat
  command's argument completes from the values it takes — `/notes step|open`, `/mode
  panel|window|full`, `/auto reads|all|off`, and `/resume` the saved sessions by
  number with each title said beside it. All of it is drawn as the `/command` name
  already was: the untyped rest after the caret, `⇥ a · b` for the rest. **For plugin
  authors:** a `:` command may declare `values` — a list, or a function returning one,
  each value a word or `{ value, label }` — and the `:` line completes its first
  argument from them (docs/plugins.md, "Commands, keys and the footer"). Optional; the
  host API number is unchanged.
- **A plugin is given `{ ui, host }` instead of `ft` — host API 2.** **For plugin
  authors — every plugin must change:** each hook of the shape (`components[slot]`,
  `setup`, `keycaps`, `chatContext`, `chatSubject`, `afterWrite`) receives
  `{ ui, host }`. `ui` holds what React and flowtty ship, unchanged: `h`, `useState`,
  `useEffect`, `useRef`, `useInput`, `Box`, `Text`, `Markdown`, `Table`, `Link`,
  `ScrollBox`, `Select`, `ListSelect`, `ListMultiSelect`, `Checkbox`, `TextInput`, and
  `isPrintable` — whether a key types a character. `host` holds what
  the host implements: `services` (`host.services.showMessage(…)`, `pushLog`,
  `chatLLM`, …), `store`, `config`, `keys`, `keyCap`, `useInputHandler`,
  `useSurfaceSize`, `useTerminalSize`, `notify`, `viewRegistry`, `commandRegistry`,
  `helpFor`, `copyToClipboard`, `pluginToken`, `hostApi`. There is no `ft`: `ft.h` is
  `ui.h`, `ft.services` is `host.services`, and so on by that table. A plugin
  declares `"hostApi": 2` and a `flowtty` range in its manifest; one that declares
  neither reads as host API 1 and is not loaded. A plugin that is a single file has no
  manifest, and so is not loaded either — make it a directory with a `manifest.json`.
- **Plugins say what they are built for.** **For plugin authors:** `manifest.json`
  takes `hostApi` — the host API numbers the plugin works with, a number or a list —
  and `flowtty`, a semver range of the flowtty its screens need. A plugin this host
  cannot run is not loaded, and said so: `plugins ls` shows `incompatible: built for
  host API 1, host provides 2` or `incompatible: needs flowtty …, host has …`, the log
  has a line, and `plugins install` refuses it. No `hostApi` reads as 1; no `flowtty`
  is loaded with a note. `host.hostApi` is the number the host provides. It goes up
  on any change to what the host gives plugins that a plugin would break on, and this
  page says what to change each time.
- **flowtty 1.0.0-alpha.28.** **For plugin authors:** `ui` offers flowtty's
  pickers — `ui.Select`, a dropdown (the host keeps the `<DialogHost>` its popup
  needs), and `ui.ListSelect` / `ui.ListMultiSelect`, the inline lists. flowtty
  renamed those lists in alpha.24 with no aliases: its old `Select` is `ListSelect`
  and its old `MultiSelect` is `ListMultiSelect`, props unchanged, and `Select` is
  now the dropdown — a plugin that took the old names from flowtty must rename them.
  They hear flowtty's own input, so a plugin gates them with `isFocused` from
  `host.hasKeyboard()` — false while the host has the keyboard (docs/plugins.md).
  While a dropdown is open every key is its own: Ctrl+] waits for it to close, and
  Ctrl+C still takes two presses. flowtty's components take the keys they act on — a focused `ListSelect` takes what
  is typed as its filter, so `F` or `:` do not reach the host while it has the focus.
  The host's own chords (Ctrl+], the collapse key, the exit keys) are heard before any
  component, and the host's other keys after them, whenever the plugin's screen was
  opened — so no picker in a plugin's screen can keep the person from the chat, and a
  focused one is never beaten to its keys by the host. Ctrl+] and the other control
  chords arrive as chords (`{ name: ']', ctrl: true }`), so a plugin that matched the
  raw byte matches the chord instead. Declare flowtty as the one alpha you built
  against — `"flowtty": ">=1.0.0-alpha.28 <1.0.0-alpha.29"`.
- **A stray `console.log` no longer lands on the screen.** What a plugin, a library or
  React prints through the console while the app runs goes to the log (`L`) at once,
  as `[console] …`, `[console.warn] …` or `[console.error] …`; the last 200 such
  lines are printed to stderr when the app exits. The log keeps its last 2000 lines.
- **The chat is a panel beside the plugin's screen.** It used to be a window over the
  screen, so the board the assistant was told about was hidden from the person talking
  about it. Now it is docked to the right by default (at the bottom on a terminal under
  120 columns; as a window on one too short for a panel and the plugin's screen both)
  and the plugin's screen is laid out in the rest. A question or a y/n is always shown
  whole — a bottom panel grows to it, or the chat is a window until it is answered. In
  a small panel the field is never squeezed: the assistant's plan folds to one row
  (`plan 2/3 · <item>`) and unfolds when there is room. Ctrl+] moves the
  keyboard between the two, the side that has it is marked, and the chat goes on
  answering while the plugin has the keys. Ctrl+\ folds the panel away and back — a
  running turn's status then sits on the plugin's bottom row, or on the one row a
  bottom panel keeps — and so does Esc Esc, which hands the keyboard to the plugin.
  Folding the chat away (or closing a window with Ctrl+]) never answers a y/n or a
  question for you: it waits, the folded chat says `? waiting for you`, and it is
  back when the chat is. Both keys are the host's before any plugin's, take only a
  chord (a key that types is refused and the default kept) and leave an open `:` line
  alone. `/mode window` brings the window back
  and `/mode full` gives the chat the whole terminal; `plugins.assistant.mode`,
  `panel.side` and `panel.size` set it from the start.
  **`/fullscreen` is gone** — it is `/mode full`; a config that says
  `plugins.assistant.fullscreen: true` is read as `mode: full`.
  **For plugin authors:** a surface may be given less than the terminal.
  `host.useSurfaceSize()` and `host.useTerminalSize()` report the plugin's side of the
  screen, and a modal laid out by them stays on it; a plugin that sizes itself by
  flowtty's own `useTerminalSize` still sees the whole terminal.
- **Cache usage is no longer invisible.** `/context` now has a `last request: …
  prompt · … from cache · … written to cache` line — the last request's cache
  breakdown, from either wire (Anthropic's `cache_read_input_tokens` /
  `cache_creation_input_tokens`, an OpenAI-compatible server's
  `usage.prompt_tokens_details.cached_tokens`) — with a part left out when the
  provider did not report it, and a plain note when it reported none at all. The
  session keeps it too: its `usage` and each turn's own message carry the cache
  figures, so a saved chat still shows where its tokens went, not only how many.

- **`!!` error messages no longer show the temp command file's path.** `!!asd` used to
  print `/var/folders/…/fa-tty-x/cmd: line 1: asd: command not found` — the shell's
  `$0` was the temp file it ran the command from. It now reads `!!: asd: command not
  found`.

- **A tool result over `ai.toolResultMaxChars` (default 40000) is cut before it joins
  the assistant's history.** A tool can return arbitrarily much, and it stayed in the
  conversation forever, costing tokens on every later request. A longer result now
  keeps its head and a short tail, with a note in between saying how much was cut and
  asking the tool for less — a filter, a limit, one item. Only what is sent is
  capped: a command's own block and the tool trail still show what really happened. A
  tool may declare its own higher cap for a result that is large and worth the
  tokens, up to a hard ceiling.
- **`tools_load` accepts a tool name qualified with its group** (`plugin:tool`), not
  only the bare name the index shows — the index reads naturally either way, and a
  model that qualified it used to lose a whole round to `ERROR: Not in the list`.

- **`!!command` runs a program that needs the terminal, and asks the assistant about
  it.** `!command` captures what a command prints, so a prompt, `git add -p`, `top` or
  a login flow could not run there. `!!command` gives the program the whole terminal
  and takes it back when the program ends. It has its own level of the chat field's
  bang prompt: `!` on an empty field enters shell mode (`! `), `!` again on the
  still-empty field steps to interactive mode (`!!`) — the same way Backspace steps
  back down, one bang at a time — so Enter always runs the field exactly as it reads,
  with no more guessing a leading `!` in the text meant `!!`. What the program printed
  is recorded with `script` — colours taken out, a progress bar in its last state —
  and shown like any command's output, marked `interactive`; then, whenever something
  was recorded, the assistant is asked at once to look at it. A full-screen program
  (`vim`, `less`, `top`) leaves nothing to look at, and without `script` nothing is
  recorded: then nothing is asked. Whatever
  the program echoes — a value typed at a prompt that shows it back — is recorded,
  sent to the assistant and saved with the session.

- **A message sent from the queue no longer undoes what just ended.** Under load, a
  message queued during a `!command` could put the finished command back into its
  running state (its seconds ticking forever), and one queued during an answer could
  cut that answer's last words.

- **The assistant knows what is on your screen.** A plugin can now describe what its
  screens show — a board with its filter and cursor and the issue open beside it —
  through a new hook, `chatContext`, as a list of items with a label and a text. Before
  every request the assistant is given them in a block of its own, `What the person
  sees now`, marked as data from outside systems and never as instructions; it follows
  the screen from one request to the next and is never stored in the conversation or
  the saved session. `/context` counts it as `on screen`. The chat's title shows the
  items' labels (`ƒ Flow Assist · Board: Frontend · Issue ABC-1`).

- **Opening the chat on another screen no longer starts a new conversation.** It used
  to switch to a fresh session whenever the plugin's subject changed, and the dialogue
  seemed lost. Now the conversation continues and only what the assistant sees of the
  screen changes; `/clear` starts a fresh one. `chatSubject` still works for this
  release, read as one item with no text, and is deprecated — move to `chatContext`.

- **Ctrl+C stops the answer, and quitting takes a second press.** Ctrl+C used to end
  the app at once, even in the middle of an answer, and Ctrl+Z to suspend it with a
  request in flight. Now Ctrl+C while an answer or a `!command` runs stops it, as Esc
  does. When nothing runs, the first Ctrl+C says `^c again to exit` and a second within
  two seconds quits; any other key takes it back. Ctrl+D on an empty field does the
  same, and Ctrl+Z says `^z again to suspend`. This holds on every screen, not only in
  the chat.

- **Esc stops the answer on the first press, even with a message waiting.** With a
  message queued and a tool running, the first Esc used to take the message back, the
  second cleared it (the message was lost), and only the third stopped the tool. Now
  Esc stops it at once. A stopped or failed answer no longer sends the waiting
  messages: they come back into the field in order, ahead of anything you had typed
  meanwhile, and you decide what to send. ↑ on an empty field takes the last waiting
  message back to edit (the hint says `↑ takes it back`).

- **`/compact` leaves one row, not the whole summary.** The note it left in the chat
  was the summary itself, often dozens of lines. It is now one separator row,
  `── compacted · ~58k → ~2.1k tokens ──` — how big the model's view was and is now —
  with the summary folded under it: a click or `^o` opens it. A conversation saved
  before shows its old note as it was.

- **`/compact` leaves the field at once.** It stayed in the field until the summary
  came back, as if it had not been sent. Now the field empties the moment you press ⏎
  (↑ brings the command back), a draft typed meanwhile is left alone, and a message
  queued behind it goes out after it — or comes back into the field when you stop it.

- **↑ repeats `/commands` too.** `/notes step`, `/compact`, `/resume 2` go into the
  ↑/↓ history like every other line you submit, as `!commands` and lines typed in
  shell mode already did (they come back in shell mode), and the history is saved with
  the session. A command
  whose argument may be a secret stays out of it: the `:config` command, and a
  plugin's command that declares `history: false`.

- **Anthropic's own Messages API: `ai.provider anthropic`.** Claude models were
  reachable only through Anthropic's OpenAI-compatible endpoint, which drops what the
  native API gives. With `config set ai.provider anthropic` and a Claude model id
  (`claude-sonnet-5`, `claude-opus-5-5`) the chat, `/compact`, a background task and
  the one-shot prompt talk to `/v1/messages`: the token comes from `ANTHROPIC_API_KEY`
  and the base URL defaults to `https://api.anthropic.com/v1`. The tools, the
  system prompt and the turn so far are cached between requests (and `ctx N%` counts
  the cached part);
  tool calls and results go natively; the model's thinking shows in the chat's
  thinking fold, and its blocks are sent back unchanged while a tool loop runs.
  New keys: `ai.maxTokens` (the cap on one answer, 8192) and `ai.thinking`
  (`{"adaptive":true}`, or `{"budgetTokens":N}` for older models). A saved
  conversation reads the same under either provider. Without `ai.provider` nothing
  changes.

- **The roots have a key per owner: `shell.roots` and `plugins.repo.roots`.** The
  directories `!command` and `run_command` start in and stay inside, and the ones
  `repo` may touch, were one host key, `fs.roots`, although only `repo` and the shell
  read it. The shell now reads `shell.roots`; `repo` reads `plugins.repo.roots`
  (`config set` checks it against repo's own settings) and, when that is not set,
  `shell.roots`. `fs.roots` keeps working for this release as the fallback of both,
  and the log (`L`) says once where to move it: `config set shell.roots '[…]'`.

- **The bundled plugins carry the host's own version.** `gitlab`, `mcp` and `repo`
  said `1.0.0` while the host was `0.1.0` — they ship from this repo, with this
  release, so a `repo-1.0.0.tar.gz` beside a `0.1.0` host read like a mismatch. A
  test now keeps every bundled plugin equal to `hostVersion()`, naming the one that
  drifts. Installing an archive over an already-installed one now says what it
  replaced when the version changed (`plugin 'notes' v0.2.0 replaced (was
  v0.1.0)`).

- **The status line says a word of its own while the model works** — `Pondering…`,
  `Brewing…`, `Tinkering…` — one picked for each request and drawn with the same
  shimmer as a running tool; magenta while it thinks, green while its text arrives.
  `writing…` is gone: it read as a promise of text that was not there yet.
  `config set ui.verbs '["Thinking"]'` puts your own words in.

- **A provider's refusal reads as a sentence.** A failed request used to show the
  provider's raw JSON — `LLM 403: { "message":"model_access_denied", "request_id":… }`.
  It now says `LLM 403 · <model>: model_access_denied (request 2395f0a1)`, and for a
  refused token or model adds what to check. `/compact` failing says why too, where it
  used to say only the status.

- **A turn reads in the order it happened, and nothing it wrote jumps away.** A turn
  used to be laid out by kind — what the assistant said, then every diff, then the
  answer — so text that turned out to come before a tool call moved up above all the
  diffs of the turn. With a tall diff it left the screen, and the chat looked as if
  text had been lost or a file written twice. Now what it said, each diff and the
  answer stand in the order they came, and a round's text stays where it was drawn:
  dim, with a spinner beside it, until it is known to be the answer, which then gets
  its `ƒ`. What it said between tool calls folds to one quiet line per stretch —
  a diff, a command or calls it made without a word end a stretch — showing the
  latest thing it said and how many steps there were (`▸ Now the tests.  (3 steps)`,
  no count for one); a click opens that stretch where it stands, with the calls each
  step made, `^o` opens them all. The tool calls are where they were made too — the
  one trail under the answer is gone; under the answer stay only the seconds and the
  cost. `/notes open` shows every step in the normal colour. The `Next:` the assistant
  writes before a tool call is never shown — the sentence after it is — while an answer
  is shown exactly as written. `/notes fold` and `/notes hidden` are gone — a config
  that still says either reads as the default — and so is the separate step line above
  the answer. Sessions keep the new order; older ones still open, their trail as one
  line before the answer. A round whose text and tool call
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

- **flowtty 1.0.0-alpha.23.** A double click selects a word and a triple click a line,
  copied like any selection; Ctrl+Z suspends the process (`fg` resumes it, the screen
  and the conversation intact).

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
