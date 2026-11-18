# Followups

Ideas the host defers until a real need appears. Each entry says what the gap is,
when it was hit, and what to do on the way back in. Nothing here is planned work:
an entry is written so that whoever returns to it does not have to rediscover the
shape of the problem.

---

## Compaction on a role of its own (2026-11)

### The summary request sends the whole history, so a smaller window cannot compact a larger conversation

`/compact` and the automatic compaction run on the conversation's own model
(`foldIntoHandoff` — `withModel(llmOpts(ai), c.model)` in
`src/assistant/conversation-turn.ts`): the request that writes the handoff carries the
WHOLE history the model saw, so a child on a role with a smaller window than its
conversation grew into cannot be asked to compact it — the provider refuses the request
before any summary is written, and the only answer is to start the work on a role with a
window big enough to hold it all.

**Hit when:** writing the models-by-role work (2026-11-15) — the summary request sends the
whole history, so it takes the window of the conversation it compacts.

**Action:** keep a `keep` tail verbatim beside the summary (opencode's `compaction.keep`:
the last messages carried into the new history as they are, taking no part in the summary
request), then the compaction model may be a role of its own — a small, cheap one writing
the summary — with a check that the kept tail fits that model's window
(`ai.models.<id>.contextWindow`).

---

## Driving the host from outside the TUI (2026-11)

### No way to reach a session the TUI does not draw

`flow-assist` keeps a session's turn, its subagents and its background shell jobs alive
after the chat is left — `/new`, the session picker, a collapsed chat: the session goes
headless, keeps its lock, and goes on working. Nothing outside the TUI can then stop it,
or answer it: every lever (`Esc`, `/subagent stop`, `x`/`y` in the tree, `shell_kill`)
lives in the chat's key path, and the menu-bar watcher is read-only by design. The only
external lever is killing the process, which stops every session at once.

The pieces a control surface needs are already in the host: the plugin protocol is
JSON-RPC over a unix socket under `hostStateDir()`, taken with a `<name>.lock` holding a
pid (`src/remote/sockets.ts`), with pid-based staleness; and the state file the watcher
reads (`<id>.state.json`, contract v1, `src/assistant/state-file.ts`) already says what
runs and what waits.

**Hit when:** a hypothetical raised while installing the menu-bar watcher
(2026-11-15) — nothing had needed it yet.

**Action:** revisit when someone really needs it. Two shapes, far apart in cost: a
control socket on the running host plus `flow-assist status` and `flow-assist stop
[--session|--job|--all]` — small, since the keys and the socket can share one
dispatcher; or a full daemon with an attachable client — large, because a screen's
state lives in the React tree today, so the host would have to be split into a brain
process and a thin view. Take the socket if the need is stopping work and answering a
y/n from the menu bar.

---

## The lead-in of a child's question (2026-11)

### A subagent's question shows its block but not what led to it

The chat-ux batch (2026-11-17) makes the narration that leads into a pending question
read at full ink and gives an answered question a ground of its own — for the
**session's own** `ask_user` questions only. A child's `ask_parent` question keeps its
block-and-answer flow: its narration lives in the watch view and stays folded and dim
there, so the same "why is it asking?" gap remains beside a waiting subagent.

**Hit when:** scoping the chat-ux batch — the person chose to cover their own
questions first, since the child's question already surfaces and its answer returns
to the child.

**Action:** when the watch view draws a waiting child question, lift the dim/fold on
the child's narration run before it exactly as `askPending` does in the chat's row
building; a child question that was already answered can carry the same ground the
session's answered rows carry. Small, and it rides the same display-flag seam.
