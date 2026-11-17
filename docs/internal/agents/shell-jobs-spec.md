# Shell, jobs, bang commands — spec

> Extracted VERBATIM from AGENTS.md as of master before the
> `chore/agents-md-slim` rewrite. This file is the behavior spec for the area
> it covers: where the trimmed AGENTS.md core and this file ever disagree, the
> core rules win — but treat any difference as a defect in one of the two and
> report it. Covers: `run_command`, background shell jobs, `cd` and project
>
> Cross-file references inside the moved text ("(models)", "(below)") follow
> the OLD single-file layout; use DISPOSITION.md to find where a section
> lives now.
> instructions, and the `!command` / `!!command` lifecycles.

- **`run_command` runs a shell command — only after the person says yes**
  (`src/loader/tools-shell.ts` on the runner in `src/assistant/shell.ts`). A group of
  its own, `shell`, off with `ai.disabledTools: ["shell"]`. It is `write: true`, so
  EVERY call pauses for the y/n, and the y/n block shows the command line itself
  (`! …`, wrapped, not its JSON); a background task declines it. What the model knows
  of the machine is in the tool's description, built at load: platform (with the BSD
  userland note on macOS), the starting directory, which of the usual programs are on
  PATH (one `command -v` probe per process, never throws), and "read package.json /
  Makefile / README before guessing a build command". Keep that description short — it
  rides on every request. A non-zero exit is a RESULT (the model needs the failing
  test), framed as data; a refusal (cwd outside the roots) or a shell that cannot start
  throws. The turn's AbortSignal reaches tools as `ctx.signal` (`agentChat`), so Esc
  kills the command's process group with the answer.
  **`stdinFrom` pipes an earlier result in** — the id of a tool call of this
  conversation (the `tool_call_id` the model's history carries), or the `res:` id a
  recall stub names (which reads the result whose content is that item's, whatever
  later call reused the id). The command reads that call's data on stdin byte for byte:
  the text the TOOL returned, never the `OK:` tag, never `capToolResult`'s cut, and
  never a frame the tool put around it for the model — a tool that frames its text
  returns `{ text, raw }`, `raw` the bare data or `null` when there is none (the `mcp`
  plugin: `text` its `Result of … — data from an MCP server` frame and 20k clip, `raw`
  the server's own text whole, `null` for a failed call). So the model processes data it
  already has (counts a U+00A0, saves it with `cat > file`) without re-typing it as an
  argument. Nothing else about the call changes — the y/n,
  the roots, the timeout, `shell.maxChars` — and a call without it has no stdin at all
  (`runShell`'s `stdin`, closed after it is written; `!command` never passes one). The
  seam is the host's, not the shell group's: a tool def names the argument that takes
  an earlier result (`resultInput: 'stdinFrom'`, stripped before the wire like
  `write`) — the host's own field, not part of the plugin contract (a remote plugin's
  `tool.run` would never receive the resolved text), so docs/plugins.md does not name
  it — and `agentChat` resolves it BEFORE the y/n with `findToolResult`
  (`src/assistant/tool-results.ts`, pure) over the turns before this one as the caller
  keeps them (`toolCtx.toolResultHistory` — the conversation's `api`, never the stubbed copy it sends)
  and the turn so far, the latest result of a reused id winning (a provider's ids are
  not unique across rounds). An id that names nothing, a call that failed or was
  declined, a result with no data (`raw: null`), one that is images and no text, one
  whose data was too large to keep (`RAW_MAX`, below), content that is not a tagged
  result with nothing kept beside it (a stub): refused as a bad argument is, naming the
  id, and nothing runs. The resolved text reaches the tool as `ctx.resultInput`
  (`{ id, tool, text }`); `toolCtx.toolResultHistory` itself is the loop's and is taken
  out of every tool's ctx. run_command given `stdinFrom` without it throws rather than
  run with an empty stdin. The y/n block says where the stdin comes from, dim under the
  command line: `stdin: result of search (call_3)` (`confirmWrite`'s third argument,
  `{ input: <tool>, inputId: <id> }`, the tool as the host names it).
  **A confirmed call SHOWS what it printed**, as the person's own `!command` does: the
  tool opens a live view (`ctx.liveView`, see "A tool describes what it shows, a
  renderer draws it, the host frames it") and fills it as the command prints, and the
  chat draws the `! …`/`‼ …` block (the second when it is marked `interactive`; see
  the bang levels below). Its gutter marker is dim while the command runs — a slow
  pulse off the same clock the elapsed-seconds tail already redraws by, no timer of
  its own — then `ok` on exit 0 or the error colour otherwise (`ChatRow.consoleMark`,
  `src/views/modals.ts`; a stopped or timed-out run keeps its own wording in the tail
  beside it, only the marker's colour changes). A declined call leaves none — nothing
  ran; a failed one shows its output and its exit code.
  **The command itself is kept WHOLE**, up to `VIEW_CAPS.command` (16 KiB — it is text
  someone typed, never a display cap, and it keeps its own line breaks — a heredoc or
  a paste — where every other field of the view is flattened to one line): a folded
  row that has no room for it cuts it with `cutStep`, reserving space for the outcome
  first so the duration and how it ended stay on screen (and flattens a multi-line
  command to draw it, `frameView` would anyway); the opened block never cuts it,
  wrapping each of its lines across its own rows instead (`wrapCells`, `src/cells.ts`)
  — up to `VIEW_CAPS.commandRows` (40) of them, past which a dim `… N more lines of
  the command` row stands in for the rest: the command's own rows share the block's
  `VIEW_CAPS.rows` budget with its output and its outcome row, so at 16 KiB they must
  stay bounded well short of it or a long enough command, wrapped narrow, could push
  the tail of the output and the outcome row out of the block entirely. The record,
  the journal and `/export` still keep the command whole regardless — only this
  display is capped.
  Every duration the person reads, here and in the turn's timer, is one
  `formatDuration` (`src/assistant/duration.ts`, pure): whole seconds, never a
  fraction — `<1s`, `12s`, `3m 5s`, past an hour `1h 2m`.
  Folded, the block is ONE line saying how it ended — `cmd · ✓ 4s`, `✗ exit 1 · 4s`, `stopped`, `timed out` — and, when it printed more than a click shows, how much it
  holds: `· 40 lines`, or `· last 200 of 300 lines` when the view kept only the tail of
  what was printed (`ConsoleData.lines`, recorded at collection only when it cut —
  past `shell.maxChars` a lower bound); a CLICK opens it
  to the last `plugins.assistant.runOutputLines` lines (20) with `… N lines cut · ^o for
  all` above them — a display cap of its own, quite apart from `shell.maxChars`, which
  is how much the MODEL is given — unless the whole block is taller than the
  conversation's rows, when the click opens it in the pager instead (see "A block
  taller than the conversation opens in the pager" under The chat); `^o` opens every
  block in full inline (`VIEW_CAPS.lines`, everything the view kept), which is what
  makes `^o for all` true rather than a second, still-capped state. Consecutive commands of a turn (no other call between them) fold under one
  `ƒ Ran N commands · ✓ 34s` head — `Running N commands · ! cmd · 4s` while one runs —
  which also takes in the rounds between them that said nothing but their plan (a
  step that is only its `Next:` line, `isPlanOnly`: the head says what ran, which is
  what the plan said would). Opened, they are the commands alone, each its own block
  (`src/assistant/view-groups.ts`). Groups form only in the `step` notes mode, and a
  message that says more — a step of its own, a call, a change, reasoning — is never
  folded into one. A call that left a view is shown by its view and never a second
  time as a trail line.
- **A background shell is a job beside the children** (`src/assistant/shell-job.ts`; the
  tools in `src/loader/tools-shell.ts`). `run_command({command, background: true})` starts a
  `ShellJob` — a record beside the owning conversation's `children`, not a degenerate
  `Conversation` — through `ctx.jobs` (`conv.jobPort()`). The consent is the foreground call's
  (the same y/n, the `shell.autoRun` lift, the cwd and `shell.roots` fence, the withheld
  environment and its once-per-conversation note); `stdinFrom` with it throws. The job is a
  *probe* until the settle (`BACKGROUND_SETTLE_MS`, 2 s, cut short by the turn's signal — Esc
  ends the wait, never the job): one that ended in the settle answers as a foreground result
  and leaves no job, no journal line, no inbox item; one still running is *kept* (`keepJob`) and
  answers `sh-N` with the lines so far in a nonce-fenced `<program-output>` and a `next:` cursor.
  The process is `/bin/sh -c` in its own group, stdin ignored, stdout and stderr in one ring
  buffer of `shell.jobChars` (64000) characters, secrets removed per pipe before anything sees
  them; it ends when the pipes close. `shell.maxBackground` (4) bounds the running jobs of the
  process (`registry.jobs`, one counter `sh-N`; a job being killed does not count; a refusal
  lists the running ones). Both keys are on the `shell` leash. A subagent may start jobs; a task
  cannot, having no `run_command`.
  `shell_output(id, {since?, tail?, grep?})` reads from `job.told` (set to the cursor
  `run_command` returned) and advances it; `since` and `grep` take an explicit cursor (grep from
  0), `tail` leaves the cursor alone. `grep` is a literal, case-sensitive substring, never a
  pattern, at most `GREP_LINES` (100) lines and `shell.maxChars` characters, with `N more … not
  shown` and a cursor that stops at the last line returned. Answers are fenced as data and say
  how much the ring buffer dropped. `shell_kill(id)` is `write: true`, in `NEVER_AUTO` and in
  the `shell.autoRun` lift (host def only, `isHostShellTool`), shows `kill sh-2: <command>`, and
  reaches only jobs of the calling conversation (`jobById`); `shell_list()` is read-only.
  **Ends of life.** `kill(by)` is SIGTERM to the group, SIGKILL after `JOB_KILL_GRACE_MS` (2 s,
  a straggler is killed when the job ends after a kill); `killNow` announces the end first, then
  SIGKILL, all synchronously — the exit path (`registry.closeAll` kills jobs first, before the
  aborts). `/clear`, the close of a subagent (a closing subagent's jobs are killed, not handed
  up) and the person's stop kill with the grace; leaving a session asks (below). The last
  `MAX_ENDED_JOBS` (20) ended jobs stay as record plus buffer (`endedShellJobs`), emptied by
  `/clear`. A state file (`shell-jobs.json` in the host state dir; entries `owner`, `id`,
  `pgid`, `startedAt`, `command`) lets the next start list jobs whose owner is dead and whose
  group is alive (`scanLeftovers`, `leftoverNote`, one note row at chat start); it never kills
  them — a pid may have been reused.
  **A job's end goes to its owner** (`deliverJobEnd`: `to = this`, no `resultRecipient`): an inbox
  item framed as data (`what: 'shell'`, the last `END_LINES` (20) lines, a nonce). Kills by the
  person or the model are quiet (a row, no turn); a kill by a signal nobody here sent is not
  quiet, so a model job so ended may wake (pinned by a rig test); a job that ends on its own
  with its group still alive (`leftover`) has the group sent SIGTERM, SIGKILL after the grace; kills by exit, clear and parent deliver
  nothing. A subagent that does not stay never reads an end that lands after its turn, so the
  person's toast covers it; one that stays reads it in its next turn. **The wake** is in
  `takeInbox` and only for a job with `by: 'model'` delivered to a session or to a subagent that
  stays: `mayWake()` needs `wakeRun < MAX_WAKES` (3), the session above (`homeSession()`, the
  conversation itself for a session) not headless, and the host's shown conversation to be that
  session, so a left session's subagent sleeps with it, as it does while the session has a question or
  y/n drawn. A shell end is a `result` item with `from.what: 'shell'`; `readsChildResult` leaves it out, so
  the answer of the turn it woke stays in the subagent (`markAnswered`) instead of going up; the inbox holds
  (`inboxHeld`: busy, y/n, question, queue) and a headless conversation starts no inbox turn
  at all. A woken turn is the ordinary `send(…, {fromInbox: true})`, so it runs under the
  conversation's own auto mode and round cap; it counts `wakeRun++`, adds a `note` row and the
  event `shell-wake {job, command, woke}`, and a `send()` from the person resets the count. At
  the cap the end lands as a row with a note and `shell-wake {woke: false}`. `Conversation.tellJobEnd`
  toasts every kept job end through `deps.showMessage` (so a left session's shows too), except
  the ends by exit, clear and parent and one the wake toast already said (`toldWake`/`toastedEnd`).
  **The person's side.** `!cmd &` (`background-bang.ts`, `backgroundCommand`) takes only a bare
  trailing `&` — not `&&`, `|&`, `>&`, `\&`, not inside quotes, not after a word-initial `#` —
  and starts a `by: 'person'` job with the whole environment in the conversation's directory,
  without holding the field. `Conversation.tree()` makes kept jobs `TreeNode`s of
  `kind: 'shell'` (`key job:sh-N`) after the children of their level: running ranks as `working`,
  an ended unread one as `idle` + `answered` until read (`readJob`); `x` then `y` on a running row is
  `killJob`, `x` on an ended row is `readJob` with no question (the `TreeRow.ended` flag turns the hint
  to `x dismiss`). The ended row of a job the model started (`by: 'model'`) is read when a request to
  the model carries its end: `landInbox` notes the id in `landedEnds`, `runTurn` calls `endsSent()` once
  it has built the history. A wake held back by a guard, or `ai.backgroundFollowUp: false`, lands the
  end with no request, so the row stays until the next message; a person's job never leaves this way.
  The pager of a job reads the WHOLE ring buffer at each draw (`jobConsoleData`,
  `whole`, `ViewRecord.rows` raising `frameView`'s 400-row cap), not the view caps.
  `askLeave` (`/new`, a picker switch, `/resume n`) lists the shells (`shownJobs()`, subagents' too;
  a probe still within its settle is none, and the session stays loaded for its running turn) in a
  panel: `s` stops them
  and leaves, `k` leaves the session headless with its jobs, Esc stays, and a pending y/n or
  question blocks the leave; a refused switch from the picker brings the picker back with its
  notice. The footer's `N in background` adds `registry.shellCount()`.
  **Journal**: `job-start {id, command, cwd, by}` (stamped `at` with the spawn time),
  `job-out` (coalesced as `shell-out`, capped as it, by id) and `job-end {id, ms, code, by:
  'self'}` or `{killed: true, by: person | model | clear | exit | parent | signal}`; a
  child's route keeps all three. `/export` draws a job at its start, stitches the output by id
  and ends it `exit N · dur`, `killed (by) · dur` or `did not finish`.
- **`cd` moves the shell's directory for the model** (`src/loader/tools-shell.ts`, the
  `shell` group, so `ai.disabledTools: ["shell"]` takes it too). `{ path }`, relative to
  the conversation's directory or absolute (`~` the home). It is held to `shell.roots`
  by `insideRoots`, the check run_command's `cwd` shares: the REAL path inside a root's
  real path is the guard, and the spelling is not held to the spelled roots — under a
  root that is itself a link, a directory stored real (`pwd -P`) is spelled by its real
  path, and `cd ..` from it must still work. Outside, it THROWS naming the roots (a
  link out says where it leads); a missing path "does not exist", a file "is not a
  directory"; with no roots configured it refuses — it is read-only (no y/n), so
  nothing but the roots guards it. It sets `ctx.shell` the way `!cd` does, so the hint
  row and every later run_command follow, and answers `now in <dir>` and the AGENTS.md
  files picked up there (or `no AGENTS.md between here and <root>`) — from the chat's
  own reading when the ctx carries one (`ctx.projectInstructions`), else read itself.
  Once the group is loaded (under tools on demand that is a `tools_load` first, since
  `shell` is not core), one call enters a project.
- **The project's instructions ride in the system prompt**
  (`src/assistant/project-instructions.ts`, pure but for the reads). Whenever the
  shell's directory is SET — `ShellState.setCwd`, the one place: `!cd`, run_command's
  moves, `cd`, `/clear`, a restored session — its `onSet` listener has the chat read
  `AGENTS.md` (exactly that name, matched in the directory's listing: a stat on a
  case-insensitive disk finds `agents.md` too) in every directory from the shell's up
  to, and not above, the innermost `shell.roots` entry holding it, compared by REAL
  path; a directory that is a root has only its own. Outermost first, nearest last, so
  the nearer wins. Nothing outside the roots is read: a directory outside them, no
  roots at all (then not even the process's directory), a file that links out, a
  non-file; a file reached twice through a link is sent once. Each file is capped at
  32 KiB (`INSTRUCTIONS_CAP`), cut at a line break with `… (cut at 32 KiB — N more
  lines)`; only the head is held, the rest counted; there is no cap on the whole, so
  five nested files cost up to five times that. The section is `## Project
  instructions` — a framing line naming the ROOT, never the shell's directory (a move
  inside a project must keep the section byte for byte, or every `cd src` misses the
  cache; the model learns the directory from `cd`'s answer and run_command's output),
  and saying these are the repository's words, not the person's or the host's, never
  overriding either; then each file under `### <path>`, quoted in a fence longer than
  any backtick run it holds, so its own headings can never read as the host's
  sections; a cut is noted outside the fence. It sits after the memory and before the
  plan (`joinSystem`). The rest of the system prompt is taken once per message; this
  section is read again before EVERY round (`AgentOpts.systemPrompt`, laid over the
  round's copy, never the history), so a `cd` is seen by the next round of the same
  turn, and a round whose text did not change sends the message it had — re-reading
  the plan per round would miss the cache after every `todo`. It is never a message in
  the history, so it is never stubbed, compacted or duplicated. A background task is a
  conversation too, so the same rule holds there: its shell starts in its parent's
  directory and its own `cd` reads the section again, its per-round system prompt (the
  worker prompt) carries the project block of its own reading, and it is never handed
  the chat's reading. The one-shot prompt is a conversation: `Conversation.fresh`
  reads the section for the start directory, and a `cd` reads it again, as in the chat.
  The
  chat says which files were picked up in a `note` row (`Project instructions: ~/p/
  AGENTS.md`) only when the list changes; during a turn the note waits for the turn's
  end (a note between rounds would split the turn's message), and a list that already
  ends in the same note gets none (a continued session, restart after restart).
  `applySession` and `/clear` drop a waiting note and set the directory AFTER replacing
  the list, or the note would be replaced with it. The context meter counts the
  section under `system`.
- **`!command` runs a shell command** — the person's own, typed into the field
  (`!bun test src/features`); the model never reaches this path. The field carries a
  **bang LEVEL** — 0 normal, 1 shell mode, 2 interactive mode (`!!command` below) —
  and `!` typed into an EMPTY field steps it UP one level instead of being inserted
  (like Claude Code's bash mode, taken one step further): the prompt glyph reads `! `
  at level 1 and `‼ ` (U+203C, one glyph rather than two `!` characters) at level 2 in
  place of `› `, both in `theme.modals.chat.shell` (a colour of its own, distinct from
  `accent` — pick it from `MODAL_COLOR_DEFAULTS.chat` in `src/playback/theme.ts`,
  checked against flowtty's `NAMED_COLORS` by the theme test; `‼` reuses the same
  colour rather than getting a second one — one shell identity at two depths). Both
  glyphs are the one mark for HOW a run happened (`RUN_MARK`/`runMark`,
  `src/assistant/shell.ts` — the source the field's own prompt reads too, rather than
  typing `!`/`‼` again), drawn wherever a run is: a command's own gutter marker in the
  chat's rows, the y/n and the tool trail for `run_command`, `/export`, and the
  model-facing text a `!command` or `run_command` returns. They are exactly `GUTTER`
  (2) columns each: `‼` is one cell wide
  (`stringWidth`), so it takes a trailing space of its own, same as `! `, so a wrapped
  command's continuation rows still line up under the first. Enter runs the field text
  as it reads — level 1 as
  the plain command, level 2 handed to the terminal (below) — and the level drops
  back to 0 right after, whatever it was: one command per bang, even on an empty
  submit (leaving a level engaged would silently redirect the next thing typed into
  the shell too). Backspace on an empty field steps the level DOWN by one (2 → 1 →
  0) without deleting anything else; Esc on an empty field does the same, before the
  usual double-Esc exit arms (the same "closest thing first" order as Esc's own
  field-clearing step) — leaving `!!` for good this way costs two Backspaces (or two
  Escs), one per level, from an empty field. `!` after other text, or already at
  level 2 (the top), is just a character. Enter reads only the UI state to pick the
  level, never the field's TEXT for a leading `!`, so a command's own text can start
  with `!` (the shell's negation, `! grep -q x f`) without being read as a request for
  an interactive run that would eat the bang the negation needs; getting such text
  INTO a level-1 field takes a paste, since typing
  `!` there on the still-empty field steps the level instead of inserting it.
  History keeps each line as it was run, `!cmd` or `!!cmd` — `encodeBangLine`/
  `decodeBangLine` in `src/assistant/prompt-history.ts` — with one wrinkle: a level-1
  `cmd` that itself starts with `!` gets a disambiguating space (`! !cmd`), since
  `cmd` is always trimmed and so never starts with a space otherwise; without it,
  `!` + `!cmd` reads back as `!!cmd`, indistinguishable from a level-2 entry
  (decoding checks the PREFIX `!!`, not what follows it). ↑ recalls a line into the
  matching level with its bang(s) — and that disambiguating space, if any — stripped
  from the field shown, so recall + ⏎ runs it the way it ran. A paste is never
  decoded into a level change (pasted text, bangs included, fires no binding), so
  pasting a whole `!command` or `!!command` into an empty NORMAL field inserts it
  literally and runs the legacy way, `decodeBangLine`-read from the pasted TEXT
  instead (also how ↑/↓ recall worked before shell mode existed, and how a session
  saved by an older build could still replay one). It runs through `/bin/sh -c` in
  its own process
  group (a timeout, `shell.timeoutMs` 120 s, or Esc kills the whole group), stdin
  closed, `PAGER`/`GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`; stdout and stderr merged;
  the output keeps its TAIL (`shell.maxChars` 20000) and says how much was cut. While
  it runs (`Conversation.runShell`, `src/assistant/conversation-shell.ts`) the chat is
  busy exactly as while an answer is written (`Conversation.busy`, the spinner, `! cmd`/`‼ cmd` as the tool label, Esc stops it); a `!` meanwhile is
  refused, not queued. The result is a message of role `shell` — `! `/`‼ ` in the
  SAME shell colour as the mode's prompt (a command reads as one thing from typing
  to result) on the
  person's ground, the same live block as the model's commands (one line while it
  runs; `✓ 1s · ~/dir` when it ends, opened by a click to its last lines) — the
  message is still role `shell` and still joins the conversation's `api` (`apiHistory` maps `shell` →
  `user`) and is read with the next message; no turn is spent. It is saved with the session and
  its line goes into ↑/↓ as `!cmd`; recalling one with ↑ shows it the way it was
  typed — level 1, the field holding `cmd` with the `!` stripped (see the bang-level
  paragraph above). The bang level itself is UI state of the field only, never saved
  and never restored across a restart; a `!…`/`!!…` or a non-zero-level field is not
  a draft. **The directory is remembered**
  between commands, as in a terminal, and shared with `run_command`: it starts where
  the app was started (`startDir`, captured once — nothing here calls
  `process.chdir`) when that lies inside a configured root, real path, by
  `shellCwd`/`dirAllowed`'s rule — else the first configured root that is a directory
  (`startNote` says so, as a TOAST — `showMessage`, not `pushNote` — every launch it
  applies, since a permanent row and journal line would otherwise pile up, one per
  restart, in a session continued outside the roots day after day); with no roots at
  all, always the start directory. A `cd` moves it only within the
  roots by real path (the shell writes `pwd -P` to a private temp file after the
  command — a 4th stdio pipe under Bun lost the report now and then), `exit N` or a
  kill keeps it, run_command's `cwd` argument is a `cd` that stays, `/clear` and `/new`
  go back to that same start-derived default, `/resume` and a restart bring back
  whatever the session had saved. Variables
  and functions are not kept — every command is a fresh shell. While the field is in
  `!` or `!!` mode the hint row under it STARTS with that directory (`~`-shortened,
  cut from the left when long — `cutLeft` in `src/cells.ts`; the chat passes
  `shellCwd` only at a non-zero bang level, since `cwd()` checks the roots on disk), so
  where the command will run is seen while it is typed and `!cd` is seen to take
  effect before the next command. **The live block still
  says where a `cd` moved to, or that one was refused** (`ConsoleData`'s `movedTo`/
  `note`, `src/assistant/console-view.ts`), drawn only alongside `showCwd`:
  `~/a → ~/b` when the command's own `cd` actually moved the directory, `cd led
  outside the roots — stayed` (fixed wording, dim) when one tried to leave the roots
  and was refused. `run_command`'s own view never sets `showCwd` and so never draws
  either.
- **`!!command` runs an INTERACTIVE program and hands its recording to the model**
  (`src/assistant/interactive.ts`; the chat's side is `Conversation.runShell(cmd, true)`
  (`src/assistant/conversation-shell.ts`)) — a
  TUI, a prompt, `git add -p`, a login flow, which `!` cannot run (its output goes
  through pipes). Typed as `!!cmd` — the second `!`, on the still-empty field, steps
  from level 1 to level 2, the same as pressing `!` again once already in shell mode
  — or reached at once by anything that skips the keystrokes: a recalled `!!cmd`
  (↑/↓), or the legacy path below for a `!!cmd` pasted whole into an empty NORMAL
  field (a paste never changes the level, so it stays 0 there and is read from the
  text instead); kept in ↑/↓ as `!!cmd`. The chat hands the terminal over through
  `services.suspend` — flowtty's `useApp().suspend`, bound by the App like `alert` and
  `copy` (the default just runs `fn`) — and the program runs under `script`, so it has
  a real terminal while what it printed is recorded into a temp file. The command is
  written to a FILE in the same temp directory, never passed as a string: util-linux's
  `-c` string is run by the person's `$SHELL`, which re-parses it — csh and tcsh refuse
  the newline every command carries (the pwd trailer), fish reads backslashes its own
  way. So BSD/macOS `script -q <rec> /bin/sh -c 'eval "$(cat "$1")"' '!!' <dir>/cmd`
  (its exit code is the child's; a child killed by a signal comes back as the bare
  signal number), util-linux `script -q -e -c "/bin/sh '<dir>/cmd'" <rec>` — the path
  is checked to be one every shell reads plainly inside single quotes (`scriptCommand`
  refuses any other), and a test runs that string through every shell on the machine.
  **`$0` is a neutral name, `!!`, not the temp file's own path** — running the file as
  its own path would read `!!asd` as `<dir>/cmd: line 1: asd: command not found`.
  Running the file as `sh <dir>/cmd`
  (two args) sets `$0` to the file; `sh -c '<script>' name args…` sets it to `name`
  instead (POSIX: with `-c`, the word after the script text is `$0`), and the script
  text READS the file and `eval`s it rather than sourcing it: `. "$1"` (sourcing) also
  keeps `$0`, but bash's own "command not found" / syntax-error messages for a
  SOURCED file still name the file, never `$0` (verified against the real macOS
  `/bin/sh`); `eval "$(cat "$1")"` does not, since nothing is tracked as a "source"
  file — the trade-off is bash's `line N:` prefix, tied to that same tracking, which
  goes with it (`!!: asd: command not found`, not `!!: line 1: …`). This applies to
  BSD (its argv is exec'd directly, `script` never hands it to a shell to re-parse)
  and to the no-`script` fallback (Node's own spawn, same reasoning) — **never to
  util-linux's `-c` STRING**, the one thing actually re-parsed by the person's
  `$SHELL`: csh and tcsh treat `!` as history expansion even inside single quotes and
  even non-interactively (`csh -c "echo '!!'"` fails with "Event not found", verified),
  so `!!`, and the `eval`/`$(…)` syntax csh does not share either, must never reach it
  — that string stays exactly `/bin/sh '<dir>/cmd'`, so `$0` there is still the temp
  path, a known gap on util-linux alone. Which `script` is asked
  once per process (`command -v script`, then `script --version`): util-linux names
  itself, BSD is told POSITIVELY (its usage line, or the system is Darwin / a BSD);
  anything else is not used, and the program runs unrecorded. The shell, the directory and its rules are `!`'s own (the same
  `withPwdTrailer`; a `cd` outside the roots is not remembered); the environment is the
  person's UNTOUCHED — `!`'s `PAGER=cat` and `GIT_TERMINAL_PROMPT=0` exist because
  nobody can answer a prompt there, and here somebody is. No time limit. The child
  stays in the app's process group (the terminal's foreground group; in a group of its
  own its first read would stop it). While it runs no key reaches the chat (the TTY
  backend stops reading stdin for the hand-over; the test backend does not, so there
  is no test of that) and Esc / Ctrl+C are the program's: `holdSignals` puts a no-op
  on SIGINT, SIGQUIT and SIGCONT and takes the other listeners off — flowtty unmounts
  the app on SIGINT whatever else listens, and without `script` the terminal is in its
  normal mode and sends SIGINT to the whole group — then puts them back in order. It
  wraps the WHOLE hand-over (`holdSignals(… suspend(… spawn))`) and gives them back one
  event-loop turn after the terminal is the app's again, so a signal raised by the
  program's last keys is never the app's. SIGCONT is held for Ctrl+Z inside a program
  run WITHOUT `script`: it stops the app too, and without holding it, on `fg` the TTY
  backend's own SIGCONT listener would take the terminal back while the program still
  ran; held, the program keeps it until it ends and the hand-over's own return
  repaints. (Reasoned
  from the backend's code, not tried in a live terminal.) On return only the recording's last `RECORDING_READ_MAX` (1 MiB) is read
  (`readTail`, from a whole line; the bytes skipped count into `cut`) — a program left
  running for hours must not cost a long freeze. `cleanRecording` resolves it as a
  terminal would have left it (`\r` back to the line start and overwrite, `\b` back
  without erasing, `ESC[K`, `ESC[nG`/`ESC[nC` — columns clamped at 4096; what was drawn
  on the ALTERNATE screen — `?1049`/`?1047`/`?47` — dropped, as it is gone once the
  program leaves, or every vim/less/top redraw would reach the model, and a tail whose
  first toggle is an EXIT began inside it, so all before that goes too; string
  sequences — OSC, DCS (sixel), APC (kitty graphics), PM, SOS — dropped whole, each
  ending at BEL/ST, the next ESC or 4096 characters; every other sequence dropped;
  util-linux's header lines dropped). Every pattern is bounded: an unterminated OSC
  never lazy-matches to the end, which would be quadratic over a 1 MiB tail (13 s
  measured); a test holds 20k of them under a second. Then `sanitizeViewText`; the model gets its END capped at
  `shell.maxChars`, the view `capConsoleText`. The temp directory goes in a `finally`,
  whatever happened. The
  result is the same `shell` message and console view as `!`'s, marked `interactive`
  (`ConsoleData.interactive`, drawn dim beside the command, kept by `capConsoleData`).
  It asks whenever something was recorded: the recording joins the conversation's `api` as `The person
  ran an interactive program …`, and a turn starts at once with `INTERACTIVE_ASK` as
  the person's message — `send(…, { hostAsk: true })`: drawn dim, gutter and all
  (`hostAsk` on the display message, `quiet` rows), never put into ↑/↓, and the field
  is left alone (it did not come from there). Nothing recorded — no `script`, or nothing
  left once a full-screen program's own screen is dropped (`!!vim`, `less`, `top`) —
  and the run is a block on screen only: no `api` entry, no turn, a dim `note`
  saying the assistant was not asked (a turn on "(no output)" is a request for
  nothing). Whatever the program echoed — a value typed at a prompt that echoes it back
  (a password prompt does not) — is part of the recording: it is sent to the model and
  saved with the session. `sessionTitle` skips the ask (`hostAsk`): a session is named
  by what the person said. The chat stays busy from the command into the ask's turn, so a message
  typed in between queues behind the ask and follows the queue's rules. Refused while anything runs, exactly as `!` is: a
  recording landing in the middle of a running turn's history would split it, and a
  y/n could wait unseen behind the program. No usable `script`: the program still runs
  with the terminal through the same `$0`-neutral `/bin/sh -c 'eval "$(cat "$1")"' '!!'
  <dir>/cmd` and the view shows how it ended. Tests inject `services.interactive`
  (`InteractiveDeps`: `detect`, `spawn`, `signals` — `renderApp`'s `interactive`,
  `bootApp`'s `opts.interactive`; by default a test has no `script` and a spawn that
  exits 0) and never reach the machine's `script` or the process's signals.
