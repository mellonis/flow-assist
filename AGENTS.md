# flow-assist

A standalone, **domain-agnostic** TUI/CLI assistant host. It has no notion of
"issue", "board", or "sprint" in its core, and none of any company's systems. Functionality is delivered as
**plugins** that register surfaces, commands, keybindings, LLM tool groups, and
config schema. The bundled `gitlab` and `repo` are tool-group-only plugins; a
plugin with surfaces (views, modals, keys) lives in its own repository and is
dropped into `plugins-available/`, which ignores everything not bundled.

## Language rule

Specs, implementation plans, and **code comments are written in English**. Russian
comments from ported source are translated during the port and are never left in
the new tree. The host's own UI — the chat, its hints, its status line — is
English throughout; a half-translated screen is worse than either language.

## Stack

- TypeScript **7.0.2** (native `tsc`), module `NodeNext`, target `ES2022`, `strict`.
- Bun **1.3.x** — `bun run`, `bun test`. The TUI runs as `bun src/cli.ts`.
  **A `bun build --compile` binary WORKS, given plugins are shipped BUILT** (probed
  end to end on Bun 1.3.14, 2026-09-21: pack → install → the compiled host draws the
  tracker's board). The one limit: inside a compiled binary a runtime `import()` of
  an on-disk package fails with "Cannot find module" when that package's
  `package.json` has an **`exports`** field — scoped or not, string or conditions
  (`main`-only packages and deep paths resolve). So a plugin run from SOURCE with its
  own `node_modules` is skipped by the binary; a plugin bundled into one file has no
  on-disk package left to resolve, and loads. It was never a two-React problem —
  plugins take hooks from `ft` and import only types from React.
- **Where the program finds its plugins and `.env`** (`src/install.ts` on the pure
  `src/loader/install-root.ts`). The root holding `plugins-available/` +
  `plugins-enabled/` is the first of: a source checkout (one up from `src/`, never
  the binary's virtual `bunfs`), `dirname(realpath(process.execPath))` — the directory
  a compiled binary is installed in, through a link to it — and the working directory,
  which is also what gets reported when nothing is found. Both plugin dirs must exist
  for the first two. Bun reads `.env` from the working directory only, so when the
  root is elsewhere `<root>/.env` is loaded too, never overriding a variable already
  set (not under `NODE_ENV=test`). `install.ts` is `cli.ts`'s FIRST import: the config
  directory is fixed when `config/load.ts` is evaluated, so a `.env` loaded from
  `main` would reach only half of the program. No enabled plugin is never silent:
  `noPluginsNote` says where the host looked — on the start screen (in the plugins'
  place), in the log, after `plugins ls`, on stderr of a one-shot prompt.
- **A published plugin ships no `node_modules`** (`packPlugin` in
  `scripts/publish.ts`). With dependencies it must have a `build` script that bundles
  them into `package.json`'s `main` (React and flowtty external — the host provides
  them); publishing runs it and ships the build without `src/`. No dependencies →
  the sources ship as they are. Dependencies and no `build` → publishing refuses. The
  loader takes `main` first and falls back to `src/` only when it is missing, which
  is what a working copy in `plugins-available/` relies on — so a `dist/` left behind
  by a local build is what the host loads, and a test that mocks one of the plugin's
  dependencies no longer reaches it. `files` in `package.json` (as npm reads it)
  names what ships, beside the manifest and `package.json` — for a plugin whose
  directory also holds what it is built from (a client package of a workspace).
- **A plugin kept in a repository of its own** is linked into `plugins-enabled/` from
  wherever it lives, and it takes React, flowtty and the host's sources for its tests
  through links to this checkout's packages (one React, never two). `bunfig.toml`
  keeps `bun test` here out of `plugins-enabled/`: such a plugin's tests run in its
  own repository.
- React 19 + `@flowtty/react` / `@flowtty/tty-backend`, zod 4.

## Repos

- `flow-assist` — this host. Plugin sources live under `plugins-available/`, each a package with its own dependencies; the host never imports a plugin or a plugin's dependency.

## Layout

```
flow-assist/
├── package.json               # host; workspace root for plugins-available/*
├── docs/
│   ├── plugins.md             # "Writing a plugin" — the contract for plugin authors
│   └── demo/                  # the README's GIFs
├── examples/
│   └── notes/                 # the plugin docs/plugins.md builds; run by the host's tests
├── plugins-available/
│   ├── gitlab/                # glab_api tool group (no UI)
│   ├── mcp/                   # tools of MCP servers, over HTTP or stdio (no UI)
│   └── repo/                  # list_dir/read_file/search/git_* tool group (no UI)
└── plugins-enabled/           # symlinks → plugins-available/*, gitignored
```

`docs/plugins.md` is the plugin contract as its authors read it, and
`examples/notes` is the code it walks through
(`src/__tests__/example-notes.e2e.test.ts` runs it). A change to the contract below
updates the page and the example in the same commit.

A plugin lives in `plugins-available/<name>/`, ships a `manifest.json` (name,
version, description, `deps`, `surfaces`, `tools`), and is enabled by symlinking
it into `plugins-enabled/`. At load time the host qualifies every registry key
with the plugin namespace (`<plugin>:<view>`, `<plugin>:<tool>`), while display
labels keep short names.

## Plugin contract (`shape`)

A plugin module default-exports `build<Name>Plugin({ renders, config, make, z })`.
The builder may be **async** — the loader awaits it — for a plugin whose tools are known
only after it has asked someone (the `mcp` plugin connects to its servers first, over
Streamable HTTP or, for a server that is a command, its stdin and stdout); it is
the plugin's job to bound that wait, since the app starts after it. `z` is the host's
zod: a plugin with no bundler, and so no runtime dependencies (the compiled binary
cannot import a package from disk), still declares its `configSchema` with it.
`make(name, shape)` injects `config.plugins.<name>` and qualified keys. The
returned `shape` has optional: `commands`, `keys`, `keyActions`, `views`,
`surface`, `modals`, `colors`, `modalColors`, `configSchema`, `components`, `tools`,
`services`, `aiTools`, `keycaps(ft)`, `entry`, `setup(ft)`, `chatSubject(ft)`,
`afterWrite(ft)`. `components[slot] = (ft) => Component`;
`services` expose host services through `ft.services` — the host wins on every
key it owns, a plugin's same-named key never clobbers it. `setup(ft)` runs once,
before any of the plugin's components mount (it is where a plugin seeds its store). Tool groups are delivered by plugins — there is
**no** `tools-available/` → `tools-enabled/` repository; `ai.disabledTools` is
the blacklist.

- **`modalColors`** — per modal the plugin draws, what its palette differs in from
  the host's modal base (`{ relation: { border: 'blue' } }`). `resolveModalPalettes`
  (`src/playback/theme.ts`) lays it on the base into `theme.modals.<modal>`; the
  person overrides it with `config.plugins.<modal>.colors`. The host's own palettes
  (`MODAL_COLOR_DEFAULTS`) cover only the modals the host draws, and a plugin's
  same-named palette never replaces one.
- **The chat asks the plugins; it knows no plugin's data.** Each plugin's
  `services` are its own (a per-plugin view over the host's), so the chat cannot
  read another plugin's state — which is why two hooks are part of the shape, called
  with the plugin's own `ft`:
  - `chatSubject(ft)` → a short id of what the plugin's screen is about now (the
    tracker: the open issue), or `null`. The first plugin to name something wins. The
    chat's title shows it (`ƒ Flow Assist · ABC-1`), and opening the chat on a
    different subject starts a new session (the old one stays on `/resume`); the
    session saves it as `subject` (older sessions wrote `issue`, still read).
  - `afterWrite(ft)` → called, for every plugin, after a chat turn in which a write
    tool was confirmed and APPLIED (not declined, not failed): reload what you show,
    or an open document keeps its text from before the write. It may return a
    promise; a rejection is logged as `[<plugin>] refresh after a write failed: …`.
  The host reaches them as `services.chatSubject()` / `services.afterWrite()`
  (bound in `runtime/app.tsx`).

### A plugin that starts a process owns its life

The `mcp` plugin starts a server given as a `command` and talks MCP over its stdin and
stdout (`plugins-available/mcp/src/stdio.ts`). One process per server for the whole run —
process-level state on purpose, unlike a conversation's — and the rules any plugin that
spawns something long-lived follows:

- **It never keeps the program alive.** The child and its pipes are unref'd, so
  `config set plugins.…` and a one-shot prompt still exit when their own work is done
  (`plugins ls` and `config get` load no plugins at all and spawn nothing; a
  `plugins.*` key does, because a plugin's key is validated by the plugin's schema). A
  request in flight holds the program through its ref'd timeout timer — without one a
  one-shot prompt could exit in the middle of a call whose answer was on its way.
- **It ends with the program.** `process.on('exit')` covers `:quit`, Ctrl+C in the app
  and a command running out of work; a signal ends a program WITHOUT that event, so
  SIGTERM/SIGHUP/SIGINT are heard too.
- **A signal handler must not swallow the signal.** flowtty decides whether to re-raise
  one by COUNTING listeners — with a second listener present it unmounts and leaves the
  signal to the app, and the app would then live through Ctrl+C. So the handler stops
  its processes, removes ITSELF, and re-raises only when no listener is left.

### A handled key is followed by a redraw

A plugin usually keeps its state in ONE component (a workspace that publishes it on
`ft.services`) and draws it in a SIBLING. A React `setState` in the first re-renders
the first only; the sibling redraws when the host re-renders. That used to require an
explicit `ft.notify()` in every setter, and a setter without one — the tracker's info
panel cursor, `setPanelIdx` — changed the state and froze on screen. It looked
intermittent: while related issues were still loading, each arriving name called
`notify()` and so "showed" the pending key presses; once loading finished, the cursor
stopped moving.

The host guarantees it: `useInput` in `runtime/app.tsx` calls `notify()` after every
key that was handled (`twoPhaseDispatch` returned true). React batches it with
whatever the handler set. A plugin still calls `ft.notify()` for changes that do NOT
come from a key — a fetch that finished, a timer.

### A plugin is a guest: whose screen it is

The app opens on the HOST's start screen (`src/views/home.ts`: the ƒ mark drawn
large, what can be done from here, the enabled plugins). flow-assist grew out of a
tracker TUI and for a long time still opened like one — every plugin component
mounted from the first frame, so the tracker's board drew "No board data" over an
assistant nobody had asked for a board.

- A plugin's **surface** — its own full screen — is the component slot named `view`,
  or named after `shape.surface`. Every other slot (modals, key triggers, the
  workspace that feeds them) is furniture and is always mounted, which is how a
  plugin's own key (`c`, the board picker) works from the start screen.
- The surface is mounted **only while the plugin says its context is active**:
  `keycaps(ft)` non-empty. That is the existing contract of `keycaps` ("returns `[]`
  when its surface is inactive"), so a plugin needs no new API to be a good guest. A
  plugin with a surface and no `keycaps` cannot say, and is shown always.
- Over a guest's surface the host keeps its title bar; on the start screen it does not.
- The start screen lists guests in three aligned columns: name · the key that leads
  in · what it is. The key comes ONLY from `shape.entry?: string[]` (action names) —
  a key on screen is an instruction, and listing every key a plugin binds put
  "⏎ open" beside a tracker with nothing open, where Enter did nothing. The
  description is `shape.description`, filled by the loader from the plugin's
  `manifest.json`; a long one wraps inside its column.
- The block is centred on both axes; inside it rows keep a common left edge.
- The start screen draws keys with `bindingGlyph(keys[action])` and offers nothing
  that is unbound.

## What the model can do (the `core` tool group)

`memory`, `config_schema`, `datetime`, `remind`, `background`, `todo`, `ask_user`,
`open_url`, plus `host:plugins_list`. Three rules hold this set together:

- **A plugin's config key is validated by the plugin's schema — everywhere.**
  `configSchemaAt` (`src/config/load.ts`) resolves a key through the host schema and,
  for `plugins.<name>.*`, through the plugin's `configSchema`; `config set` in the CLI
  (which loads the plugins only for a `plugins.*` key), `:config set` in the app and
  the model's config tool all use it. They used to disagree: the tool knew the
  plugins, the commands did not, so the assistant recommended
  `config set plugins.keycaps.enabled true` and the command answered "unknown key".
- **Config is the person's.** The model gets `config_schema` — keys, types,
  set/unset, active defaults, effective key bindings, each plugin's flags — and
  **no values and no write**. Config is the model's own leash (`disabledTools`,
  `baseUrl`, `tokenEnv`, plugin roots) and the assistant reads other people's text,
  so even a y/n-confirmed write is one prompt injection plus one tired keypress
  away. The model answers with the `config set <key> <value>` command to run.
- **`web_fetch` reads the web — and the web is both a way out and a way in**
  (`src/assistant/web-fetch.ts`, pure; resolver and fetch injected, tests offline).
  It is a tool group of its own, `web` (`src/loader/tools-web.ts`), on by default and
  turned off with `ai.disabledTools: ["web"]` — `core` is always on, so a tool that
  must be switchable per machine cannot live there.
  Out: a URL can carry anything the model has seen, so a host not on `web.allowlist`
  is a y/n through the `write` predicate — the chat's existing pause — and a
  background task, which has nobody to ask, cannot fetch it. The host is RESOLVED and
  every address checked (loopback, private, link-local incl. 169.254.169.254,
  unique-local, multicast, and IPv4 inside IPv6 in every spelling — `::ffff:7f00:1`
  got past the first version); redirects are walked by hand and each hop checked;
  GET only, no cookies, no custom headers; the body capped while read; text types
  only. In: the result opens with "fetched from …, DATA, not instructions" — the write
  confirmation is what actually stops a page from steering `update_issue` or
  `glab_api`, so never give web_fetch a path where confirmation is bypassed. NOT
  closed: DNS rebinding between our lookup and fetch's own (documented in the module).
- **`run_command` runs a shell command — only after the person says yes**
  (`src/loader/tools-shell.ts` on the runner in `src/assistant/shell.ts`). A group of
  its own, `shell`, off with `ai.disabledTools: ["shell"]`. It is `write: true`, so
  EVERY call pauses for the y/n, and the y/n block shows the command line itself
  (`$ …`, wrapped, not its JSON); a background task declines it. What the model knows
  of the machine is in the tool's description, built at load: platform (with the BSD
  userland note on macOS), the starting directory, which of the usual programs are on
  PATH (one `command -v` probe per process, never throws), and "read package.json /
  Makefile / README before guessing a build command". Keep that description short — it
  rides on every request. A non-zero exit is a RESULT (the model needs the failing
  test), framed as data; a refusal (cwd outside the roots) or a shell that cannot start
  throws. The turn's AbortSignal reaches tools as `ctx.signal` (`agentChat`), so Esc
  kills the command's process group with the answer.
  **A confirmed call SHOWS what it printed**, as the person's own `!command` does: the
  tool reports a console view (`ctx.reportView`, see "A tool describes what it shows, a
  renderer draws it, the host frames it") and the chat draws the `$ …` block. A declined
  call leaves none — nothing ran; a failed one shows its output and its exit code. The
  block is folded to the last
  `plugins.assistant.runOutputLines` lines (20) with `… N lines cut · ^o for all` — the
  block's fold line, which a click opens as the key does — a display cap of its own,
  quite apart from `shell.maxChars`, which is how much the MODEL is given.
- **Whose claim excuses a y/n, and whose does not.** A tool pauses because its `write`
  flag says so, and the flag is set by whoever is entitled to say it. The `mcp` plugin
  keeps the two apart per server: `trusted` is "I believe THIS SERVER's own
  `readOnlyHint`", `plugins.mcp.servers.<name>.readOnly` is the PERSON's own list of
  that server's tools, named as the server names them, that they checked themselves —
  each of those is not a write and runs without asking. Either claim alone is enough,
  and the second is the only one that helps a server which makes no claims at all (a
  browser's tools carry none). A listed name the server does not offer is said once, at
  start, in the log: a typo would otherwise be a setting that quietly does nothing. A
  rule scoped to an ARGUMENT is a different thing and does not exist yet — a "read"
  that takes a URL can carry data out in it, so it stays on the ask path.
- **How much is asked about at all is the person's lever: the auto mode**
  (`src/assistant/auto.ts`, pure; the chat owns the state). `/auto [reads|all|off]` and
  ⇧⇥ step ask → reads → all. `ask` is where every conversation starts. `reads` skips no
  pause of its own on today's tool set — what the host considers a read (no `write`
  flag, an MCP tool on the person's `readOnly` list) never reached the y/n anyway — it
  is the rung the cycle passes THROUGH, so one keypress cannot land on "every write
  runs", and it is what the hint line then says. `all` answers a write's y/n for the
  person. The mode belongs to the CONVERSATION and is never saved: a restart, `/clear`,
  `/resume` and a change of task all come back to `ask`, and the session file does not
  hold it. Two calls are never automatic in ANY mode — `run_command` (the y/n is its
  only guard, and the command may have been written from a page the model just read)
  and `web_fetch` (one that reaches the confirmation at all is to a host outside
  `web.allowlist`, which is exactly what its write flag tests). A background task is
  untouched: it is handed a confirmation that always answers no, and the chat's mode
  never reaches it; the person's own `!command` is untouched too. The decision lives in
  the one place the chat already pauses — the `confirmWrite` closure — and it changes
  nothing about what `agentChat` asks about: a tool never skips its own write flag.
  What ran under the mode is still shown, the ✎ diff block and the tool trail as usual.
- **The log is the person's too.** No log tool; `/log [N]` shares the tail of the
  host log as the person's own message.
- **`ask_user`** (1–4 questions, 2–4 options each, optional multi-select, an
  "Other…" row the UI always adds) is a pure state machine in
  `src/assistant/ask.ts`; the chat owns only the pause and the render. A
  background task is never given the hook — a question popping up would seize the
  keyboard mid-sentence — so there the tool answers "nobody to ask".
  **Typing starts the answer**: any printable character opens the free-text field with
  that character in it (walking to the "Other…" row first was a step nobody guessed
  at), and a paste on the list opens it with its text. What does NOT open it: `1`–`9`,
  the shortcuts the list advertises — a numeric answer is typed once the field is open
  — and the space bar, which toggles in a multi-select. The hint line states that rule.
  **The field is the chat's own editor**: flowtty's `editorReducer` in its single-line
  mode, so the caret (`state.caret`, a UTF-16 index — `state.cursor` is the ROW in the
  list) moves by character and word, Home/End and the kill bindings work, and a paste
  goes in at the caret with its line breaks collapsed to spaces. Esc leaves the field
  for the list; Esc on the list dismisses the question, as it always did.
- **The memory is the person's too.** The `memory` tool is the model's: a stored fact
  goes into the system prompt of EVERY later request — across `/clear`, across
  restarts. That is its purpose, and it is also why "after /clear the assistant still
  knew my earlier prompt" looked like `/clear` failing: the conversation was gone, the
  memory was not, and nothing said so. So `/clear` reports what it kept
  (`keptAfterClear`), and `/memory` lists and `/memory forget <n|all>` removes — without
  going through the model (`src/assistant/memory-command.ts`). What the host tells the
  person this way is a display-only message of role `note`; `apiHistory` drops it, and
  the model's history (`apiRef`) never holds it.
  - **A fact that rides on every request forever is worth writing well**, so the
    tool's description asks for one durable fact per entry — a preference, a
    convention, a name — as a short sentence that stands without the conversation it
    came from; never task state, a number that will change, or a secret; and before
    adding, list and UPDATE the entry that already says it. The model reads other
    people's text, so a rule that lives only in a description is a rule it may ignore:
    the host enforces the three that can be enforced (`refuseMemory` in
    `runtime/services/memory.ts`, applied by the tool's `add`). A near-copy is refused
    naming the entry it duplicates — text matched with case, runs of whitespace and
    trailing punctuation taken out; an entry over `MEMORY_TEXT_MAX` (300) characters is
    refused with its length; past `MEMORY_MAX_ENTRIES` (100) the tool refuses and names
    the oldest. Every refusal says what to do instead and points at `/memory`. Only
    `add` is guarded: `update` is the remedy the duplicate refusal names, so refusing
    that too would leave nowhere to go (an entry added short and then updated long is
    still open).
  - **Where it is kept is the host's state, not the repo's**: `memoryFilePath(config)`
    → `config.memory.file`, else `memory.json` under `hostStateDir()`. It is resolved
    on every call and never at import — an import-time constant is fixed before a test
    can move it, which is how every e2e test that reached the tool appended to the
    person's own file, 32 copies of one fact.
- **How full the context is, is shown — and says where the number came from.** The
  chat's hint line ends in `ctx N%` (yellow from 80%), and `/context` opens a PANEL in
  the field's place, like a write confirmation — a look at the conversation, not a
  message in it: the window as a field of cells (`⛁` full, `⛀` part, `⛶` free; a part
  that exists at all gets a cell) beside a legend; Esc or ⏎ close it, and it holds
  the keys while up (`src/assistant/context-meter.ts`, pure; the view owns colours). The total
  is the provider's `prompt_tokens + completion_tokens` of the last round when it
  reports usage (`stream_options.include_usage`; a server that refuses the field by
  name is retried once without it and not asked again); until then it is characters/4
  and drawn `~N%`. The split between parts is always an estimate, scaled to the total.
  The window is `ai.contextWindow` (default 200000) — the API cannot be asked for it.
  `/compact`, `/clear` and a change of conversation drop the measurement. `/compact`
  shrinks what the MODEL sees (`apiRef` → a summary in the system context) and leaves
  the screen alone — the display list keeps the conversation and gains a `note` marking
  where the model's view now begins; wiping the screen read as `/clear`. There is no
  `/refresh-context`: the system prompt is assembled anew for every message, so the
  command had nothing to refresh.
- **The plan (`todo`) belongs to a conversation, not to the process.**
  `createPlan()` in `src/assistant/plan.ts` makes one; its owner passes it to the
  tool as `ctx.plan`. The chat holds its own (`planRef`), and `/clear` resets it —
  so does the end of a turn that left every item done (a finished plan otherwise hung
  over the chat as "· N done"); a
  background run gets a fresh one, so its checkboxes never appear among the chat's;
  an eval trial makes one per trial. Only a caller with no conversation of its own
  (the one-shot CLI, a bare `execChatTool`) falls back to the process-wide plan.
  The shell's directory is the same kind of state: `createShellState` in
  `src/assistant/shell.ts`, held by the chat (`shellRef`), handed to run_command as
  `ctx.shell`; a background run gets a fresh one.
  **Tool state that describes a conversation is never module-level** — as a module
  variable the plan outlived `/clear`, was shared with background runs, and leaked
  from one test into the next.
- **A request carries the core tools and an INDEX of the rest** (tools on demand,
  `src/assistant/tool-loading.ts`, pure; wired in `agentChat`). Every tool's full
  schema on every request was ~7k tokens with only the bundled plugins, a tracker
  plugin doubles it, and a turn uses two or three. So with `ai.toolLoading: 'onDemand'`
  (the config default) a request sends the `core` group in full, the tools this
  conversation has LOADED, and `tools_load`, whose description is the index — per
  group, `name — first sentence of the description`. The index does not change as
  tools load (a stable prefix). `tools_load({ names | group })` is the loop's own
  tool, not the registry's; a group's name given in `names` loads the group (a tool of
  the same name wins) — a model passes one there, and refusing it cost a round; what is sent is worked out again for EVERY round, so a
  load reaches the next round of the same turn. A call to a tool that is indexed but
  not loaded is an ERROR naming `tools_load`, refused BEFORE the y/n — the wire-name
  map covers every known tool, not only the sent ones, or that call would not even
  resolve. The loaded set is a `ToolSet` owned like the plan: the chat's `toolSetRef`
  (saved as the session's `tools`, kept by `/compact`, emptied by `/clear` and a
  change of task); a background run and the one-shot CLI start from an empty one.
  `agentChat`'s own default is `'all'` — the mode is applied by `services.chatLLM`
  and `runPrompt` from config — and `bootApp` pins `'all'` so an e2e script can call
  the tool it tests; `tool-loading.e2e.test.ts` opts in. The context meter measures
  `requestTools(...)`, what is really sent. `host:tools_list` still lists every name;
  the index made it mostly redundant.
- **Sessions survive a restart** (`src/assistant/sessions.ts`, one JSON per session
  in `<config dir>/sessions/`, dir 700 / files 600 — they hold tracker and MR text).
  A session is ONE object: the screen list, `apiRef` (what the model is sent),
  `summaryRef`, the plan, the usage reading, the ↑/↓ prompts, the unsent draft, the
  loaded tools (`tools`) and the
  shell's directory (`shellCwd`, re-checked against the roots when used) —
  three views of one conversation, saved together or not at all. Not saved: an answer
  in progress (`live`), a pending y/n or question, the queues. Saves: 250 ms after a
  question, an answer's end, `/compact`, a background result; at once on closing the
  chat, `/clear`, `/resume`, a task change, and at process exit (`flushOnExit`). A
  write is temp file + rename; a file that does not parse is skipped. On start the
  newest session is continued unless `/clear` closed it (`sessions.resume: false`
  turns this off); `/clear` and a change of task start a new one and keep the old on
  `/resume` (`/resume <n>` opens it). The last 400 messages are kept, 50 sessions.
  An image is saved as a ref (`images`, `imageSeq` — see "Images" under The chat),
  never as its bytes; the e2e test asserts the file holds no base64.
  **Under `bun test` with no `sessions.dir` nothing touches disk** (`sessionsDir` →
  null): `bootApp` gives every test a temp dir, and a test that renders the app
  directly must not write into, or continue, the person's own chats. A restored
  screen over an empty `apiRef` looks right and is the bug — the e2e tests assert on
  what the model is SENT after a restart.

A qualified tool name (`plugin:tool`) is translated to a provider-safe wire name
(`plugin__tool`) in `src/assistant/agent.ts` and nowhere else: providers validate
names against `^[a-zA-Z0-9_-]{1,128}$`.

### How a tool gets its name

**The model sees the name the plugin gave** — `get_issue`, `open_issue`, `read_file` —
for group tools (`shape.tools`) and standalone ones (`shape.aiTools`) alike. No plugin
prefix: it is shorter, costs fewer tokens on every request, and the model has no use
for which plugin stands behind a tool. (The loader used to qualify aiTools and not
group tools, so one plugin's tools arrived as both `get_issue` and
`acme-tracker__open_issue`.) The loader neither adds a prefix nor takes one away: a
plugin that wrote `x:tool` itself gets exactly that.

A prefix appears only when it is NEEDED. **A name is claimed once**: the first group to
declare it keeps the bare word; a later group's tool is registered as `<plugin>:<name>`
instead and the clash is said (`[tools] "search" is declared by both …`). The registry
remembers the tool's own name (`ownName`) because that is what the group's `exec`
understands. Without this a clash is silent — the provider's "Duplicate tool name" 400
no longer fires, since `agentChat` sends one declaration per name.

The host's own groups: `core` is bare (`memory`, `todo`), `host` qualifies its names
itself (`host:plugins_list`). Names reach the provider through the wire translation in
`agent.ts` (`:` → `__`).

### A tool argument is hostile input

The model writes every argument, and what it read a minute ago (a ticket, a README,
a web page) may have told it what to write. A tool that pauses for y/n is guarded by
a person; a **read-only tool is guarded by nothing**, so it is the one to check
hardest. Rules the `repo` and `gitlab` plugins hold, each with a test that tries it:

- **A value that reaches a CLI's argv never starts with `-`**, and refs go after
  `--end-of-options`. `git diff --output=<file>` writes a file from a "read" tool.
- **A path check is on the real path, not the spelled one** — a clone may carry a
  symlink out of the root (`realOf` in `repo`, which also handles a path that does
  not exist yet and a dangling link).
- **A configured root is never deleted**, confirmed or not.
- **A write shows what it changed.** A tool that edits text calls
  `ctx.reportChange({ title, before, after })` once the write has succeeded — the
  host gives every call that function (`agentChat`); a caller with no chat (the
  one-shot CLI, a test's bare ctx) gives none, so call it as `ctx?.reportChange?.(…)`.
  The host diffs the two (`src/assistant/diff.ts`, pure: LCS over what is left
  between the common head and tail, 3 lines of context, 80 diff lines drawn and the
  rest counted, a text with a NUL named and not drawn) and the chat keeps a
  `✎ title · +N −M` block with a ```diff fence above the answer, always open — never
  foldable, it is the part of a turn the person most needs to see.
  **How it is DRAWN** is the chat's (`changeLines` in `src/views/modals.ts`): the `✎`
  line is a title, not markdown — plain text, the path in the chat's accent, the counts
  dim — because `changeMarkdown` used to wrap the path in backticks and a path took the
  code style. Each row carries the line it is in the FILE (`diffRows` / `diffLineNumbers`
  in `diff.ts`: a context or added row its number in the new file, a removed row its
  number in the old, counted again per hunk), which is why the `@@` row is left out of
  what is drawn — it exists to say where in the file one is. The numbers are chrome:
  dim, right-aligned in a gutter before the `│ `, and out of a selection, so a drag
  copies the code alone; the block is laid out at the width LESS that gutter, or a row
  would run past its box and stop being one terminal line. The hunks stay whole in
  `ChangeView.diff` — that is what a session keeps, and the header is the numbers'
  only source.
  It is DISPLAY only: it rides on the display message (`changes`), never on the
  tool's result, so the model's history does not grow by a copy of every edit — the
  e2e test asserts on what the model is sent next. A tool that threw has its reports
  dropped. Only the tool knows what "before" is (a file, an issue's description, a
  comment), so the host never guesses it: `repo`'s write_file / edit_file /
  delete_file report (a directory delete and a file over 2 MiB do not).
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
  - **Display only**, as before: a view rides on the display message (a message of
    role `view`, which `apiHistory` drops) and never on the tool's result — the model
    already read the result, and a copy of it in the conversation costs the context
    twice.
- **A shell command is seen before it runs.** `run_command`'s guard is the y/n, not a
  filter on the command; its directory is checked anyway — inside a root by the REAL
  path (`dirAllowed`), a `cd` that leads out is not remembered. `runShell` has exactly
  two callers, `!command` (the person typed it) and `run_command` (the person
  confirmed it); a new caller keeps one of those guards.
- **No "magic" flags**: glab's `--field` reads `@path` from disk; strings go through
  `--raw-field`. Check the same before wrapping any other CLI (`gh api -F` is alike —
  this applies to the planned `github` plugin).
- **A write tool refuses by throwing.** The host counts whatever a write tool
  RETURNS as done (✎ under the answer); "path is required" returned as a string
  read as a change made. Every refusal and every failed CLI call of a write throws —
  `repo`'s write_file / edit_file / delete_file included (an `old` not found, a path
  outside the roots, a directory without `recursive`): a refusal the tool makes
  itself, before touching anything, ends in "Nothing was changed."; an error the
  filesystem throws is passed on in its own words and claims nothing about the disk.
  The read-only tools keep answering with a string.
- **The git writes follow the person's workflow** (`repo/src/git-write.ts`, tested
  on real repos with a bare origin): a branch starts from a freshly fetched
  `origin/<default>` (the default is asked of git — `origin/HEAD`, then probes —
  never guessed); nothing is committed or pushed to the default branch or to
  main / master / develop / trunk; a push is always the current branch to origin
  under its own name — no refspec or remote from the model; no plain force, only
  `--force-with-lease` after a rebase; a sync is a rebase, and a conflict is
  aborted and named, never resolved; a commit without `paths` takes changed tracked
  files only, and its message goes as written. Branch names are checked by
  `git check-ref-format`. git runs with no prompt (`GIT_TERMINAL_PROMPT=0`, SSH in
  batch mode) and a time limit, so a missing credential fails instead of hanging.

### A tool's result is what the model will tell the person

- **A failure is reported as a failure, in the failing thing's own words.** The
  `gitlab` plugin's `glab` runner was a stub that answered `{}` to everything; the
  model made five calls, read five empty objects, and told the person with full
  confidence to run `glab auth login`. A wrapper returns the exit code and stderr,
  says "not installed" when the binary is missing, says "empty body" when it is
  empty, and times out instead of hanging the turn (`plugins-available/gitlab/src/glab.ts`).
- **A tool that can never work is not offered.** `get_feature_context` always answered
  "unavailable" — nothing ever supplied its context — yet it sat first in the list
  and the model called it. A dead tool costs a call, tokens on every request, and a
  wrong turn in the reasoning. Remove it, do not leave it answering "unavailable".

## The conversation the model sees

**The chat's display list is never the model's history.** `agentChat` returns the
turn's `transcript` (assistant messages with `tool_calls`, every tool result, the
final answer) and the chat keeps it in a model-side history (`apiRef`) beside the
display list; `apiHistory()` sends API fields only and never half of a
call/result pair. Replaying only each turn's final text shows the model a
conversation in which state changed with no tool call in sight, and it imitates
that: it narrates the change and guesses at state. `scripts/eval-tool-use.ts`
measured it — 1 tool call in 15 turns with 14 false claims, against 15 in 15 with
none. `/compact`'s summary rides in the system context of every later turn for the
same reason: a display-only system message never reaches the model.

**A turn that did not finish is closed in the model's history too.** The question
joins `apiRef` before the request, so it stays on record whatever happens. Left there
alone after Esc, it read to the model as a question still waiting: the next request
showed two user messages in a row, and the model answered both — going back to the
work the person had stopped. So when `agentChat` throws it hangs the turn's
transcript so far on the SAME error (`transcriptSoFar(e)`; the `name` still says
`AbortError`), and the chat appends it — the tool calls that completed, a write that
landed included; `apiHistory` drops a call left without its result — and then an
assistant message in the model's own voice: `STOPPED_TURN` after Esc (stopped by the
person, not to be resumed unless they ask), `failedTurn(message)` after an error
(it failed, with the error's first 200 characters — a retry the person asks for then
reads as one). The text of the round that was cut off is not kept. The closing
message is model-side only: the screen already says `stopped (Esc)` or shows the
error. It is saved with the session like the rest of `apiRef`
(`turn-end.e2e.test.ts` asserts on what the model is sent next).

**An image is kept as a ref and sent as a part.** `ChatMessage.content` is
`string | ContentPart[] | null`, but content PARTS exist only on the way to the
provider: everywhere the host keeps a message (the display list, `apiRef`, the
session) its content is a string, and a person's message with images carries them
beside it as `images: ImageRef[]` (`{ n, name, path, sha256, mime, bytes, width,
height }`, `src/assistant/images.ts`) — on the display message only their numbers.
`apiHistory` passes a user message's `images` through; `send()` alone turns them into
`[{type:'text'}, {type:'image_url', image_url:{url:'data:…'}}]` (`wireMessages`) right
before `chatLLM`, from bytes read when the image was attached or, after a restart,
read again from the path with the hash checked. A file gone or changed is a `note` in
the chat (once per image) and the message goes as its text + `[image unavailable:
name]`; with `ai.images.enabled` false every image goes as `[image not sent: name]`.
So the session file never holds base64, and the context meter never counts it — it
counts an image by its pixels (`imageTokens`: w×h/750 after the providers' scaling,
1600 when the size is unknown), as a part of its own. `/compact` sends text with
`[image: name]` and the image leaves with the history it replaced; `/clear` drops it.
A provider 400 that talks about images is quoted once as a `note` naming
`config set ai.images.enabled false` — the image stays in the history, so without
that every later message fails too. A background task never gets images.

## The command line

`:` opens it. It completes **inline, on its one row**, as the chat's field does: the
untyped rest of the suggestion after the caret, the other candidates beside it as
`⇥ a · b`; Tab takes the offer and then walks the rest. The logic is pure —
`lineView` / `lineTab` in `src/config/commandline.ts` — and both the drawing and Tab go
through the one `completeLine`. Never add a row that appears while typing: the old
second row of candidates made the whole screen jump with every keystroke. Tab
replaces the WORD being completed (`stem + candidate`), a command name or a
`config get|set|unset` argument alike.

- **A command is its first word**; the rest of the line is its argument. The whole
  line used to be looked up, so every plugin command given an argument was not found
  and did nothing — `:ask hi`, a tracker's `:open ABC-1`. Without an argument they
  worked, which is how it went unnoticed.
- **Nothing is silent.** An unknown command answers `Unknown command: x — try :help`.
  A command that is listed does something: `view` and `back` set a state nothing in
  the host reads and were removed. The host's commands are `clear`, `quit`, `config`,
  `cache`, `help`; everything else is a plugin's.
- **The typed command is text; everything drawn around it is chrome.** A drag over
  the line copies what was typed and nothing else — not the `: ` prompt, not the
  inline offer after the caret, not the `⇥ a · b` candidates — so a long
  `config set plugins.mcp.servers.safari.readOnly …` can be taken out to be fixed or
  shared. It follows the rule the chat's rows follow (the gutter is chrome, the text
  is not): the bottom box used to be `selectable: false` whole and swallowed the
  command with its chrome; only the spans carry the flag now, and the box carries
  `selectionScope` instead — a drag that starts there stays on its row and inside the
  padding, so the layout's own blank cells never come back as spaces around the
  command. The footer hints and the toast, which have that row whenever the line is
  closed, are chrome as they were. A command wider than the terminal is not wrapped
  (the rule above), so a drag copies the part that is on the screen. The chat's input
  field is NOT this: its caret and placeholder sit in the middle of its text, so it
  stays unselectable whole until that is thought through.

## The chat

- Who speaks is said by a **gutter marker and a ground**, not a label: `›` on the
  user ground for the person (the input field's own prompt), `ƒ` for the
  assistant's answer (also signing the frame, `ƒ Flow Assist`), `◆` on its own
  ground for a background result, `$` on the user ground for the person's own
  `!command` and on none for a command the MODEL ran and they confirmed (a `view`
  message) — the same marker in the same colour, the ground saying whose it was. Colours come from `theme.modals.chat` (`accent`,
  `assistantAccent`, `userBg`, `fieldBg`, `bgAccent`, `bgBg`, `warn`, `ok`) and are
  overridable via `config.plugins.assistant.colors`.
- A marker is ONE narrow code point: flowtty's grid counts one cell per code point,
  so an East-Asian-ambiguous glyph (`∮`, `≈`, most of Mathematical Operators)
  shifts the row in terminals that draw it two cells wide.
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
- **⏎** sends; while an answer is coming it **queues** instead (sent in order when
  the turn ends). **Esc**: clear the field → take the last queued message back →
  stop the answer (the line under what came so far says `stopped (Esc)` — a cut-off
  «В» must not read as a whole answer; the model's history gets a closing message of
  its own, see "The conversation the model sees") → arm/close. **Alt+⏎** (drawn `⌥⏎` on macOS) is a newline (`NEWLINE_KEY` in
  `src/views/modals.ts` — the one spelling every hint uses); a blank line is kept.
  ⇧⏎ works too where the terminal sends it (decoded since flowtty 1.0.0-alpha.7),
  but the hint names the key that works in every terminal that has an Alt.
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
    on a modified key had to be hard-coded in its handler — which is what `^r` was,
    `key.name === 'r' && key.ctrl`: unremappable, and invisible to every hint.
  - **Never write a key's symbol by hand in a hint.** Two cases:
    - the action is BOUND (it is in `ft.keys`, so the person can remap it) → draw
      `ft.keyCap(action)`; it is `''` when the action is unbound, and then the hint is
      not shown at all. The host footer (`composeFooterHints`) and the chat's
      `F chat` hint do this. Host-side code uses `bindingGlyph(keys[action])`, or
      `firstGlyph(…)` where an action answers to several keys and the hint should
      teach ONE (`details` takes `^o` and keeps `^r`; `^o/^r` in a line of hints reads
      as two keys to learn).
    - the key is fixed (the chat's own Enter / Esc / Tab) → `keyGlyph(…)`, as the
      `CAP` table in `src/views/modals.ts` does.
    A bundled plugin that still spells caps by hand in its `keycaps(ft)` (acme-tracker)
    shows the default key after a remap — that is the bug this rule prevents.
- **A key acts where it is shown, and is shown where it acts.** Audited 2026-09-21:
  - `x` flushed the cache from the start screen, where the footer did not offer it.
    The hint and the key now read ONE predicate, `cacheInPlay` (`loader/registry.ts`):
    a plugin that keeps data in the cache is on screen. `:clear` works from anywhere.
  - Flushing the cache (`x`, `:clear`) also **reloads what is on screen**: the host
    counts flushes in `services.cacheEpoch`, and a plugin that draws cached data
    reloads when the number changes (`useEffect(..., [ft.services.cacheEpoch])`). A
    flush that left the open board as it was read as a key that does nothing.
  - `b` was answered by the host with "no target (tracker supplies the URL)". The host
    no longer handles it. `openBrowser`, `prev`, `next` and `open` stay in
    `HOST_DEFAULT_KEYS` only as a shared vocabulary for plugins (a plugin reads
    `ft.keys.open`); the host acts on none of them.
  - A test presses every lower-case letter on the start screen and expects silence
    (`home.e2e.test.ts`) — `q` included. **No key quits by default**: a stray `q`
    closed the whole app. Quitting is the `:quit` (`:q`) command or Ctrl+C; the action
    stays in `HOST_DEFAULT_KEYS` unbound (`[]`) so `config.keys.quit` can bind it, and
    the start screen then names the key instead of `:q`. Plugins leave their screens
    on Esc (`keys.back`) only.
- **A capital opens something big**: `F` the assistant (Flow Assist), `L` the log; a plugin's main
  screen should follow (`B` for a board). Lower case is for what is INSIDE a screen.
  A modal is closed by the key it is bound to (`f.keys.<action>`), never by a letter
  written in the handler — the log used to close on a hard-coded `l`.
- **↑/↓** walk the prompt history, only while the field is empty or still shows a
  history entry untouched. The **wheel** and **PgUp/PgDn** scroll.
- **What is open and what is folded** (`src/assistant/folds.ts`, pure; the chat owns
  the state, the view resolves it per block). Everything foldable used to answer to
  one flag: `^r` opened the reasoning, the narration, every tool call of every turn
  and every capped command block at once, so to read ONE command's output a person
  unfolded the whole conversation and folded it back. The model, so that a click and
  the key cannot disagree:
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
    the next turn's tool calls and command output arrive open. `/clear`, `/resume` and
    a change of task all go back to everything folded with no exceptions — the state
    is the CONVERSATION's, like the auto mode, and is never saved.
  - One block does NOT follow it (`isClicked`): the **cap on an open tool trail**. A
    key meaning "open everything" is asking for the trail, not for sixty rows of it,
    and the cap is what keeps an open trail readable.
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
  are tests for each). Mapping a click to a row: every `ChatRow` is one terminal line,
  the conversation reports its rect (`onLayout`) and its scroll (`onMetrics`) through
  `onViewport`, and the chat asks `chatRows(...)` — cached per message — which row
  carries which `fold` id. The pinned question is painted over the top row, so a click
  there is the pin's and not the row beneath it.
  - **Where the eye is left.** Opening a block scrolls so its FIRST row is the top row
    (a block taller than the window used to land on its LAST line — the end of the
    thing the person opened it to read); closing keeps the clicked block's first row
    where it was; the key, which has no one block to anchor on, keeps the message the
    top row belongs to where it was. With the list resting at the END nothing scrolls
    at all: the rows are added above the reader and the bottom is already their place.
    The ask travels as `scrollTo: { row, n }` and is carried out inside the metrics
    callback, where the box has just measured the rows the fold added or took away.
  - Following the bottom belongs to a message ARRIVING (`scrollToEnd` on the count of
    questions asked), never to rows appearing above the viewport.
- **What it said between tool calls is ONE line: the step** (`src/assistant/step.ts`,
  pure; the chat owns the state and the view draws the row). Every answer used to carry
  a `▸ notes` header and the last two lines of prose under it, so the header was there
  for text that is mostly noise while the one thing worth seeing — what it is about to
  do — was inside the fold. It is now one dim row: the last thing the model SAID it is
  doing. The naive version of that line flickered (six changes over one turn, growing
  mid-sentence, and picking up the final answer as it streamed); what is drawn was
  measured against a recording of a live turn, and three rules make the difference:
  - **Only a complete sentence is shown** — one ending `.`/`!`/`?`. The narration is
    read as a PREFIX of what is being written: every line but the last was closed by
    its newline, the last only by its own punctuation. While a new sentence is being
    written the previous one stays. The exception is a **`Next:` line**, which the
    prompt asks for before a tool call and which a model often leaves unpunctuated: its
    newline closes it, and the `Next:` itself is stripped — it is protocol, not
    something to read.
  - **At most one change a second.** A change that comes sooner waits and lands when
    the second is up (`offerStep` / `dueStep` / `stepWaitMs`, with a timer in the chat);
    nothing is lost and nothing flickers. The state is the CONVERSATION's — never
    module-level — and every turn starts it again, so a turn's first step is immediate.
  - **The answer's own text never feeds the line.** Only the narration of rounds that
    carried tool calls does — what `onLiveCommit` commits to `process`, never a round's
    `live` or the final content. That was the prototype's real bug. Reasoning does not
    feed it either: the status line already says `thinking…`.
  The line is chrome — `selectable: false`, so a drag over an answer copies what the
  model wrote and not the host's account of it — and exactly ONE terminal row, cut with
  `…` rather than wrapped. A turn that narrated nothing, or nothing finished, draws no
  line at all.
  - **The rounds are kept apart where `process` is accumulated** (`joinNarration`): two
    chunks appended with nothing between them read as one broken sentence ("…how many
    there are.Now I will count them…"), in the fold as much as in the line.
  - **`plugins.assistant.notes` says how much is drawn, `/notes [step|fold|open|hidden]`
    changes it for the conversation** — the pattern `/fullscreen` uses: the config is
    where a conversation starts, the command moves it from there, nothing is saved, and
    `/clear` comes back to the config's answer. `step` (the default) is the line;
    `fold` is the older `▸ notes` header with the last two lines under it; `open` is
    the whole narration unfolded; `hidden` draws none of it, open or folded (the key
    still opens the tool calls and the views). Opened, `step` shows what `open` shows
    — the line is a summary of what is then fully on screen. The mode is in the
    `rowCache` key, or `/notes` would redraw only the message being written. It
    belongs to the CONVERSATION, like the auto mode: nothing is saved, and `/clear`,
    `/resume` and a change of task all go back to what the config says.
  - **What a round's text IS, is decided as it ARRIVES — and what has been shown is
    never taken away.** It used to be decided at the END of the round, when the tool
    calls were in: until then the text was drawn as the ANSWER, and a round that turned
    out to carry a call had the paragraph the person was reading reclassified and
    collapsed into the line above. A blink, and a lost sentence. Three rules:
    - A line starting `Next:` is narration from its first characters (`liveKind` in
      `step.ts`) and is never drawn as answer text — the shape the prompt asks for is
      what makes this cheap. `unknown` is the handful of characters that could still
      become `Next:`; nothing is drawn for them, and that is a few tokens nobody sees.
    - A model that ignores the shape is caught mid-round instead: `agentChat` reports
      `onRoundKind('tools')` the moment the first `tool_calls` fragment arrives.
    - A round that ends in tool calls and had already DRAWN its text keeps it where it
      was, dimmed in place (`shown` on the message), as well as in the fold. The step
      line is not drawn for a sentence that is standing there already — it is a summary
      OF the narration, not a copy beside it. The answer is only ever added to
      (`liveAs` says which shelf the streaming text is on); a commit that says "this
      was the answer" just stops the dimming.
  - **The model is asked for the shape, not for silence.** `baseStatic()` used to tell
    it not to narrate; it narrated anyway, having nothing else to write between calls.
    It now asks for ONE short line starting `Next:` before a tool call and nothing else
    between calls, and for the final answer not to start with one. So there is one
    sentence per step and far less to fold. Whether the instruction holds over a long
    turn, and that it costs no tool call, is a question for a live run
    (`scripts/eval-tool-use.ts`); the e2e test only holds the host to SENDING it.
- **⇧⇥ steps the auto mode** — how much of a turn runs without the y/n (the rules are
  under "What the model can do"). It is one of the chat's own fixed keys, like ⏎ and
  Esc, drawn with `keyGlyph` and NOT in `HOST_DEFAULT_KEYS`: the chat owns the keyboard
  while it is open. It used to fall into the plain Tab's completion, which is not what
  anyone asks for by holding Shift. `/auto [reads|all|off]` does the same in words, and
  a bare `/auto` takes the next rung. The mode is stated on the hint line in the warn
  colour (`auto: writes`) as a SIBLING of the hint, not inside it: the left cell becomes
  the running turn's status while an answer comes in, and a mode that disappeared
  exactly while writes were running unasked would be the wrong half of the screen to
  lose.
- A **paste** is one key, `{ name: 'paste', text }` (flowtty's bracketed paste): it
  goes in at the caret with its line breaks kept. It is never decoded into keys, so
  a pasted newline does not send and pasted letters fire no binding — any new
  key handler must keep it that way (match on `key.name`, never on characters of
  pasted text).
- **Images** (`src/assistant/images.ts`; the model's side is under "The conversation
  the model sees"). The person attaches; the model can never make the host read a
  file as an image. An attachment is a TOKEN in the field's text, `[Image #N]`, put
  in at the caret with a space after it, drawn in `accent` (in the field and in the
  sent message — not dim, which in the field means "offered"). N counts up for the
  whole conversation (`imagesRef` N → ref, `imageSeqRef`; saved as the session's
  `images` / `imageSeq`, reset by `/clear` and a change of task). The TEXT decides
  what is sent — the tokens it holds that the map knows, in the order written, each
  once — so a queued message, ↑/↓ recall and the draft carry their images by their
  text alone; a token edited away is not sent, one typed by hand with nothing behind
  it is text. Ways in, all refused the same way (`not attached: <why>` on the error
  line — too big, too many, not an image, missing, `IMAGES_OFF`; nothing shrunk):
  - a PASTE that is wholly paths of image files (a file dragged onto the terminal
    arrives as its path; quoted, `\ `-escaped, several, `file://`), decided on the
    paste key, never on characters; a refused one goes in as text. Not in shell mode
    or a `/`/`!` field — there a path is the command's argument.
  - `/image <path>` (any word is a path there, relative to the shell's directory);
    `/image` alone, **Ctrl+V** (free in the editor reducer) and an EMPTY paste — the
    only signal a terminal gives for Cmd+V with an image on the clipboard — take the
    clipboard's image through `services.clipboardImage` (`readClipboardImage`:
    pngpaste → osascript; wl-paste → xclip; a private temp file). From a key an empty
    clipboard is only a toast. `bootApp`'s `opts.clipboardImage` fakes it; without
    one a test's clipboard is empty.
  - The file is taken by its real path, told by its magic bytes (png, jpeg, gif,
    webp), its size read from the header. The chat's key handler runs first:
    Backspace right after a token (Delete right before one) removes it whole.
- The mouse is reported because the TTY backend is opened with `{ mouse }`, on
  unless `ui.mouse` is `false`: the wheel scrolls, and a **drag selects and copies**
  (flowtty ≥ 1.0.0-alpha.15 copy-on-select — no host code draws the band or reads the
  cells). The terminal's own selection still works with its bypass held (Option in
  iTerm2, Shift in most Linux terminals, fn in Apple Terminal) and takes whole screen
  rows, borders included. The active default in `config_schema` describes all this,
  because "how do I copy text" is asked of the assistant. Without the mouse, `/copy`
  copies the last answer's code block (`/copy answer` — all of it).
- **What a drag copies is decided by two props** — read the whole of it before
  adding a pane:
  - `selectionScope` on every pane and window: a drag that starts inside stays in its
    content rect — never onto the border, never into the neighbour. The chat's frame,
    `frame()` (log, help), the reminder and the host's bottom box (the command line)
    carry it; a `<ScrollBox>` (the conversation, the help's list) and a `<Table>` are
    scopes already. A plugin's panes carry it too (the tracker: the board, each column
    cell, the issue, the info panel, every modal window).
  - `selectable: false` on chrome: the gutter marker (`ƒ `, `› `, `$ `, `◆ `), the
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
  - **Mouse buttons are not keys.** `mousedown` / `mousedrag` / `mouseup` reach every
    `useInput` subscriber; `twoPhaseDispatch` drops them before any handler or the
    host fallback (`isMouseButton` in `src/playback/keys.ts`). Handlers were written
    for keys: the y/n pause and an open question swallow every key, Esc Esc is
    disarmed by "any key", the command line's catch-all consumes, keycaps would draw a
    cap per dragged cell, and every consumed key costs a re-render. A new handler
    needs no guard of its own; one that bypasses the registry (a raw `useInput`) does.
    **One handler asks for them**, `mouse: true` on its registration: the chat's, the
    only thing on screen that knows what is under the pointer (the click above). A
    button reaches such a handler and nothing else — not another consumer, not the
    host fallback — and that handler returns `false` unless it actually acted, so a
    drag still costs no re-render a cell.
  - Tests: `backend.mouse('down' | 'drag' | 'up', x, y)`, then read
    `backend.clipboard`; `backend.clipboardAvailable = false` stands for Apple
    Terminal (`src/__tests__/copy.e2e.test.ts`).
- **`!command` runs a shell command** — the person's own, typed into the field
  (`!bun test src/features`); the model never reaches this path. `!` typed into an
  EMPTY field switches the field into **shell mode** instead of being inserted (like
  Claude Code's bash mode): the prompt glyph reads `! ` instead of `› `, in
  `theme.modals.chat.shell` (a colour of its own, distinct from `accent` — pick it
  from `MODAL_COLOR_DEFAULTS.chat` in `src/playback/theme.ts`, checked against
  flowtty's `NAMED_COLORS` by the theme test). Enter then runs the field text as the
  command and the mode reverts right after — one command per `!`, even on an empty
  submit (leaving it engaged would silently redirect the next thing typed into the
  shell too). Backspace on an empty shell-mode field leaves the mode without deleting
  anything else; Esc on an empty shell-mode field leaves the mode before the usual
  double-Esc exit arms (the same "closest thing first" order as Esc's own field-
  clearing step). `!` after other text, or already in the mode, is just a character —
  a shell command may itself start with one. A paste is never decoded into a mode
  switch (pasted text, letters included, fires no binding), so pasting a whole
  `!command` into an empty field inserts it literally and runs the legacy way: typed
  or pasted text starting with `!` still runs as a command even outside shell mode
  (also how ↑/↓ recall worked before shell mode existed, and how a session saved by an
  older build could still replay one). It runs through `/bin/sh -c` in its own process
  group (a timeout, `shell.timeoutMs` 120 s, or Esc kills the whole group), stdin
  closed, `PAGER`/`GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`; stdout and stderr merged;
  the output keeps its TAIL (`shell.maxChars` 20000) and says how much was cut. While
  it runs the chat is busy exactly as while an answer is written (`streamRef`, the
  spinner, `$ cmd` as the tool label, Esc stops it); a `!` meanwhile is refused, not
  queued. The result is a message of role `shell` — `$ ` in the SAME shell colour as
  the mode's prompt (a command reads as one thing from typing to result) on the
  person's ground, a ```console block and one line (`exit 0 · 1.2 s · ~/dir`) — and,
  like a background result, it joins `apiRef` (`apiHistory` maps `shell` → `user`) and
  is read with the next message; no turn is spent. It is saved with the session and
  its line goes into ↑/↓ as `!cmd`; recalling one with ↑ shows it the way it was
  typed — shell mode on, the field holding `cmd` with the `!` stripped. Shell mode
  itself is UI state of the field only, never saved and never restored across a
  restart; a `!…` or a shell-mode field is not a draft. **The directory is remembered**
  between commands, as in a terminal, and shared with `run_command`: it starts at the
  first `fs.roots` directory (else the process's), a `cd` moves it only within the
  roots by real path (the shell writes `pwd -P` to a private temp file after the
  command — a 4th stdio pipe under Bun lost the report now and then), `exit N` or a
  kill keeps it, run_command's `cwd` argument is a `cd` that stays, `/clear` and a
  change of task go back to the root, `/resume` and a restart bring it back. Variables
  and functions are not kept — every command is a fresh shell.
- A `/command` **completes inline**, like a shell's autosuggestion: the part not
  typed yet is drawn after the caret in the dimmed accent colour, the other
  candidates follow as `⇥ a · b`, **Tab** takes the offer and then walks the rest.
  Only with the caret at the end of a one-line `/word`. In the field, dim means
  "offered, not yours yet" — the person's own text is never dimmed, on either side
  of the caret.
- The **status line** while a turn runs says what happens NOW: a running tool's label
  (`⚙ name(args)…`, `$ command`) pulses through bright colours; once the tool ends
  (`onToolRun`) the label goes. With no tool running the line says `writing…` only
  while the model's text arrives, and `thinking…` otherwise — before the first token,
  while it reasons, and between tools while it works out the next call (it said
  `writing…` there, and nothing appeared). The stream callbacks are
  closures made when the message was sent, so anything they READ (the tool label
  they clear) is kept in a ref beside the state — reading the state there saw its
  send-time value, and a finished tool's label stayed up for the rest of the turn.
  - **The seconds are the running THING's, not the turn's.** They start again whenever
    the line changes hands: a tool the moment it is called (`onTool`), the model's
    round the moment the tool ends (`segRef`, `beginSegment` in the chat; `t0Ref` still
    times the turn). One timer from the question to the answer sat at `3m 12s` through
    a build, which says nothing about what is happening. The TURN's total, and what it
    cost, stay on the quiet line under the finished answer (`· 12.4 s · ▸ 3 tools ·
    3.1k tok`), where they are read afterwards and distract nobody.
  - **What the turn costs is said** (`3.1k tok`, `tokensBadge`): every round's prompt
    plus its completion as the provider reports them (`onRound`'s `usage`), added up
    for the turn. It is not `ctx N%` beside it — that one is how big the NEXT request
    is, from the last round alone (`usageRef`, the context meter). A provider that
    reports nothing shows no figure: an estimate that moved on its own would be worse
    than none, and nothing here is estimated.
- **The tool trail is condensed and capped** (`condenseRuns` / `TRAIL_ROWS` in
  `src/views/modals.ts`). One dim line per call earns nothing past a handful: a turn
  that ran to the round limit printed dozens of them and the screen was a sheet of
  grey, with the end of the turn lost in the middle of it. Consecutive calls of the
  same tool that ENDED the same way are one line with a count (`read_file ×12`) — a
  different argument is not a different line, the arguments are in the log — while a
  call that FAILED keeps a line of its own with its reason, which is how a person
  knows why an answer is thin. An open trail shows its last `TRAIL_ROWS` (12) lines
  over `… N earlier calls`, which only a click opens (see the fold model above). The
  folded summary (`toolSummary`) carries the counts too and is cut to the width —
  every `ChatRow` is one terminal line, and fifty tool names would take two.
- **A turn that ran out of rounds says so where the answer would be.** `agentChat`
  reports `roundLimit` when the loop ends with no round that was an answer, and the
  chat draws `stopped after N rounds — no answer; say "continue" to carry on` in the
  warn colour, in the conversation. It replaces the dim "ran out of steps" line under
  the field, which the wall of grey above it hid.
- A **background result** (the `background` tool's nested run finishing) is SHOWN as
  soon as no turn is being written — a half-typed draft does not hold it back. It
  does not open the chat and does not spend a model turn: it joins the model's
  history and is read with the person's next message. Landing while the chat is
  closed, it is counted as unread; the host footer shows `F chat · ◆ N new` through
  the chat plugin's `keycaps`, and opening the chat clears the count. It also calls
  `services.alert(title, body)` — flowtty's `notify`: a desktop notification, or the
  bell where none reaches the terminal (tmux, a bare console), at most one a second.
  A fired reminder alerts the same way, chat open or not. The App binds `alert` from
  `useApp()`; tests read `TestBackend.notifications` / `bells`.
  `ai.backgroundFollowUp: true` opts back into a turn per result, and then only
  with the chat open, the field empty and nothing queued.
- What the footer reads from a plugin (`ft.store.<x>`) must be patched
  synchronously when it changes: the host draws its footer BEFORE the plugin's
  component re-renders, so a value assigned during render is one frame stale.
- A tool's ctx is built with `allServices(ft.services)`, never `...ft.services`:
  host services sit on the PROTOTYPE of the per-plugin services view, and a spread
  copies own properties only. The spread silently gave tools a ctx with no
  `chatLLM`/`config`/`showMessage`, and `background` answered "no LLM service".
- The conversation is a flowtty **`<ScrollList anchor="bottom" rowHeight={1}>`**
  (`ChatMessages` in `src/views/modals.ts`): it takes the rows the column leaves,
  follows new rows until the person scrolls up, and hears PgUp/PgDn and the wheel
  ITSELF — the chat's key handler must not. No heights are added up anywhere: a new
  block under the conversation needs `flexShrink: 0` and nothing else. Sending a
  message calls `scrollToEnd()`. Needs flowtty ≥ 1.0.0-alpha.20.
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
  - The empty conversation is still a `<ScrollBox>`: it holds the invitation, not rows.
  - The **wheel scrolls only while the pointer is over the box**. In a test pass
    coordinates — `backend.wheel('up', 20, 8)`; the default `(0, 0)` is the app title.
  - Every `ChatRow` is exactly one terminal line; the pinned-question check reads a
    row's index as its line. A row that wraps would break it. Long lines of fenced
    code are hard-wrapped by `layoutMarkdown` since flowtty 1.0.0-alpha.11 (before,
    one ran out of its box as a single over-wide row); a test holds it.
- **One look for every host modal** — the chat's: `frame()` in `src/views/modals.ts`
  (round border, the modal palette, a plain title) and a quiet hint line at the bottom
  saying how to move and how to get out. The log and the help wore a double frame of
  their own, so one product looked like two.
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
    more). The help used to run off both ends of the terminal with no way to scroll.
  - **The log** stamps each entry with its time (`services/log.ts`), and what a line IS
    decides how loud it is: a failure red, `[bg]` the background's colour, the
    model-round bookkeeping and the stamp dim.
  - **The help** answers two questions — which keys, which commands. Keys are drawn
    with `bindingGlyph` and split in two: the ones the HOST acts on anywhere
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
  do not rebuild the absolute box by hand (there were four copies of it).
  - Rows are cached per message OBJECT (`rowCache`, a WeakMap). It is correct only
    because the chat replaces a message and never mutates one — keep every
    `setMessages` updater that way.
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
  - The caret (`cursor`) is a **UTF-16 index into the value, resting on a code-point
    boundary** — flowtty's unit. `value.slice(0, cursor)` works; `Array.from(value)`
    indices do not. Columns are counted in characters.
  - Newline keys: **Alt+⏎** (what the hints name), Shift+⏎ where the terminal sends
    it, and backslash-then-⏎, which works everywhere.
  - In a draft ↑/↓ move the caret between rows; they walk history only while the
    field is empty or shows an untouched history entry.
  - `chatFieldWidth(width)` is the one place the field's width is computed — the
    view and the key handler must agree on it, or ↑/↓ land in the wrong column.

## CLI

- **The interactive screen needs a terminal on both ends** (it draws on stdout, reads
  keys from stdin). `runInteractive` checks first (`interactiveRefusal`, on flowtty's
  `isInteractive`) and answers a pipe / CI / redirected input with a sentence, the
  one-shot form that does work there, and exit code 1. Since flowtty 1.0.0-alpha.12
  `new TtyBackend()` THROWS without an interactive stdout (a `NotInteractiveError` since
  alpha.13 — nothing here catches it or reads its text), so the backend is built on
  the interactive path ONLY — never before a subcommand has been ruled out, or
  `flow-assist config get x | jq` dies.
- flowtty restores the terminal on SIGINT / SIGTERM / SIGHUP itself and honours
  `NO_COLOR` / `FORCE_COLOR`; the host adds no handler or colour flag of its own. A
  plugin with a child process to stop adds one — under the rules in "A plugin that
  starts a process owns its life", which keep flowtty's own re-raise working.

`flow-assist` with subcommands:

- (default) `interactive` — the TUI.
- `config get|set|unset|help` — host config.
- `plugins ls|install|remove|update` — manage enabled plugins. `install` takes a name
  (linked from `plugins-available/`, else fetched from the registry) or an archive —
  a `.tar.gz` path or an https URL (`loader/archive-install.ts`). An archive's member
  list is checked before extraction (no links, no `..`, one top-level `<name>/`), it
  is unpacked in a temporary directory, and it replaces only a plugin that came from
  an archive (the `.flow-assist-source` marker says `archive`). The model's
  `host:plugins_install` stays name-only: a URL in a tool argument may come from any
  page the model has read.
- any other arg — a one-shot `<prompt>` chat with the loaded tool registry.

## Config & environment

- Config: `~/.config/flow-assist/config.json` (schema from each plugin's `configSchema`).
- Environment: the host reads `LLM_TOKEN` (or `ai.tokenEnv`) and the optional `FLOW_ASSIST_PLUGIN_REGISTRY_URL` / `FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT` / `FLOW_ASSIST_PLUGIN_REGISTRY_TOKEN`; host variables take the `FLOW_ASSIST_` prefix. A plugin owns its own variables and declares them in `requiredSettings`.
- `ai.images` (`enabled` true, `maxBytes` 5 MB, `maxPerMessage` 4) — images in the
  chat. On by default: the API cannot be asked whether a model takes images, so a
  machine whose model cannot says `config set ai.images.enabled false`. Its
  `config_schema` note (`KEY_DEFAULTS['ai.images']`; a leaf takes the note of its
  nearest parent that has one) says how to attach and how to turn it off.
- `config.user` (`name`, `login`) is the only source of the person's identity in the chat context — never the environment or the OS account.

## Testing

From the host root: `bun run typecheck && bun test ./src ./scripts` (the path
filter keeps a locally dropped-in plugin's suite out of the host run).
Plugin tests: `cd plugins-available/<name> && bun test`.
The host suite must pass with `plugins-available/` empty — a host test never loads a real plugin.

**A test never reaches the person's own files.** `hostStateDir()` (`src/config/load.ts`)
is where the host keeps what it writes for itself: the config directory normally, a
temporary directory of this process under `bun test`. The memory, the tool log and a
setting `config set` saves all resolve through it, the cache keeps its store in memory
and writes no file at all under a test, and the sessions have their own `null`
(`sessionsDir`). Two rules hold it together, and a new file the host writes by default
keeps both:

- **Resolve the path on every call, never at import.** A `bun test` run shares its
  module registry across every file, so an import-time constant is decided by whichever
  file imports the module first — before any test can point the directory anywhere.
  That is how `memory.json`, `cache.json` and `tools.log` all pointed at the person's
  own directory for the whole suite: their memory grew a copy of the same fact per run,
  and pressing `x` in an e2e test emptied their cache.
- **A temp directory is the floor; a file of the test's own is the isolation.**
  `bootApp` names both a sessions dir and a memory file of its own, so one test's
  stored fact cannot ride into the next test's system prompt; a test that reads the
  file back names it through `extra`.

- `src/__tests__/helpers/scripted.ts` — a scripted model and a booted app: the
  REAL TUI on a test backend with only the network replaced. Steps are text,
  a tool call, or a `hold` that freezes the stream until `release()`. Like a real
  fetch it honours the request's `signal`: an abort errors the body with an
  AbortError, so Esc stops a scripted answer, and a request made with a signal already
  aborted rejects before it is recorded. End-to-end
  tests drive the app through it; assert on the frame AND on cell styles
  (`backend.lastBuffer`).
- `bun scripts/ui-frames.ts [--size WxH] [--color|--styles] [scenario…]` — the same
  rig for eyes: frames at named checkpoints, no network. Look at a display change
  before and after with it.
- `bun scripts/eval-tool-use.ts` — a behavioural eval against a LIVE model (costs
  money; `--fake` checks the harness): rates by turn, false claims, `--history
  display|api` as an A/B, `--show` prints the dialogue.
- `bun scripts/eval-tool-loading.ts` — the same kind of eval for tools on demand:
  does the model find the one tool a task needs among a dozen, in how many rounds,
  `--tools all|onDemand|both` as the A/B (live; `--fake` checks the harness).
- A fake for a validating route must reject what the real one rejects; prove a
  new test fails on the bug before trusting it.

## Git

- **Never** append a `Co-Authored-By: Claude` trailer (or any Claude
  `Co-Authored-By`) to a commit message.
- Branch from `master`; the default branch here is `master`.
- **Versions**: semver, `0.x` while the plugin contract may still change. The version
  lives in `package.json` and `src/version.ts` (a test keeps them equal); each release
  gets a `CHANGELOG.md` entry and a `vX.Y.Z` tag. A release is what is handed out —
  a build of the host that someone installs — so bump the version before building one.