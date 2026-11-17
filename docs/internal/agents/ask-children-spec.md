# Children, subagents, asks — spec

> Extracted VERBATIM from AGENTS.md as of master before the
> `chore/agents-md-slim` rewrite. This file is the behavior spec for the area
> it covers: where the trimmed AGENTS.md core and this file ever disagree, the
> core rules win — but treat any difference as a defect in one of the two and
> report it. Covers: the subagent y/n block, the agent tree, watching a child,
>
> Cross-file references inside the moved text ("(models)", "(below)") follow
> the OLD single-file layout; use DISPOSITION.md to find where a section
> lives now.
> conversation kinds and child start, agent files and skills, allow-lists,
> and the two queues and the inbox.

- **A subagent's y/n (subagent y/n)** is the OLDEST request parked anywhere below the
  conversation on screen (`Conversation.offered()`: own first, with an empty `path`; else
  the oldest, `path` the labels from the child the conversation started down to the
  owner; an `Offered` has a `kind`, `confirm` for a y/n or `ask` for a question a subagent the person started put to the person, ordered together by when each was parked), drawn by the chat only while its OWN list is what the chat shows — no picker,
  command panel, pager or `/context`, and no y/n or question of its own. Those stay open;
  the request is drawn after they close and never closes them (an own y/n still closes the
  pager and `/context`). The view binds the `asking` event every child's `confirm` raises on
  its ancestors, and redraws. With an EMPTY field (no text, bang level 0) the block stands
  in the field's place: title `⚠ <path> · Confirm write: <tool>` cut to one line
  (`ConfirmAsk.path`), hint `y yes · n no`. With a draft in the field one line above it says
  `⏸ <path> waits for a y/n — clear the line to answer` (`renderChatModal`'s `askNotice`);
  that line is a row of the field's place, counted by `besides`/`planFit` and by
  `pendingChatRows`' `notice` (the draft's rows plus one), so neither the plan nor a bottom
  panel's list is squeezed. In shell mode (bang level above 0) the notice says `leave shell
  mode to answer`. A request does not undock a docked chat: it may grow a
  panel, but not past the rows that leave the plugin its least (`PLUGIN_MIN_ROWS`); the
  session's plan gives way first (`needRows` counts it only when the block fits beside
  it), and a block that needs more even with no plan is replaced by the notice, `<path>
  waits for a y/n — no room to show it; /subagent stop <label> declines it` (the path is
  cut, not the instruction), which no key answers (`childShape` decides block or
  notice). A chat that is already a window shows the block there. Only `y` and `n`, only on an empty field with the block drawn,
  answer it, and only after a pause: `src/assistant/child-ask-guard.ts` — an answer counts
  600 ms after the request first came on screen with the keyboard in the chat (a request
  seen anew after a gap with none shown, or a different one, arms from then) and 600 ms
  after the person's last key of any kind: every key the chat handler gets is noted, and
  so is every key the App takes first (`store.chat.noteKey`, from `keyPath.first` when it
  consumes a key). While the chat lacks the keyboard — collapsed, the plugin's side
  focused, the runtime's panel or the `:` line up — the guard is told nothing is shown, so
  the chat regaining the keyboard (the chat key, the collapse key, a click, a closed
  panel) arms afresh. `askClock` is the guard's clock and the seam a test moves instead
  of sleeping. A `y`/`n` that does not count is not
  swallowed: it types its letter, which turns the block into the notice. ⏎ and Esc never
  answer it; every other key goes to its usual handler. The answer is
  `owner.answerConfirm`, the request's owner, never the attached conversation. An own
  y/n keeps its keys (y / ⏎ yes, n / Esc no, every other key swallowed) and is offered
  first. It answers at once, except when it takes the place of a subagent's block that
  is on screen: then, for 600 ms from that moment, every key is swallowed and none
  answers it. `needRows` and the collapsed chat's `? waiting for you` read the same
  `offered()` as the drawing; the other `conv.confirm` readers (the picker, panel and pager
  guards, `store.chat.asking`, `inboxHeld`) mean the conversation's own. While a child is
  watched its requests are drawn and answered in the watch instead
  (AGENTS.md (watching a child)); the session's list shows none.
  **A question from a subagent the person started** is the same request with another kind. With an empty field
  (bang level 0) it is drawn in the field's place as `ask_user`'s free-text block (`renderAsk`, `askBlockRows`)
  titled `from «<label>»`, hint `⏎ submit · Esc dismiss` (the field is open from the start, so every printable key, digits and spaces included, is text); with a draft one line says `⏸ a question from
  «<label>» waits — clear the field to answer it` (`leave shell mode to answer it` in shell mode), the draft untouched;
  where the block has no room the notice reads `a question from «<label>» waits — no room to show it; /subagent stop <label> declines it`. The session's own y/n and its own
  question come first, then the oldest child request of either kind; an own request that takes the place of a drawn
  child's block, y/n or question, is armed for 600 ms as above, and a child's typed answer owes the pause again after
  its block was away. The first key of the answer counts after the guard's pause (an earlier key is the field's, as a
  `y` is); once one counted, the rest is typed without it. Every key then goes to the question's state machine
  (`askKey`), ⏎ answers it and Esc, even after text was typed, settles it with the no-answer text; the answer goes to the owner's
  `stepParentAsk`, never to the session's model. In a watch of the asking node (or above it) the block is
  `WatchView.question`, drawn with no field and so with no empty-field rule, and every other key is swallowed. The
  waiting badge, the left-session toast (`a question from «<label>»`) and the picker's status
  (`subtreeWaiting`) count only questions waiting for the person, not one waiting for a model.
  **A question waits out the person's sentence** (`ASK_GRACE_MS`, 600 ms, the same
  `askClock`): a question that parks — the session's own `ask_user` or a child's routed to
  the person — takes the keyboard only once the last key the chat took is older than the
  grace, and never while the `:` line is open, since a half-written command is a long
  thought. While the grace holds it the field keeps every key and each such key re-arms the
  grace (the key that sends a message clears it: the sentence went), the block is not drawn
  in the field's place, and the strip above the field — or, with the chat collapsed, its
  status — says `? a question is waiting`; a one-shot unref'd timer re-runs the claim when
  the person goes quiet. A key a block, a picker, a panel or a reader (the pager, a watch)
  takes is no typing and re-arms nothing. Past the grace the claim runs unchanged — the
  arms above still hold — and a y/n gains no grace: its own `ASK_ARM_MS` pause stands.
- **The question wizard (`ask_user`, `src/assistant/ask.ts`).** The model's call carries 1–4
  questions of 2–4 options, each optionally `multiSelect`; the block always offers `Other…`
  for the person's own words, so the model never spends an option on it. `AskState` holds
  one page per question (`index`), one `AskDraft` per question (`cursor`, `picked`, `typing`,
  `text`, `caret`) and the answers the call has written so far. A single question keeps its
  own keys: on a single-select a digit answers the option it names at once and ⏎ answers
  the row under the cursor (or opens `Other…`); in a multi-select a digit toggles the
  option it names and Space toggles the option row under the cursor, and ⏎ commits the
  picks. Any other printable key starts the answer with itself in the field. More than
  one question is a WIZARD: the page after the last is the submit page, and only that
  page's ⏎ answers the call — a page's ⏎ on an option commits its draft and moves on, a
  digit does the same on a single-select, and in a multi-select a digit or Space toggles
  an option row and ⏎ commits the picks; ←/→ walk the pages (clamped at both ends;
  inside the open field they are the caret's). A draft survives every move, so going
  back, changing a pick, editing the words or leaving a page empty costs nothing; a
  page's words erased before the call goes read as the empty page they left, never as
  words the person took back. **Submit is the answer**: the submit page lists every
  question with the answer its ⏎ will send (`(not answered)` for a draft that holds
  nothing), and its ⏎ rebuilds `answers` for every question in order — an empty one sent
  as `- <question> → no answer given` — resolves the tool once, and writes the kept
  `? / →` rows and journal rows, one per question. Esc leaves the answer field first (a
  free-text question has no list, so there Esc dismisses at once); Esc on the list — or
  on the submit page — dismisses the whole call: a dismissal is not consent — the model
  reads `The user dismissed the question without answering` and that it must not assume
  an answer. What a page COMMITTED and its draft still holds is kept as that question's
  answer; every other question reads `dismissed`. A child's question (`ask_parent`) is a
  free-text block and takes none of this: its field is open from the start and Esc
  settles it.
- **The agent tree (agent tree)** is a conversation's live subagents and tasks, drawn as
  rows under its field and listed by `/agents`. The data is `Conversation.tree()`: the live
  descendants depth first in start order, each a `TreeNode` (`key` — the descendant's
  conversation key, `label`, `kind`, `depth` from 1, `status` working / waiting / asks / queued /
  delayed / idle, `answered` — an idle node whose latest answer nobody has read, `latest` — the tool label while one runs, else the round's verb, `below` — its live
  descendants, `model` — the model it runs, when it has one); `nodeByKey` returns the
  live descendant of a key. One rule, `childState`,
  gives a child's status to `runningChildren()` and to `tree()`: `waiting` while a y/n is parked, `asks` while its `ask_parent` question waits (a child holds one of the two at a time), else `working`. Ended children are not
  nodes: their result is a row of the conversation and `endedChildren` keeps the last
  twenty. A change reaches the chat as the `tree` event, raised on the conversation where it
  happened and on every ancestor read at the event (a child may have moved), then the root's
  `deps.notify()` once: a child that starts, ends, is stopped or handed up, flips busy,
  parks or has answered a y/n, asks a question or has it settled, or ends its delay. A change of the latest step is held: the
  first goes at once, the conversations that changed in the rest of a 200 ms window are
  remembered, each once, and at its end each of them and its ancestors hear `tree` once and
  the root's `notify` runs once, so a child running tool after tool does not redraw the
  chat at the tool's pace. A closed root says nothing.
  The rows are `src/assistant/agent-tree.ts`: `treeRows` makes one terminal line per node
  (`<mark> <label> · <state>`, two cells of indent per level, no clock; an idle node is
  `◦ <label> · idle`, or `· answered` while a later answer is unread; a node with a question open reads `? <label> · asks its parent`), keeps at most
  `ui.agentRows` (4, 0 to 8) and, over that, the waiting and asking nodes first, then the working, then the answered
  idle ones, then the rest, each in tree order, with a last row `+K more — /agents` that is not a stop of the
  cursor; `treeCursor` keeps the cursor on its node, else the nearest stop, else nowhere.
  **One budget serves the draw and the keys.** `chatRoom` measures the column (what the error,
  hint row, queue line and field's place take, the plan block, and whether a question, a y/n,
  `/context`, the pager, a picker or a panel hides the tree); `treeBudget` gives `min(rows,
  nodes)` reduced so the conversation keeps four rows with the whole plan block counted, and
  keeps one row for the gap above. So the tree gives way first, down to none; then the plan;
  never the field, the hint row or a y/n. The block is the gap and the rows, nothing else: the
  stop question takes the place of the cursor row's text and the keys are named in the hint
  row's left cell. The plugin asks `treeNow` for the rows, in the render and in the key
  handler alike: the geometry (`chatRoom`, the budget) is the last render's, the nodes are
  read from `Conversation.tree()` at the key, so a node that changed between the two can
  reorder the stops under the key (the question names the node the cursor is on, so no wrong
  node is stopped).
  **The cursor** (`treeSel`: the node's key and whether its stop question is up) enters with
  ↓ on an empty field, with no history entry shown before the key (the ↓ that ends a history
  walk does not also enter) and bang level 0, when a row is drawn. With it in the rows the
  chat handler gives every key to one branch, after a question, `/context` and an own y/n and
  before everything else: ↑ / ↓ move, ↑ on the first row and Esc leave, `x` asks, `y` calls
  `stopSubtree` on the node (the stop `/subagent stop` makes, journaled as the person's),
  `n` / Esc drop the question (Esc with a question up drops only the question; the next Esc
  leaves the rows), the sessions key clears the cursor and the question and opens the picker,
  ⏎ on a row starts watching it (AGENTS.md (watching a child)), anything else is swallowed. Ctrl+C, the wheel and PgUp/PgDn are heard above this handler.
  Esc there is never the turn's stop, the field's clear or the exit arm. **A request is not
  answerable from the rows:**
  `childAskNow` is null while the cursor is in them, so a waiting subagent shows as the
  notice line `⏸ <path> waits for a y/n — Esc to answer`, the guard is told nothing is shown
  (Esc then arms the block afresh), and every key is noted. The cursor and its question are
  cleared in the render whenever the rows are not drawn (the cursor's node gone with no
  other row, a hidden state, the chat folded away or without the keyboard) and when the
  conversation on screen changes (`adopt`). `/agents` is a command panel (`follow: true`, so
  its cursor stays on its row id as rows start and end) whose rows are
  `agentsPanelRows`: live nodes with the time spent and the model a node runs when it is
  not the conversation's own (`chatModel`; a conversation with no model names them all),
  then the ended ones; `x` asks in place
  of the row and `y` stops, as in the rows; ⏎ on a live row closes the panel and starts watching it, on an ended row it says there is nothing to watch. A subagent's
  block is never drawn under it (the panel hides it), so a subagent's request is not
  answerable there. The conversation's own request that arrives while the cursor is in the
  rows or a panel is drawn is armed like one that takes a block's place (`ownArmedAt`): the
  `y` already on its way to the stop question waits out the 600 ms pause. Its own QUESTION
  that arrives over the cursor is armed the same way (`questionArmedAt`): every key is
  swallowed for 600 ms from its appearing, so a ⏎ on its way to the rows picks no option.
- **Watching a child (watching a child)** shows a live node's conversation in the list's
  place while the chat's conversation stays the session. ⏎ on a tree row (`startWatch`) or on a
  live row of `/agents` starts it; `Watching` (`watchRef`, mirrored in state) holds the node,
  its `path` (labels from the session's child down, `watchPath`; read again at every render
  while the node lives, since a task that ends hands its children up, and kept as stored
  once it has ended), `ended`, `final` and the tree row to return to.
  **What stays the session's, and why.** `messages`, `streaming`, `drawnRef`,
  `store.chat`, the port, `postHome`, `/export`, `/title` and `/copy` read the session,
  watched or not: the watch has its own names (`watched`, `watchSnap`, `watchFolds`). The
  registry treats a conversation the chat does not show as a left session (its turn headless,
  a toast when it finishes or waits, its turn counted in `N in background`); a watch leaves
  nothing, so none of that applies.
  `showsEnd` is false while watching, so an answer of the session that lands meanwhile is
  not counted seen until the watch ends: by Esc, or by the session's own y/n or question
  (`endWatchForOwnAsk` marks it, as the pager's close does).
  **Two subscriptions.** The session's `useSyncExternalStore` reads the session alone; a second one
  reads `(watched ?? conv)` for the watched rows. A child's own `deps.notify` is silent
  and nothing of the session changes when a child's row does, so the watch also calls
  `node.subscribe(() => host.notify())` and drops it with the watch.
  **The close order.** `startWatch` subscribes `closed` before anything else; its handler
  reads `getSnapshot()` again and keeps that as `final`, because the last rows may be told
  after the node's listeners are cleared. An ended watch stays (`ended: <verdict>`, `x`
  does nothing) until Esc; a node the person stopped reads `ended: stopped` whether or not it
  had begun (a queued node closes inside `stopSubtree`, so `y` marks the watch before the
  call and the `closed` handler words the end from the mark); opening a chat whose watch has ended opens on the session.
  **A subagent that rests is watched like any other**, read-only: opening the watch on it
  (`startWatch`), and any change of it while the watch is open, marks its latest answer read
  (`seeAnswer`), which is when the row stops saying `answered`. The first answer is never
  marked: it is a row of the session.
  **Folds.** `watchFolds` is the watch's own fold state, everything folded at the start: fold
  ids are indexes into one list, so the session's would open the wrong rows. The details key
  flips it, End jumps to the end (`watchToEndRef`), the list follows its end while it rests
  there.
  **Keys.** One branch, after the pager's and before the question, `/context`, own y/n,
  tree rows, a subagent's y/n, panel and picker: the sessions key ends the watch and opens
  the picker; a request of the node answers (below); Esc steps back (`endWatch(true)`: the
  cursor goes back to the node's row when it is still drawn and no y/n waits anywhere in the
  session's tree, `conv.offered()` being null; with one waiting the cursor stays in the field,
  so that request's block is drawn at once and armed afresh; the session's end is counted
  seen) and does not stop the child; the details key and End act on the watched rows; `x`,
  on a live node, asks `stop <label> and N below it?` in the hint row, `y` calls
  `stopSubtree` on the node, `n` / Esc drop the question; every other key is swallowed, so
  nothing reaches the field, the model or the queue (⇧⇥ does nothing there). Ctrl+C is not
  this branch's but `ctrlKey`'s: while a watch is up it never stops the session's turn, which
  is not what the person is looking at, and goes straight to arming the exit. PgUp/PgDn and
  the wheel belong to the list. The pager is closed on entering and the tree cursor is cleared.
  **What ends a watch:** Esc, the sessions key, the session's own y/n (the settings
  file's included) or parked question, `leave`, `adopt`, `renew` and `resetView`. The own y/n and the own question
  are armed for 600 ms from the moment they end it (`endWatchForOwnAsk`), and the render ends a
  watch that a session's request stands over, never drawing that request inside it. Collapsing the chat keeps the watch.
  **A y/n in the watch.** `Conversation.offeredWithin(node)` is the oldest request owned
  by the node or by one below it, `path` counted from the session (so the title names every
  label, as `offered()` does); `offered()` stays the oldest request of the whole tree. It is drawn as the confirm
  block at the bottom of the watch (`WatchView.request`), counted by `needRows` through
  `pendingChatRows` with no plan and no queue, so a docked chat grows as it does for a
  child's block in the session's view; where that block cannot be given the rows a docked
  panel may have, one line says there is no room and no key answers. `askGuard.show` sees it
  when the chat has the keyboard, and `y` / `n` without ctrl or meta, armed, call the
  owner's `answerConfirm`; ⏎ and Esc never do. The oldest request of the tree, when it is
  outside the watched node, is one line above the hint row,
  `⏸ <path> waits for a y/n — Esc to answer`, and takes no key; a younger one elsewhere is
  not named until the older is answered. A
  node that has ended offers nothing. **One meaning for `y`:** a request in the watch drops
  a stop question that was up (in the render and at the key), and while one is up `x` is
  swallowed and the hint row does not offer `x stop`, so at any moment `y` approves a
  request or stops a node, never either by chance. The guard is told nothing is shown when
  the watch ends (`endWatch`), so the session's view arms the request afresh.
- **A conversation has a kind** — `session` (the chat's), `task` (a background task's),
  `subagent` (a job the person's work runs in beside the chat, read-only unless the person started it) or
  `oneshot` (the one-shot prompt's) — and a policy for its writes (`confirm-policy.ts`),
  both decided when it is made: `Conversation.fresh(deps, { kind, policy })` for a new one, which reads the
  project's instructions for the start directory, `Conversation.restore(…)` for a saved
  session. A policy that asks cannot be given where `deps.canAsk` is false (the
  constructor throws), and neither the settings-file guard nor `ask_user` asks there.
  What a host hands a conversation comes from one factory, `hostDeps`
  (`src/assistant/host-deps.ts`), which reads the host's services when a member is
  called; `canAsk` is always said. What a turn is handed that differs by kind is
  `turnShape` (`conversation-turn.ts`), a table with a row per kind; the `task` row hands the
  worker prompt (plus the project block) as the system prompt, `ai.taskRounds` rounds (12 by default), no screen tail,
  round boundary, recall, `ask_user` or images, and withholds `ask_user` and `answer_child` from its tool list. The `subagent` row
  hands the same worker prompt with the person's prompt framed as `The person's task:`,
  then the memory block and the language directive (read once for the message) and,
  read again every round, the project block and the conversation's own summary — a
  summary handed over at the start (`ChildSpec.summary`) or one an automatic compaction
  made, so a long run keeps its context; no screen tail; the round boundary on (the
  automatic compaction; the queue finds nothing to do in a child, and the settings-file
  guard never runs in a conversation that has a parent); recall on; no `ask_user`, no images; no round cap of its own, so the config's
  `ai.maxRounds` and `ai.maxTurnTokens` apply; `remind` and `ask_user` are withheld from its own turn and from every run a tool starts through `ctx.chatLLM` (a subagent's `chatLLM` adds both to the list, a task's adds `ask_user`). The worker prompt both kinds get says not to wait for the user, to make a reasonable assumption where the task leaves something open and name each assumption in the result, and to ask the conversation that started it ONE question with `ask_parent` (below) only when the work cannot go on without an answer, reading a `no answer` reply as "proceed on the best assumption". The turn shape carries `askParent` and `answerChild`: a task and a subagent are offered `ask_parent`, a session and a subagent are offered `answer_child`; the session withholds `ask_parent`, the task `answer_child`, the one-shot prompt both, and every run a tool starts through `ctx.chatLLM` withholds both (`NESTED_WITHHELD`). A child says nothing
  of a missing memory record and spends no flag of the host's once-only note: nobody
  draws its rows.
- **A conversation runs ONE model (models)** — its own (a session's, set by `/model` and
  kept in its file as `model`, absent when it runs `ai.model`; a child's, resolved from a
  role at its start), else `ai.model`, else the provider's default (`effectiveModel()`),
  and the frame's title names it after the chat's own name
  (`ƒ Flow Assist (big-model) · <subject>`, the bare name while no model is known). The
  requests its turn makes carry it (`withModel(llmOpts(ai), c.model)`, at the turn and at
  `foldIntoHandoff`); a run a tool starts through `ctx.chatLLM` keeps `ai.model`, passing
  its own options to `services.chatLLM`, which merges them last. A child without a role of
  its own inherits its parent's model, materialised at the start
  (`child.model = spec.model ?? this.effectiveModel()`), so a task a subagent starts — and
  a subagent a session with a `/model` choice starts — runs what its parent runs. A
  session's own model outlives the config: `config set ai.model` leaves it where it is,
  and `/model default` is the absence of the field, so the session follows `ai.model`
  again. The window is that model's:
  `Conversation.contextWindow()` —
  `ai.models.<id>.contextWindow` → `ai.contextWindow` → 200000 — is the ONE reader of the
  window, so the meter, the automatic compaction's threshold and the recall threshold all
  measure against it. An id whose own text holds a dot (`big-model.v2`) cannot be a key
  path: every config key is a dot path, so `ai.models.<id>.contextWindow` reads as two
  keys and is refused — the catalogue is set whole (`config set ai.models '{…}'`) or in
  `config.json`. A role nothing defines is not a refusal: one note, `role "<key>" is
  not defined (ai.roles) — using the conversation's model`, and the work starts on the
  conversation's model — a model id given where a role belongs is exactly that case.
- **A conversation starts a child of its own** (`startChild(spec, journalId)`, in
  `src/assistant/conversation.ts`; a turn hands it to its tools as `ctx.startChild`, with
  the host's slots as `ctx.childSlots`): a `task` or `subagent` conversation (`ChildSpec.kind`;
  `parent`, `depth` one more, `label`, `spawnedBy`) with its own plan, shell, tool set and abort, and the policy
  `childPolicy` makes from its writes capability (`ChildSpec.writes`, absent reads as
  `'ask'`): `deny` is `always-no` read-only and never lifts, `allow` runs each write the
  auto mode with `shell.autoRun` answers — not `config_set`, an unlisted `web_fetch` or a
  plugin's `run_command` — and says it in the log, `ask` waits for the person's yes on each
  (the `subagent` tool
  starts a `task` whose `writes` is the named agent's own `writes:` (omitted — `'ask'`) or,
  with no `agent`, the call's own mapping: a worker `'ask'` by default, `writes: 'deny'`
  read-only, a call's `allow` answered as `'ask'` with a note:
  `ai.taskRounds` rounds, the worker
  prompt, its y/n offered to the session like a subagent's — `writes` wins over the
  deprecated `write`, `true` reading as `ask` and `false` as `deny`) — where the host's root can ask at all (`canAsk`; with nobody to ask the
  policy is `always-no` `cannot-ask`) and the starter may vouch: a session, or a child that
  asks itself or runs `allow`. A child that may not vouch cannot start one that may,
  whatever its spec says. A child that is not `deny` also starts in the auto mode of the
  conversation that started it. Its
  deps are its parent's with no sessions directory, no screens, no redraw
  (`notify`) and a silent `pushLog`; `canAsk` is true only for a child whose policy
  asks, and `ask_user` is not in a child's tool list. It keeps no state file. A task has no
  journal either: its `journalRoute` sends its `call-start`, `confirm` and `call` lines — and
  nothing else — to its owner's journal (the nearest ancestor with one: the session, or a
  subagent with a file), tagged `{ task: <label>, ...line }`. A subagent in a session with
  a home keeps a journal file of its own (`subJournalId`; the journal's line list, above):
  its route writes every line of the conversation there, and the lines about the subagent
  itself — `{ t: 'subagent', label, by, event: 'start' | 'answered' | 'end', id, outcome? }` and a task's
  `task-end` — through the route's `about` into the owner's journal, the start when it is
  made, the end when its run settles (a subagent the person started: when it is stopped,
  cleared or the process exits; each answer is an `answered` line). Without a home its lines go to its parent's journal
  as a task's do, tagged `{ subagent: <label>, ...line }`. Its project is its parent's (`inheritedProject`, read
  first by `currentProject`), whatever root its shell moves to — the memory and the
  workspace follow it; its shell starts in its parent's directory, and its `cd` moves
  only its own (and the project instructions its per-round prompt reads). A
  conversation at depth `ai.subagentDepth` (2 by default) cannot start another: it is
  refused at once, the refusal naming the number. `startChild` neither admits, arms nor
  delays: the caller schedules `run()` (once: a second call fails with `already run`),
  which sends the task as background work, answers the end
  (`outcome`, the trimmed text, the error, the round or token limit with its last step),
  closes the child (`park`: its save and inbox timers go; **not a subagent the person
  started, below**) and **delivers its result to
  the nearest conversation above it that takes it** (`resultRecipient`: the first one from
  its parent upward that is open and is a session or a subagent the person started and that
  stays; a task above it is passed over, since it ends after its answer and its inbox goes
  with it; none open: the result goes nowhere) —
  (`childResultText`: `<label> finished:` or `<label> failed:`, then
  `childResultBody`: the text and the limit, or the reason — a looped answer names the
  dropped run beside them), never to whatever the chat
  shows. With no recipient the end carries
  `delivered: ''` and no `landedIn`. Otherwise it carries `delivered` (the text) and
  `landedIn` (the title of the conversation it landed in — a subagent's label — and
  `onScreen`: it landed in a session that is the registry's `shown`, or none is shown; a
  subagent is never on screen), from which the tool's toast reads `⏳ <label>
  done`, or `⏳ <label> done — in «<title>»` (`in an untitled session` for an empty
  title) when it landed elsewhere. The starting conversation counts its children
  (`children`: armed, queued or running; `childTimers`: the delay timer of each one
  still armed, handed over by the caller through `armed(timer)` and dropped by `fired()`
  when it fires) from `startChild` until the result is in, and emits `children` with the
  count at both ends. The result is delivered BEFORE the child is untracked (in a
  `finally`, so a throwing delivery still untracks it), so whoever sees the count fall
  finds it already in. **A task that ends hands its children still live to its own
  parent** (`handChildrenUp`, run only by a child's `close('park')`): they are that
  parent's to count from then on — the session counts a grandchild whose task is over —
  and their results go to the nearest recipient above (the session, or a subagent that
  stays); **the rules about "a child" read `parent`, not the
  kind**: this hand-up, the walk to the recipient (`run`, `resultRecipient`) and to the
  session (`workHome`, where a plugin's work posts), the abort at
  `close('exit')` and `closeAll`'s end line. The result carries `ms` and `tokens` from the child's
  last end. **A subagent the person started stays after its answer** (`staying`, set by
  `startChild` for kind `subagent` with `by: 'person'`; a task, and a subagent the model
  starts, end as above). `run()` is its first turn: the result is delivered to its recipient
  as for any child, the parent's journal gets an `answered` line instead of `end`, and the
  child is not closed or released: it rests (`idle`, `rest()`), a state of the child and not
  of its slot. A slot is held per TURN: a rested child holds none and has no timer, and a
  message (`receive(text)`) that finds it resting starts a turn through the schedule, which
  admits it like any child's (`queued` while no slot is free). The system prompt keeps the
  ORIGINAL task for its whole life (`task`; a compaction rebuilds from it too), and each
  message is an ordinary person turn in its history. The answer to a later turn that read
  only the person's message (`/subagent tell`, or a message with nothing waiting in the
  inbox) is NOT delivered: it stays in the child (`answered` on its node until the watch
  has read it, `seeAnswer`) and an `answered` line is journaled. **A later turn that read a
  child's result delivers its answer upward as the first does** (`again`, with
  `LaterTurn.readResult`: the turn's inbox held a `result` item, alone or landed just ahead
  of the person's message); a stopped child's quiet row does not count as one read, so a
  turn that read only the person's message and a stopped child's row keeps its answer.
  **A subagent has an inbox of its own**: what a child delivers into it never enters a
  running turn and waits for the turn's end. At the end (`afterAnswer`) the person's
  queued message goes first and starts the next turn through the schedule (a slot per
  turn) with the waiting items landed as rows just ahead of it; with no message the inbox
  starts a follow-up turn the same way (`takeInbox`, taken from rest or at a turn's end),
  and a turn with nothing to start rests the child. `ai.backgroundFollowUp: false` and a
  quiet item keep rows only, and so does a turn that did not end in an answer (failed, at a limit, empty). A message while a turn runs is queued
  and taken at the child's next request boundary, or by the next turn when none is left;
  `receive` refuses a task or a model's subagent, a stopped or closed child and an empty
  text, and `runTurn` refuses a closed conversation. The child ends when stopped
  (`stopSubtree` on a resting child is `endIdle`: its `end` line says `stopped` by the
  person, its own file gets its closing `end`, the row goes, `endedChildren` keeps it, and no
  message is delivered; on a working later turn the turn is aborted and the same end is
  written when it settles, with nothing delivered; a stopped first turn delivers
  `stopped:` as for any child), by `/clear` and by the exit. It has no state file
  and does not survive a restart; its journal and `/export` keep it. A resting child
  counts as a live child for the registry's `quiescent`, so its session is kept loaded
  headless, not put away; `hasWorkingChildren` (a child not resting, or a resting one with
  work below it) is what the picker's `working` reads. **Only `close('clear')` and `close('parent')`
  stop the subtree** (`stopChildren`): each child still counted is closed with
  `'parent'` — its turn aborted, one still armed has its timer cleared and its count
  disarmed (a timer that fired was disarmed when it fired, so only `childTimers` is
  disarmed), one queued for a slot sends nothing when its run comes — and a task closed
  so writes its `task-end` line (`by: 'clear'`; a subagent's `subagent` end line with
  `outcome: 'stopped'` and `stoppedBy: 'clear'`) into the session's journal through its
  route's `raw` and delivers nothing (`stoppedWithParent`). When the person's stop closes
  the subtree, the children write `by: 'person'` / `stoppedBy: 'person'` instead. `/new` closes nothing: the
  chat leaves the session through the registry's `retire`, and its tasks run on.
  **`stopSubtree(glyph)` is the person's stop of one child and everything under it**: the
  child's own turn is aborted (`stop`), or — before its run began — it leaves the schedule
  (`leaveSchedule`); every child it started is closed with `'parent'` (they deliver
  nothing); the child itself delivers once, `<label> stopped:` and the text it had
  written (the last answer text of its rows; the steps of its tool-calling rounds are not
  text it said), or `nothing said yet`, to its recipient as any result is.
  A child that ends or is stopped lands what waits in its inbox as rows before it closes
  (its journal and export keep them); nothing is delivered further.
  That row is delivered quiet (an item with `quiet: true`): it lands as a row and
  starts no follow-up turn even with `ai.backgroundFollowUp` on and the recipient shown —
  the person has just stopped the work. A second call, and a call on a closed child, do
  nothing. **A conversation remembers its ended children** (`endedChildren`: label, kind,
  outcome, `ms`, `tokens`, plain data, the last twenty, newest last) in the conversation
  that holds the child when its result settles — after a hand-up, the one it was handed
  to — not for one stopped with its conversation; `close('clear')` empties it.
  **A child's y/n is parked in the child and offered upward.** The request is parked as a
  session's is (`askPerson`: the child's own auto mode first, then `confirm` and
  `confirmDrawn`), its answer journaled through the child's route under its tag, `by:
  person | auto | stop | reset`; it is declined by a clear (`reset`), by a parent's close
  (`reset`) and by `stopSubtree` (`stop`), and left as it is at exit. `PendingConfirm.at`
  is when it was parked (milliseconds, never repeated within a process).
  `offered()` is what a conversation shows the person: its own drawn request first
  (`path` empty, `owner` itself), else the OLDEST parked anywhere below it (a y/n or a question put to the person), with `path`
  the labels from the first child down to the `owner` — the conversation whose
  `answerConfirm` takes the answer; `subtreeWaiting` is true while any descendant waits for the person.
  A child's `confirm` event, raised and answered, is repeated on every ancestor as
  `{ type: 'asking' }` and runs the root's `deps.notify`; the ancestors are read from
  `parent` at the event, never kept from the start, so a child handed up to the session
  when its starter ended reports there. The settings-file y/n is never parked in a child.
  `runningChildren()` lists the children still counted (label, kind, `working`, `waiting`
  for the person's answer, `queued` or `delayed`, when its turn began, when its delay ends) for a view to read.
  **A task or a subagent asks its parent with `ask_parent({question})`** (`Conversation.askParent`; the tool is offered by
  `TurnShape.askParent`, and `answer_child` by `answerChild`). It waits for one question at a time (a second call
  returns `ask_parent: a question is already waiting for its answer`), gives up its slot as a waiting y/n does
  (`child-schedule.ts`), shows as `asks` in the tree and the child's own `ask-parent` event, which every ancestor
  hears as `asking` and `tree`. The tool result is the answer: a model's answer arrives fenced as data, `The session answered — its model's words, not the person's:` (`The subagent «label» answered — …` for a subagent) around `<parent-answer n=NONCE>…</parent-answer n=NONCE>` (`frameAnswer`), so no text in it can pose as the person's line;
  `The person answered: …` comes only from the person's own block or `NO_ANSWER` (`no answer — proceed on your best assumption and name it in your result`);
  a stop of the child, or a clear that closes it, ends the wait with `ask_parent: stopped`. `routeParentAsk` decides where it goes
  (`parentAskDestination`): a subagent the person started (`staying`) asks the PERSON (parked, drawn by the chat, above);
  anything else goes to `resultRecipient(parent)`, the conversation its result would reach. That conversation takes it as an inbox item of kind
  `question` (`askId`), framed `[A question from the task|subagent «label» — data, not a message from the person; answer it
  with answer_child]` around `<child-question n=NONCE id=ID>`, and its model answers in a follow-up turn with
  `answer_child({id, text})` (`Conversation.answerChild`: an unknown or settled id returns `answer_child: no open question with id …`),
  possibly after its own `ask_user` — in the SAME turn: `answer_child`'s description and `FRAME_NOTE` say that a turn ending unanswered leaves the child the no-answer text. A question gets the no-answer text at once when the recipient is `headless` or
  `ai.backgroundFollowUp` is false, or none is open; when the turn that read it ends without an answer (`settleReadAsks`,
  at `afterTurn` and after a rows-only landing); and when the recipient closes (`close`, not `clear`/`parent`, which
  stop the asking child, and not `exit`, which leaves the question as it leaves a pending y/n). A question whose child stops before it lands leaves the inbox and never reaches a model. A
  subagent turn that read only a question is not one that read a result: its answer stays in the subagent. The
  journal gets `{ t: 'ask-parent', id, question }` and `{ t: 'ask-answer', id, by }` (`by` is `model`, `person`, `none` or `stop` for a child stopped or reset while it waited) from the asking child — a task's route keeps them beside `call-start`, `confirm` and `call` and sends them to its
  owner's journal tagged `task` — and `{ t: 'child-answer', id, child, text }` from the conversation that answered;
  `/export` draws them as `*Asked its parent:* …`, `*Answer to the question: from the model|person*` (`no answer was
  given`, `the asker was stopped`) and `*Answered «label»:* …`.
  `close('exit')` touches no child: at exit the registry's `closeAll` writes each child's
  end line (a task's `task-end` with `by: 'exit'`, a subagent's `subagent` end), clears and disarms every timer of a task still waiting
  on its delay, aborts every live conversation's turn (a session's `!command` or turn
  as well as a child's, so every running command's process group is killed and none
  outlives the process; a pending y/n is left as is), and closes the tree itself,
  deepest first (a session kept for a resting subagent is among the live conversations, so
  its subagents are reached); `close('exit')` of a child stops its own turn.
  **The subagent command** (`/subagent`, `/sub`; `src/assistant/subagent-command.ts` for the
  text, the `subagent` case of the chat's command switch for the rest) starts a `subagent`
  child through `scheduleChild` with no delay, `by: 'person'`. It reads the line's RAW rest
  (`cmd`, not the whitespace-split `arg`), so the spacing and line breaks of the prompt
  reach the model; `--with-context` and `--auto` count only as the first words, and `stop`
  and `tell` as the first word are those commands (a prompt that starts with either word
  is written another way). Nothing in it is a turn, so it is never refused while one runs;
  the child's lines go to the journal of the conversation's own session, which
  `keepPersonWork` makes when nobody has spoken: the line the person typed becomes the
  first `user` row (display only — the model's history never holds it), which gives the
  session its id, its lock and a journal with a start line, and the save timer writes the
  state file beside it, so the journal is never one the sweep finds with no state file. The
  label is cut from the prompt's first three words, lower-case and hyphenated, and made
  unique among the live children (`-2`, `-3`). `--with-context` hands `conv.summary` and
  nothing else — with none, nothing starts and the line says a `/compact` makes one;
  `--auto` sets the child's own auto mode to `all` (`setAutoMode`) on the child
  `scheduleChild` returns, before the schedule's timer lets its first turn go —
  overriding the mode the child starts with, the one of the conversation that started
  it (`autoConfirms` reads the asking conversation's own mode, and `shell.autoRun`
  applies as in a session). `/subagent` alone puts a note listing
  the conversation's running children of both kinds, numbered (`working`, `queued`, or
  `in <time>` for a delayed task), then the ended ones (`done`, `failed`, `stopped`, the
  duration, the tokens), or `no subagents here`; `/subagent stop <n|label>` takes the
  running child by its number in the listing last printed (the chat keeps its labels, so a
  job that ended since leaves its number unanswered rather than shifting the others; with
  no listing printed, a number names nothing) or by its label against the live children,
  and calls `stopSubtree`. Resting subagents are numbered in the listing with `idle` (or
  `answered`).
  **`/subagent tell <n|label> <text>`** writes to a subagent the person started
  (`tellTargetIndex` resolves the target: a number against the listing last printed, a name
  case-insensitively against the live children; a name that several children answer to is
  refused naming their numbers) and calls `Conversation.receive`. The refusals are
  `setError` lines that keep the line in the field: no such subagent, an ended one
  (read from `endedChildren`), the ambiguity, the usage, and `receive`'s own. A message sent
  clears the field and says a toast: `message sent to «x»`, or `«x» is working — your
  message reaches it at its next step`. The text keeps its inner spacing and line breaks.
  The tell is typed in the session's field, so it is ordinary field input; a subagent's y/n
  waiting meanwhile is answered only by `y` / `n` on an empty field.
  **The `@` form** (`/subagent @<id> <arguments>`, `/sub @…`; `parseSubagentLine` yields
  `{kind:'agent'}`, `@` alone `{kind:'agents'}`) starts a subagent from an agent file
  (below). `@` counts only as the very first word, so `stop`, `tell` and the flags come
  after the name (`--with-context` is taken right after it; `--auto` is refused with
  `--auto is refused for an agent: the agent's file says what it may do`). `@` alone puts a
  note listing the files found (`agentListing`: a markdown list item per agent —
  `@id — description · <params> · source` — a person's agent hidden by the project's
  marked shadowed, every file with errors as `path:line: message`, and a line saying the
  project's agents are not read when `shell.roots` is unset). Tab completes the first word
  after `/subagent` with `@<id>` and the description. The start (`plugins/assistant.ts`,
  the `agent` branch): `resolveAgent`, `parseAgentArgs` (pairs `name=value` first, then
  positional values in the declared order, the declared-last parameter taking the rest of
  the line; an unknown name, a name twice and an extra value are `setError` refusals that
  keep the line), one `askUser` free-text block per required parameter without a value
  (Esc, an empty answer or a dismissed question gives the typed line back), the trust
  question for a project file (below), then `begin` — the same start the prompt form
  uses. The prompt is `fillPrompt(agent, values)`; the label is the agent's id made
  unique among the live children (`uniqueLabel`); the child's writes are the agent
  file's own `writes:`, omitted — `'ask'`.
- **Agent files** (`src/assistant/agent-file.ts` the reader, `agent-find.ts` discovery,
  `agent-args.ts`, `agent-start.ts`, `agent-trust.ts`, `agent-model.ts`; durable page
  docs/usage.md, "Agent files"). The file is a header of `key: value` lines between two
  `---` lines — `description` (required), `params` (names, a trailing `?` for an optional
  one, the optional ones last), `tools` (tool group ids), `skills` (skill ids, comma-separated), `auto` (`ask`, `reads`, `all`), `model` (a role from `ai.roles` — a ROLE, never a model id, so the file travels between machines; see (models)), `writes` (allow | ask | deny (omitted: ask) — what a run of the agent may change: `ask` waits for the person's yes on each write and command, `deny` declines each one, `allow` runs each write the auto mode with `shell.autoRun` answers — not `config_set`, an unlisted `web_fetch` or a plugin's `run_command` — and is said in the log) —
  and a body; `{{name}}` in the body is replaced, single braces never. The reader is our
  own and total: every error carries the file and its 1-based line, an unknown or repeated
  key, an undeclared `{{name}}`, a declared parameter the body never spells, a `writes`
  value outside the three and a malformed name each fail the file, and a failed file is
  never offered. A file is read at
  each use (no cache) and hashed over its bytes (`Agent.hash`, sha-256). Three places
  (`findAgents`): the project's `.flow-assist/agents/*.md` under the git top level of the
  shell's directory (else the directory), read only when the real path of the directory and
  of each file lies inside a `shell.roots` entry — with no roots nothing is read, a link out
  is an error line, a file over `INSTRUCTIONS_CAP` is an error, never a cut prompt; the
  person's `agents/*.md` under `hostStateDir()`; and the files a plugin's `manifest.json`
  lists under `agents` (paths resolved inside the plugin's real directory, id
  `<plugin>/<name>`; only for plugins `services.agentPlugins()` returns — loaded, enabled,
  trusted, not built in). A project agent shadows the person's of one name unless the
  project's has errors. **An agent child** is an ordinary child started with
  `ChildSpec.agent` (`AgentRef`: id, source, path, hash) and `ChildSpec.toolGroups`.
  Its auto mode is not in the spec: the starter sets it after `scheduleChild`, as `--auto`
  does, to `agentAutoMode(file auto, maxAutoOf(config))` — the lower on `ask < reads < all`
  of the file's mode and `agents.maxAuto` (`reads` when unset or not a mode).
- **Skills** (`skill-file.ts` the reader and `loadSkillFresh`, `skill-find.ts` discovery,
  `skill-model.ts` the tool and prompt block, `skill-command.ts` the `/skill` line,
  `agent-skills.ts` the preload; durable pages docs/usage.md, "Skills", and docs/plugins.md,
  "Skills"). A skill is a directory with `SKILL.md`: a frontmatter between two `---` lines, read
  by our own reader (plain, quoted, `>` and `|` scalars; lists and nested maps read and ignored;
  `name` must equal the directory, `description` required; other keys come back as `notes`),
  then a body that no `{{}}` pass touches. `SKILL.md` over `SKILL_CAP` (32 KiB) is an error, never a cut.
  Three places (`findSkills`): the project's `.flow-assist/skills/<name>/` (same `shell.roots`
  rule as agent files), the person's `skills/` under `hostStateDir()`, and a plugin manifest's
  `skills` (directories, or a path ending in `SKILL.md`, resolved inside the plugin; id
  `<plugin>/<name>`, only for `services.agentPlugins()`); a project skill shadows the person's.
  The directory hash (`skillDirHash`, sha-256 over each sorted relative path, size, execute bit
  and content) covers every file; the walk is bounded (`SKILL_MAX_FILES` 256,
  `SKILL_MAX_BYTES` 2 MiB) and a link out is an error; `findSkills` takes it through a bounded,
  stat-keyed cache, while the tool, `/skill` and a preload read afresh. **Trust** is the
  `skill:<real path of the directory>` key of the same `agents.accepted.json` (`skillTrusted`,
  `recordSkillLoad`; a plugin's skill has none; nothing is written under `inModelShell()`). The
  person's own skill is recorded at the first `/skill`; a project skill asks (the host's y/n
  slot, `askAgentTrust(…, 'skill')`; Esc dismisses it and returns the typed line, where an agent
  y/n takes Esc as no); after yes a second fresh read must give the same hash before the record
  is written. `/skill trust <name>` and `/skill <name> [text]` are refused while a turn
  runs or a question is open (the bare listing is not); the person's message reaches the model as `frameSkill`'s block then the
  text (`SendOptions.skill`) while the row, the journal and ↑ keep the typed line. An agent's
  `skills:` is resolved at the start by the model's rule (`preloadSkills`; a failure names
  the skill and the command), framed after the filled prompt and before the follow-up in the
  first message (`ChildSpec.skills`; `ChildSpec.head` keeps the bodies out of a task's system
  prompt), at most `PRELOAD_MAX_CHARS` (64 KiB) in all; the person's start reads again after
  the first-start y/n.
- **A child's tool groups are an allow-list** (`Conversation.toolGroups`,
  `AgentOpts.allowGroups`). `tools:` of an agent file gives the child the `core` group
  plus the groups it names; `readTools` in `agent.ts` withholds every other tool of the
  registry, judged again on each registry revision, so a group that loads later is held
  to the list. The `core` group is not narrowed: `memory`, `config_set` and the rest of it
  stay. A child whose writes are `deny` is offered no write tools at all —
  `WRITE_TOOLS_WITHHELD` (`conversation-turn.ts`: `write_file`, `edit_file`,
  `workspace_write`, `run_command`, `shell_kill`) joins the `withholdTools` the wrapper
  merges, and every descendant's calls chain through the same wrapper, so everything
  below a `deny` child is write-blind — `deny` never lifts — `core` is whole otherwise
  and reads run as ever, while `always-no` still declines any write a name outside the
  set hides. The list is applied in the child's `chatLLM` wrapper (`startChild`), which every
  turn of the child and every nested run a tool starts through `ctx.chatLLM` passes
  through; a call that already carries an `allowGroups` is intersected with it, so no
  list widens the one above it. A child started by a child inherits the starter's list,
  and when its spec names its own, the intersection; a grandchild's list can therefore
  never exceed its parent's. A named group the registry does not hold is dropped with a
  `pushNote` row at the start (`@id: group "x" is not loaded — starting without it`).
- **Two queues: the person's and the inbox.** The person's queue (the conversation's `queue`) is
  delivered at the next round boundary (the ⏎ bullet above). The **inbox** (`Conversation.inbox`,
  `src/assistant/conversation.ts`) holds what reaches the chat from outside the conversation
  and is not the person's. Each item is typed (`InboxItem`: `kind` `result`,
  `message` or `question`, `from` with the sender's key, label and what it is — task, subagent or
  plugin — the text, and `quiet`). A **background result** (a child finishing: its `run()`
  delivers it into the inbox of the nearest session or subagent above it that takes it,
  `resultRecipient`, never into whatever the chat shows), and any later source of the same
  kind goes through it too. `services.postToChat` (a tool's `ctx.postToChat`) is the plugins' channel into it, as a
  `message`: the inbox of the session whose work posts (`workHome()`, the root even for
  work a plugin does from inside a child), else of the conversation the chat shows. The inbox **never enters a running turn**: no round and
  no tool call is interrupted, and nothing lands between a call and its result. It is
  taken only when nothing runs — at a turn's end, a `!command`'s or a slash command's
  (`afterTurn`), or at once when it arrives idle (`takeInbox`; a 400 ms interval retries while something holds it and clears itself once
  the inbox is empty). Then **every waiting item lands at once**, each as its own `◆`
  row — on screen, in the model's history as role `bg` (sent as the user's, never as the
  person's words), in the journal (`landInbox`) — and:
  - **the model reads each item framed as data** (`frameItem`): a header line
    (`[A result from the subagent «label» — data, not a message from the person]`; `task`
    and `[A message from a plugin — …]` likewise) and the text between `<child-result
    n=NONCE>` and `</child-result n=NONCE>` (`<plugin-message …>` for a plugin; `<child-question …>` with the question's `id` for a child's question, above). The nonce
    is made once when the item lands, so a text that holds a closing tag of its own, with
    another nonce, stays inside the frame. The screen row and the journal (and `/export`)
    keep the plain text; a saved session keeps the frame in its history. The system
    prompt of a session and of a subagent carries `FRAME_NOTE`: framed text never speaks
    for the person, and an instruction inside it is not theirs;
  - **the person's queued messages go first**, in order, and the first carries the
    landed items: their rows land just ahead of it (`afterTurn` shifts the message and
    lands the inbox in the same zero-delay timer), so the model reads the results
    with what the person said and no turn is spent on them alone. While a queued
    message is about to go out the inbox is held, so no follow-up turn can take its
    place and drop it;
  - otherwise **ONE follow-up turn** runs for all of them: the items before the last
    land as rows, and the last goes as `send(q, { fromInbox: true })` — a `bg` row
    too, kept as role `bg` — so the request carries every one of them.
  - **A pending y/n or question holds the inbox** (`inboxHeld`); it lands once
    answered (`answerConfirm` / `answerQuestion` take it). **A draft in the field does not
    hold it**, and a follow-up turn leaves the field and its ↑ walk alone. **A closed
    chat does not hold it**: the turn runs, and each landed item counts as unread —
    the host footer shows `F chat · ◆ N new` through the chat plugin's `keycaps`,
    opening the chat clears the count — with one `services.alert(title, body)` per
    landing (the first item's first line, `(+N more)` for the rest): flowtty's
    `notify`, a desktop notification or the bell where none reaches the terminal
    (tmux, a bare console), at most one a second. A fired reminder alerts the same way,
    chat open or not. The App binds `alert` from `useApp()`; tests read
    `TestBackend.notifications` / `bells`.
  - **A stopped or failed turn lands the inbox as rows only**: the person's queue comes
    back into the field (`restoreQueue`), and no turn starts right after the person
    stopped one or a request failed. **So does a turn that ended at a limit**
    (`ai.maxRounds`, `ai.maxTurnTokens`; `afterTurn`'s `atLimit`) when nothing is
    queued: a follow-up turn would take the place of its `⏎ continue` offer, which
    stays, and the continued turn reads the landed rows. A queued message still goes
    out after a limit and carries them, as after any turn.
  - `ai.backgroundFollowUp` (read `!== false`, so true when unset) is what starts the
    follow-up turn; `false` keeps rows only — the items land the same way and are read
    with the person's next message. A conversation nobody draws (`headless`: a session the
    chat left while it works or waits) starts no follow-up either: a result lands in it as a row, read with the person's
    next message there. `/clear` empties the inbox; `/new` and opening another session
    land what waits in it as rows of the session left (`park`), or keep it there while
    that session's tasks run or a subagent rests in it. `/clear` also stops the cleared session's tasks — a
    running one is aborted and delivers nothing, a delayed one is cancelled; after
    `/new` or opening another session a task still running delivers to the recipient above it,
    and a closed one takes nothing.
  - **The model is told this contract, not a kinder one.** `subagent`'s description
    (`src/loader/tools-core.ts`) says a result comes back to the conversation that started
    the task — for a subagent, itself, as a framed message that starts its next turn — as
    `<label> finished:` (or `failed:`) when the current turn ends, never in the middle of it;
    that one turn then follows for all the results that landed (or the person's queued
    message carries them); that `ai.backgroundFollowUp: false` turns that off, so the
    model must not promise to act on results when they arrive, only say they will come
    into the chat and it will look at them then; and that when results arrived since
    its last answer, the next answer opens with what came back, a line per task. It also
    says the task writes and runs commands through the person's y/n (the session's auto
    mode answers), and `writes: 'deny'` narrows it to a read-only task, and that a named
    agent's own `writes:` line is what its work gets. The
    call's own answer says the same (`the result appears in the chat when it ends, and
    you see it on your next turn`), and so does `config_schema`'s note for
    `ai.backgroundFollowUp` (`KEY_DEFAULTS`, the key is in `hostConfigSchema`'s `ai`).
    A description that promises a reaction the default does not make is what the
    model repeats to the person as its own promise.
- What the footer reads from a plugin (`host.store.<x>`) must be patched
  synchronously when it changes: the host draws its footer BEFORE the plugin's
  component re-renders, so a value assigned during render is one frame stale.
- A tool's ctx is built with `allServices(host.services)`, never `...host.services`:
  host services sit on the PROTOTYPE of the per-plugin services view, and a spread
  copies own properties only. A spread silently hands tools a ctx with no
  `chatLLM`/`config`/`showMessage`/`pushLog`.
- The conversation is a flowtty **`<ScrollList anchor="bottom" rowHeight={1}>`**
  (`ChatMessages` in `src/views/modals.ts`): it takes the rows the column leaves,
  follows new rows until the person scrolls up or a long answer's first row reaches
  the top (see "Where the eye is left"), and hears PgUp/PgDn and the wheel ITSELF —
  the chat's key handler must not. No heights are added up for the
  conversation: a new block under it needs `flexShrink: 0` — and a place in the count
  `planFit` is given, since the plan is the one block that yields rows. Sending a
  message calls `scrollToEnd()`. Needs flowtty ≥ 1.0.0-alpha.20; since alpha.22 the
  rendered window snaps to a grid, so a small scroll step re-renders no row at all.
  - **Only the rows near the screen are laid out.** A `<ScrollBox>` lays out every row
    of the conversation on every render, so a keystroke cost 1.7 ms more per turn of
    the conversation — 13 ms on a fresh chat, 75 ms at 81 messages, 144 ms at 161, and
    a session keeps 400. Every streamed token pays it too, which is what made a long
    chat freeze while an answer came in. With the list it is flat at the fresh-chat
    cost (`scripts`-free benchmark: boot the app over a restored session and time
    `backend.type`). It is exact only because every `ChatRow` is ONE terminal line
    (`rowHeight: 1`), the rule the pinned question already relied on.
  - The rows are handed over as `items` with a stable `keyOf` and drawn by
    `renderItem`; `children` are overlays only (the pinned question). A row keeps its
    selection marks — `wrapContinues`, `chrome`, a whole `frame` row — exactly as it
    carried them as a child (alpha.19 dropped them under the list: a wrapped paragraph
    copied as several lines; `copy.e2e.test.ts` catches that).
  - **A keystroke re-renders no row.** `ScrollList` calls `renderItem` for its whole
    window on every render, and the chat re-renders `ChatMessages` on every key, so
    everything the list is handed stays the same object while the conversation does:
    `items` is a `useMemo` over what the rows depend on (the palette by its values —
    the theme object is updated in place — and the renderers table through
    `useShallowStable`, as the chat rebuilds it on every render; `viewRevision()`, a
    renderer's late answer; `onViewFail` through a ref); the renderer is a `useMemo`, `renderItem` a `useCallback` handing each row to
    `ChatRowItem` (memoized on the row, its index and the renderer — the row cache's own
    objects); the list's callbacks are stable and call the latest render's code
    through a ref; the pinned question and the `↓` control are `useMemo`s, handed to the list
    as ONE memoized `Fragment` child (two positional children would be a new array every
    render). The list itself is `ChatList`, a
    `memo` of `ScrollList`, so with none of that changed it is not rendered at all, and a
    wheel step re-renders only the rows entering the window. The clock, which moves on
    every render while a turn runs, is kept out of all of it: the rows read it only for
    the whole seconds of a view still running (`items` depends on those seconds, not on
    `RowOpts.now`), and the renderer not at all — the round's spinner and a running
    command's pulse are `LiveMark` / `PulseMark`, which read `ChatClock`, a context
    `ChatMessages` (and the pager) provide with the render's `now`; a context change
    re-renders its readers through the memos and nothing around them.
    `perf.e2e.test.ts` holds it: a keystroke's frame (the frame meter, `:perf`) touches
    as many boxes with a screenful of conversation as with one row, and during a
    running turn only the turn's status line more, while the spinner still turns. Anything new a row is drawn with goes into those
    dependencies, or the row keeps its old look.
  - The empty conversation is still a `<ScrollBox>`: it holds the invitation, not rows.
  - The **wheel scrolls only while the pointer is over the box**. In a test pass
    coordinates — `backend.wheel('up', 20, 8)`; the default `(0, 0)` is the app title.
    A fourth argument is the run length a flick stands for — `backend.wheel('up', 20,
    8, 5)` scrolls as far as five single notches, `wheelStep × count` (flowtty ≥
    1.0.0-alpha.35; default 1).
  - Every `ChatRow` is exactly one terminal line; the pinned-question check reads a
    row's index as its line. A row that wraps would break it. Long lines of fenced
    code are hard-wrapped by `layoutMarkdown` (needs flowtty ≥ 1.0.0-alpha.11, or
    one runs out of its box as a single over-wide row); a test holds it.
