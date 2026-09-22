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
│   ├── mcp/                   # tools of MCP servers (no UI)
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
only after it has asked someone (the `mcp` plugin connects to its servers first); it is
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
- **The log is the person's too.** No log tool; `/log [N]` shares the tail of the
  host log as the person's own message.
- **`ask_user`** (1–4 questions, 2–4 options each, optional multi-select, an
  "Other…" row the UI always adds) is a pure state machine in
  `src/assistant/ask.ts`; the chat owns only the pause and the render. A
  background task is never given the hook — a question popping up would seize the
  keyboard mid-sentence — so there the tool answers "nobody to ask".
- **The memory is the person's too.** The `memory` tool is the model's: a stored fact
  goes into the system prompt of EVERY later request — across `/clear`, across
  restarts. That is its purpose, and it is also why "after /clear the assistant still
  knew my earlier prompt" looked like `/clear` failing: the conversation was gone, the
  memory was not, and nothing said so. So `/clear` reports what it kept
  (`keptAfterClear`), and `/memory` lists and `/memory forget <n|all>` removes — without
  going through the model (`src/assistant/memory-command.ts`). What the host tells the
  person this way is a display-only message of role `note`; `apiHistory` drops it, and
  the model's history (`apiRef`) never holds it.
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
  tool, not the registry's; what is sent is worked out again for EVERY round, so a
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
  `✎ title · +N −M` block with a ```diff fence above the answer, open, not under ^r.
  It is DISPLAY only: it rides on the display message (`changes`), never on the
  tool's result, so the model's history does not grow by a copy of every edit — the
  e2e test asserts on what the model is sent next. A tool that threw has its reports
  dropped. Only the tool knows what "before" is (a file, an issue's description, a
  comment), so the host never guesses it: `repo`'s write_file / edit_file /
  delete_file report (a directory delete and a file over 2 MiB do not).
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

## The chat

- Who speaks is said by a **gutter marker and a ground**, not a label: `›` on the
  user ground for the person (the input field's own prompt), `ƒ` for the
  assistant's answer (also signing the frame, `ƒ Flow Assist`), `◆` on its own
  ground for a background result. Colours come from `theme.modals.chat` (`accent`,
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
- **⏎** sends; while an answer is coming it **queues** instead (sent in order when
  the turn ends). **Esc**: clear the field → take the last queued message back →
  stop the answer (the line under what came so far says `stopped (Esc)` — a cut-off
  «В» must not read as a whole answer) → arm/close. **Alt+⏎** (drawn `⌥⏎` on macOS) is a newline (`NEWLINE_KEY` in
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
  - **Never write a key's symbol by hand in a hint.** Two cases:
    - the action is BOUND (it is in `ft.keys`, so the person can remap it) → draw
      `ft.keyCap(action)`; it is `''` when the action is unbound, and then the hint is
      not shown at all. The host footer (`composeFooterHints`) and the chat's
      `F chat` hint do this. Host-side code uses `bindingGlyph(keys[action])`.
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
  history entry untouched. The **wheel** and **PgUp/PgDn** scroll. **^r** unfolds
  thinking, notes and the tool calls behind the one-line `▸ N tools` summary.
- A **paste** is one key, `{ name: 'paste', text }` (flowtty's bracketed paste): it
  goes in at the caret with its line breaks kept. It is never decoded into keys, so
  a pasted newline does not send and pasted letters fire no binding — any new
  key handler must keep it that way (match on `key.name`, never on characters of
  pasted text).
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
    `frame()` (log, help) and the reminder carry it; a `<ScrollBox>` (the
    conversation, the help's list) and a `<Table>` are scopes already. A plugin's
    panes carry it too (the tracker: the board, each column cell, the issue, the info
    panel, every modal window).
  - `selectable: false` on chrome: the gutter marker (`ƒ `, `› `, `$ `, `◆ `), the
    pinned question, the `N tools` line, the hint rows, the input field, the title bar
    and footer, the keycaps panel.
  - The chat lays markdown out itself (`mdLines`), so it keeps what `layoutMarkdown`
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
- The conversation is a flowtty **`<ScrollBox anchor="bottom">`** (`ChatMessages` in
  `src/views/modals.ts`): it takes the rows the column leaves, follows new rows until
  the person scrolls up, and hears PgUp/PgDn and the wheel ITSELF — the chat's key
  handler must not. No heights are added up anywhere: a new block under the
  conversation needs `flexShrink: 0` and nothing else. Sending a message calls
  `scrollToEnd()`.
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
  completion, history, ^r); its geometry (`inputRows`, `caretPosition`) draws the
  rows in `inputVisualRows`. So caret motion by character / word / visual row,
  Home/End and the kill bindings per line, paste and the newline keys are NOT host
  code — do not re-add branches for them. The reducer answers `submit` for a plain
  Enter; what submit means (send, queue, run a `/command`) stays here.
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
  `NO_COLOR` / `FORCE_COLOR`; the host adds no handler or colour flag of its own.

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
- `config.user` (`name`, `login`) is the only source of the person's identity in the chat context — never the environment or the OS account.

## Testing

From the host root: `bun run typecheck && bun test ./src ./scripts` (the path
filter keeps a locally dropped-in plugin's suite out of the host run).
Plugin tests: `cd plugins-available/<name> && bun test`.
The host suite must pass with `plugins-available/` empty — a host test never loads a real plugin.

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