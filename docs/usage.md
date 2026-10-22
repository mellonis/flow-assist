# Using the chat

How to work in flow-assist's chat: sessions and projects, what the assistant keeps,
background work, reading a long turn, where the chat sits, and running commands. What
the assistant may do without asking is on [safety.md](safety.md); every setting and
variable is on [config.md](config.md).

## Sessions

### A session belongs to a project

The chat is saved as you go and continued on the next start, so a restart or an update
loses nothing. A session belongs to the project it started in — the git repository
holding the shell's directory at its first message, when that repository lies inside
your `shell.roots` entry (so a root that is a whole workspace keeps each of its
repositories a project of its own); the root itself when there is no repository between
it and the directory; outside every root, the nearest repository — and a start continues
that project's newest session; in a project with none yet a new session starts, and a
note says where the others are.

### The session picker

`/sessions` — or Ctrl+S from any screen (`config set
keys.sessions <key>` moves it) — lists the current project's saved sessions, newest
first, with their titles, when each was last used, its size, and what it is doing —
`this chat · working` while an answer or a command runs, `here · working` for a session
you left while its background tasks run (it stays open in this process until they end,
and the row changes to the file's status by itself when it is put away; a session you left
with a subagent resting in it stays open the same way, and its row reads by the session's
own status; `here · waiting`
when it stopped on a y/n or a question — a toast and a system alert say so once, and it
waits until you open it and answer, since keys typed elsewhere answer nothing there),
`in use elsewhere` when another flow-assist process has it open, `done` when its last
answer or background result came while you were not looking — your own session's row
too (`this chat · done`), for one that came while the picker was open (your own row
shows only your own turn; its background tasks, and the turn of a session you left, are
the footer's `N in background`). A session you left that finishes its turn says so once,
with a toast (`● «title» finished — its answer is unread`) and no system alert, also when it
stays open for a subagent; the answer of a subagent you wrote to (`/subagent tell`) that
lands in a session you left says so once too (`● «name» answered — open the session to
read it`), and the session counts as `●` until you have read it. A
background task's result has its own toast. The row under the chat's field shows, at its
right, `⏸ N` for the other sessions waiting for your answer and `● N` for the ones you
left whose answer you have not read (nothing when there are none; the session you are in
is never counted; the count is lost on a restart, the picker's `done` is not). Tab shows
every session, grouped under each project's path. Type to filter by the title
or by any word of the conversation; ⏎ opens one (the session you are in is saved first;
a `here` one is taken back as you left it: its draft with the caret, unfolded blocks,
notes mode and place in the list; one already put away opens as any saved session does,
folded and at the end), Ctrl+N starts a new one,
Ctrl+R renames, Ctrl+P moves it into the current project (its file and journal with it),
Ctrl+X deletes after a y/n.
A session open in another process can be neither opened, renamed, moved nor deleted
from here, and your own open session refuses a move too — switch away from it first. A
`here` one can be opened and renamed, but not moved or deleted until it is put away (when its turn and its children have ended, and any subagent you started is stopped).

### Naming, `/new`, `/clear` and `/resume`

A session is named by the first line you wrote; `/title <text>` renames it. `/new`
starts a fresh session and keeps the current one as it is — a restart before you say
anything continues it. If an answer is still coming, the session you leave goes on
working: the picker shows it (`here · working`), and Esc does not reach it from another
session. A session you leave with a subagent you started still in it stays open in this
process too, so coming back finds the subagent where it was; it is put away when the last
subagent ends.
`/clear` also starts a fresh session, but it stops an answer that is still coming and
the session's background tasks, and marks the old session closed, so a restart starts
empty. `/resume` lists the current
project's saved sessions (the top level's when there is no project) and `/resume <n>`
opens one; the others are a Tab away in `/sessions`.

### Where sessions live, the journal and `/export`

Sessions live in `sessions/` in the
config directory, under a mirror of their project's path
(`sessions/Users/me/app/<id>.json`; a session with no project, and one saved by an older
version, at the top level), readable by you only (`sessions.resume: false` starts every
run empty; `sessions.keep` — how many are kept per project, 50 by default;
`sessions.maxRunning` — how many conversations of the process may work at once, your
own turn included, 4 by default, so a turn's background tasks run three at a time).
What a restart restores is bounded — the last 400 messages of the conversation, fewer of the commands' output blocks — but each session also keeps a
journal beside it, `<id>.log.jsonl`: everything as it happened — every tool call with
its whole arguments and result and the y/n you gave it, a background task's calls under
its name, every `!command` with its whole output (up to 8 MiB), every `/compact` summary
— written line by line so a crash loses nothing, and never trimmed. It lives exactly as
long as its session and goes when the session is deleted; `sessions.journalDays` (0 by
default) removes one not written to for that many days, and the session then says so in
a note.

A subagent keeps its whole conversation in a journal of its own, in a `<id>.sub` directory
beside the session's: what it was asked, its steps, its calls with their results and your
y/n, the questions it asked and who answered them, its answer. The session's journal holds only the lines saying it started, answered and ended.
A background task has no file of its own; its calls are in the journal of whoever started
it. The `.sub` directory goes with the session — when it is deleted, pruned beyond
`sessions.keep`, or has its journal removed by `sessions.journalDays` — and moves with it
into another project.

`/export [path]` turns the journal into a markdown document you can read — the
conversation, each tool call folded with its arguments and result, the `/compact`
summaries where they happened, each subagent's conversation folded under the line that
says it started — written to the path you give, or to `session-<id>.md` in
the shell's directory; it never overwrites a file that is there.

## What the assistant remembers

**What the assistant remembers is yours to see.** When you ask it to remember
something, it keeps the fact as a file of its own in the project's agent workspace —
`memory/<id>.md`, with a name, a one-line description and a type, indexed in
`memory/MEMORY.md` — or in the global workspace, for what holds in every project. Each
request carries the index of this project's facts and the global ones, not their text,
presented to the assistant as its own earlier notes rather than your instructions; it
reads a fact in full when its line matters. A fact kept in one project never reaches
another. `/memory` lists them, this project's first; `/memory forget <n>` removes one,
`/memory forget project`, `global` or `all` a whole list — without asking the model.
A fact file the app did not write itself — a command changed or added it — is listed as
`changed outside flow-assist`, with the line a request would carry for it, and not sent
until you accept it as that list showed it: `/memory accept <n>`, or `/memory accept
all` ([safety.md](safety.md), "Plugins and memory changed behind the
app's back").
`/clear` says how many it kept. What an older version remembered in `memory.json`
moves into the global workspace on the first start, and a note says how many facts
moved; the old file stays as `memory.json.migrated`.

## The assistant's own workspace

**The assistant keeps its own work in its own place.** Each project has an agent
workspace, `projects/<the project's path>/_workspace/` in the config directory
(`_global/_workspace/` for what holds everywhere), holding its memory and `artifacts/`:
the drafts, notes, plans and findings you asked it to keep. It writes there without a
y/n — nothing of yours is touched — and each write shows in the chat as a change with its
path, and in the session's journal. The tools reach nothing outside the workspace, and
what the assistant reads back from it is its own earlier note, not your instruction.
`/workspace` lists this project's workspace; `/workspace <path>` shows one of its files
in the chat, to you only — it is not sent to the assistant.

## New lines

⏎ sends; ⇧⏎ (Shift+Enter) starts a new line. flow-assist asks the terminal for the
kitty keyboard protocol as it starts and hands it back as it exits, and a terminal that
has it tells Shift+Enter from Enter: kitty, Ghostty, WezTerm, foot, Alacritty, iTerm2
3.5 and later, and tmux with `set -s extended-keys on` inside one of them. Terminal.app
does not — there Shift+Enter is a plain Enter and sends. Two more keys start a new line
anywhere: ⌥⏎ (Alt+Enter; in Terminal.app with "Use Option as Meta key" on), and a
backslash typed at the end of the line, then ⏎, which works in every terminal.

In a terminal with the protocol, Ctrl+[ is a key of its own, not Esc, and Ctrl+I and
Ctrl+M are not ⇥ and ⏎; Esc arrives at once.

## Typing while it answers: the queue

A message sent while an answer is still coming is queued (`⏎ queued`) and reaches the
assistant after its current step — between two tool rounds — so a correction lands
while the work it means to steer is still going; ↑ on an empty field takes the last one
back to edit until then, and ⇥ holds it for the end of the answer instead. Esc or
Ctrl+C stops the answer on the first press — then the waiting messages come back into
the field instead of being sent, and so they do when a request fails. ↑/↓ walk
everything you typed, `/commands` and `!commands` included, and the history is saved
with the session. Ctrl+C (or Ctrl+D on an empty field) quits and Ctrl+Z suspends only
when pressed twice: the first press says `^c again to exit`.

## Background work

**Work in the background comes back by itself.** Ask for something "in the background"
and the assistant hands it to a task of its own; the chat stays yours meanwhile. A
task's result never cuts into an answer being written: it waits until that answer ends,
then lands as a `◆` message, and the assistant reacts — in one turn for everything that
came back together, or, when you have a message queued, in that message's turn. A
half-typed message in the field stays where it is; a y/n or a question waiting for
you holds the results until you answer. With the chat closed the turn still runs,
and the footer's `◆ N new` and a desktop notification say something came in.
`config set ai.backgroundFollowUp false` keeps the results as messages only, read with
your next message. The assistant reads a result as data another agent wrote, in a frame of
its own, never as something you said: you see the plain text, and an instruction inside it
is not yours.

A task works on its own: it never asks you directly, and Esc in the chat does not stop it.
When it cannot go on without an answer it may ask the conversation that started it (the
session, or the subagent you started that began it): the assistant there reads the question
as data another agent wrote, in a turn of its own, and answers it, asking you first if it
must. A task that gets no answer — the turn ends without one, the conversation closes or
was left, or `ai.backgroundFollowUp` is off — goes on with its best assumption and names it in
its result. Where the job merely leaves something open it makes an assumption without asking. Whatever would wait for your y/n (a command, a file change, a fetch off the
allowlist) is declined, unless the assistant started the task with `write: true`: then each
write stops for your yes, asked as a subagent's is (see Subagents you start), and the task
that waits does not hold one of the running places. It gets twelve rounds; one that runs out of them
says so at the end of its result (`stopped after 12 rounds — last: …`). A task may start
one follow-up task of its own; `ai.subagentDepth` (2 by default) is how deep such a chain
may go. At most three run at once (`sessions.maxRunning`, above); the rest wait their turn.

A task's result goes to the session, or, when a subagent you started began the task, to
that subagent (see Subagents you start). Leave that session while the task
runs — `/new`, `/resume`, the picker — and it stays open here until the task ends
(`here · working` in the picker): the result is a message there, not in the chat on
screen, which gets only a toast naming it, and no turn starts for it. `/clear` stops the
cleared session's tasks. A task stopped by `/clear` or by quitting says so in its
session's journal, and `/export` shows it with its time (`*<label> stopped (exit)*`).
Quitting also stops a `!command` or an assistant `run_command` still running in any
conversation.

## Subagents you start

**`/subagent <prompt>`** (`/sub` for short) hands a job to a subagent that works beside the
chat: you go on talking while it runs, and its first answer lands as a `◆` message, as a
background task's does. The subagent then stays, resting (`idle`), until you write to it
again or stop it. The tasks it starts report to it, not to your conversation. It may read what the assistant reads without asking
you. It may also write: each write (a command, a file change, a fetch off the allowlist)
stops for your y/n, and the y/n is asked where you started the subagent. It can also ask
you a question when it cannot go on without one (`ask_parent`): it waits, and what you
answer is what it reads. Where the job leaves only a small thing open it makes an
assumption and names it in its answer. It gets the
rounds and the token budget of `ai.maxRounds` and `ai.maxTurnTokens`, not a task's twelve,
and counts toward the three that run at once. The prompt is sent as you
typed it, line breaks included (⇧⏎ makes one).

**`/subagent @<name> <arguments>`** starts a subagent that an agent file describes, in place
of a prompt (see Agent files, below); `/subagent @` alone lists the agent files found, with
the errors of those that cannot be read. `--with-context` goes right after the name; `--auto`
is refused there, since the file says what the agent may do.

A question from a subagent you started is drawn in the place of the field, a free-text block
titled `from «<name>»`, only while the field is empty; with a draft in it, one line says `⏸ a
question from «<name>» waits — clear the field to answer it` and the draft stays as it is.
Your own y/n and question come first, then the oldest request of the subagents, a y/n or a
question. Like a subagent's y/n, a question takes its first key after a short pause. Type
the answer (numbers and spaces included) and press ⏎; Esc, even after you typed, answers that you gave none (the subagent then goes on with its
best assumption). The assistant never sees the question or your answer.

`--with-context` first on the line also hands over the conversation's summary — what
`/compact` left — and nothing else of the history; with no summary yet, nothing starts and
the line says so.

`--auto` first on the line starts the subagent in the auto mode `all`: the writes that mode
answers are answered without asking, as in a chat (`/auto`), and a command still asks
unless `shell.autoRun` is on. The mode of the conversation you start it from never passes to a
subagent, and a subagent's mode is not saved; without `--auto` every write asks. The flags may come in either order.

**A subagent's y/n** looks like the assistant's own, with the subagent's name in the title
(`⚠ fix-tests › read-logs · Confirm write: run_command`), and stands where you type. It is
answered with `y` or `n` alone, and only when the line is empty and you have paused: a key
pressed in the moment the block appears, in the moment the chat gets the keyboard back
(the chat key, a click, a closed panel), or right after another key, is typed as a letter
instead, so a request that arrives under your fingers is never answered by them. ⏎ and Esc
never answer it. With text in the line, or in shell mode, one line above it says `⏸ <name>
waits for a y/n — clear the line to answer` (`leave shell mode to answer` in shell mode),
and the text stays yours. With several waiting, one shows at a time, the oldest first; your
own conversation's y/n comes before them and keeps its keys, except that when it takes the
place of a subagent's block you are looking at, it waits the same pause. A picker, a
command's panel, the pager or the `:plugins` panel that is open stays open: the request
shows after you close it. On a terminal too small to give the chat the rows for the block,
the chat stays docked (the plan gives way first) and a line says there is no room to show
it; `/subagent stop <name>` declines it, with the subagent's name from that line. A chat that is
already a window shows the block there. In `/subagent`'s list such a job reads `waiting`. A subagent that waits does not count
toward the three that run at once.

`/subagent` alone lists this conversation's jobs, the live ones numbered
(`1 · find-the-failing · working · 1m 12s`; a subagent that rests reads `idle`, or
`answered` when its latest answer to a later message is unread), then the last twenty that
ended (`find-the-failing · done · 2m 3s · 14k tokens`). The list is this conversation's; the
`N in background` count on the hint row covers every conversation at once.
`/subagent stop <number or name>` reads a number against the list you last saw (a job that
ended since keeps the others' numbers, and its own is answered with a line), so list first;
a name needs no list. It stops one and whatever it started: what it had written so far comes back as a `◆ <label>
stopped:` message, with one toast and no follow-up turn. A resting subagent just ends, with
no message. A prompt that begins with the word `stop` or `tell` would be read as one of
these commands, so put another word before it.

**`/subagent tell <number or name> <text>`** writes to a subagent you started, the number
read against the list you last saw, a name as typed (any case; a name two subagents share
asks for the number). A resting subagent takes the message as a new turn of its own, with
its original task still in front of it, and counts toward the three that run at once for as
long as the turn lasts. One that is working takes the message at its next step. The answer
to a message does not come into your conversation, and the assistant never sees it: the
row reads `answered` until you have opened the subagent (⏎ on its row) and read it there.
A result that a task of the subagent's brings back is read by the subagent in a turn of its
own, once the turn it is in ends (with your message, if you wrote one meanwhile, in one
turn); what the subagent then says reaches your conversation as its first answer does, a `◆`
message. `ai.backgroundFollowUp: false` keeps such results as rows in the subagent, read
with your next message to it. A task of the subagent's that you stop lands quiet and starts
nothing.
A task, a subagent the assistant started, and one that has ended take no messages, and
the line says so. A subagent ends when you stop it, at `/clear`, and when flow-assist
exits; it does not come back after a restart, though its journal and `/export` keep what it
did. Each turn has the usual limits (`ai.maxRounds`, `ai.maxTurnTokens`); the number of
resting subagents has none. Its y/n during a later turn is asked the same way as in the
first.

Started in a chat where nothing was said yet, `/subagent` makes the conversation a saved
session like a first message would; the line you typed is its first message.

### The live subagents under the field

The subagents and tasks a conversation has running are listed under the line you type in,
one row each: `⚙ <name> · <what it is doing>` while it works, `⏸ <name> · waiting for a
y/n` when it asks you, `? <name> · asks its parent` while a question waits for an answer, `○ <name> · queued` or `· in 4m` when it has not started,
`◦ <name> · idle` when a subagent you started rests after its answer (`· answered` while a
later answer is unread). What a
node started stands under it, indented. A task is marked `(task)`. The rows carry no clocks
(an idle chat does not redraw); `/agents` shows the time. Ended nodes are not rows — their
`◆` message is already in the conversation, and `/agents` lists the last twenty.

`ui.agentRows` is how many rows may be drawn: 4 by default, 0 to 8, 0 for none. With more
live nodes than that, the ones waiting for you come first, then the working ones, then the
rest, and the last row reads `+3 more — /agents`. In a short chat the rows give way first,
down to none, keeping four rows of conversation; then the plan gives way.
The field, the hint row and a y/n never do. The rows are not drawn while a question, your own
y/n, a subagent's y/n or question block, `/context`, the pager, a picker or a command's panel is.

**↓ on an empty line** steps into the rows (not while a history entry is shown — the ↓ that
ends a walk through the history lands on the empty line, and the next one steps in — and not
in shell mode). ↑ and ↓ walk the rows; ↑ on the first row, or Esc, goes back to the line,
and the hint row names the keys while you are in the rows. `x` asks `stop <name> and 2
below it? y yes · n no` in place of that row; `y` stops the node and everything it started
(the same stop as `/subagent stop`, written to the journal as yours), `n` or Esc leaves it
running; with a question up, the first Esc only drops it. ⏎ on a row shows that node's
conversation (see below). The sessions key, Ctrl+C, the wheel and PgUp/PgDn still work there;
every other key is swallowed: nothing is typed and nothing is sent. The
cursor follows its node when the rows change; when its node ends it moves to the nearest row, and
with no row left the line has the keys again.

A subagent's y/n cannot be answered from the rows. While the cursor is in them, a waiting
subagent shows as the one line `⏸ <name> waits for a y/n — Esc to answer` (with a stop
question up, the first Esc drops the question and the next one leaves the rows); after Esc its
block is drawn and, like any block that has just appeared, waits a short pause before a `y`
counts. A subagent that waits while the line is empty draws its block in place of the rows,
so the rows are away exactly then; `/agents` or `/subagent stop <name>` still reach it.

**`/agents`** opens the whole tree where the conversation is: the live nodes in tree order
with `<state> · <time spent>`, then the last twenty that ended (`done`, `failed`, `stopped`, `empty`,
`limit`, the time and the tokens). ↑ and ↓ move, `x` asks the same question in place of the row and
`y` stops the node, Esc closes. On an ended row `x` only says there is nothing to stop. ⏎ on
a live row closes the panel and shows that node's conversation; on an ended row it says there
is nothing to watch. The cursor stays on its node while others start and end. `/subagent` still prints the
numbered list that `stop <number>` reads.

### Watching a subagent or task

⏎ on a row under the line, or on a live row of `/agents`, shows what that node is doing: its
conversation takes the list's place, folded the way the chat folds its own. The frame title
names the path (`ƒ Flow Assist · fix-tests › read-logs`); the line, the plan, the queue and
the rows are not drawn. The hint row says what the node is doing, as its row did (`⚙ <latest
step>`, `⏸ waiting for a y/n`, `○ queued`), and on the right `x stop · Esc back`.

PgUp/PgDn and the wheel scroll the rows, which follow their end while they rest there; End
jumps to it, and the details key opens or folds everything in them. Esc steps back to your
conversation, where you left it, and does not stop the node; from a watch that began in the
rows it puts the cursor on that node's row, unless a y/n waits somewhere in the tree: then the
cursor stays in the field and that block is shown at once. `x` asks `stop <name> and 2 below it? y yes · n
no` in the hint row and `y` stops the node and what it started; `n` or Esc drops the
question. The sessions key opens the picker. Ctrl+C never stops your conversation's turn from here: it
arms the exit, and a second one exits. Every other key, ⇧⇥ included, is swallowed: nothing is
typed, sent or queued, which holds for a resting subagent too; write to it with `/subagent
tell`. A node that ends stays on screen as it was, the hint row reading `ended:
done` (or `failed`, `stopped`, `limit`, `empty`), until Esc; a node you stopped reads `ended:
stopped` even if it had not begun; its result is in your conversation as always.

**A y/n of the watched node, or of one it started, is answered there.** It is drawn at the
bottom as the same block (`⚠ fix-tests › read-logs · Confirm write: run_command`, `y yes · n
no`) and answered by `y` or `n` alone, after the pause of a subagent's block (600 ms after it
appears and after your last key). ⏎ and Esc never answer it; Esc steps back, and the request
waits in your conversation, where its block is shown at once and armed afresh. While a block is up `x` is not offered, and a stop
question that was open is dropped, so a `y` always means one thing. The oldest request of the tree, when it belongs to a
node elsewhere, is one line, `⏸ <name> waits for a y/n — Esc to answer`, and no key
answers it there. Where the block would not fit the docked chat, a line says there is no room
and `/subagent stop <name>` declines it.

Your own conversation's y/n or question, the settings file's y/n included, ends the watch. The y/n waits the same pause before
a `y` counts; a question that arrives while the cursor is in the rows, or that ends a watch,
takes no key for 600 ms, so a ⏎ on its way to the rows does not pick an option. With neither
on screen a question takes keys at once.

## Agent files

An agent file is a named subagent written down in a Markdown file: a prompt you reuse, with
the parameters it takes and what it may do. `/subagent @<name> <arguments>` starts it, and the
assistant can start one by name too. It runs as any subagent you start does (see Subagents
you start), with the limits its file and your settings give it.

### Where the files are

- **The project's**: `.flow-assist/agents/*.md` in the project, the git repository holding the
  shell's directory (the directory itself when there is none). They are read only inside
  `shell.roots`, by real path, as the project instructions are: with no roots set none is read
  (`/subagent @` says so), and a file that is a link out of the roots is reported as an error
  and not read.
- **Your own**: `~/.config/flow-assist/agents/*.md`.
- **A plugin's**: the files its manifest lists under `agents`, named `<plugin>/<name>`; only
  an enabled, trusted plugin's are found (docs/plugins.md, "Agents").

A file is read each time it is needed, so a change takes effect at the next start. The name
is the file's name without `.md`: letters, digits and `-`. `@<name>` takes the name as written
or, for a plugin's agent, its short name when exactly one plugin agent has it. A project agent and one
of your own with the same name: the project's is offered, and `/subagent @` marks yours as
shadowed. A file larger than 32 KiB, or with any error, is not an agent. `/subagent @` lists
what each error is, as `path:line: message`, and starting a file that has errors says so.

### The file

A header between two `---` lines, then the prompt:

```markdown
---
description: Review a branch against the project's rules
params: ticket, branch?
tools: repo
auto: reads
---
Review the changes for {{ticket}} on branch {{branch}} (the current branch when empty).
Read the diff, then answer with the findings, worst first. In a code block, braces such as
{x} are left alone.
```

- `description` is required, one line, and is what the listing and Tab completion show.
- `params` names the values the prompt takes, separated by commas; a trailing `?` makes one
  optional, and the optional ones come after the required ones.
- `tools` narrows the tool groups the agent may use (see What it may do).
- `auto` is `ask`, `reads` or `all`; without it the agent asks.
- The prompt spells each parameter as `{{name}}`. A `{{name}}` that `params` does not declare is
  an error, and so is a declared parameter the prompt never uses. A value left out of an
  optional parameter is the empty text. Single braces are left alone.
- An unknown or repeated key is an error.

### Arguments

After the name, values go in the order `params` lists them. The last parameter takes the rest
of the line whole; an earlier one takes one word, or `"several words"` in double quotes. A value
can also be written `name=value` (`name="several words"`), before the positional ones. A
required parameter with no value is asked for, one block at a time in the place of the field
(`@<name>: <param>`); Esc, an empty answer or a dismissed question starts nothing and puts
the line back in the field. An unknown parameter, one given twice and too many values are
refused with a line that keeps what you typed.

### What it may do

`auto` is what the agent asks for, and `agents.maxAuto` (`ask`, `reads` or `all`; `reads`
when unset) is the most you allow: the agent runs in the lower of the two. At `reads` a file
that says `auto: all` runs in `reads`. `config set agents.maxAuto all` lets such a file
run without asking; the assistant can never set it. A command still asks unless `shell.autoRun` is on, as for any
subagent you start (docs/safety.md, "Asking less").

`tools` narrows the groups of tools: the agent gets the `core` group and the groups the
file lists, and nothing else (without `tools` every group is available). It does not make the agent read-only: the `core` group stays
whole, with `memory` and `config_set`, which asks as ever; and a group the file lists keeps
its writing tools, each write asking you as for any subagent you start. A group named in the file that is not loaded is left out, and
a note says so at the start. A subagent or task the agent starts has the same groups, or fewer.

### Trust

An agent file is somebody else's instructions, so what you have not started does not run on
the assistant's word.

- A **project file** asks at its first start, and again after its content changes: a y/n shows
  the file's path, its description, the tool groups, the auto mode after the cap and the
  parameters. `y` starts the agent and remembers this content; `n` starts nothing.
- **Your own file** is recorded at your start and asks nothing.
- A **plugin's file** follows the plugin: a plugin that is installed, trusted and enabled
  may start its agents without another question. `plugins install` and the kit's `install.sh`
  trust a plugin, and a plugin linked to a development checkout changes its agents without a
  new trust.

The record is `agents.accepted.json` in the config directory. A start made from a command the
assistant runs records nothing.

### The assistant starts one

The system prompt lists the agents the assistant may start, up to twenty: those of the
project and your own that you have started with their current content, and the plugins'. The
`subagent` tool takes `agent` and `args` (an object of the parameters); its `task` is then
only extra instructions, added after the prompt. The agent runs as a background task
that may write, each write asking you, and its result comes back to the assistant as
any task's does. A call that names an agent you have not started, an unknown parameter or a missing
one is answered with why, and nothing starts. The assistant never asks you to trust a file;
start it once yourself with `/subagent @<name>`.

## Clicks, folds and the pager

**Click what you want to read.** Everything the chat folds — a turn's tool calls, what
it said between them, a command's capped output — opens where you click it: on its fold line to
open it, anywhere inside it to close it again. A block opens at its first row, so a
long one starts where it starts; a drag is still a selection and never folds anything.
A fold line is underlined while the pointer is over it, and so is a row of the session
picker or of a command's panel like `/mcp`, where a click puts the cursor (⏎ still
opens); nothing else changes under the pointer. `config set ui.hover false` keeps the
mouse and drops the motion reports, for a terminal or a slow link that feels them.
A block taller than the conversation's window — a build's output, a turn of dozens of
calls — opens in a pager instead (what the assistant said between its tool calls always
opens where it is, however long): that block alone in the conversation's place inside the chat's frame, with its own scroll
(PgUp/PgDn, the wheel) and a drag to copy from it; Esc brings the conversation back
where you left it, the block still folded.
`^o` is the same thing for the whole screen: with anything folded it opens everything,
pressed again it closes everything (`config set keys.details <key>` moves it; `^r`
works too).

## How a turn reads, and `/notes`

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

## Long answers

**A long answer stays at its first line.** The conversation follows an answer while it
fits; once its first line would scroll out of view, the conversation stops with that
line at the top, under your question, and the rest comes in below. PgDn or the wheel
reads on, and at the end the conversation follows again. Scrolled somewhere else, you
stay where you are; the next message you send brings you to the end.

**Back to the end in one step.** While the conversation is not at its end, a `↓` sits
in its bottom-right corner — `↓ new` once something has arrived since you left the end.
A click on it, or End, brings you back, and it goes. End is also the field's own key
(the end of the line): while your draft has text after the caret — on a later line
too — End moves the caret; at the very end of the draft, or with nothing typed, it
jumps. `config set keys.toEnd <key>` moves it.

## Where the chat sits: the panel, the window, the whole terminal

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

What a plugin with screens can do — a tracker plugin (it is not part of this
repository), recorded against a mock tracker:

![A tracker plugin: the board, a filter by the person the chat says you are, an issue's card](demo/tracker-board.gif)

![The same plugin in the chat: an epic reviewed, a description fixed and an estimate set behind the y/n, a failed pipeline explained and retried](demo/tracker-chat.gif)

## Images

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

## Bulky content

Bulky things — an image, a `!command`'s output, a large tool result — are sent to the
model in full in the turn they arrive in, and later as a one-line stub naming an id
(`[! brew update — exit 0 · 24s · 120 lines — recall("out:7d41e0aa")]`) that the
assistant reads again with its `recall` tool when it needs the content; the screen and
the session keep everything. Stubbing happens in batches, once the context passes half
the window (`ai.recall.threshold`) or every ten turns (`ai.recall.everyTurns`), so the
provider's prompt cache is missed rarely; `/context` says how many items are stubbed.
`config set ai.recall.enabled false` sends everything in full every time.

## Compaction

`/compact` folds the conversation the assistant sees into a handoff — the goal, what is
done (commits, paths, commands that worked), what is in progress and its next step, the
open decisions, the facts learned — and a `── compacted ──` row marks the place; the
screen keeps everything, and the summary opens under the row. The chat does it by
itself before a request would pass 80% of the window (`ai.autoCompact.threshold`,
0.5–0.95 of `ai.contextWindow`), between two requests so no tool call is parted from
its result, and marks the row `auto`; `config set ai.autoCompact.enabled false` leaves
it to `/compact`.

## Limits of a turn

Two limits bound one turn, and whichever is reached first ends it: `ai.maxRounds`,
the requests a turn may make (150 by default; 0 is no cap), and `ai.maxTurnTokens`,
the tokens its requests spend together (2,000,000 by default — each prompt without the
part read from the provider's cache, plus the answer; 0 is no budget). A background
task runs 12 rounds. The chat then says where the turn stopped — `stopped after 150
rounds (ai.maxRounds) — ⏎ continue · last: <the last call>`, or `stopped after 2.0M
tokens (ai.maxTurnTokens) — …` — and Enter on the empty field, whose hint then reads
`⏎ continue`, sends "continue", so the assistant carries on where it stopped. Both
limits are yours to set; the assistant cannot change them.

## When a request to the model fails

A request that fails for a reason that passes is made again: a 429, 500, 502, 503, 504
or 529 (the provider is limiting, busy or failing), the same arriving as an error event in
the middle of an Anthropic stream, or a connection that could not be made or was lost
before the answer began. While a chat turn waits
its status line reads `LLM 429 · retry 2/10 in 3 s` and counts down each second, and the
log gets a line for each try; a subagent's or a task's wait, and a compaction's, is the log
line alone. A model request a plugin or a tool makes itself is repeated the same way,
without showing the wait. Esc ends the wait and stops the turn. A one-shot prompt says
each repeat on stderr, one line each.

A request is made again only while nothing of its answer has been shown. One that fails
after its first word fails as it is, so an answer is never shown twice and a tool call
never runs twice. Anything else a provider refuses (a bad token, a missing model, a
request too large) fails at once. A request that is still failing after the last try
fails with the provider's words and the count, `… — gave up after 10 retries`.

`ai.retries` is how many times a request is made again (10 by default; 0 makes one
request and no more). `ai.retryDelay` is the seconds before each (3 by default); a
provider's `Retry-After`, in seconds or as a date in the future, is waited instead, up to a
minute; `ai.retryDelay` is at most 60.
`config set ai.retries 0` turns it off; both are yours to set.

## Shell commands

### Your own: `!command`

`!command` in the chat runs a shell command yourself (`!bun test src/features`): it is
one folded line while it runs (`bun test src/features · 3s`) and stays folded, its tail
settled, once it ends (`· ✓ 4s`); the output lands in the conversation and the
assistant sees it with your next message, without spending a turn on it. Esc stops it.
Commands start where you started flow-assist, when that lies inside a configured root
(`config set shell.roots '["~/src/app"]'`); otherwise the first root, with a note
saying so. The directory is remembered between them, as in a terminal (`!cd pkg`;
only within the roots; variables are not kept; `/clear` and `/new` go back to that
same starting directory). A background task starts where its parent conversation's
directory is, not at that default.

### The assistant's: `run_command`

The assistant can run commands too — `run_command`, in the same directory and
drawn the same live way, and only after you confirm each one (`ai.disabledTools:
["shell"]` turns it off); several in a row fold under one head, `Ran N commands`, that
opens into each command's own block. A folded command that printed more than that
says how much it holds (`· 40 lines`, or `· last 200 of 300 lines` when only the tail
was kept). A click on a command's line opens its last
`runOutputLines` lines (`plugins.assistant.runOutputLines`), or the whole of it in the
pager when it is taller than the conversation's window; `^o` opens it, and everything
else folded, in full. Limits:
`shell.timeoutMs` (120 s) and `shell.maxChars` (20000; the end of the output is kept).
A command the assistant runs may read an earlier tool result on its stdin — the text
exactly as the tool returned it, never cut — so it can count, search or save data it
already has without typing it out again; the confirmation says where the stdin comes
from (`stdin: result of search (call_3)`).

### Moving the directory: `cd` and `/cd`

The assistant moves the directory itself with its `cd` tool — "go to the project" —
without a y/n, since it runs nothing, and only inside `shell.roots` (with no roots set
it cannot move at all). You can move it the same way with `/cd <dir>` — like `!cd`, so
with no roots set it goes anywhere; Tab completes to directories only, inside the roots.
`/cd` alone goes back to the starting directory, `/cd -` to the one before the last move.

## Project instructions

Wherever the directory is — at the start, after `!cd`, `cd` or a command's own `cd` —
the assistant is given the project's own rules: every `AGENTS.md` from that directory
up to the `shell.roots` entry holding it, outermost first and the nearest last, so the
nearer file wins where two disagree. They go into its instructions as a section of
their own, each file under its path, read again whenever the directory moves; a line
in the chat says which files were picked up (`Project instructions: ~/src/app/
AGENTS.md`). A file over 32 KiB is cut at a line, with a note saying how many lines
were left out; there is no cap on the whole, so five nested files cost up to five
times that. The files are quoted as the repository's words: they never override your
requests. Nothing outside `shell.roots` is read — with no roots set, nothing is. A
background task and a one-shot `flow-assist "<prompt>"` read them the same way for
their own directory.

## Programs that need the terminal: `!!command`

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

## MCP servers: `/mcp`

`/mcp` in the chat lists the MCP servers the `mcp` plugin reaches — each one's name,
transport, state and how many of its tools run without asking — and from there a
server is disabled, enabled, restarted or its tools listed. The plugin's own page,
`plugins-available/mcp/README.md`, has the whole command set and its settings.

The screen does not wait for the servers. While they connect, the start screen says so
under the plugins — `starting: mcp…`, and the same for a plugin in another language
while its process starts — and each one's tools join as it answers: a message already
on its way gets them from its next step. The line goes once everything has joined or
failed; what failed is in the log (`L`).

## Asking for a plugin's screen

"Open the tutor", "show me board FRONT": the assistant knows each plugin's screens and
the key that opens them, and opens one for you — the entry screen with `ui_open`, a
board or an issue with the plugin's own tools when it has them. Opening a screen asks no
y/n. While you type in the chat or on the `:` line, or a question waits for your answer,
it waits for the end of the assistant's turn and then opens, your draft kept in the field
(a turn you stop opens nothing); the answer says it waits. A session you left while it
works (`/new`, `/resume`) opens nothing over the one you are in — the assistant there is
told you are away — and a screen it had waiting when you left is dropped. A plugin's own field is not
watched: a screen may open while you type there. In the panel the screen is beside the chat; in a
window, or with the chat over the whole terminal, it is behind the chat until you close
it. Esc closes it as ever. The assistant never opens `:plugins`, `/mcp`, the sessions or
the settings for you — those stay yours — and never a plugin you have not trusted or
have disabled. A plugin in another language is opened at its entry, as its key opens
it.

## Plugins: `:plugins`

`:plugins` on the `:` command line lists the plugins — each one's version, its state and
what it brings (its tool groups, its tools, its keys). The state is `active`,
`starting…` (a plugin in another language while its process starts, `mcp` while it
connects), `skipped: <why>`, `missing settings: <VAR>`, `not trusted` (with where its
link led and where it leads now, when that changed) or `disabled`. It works with the chat
closed, and without the chat at all — the place to look when a plugin is broken.
`/plugins` in the chat opens the same list in the chat's frame. The keys:

- **⏎** — its details: what it is, the host API and flowtty range it declares, why it
  was skipped (whole), and its settings under `plugins.<name>`, a secret-looking one
  masked and each environment variable it needs marked set or `required — unset`.
- **r** — restart a plugin in another language: its process is stopped and started
  again, and it rejoins as it does at a start. A plugin that runs inside the app is
  reloaded by restarting the app.
- **d** — disable or enable. Disabled, its tools are out of the assistant's next step (a
  step already running is told the tool is gone), and its screens and keys stay until
  you restart the app — the row says `disabled (restart to unload)`. Its link waits in
  `plugins-enabled/.disabled/`: it stays installed, `plugins ls` says `disabled`, and its
  trust is forgotten. Enabled again, it is `not trusted` until you press `y`, which
  trusts it at once while its link leads where it did; then it loads (or, still loaded,
  gets its tools back).
- **t** — its tools, the ones that ask before they run marked.
- **y** — trust it, as `flow-assist plugins trust <name>` would, and it loads. A plugin
  trusted for the first time shows where its link leads, one whose link now leads
  elsewhere shows both places, and each waits for a second `y`. Enabling a plugin never
  trusts it. A plugin restarted or enabled whose link a command moved meanwhile is not
  loaded, and its row says where it led and where it leads.

While the chat waits for your answer to a question or a y/n, the list's own keys do
nothing — a `y` meant for the chat never trusts a plugin; `^]` takes you to the chat and
closes the list. Installing, removing and updating stay `flow-assist plugins
install|remove|update` (and the assistant's tools); the list shows what they did the
next time you open it.

## When the app feels slow: `:perf`

`:perf` on the `:` command line says how long the app took to answer your input, over
the last 200 frames of each kind: typing, the mouse wheel, any other key or click, and
the redraws nobody typed for (an answer streaming in). The toast gives the p95 of each;
the log (`L`) gets the whole report — the median, the p95 and the slowest wait from the
key to the screen, the time the frame itself took, and how much of the screen was laid
out again. A frame slower than 50 ms leaves a `[perf] slow frame` line in the log as it
happens — at most one a second, counting the slow frames in between — so a lag you felt
a minute ago can still be found there.
