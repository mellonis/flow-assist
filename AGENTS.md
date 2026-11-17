# flow-assist

## Language rule

Specs, implementation plans, and **code comments are written in English**.
Russian comments from ported source are translated during the port and are
never left in the new tree. The host's own UI — the chat, its hints, its status
line — is English throughout; a half-translated screen is worse than either
language.

## Comments describe the code as it is

A comment or doc line states what the code does and why, in the present tense —
never how it got there. No "used to", "no longer", "was renamed", "previously",
"since alpha.N", "as before", "now does X" where "now" contrasts with a past
state: that is history, and history belongs only in `CHANGELOG.md` and git. A
past incident may motivate a rule; keep the rule, drop the incident.

## Stack

- TypeScript **7.0.2** (native `tsc`), module `NodeNext`, target `ES2022`,
  `strict`. Bun **1.4.x** — `bun run`, `bun test`; the TUI runs as
  `bun src/cli.ts`.
- A `bun build --compile` binary works **when plugins are shipped BUILT**.
  One limit: inside a compiled binary a runtime `import()` of an on-disk
  package fails with "Cannot find module" when that package's `package.json`
  has an **`exports`** field. So a plugin run from SOURCE with its own
  `node_modules` is skipped by the binary; a plugin bundled into one file has
  no on-disk package left to resolve, and loads. This is not a two-React
  problem: plugins take hooks from `ui` and import only types from React.
  `build:binary` passes `--define process.env.NODE_ENV="production"`; the
  bundle holds no development React (`bun run test:binary` checks — run it
  before building a release).
- **Where the program finds its plugins and `.env`** (`src/install.ts`, the
  FIRST import of `main.ts`): the root holding `plugins-available/` +
  `plugins-enabled/` is the first of: a source checkout (one up from `src/`,
  never the binary's virtual `bunfs`), `dirname(realpath(process.execPath))`,
  and the working directory. Both plugin dirs must exist for the first two.
  Bun reads `.env` from the working directory only, so when the root is
  elsewhere `<root>/.env` is loaded too, never overriding a variable already
  set (not under `NODE_ENV=test`). It must be `main.ts`'s first import: a
  module that reads the environment when it is evaluated must see the `.env`
  values.
- **The entry is `src/cli.ts`, the CLI is `src/main.ts`, and React runs its
  PRODUCTION build.** `cli.ts` imports `main.ts` dynamically through
  `withProductionDefault` (`src/node-env.ts`): `NODE_ENV` is `production`
  only while the modules load, when the person had none (a value already set
  wins), and is then put back as the person had it — so every command the
  program starts inherits the person's own value. Nothing imports `cli.ts`
  (it runs the program) and `main.ts` is never run directly; tests import
  `main.ts`.
- No enabled plugin is never silent: `noPluginsNote` says where the host
  looked — start screen, log, after `plugins ls`, stderr of a one-shot prompt.
- **A published plugin ships no `node_modules`** (`packPlugin`). With
  dependencies it must have a `build` script that bundles them into
  `package.json`'s `main` (React and flowtty external — the host provides
  them); publishing runs it and ships the build without `src/`. No
  dependencies → sources ship as they are. Dependencies and no `build` →
  publishing refuses. The loader takes `main` first and falls back to `src/`
  only when it is missing — so a `dist/` left by a local build is what the
  host loads, and a test that mocks one of the plugin's dependencies never
  reaches it.
- React 19 + `@flowtty/react` / `@flowtty/tty-backend`, zod 4.

## Repos

- `flow-assist` — this host. Plugin sources live under `plugins-available/`,
  each a package with its own dependencies; the host never imports a plugin
  or a plugin's dependency.

## Layout (rules, not a map)

- `docs/` — `usage.md`, `safety.md`, `config.md` (the user manuals),
  `plugins.md` (the plugin contract as its authors read it), `demo/`,
  `internal/`.
- `examples/` — `notes/` (the plugin `docs/plugins.md` builds; run by the
  host's tests) and `remote-login/`.
- `packages/remote/` — `@flow-assist/remote`: the protocol's types, codec,
  `runPlugin`, its shared server.
- `plugins-available/<name>/` — one plugin per directory, a package with its
  own dependencies and a `manifest.json`.
- `plugins-enabled/` — symlinks into `plugins-available/*`, **gitignored**;
  `enabledPlugins` lists only the links at the top level. `docs/plugins.md` is
  the contract as its authors read it; a change to the contract below updates
  that page and `examples/notes` in the same commit
  (`src/__tests__/example-notes.e2e.test.ts` runs the example).

## Plugin contract — invariants

> The plugin author's contract lives in `docs/plugins.md` (kept in sync by
> the same-commit rule); the host mechanics and the remote protocol's spec
> live in `docs/internal/agents/plugins-runtime-spec.md`. What follows is
> what must hold in every change.

- **The host API has a number, `HOST_API` (`src/version.ts`).** It covers
  everything the host gives a plugin — the object each hook receives and what
  is on it (components, hooks, services), the shape's hooks and their
  signatures, the manifest's fields. A change a plugin built for the previous
  number would break on **bumps it, in the same commit**, with a CHANGELOG
  line saying what a plugin must change. `pluginCompat` (`src/loader/compat.ts`)
  answers for every place a plugin is met, from the manifest alone and before
  its code is imported: load skips it (`loadNotes`), `plugins ls` shows
  `incompatible: …`, install refuses it.
- A plugin module default-exports
  `build<Name>Plugin({ renders, config, make, z, modelMaySet, modelMaySave,
  appliesOnRestart, toolsChanged })`. The builder may be **async** — the
  loader awaits it, and the app draws after it, so it must be short. `z` is
  the host's zod. A plugin whose tools are known only after it has asked
  someone returns at once and says so with **`ready`**, a promise that
  settles when it is done waiting — bounding that wait is the plugin's job.
- The registries beside `z` are the host's config marks: `modelMaySet`,
  `modelMaySave`, `appliesOnRestart`. They are an addition: `HOST_API` stays,
  and a plugin that must also run on an older host checks that they are there.
  `make(name, shape)` injects `config.plugins.<name>` and qualified keys. The
  returned `shape` has optional `commands`, `keys`, `keyActions`, `views`,
  `surface`, `modals`, `colors`, `modalColors`, `configSchema`, `components`,
  `tools`, `services`, `aiTools`, `keycaps`, `entry`, `screens`, `setup`,
  `chatContext`, `chatSubject` (deprecated), `afterWrite`, `ready`; every hook
  receives the plugin's pair `{ ui, host }`.
- **What a plugin is given is `{ ui, host }`** (`src/runtime/plugin-api.ts`):
  `ui` is what React and flowtty ship, passed through unchanged (one
  `makePluginUi` for every plugin — a plugin cannot import its own
  `stringWidth`: a second copy would not share the width policy the backend
  sets); `host` is what the host implements or wraps — one per plugin, built
  once per App (`apiMap`), so a component factory makes one component type for
  the App's life. `host.services` stays the live per-plugin view (host
  services on its prototype, rebound every render): **never flatten it into
  `host` or spread it**. A tool's ctx is built with `allServices(host.services)`,
  never `...host.services` — a spread copies own properties only and silently
  hands tools a ctx with no `chatLLM`/`config`/`showMessage`/`pushLog`.
- A change to either part a plugin would break on bumps `HOST_API`.
- `services` expose host services through `host.services`; **the host wins on
  every key it owns**. `setup` runs once, before any of the plugin's
  components mount (it is where a plugin seeds its store).
- **How a tool gets its name:** the model sees the name the plugin gave
  (no prefix — it is shorter and the model has no use for which plugin stands
  behind a tool). The loader neither adds a prefix nor takes one away. **A
  name is claimed once**: the first group to declare it keeps the bare word; a
  later group's tool is registered as `<plugin>:<name>` and the clash is said.
  A handed-out name keeps its holder (`held` → `claim`) for as long as the
  holder still declares it; a late plugin or an MCP group that connects is
  registered qualified and the line says so. Once the holder stops declaring
  it, the next declarer in order takes it. Without this a clash is silent:
  `agentChat` sends one declaration per name, so the provider's own "Duplicate
  tool name" 400 never fires. The registry remembers `ownName` (what the
  group's `exec` understands). Names reach the provider through the wire
  translation in `src/assistant/agent.ts` (`:` → `__`) and nowhere else.
- **`toolsChanged`** is for a plugin whose tool groups change while the app
  runs: it sets `tools` and calls; `refreshToolRegistry` assembles every group
  again INTO the registry object already handed out (never replaced) with
  `ai.disabledTools` read again and a name clash said once per registry. Every
  assemble/refresh moves `toolRegistryRevision()`; `agentChat` reads it before
  each round, so a group that joins mid-turn is sent from the turn's next
  round, and a round without a movement sends what the last one sent byte for
  byte (a refresh costs one prompt-cache miss). A def a refresh took away is
  KEPT in the turn's `toolByName`; a call runs against the registry as it is —
  **a tool a refresh took away never runs again**. The registry keeps the
  group that last held the name (`left`) and THROWS why it is gone: the
  group's own word (`ToolGroup.gone(name)`) else the host's — `<tool> is gone
  — <plugin> removed it` / `… was disabled` / `… is not loaded`. Never a bare
  `Unknown tool`, never a "call again" for a tool that is not coming back.
- **`modalColors`** — per modal the plugin draws, what its palette differs in
  from the host's modal base; `resolveModalPalettes` lays it on the base into
  `theme.modals.<modal>`, the person overrides it with
  `config.plugins.<modal>.colors`. The host's own palettes cover only the
  modals the host draws; a plugin's same-named palette never replaces one.
- **The chat asks the plugins; it knows no plugin's data.** `chatContext` →
  what the plugin's screens show now as items `{ label, text }`, or `[]`.
  `services.chatContext()` asks every plugin in load order, each call guarded
  (a throw gives nothing and is logged once per plugin; `pushLog` of a
  throwing hook is deferred — `queueMicrotask`), items sanitized and capped
  (label 120 code points, text 2000, list 6000, tail dropped behind one
  `… N more`). What the model gets is placed **at the very END of every
  request** — after the conversation, past everything a provider caches —
  as a nonce-marked block, the nonce new for every block; text inside the
  tags is screen content and never the person's words. The chat's title is
  the labels joined ` · ` after the chat's name and the model it runs.
  **The screen changing never switches the session.**
  `afterWrite` → called for every plugin after a chat turn in which a write
  tool was confirmed and APPLIED: reload what you show, or an open document
  keeps its text from before the write. `chatSubject` is deprecated for one
  release; a plugin that has `chatContext` is not asked it.
- **A handled key is followed by a redraw.** The host calls `notify()` after
  every handled key, so a setter needs none of its own; a setter that did
  would change the state and freeze it on screen. A plugin still calls
  `host.notify()` for changes that do NOT come from a key — a fetch that
  finished, a timer. What the footer reads from a plugin (`host.store.<x>`)
  must be patched synchronously when it changes: the host draws its footer
  BEFORE the plugin's component re-renders.
- **A plugin that starts a process owns its life.** It never keeps the
  program alive (children and pipes unref'd); it ends with the program
  (`process.on('exit')`, SIGTERM/SIGHUP/SIGINT heard too — a signal ends a
  program without `exit`); a signal handler must not swallow the signal —
  flowtty decides whether to re-raise by COUNTING listeners, so the handler
  stops its processes, removes ITSELF, and re-raises only when no listener is
  left.
- **A plugin is a guest: whose screen it is.** The app opens on the HOST's
  start screen; mounting every plugin's surface from the first frame would
  draw "No board data" over an assistant nobody had asked for a board. A
  plugin's **surface** (the component slot named `view`, or `shape.surface`)
  is mounted **only while the plugin says its context is active**
  (`keycaps` non-empty); every other slot is furniture and is always mounted.
  The start screen lists guests as name · the key that leads in (ONLY from
  `shape.entry?: string[]`) · what it is; a key on screen is an instruction,
  so a plugin's unbound keys are not drawn as if they acted. While a plugin is
  still starting the start screen names it (`startingLine`); an enabled plugin
  the person has not trusted never starts and has a dim row of its own.
- **A write tool refuses by throwing.** The host counts whatever a write tool
  RETURNS as done; "path is required" returned as a string reads as a change
  made. Every refusal and every failed CLI call of a write throws — a refusal
  the tool makes itself, before touching anything, ends in "Nothing was
  changed."; an error the filesystem throws is passed on in its own words and
  claims nothing about the disk. The read-only tools keep answering with a
  string.

- **Screens the model can open** (`shape.screens`, `src/runtime/screens.ts`):
  its name → `{ entry?, title?, params? (JSON Schema), tools?, open(api,
  params), close?(api) }`; `open` lives in the shape and sets the plugin's own
  state. Two ways in — `host.open(screen, params)` (a plugin's own navigation)
  and the model's `ui_open(plugin)` (the entry screen) — one set of rules:
  a built-in plugin or a `HOST_PANELS` name, a disabled/untrusted/not-loaded
  or still-starting plugin, an undeclared screen, params that fail
  `toolArgsError` are refused as a readable `Not opened: …`. **Never over the
  person**: with the chat's draft non-empty while the chat has the keys, the
  `:` line open or a question waiting, the open is DEFERRED and answered at
  once. A deferred open records whose work deferred it
  (`workOwner()`); `screens.dropFor(owner)` removes those entries when the
  session is parked or kept. Background work opens nothing;
  a session not on screen opens nothing (`work-owner` rules). A refused or
  deferred open's answer is worded for the model, never naming a trust command.
  `promptBlock()` lists the screens and how to open them; `ui_open` is offered
  only when one can be opened.
- **Remote plugins** (`src/remote/adapter.ts`): the plugin sends its whole
  screen as a `frame` notification whenever it changes — never a diff; a frame
  the host cannot draw never takes the App down (`FrameBoundary`). **A
  stateful node's value is the host's**: `fieldState.ts` keeps it by `id` and
  checks each frame's value against the last 256 values the host sent as
  events; a field whose value the plugin ever sets carries `value` in every
  frame. Keys are consumed by what the frame declares (an entry naming the
  plugin's own action takes the person's effective binding; any other is a
  binding-vocabulary key); an open modal has the keyboard. The `Transport`
  seam is three implementations: a `run` child over stdio, a `connect` server
  over a local socket, a pair of in-memory streams for tests — plus a
  restarting supervisor (backoff 1, 2, 4, 8 s; a fifth quick failure in a row
  gives up until restart). A `run` child gets the full stop the host waits for
  (stdin closed → grace → `SIGTERM` → `SIGKILL`); a `connect` server is
  spawned detached and is never killed by a host, its stderr in
  `<socket>.log`; two hosts starting one server are serialised by a lock
  beside the socket (`<name>.lock`, `O_EXCL`, stale by dead pid). The host's
  own exit asks every plugin's `shutdown` (1 s) in parallel, bounded to
  1.5 s. `host.store.set` by a remote plugin fans out to every OTHER remote
  plugin of the same app; `host.store.get`/`set` refuse `__proto__`,
  `constructor`, `prototype` as keys. `hello.locale` follows gettext's order:
  `FLOW_ASSIST_LOCALE`, `LC_ALL`, `LC_MESSAGES`, `LANG`.
- **Where the chat is: panel, window, full.** `panel` docks the chat beside
  the plugin's screen (so what the model is told about stays visible to the
  person typing about it), `window` floats it, `full` takes the terminal.
  The layout is the App's: the terminal splits into the plugin's SIDE and the
  chat's panel, each side given its size through a host context
  (`AreaContext`), so a plugin lays out as on a smaller terminal. Too small to
  dock → the chat is a `window` until the terminal grows (both floors must
  hold: the panel's 12 rows AND `PLUGIN_MIN_ROWS` for the plugin's side). A
  pending question may grow a bottom panel but never past the plugin's least.
  "Closed" in panel mode is COLLAPSED: opening brings the keyboard; Esc Esc /
  `/exit` collapse and hand the keyboard to the plugin. **Closing is not an
  answer** — a y/n or question pending when the chat is closed stays pending
  and is shown as `? waiting for you`. Ctrl+] (`chatFocus`) moves the keyboard
  between the two sides; Ctrl+\ (`chatCollapse`) collapses; both act after
  the exit keys and before `twoPhaseDispatch`, and never while the `:` line is
  open. The mouse goes by the pointer: a press tells the chat which pane it
  landed in and the keyboard follows it.
- **A key has two names, and they meet in one place.** The TERMINAL's name is
  what flowtty's decoder gives (`key.name`); a PERSON's name is what a binding
  writes (`config.keys`, a plugin's `keys` table). `canonicalBinding`
  (`src/playback/keys.ts`) turns the second into the first when the map is
  assembled; `keyGlyph` is the third vocabulary — what is DRAWN (`⏎ ␣ ⇥ ⌫`,
  `^r`, `⌥⏎`, `⇧⇥`; Alt is `⌥` on macOS). A comparison must use
  the terminal's name; a **modifier is part of the key** (`keyId`:
  `ctrl+alt+shift+<name>`, Shift on a character left out — the decoder reports
  `'A'`). **Never write a key's symbol by hand in a hint**: a bound action
  draws `host.keyCap(action)` / `bindingGlyph(keys[action])`, a fixed key like
  the chat's own Enter/Esc/Tab draws `keyGlyph(…)`.
- **Ctrl+C, Ctrl+D, Ctrl+Z take a second press** (`src/runtime/exit-keys.ts`).
  The host takes them before `twoPhaseDispatch` and before every flowtty
  component; the first press arms (`^c again to exit`, `ARM_MS` 2 s), the same
  key fires, any other key disarms. The open chat speaks first: Ctrl+C with a
  turn or `!command` running STOPS it exactly as Esc does and nothing is
  armed; Ctrl+D in a field with text is the editor's forward delete. **The
  keys are claimed only while there is something to stop**
  (`Conversation.canStop`) — for Esc as well. No key quits by default: a
  stray `q` would close the whole app; quitting is `:quit` or Ctrl+C twice.
  A capital opens something big (`F` the assistant, `L` the log); lower case
  is for what is INSIDE a screen. A modal is closed by the key it is bound to
  (`f.keys.<action>`), never by a letter written in the handler.
- **One look for every host modal** — `frame()` and `overlay()` in
  `src/views/modals.ts`; a modal that draws its own frame doubles up. A window
  that paints its own ground sets its own ink (`color: m.text`). The palette
  follows the terminal's scheme (`themeFor(scheme)`, `modalColorDefaults`);
  a new colour goes into all three palettes and a ground a plugin paints is a
  `${token}`, never a literal. A modal is as tall as what it holds; what does
  not fit scrolls (`<ScrollBox scrollbar>`). The log stamps each entry with
  its time and its loudness is its kind; the help answers which keys, which
  commands, and lists only keys that act here.
- **What a drag copies is decided by two props**: `selectionScope` on every
  pane/window (a drag stays in its content rect) and `selectable: false` on
  chrome (gutters, hints, the field, the title bar, everything the bottom box
  draws around the typed command — the command itself is the one thing down
  there a drag copies). The clipboard: flowtty writes OSC 52 and calls
  `onCopy`; `services.copy(text)` is what the app's own copies go through.
  **Mouse buttons are not keys**: `mousedown`/`mousedrag`/`mouseup` reach only
  a handler that asked with `mouse: true` (the chat's); a move costs nothing
  on the host's path — it disarms no Esc, answers no y/n, redraws nothing.

## What the model can do — the rules

> How each tool feels is `docs/usage.md`; the storage and wire specs ride in
> `docs/internal/agents/sessions-journal-spec.md` and
> `docs/internal/agents/model-wire-spec.md`. What follows is what binds
> behaviour.

- The `core` tool group: `memory`, `workspace_read`, `config_schema`,
  `config_set`, `datetime`, `remind`, `subagent`, `skill`, `todo`, `ask_user`,
  `open_url`, `recall`, `ui_open`, plus `host:plugins_list`; `workspace`
  (`workspace_write`, `workspace_list`) and `web`, `shell` are on-demand
  groups off with `ai.disabledTools`. `core` is always on, so a tool that must
  be switchable per machine cannot live there.
- **A tool argument is hostile input.** The model writes every argument, and
  what it read a minute ago may have told it what to write. A tool that pauses
  for y/n is guarded by a person; **a read-only tool is guarded by nothing**,
  so it is the one to check hardest: a value that reaches a CLI's argv never
  starts with `-`, refs go after `--end-of-options`; a path check is on the
  REAL path (`realOf`), not the spelled one; a configured root is never
  deleted, confirmed or not; no "magic" flags (glab's `--field` reads `@path`
  from disk — strings go through `--raw-field`; `gh api -F` is alike).
- **A tool that can never work is not offered.** A tool that only ever answers
  "unavailable" still costs a call, tokens on every request and a wrong turn.
- **A failure is reported as a failure, in the failing thing's own words** —
  exit code and stderr, "not installed" when the binary is missing, "empty
  body" when it is empty, a time limit instead of a hung turn.
- **A tool's result is what the model will tell the person.** A result over
  `ai.toolResultMaxChars` (40 000) is cut before it joins the history — head
  90%, tail the rest, a `… [cut: …]` note the model reads in place of what was
  cut; only what is SENT is capped. Data behind a framed result rides beside
  as `raw` (never sent, what `stdinFrom` reads) and over `RAW_MAX` (1 MiB) is
  not kept — piping it answers `too large to pipe`, never "call again".
- **A call is checked against the tool's own schema before it runs**
  (`toolArgsError`): a missing `required` key, a wrong type, a key
  `properties` does not list — BEFORE the y/n and before either `def.run` or
  `execChatTool`. `additionalProperties` absent is read as refusing an
  unlisted key; `null` on an optional key is that key left out, at every
  level. Only the check sees the cleaned copy — the tool gets the arguments
  as sent. A schema one zod's reader cannot compile is logged once and the
  call runs unchecked from then on: a plugin author's schema quirk must not
  stop their tool.
- **A call whose arguments do not parse to a JSON object is refused at the
  call**, and the history keeps `"{}"` in the call's place so it stays valid
  JSON — stored raw, every later request would carry the malformed call.
- **A tool call written as text is asked for again, once, as a real call**
  (`tool-markup.ts`); markup written beside a real call is stripped from the
  screen and the history. Code fences are never markup.
- **A tool can return images it fetched itself** (`{ text, images }`, def says
  `returnsImages: true`): images from a tool that does not declare it are
  dropped with a note. Bytes are told by magic bytes (a `mime` is a claim);
  `ai.images` limits hold; an accepted image is written once to
  `images/<sha256>.<ext>` and kept as a ref — the session stays base64-free.
  The person attaches; the model can never make the host read a file as an
  image.
- **Bulky content is sent once, then as a stub the model recalls**
  (`recall.ts`): an image, a `!`/`!!` output, a result over `ai.recall.minChars`
  (4096) become stubs in BATCHES at the end of a turn (`decideBatch`: past
  `ai.recall.threshold` (0.5) or every `ai.recall.everyTurns` (10) turns) —
  replacing old content costs a prompt-cache miss, so between batches the
  prefix is byte-stable. `recall(id)` brings an item back for ONE turn, beside
  its result — never back in place.
- **A request carries the core tools and an INDEX of the rest** (tools on
  demand): `tools_load`'s description is the index per group. The index does
  not change as tools load (a stable prefix) — only when the registry does. A
  call to a tool that is indexed but not loaded is an ERROR naming
  `tools_load`, refused BEFORE the y/n. `names` takes bare and
  `<group>:<name>` names and forgives a serialised string; `group` takes a
  tool's own name as a fallback. A group past `BIG_GROUP_TOOLS` (12) carries
  its own cost line and is never loaded whole by `group` alone.
- **A path to the model that cannot ask the person declines writes.** One
  closed set of policies (`confirmFor`): `ask` (the chat), `always-no`
  (background tasks with `writes: 'deny'`), `none` (nobody to ask — the
  one-shot prompt), `allow-writes` (`--allow-writes`), `caller` (a plugin's
  own confirmation). A write goes to `confirmWrite` when the caller passed
  one, and with none it is declined before it begins — no `onToolStart`, the
  tool never runs, the model gets a `DECLINED` result. A caller can withhold
  tools (`AgentOpts.withholdTools`); a call to one answers `Unknown tool`
  without running. `config_set` is `write: true` in effect but its write flag
  is a predicate (`configSetRefusal`) that is false for a call that will not
  happen (an unmarked key, a value the schema refuses) — such a call never
  reaches the y/n and `exec` throws the refusal. It runs only on
  `ctx.confirmedByPerson`: the loop's own word that the person said yes to
  THIS call (after the caller's `toolCtx`, so a caller cannot forge it).
- **Whose claim excuses a y/n, and whose does not.** The `mcp` plugin keeps
  the two apart per server: `trusted` is "I believe THIS SERVER's own
  `readOnlyHint`"; `plugins.mcp.servers.<name>.readOnly` is the PERSON's own
  list of tools they checked. Either alone is enough; the second is the only
  one that helps a server that makes no claims. A rule scoped to an ARGUMENT
  does not exist — a "read" that takes a URL can carry data out in it.
- **The auto mode is the person's lever** (`/auto [reads|all|off]`, ⇧⇥):
  `ask` → `reads` → `all`. The mode belongs to the CONVERSATION and is saved
  with its session. Three calls are not automatic in any mode on their own —
  `run_command` unless `shell.autoRun`, `web_fetch`, `config_set`; the last
  two never are. "The host's own `run_command`" is the def object the shell
  group made (`isHostShellTool`), never the name: a plugin's tool called
  `run_command` still asks.
- **Config is the person's.** The model gets `config_schema` — keys, types,
  marks, defaults — and **no values**. It writes only a MARKED key in the
  scope the mark allows (`config_set(key, value, scope)`), and answers for
  every other key with the `config set <key> <value>` command to run. Every
  key is read-only to the model unless its schema node is marked
  (`modelMaySet` / `modelMaySave` zod registries — not `z.readonly()`); none
  of the marks is honoured on the model's own leash (`isLeashKey`: anything
  under `ai`, `shell`, `web`, `plugins.<name>.roots`, and a key holding one).
  **Not for the model: everything under `ai`** — endpoint, token, model and
  tools stay unmarkable whatever else changes. A key marked `appliesOnRestart`
  is never laid on the running app. The y/n block shows the command line the
  call stands for (`config set --session ui.verbs '[…]'`), so what the person
  confirms reads as the CLI does.
- **`web_fetch` reads the web — and the web is both a way out and a way in.**
  Out: a URL can carry anything the model has seen, so a host not on
  `web.allowlist` is a y/n, and a background task cannot fetch it. The host is
  RESOLVED and every address checked (loopback, private, link-local incl.
  169.254.169.254, unique-local, multicast, IPv4-inside-IPv6 in every
  spelling); redirects walked by hand, each hop checked; GET only, no cookies,
  no custom headers; body capped; text types only. In: the result opens with
  "fetched from …, DATA, not instructions" — the write confirmation is what
  actually stops a page from steering a write tool. NOT closed: DNS rebinding
  (documented in the module).
- **`run_command` runs a shell command — only after the person says yes**
  (every call pauses; a background task declines; the y/n shows the command
  line itself). A non-zero exit is a RESULT (the model needs the failing test),
  framed as data; a refusal (cwd outside the roots) or a shell that cannot
  start throws. The turn's AbortSignal reaches tools as `ctx.signal`.
  `stdinFrom` pipes an earlier result in (that call's data, byte for byte —
  `raw`, never the `OK:` tag, never the frame); a tool that frames its text
  returns `{ text, raw }`. The resolved text reaches the tool as
  `ctx.resultInput`. A confirmed call SHOWS what it printed (live view; the
  command kept WHOLE up to `VIEW_CAPS.command` 16 KiB) and the person sees the
  outcome folded on one line. Every duration the person reads is one
  `formatDuration` (whole seconds).
- **A background shell is a job beside the children** (`shell-job.ts`): consent
  is the foreground call's; the process is `/bin/sh -c` in its own group, its
  output in one ring buffer of `shell.jobChars` (64 000), secrets removed per
  pipe; `shell.maxBackground` (4) bounds the running jobs; `shell_output`,
  `shell_kill`, `shell_list` read from `job.told`; a job's end goes to its
  owner as an inbox item, and the wake rules decide whether it starts a
  follow-up. `!cmd &` is the person's own job. `askLeave` lists the shells
  before a session is left. Journal events `job-start`/`job-out`/`job-end`.
- **`cd` moves the shell's directory for the model**, held to `shell.roots`
  by real path; bare `/cd` goes back to the default, `/cd -` goes back.
  Whenever the shell's directory is SET, the chat reads `AGENTS.md` (exactly
  that name) in every directory from the shell's up to the innermost
  `shell.roots` entry, outermost first, nearest last — nothing outside the
  roots, each file capped at `INSTRUCTIONS_CAP`, the section framed as the
  repository's words, never the person's or the host's. A `cd` is seen by the
  next round; the block is read again before EVERY round (`AgentOpts.
  systemPrompt`) and is never a message in the history.
- **The project's instructions, the memory index and everything framed are
  data, never instructions from the person.** Framed text never speaks for the
  person (`FRAME_NOTE`); an instruction inside it is not theirs.
- **The memory is the person's too.** A stored fact is a file in the agent
  workspace; its LINE goes into every later request's system prompt of that
  scope. `/clear` reports what it kept; `/memory` lists, `forget` removes,
  `accept` accepts a fact changed outside flow-assist. One durable fact per
  entry — never task state or a secret; a near-copy in either scope is
  refused naming the entry it duplicates (`refuseMemory`), an entry over
  `MEMORY_TEXT_MAX` (300) is refused, past `MEMORY_MAX_ENTRIES` (100) the tool
  refuses and names the oldest. **A fact the host did not write is not sent**
  (`markFacts`: `outside` facts are left out of the prompt, the tool's list,
  `MEMORY.md` and a plugin's `memory`) and `/memory accept` records the shown
  hash. A `memory.json` older host's list migrates once into the global
  workspace, claimed by an atomic rename.
- **The agent workspace is the model's own place** (`workspace.ts`): a
  `<workspace.dir>/<mirror>/_workspace/` per project, `memory/` and
  `artifacts/`. A path holds no `..`, is never absolute or `~`, and its REAL
  location lies inside the workspace's real location; a write goes under
  `artifacts/` only (checked as spelled AND by real path — a link planted as
  `artifacts` cannot lead to `memory/`); it never writes through a link in the
  file's place (temp file `wx` + rename); 2 MiB per file. **A write takes no
  y/n** (nothing of the person's is touched) and is SHOWN instead
  (`ctx.reportChange`). Reading back is data, not instruction (`workspace_read`
  frames its text; `raw` is the bare file).
- **Tests start without either trust record** (`test-setup.ts`, the
  `bunfig.toml` preload), and `hostStateDir()` is a temp directory per test
  process — **resolve such paths on EVERY call, never at import**, or one
  test's state rides into the next.
- **Two limits bound a turn** (`src/assistant/rounds.ts`): `ai.maxRounds`
  (150) and `ai.maxTurnTokens` (2 000 000); the one reached first ends it,
  says where, and `⏎ continue` carries the work on (`CONTINUE_WORD`). A
  background task takes `ai.taskRounds` (12). **A looped answer is stopped
  where the repeat began** (`loop-guard.ts`: an exact 1–32 code-unit repeat,
  400 code units of run) and the same `continue` carries it on; the guard is
  always on and has no config key.
- **A tool describes what it shows, a renderer draws it, the host frames it**
  (`src/assistant/views.ts`): `ctx.liveView(kind, data)` / `ctx.reportView`;
  `viewRenderers` map a bare kind to a renderer (`scopeViews` qualifies it);
  `frameView` caps rows, strips escape sequences, one row is one line, cut to
  the width — never wrapped. Display only: a view rides on the display
  message and never on the tool's result. A view's `callId` is
  `${turnKey}.${callSeq}#${n}` (the provider's own id is not unique across
  rounds). A reset makes a new `Conversation` with its own buffers; every
  callback of a turn still running writes into the object it started in and
  checks `closed` before it draws.
- **A write shows what it changed.** A tool that edits text calls
  `ctx.reportChange({ title, before, after })` after a successful write; the
  host diffs (`src/assistant/diff.ts`: LCS, 3 lines of context, 80 drawn) and
  the chat keeps a `✎` block **always open — never foldable: it is the part of
  a turn the person most needs to see**. It is DISPLAY only — the model's
  history does not grow by a copy of every edit. Only the tool knows what
  "before" is; the host never guesses it. The `✎` line is a title, not
  markdown; each row carries its line number in the file (dim gutter, out of
  a selection).

## The chat — the contracts

> How the chat feels is `docs/usage.md`; the render and key machine (folds,
> clicks, row cache, eye-landing, queue boundaries, key vocabulary) is pinned
> in `docs/internal/agents/chat-spec.md`. Here is what must never regress.

- Who speaks is said by a **gutter marker and a ground**, not a label:
  `›` the person, `ƒ` the assistant (also signing the frame), `◆` a background
  result, `!`/`‼` a command. A marker is ONE narrow-width code point (a wide
  glyph shifts the row in a terminal that draws it two cells wide). Colours
  come from `theme.modals.chat`.
- Markdown in answers is laid out by flowtty's `layoutMarkdown`; **the person's
  own message is drawn as typed, not as markdown** (every line break and
  indent kept). Only role `user`: a background result and a `!command`'s block
  stay markdown.
- **⏎** sends; while an answer is coming it **queues**, and a queued message
  reaches the model at the turn's next REQUEST BOUNDARY. ⇥ holds one message
  to the turn's end; a message naming an image waits for the end AND holds
  everything behind it. **A queued message never undoes what just ended** (the
  conversation holds ONE list and replaces it on every change). **Esc** while
  an answer or `!command` runs **stops it, on the first press**, touching
  neither the field nor the queue; `stopped (Esc)` names the key that stopped
  it. A stopped or failed turn does not send the queue — it comes back into
  the field in order. The chat stays busy from `!!command` into its ask's turn.
- **⇧⏎/⌥⏎** is a newline (also backslash-then-⏎); a paste is ONE key
  (`{ name: 'paste', text }`) — never decoded into keys, so a pasted newline
  does not send and pasted letters fire no binding (match on `key.name`, never
  on characters of pasted text).
- **The person's field is flowtty's `editorReducer`** (multiline): caret by
  character/word/visual row, Home/End, kill bindings, paste at the caret are
  NOT host code. The caret is a UTF-16 index resting on a grapheme-cluster
  boundary; columns are display width. `<TextArea>` itself is never mounted —
  the host has ONE key dispatcher (`useInputHandler`). `chatFieldWidth(width)`
  is the one place the field's width is computed — the view and the key
  handler must agree.
- **↑/↓** walk the prompt history — every submitted line, with no line twice
  in a row; a `/command` with `history: false` is never kept (its argument may
  carry a secret). ↑ on an empty field takes the last queued message back
  first. The wheel and PgUp/PgDn scroll.
- **What is open and what is folded** (`folds.ts`): ONE global state (all
  folded / all open — where a conversation starts) plus the blocks a CLICK
  made an exception of; `details` (`^o`) is the master switch and clears the
  exceptions; a block that did not exist yet follows the global state; the cap
  on an open tool trail does NOT follow it. A click (press + release on the
  same cell, no drag between, ~250 ms) opens the block under it, or closes an
  open block — and must not dismiss the reminder, close the log or answer a
  y/n. A block taller than the conversation opens in the pager; a run of steps
  always opens inline. Row ids (`foldId`) name a message by its place among
  the messages that are DRAWN — not the message object (the chat replaces a
  message whenever it changes) and not its raw index (the system prompt draws
  nothing and is unshifted again with every question).
- **Where the eye is left**: opening a block lands its first row under the
  pinned question; closing keeps the clicked block's first row where it was;
  a long answer stops at its first row once the rows would carry it past the
  top; following the bottom belongs to a message ARRIVING, never to rows
  appearing above the viewport.
- **A turn is drawn in the order it happened** (`step.ts`): one assistant
  message, its `parts` in the order they happened — never grouped by category
  (a category layout would move a round's text above every diff of the turn).
  A round's text never moves: while it streams it is dim under a live mark;
  the moment a tool-call fragment arrives it is a step, in its run. `step` (the
  default) folds each run to ONE dim row; `open` draws every step in full. The
  `Next:` token is never drawn; its sentence is the step. The reasoning is a
  block of its own, where the model thought it. Round bookkeeping lives
  outside the state updaters. A round cut off keeps its text where it was
  drawn. Under the answer only the quiet line stays: how long, what it cost
  (`3.1k tok` from the provider's reported usage — never estimated).
- **The tool trail is condensed and capped**: consecutive calls of the same
  tool that ended the same way are one line with a count; a failed call keeps
  a line of its own with its reason. A trail's tone is red when a failure was
  never followed by a later successful call of the SAME tool, yellow when it
  was. Every cut counts cells per grapheme cluster (`cutStep` / `cellWidth` on
  `@flowtty/core`'s `stringWidth`) — a wide character never pushes a row onto a
  second line.
- **The status line while a turn runs says what happens NOW**: a running
  tool's label pulses; with no tool running a WORD (a gerund per request,
  `ui.verbs` replaces the list) shimmers; the PHASE is the colour (magenta
  while the model thinks, the assistant's accent while its text arrives). The
  seconds are the running THING's, not the turn's; the turn's total and cost
  stay on the quiet line under the answer. The stream callbacks read what they
  clear through the conversation's own state (`toolLabel`), never the render's.
- **The y/n pause is the one guard** (see confirm policy above) and it is
  never silently answered: the auto mode answers only what the rules allow.
  Subagent y/n blocks stand in the field's place (or as a notice line), and
  only `y`/`n` on an empty field with the block drawn answer it, and only
  after the 600 ms guard pause (`child-ask-guard.ts`, `askClock` the seam a
  test moves). ⏎ and Esc never answer it. A question from a subagent the
  person started is the same request with its own block and machine
  (`askKey`). "Closing is not an answer" (above). The picker, the pager and a
  host panel hold every key while drawn and never reach the conversation
  beneath them.
- **The session picker** opens on the current project's sessions, Tab for
  all, grouped by project. The status comes from disk and this process:
  `working` / `waiting` / `held` (another process has the lock) / `done` (an
  answer nobody read) / `idle`. ⏎ reopens; `^p` moves the row into the
  current project (three steps, safe to kill at any point and retry); `^x`
  deletes after the picker's own y/n; `^r` renames. A HELD session is never
  written, moved or deleted by this process.
- **Sessions survive a restart** (`sessions.ts`, task file 600): one object —
  the screen list, the model's `api`, summary, plan, usage, history, draft,
  tools, model, `shellCwd` — saved together or not at all. **A session belongs
  to the project it started in**; a `cd` later does not move it; the picker's
  `^p` is the one deliberate move, held to the same lock as every other write.
  **Two processes on one session do not overwrite each other**: an ownership
  lock beside the file, a token per chat INSTANCE; a write whose on-disk
  fingerprint (rev + mtimeMs + size) does not match what this chat last saw
  **forks** into a new session and says so — it never overwrites. The
  fingerprint at a load is taken with a stat BEFORE the content is read (a
  write in that gap must be caught as "changed elsewhere"). A session left
  while it works (turn, `!command`, y/n, tasks) keeps its lock until the last
  one ends. The state file is bounded (`trimScreen` 400 rows / `KEEP_VIEWS`
  100 views; history ~400 messages cut at a turn boundary, never between a
  call and its result). Sessions are made through ONE registry
  (`ConversationRegistry`): one lock token for the chat's life, `retire`/`park`
  only when a conversation is **quiescent** (its six clauses), `park` THROWS
  on a conversation that still has work. Under `bun test` with no
  `sessions.dir` **nothing touches disk** — `bootApp` gives every test a temp
  dir and a workspace root of its own.
- **The journal is the record; the state file is what a restart restores** —
  one JSONL per session, appended AS IT HAPPENS (`journal.ts`): `start`, `row`,
  `step`, `answer`, `call-start` (before its y/n), `confirm`, `call`, `shell`,
  `shell-out` (whole, streamed), `shell-end`, `call-out`, `markup`, `compact`,
  `end`, `task-end`, `subagent`, `task-start`, `skill-load`, `ask-parent`,
  `ask-answer`, `child-answer`. **No tool writes to the journal** — it is the
  host's record; a tool's ctx carries nothing that writes there. A subagent
  keeps its own journal under `<home>/<sessionId>.sub/`; a task's lines are
  tagged into its owner's. `/export` renders the journal as markdown (the
  PERSON's command, no y/n, never overwrites). The journal lives as long as
  its session — every delete takes state file + journal + `.sub` together.
  Journal paths are resolved on every call (a session the picker moves is
  found where it is); a fork redirects the rest of a turn in flight.
- **The conversation the model sees is never the display list.** `apiHistory()`
  sends API fields only and never half of a call/result pair; display-only
  rows (notes, views) never reach the model (`apiHistory` drops them). A turn
  that did not finish is closed in the model's history too (`STOPPED_TURN` /
  `failedTurn` in the model's own voice) — left open it reads as a question
  still waiting and the model answers both. A turn the loop guard stopped is
  closed the same way, without an error. A provider's refusal is READ
  (`llmErrorMessage`, pure) — the raw body is never pasted to the person. A
  request that fails for a reason that passes is made again (`withRetry`:
  429/5xx/network; `Retry-After` honoured; **a round that gave anything to its
  callbacks is never repeated**); an abort is never repeated.
- **Two wires, one history**: what the host keeps never changes shape; the
  Anthropic request is converted on the way out (`anthropicRequest`); thinking
  blocks go back unchanged within a turn and never outlive it. A compaction's
  summary is a HANDOFF with fixed sections and the new one REPLACES the old.
  Automatic compaction runs in `AgentOpts.beforeRequest` — before EVERY
  request of a turn, so a compaction never parts a call from its result.
  Cache usage rides on `TokenUsage` (`cachedTokens`/`cacheWriteTokens`),
  `undefined` — never `0` — when the provider reports none.
- **An image is kept as a ref and sent as a part**: everywhere the host keeps
  a message its content is a string and images ride beside as `ImageRef[]`;
  the session file never holds base64. `/compact` sends `[image: name]`. A
  provider 400 that talks about images is quoted once as a `note` naming
  `config set ai.images.enabled false`.
- **Two queues: the person's and the inbox.** The inbox holds what reaches
  the chat from outside — a background result, a plugin's `postToChat` — and
  **never enters a running turn**; at a turn's end (or at once when idle) every
  waiting item lands at once, each as a `◆` row and framed as DATA for the
  model (`<child-result n=NONCE>`, `<plugin-message …>`; a nonce new per
  landing). The person's queued messages go first and the first carries the
  landed items; otherwise ONE follow-up turn for all of them
  (`ai.backgroundFollowUp`). A pending y/n or question holds the inbox; a
  draft does not; a closed chat does not — `◆ N new` and one alert per
  landing. A stopped/failed turn, and a turn ended at a limit with nothing
  queued, lands the inbox as rows only.
- **A conversation starts a child of its own** (`startChild`): `task` or
  `subagent`, with its own plan, shell, tool set and abort; the policy is made
  from its writes (`deny` never lifts and is write-blind all the way down;
  `allow` runs each write the auto mode with `shell.autoRun` answers; `ask`
  waits). A child that may not vouch cannot start one that may. A task stays
  within `ai.taskRounds` (12) and the worker prompt; a subagent the person
  started **stays after its answer**, takes messages (`/subagent tell`), and
  its later turns deliver answers the way its first did (only when they read a
  child's result). Depth `ai.subagentDepth` (2) stops the recursion. A task
  that ends hands its children still live to its parent. Only `close('clear')`
  and `close('parent')` stop the subtree (`stopChildren`); the person's stop is
  `stopSubtree(glyph)`. A child's y/n is parked in the child and offered
  upward (`offered()` — the oldest request of the whole tree, with its path);
  `ask_parent({question})` goes to the person (a staying subagent) or to the
  conversation that would receive the result, which answers with
  `answer_child` — a turn ending unanswered leaves the child the no-answer
  text. The model is told this contract, **not a kinder one** (`subagent`'s
  description: results arrive when the turn ends, never mid-turn).
- **Agent files and skills**: a file is a `---`-fenced header + body,
  `{{name}}` filled; the reader is our own and total — every error names the
  file and line, and a failed file is never offered. Three finders (the
  project's `.flow-assist/`, the person's under `hostStateDir()`, a plugin's
  manifest). **Trust is hash-recorded and asked once** (`agents.accepted.json`,
  `agent-trust.ts`): a project file with no record or another hash asks at the
  person's start; the model starts only a recorded current hash or a plugin's
  file. A skill's `SKILL.md` body is loaded fresh and answered only when its
  hash is recorded (`skillTrusted`); the refusal is one line — `ask the person
  to run /skill once`. Both records are never written from the model's shell
  (`inModelShell()`).
- **The plan (`todo`) belongs to a conversation** (`createPlan`), `ctx.plan`;
  ids `t1`, `t2`, … never reused within a plan; the drawing follows PLAN ORDER
  with flowtty's checkbox glyphs and **no number beside an item** (a number on
  screen is what the person and the model each read as something else). The
  reminder (`PLAN_REMINDER`) goes on the round's last real work result, once
  per turn, after the result's cap — and the result's data is kept beside it
  first, so a later `stdinFrom` pipes the data without the reminder. **Tool
  state that describes a conversation is never module-level** (as a module
  variable the plan outlived `/clear` and leaked into the next test).
- **`!!command` runs an INTERACTIVE program and hands its recording to the
  model** — through `services.suspend`, under `script`, `$0` a neutral name
  (`!!`, never the temp file's path — bash errors for a SOURCED file name the
  file; `eval "$(cat "$1")"` does not), and util-linux's `-c` STRING never
  gets `!!` into it (csh history expansion). Whatever was recorded is sent to
  the model and asked about; nothing recorded — a block on screen only. The
  recording is cleaned as a terminal would have left it (`cleanRecording`:
  `\r` overwrites, sizes clamped, the alternate screen DROPPED whole), then
  `sanitizeViewText`, then capped at `shell.maxChars`.
- **`!command` runs a shell command** — the person's own, typed into the
  field; the field carries a bang LEVEL (0/1/2); `!` on an empty field steps
  up, Backspace/Esc on an empty field step down; Enter reads only the UI state
  to pick the level, never the field's TEXT for a leading `!`. The directory is
  remembered between commands within the roots (`pwd -P` to a private temp
  file), `exit N` or a kill keeps it; `/clear`/`/new` go back to the default.
  The result is a `shell` message that joins the model's history (mapped to
  `user`); no turn is spent on it.

## Secrets — the rules

> What these measures do NOT do (they stop the accident, not a model that
> tries) is spelled out in `docs/safety.md`, which also holds the settings
> guard's flow walkthrough and the trust record shapes. Here is what must
> hold in code.

- **The host knows the secret values** (`src/assistant/secrets.ts`,
  `SecretSet`): every env var the config names (`${VAR}`, `ai.tokenEnv`), every
  variable whose name matches `SECRET_NAME_RE`
  (`TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|API_?KEY|_KEY$` — a plugin's
  `requiredSettings` token is one these), and a literal at a secret-looking key
  of the config (an MCP server's `headers.Authorization`), and a request header
  expanded as sent. A system variable (`PATH`, `HOME`, `LC_*`, `XDG_*`, …) is
  NEVER one, whatever names it. Built at start and again whenever a value is
  set or unset; a value is never logged or journaled.
- **`redactSecrets(text)`** replaces each occurrence with `‹secret NAME›` —
  the value and its base64/base64url/URL forms, longest first; a value under
  `SECRET_MIN_LENGTH` (8) is never redacted. Matches are found with terminal
  escape sequences taken out. **One choke point per channel**: tool results
  (`agentChat`'s `detailStr` and `raw`), view data and `reportChange` diffs
  (before `acceptData`), command output (inside `runShell`, before `onOutput`
  or the kept tail), the model's answer and reasoning (a stream per round,
  flushed in a `finally`), view text (`sanitizeViewText`), the log, what a
  plugin says and every toast, the system prompt (`withSystemPrompt`), and the
  backstop (`appendJournal` and `saveSession` write `redactDeep`) — at write
  time only: what a call runs is what the model wrote. The person's own words
  are shown and sent as they are; on disk the backstop takes a pasted token
  out of them too. `secretStream` holds back the shortest tail that could
  still grow into a secret — a chunk boundary never lets a split one through,
  and a held tail is never emitted in clear.
- **The model's commands run without the secrets**: `run_command` starts from
  the process's env less every name of the set (`withheldEnv`), except
  `shell.passEnv` (on the leash); what was withheld is named once per
  conversation. The person's own `!`/`!!` keep the whole environment; their
  output is still redacted.
- **A settings file the host did not accept is never applied silently**
  (`config.accepted.json`, 0600): the guard keeps the hash and content it last
  ACCEPTED (its own writes and the person's y/n); at a start a file whose hash
  differs is not applied and the app asks — one change asked in ONE
  conversation at a time (`said.configAsking`), each change re-checked when
  its turn comes and again at the answer. No writes the accepted content back
  beside the rejected text (`<file>.rejected-<time>`). A change the model's
  shell made (`FLOW_ASSIST_MODEL_SHELL=1`) is accepted by that process and
  asked about by a running app. The auto mode never answers the question. The
  model's commands run with `FLOW_ASSIST_MODEL_SHELL=1`; the person's
  `!command` does not set it.
- **A plugin or a memory fact the host did not record does not reach the next
  start** (`src/loader/trust.ts`, `memory-trust.ts`): `plugins.trusted.json`
  (first start is ONE per record and trusts every valid entry of the directory
  it checks, then sets the flag), `memory.accepted.json`, `agents.accepted.json`
  (files by real path → sha-256) and the skills keys of the same file. From the
  model's shell a missing record trusts nothing and writes nothing. Only
  `PLUGIN_NAME` (`^[A-Za-z0-9][A-Za-z0-9._-]*$`) is a plugin. A check forgets
  stale entries; a tombstone (`forgotten`) never grants trust and only the
  person clears one (`plugins trust`, `plugins remove`); a retarget is untrusted
  with `was`/`now` and answered with `yes`. `plugins install` and `plugins
  trust` record what they install/trust; the model's install forgets trust and
  says `installed, not trusted`. The records stop the accident, not a
  same-user process that forges them.

## Config & environment

- Config: `~/.config/flow-assist/config.json` + `config.local.json`; the
  schema comes from the host and each plugin's `configSchema`. A change to
  either settings file the host did not accept is asked about before it
  applies (the guard above).
- **A value is set in one of two scopes, through one path** (`setConfigValue`):
  `config set <key> <value>` saves to `config.local.json`;
  `:config set --session` is this run only (the session map). Either is laid
  on the running app at once — except a key marked `appliesOnRestart`
  (`ui.mouse`, `ui.hover`, `keys`, `theme`, `sessions`, the chat's `mode`,
  `keycaps.enabled`, and on the leash `ai.provider`, `ai.baseUrl`,
  `ai.tokenEnv`, `ai.disabledTools`), whose value waits for the next start and
  says so. A saved value takes over from a session value. The CLI refuses
  `--session` and names the `:` line. `config get` says where a value comes
  from (`session`/`local`/`config`/`default`) from the layers `loadConfig`
  kept — never a second read.
- Environment: `LLM_TOKEN` (or `ai.tokenEnv`; `ANTHROPIC_API_KEY` with
  `ai.provider: 'anthropic'`) and optional `FLOW_ASSIST_PLUGIN_REGISTRY_*`;
  host variables take the `FLOW_ASSIST_` prefix. A plugin owns its own
  variables and declares them in `requiredSettings`.
- `agents.maxAuto` (`ask`|`reads`|`all`, default `reads`) — the highest auto
  mode an agent file may run in; `agents` is a root of the model's leash.
- `ai.images`, `ai.recall`, `ai.models` / `ai.roles` / `ai.model`, `ai.thinking`
  and the derived `answerCeiling` behave as the model docs say (`docs/config.md`
  and `model-roles.ts`); all sit under `ai`, on the leash: no mark, only the
  person sets them. `config.user` (`name`, `login`) is the only source of the
  person's identity — never the environment or the OS account.
- **Roots: each consumer has its own key, and the host never reads a plugin's.**
  The host's shell is confined to `shell.roots`; `repo` to
  `plugins.repo.roots`, falling back to `shell.roots`, then to the legacy
  `fs.roots` (one `legacyRootsNote` covers the fallback). **A key that is SET —
  an array, even `[]` — is the answer: nothing falls through an empty list.**

## Testing

- From the host root: `bun run typecheck && bun test ./src ./scripts ./packages`
  (the path filter keeps a locally dropped-in plugin's suite out of the host
  run). `./packages` is `@flow-assist/remote`'s own suite. Plugin tests:
  `cd plugins-available/<name> && bun test`. **The host suite must pass with
  `plugins-available/` empty — a host test never loads a real plugin.**
- **A test never reaches the person's own files.** `hostStateDir()` is a
  temporary directory of this process under `bun test`; the workspaces, the
  legacy memory file, the tool log and both settings files resolve through it;
  the cache keeps its store in memory; the sessions have their own `null`:
  **resolve such a path on every call, never at import** (a `bun test` run
  shares its module registry across every file), and **a temp directory is the
  floor; a file of the test's own is the isolation** (`bootApp` names a
  sessions dir, memory file and workspace root per boot).
- `helpers/scripted.ts` — a scripted model + booted app on a test backend,
  only the network replaced; it honours the request's `signal` like a real
  fetch. `helpers/conversation.ts` — `conversationRig(model, opts)`: ONE
  conversation on the host's real services and tool registry, no App.
  `helpers/session-files.ts` — find a session's files under the project
  mirror (`listTree`/`homeIn`), never by listing flat. `scripts/ui-frames.ts`
  renders frames for eyes; `scripts/eval-*.ts` are live-model evals (cost
  money; `--fake` checks the harness). Remote plugins are held by
  `remote-transports.e2e.test.ts` over REAL processes; the other side is
  `helpers/remote-fake-plugin.ts`. **A fake for a validating route must reject
  what the real one rejects; prove a new test fails on the bug before trusting
  it.**

## CLI

- **The interactive screen needs a terminal on both ends** (`runInteractive`
  checks first; a `new TtyBackend()` without an interactive stdout THROWS —
  the backend is built on the interactive path ONLY, never before a
  subcommand has been ruled out).
- flowtty restores the terminal on SIGINT/SIGTERM/SIGHUP and honours
  `NO_COLOR`/`FORCE_COLOR`; the host adds no handler of its own (a plugin with
  a child follows the process-life rules above). **The kitty keyboard protocol
  is on, and not a setting.**
- **The console goes to the log** while the TTY backend owns the screen;
  `onConsole` (`consoleBridge`) keeps the run's last 200 lines and
  `runInteractive`'s exit writes them to stderr after the terminal is
  restored. Delivery is on a microtask (React prints mid-render).
- Subcommands: default `interactive`; `config get|set|unset|help`;
  `plugins ls|install|trust|remove|update` (install takes a name or an
  archive — member list checked before extraction: no links, no `..`, one
  top-level `<name>/`; what it installs is trusted; `trust` trusts a plugin put
  in another way; there is no separate `enable`); any other arg is a one-shot
  `<prompt>` — ONE headless conversation, `canAsk: false` (it declines every
  write; `--allow-writes` lets them run, each said on stderr), no journal, no
  session, no screen, nothing streamed. Exit codes: 0 an answer, 2 a limit or
  nothing kept, 1 a failure or anything that fails before the turn. Every
  stderr line about the turn passes `redactSecrets`.

## Git

- **Never** append a `Co-Authored-By: Claude` trailer (or any Claude
  `Co-Authored-By`) to a commit message.
- Branch from `master`; the default branch here is `master`.
- **Versions**: semver, `0.x` while the plugin contract may still change. The
  version lives in `package.json` and `src/version.ts` (a test keeps them
  equal); each release gets a `CHANGELOG.md` entry and a `vX.Y.Z` tag. A
  bundled plugin ships with the same release and carries the host's own
  version (a test keeps every bundled plugin equal to `hostVersion()`).
  `packages/remote`'s version equals the host's the same way; it is published
  with each release by `bun publish` from `packages/remote` (`prepublishOnly`
  builds `dist/` with `.d.ts`; the package ships `dist` and `src` but not
  `src/**/__tests__` — `package.test.ts` holds that, and that the package
  builds on its own with the root's `@types/bun`).

---

## Trigger index — read the reference when the work touches it

The rules in this core win where the two ever disagree.

- `docs/internal/agents/sessions-journal-spec.md` — `sessions.ts`,
  `journal.ts`, `session-picker.ts`, `conversation-session.ts`.
- `docs/internal/agents/chat-spec.md` — `views/modals.ts`, `step.ts`,
  `folds.ts`, `cells.ts`, the chat's key handler.
- `docs/internal/agents/plugins-runtime-spec.md` — `src/loader/*`, a plugin
  in `plugins-available/`, `src/remote/*`, the wire protocol.
- `docs/internal/agents/shell-jobs-spec.md` — `shell*.ts`, `run_command`,
  `interactive.ts`, `background-bang.ts`.
- `docs/internal/agents/ask-children-spec.md` — `conversation.ts`'s child
  ports, `child-schedule.ts`, `subagent-command.ts`, `child-ask-guard.ts`.
- `docs/internal/agents/model-wire-spec.md` — `agent.ts`, `anthropic.ts`,
  `llm-*`, `compaction.ts`, `recall.ts`, `tool-results.ts`,
  `context-meter.ts`.



