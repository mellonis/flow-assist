# The chat render, keys, panels — spec

> Extracted VERBATIM from AGENTS.md as of master before the
> `chore/agents-md-slim` rewrite. This file is the behavior spec for the area
> it covers: where the trimmed AGENTS.md core and this file ever disagree, the
> core rules win — but treat any difference as a defect in one of the two and
> report it. Covers: the panel layout, the chat rows and views, the `:` line
>
> Cross-file references inside the moved text ("(models)", "(below)") follow
> the OLD single-file layout; use DISPOSITION.md to find where a section
> lives now.
> panels, the message order, keys and bindings, folds and clicks, the mouse,
> `/model`, plugin commands through the chat, the field, and the modals.

### Where the chat is: panel, window, full

`panel` docks the chat beside the plugin's screen, so the board the model is told
about (`chatContext`) stays visible to the person typing about it. Three modes
(`src/runtime/panel-layout.ts`, pure): `panel` — the default — docks it beside the
plugin's screen, `window` floats it over the plugin's screen, `full` takes the whole
terminal. `plugins.assistant.mode` says where a conversation starts, `/mode` moves it
for the session (never saved); `fullscreen: true` reads as `full` (`chatModeOf`), and
there is no `/fullscreen`.

- **The layout is the App's** (`runtime/app.tsx`). The terminal is split into the
  plugin's SIDE — title bar, surface, footer, always from the top-left corner — and the
  chat's panel: on the right (`panel.size`, 35% of the width) or at the bottom (40% of
  the height; a right panel goes there by itself under `RIGHT_PANEL_MIN_COLS`, 120).
  Each side is given its size through a host context (`AreaContext`), which is what
  `host.useTerminalSize` and `host.useSurfaceSize` read — so a surface, a plugin's modal and
  the host's own furniture on that side are laid out as on a smaller terminal, and a
  modal's `overlay()` at `top: 0, left: 0` covers that side only (absolutes are placed
  from the root, and the side starts at it). flowtty's own size context is not exported:
  a plugin that calls flowtty's `useTerminalSize` directly still sees the whole
  terminal. The chat is drawn in the panel as a plain box (`docked`), not an overlay.
- **Too small to dock, it is a window.** `panelLayout` says `fits: false` when the
  terminal cannot give the panel its least (12 rows) AND the plugin's side its own
  (`PLUGIN_MIN_ROWS`: title bar + footer + one row — both floors must hold, or docking
  would squeeze the plugin's side down to a few rows or none). The App then gives the chat no dock
  (`chatDock` null) and it is laid out and behaves as a `window` — `layout` in the chat,
  published as `store.chat.layout`, which every behaviour check reads while `mode` stays
  what was asked for — until the terminal grows back. Both Ctrl+] and the collapse key
  open and close it then. A right panel needs its 12 rows of height the same way.
- **A pending question is shown whole.** While a question or a y/n is up in the open
  chat, the App asks it for the rows it needs at the panel's width
  (`store.chat.needRows` → `pendingChatRows` in `views/modals.ts`, counted from the same
  pieces `renderAsk` and the confirm block draw) and passes them to `panelLayout` as
  `need`: a bottom panel GROWS to it as long as the plugin keeps `PLUGIN_MIN_ROWS`, and
  past that — or past a right panel's whole height — `fits` is false and the chat is a
  window until it is answered. Growing first keeps the plugin's screen in view (what the
  question is usually about) and moves the layout by a few rows; the window is for the
  terminal where no growth can hold it (100×22: the default panel is 12 rows, the
  question 17). Collapsed, nothing is needed (the strip says it waits).
- **A call with several questions is a wizard.** `ask_user`'s block (`renderAsk` and
  `askBlockRows` in `src/views/modals.ts`; the machine is `src/assistant/ask.ts`) opens
  on the first question. With more than one it carries ONE tab strip row under its
  title: a tab per question (its header, else `question N`) and `Submit` last, a page
  whose draft holds a pick or words ticked `✓`, the page on screen drawn inverse, and
  every label cut by cells to the share of the row it has, so a wide label never wraps
  the strip onto a second line. The page after the last is the submit page: it draws no
  options and each question's title with the answer ⏎ will send under it — quiet and
  `(not answered)` when the draft holds nothing. `askBlockRows` counts the strip and the
  submit rows the render draws, so `pendingChatRows` and the window/panel arithmetic
  agree with the screen. A single question draws no strip and no submit page: a
  single-select row answers in one key, and a multi-select's digits and Space toggle its
  option rows with ⏎ sending the picks. The hint names the keys of the page it is on
  (`←→ questions · ⏎ submit · Esc dismiss` on the submit page).
- **In a chat with few rows the plan gives way, never the field.** The field's group
  never shrinks (`flexShrink: 0`, its whole height kept, so a 12-row bottom panel with
  a three-item plan still shows the field and its hint) and the conversation keeps at
  least one row. The `todo` plan is
  what yields: whole when it fits, else ONE row — `▸ plan · ⊟ <item>`, the item in
  progress (else the first pending) with its checkbox, cut to the width — and
  whole again when there is room (`planFit` / `planLine` in `views/modals.ts`, the
  rows counted from the same pieces the blocks draw). Past even that it is not drawn.
- **Two slots, in every mode, in the same order** — the plugin's side, then the panel;
  only their props change (the row/column direction, a width, `position: 'absolute'`
  over the whole terminal for `window`/`full`). A component moved to another parent is
  mounted anew: `/mode` would lose the turn being written, the draft and the queue,
  and a plugin's screen its state. A third place holds what floats over everything,
  the chat included — the reminder and the keycaps panel
  (`TOP_LAYER`): layers of no
  size of their own at the corner each piece places itself from, because a box that
  covered the screen would be what every drag starts in, and no pane's selection
  bounds would hold.
- **"Closed" in panel mode is COLLAPSED.** Open = expanded; opening (`F`, `:ask`,
  Ctrl+]) expands and brings the keyboard; Esc Esc and `/exit` collapse and hand the
  keyboard to the plugin (in `window`/`full` they close). Collapsed on the
  right the panel has no width, and a running turn's status (spinner, seconds, word,
  `^] chat`) is drawn on the plugin's bottom row — the App reads `store.chat.statusRow`,
  an element the chat hands over (`liveChatStatus` in `views/modals.ts`): a component
  that redraws itself every 120 ms while a turn runs, reading the status the chat's last
  render built, so the ticking seconds never redraw the App and the plugin's surface
  with it (the chat asks the App to redraw only when the status comes or goes); the assistant's own footer hint (`F chat`) steps aside while it is there
  (`store.chat.footerStatus`), keeping only an unread count, so "chat" is said once; collapsed at the bottom the panel keeps ONE row, the same status or the
  key that brings it back (`renderChatStrip`).
- **Closing is not an answer.** A y/n or an `ask_user` question pending when the chat
  is collapsed or closed by Ctrl+] / Ctrl+\ stays pending (`closeChat` settles
  nothing), in every mode: the closed chat's `statusRow` becomes `? waiting for you ·
  ^] chat` in the chat's `warn` colour — on the plugin's bottom row (collapsed on the
  right, or a closed window / full chat) or on a bottom panel's strip — and opening
  the chat shows the block again. Esc keeps its meaning: it declines or dismisses first,
  in the chat's handler, so Esc Esc never closes over one; `/exit` cannot be typed
  while one is up. Ctrl+C with a turn running still declines and stops. **A dismissal is
  not consent**: the question's Esc on the list — the answer field's Esc leaves the
  field first, and a free-text question has no list and dismisses at once — answers
  nothing, on any page, the submit page included; the model is told the person dismissed
  it and must not assume an answer, and every question whose draft holds nothing is kept
  as `→ dismissed`.
- **Focus** (`store.chat.focus`, docked and expanded only): Ctrl+] (`chatFocus`) moves
  the keyboard between the two sides; Ctrl+\ (`chatCollapse`) collapses and restores.
  Both are the assistant's bindings (`keys`, so a person moves them — to a chord only:
  `buildKeys` refuses a key that types for `APP_TAKEN_ACTIONS`, logs one line and keeps
  the plugin's default, since a letter taken before every handler would break typing
  everywhere and could not be undone from inside the app) but the App takes
  them right after the exit keys and BEFORE `twoPhaseDispatch`
  (`store.chat.panelKey`), so a plugin consuming every key, or its modal, can never keep
  the person from the chat — except the `:` line: while it is open it owns the keyboard,
  as it does for the exit keys, and neither key acts (nor types a control byte into
  it). With the plugin focused the chat's handler sits at priority
  1 and answers no key but the wheel over its conversation; its `ScrollList` gets
  `isActive: false`, so PgUp/PgDn are the plugin's; Ctrl+C / Ctrl+D are the plugin
  side's too (`ctrlKey` answers nothing). The focused side is marked: the panel's frame
  in `accent`, `idleBorder` when not; the title bar in `accent` when the plugin has it.
  Ctrl+] in `window`/`full` opens or closes the chat, and the collapse key is nobody's.
  Ctrl+] arrives as `{ name: ']', ctrl: true }` — the decoder names the control bytes
  0x1c–0x1f as chords.
- **The mouse goes by the pointer.** A press anywhere tells the chat which pane it
  landed in (`store.chat.pointer`) and the keyboard follows it; the button then goes on
  its usual path — the chat's `mouse: true` handler folds by the conversation's own rect, so
  a click on a fold in the panel works whichever side has the keys. A press on a box with
  `onClick` — flowtty's pickers, checkboxes and fields declare one on their own box — is
  taken by flowtty's mouse controller before any input handler, `HostChords` included,
  and never reaches step 1: `hostKeyed` tells the chat where it landed all the same
  (`HostKeyPath.pressed`), so a click on a plugin's list moves the keyboard to the plugin.
  The wheel scrolls whatever list is under it (flowtty's lists check the pointer; the
  chat's own, when not focused, through its handler). A flick over one stdin read
  arrives as ONE `wheelup` / `wheeldown` key with `count`, the run's length (absent
  for a lone notch, flowtty ≥ 1.0.0-alpha.35); flowtty's lists scale their own step by
  it, and the chat's handler reads `key.count ?? 1` for its own. Plugins get no mouse buttons
  through `useInputHandler`; flowtty's own components in `ui` take their clicks
  themselves.
- `bootApp` opens the chat as a WINDOW unless a test says otherwise (`opts.chatMode`,
  `null` for a fresh config): most e2e tests are about what the chat draws.
  `chat-modes.e2e.test.ts` holds the modes, the keys, the layout and a row check at a
  panel's width.

- **A tool describes what it shows, a renderer draws it, the host frames it**
  (`src/assistant/views.ts`). Everything else a tool does collapsed to one dim line in
  the fold unless host code knew that tool by name. So a tool may hand over a VIEW —
  data, never rendering — and a renderer turns that data into lines the host frames.
  - `ctx.liveView(kind, data)` opens a block and returns `{ update, discard }`:
    `update(next)` replaces the data while the call runs, `discard()` removes the
    block once the call ends. `ctx.reportView(kind, data)` is the one-off form — opened
    and left to become final with the call; its old one-argument shape,
    `ctx.reportView({ kind: 'console', … })`, is still read, as the console block.
  - `viewRenderers` in the shape maps a bare kind to a renderer (data in, lines of
    spans out); `scopeViews` (`src/loader/tools.ts`) qualifies it `<plugin>:<kind>` on
    the way out of the plugin, so a tool names its own kind bare and never collides
    with another plugin's. `collectViewRenderers` gathers the host's own `console`
    renderer plus every plugin's, bound once as `services.viewRenderers`.
  - **The frame** (`frameView`) is what turns a renderer's lines into what actually
    reaches the screen: one row is one line — cut to the width, never wrapped — capped
    at `VIEW_CAPS.rows`, every span's text stripped of escape sequences and every
    colour resolved from the chat palette (a token, never a literal), a leading span
    marked `chrome: true` painted and never copied. A renderer that is missing (its
    plugin was disabled) or throws costs one dim `▸ kind` line instead.
  - `agentChat` reports every change through `onToolLive` — a view's first state, each
    update, and its final phase once the call ends — so the chat can draw it live. A
    tool that then throws keeps what it showed, marked failed: the person was reading
    it, and a discarded view is the only one that goes. `data` must be JSON and no more
    than 64 KB; anything else is dropped and the view keeps its last accepted state.
    A view still `live` when a session was SAVED (the process ended mid-call) reads
    the same way on load — `failed`, never a clock ticking forever (`normalizeViews`,
    `src/assistant/sessions.ts`).
  - **Display only**: a view rides on the display message (a message of
    role `view`, which `apiHistory` drops) and never on the tool's result — the model
    already read the result, and a copy of it in the conversation costs the context
    twice.
  - **The chat's half of `onToolLive`** (`src/assistant/conversation.ts`): the message a
    view rides on is pushed on the view's FIRST change, so it has its place — and its
    fold id — from the start, and a block opened (by a click) while it ran is still
    open when it ends. Every later change replaces that same message (`views`, a new
    array each time — the row cache is keyed by the message object), coalesced to at
    most `LIVE_REDRAW_MS` (200 ms) so a command printing fast costs a few redraws, not
    thousands; a view's first state and its final phase are always placed at once,
    never held for the timer. A discarded view's message STAYS, drawing nothing
    (`views: []`) — removing it would move the fold id of every message after it. A
    live view's whole seconds are part of the row cache's key (`chatRows`' `RowOpts.now`,
    read once per render), or a cached `12 s` would stand still through a silent
    `sleep 30`. Live updates never call `persist()` — only the turn ending, or the
    `!command` runner's own `finally`, does.
  - **A view's `callId` is `${turnKey}.${callSeq}#${n}`** (`src/assistant/agent.ts`) —
    `turnKey` a random id made once per `agentChat` CALL (one per model turn),
    `callSeq` the turn's own call counter, `n` which view this call opened. Never the
    provider's own tool-call id alone: that id is not guaranteed unique across the
    rounds of one turn (a test double restarts at `call_0` every round; some real
    servers send `''` or reuse ids); using it alone would let two commands whose ids
    collided overwrite one another's block.
  - **A reset — `/clear`, `/new` and `/resume` — makes a new `Conversation`**
    (`renew` / `openSession` in `src/plugins/assistant.ts`), with its own `liveBuf`,
    `liveSeen` and `liveTimer`; the one left is closed (`Conversation.close` in
    `src/assistant/conversation.ts`: its `liveTimer` cleared, its listeners and port
    dropped). The turn counter (`turn`) carries over to the new object: it belongs to
    the chat's whole history, so a view's `turn` never repeats one already drawn.
    Every callback of a turn (`runTurn`) or a `!command` (`runShell`,
    `src/assistant/conversation-shell.ts`) still running — a tool's own view
    (`offerLive`), its `changes` (`onToolRun`), the turn's own final `flushLive()`, the
    command's own completion — writes into the object it started in, and checks
    `closed` before it draws: a closed conversation journals where the work happened
    and draws nothing, so a command still running when `/clear` fires never reappears,
    with its final phase, in the cleared chat.
- **`:perf` is how fast the app answers** (`src/runtime/frame-stats.ts`). The runtime,
  not any plugin, owns it: `renderApp` passes flowtty's `onFrame` (docs/app.md in
  `@flowtty/react`, "frame stats") to a `FrameMeter`, and wraps the root backend in
  `metered` UNDER `hostKeyed` — `hostKeyed` hands a key nothing took to flowtty a
  second time, so wrapped outside it the meter would count such a key twice. A frame is
  tagged by the input that came before it — `typing` (a printable key, Backspace,
  Delete, a paste), `wheel`, `other` (any other key or mouse event) — or is a `redraw`
  when none did (an answer streaming, a timer). An input frame is timed from the first
  input since the previous frame to the frame's end, the React render included; a
  redraw by its own layout + paint + draw. A stamp no frame took by the next macrotask
  is dropped (the paint is a microtask after the commit), so a key that changed
  nothing never lends its time to a later frame. The last `FRAME_WINDOW` (200) frames
  of each kind are kept; `:perf` writes p50/p95/max of the wait, the frame's own time,
  `commits`, `applied` and `skipped` per kind into the log and says the p95s in the
  toast. A frame slower than `SLOW_FRAME_MS` (50 ms) appends one `[perf] slow frame`
  line with its counters — `services.log.append`, no redraw, so logging a slow frame
  never costs another frame — and at most one line per `SLOW_LOG_EVERY_MS` (1 s): the
  slow frames in between are counted into the next line (`+N slow frames since the last
  line`), so a lagging app does not flood the log it is read in. `onFrame` must never throw (with no `onError` flowtty
  would end the app), so the meter swallows its own errors. A test passes its own meter
  (`bootApp`'s `opts.frameMeter`) to read the frames.
- **`:plugins` is the person's lever over the plugins** (`src/runtime/plugins-panel.ts`,
  `createPluginsPanel`; drawn by the command panel's `renderCommandPanel` over the
  plugin's side). The runtime owns it, like `:perf`: it works with the chat closed and
  with no assistant plugin at all. `plugins` is a host command WITH a `run`
  (`hostCommands` in `renderApp`, the base both registry builds use — a late join
  rebuilds the registry), marked `chat: true`, so `/plugins` in the chat opens the same
  spec through the chat's `openPanel`; the chat implements nothing of it. On the `:` line
  it opens the runtime's own panel (`hostPanel`): in step 1 of the key path, after the
  exit keys AND the chat's chords — it never keeps the person from the chat: Ctrl+] or
  the collapse key acting closes it — it holds every other key while up (`ui.hostPanel`,
  and `pluginHasKeyboard` is false). While the chat shows a request that waits for an
  answer (`store.chat.needRows` above zero: its OWN y/n or question, open or not, or a
  subagent's y/n drawn at the keys the chat has) none of its own keys acts —
  ↑/↓ and Esc only, and a notice names the chat's key — so a `y` meant for the chat never
  trusts a plugin. A subagent's y/n is not drawn under this panel (`services.hostKeys()`,
  read by `childAskNow`), so `needRows` does not count it and the panel's keys act; it is
  drawn, and armed afresh, once the panel closes. A 1 s tick redraws it, and its rows are redacted before they are drawn. One row per
  plugin — the list's own in order, then every other enabled, disabled, starting,
  untrusted or skipped name — with its version and its state: `disabled (restart to
  unload)`, `disabled`, `not trusted` (with `was`/`now`), `starting…`
  (`late.starting()`), `skipped: <why>` (`site.skipped`, from the loader's `skipped` map
  and each late `skipped` event's `why`), `missing settings: …`, `active` with its
  groups, tools and keys. `rows()` reads no disk: what the repository says is read when
  the panel opens and after each action. Keys: ⏎ details (manifest description, ranges,
  the skip reason, `plugins.<name>` flattened with `shownValue`'s mask, each
  `requiredSettings` variable set or `required — unset`), `r` restart (a REMOTE plugin
  only: out of the list, `stopRemotePlugin` — `shutdown`, then its transport's close —
  and loaded again through `site.load` and `late.expect`, so it rejoins as a late plugin
  does; the order is read again first, `late.order`), `d` disable/enable (below), `t`
  tools, `y` trust (below). What the loader knew reaches it as `renderApp`'s `site`
  (`PluginSite`: the repository, `enabledDir`, the trust options, `skipped`, the
  `untrusted` array the start screen reads, `load` = `loadEnabledPlugin`); the App always
  has a late hub (its own when the loader passed none), which is how enable and restart
  join.
  **Every load the panel starts** — enable, restart, trust — is `site.load` =
  `loadTrustedPlugin` (`src/loader/build.ts`): a read-only `pluginTrustOf` for that name,
  the link's real target equal to the recorded one, and the plugin loaded from that
  recorded place (`loadEnabledPlugin`'s `dir`), never through the link — a link moved
  in between loads nothing. Not trusted: it rejects with `UntrustedPluginError`, the
  App's `join` puts its `Untrusted` (with `was`/`now`) into `untrusted`, and the row says
  so. During a restart a call to one of its tools is told `<tool> is gone — <plugin> is
  restarting` (`registry.leaving`).
  **Disable** moves the link to `plugins-enabled/.disabled/<name>` (`repo.disable`, the
  link re-made absolute so a relative one still leads where it did) and FORGETS the trust
  (`untrustPlugin`, keeping the tombstone; the repository takes the trust options,
  `PluginRepoOptions.trust`). A loaded plugin goes into `disabledNow` and its tools are
  withheld (`registry.withhold` + `rebuildFromPlugins`, which also splices
  `pluginAiTools`): out from the next round, a call from the turn in flight answered
  `<tool> is gone — <plugin> was disabled`. Its screens, keys and commands stay until a
  restart. A plugin disabled while starting is not mounted when it would join, and a
  remote one is stopped (`stopRemotePlugin`). `.disabled` must be a real directory: as a
  link it is never listed and nothing is moved through it; a non-plugin name in it is
  not listed. **Enable** moves the link back and never trusts: the plugin is added to
  `untrusted` (a loaded one keeps its tools withheld) and the row says `not trusted` with
  where its link leads. `enabledPlugins` lists only the links at the top level, so a
  disabled one is never loaded, and a command moving it back loads nothing at the next
  start (its trust is gone). `plugins ls` says `disabled`, `install` of a disabled plugin
  moves it back, `remove` takes a disabled one.
  **Trust from the panel** is `trustPlugin` with the loader's trust options, on the
  person's `y` in the panel — the only way it is reached: the model's tools do not
  include it, a remote plugin's requests do not, and a chat line (`/plugins y`, typed or
  queued) opens the panel and nothing more. A plugin whose tombstone (or record) is its
  target now is trusted at once; otherwise the panel opens a spec over itself — `its
  link leads to <now>` for a first trust, `was` and `now` for a retarget — and only that
  spec's own `y`, for the place it showed, records it. A trusted plugin leaves
  `untrusted` (the start screen follows); a loaded one gets its tools back, an enabled
  one joins. Every name in a notice or a title goes through `shownName`.
  `src/__tests__/plugins-panel.e2e.test.ts` holds it.
- **The typed command is text; everything drawn around it is chrome.** A drag over
  the line copies what was typed and nothing else — not the `: ` prompt, not the
  inline offer after the caret, not the `⇥ a · b` candidates — so a long
  `config set plugins.mcp.servers.safari.readOnly …` can be taken out to be fixed or
  shared. It follows the rule the chat's rows follow (the gutter is chrome, the text
  is not): only the spans carry `selectable: false`, and the bottom box carries
  `selectionScope` instead — a drag that starts there stays on its row and inside the
  padding, so the layout's own blank cells never come back as spaces around the
  command. The footer hints and the toast, which have that row whenever the line is
  closed, are chrome too. A command wider than the terminal is not wrapped
  (the rule above), so a drag copies the part that is on the screen. The chat's input
  field is NOT this: its caret and placeholder sit in the middle of its text, so it
  stays unselectable whole until that is thought through.

## The chat

- Who speaks is said by a **gutter marker and a ground**, not a label: `›` on the
  user ground for the person (the input field's own prompt), `ƒ` for the
  assistant's answer (also signing the frame, `ƒ Flow Assist`), `◆` on its own
  ground for a background result, `!`/`‼` on the user ground for the person's own
  `!command`/`!!command` and on none for a command the MODEL ran and they confirmed (a `view`
  message) — the same marker in the same colour, the ground saying whose it was. The
  host's own ask after a `!!command` is a `›` message drawn dim, marker and text: the
  person's side of the conversation, not their words. A kept `ask_user` question and the
  answer it got (`?` over `→`) share a ground of their own, `askBg` in `askInk`, so the
  pair reads as one band in the transcript; a dismissed answer keeps the ground and dims
  its ink. Colours come from `theme.modals.chat` (`accent`, `assistantAccent`, `userBg`,
  `fieldBg`, `bgAccent`, `bgBg`, `warn`, `ok`, `askBg`, `askInk`) and are overridable via
  `config.plugins.chat.colors` — the resolver merges `config.plugins[<modal name>].colors`,
  and this modal is named `chat`.
- A marker is ONE narrow-width code point: flowtty's grid measures display width per
  grapheme cluster and reads an East-Asian-ambiguous glyph (`∮`, `≈`, most of
  Mathematical Operators) as one cell, so it shifts the row in a terminal that draws
  it two cells wide. A CJK ideograph or an emoji is wide and gets its own two cells
  (`Cell.char` is `''` for the second one).
- Markdown in answers — tables included — is laid out by flowtty's
  `layoutMarkdown`. The host adds nothing but the soft `▍` heading marker (and keeps
  the selection marks each row carries — see the drag below); a gap in
  that layout is fixed in flowtty, not papered over here. Since flowtty
  1.0.0-alpha.14 fenced code is highlighted in ~25 languages, ```diff is coloured,
  and a block is a dim language label over rows prefixed with a dim `│ ` (no
  backtick rows) — a test that joins a block's text must strip that bar.
- **The person's own message is drawn as typed, not as markdown** (`typedLines` in
  `src/views/modals.ts`). In markdown a single line break is soft: two typed lines
  were drawn as one, `  npm test` lost its indent, `- a` became a bullet. Their text
  is laid out by `inputRows`, as the field showed it — every line break, blank line
  and leading space kept, a wide line cut at the column (character wrap, like the
  field). A cut drops nothing, so the row before it carries `continues` with
  `dropped: ''` and a drag rejoins the line exactly; a typed line break copies as a
  line break. Only role `user`: a background result (`bg`) is the model's writing and
  a `!command`'s block (`shell`) is the host's own ```console fence — both stay
  markdown. The pinned question folds a multi-line message onto its one row.
- **⏎** sends; while an answer is coming it **queues** instead, and a queued message
  reaches the model at the turn's NEXT REQUEST BOUNDARY — after the current round's
  tool results, as the person's message, the turn going on with it in view (the
  `beforeRequest` hook in `runTurn`, `src/assistant/conversation-turn.ts`: the message
  is taken off the queue, put into ↑'s
  history, drawn as the person's message where it reached the model, and appended to
  what `agentChat` sends, so it joins the turn's transcript; delivered first, then the
  automatic compaction's size check, with the message counted — a compaction keeps it
  after the question). **⇥ on the empty field holds** the last queued message for the
  turn's end instead, and ⇥ again lets it go at the next step; a message naming an
  image waits for the turn's end too (it goes as a message of its own, images and
  all). What is left when the turn ends goes out in order then — a turn with no
  further round (an answer) delivers nothing mid-turn — and the first of it carries
  whatever waited in the inbox (the two queues, below). The line over the field shows
  the LAST one and what it waits for — `reaches the model after this step · ↑ back ·
  ⇥ hold to end`, or `held to the turn's end · ↑ back · ⇥ release` — in a turn
  (`queueWaits`), and `↑ takes it back` outside one (a slash command's wait); ↑ and ⇥
  act only on an empty field, where they are offered. Two rules decide what waits
  (`queueWait`, shared by the delivery and the line): **⇥ holds only the message it
  was pressed on** — it goes at the turn's end, and messages queued after it are still
  delivered at the next boundary (the person held that one on purpose; a correction
  typed after it is meant to reach the model now). **A message naming an image waits
  for the turn's end AND keeps every message behind it waiting** — it was not held by
  choice, and delivering the later text first would reorder what the person wrote. The
  line says which: `held to the turn's end`, `at the end of the turn (it names an
  image)`, `at the end of the turn (behind an image)` (no ⇥ offered for either). A turn that ends on a limit delivers nothing more: what is
  queued goes out as the next turn, after the host's stop line. **Esc** while an answer or a `!command` runs **stops it,
  on the first press**, touching neither the field nor the queue (the line under what
  came so far says `stopped (Esc)` — `stopped (^c)` after Ctrl+C: the label names the
  key that stopped it, from `keyGlyph`, and so does a `!command`'s outcome; the message
  carries it as `stoppedBy`, and a session saved without one reads as `(Esc)` —
  a cut-off «В» must not read as a whole answer;
  the model's history gets a closing message of its own, see "The conversation the
  model sees"). Idle: clear the field → step the bang level down (one level per Esc)
  → arm/close (docked, collapse — so an empty `!!` field takes four Escs to fold the
  panel). Stopping always comes first, before clearing the field or taking the queue back: with
  a message queued, doing either first would throw the queued message away on the
  second Esc and only stop the tool on the third.
  **A queued message never undoes what just ended**: the conversation holds ONE list
  and replaces it on every change (`Conversation.setRows`), so a message sent from the
  zero-delay timer after a turn, a `!command` or a slash command (and `!!`'s ask
  likewise) lands on the list as it is, the end included — never on the list as last
  DRAWN (`Conversation.rows()`), which that timer can run ahead of: a list built from
  it would throw the end away — a finished command's block would come back live and
  tick forever, an answer would lose its last words. The drain still goes out from
  that timer; `queued-send-race.e2e.test.ts` runs zero-delay timers as microtasks to
  hold the race open. **A stopped or failed turn does not send the queue**
  (`Conversation.restoreQueue`, and the chat's `restoreQueue`, which puts the texts
  back into the field): the queued messages come back into the field in order,
  joined by blank lines, AHEAD of whatever was typed meanwhile — the order they would
  have gone out in; a `!`/`!!`-mode draft keeps its bang(s) and the level drops to 0. A failed
  request would most likely fail again. A conversation the chat has LEFT (`headless`) has
  no view to put them back: `afterTurn` moves them, on a `stopped` or `failed` `lastEnd`,
  into the kept draft ahead of what was typed at the leave, so they are saved with the
  session and the park is not held by a queue (a conversation merely without a port is
  not left: its queue stays for its owner). **↑ on an EMPTY field takes the last queued
  message back** before it steps into the history. **⇧⏎** is a newline, and so is
  **Alt+⏎** (drawn `⌥⏎` on macOS); a blank line is kept. The hints name both, Shift
  first — `⇧⏎/⌥⏎` (`NEWLINE_KEY` in `src/views/modals.ts`, the one spelling every hint
  uses): the TTY backend asks for the kitty keyboard protocol, under which a terminal
  tells ⇧⏎ from ⏎, and one without it (Terminal.app) sends ⇧⏎ as a plain ⏎, which
  sends — Alt+⏎ is the key every terminal with an Alt sends as its own.
- **The chat draws a `Conversation`'s snapshot** (`src/assistant/conversation.ts`)
  through `useSyncExternalStore`: the list, the busy mark, the status line's activity,
  the y/n, the question, the queue, the auto mode — one object, the same until something
  drawn changes, and around the SAME `messages` array until the list itself is replaced
  (the rows' memo keys on it). A write that changes nothing tells nobody. The chat's
  root is concurrent: React renders a store's change as urgent work, before the next
  await resumes, where a state change made outside a key handler waits for the
  scheduler's next task. So outside a turn, and for the busy mark, the y/n, the
  question, the queue and the auto mode at any time, the conversation tells its
  subscribers at once; while a turn runs, at most once per macrotask, two
  `setImmediate` steps later — behind any render React's scheduler queued meanwhile, so
  a stream draws once per network read, as often as the chat's own state did. The
  second step is what keeps it there: with one, the telling lands before a render the
  scheduler queued in the same loop turn (the ticker's, the App's `notify`), and the two
  commit apart. A telling at once disarms the deferred one waiting. `stream-cadence.e2e.test.ts`
  guards this in React commits: an answer read at once draws a couple of times, and one
  read delta by delta (200 reads) draws at most once per read, +3.5 % — the racing
  variants draw 6–9 % more. The
  model's saves and notes read the list as the chat last drew it while a port draws the
  conversation (`drawnRows`, set by every render; `currentRows`), so a save and the
  journal see what the person saw; with no port they read its own `messages`. One
  conversation per session: `/clear`, `/new` and `/resume` give the chat another object
  (`adopt` moves the chat's listeners, its port and what the render's handlers reach
  to it). `/clear` closes the one left. `/new` and `/resume` leave it (`leave`: its
  view handlers unbound, its port detached, then the registry's `retire`): closed at
  once when nothing of its own is left, else kept loaded, locked and drawn by nobody
  until it is quiescent — its turn, a `!command`, a y/n or its tasks go on in it, and
  it draws nothing on this chat meanwhile (no clock, unread count, alert or
  row; only a task's toast names it). The clock (`leave` stops it and zeroes it) and the `/memory`
  listing a number was taken from (`leave` forgets it, so `/memory accept <n>` lists
  again) are the session on screen's; `adopt` starts the clock again, from the
  segment's start, for a conversation taken back while it works. `/resume` of that session while it is kept takes
  the same object back, with the draft it kept (`reclaimLive`), never a second one read
  from its file (`openFromFile`). `leave` writes what the chat showed of it — its folds (the exception
  set copied), its notes mode, the caret in its draft and its place in the list (at its
  end, else the row at its top as a message and an offset, `rowAnchor`) — into a map keyed
  by the object (`src/assistant/view-memory.ts`), and the taken-back conversation's view
  reset reads that entry instead of resetting (`applySessionView`). The place is asked
  after the folds are set, since the row counts what is laid out with them. The caret is
  put back only into the very draft it was in: one that grew while the session was away
  (a stopped or failed turn's queue goes ahead of it) has the caret at its end. A session put away, one read from its file, `/clear` and `/new`
  have no entry and open folded, on the config's notes mode, at the end; so does one left at its end (the list keeps its scroll offset across a switch, so the chat asks it to its end). The pager is
  closed on every switch. `/resume` of the session on screen keeps the object
  on screen and refreshes only the view. The chat makes every
  conversation through its registry (`ConversationRegistry`), made on its first render:
  its lock token is every conversation's, the chat's unmount writes and releases what
  is live (`flushAll`, which closes nothing), its exit hook closes everything
  (`closeAll('exit')`), and `adopt` tells it
  which conversation is on screen. The screens' gates (`store.chat.busy`, `typing`,
  `asking`) read the conversation the chat holds now (`convRef`); `postToChat` and
  `store.chat.note` read whose work calls them — `workHome()`
  (`src/assistant/conversation.ts`): the conversation whose turn runs the caller
  (`workOwner()`), or for a task the nearest ancestor that is not one, null outside any
  turn. A plugin's tool called by a left session's turn posts into that session, not
  into the one on screen; with no owner (a plugin's own poller, a key), or with that
  session already closed, the message goes to the conversation on screen. The owner
  outlives the turn in what a tool left running (a timer, a promise), and ends where a
  conversation hands control to the host — `outsideWork(fn)`
  (`src/runtime/background-work.ts`) runs `fn` with no owner, the background mark left
  as it is: around the store listeners `tell` calls, around every handler `emit` calls
  (the chat's view, the registry's `track` and its park watch), and in the App's
  `notify` (`src/runtime/app.tsx`), the one redraw every caller reaches — a
  conversation's `deps.notify`, the registry's, a tool's `ctx.notify`. React schedules
  its work in the context of whoever asked for it, so without that a render, a
  component's effect and any timer it starts while a turn streams would read that
  turn's session as their owner: a plugin's `host.open` from an effect refused as "not
  on screen" while a left session streams, its note posted into that session. A
  plugin's tool that sets its own component's state directly is outside this.
- **Ctrl+C, Ctrl+D and Ctrl+Z take a second press** (`src/runtime/exit-keys.ts`, pure;
  the App owns the arm). flowtty hands these three to the app BEFORE the terminal
  backend acts (exit, exit, suspend — skipped when a `useInput` handler returns strict
  `true`), so a stray press never ends the app mid-answer. The App takes them
  before `twoPhaseDispatch`, since the y/n pause, an open question and a modal's
  catch-all swallow every key — and before every flowtty component.
  **The host's place in key delivery is fixed** (`HostKeyPath` in `runtime/app.tsx`):
  host chords → whatever flowtty component takes the key → the host's key path. flowtty
  delivers a key to its ordinary `useInput` handlers in mount order (a surface mounted
  after boot comes after everything of the App's), and a component takes the keys it
  acts on (a focused `ListSelect` takes what is typed as its filter); a capture
  handler (`{ capture: true }`) hears every key before the ordinary ones. So:
  `HostChords`, the App's first child, is a capture handler — the first in the App's
  subtree — and runs the chords (`first`: the exit keys, Ctrl+], the collapse key, the
  pointer's pane). flowtty has no phase after the ordinary handlers, so the backend's
  key listener is wrapped (`hostKeyed`): a key nothing took in pass 1 goes round as
  pass 2, where `HostChords` runs `twoPhaseDispatch` (`last`) and takes it — no other
  handler hears it twice, and the host's path runs inside flowtty's synchronous render
  (a burst of keys — Esc Esc — sees each key's state). A mouse button skips pass 2 (a
  second press would redo the selection) and runs `last` right after pass 1. Tab and
  ⇧⇥ go from `HostChords` to `last` at once: the DialogHost's `FocusGroup` above the
  App takes Tab whenever two flowtty fields are mounted, and the chat completes and
  steps its auto mode with them, a plugin's handlers hear them. While a
  dropdown's popup is open flowtty mutes the App's subtree, `HostChords` with it; the
  exit keys are then heard by `HostExit`, a capture handler beside the DialogHost
  (never muted, mounted after it, and acting only when `HostChords` did not hear the
  key), and nothing else of the host's runs. For the exit keys the first press arms and
  is consumed, the status
  line says `^c again to exit` / `^d again to exit` / `^z again to suspend` (the cap
  from `keyGlyph`, in the chat where `Esc again to exit` is — `services.armedHint` —
  and on the bottom row of every other screen); the same key within `ARM_MS` (2 s)
  fires; any other key (not a mouse button) disarms, and the arm fades on its own.
  Ctrl+C / Ctrl+D fire through `onExit`, as `:quit` does; the second Ctrl+Z is NOT
  consumed, so the backend hands the terminal back and stops the process, and repaints
  on `fg` (a test sees it as `backend.press()` answering `false`). The open chat speaks
  first, through `store.chat.ctrlKey`: Ctrl+C with a turn or a `!command` running
  STOPS it exactly as Esc does (a pending y/n declined and a question dismissed first,
  or the turn would wait on them) and nothing is armed; Ctrl+D in a field with text is
  the editor's forward delete, consumed (never while the `:` line is open — it owns the
  keyboard then; its own catch-all types no chord as a character); a chord a drawn
  plugin's panel binds (its `ctrl+d` — the work picker's kill) is the panel's key and
  goes on to the panel, never to the arm. **The keys are
  claimed only while there is something to stop** (a live abort controller not yet
  aborted, `Conversation.canStop`) — for Esc as well: a run that goes on after its abort (a tool that ignores
  its signal) no longer holds them, so the next Ctrl+C arms and the one after exits,
  Esc goes back to its idle steps, and the status line drops `Esc stops`. `/compact`
  (`runCommand`, `src/assistant/conversation-turn.ts`) has a controller of its own, passes the signal to its request and
  races the wait against the abort, so it stops at once (`/compact stopped (^c)`) and a
  late summary is not applied. It **leaves the field the moment it is submitted**, as a
  sent message does (it is in ↑ already), and never touches the field when it ends — a
  draft typed meanwhile stays; what was queued meanwhile goes out after it, or comes
  back into the field when it was stopped or failed (`restoreQueue`), as after an answer. It holds app-wide — the start screen and a
  plugin's screen arm the same way; a turn running while the chat is closed is not
  stopped by Ctrl+C. **Nothing else is consumed**: `twoPhaseDispatch`'s `true` means
  "handled, redraw", and the chat answers it for every key — PgUp and the wheel
  included, which the conversation's scroll list hears on its own.
- **A key has two names, and they meet in one place.** The TERMINAL's name is what
  flowtty's decoder gives as `key.name`: `'return'`, `' '`, `':'`, `'escape'`. A
  PERSON's name is what gets written in a binding — `config.keys`, a plugin's `keys`
  table: `"enter"`, `"space"`, `"colon"`, `"esc"`. `canonicalBinding` in
  `src/playback/keys.ts` turns the second into the first, once, when `buildKeys` /
  `resolveKeys` assemble the map; `writtenKey` goes back for anything shown in words
  (the model's `config_schema`). So: a **binding** may say `'enter'`; a **comparison**
  (`key.name === …`, a test's `press(…)`) must use the terminal's name — there is no
  `'enter'`, `'space'` or `'colon'` there, and flowtty's `TestBackend.press()` throws
  on them.
  - What is DRAWN for a key is the **third** vocabulary: `keyGlyph` in the same file
    — `⏎ ␣ ⇥ ⌫ ↑`, `^r`, `⌥⏎`, `⇧⇥`; one code point per glyph, a short word where no
    glyph exists. The keycaps panel draws pressed keys with it (the raw name read
    `return`, and `' '` drew an empty cap). Alt is `⌥` on macOS and `Alt+` elsewhere
    (`META_CAP`).
  - **A modifier is part of the key, and so part of a binding.** A binding may name a
    key that is held with Ctrl, Alt or Shift — the chat's `details` is `^o` — and a
    person writes it as it is printed (`ctrl+o`, `^o`, `alt+enter`, `⇧⇥`). `keyId`
    canonicalises both sides into ONE string (`ctrl+alt+shift+<terminal name>`, in
    that order), which is what `canonicalKey` stores and what `isKey(binding, key)`
    compares — so pass the whole key where an action may sit on a modified one, and
    the bare `name` where every binding is a bare key and a modifier held with it
    should not stop it firing (the host fallback in `app.tsx`). Shift on a CHARACTER
    is left out: the decoder reports `'A'`, never shift+`'a'`. Without this an action
    on a modified key would have to be hard-coded in its handler, `key.name === 'r'
    && key.ctrl` style: unremappable, and invisible to every hint.
  - **Never write a key's symbol by hand in a hint.** Two cases:
    - the action is BOUND (it is in `host.keys`, so the person can remap it) → draw
      `host.keyCap(action)`; it is `''` when the action is unbound, and then the hint is
      not shown at all. The host footer (`composeFooterHints`) and the chat's
      `F chat` hint do this. Host-side code uses `bindingGlyph(keys[action])`, or
      `firstGlyph(…)` where an action answers to several keys and the hint should
      teach ONE (`details` takes `^o` and keeps `^r`; `^o/^r` in a line of hints reads
      as two keys to learn).
    - the key is fixed (the chat's own Enter / Esc / Tab) → `keyGlyph(…)`, as the
      `CAP` table in `src/views/modals.ts` does.
    A bundled plugin that still spells caps by hand in its `keycaps` (acme-tracker)
    shows the default key after a remap — that is the bug this rule prevents.
- **A key acts where it is shown, and is shown where it acts.**
  - The hint and the key read ONE predicate, `cacheInPlay` (`loader/registry.ts`): `x`
    flushes the cache only from a screen whose footer offers it — a plugin that keeps
    data in the cache is on screen. `:clear` works from anywhere.
  - Flushing the cache (`x`, `:clear`) also **reloads what is on screen**: the host
    counts flushes in `services.cacheEpoch`, and a plugin that draws cached data
    reloads when the number changes (`useEffect(..., [host.services.cacheEpoch])`); a
    flush that leaves the open board as it was reads as a key that does nothing.
  - `openBrowser`, `prev`, `next` and `open` stay in
    `HOST_DEFAULT_KEYS` only as a shared vocabulary for plugins (a plugin reads
    `host.keys.open`); the host acts on none of them.
  - A test presses every lower-case letter on the start screen and expects silence
    (`home.e2e.test.ts`) — `q` included. **No key quits by default**: quitting is
    deliberately unbound from any letter, since a stray `q` would otherwise close the
    whole app. Quitting is the `:quit` (`:q`) command or Ctrl+C twice; the action
    stays in `HOST_DEFAULT_KEYS` unbound (`[]`) so `config.keys.quit` can bind it, and
    the start screen then names the key instead of `:q`. Plugins leave their screens
    on Esc (`keys.back`) only.
- **A capital opens something big**: `F` the assistant (Flow Assist), `L` the log, `J` the
  work picker; a plugin's main screen should follow (`B` for a board). Lower case is for
  what is INSIDE a screen. The work picker acts where the chat does not have the keyboard
  (a capital would type into the field), and `/work` opens it from inside the chat.
  The session picker is the exception, `^s` (`sessions`): it must open from inside the
  chat, where a letter types.
  A modal is closed by the key it is bound to (`f.keys.<action>`), never by a letter
  written in the handler.
- **↑/↓** walk the prompt history, only while the field is empty or still shows a
  history entry untouched (↑ on an empty field takes a queued message back first). The
  history holds **every submitted line** (`src/assistant/prompt-history.ts`) — a
  message, a `/command` (an unknown one too: a typo is fixed with ↑), a `!command`
  and a shell-mode line, both kept as `!cmd` (an interactive one as `!!cmd`) and
  recalled at the matching bang level — never the host's own ask after a `!!` — with
  no line twice in a row. A command pushed before it runs is pushed again after if it REPLACED
  the history (`/resume <n>` loads that session's own), so ↑ there still offers it. A
  command whose definition says `history: false` is never kept — for one whose argument
  may carry a secret, since the last 100 entries are saved with the session as
  `prompts`. None of the chat's own commands (`CHAT_COMMAND_DEFS`) takes one; the `:`
  line's `config` does (an MCP server's `headers` / `env`), and a plugin's command may
  say it too (docs/plugins.md). A `/…` or `!…` field is still never saved as the draft.
  The **wheel** and **PgUp/PgDn** scroll.
- **`↓` / `↓ new` goes back to the end** (`JumpControl` in `src/views/modals.ts`). While
  the conversation's list is away from its end — scrolled up, or a long answer resting
  at its first line — a control is painted over its bottom-right corner, `↓`, and
  `↓ new` once the messages changed since the list left the end (one more, or the last
  one replaced: a round still being written). It is an overlay of the list, like the
  pinned question, and both go to the list as ONE memoized child, so a keystroke leaves
  the list's props as they were; its state is `ChatMessages`' own (`view.atEnd`, set
  from the metrics). A click takes it through flowtty's `onClick` on its own box, so the
  press never reaches the chat's fold click; with hover on it is underlined under the
  pointer. Not drawn while the pager hides the list — where the list left the end is
  kept meanwhile, so what arrived under the pager reads `↓ new` after Esc. The key is the assistant's `toEnd`
  (End, `config.keys.toEnd`), acted on in the chat's handler only when the list is away
  from the end AND the field is empty or its caret stands at the very end of the draft
  (`cursor === value.length`) — End is the editor's too, so with any text after the
  caret, a later line of a draft included, End goes to the editor.
- **What is open and what is folded** (`src/assistant/folds.ts`, pure; the chat owns
  the state, the view resolves it per block). A single global flag would open the
  reasoning, the narration, every tool call of every turn and every capped command
  block at once, so reading ONE command's output would mean unfolding the whole
  conversation and folding it back. Instead each command block folds to ONE line
  whatever it printed — see the `run_command` bullet above. The model, so
  that a click and the key cannot disagree:
  - **ONE global state** — everything folded (where a conversation starts) or
    everything open — plus the blocks a CLICK has made an exception of. A click
    toggles that block alone: opening one command's output must not become a sticky
    "expand mode", which is the verbosity this is meant to remove.
  - **`details` is the master switch and clears the exceptions**: with anything folded
    it opens everything, pressed again it closes everything. After it the screen is
    uniformly one or the other — there is always a way back to a state a person can
    describe. It is `^o` (`^r` kept as an alias) and a BOUND action, so
    `config.keys.details` moves it and every hint draws from the binding.
  - **A block that did not exist yet follows the global state**: with everything open,
    the next turn's tool calls and command output arrive open. `/clear` and `/resume`
    both go back to everything folded with no exceptions — the state
    is the CONVERSATION's and is never saved.
  - One block does NOT follow it (`isClicked`): the **cap on an open tool trail**. A
    key meaning "open everything" is asking for the trail, not for sixty rows of it,
    and the cap is what keeps an open trail readable.
  - A group's open state is DERIVED: open when its own id says so, or when a member
    was clicked open before the group formed around it, so a group never folds away
    what the person opened.
  - The kinds (`FoldKind`): `thinking` (a message's aggregate reasoning, what a session
    with no reasoning parts holds), `reasoning` (one thought, numbered — a message may
    hold several), `steps` (one run of
    steps — a message may hold several, numbered), `tools` / `calls` (one stretch of
    calls and its trail's cap, numbered together), `view` (a command's block,
    numbered), `group` (a group's head), `summary` (what /compact's note folds under its
    separator row).
  - A block's id names its message by its place among the messages that are DRAWN
    (`foldId`). Not by the message OBJECT — the chat replaces a message whenever it
    changes, which is what makes `rowCache` correct — and not by its raw index: the
    system prompt draws nothing and is unshifted onto the list again with every
    question, which would move every id by one.
  - **Which of a message's blocks are open is part of the `rowCache` key**, or a
    message would keep the rows it was first laid out with and a click would move
    nothing.
- **A click opens the block under it.** `mousedown` + `mouseup` on the SAME cell, no
  `mousedrag` between them, within ~250 ms; anything else stays a drag, so
  copy-on-select is untouched. A click on a fold line opens THAT block, a click on any
  row of an OPEN block closes it, and a click on anything else does nothing — in
  particular it must not dismiss the reminder, close the log or answer a y/n (there
  are tests for each). A click on a group's own head (`Ran N commands`) folds or
  reopens the WHOLE group, not just its own exception — closing it also forgets any
  member the person had opened, so the group reopens folded (`toggleGroup`,
  `src/assistant/view-groups.ts`). Mapping a click to a row: every `ChatRow` is one
  terminal line, the conversation reports its rect (`onLayout`) and its scroll
  (`onMetrics`) through `onViewport`, and the chat asks `chatRows(...)` — cached per
  message — which row carries which `fold` id. The pinned question is painted over
  the top row, so a click there is the pin's and not the row beneath it.
  - **Where the eye is left.** Opening a block scrolls so its FIRST row lands right
    under the pinned question (never behind it — landing on its LAST line instead
    would show the end of the thing the person opened it to read, past where they
    meant to start); closing keeps the clicked block's first row exactly where it was
    on screen, pin or no pin — a screen position, not a thing to read, so it is never
    pushed down for the pin; the key, which has no one block to anchor on, keeps the
    message the top row belongs to where it was. With the list resting at the END
    nothing scrolls at all: the rows are added above the reader and the bottom is
    already their place. The ask travels as `scrollTo: { row, n, pin? }` and is
    carried out inside the metrics callback, where the box has just measured the rows
    the fold added or took away — `pin: true` (opening) subtracts the pin's height
    (`lead`, shared with the answer-anchor below) from `row` before it becomes the new
    scrollTop; without it (closing) `row` is used as it stands.
  - Following the bottom belongs to a message ARRIVING (`scrollToEnd` on the count of
    questions asked), never to rows appearing above the viewport.
  - **A long answer stops at its first row.** While the answer fits, the list follows
    the bottom; the moment the rows arriving would carry the answer's first row past
    the top (under the pinned question, `MIN_ROWS_TO_PIN`), `ChatMessages` asks
    `scrollTo` for that row once, from the metrics callback — the box then holds its
    `scrollTop` and the rest grows below, the list's own "scrolled up" state. Only
    that CROSSING stops it: the list was at the end with the row in view at its last
    measurement (`following`, false until it has measured once, so a list mounted anew
    mid-answer only looks). So a person who scrolled away keeps their place; one who
    comes back to the end follows the answer from there — the list stops again only
    if the answer's first row is still in view then and later crosses the top. The
    row is the round streaming now (`liveMark`) or the answer's `first` row — never a
    step's, and never one from before the turn's question: the person's last
    `user`/`shell` message (a `!command`'s output does not stop on an older answer) or
    a landed result's `bg` row (a follow-up turn never stops above the result it
    follows); the turn's steps and trail above it scroll away with the question. A held round that turns out to carry a
    call folds into its step row under the held position, and the box keeps that
    position through the shrink, so the next round's answer grows under it (a test
    holds this: it rests on flowtty's box keeping its offset). It counts only for a
    turn the list saw being written (`streaming` with that question the last thing
    sent — a whole answer may arrive in the render that ends its turn, and a resumed
    session is no answer arriving) and only while that turn's message is the LAST
    one, so a background result landing under an answer never trips it.
  - **A block taller than the conversation opens in the pager**, not into the
    conversation. When a click would OPEN a `view`, `tools`, `thinking`, `reasoning` or `summary`
    block (`pageable` in `folds.ts`), the chat measures the block WHOLE — as
    the pager shows it: laid out with `openInFull` (open, a trail's earlier-calls cap
    lifted) and a view at `VIEW_CAPS.lines`, only the block's own message laid out
    (`blockRows`), at the conversation's own width, since the question is whether it
    fits THERE — against the rows the conversation has for it: the list's height from
    `onViewport` at that moment, less the top row the pinned question covers once the
    list is tall enough to pin (`roomForBlock`). More rows than that → the pager; as
    many or fewer → inline, a view capped to its tail. So a view whose whole kept text
    does not fit opens in the pager even when its 20-line tail would have. A run of
    `steps` always opens inline, however tall: it is the conversation's own flow, read
    beside what came before and after it. A group's
    head and a trail's `… N earlier calls` line always open inline (the first opens
    into one-line blocks, the second belongs to a trail that fitted). A ✎ diff never
    folds, so it never reaches the pager. **Only a click opens one**: `^o` opens
    everything inline, the tall blocks included — the pager is for reading ONE block.
    **A y/n or a question comes first**: one arriving closes the pager (where the
    `/context` panel closes too), and while one waits a click opens nothing in the
    pager — it is answered in the conversation, which the pager would cover.
    The pager is drawn in the conversation's place inside the chat's own frame, as the
    session picker is — so it is the same docked, as a window and full, and a docked
    chat's pager leaves the plugin's screen in view beside it; only in `full` mode,
    where the frame is the terminal, does it fill the terminal. `renderChatModal`
    takes it as `pager` (`PagerView`: the rows and the title): the frame's title names
    the block (`N tool calls`, `thinking`, the command's line, …), its rows are drawn
    by the conversation's own row renderer (`chatRowRenderer`, so a drag copies the
    text and never the gutter or the `│ ` bar) in a `<ScrollList scrollbar>` laid out
    at the conversation's width (`rowOpts`, the width it was measured against), the
    pager's keys take the hint row, and the plan, the queue line and the field are not
    drawn. The conversation's list stays mounted under it with `display: 'none'`
    (`hidden`) and `isActive: false`: PgUp/PgDn and the wheel are the pager's, and Esc
    returns to the conversation exactly where it was, the block still folded. It is a
    reader: the chat's key handler takes every key while it is drawn
    (`pagerShownRef`) — Esc closes it, anything else does nothing, so nothing reaches
    the field, the folds or the model — and `mouse()` folds nothing, so a drag is the
    pager's selection. A press follows the chat's ordinary focus rules (`pointer`): on
    a docked chat's plugin side it hands the keys to the plugin, and the pager stays,
    as the picker and the `/context` panel do — drawn with the idle border, its list
    `isActive: false`, the wheel over it scrolling neither it nor the conversation it
    hides — and is live again once a press or Ctrl+] brings the keys back. Opening the
    picker, closing the chat, `/clear` and `/resume` drop it. Its state is the fold id
    (`pager`); a block whose id does not resolve draws no pager and holds no key.
- **A turn is drawn in the order it happened** (`src/assistant/step.ts`, pure; the chat
  owns the parts and the view lays them out). A whole turn is one assistant message,
  its `parts` kept in the order they happened rather than grouped by CATEGORY: laying
  out by category — a step line, the text already shown, every ✎ diff of the turn,
  then the answer — would move a round's text that turns out to carry a tool call into
  the "shown" slot, above EVERY diff of the turn, so a tall diff scrolls off the
  screen and its ✎ block looks like the last thing on it, as if a second write had
  happened. The message carries its `parts` in order — the text of each round that
  went on to call a tool (a STEP), the calls (`tools`, from `onToolRun` as each call
  ends) and each change a write reported — then `live` (the round being written) and
  `content` (the answer):
  ```
    ▸ I will change b to 42.
    ✎ clone/app.ts · +1 −1
    (diff)
    ▸ All clear, nothing else uses b.  (2 steps)
    ▸ 2 tools: datetime ×2 · ^o
    ▸ Now the test.
    ✎ clone/app.test.ts · +1 −1
    (diff)
  ƒ Done: b is now 42.
  ```
  - **A round's text never moves.** While it streams nobody knows what it is, so it is
    drawn in full, DIM, with a live mark (the spinner) in the gutter — never the
    answer's `ƒ`. The moment a tool-call fragment arrives (`onRoundKind` — `agentChat`
    reports it on the first fragment, long before the round ends) it is a step, and it
    joins its run where it stands. A round that ends with no call is the answer: the
    same rows, now under `ƒ` and in the normal colour — drawn exactly as the model
    wrote it (`answerText`), so a `Next:` it held reflows by a word there and nowhere
    else.
  - **Steps come in runs, and calls stand where they were made.** A step's own calls
    — the calls of its round, right after it — are the step's: they sit inside its run
    (opened, a line per call under the step) and do not end it, or no two steps could
    ever share a run. Calls no step made (a round that wrote nothing, calls after a
    change) are a trail of their own — `▸ 2 tools: read_file ×2`, opened to a line per
    call — and end a run like a ✎ change or a command's block (a message of its own)
    does. Consecutive silent rounds share one trail; a silent round after a step's
    calls leaves an empty step first (`endRound`) so its calls are not taken for the
    step's. Under the answer only the quiet line stays: how long the turn took,
    `stopped (Esc)`, what it cost. **That line is the turn's LAST row.** A turn
    stopped, failed or cut at a limit while a call's block (a command's, a view's) was
    its newest message, or right after a queued message reached the model, has no
    message of its own under it — so `runTurn`'s `finally` puts the line on a fresh one
    rather than on the message above. A call still running at Esc finishes before the
    turn ends (`agentChat` awaits it), so its trail line, its ✎ mark or its diff lands
    above the label.
  - **`step` (the default) folds each run to ONE dim row** at the place the run began:
    `▸ ` + the newest step (its last finished sentence, else its first line) and, for
    more than one, `(N steps)` — no count for a run of one (`runRowText`). The row is
    chrome (`selectable: false`) and exactly one terminal row, the summary cut so the
    count always fits. When a new step joins a run the row stays where it is and only
    says more; the step's own streaming rows go into it. Each run is a fold of its own,
    `foldId(at, 'steps', n)` — `n` is the run's number within its message, which never
    changes as the turn grows because parts are only appended. A click opens that run
    alone: every step in full, dim, where it happened (a click on any of its rows
    folds it again); `^o` opens and closes every run with everything else. A folded
    run carries marks after its text so what happened inside is seen without a click:
    `✗` when one of its calls failed or was declined, `✎` when a write ran and showed
    no diff — both in the run's TONE (`trailTone`, pure, `src/assistant/step.ts`): red
    when a failed call was never followed by a later, successful call (`ok`/`applied`)
    of the SAME tool — a failure nobody recovered from — yellow when it was, the normal
    colour when nothing failed. A write never moves the tone, only adds its own `✎`, in
    whichever colour that is — it no longer turns the row yellow on its own. An open
    trail's own header (`▾ N tools:`) takes its colour the same way, over every call it
    holds; the rows' cache key changes through the message's own identity (below), the
    tone is never baked into it. The summary is cut to leave the marks room. Every cut
    in the chat's chrome counts cells per
    grapheme cluster, as the grid draws them — `cutStep` / `cellWidth` in
    `src/cells.ts`, on @flowtty/core's `stringWidth` / `fitClusters`, never a
    per-code-point or `.length` count — so a wide character, a flag or a ZWJ sequence
    never pushes a row onto a second line and a cut never splits one; `cutLeft`
    there is the same cut keeping the tail (a path in the `!` hint row, a ✎ change's
    title), and `headClusters` a cap by COUNT (the pinned question's 60, the y/n
    block's 1000 and 120, a trail's reason) that still cuts between clusters, never
    inside a surrogate pair or a flag. The folded tools summary (`toolSummary`), the text-only help's usage
    column (`helpText`), a view's rows (`frameView`) and the start screen's columns
    are measured the same way. A trail is
    numbered the same way (`foldId(at, 'tools', n)`, its cap `calls` with the same
    `n`), a step's own calls included, so an id means the same in both modes.
  - **A waiting question lights the run that led into it.** While a conversation's OWN
    question is pending (`conv.question` — one question or a wizard, whatever the block's
    shape), the newest assistant message's LAST run, the narration the `ask_user` call
    follows, draws unfolded and at full ink: its steps in full and no `quiet`, so the
    question is read against what brought it on. The turn's older runs, its reasoning
    blocks and its ✎ diffs keep the look they had. The flag is `RowOpts.askPending`, whose
    source is `conv.question` and never the field place's block — a child's ask drawn
    there is not this conversation's, and the child's narration lives in the child's own
    rows (a watched child's rows carry their own flag, from the watched conversation) —
    and it is dropped the moment the question is answered. It is DISPLAY only, not fold
    state: `folds.ts` is untouched and the run keeps its `foldId`, so a click or `^o`
    still decides the folds. Only the
    newest assistant message may draw this way — a view's or a note's message drawn under
    the turn is furniture, not the end of the turn — and the bit is in the `rowCache` key
    for that message alone, so the rest of the conversation keeps its cached rows.
  - **`open` draws every step in full, in the normal colour** — steps do not fold, and
    each step's calls are a trail line under it. The mode is the CONVERSATION's: `plugins.assistant.notes` says where
    a conversation starts, `/notes [step|open]` moves it, nothing is saved, and
    `/clear` and `/resume` come back to the config's answer. The
    modes `fold` and `hidden` were dropped; a config file that still says either reads
    as `step` (`notesMode`), and `/notes fold` is refused. The mode is in the
    `rowCache` key, and so is every run's open bit.
  - **The `Next:` token is never drawn; its sentence is the step.** A model that keeps
    to the prompt writes exactly one `Next: …` line before each call, so hiding the
    line left every step empty. A line starting `Next:` (any case, any markup) is drawn
    without the token — streaming, in a run's row, opened, in `open` (`shownText`). A
    last line that could still grow into one (`N`, `Nex`…) is held back until it says
    what it is. The answer is left as written: `Next: restart the server` there is
    advice to the person.
  - **The reasoning is a block of its own, where the model thought it**
    (`foldId(at, 'reasoning', n)`): a turn keeps each round's thinking as an ordered
    `{ kind: 'reasoning' }` part (`addReasoning` in `step.ts`), so two rounds that
    thought are two blocks with the tool call between them, not one block lifted to the
    top of the turn. In `step` each folds to a header a click or `^o` opens; in `open`
    they are always open. The header is `thinking` while the turn is still running and
    `thought` once it has moved on; a leading `**Title**` paragraph becomes the header's
    name (`reasoningSummary`), and the pager's title is that same header. A session saved
    by a host that kept reasoning only as one field holds no reasoning parts: its
    aggregate `reasoning` draws once, in a `foldId(at, 'thinking')` block, above the
    turn's parts.
  - **Round bookkeeping lives outside the state updaters.** Whether the round being
    streamed carries a call is a field of the conversation (`roundTools`), set by `onRoundKind`, read by
    `onLive` when it FIRES and handed to its updater, reset by `onLiveCommit`. The
    updaters are pure functions of the list, and round state lives outside them: kept
    inside, `onLiveCommit` would read round state an updater mutates synchronously, so
    a round whose tokens and call arrive in one batch could be read before its own
    updater has run — its text lost and the next round taken for it, however the
    network happens to cut the stream.
  - **A round cut off** by Esc or an error keeps its text where it was drawn: a round
    known to carry a call, or one that began with its `Next:` plan (`startsWithNext`),
    becomes a step — drawn as it streamed, the token never; any other is what the
    answer had come to, under the `stopped (Esc)` line.
  - **Sessions keep the parts in order.** A call is kept as the trail draws it
    (`callRun`): its name, its outcome, the first 300 characters of its result, and its
    arguments SUMMARISED (`summarizeArgs` — a string cut to 80 characters, a list as
    `[N items]`, an object as a 40-character JSON cut) — never a write_file's
    `content` or an edit's `old`/`new` in every save (the model's own history, `api`,
    keeps the call as it was made; it is sent it again, and the session's journal keeps
    it whole, its result too). A session file saved by an older host keeps the text of the tool
    rounds (`process`, or `shown`), the turn's `changes` and its whole trail
    (`toolRuns`); it reads as those parts in that order — the text, the changes,
    then the calls as one trail of its own just before the answer, an empty step put
    before it so it is never taken for the step's own calls, and a call that left a
    view dropped since its view message draws it (`normalizeParts`). A part a
    renderer cannot draw, or a "message" that is not an object, is dropped on load;
    `live` and `liveQuiet` are never saved.
  - **The model is asked for the shape, not for silence.** `baseStatic()` asks for ONE
    short line starting `Next:` before a tool call and nothing else between calls, and
    for the final answer not to start with one — telling it merely not to narrate
    leaves it nothing else to write between calls, so it narrates anyway. The sentence after
    the token is the step the chat draws. Whether the instruction holds over a long
    turn, and that it costs no tool call, is a question for a live run
    (`scripts/eval-tool-use.ts`); the e2e test only holds the host to SENDING it.
- **⇧⇥ steps the auto mode** — how much of a turn runs without the y/n (the rules are
  under "What the model can do"). It is one of the chat's own fixed keys, like ⏎ and
  Esc, drawn with `keyGlyph` and NOT in `HOST_DEFAULT_KEYS`: the chat owns the keyboard
  while it is open, rather than letting it fall into the plain Tab's completion, which
  is not what anyone asks for by holding Shift. `/auto [reads|all|off]` does the same in words, and
  a bare `/auto` takes the next rung. The mode is stated on the hint line in the warn
  colour (`auto: writes`; `auto: writes + commands` while `shell.autoRun` is on
  too) as a SIBLING of the hint, not inside it: the left cell becomes
  the running turn's status while an answer comes in, and a mode that disappeared
  exactly while writes were running unasked would be the wrong half of the screen to
  lose.
- **`/model` is the model this conversation runs (models)** — the session's own, kept in
  its file and outliving `ai.model`; the config names what may be chosen, and `/model`
  never writes it (`ai` is the model's own leash). `/model <name>` takes a role of
  `ai.roles`, an id of `ai.models` (an id a role maps to too), or `default` — the
  absence of the field, so the session follows `ai.model` again; `/model` alone opens a
  command panel over the conversation's place whose rows are `modelRows(ai)`
  (`src/assistant/model-roles.ts`, pure): the reset `default (<ai.model>)`, then the
  roles in `ai.roles`' order, then the ids of `ai.models` no role names, each with its
  window (`512k`), and every row whose `model` is the choice made carries its window in
  the `ok` tone — the `default` row while it runs `ai.model`, and each role's row for an
  id roles map to, so two rows can be marked; a pinned id no role names and the
  catalogue no longer lists has no row at all. The cursor starts on the reset; ⏎ takes
  the row under it and closes the panel, Esc closes it and changes nothing. A name the
  config does not know is refused (`no model or role "nope" here (/model lists them)`),
  the line stays as typed for a fix and nothing changes; a switch is one `note` row
  (`model: deep → big-model`), saved with the session (a switch made before anything is
  said goes in with the first save), and the next turn's request carries it — the turn in
  flight sent its own already. The value completes in the field from the same rows,
  labelled as the panel draws them. While a command panel is up the frame's
  heading is the panel's (`ƒ Flow Assist · Model`), with no model.
- A **paste** is one key, `{ name: 'paste', text }` (flowtty's bracketed paste): it
  goes in at the caret with its line breaks kept. It is never decoded into keys, so
  a pasted newline does not send and pasted letters fire no binding — any new
  key handler must keep it that way (match on `key.name`, never on characters of
  pasted text).
- **What a drag copies is decided by two props** — read the whole of it before
  adding a pane:
  - `selectionScope` on every pane and window: a drag that starts inside stays in its
    content rect — never onto the border, never into the neighbour. The chat's frame,
    `frame()` (log, help), the reminder and the host's bottom box (the command line)
    carry it; a `<ScrollBox>` (the conversation, the help's list) and a `<Table>` are
    scopes already. A plugin's panes carry it too (the tracker: the board, each column
    cell, the issue, the info panel, every modal window).
  - `selectable: false` on chrome: the gutter marker (`ƒ `, `› `, `! `/`‼ `, `◆ `), the
    pinned question, the `N tools` line, the hint rows, the input field, the title bar,
    the keycaps panel, and everything the bottom box draws around the typed command —
    the `: ` prompt, the inline offer, the candidate list, the footer hints and the
    toast. The command itself is the one thing down there a drag copies (see "The
    command line").
  - The chat lays markdown out itself (`mdLines`; the person's own text through
    `typedLines`, which sets the same `continues`), so it keeps what `layoutMarkdown`
    marks on each row: a row is the gutter box + a content box carrying
    `wrapContinues` (a wrapped paragraph copies as one line — without it every row
    pastes as its own), the leading `chrome` spans (a code block's `│ `) are
    `selectable: false`, and a `frame` row (a fence label) is taken out WHOLE, row
    box and all — otherwise its blank cells come back as an empty line. The `▍ `
    heading marker is chrome.
  - **The clipboard**: flowtty writes OSC 52 and calls `onCopy` (`renderApp` passes
    it) whether or not a sequence went out. `onCopySelection` handles a DRAG: where
    nothing was delivered (Apple Terminal has no OSC 52) the platform's tool takes the
    text (`copyToClipboard` in `src/assistant/copy.ts` — pbcopy / wl-copy / xclip /
    xsel), then the toast says `Copied N chars` (or why not). It never throws —
    flowtty calls it on the key path. Copies the app makes go through
    `services.copy(text)` (`useApp().copy`, then the tool), and `onCopy` leaves those
    (source `'api'`) to their caller, so `/copy` says what it copied once.
  - **Mouse buttons are not keys.** `mousedown` / `mousedrag` / `mouseup` — and, with
    hover on, `mousemove` / `mouseleave` — reach every `useInput` subscriber;
    `twoPhaseDispatch` drops them before any handler or the host fallback (`isMouseKey`
    in `src/playback/keys.ts`; `isMouseButton` is the three buttons alone). A move comes
    at every cell the pointer crosses, so it must cost nothing on the host's path: it
    disarms no Esc, answers no y/n, reaches no remote plugin and redraws nothing — the
    chat's `mouse: true` handler hears it and returns `false` without touching the press
    it may be waiting to see released. Handlers were written
    for keys: the y/n pause and an open question swallow every key, Esc Esc is
    disarmed by "any key", the command line's catch-all consumes, keycaps would draw a
    cap per dragged cell, and every consumed key costs a re-render. A new handler
    needs no guard of its own; one that bypasses the registry (a raw `useInput`) does.
    **One handler asks for them**, `mouse: true` on its registration: the chat's, the
    only thing on screen that knows what is under the pointer (the click above). A
    button reaches such a handler and nothing else — not another consumer, not the
    host fallback — and that handler returns `false` unless it actually acted, so a
    drag still costs no re-render a cell.
  - **Hover** (`src/config/mouse.ts`): with `ui.mouse` on and `ui.hover` not false the
    backend is opened with `mouse: { hover: true }` (any-event tracking; the TTY
    backend coalesces the moves to one per cell), and what a click acts on is underlined while
    the pointer is over it — flowtty's own hover look for its components, so a
    plugin's `ListSelect` and the host's rows read the same. Underline, not brightness:
    the rows it marks are the chat's dim chrome, and brightening them would read as the
    answer's text, while an underline is a look nothing else in the chat uses on its
    own. Which rows: a chat row with `foldLine` (set where the rows are built — a folded
    block's one row, the `▸ N tools` trail head, a folded run of steps and a group's
    head, a thought's header, a command block's first row and its `… N lines cut`
    row, `… N earlier calls`, the `/compact` summary's row); the body of an open block
    closes it on a click but never changes under the pointer. A fold line with hover on
    is drawn by `FoldLine` (`views/modals.ts`), its own component with flowtty's
    `useHover`, the hover props on the row's own outer box (a wrapper would change what
    a drag copies): entering or leaving it re-renders that row alone, and the row cache
    (`messageRows`) never hears of the pointer. The pager draws the same rows with hover
    off — a click there folds nothing. The session picker's and a command panel's rows
    (`ListRow`) take a click through `onClick` on their own box that puts the cursor
    there, as ↑/↓ would (never ⏎'s open; the picker only in its list mode), and are
    underlined under the pointer too. `ui.hover: false`, or the mouse off, draws no
    hover props at all — the test backend delivers moves whatever the mode, so the
    rows, not the backend, are what holds it; a `mouseleave` clears it (flowtty).
  - **flowtty's `onClick` beside the chat's own click.** The chat maps a click to a fold
    by hand (`mouse()` and `foldAt` in the chat: press, release in the same cell within
    `CLICK_MS`, the row under it by the viewport's arithmetic). flowtty's `ScrollList`
    `onRowClick(index)` does the same hit-testing from the committed frame and would
    replace `foldAt` and the press bookkeeping; its press is withheld from every input
    handler, which is fine once nothing else reads it (the pointer is told through
    `HostKeyPath.pressed`). Not done: the working click code stays as it is until it is
    rewritten on its own.
  - Tests: `backend.mouse('down' | 'drag' | 'up', x, y)` (and `'move'` / `'leave'` for
    hover, `src/__tests__/hover.e2e.test.ts`), then read
    `backend.clipboard`; `backend.clipboardAvailable = false` stands for Apple
    Terminal (`src/__tests__/copy.e2e.test.ts`).
- **A plugin's command is the chat's too when it says `chat: true`**
  (`pluginChatCommands` in `src/plugins/assistant.ts`, read from `host.commandRegistry`
  by its bare name; a name the chat's own commands have stays theirs, the first plugin
  to claim a name keeps it). `runChatCommand`'s `default` runs it with the chat's ctx —
  `surface: 'chat'`, `say` (a `note`, display only), `error` (the error line, where a
  throw or a rejection lands too), `showMessage`, `openPanel`; the `:` line's ctx says
  `surface: 'line'`. It completes and is kept in ↑/↓ by its own `values`, `complete`
  and `history`, and the unknown-command line lists it.
  **Its panel** (`ctx.openPanel(spec)`, `src/assistant/command-panel.ts`, pure; drawn by
  `renderCommandPanel` in `src/views/modals.ts`) stands in the conversation's place
  under the picker's rules: it opens the chat and takes the keyboard, a pending y/n or
  question is drawn over it and answered first, it holds every key while drawn (↑/↓,
  Esc, the spec's own keys — `up`/`down`/`escape` are never the plugin's, and a key may
  spell a chord like `ctrl+d`, which fires only with that modifier held), a mouse
  button and the wheel never reach the conversation it hides, and closing the chat,
  `/clear`, `/new`, `/resume` and opening the picker drop it. A row's `kind: 'group'`
  is a dim group header (`id: 'group:…'`): the cursor moves over it and no key runs on
  it. `rows()` is read at every
  draw and a 1 s tick redraws it while up. A spec's `onCursor(id, index)` observes a
  cursor move and `onDrop()` a drop WITHOUT a decision (never a key's `run`), where a
  preview laid on screen is put back (`/theme`). A key's `run(id)` may answer a line (the
  notice), a spec (opened over it, Esc goes back) or a promise of either; an answer
  that lands after its panel went is dropped.
  A spec's `look: 'bottom'` draws a strip over the chat's bottom instead of the window:
  exactly 12 rows (the frame, the tab strip, an 8-row list window and the hint), no
  padding and no gaps, the chat's width, its last row on the area's last row, and its
  message takes the hint row's place. `'window'` (the default) keeps the panel in the
  conversation's place. `tabs()` is read at every draw: ONE row under the top border, a
  label per tab cut by cells, the current one inverse, and the strip names the keys
  that walk them (`←→ tabs`, `↑↓ pick`, the way out first). A key def marked `reset` hands its
  flag with its answer (`panelAnswer(state, answer, reset)`): once the key's `run` has
  answered without opening a panel, the cursor lands on the first row a key can run on
  — the row `panelStart` opens on.
  **`services.chatNote(text)`** is a plugin's news from outside a command: the chat
  publishes `note` on `store.chat`, and the App binds the service PER PLUGIN (an own
  prop of the plugin's services view) with `[<plugin>] ` in front, so no plugin's note
  passes for the host's; it goes to the session whose work says it (`workHome()`), else
  to the one on screen; during a turn it waits in the conversation's `laterNotes` and is said under
  the answer, where the project's instructions note is — and so does a command's
  `ctx.say`, prefixed the same way. **`services.setConfig` / `unsetConfig`** are bound
  per plugin too: `setConfigValue` / `unsetConfigValue` with every plugin's schema,
  refused for any key not at or under `plugins.<that plugin>` (`ownSettingsRefusal`,
  `src/runtime/services.ts`) — never `ai.*`, `shell.*` or another plugin's — and an
  unset's key checked against the schema (`configSchemaAt`).
- **The field completes inline, through the `:` line's own `lineView` / `lineTab`** —
  one vocabulary: the untyped rest of the offer after the caret in the dimmed accent,
  its label beside it, the other candidates as `⇥ a · b`, Tab taking the offer and then
  walking the rest. What is offered is `chatComplete`'s (`src/config/fieldcomplete.ts`,
  pure): a `/command`'s name in the declared order (a bare `/` lists them all), then
  its argument from `CHAT_COMMAND_DEFS`' `values` — `/auto reads|all|off`, `/notes
  step|open`, `/mode panel|window|full`, `/model` the names the config knows (the panel's
  own rows, read when the field is drawn), `/memory project|global|forget|accept`, and `/resume` the saved sessions by number,
  newest first, each labelled with its title (`chatCommandDefs`, bound where `sessDir`
  is known and read when the field is drawn) — the picker (`/sessions`) is the way to
  find one by what was said — or, at a non-zero bang level, the last
  word as a PATH under the shell's directory (`completePath`): `~` is the home, a
  directory gets `/`, hidden entries only for a word starting with `.`, a name with a
  space escaped `\ `, and nothing outside `shell.roots` by REAL path — the listed
  directory itself, and any link that leads out (`dirAllowed`'s rule; only the
  directory and its links are resolved, never every entry). `/cd`'s own argument
  (`chatComplete`'s `CD_ARG`, checked before `completeSlash`) completes the same way,
  `dirsOnly: true` on `PathDeps` so a file is never offered. The listing and the
  real-path check are injected (`listDirectory`, `realOf`), so the tests use a
  directory of their own. Only with the caret at the end of a one-line field; the walk
  is `tabRef` (a `TabWalk`), over the moment the field is anything else. In the field,
  dim means "offered, not yours yet" — the person's own text is never dimmed, on
  either side of the caret.
- **`/cd <dir>` is the person's own move, typed rather than asked of the model** —
  `runChatCommand`'s `cd` case in `src/plugins/assistant.ts`, resolved by
  `cdChatTarget` (`src/assistant/shell.ts`). It follows `!cd`'s rule, not the model's
  `cd` tool's: relative to the shell's current directory or absolute (`~` the home),
  held to `shell.roots` by the REAL path when any are configured, but free to go
  anywhere when there are none — nobody needs to be asked, since the person typed it
  themselves. `asked` is unescaped first (`unescape`, shared with `fieldcomplete.ts`'s
  own — that module imports FROM `shell.ts`, so the escaping helper lives here, not
  there, to avoid a cycle): a name with a space, typed or Tab-completed as `a\ b`
  (`escapeName`'s own spelling), resolves as the real directory. `!cd` never needed
  this — its text reaches a real shell, which unescapes its own argument; `/cd` is
  never run through one. A refusal names the roots (or says the path is not a directory) and
  leaves the directory where it was. It goes through the SAME `setCwd` every other
  mover does, so the project's instructions are read again and the hint row shows the
  new directory at once. Bare `/cd` goes back to the default (`setCwd(null)`, the same
  one `/clear`/`/new` reset to — the start directory, or the first root); `/cd -` goes
  to `ShellState.previous()`, the directory the last `setCwd` moved FROM (updated by
  every mover, so `!cd`, run_command's own `cd` and the `cd` tool feed it too) —
  re-checked against the roots on the way back, since they may have changed since.
- The **status line** while a turn runs says what happens NOW: a running tool's label
  (`⚙ name(args)…`, `! command`/`‼ command`) pulses through bright colours; once the
  tool ends (`onToolRun`) the label goes. With no tool running the line says a WORD — a gerund
  picked at random for each model request (`Pondering…`, `Brewing…`;
  `src/assistant/verbs.ts`, `ui.verbs` replaces the list) — with the same shimmer as
  a tool's label. It is picked when the request goes out (`runTurn`, then `onRound` for
  the next one) and held in state, never in the render, so it never changes within a
  round, and a new round never repeats the last word. The PHASE is the colour:
  magenta while the model thinks — before the first token, while it reasons, between
  tools while it works out the next call — and the assistant's accent only while its
  text arrives; spelling that out as `thinking…`/`writing…` instead would have
  `writing…` read as a promise of text that is not there yet. The stream callbacks are
  closures made when the message was sent, so anything they READ (the tool label
  they clear) is kept in the conversation (`toolLabel`) beside the state — reading the state there would see
  its send-time value, and a finished tool's label would stay up for the rest of the turn.
  - **The seconds are the running THING's, not the turn's.** They start again whenever
    the line changes hands: a tool the moment it is called (`onTool`), the model's
    round the moment the tool ends (the conversation's `segmentStartedAt`, `beginSegment` in the conversation; its `turnStartedAt` still
    times the turn). One timer from the question to the answer sat at `3m 12s` through
    a build, which says nothing about what is happening. The TURN's total, and what it
    cost, stay on the quiet line under the finished answer (`12s · 3.1k tok`), where
    they are read afterwards and distract nobody.
  - **What the turn costs is said** (`3.1k tok`, `tokensBadge`): every round's prompt
    plus its completion as the provider reports them (`onRound`'s `usage`), added up
    for the turn. It is not `ctx N%` beside it — that one is how big the NEXT request
    is, from the last round alone (the conversation's `usage`, the context meter). A provider that
    reports nothing shows no figure: an estimate that moved on its own would be worse
    than none, and nothing here is estimated.
- **The tool trail is condensed and capped** (`condenseRuns` / `TRAIL_ROWS` in
  `src/views/modals.ts`). One dim line per call earns nothing past a handful: a turn
  that runs to the round limit would print dozens of them, turning the screen into a
  sheet of grey with the end of the turn lost in the middle of it. Consecutive calls of the
  same tool that ENDED the same way are one line with a count (`read_file ×12`) — a
  different argument is not a different line, the arguments are in the log — while a
  call that FAILED keeps a line of its own with its reason, which is how a person
  knows why an answer is thin. A turn has a trail wherever it made calls no step made
  (see "A turn is drawn in the order it happened"); a step's own calls are drawn
  condensed the same way inside its run. An open trail shows its last `TRAIL_ROWS` (12) lines
  over `… N earlier calls`, which only a click opens (see the fold model above). The
  folded summary (`toolSummary`) carries the counts too and is cut to the width —
  every `ChatRow` is one terminal line, and fifty tool names would take two.
- **One look for every host modal** — the chat's: `frame()` in `src/views/modals.ts`
  (round border, the modal palette, a plain title) and a quiet hint line at the bottom
  saying how to move and how to get out. A modal that draws its own frame instead
  doubles up, so one product looks like two.
  - **A window that paints its own ground sets its own ink**: `color: m.text` on the
    window box (the chat, `frame()`, the reminder, the keycaps panel), which every text
    with no colour of its own inherits (flowtty ≥ 1.0.0-alpha.16). Left to the
    terminal's foreground, a light terminal theme drew black on the black window.
  - **The palette follows the terminal's scheme** (flowtty ≥ 1.0.0-alpha.17):
    `themeFor(scheme)` and `modalColorDefaults(scheme)` in `src/playback/theme.ts` give
    dark (DEFAULT_THEME), light and unknown (`'default'` grounds and ink). The App reads
    `useColorScheme()` and, on a change, re-resolves the theme INTO the same
    `config.theme` object — plugins hold it — before rendering; the person's
    `config.theme` goes on top of every scheme. A new colour goes into all three
    palettes, and a ground a plugin paints is a `${token}`, never a literal.
    `bootApp` starts the e2e tests on a dark terminal (`opts.scheme` for another).
  - A modal is **as tall as what it holds** and never taller than the screen; what does
    not fit scrolls (`<ScrollBox scrollbar>` — the bar is how a person learns there is
    more).
  - **The log** stamps each entry with its time (`services/log.ts`), and what a line IS
    decides how loud it is: a failure red, `[bg]` the background's colour, the
    model-round bookkeeping and the stamp dim.
  - **The help** answers two questions — which keys, which commands. Keys are drawn
    with `bindingGlyph` and split in two: the ones the HOST acts on anywhere — the
    assistant's `chat` and `sessions` included, whose keys work on every screen —
    (`HOST_ACTIONS`), and the ones that belong to a plugin's own screen (`prev`, `next`,
    `open`, … — the host only gives them a default). A key in a help list is an
    instruction, so a key that does nothing here is not listed as if it did.
    `helpEntries` gives one entry per word a person types: a plugin's `core:quit` and
    the host's `quit` are the same word, and the described one wins.
  - A modal opened by a key names that key in the footer through `keycaps` (`L log`),
    and the flag the footer reads is patched synchronously AND followed by `notify()`
    on close as well as on open — the host draws the footer before the plugin re-renders.
- Every host modal is centred on one full-screen layer, `overlay()` in
  `src/views/modals.ts`, which carries `backdrop: 'dim'`: the screen behind a modal
  keeps its characters and colours and steps back. A new modal uses `overlay()` —
  do not rebuild the absolute box by hand (there were four copies of it). The one
  exception is the docked chat, a plain box in its panel (see "Where the chat is").
  - Rows are cached per message OBJECT (`rowCache`, a WeakMap). It is correct only
    because the chat replaces a message and never mutates one — keep every
    `setRows` that way.
  - The last question, once scrolled out of view, is pinned as an OVERLAY — an
    absolute child of the box, over its top row — so pinning never shifts the rows
    being read. Needs flowtty ≥ 1.0.0-alpha.9 (before it, an overlay and the
    `scrollbar` vanished under any ancestor with `padding`). It is not pinned when
    the box has fewer than `MIN_ROWS_TO_PIN` rows.
- The field's EDITING is flowtty's `editorReducer` (`multiline`, ≥ 1.0.0-alpha.8),
  called from the chat's key handler after the chat's own keys (Esc ladder, Tab
  completion, history, `details`); its geometry (`inputRows`, `caretPosition`) draws the
  rows in `inputVisualRows`. So caret motion by character / word / visual row,
  Home/End and the kill bindings per line, paste and the newline keys are NOT host
  code — do not re-add branches for them. The reducer answers `submit` for a plain
  Enter; what submit means (send, queue, run a `/command`) stays here. A field the
  host draws elsewhere takes the same reducer rather than a little editor of its own:
  the `ask_user` block's free-text row does (single-line, `askFieldWidth` shared with
  its render the way `chatFieldWidth` is with this one).
  - `<TextArea>` itself is not mounted: the host has ONE key dispatcher
    (`useInputHandler`), and a mounted field would be a second listener.
  - The caret (`cursor`) is a **UTF-16 index into the value, resting on a grapheme-
    cluster boundary** — flowtty's unit. `value.slice(0, cursor)` works; `Array.from(value)`
    indices do not. Columns are counted in display width, so a wide cluster (an emoji,
    a CJK character) takes two. What is DRAWN goes the same way back: `inputVisualRows`
    turns the caret's column into an index with flowtty's `rowIndexAt` and draws the
    whole cluster there (`nextGrapheme`) inverted — the chat's field, the `ask_user`
    field and the picker's filter and rename fields (`pickerField`) alike — so a wide
    character before the caret never moves it a cell, and the caret never lands inside
    a cluster.
  - Newline keys: **Shift+⏎** where the terminal tells it from ⏎ (the kitty keyboard
    protocol, below under CLI), **Alt+⏎** — the hints name both, Shift first — and
    backslash-then-⏎, which works everywhere (docs/usage.md, "New lines").
  - In a draft ↑/↓ move the caret between rows; they walk history only while the
    field is empty or shows an untouched history entry.
  - `chatFieldWidth(width)` is the one place the field's width is computed — the
    view and the key handler must agree on it, or ↑/↓ land in the wrong column.

