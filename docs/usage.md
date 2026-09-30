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
`this chat · working` while an answer or a command runs, `in use elsewhere` when another
flow-assist process has it open, `done` when its last answer came while you were not
looking; Tab shows every session, grouped under each project's path. Type to filter by
the title or by any word of the conversation; ⏎ opens one (the session you are in is
saved first), Ctrl+N starts a new one, Ctrl+R renames, Ctrl+P moves it into the current
project (its file and journal with it), Ctrl+X deletes after a y/n.
A session open in another process can be neither opened, renamed, moved nor deleted
from here, and your own open session refuses a move too — switch away from it first.

### Naming, `/new`, `/clear` and `/resume`

A session is named by the first line you wrote; `/title <text>` renames it. `/new`
starts a fresh session and keeps the current one as it is — a restart before you say
anything continues it; while an answer is still coming it says to stop it (Esc) first.
`/clear` also starts a fresh session, but it stops an answer that is still coming and
marks the old session closed, so a restart starts empty. `/resume` lists the current
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
What a
restart restores is bounded — the last 400 messages of the
conversation, fewer of the commands' output blocks — but each session also keeps a
journal beside it, `<id>.log.jsonl`: everything as it happened — every tool call with
its whole arguments and result and the y/n you gave it, a background task's calls under
its name, every `!command` with its whole output (up to 8 MiB), every `/compact` summary
— written line by line so a crash loses nothing, and never trimmed. It lives exactly as
long as its session and goes when the session is deleted; `sessions.journalDays` (0 by
default) removes one not written to for that many days, and the session then says so in
a note. `/export [path]` turns the journal into a markdown document you can read — the
conversation, each tool call folded with its arguments and result, the `/compact`
summaries where they happened — written to the path you give, or to `session-<id>.md` in
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
your next message.

A task works on its own: it cannot ask you anything, whatever would wait for your y/n (a
command, a file change, a fetch off the allowlist) is declined, and Esc in the chat does
not stop it. It gets twelve rounds; one that runs out of them
says so at the end of its result (`stopped after 12 rounds — last: …`). A task may start
one follow-up task of its own; `ai.subagentDepth` (2 by default) is how deep such a chain
may go. At most three run at once (`sessions.maxRunning`, above); the rest wait their turn.

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
(a turn you stop opens nothing); the answer says it waits. A plugin's own field is not
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
