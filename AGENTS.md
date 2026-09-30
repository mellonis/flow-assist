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

## Comments describe the code as it is

A comment or doc line states what the code does and why, in the present tense —
never how it got there. No "used to", "no longer", "was renamed", "previously",
"since alpha.N", "as before", "now does X" where "now" contrasts with a past
state: that is history, and history belongs only in `CHANGELOG.md` and git. A
past incident may motivate a rule; keep the rule, drop the incident.

- Bad: "That used to require an explicit `host.notify()` in every setter."
  Good: "The host calls `notify()` after every handled key, so a setter needs
  none."
- Bad: "an old `fullscreen: true` reads as `full`, and `/fullscreen` is gone."
  Good: "`fullscreen: true` reads as `full`; there is no `/fullscreen`."

## Stack

- TypeScript **7.0.2** (native `tsc`), module `NodeNext`, target `ES2022`, `strict`.
- Bun **1.4.x** — `bun run`, `bun test`. The TUI runs as `bun src/cli.ts`.
  **A `bun build --compile` binary WORKS, given plugins are shipped BUILT** (probed
  end to end on Bun 1.3.14, 2026-09-21, and the kit's binary again on 1.4.2, 2026-09-29: pack → install → the compiled host draws the
  tracker's board). The one limit: inside a compiled binary a runtime `import()` of
  an on-disk package fails with "Cannot find module" when that package's
  `package.json` has an **`exports`** field — scoped or not, string or conditions
  (`main`-only packages and deep paths resolve). So a plugin run from SOURCE with its
  own `node_modules` is skipped by the binary; a plugin bundled into one file has no
  on-disk package left to resolve, and loads. This is not a two-React problem:
  plugins take hooks from `ui` and import only types from React.
- **Where the program finds its plugins and `.env`** (`src/install.ts` on the pure
  `src/loader/install-root.ts`). The root holding `plugins-available/` +
  `plugins-enabled/` is the first of: a source checkout (one up from `src/`, never
  the binary's virtual `bunfs`), `dirname(realpath(process.execPath))` — the directory
  a compiled binary is installed in, through a link to it — and the working directory,
  which is also what gets reported when nothing is found. Both plugin dirs must exist
  for the first two. Bun reads `.env` from the working directory only, so when the
  root is elsewhere `<root>/.env` is loaded too, never overriding a variable already
  set (not under `NODE_ENV=test`). `install.ts` is `main.ts`'s FIRST import: a module that
  reads the environment when it is evaluated must see the `.env` values, or a `.env`
  loaded from `main` would reach only half of the program.
- **The entry is `src/cli.ts`, the CLI is `src/main.ts`, and React runs its
  PRODUCTION build.** React and the reconciler inside `@flowtty/react` pick their
  build by `NODE_ENV` when first loaded, and Bun leaves it unset — so the app ran the
  development build, about twice as slow per scroll step. `cli.ts` sets
  `NODE_ENV ??= 'production'` (`defaultToProduction`, `src/node-env.ts`: a value
  already set wins — `test` under `bun test`, a person's `development`) and only THEN
  imports `main.ts` dynamically; a static import would be evaluated before the
  assignment. So nothing imports `cli.ts` (it runs the program) and `main.ts` is never
  run directly; tests import `main.ts`. The compiled binary is settled at build time:
  `build:binary` passes `--define process.env.NODE_ENV="production"`, and the bundle
  holds no development React at all (`bun run test:binary` builds it and checks —
  skipped by the regular `bun test`, as it compiles a ~60 MB binary; run it before
  building a release) — a
  `NODE_ENV` set when running the binary changes nothing. The scripts
  (`ui-frames`, the evals) stay on the development build, like the tests they share
  a rig with. No enabled plugin is never silent:
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
  dependencies never reaches it. `files` in `package.json` (as npm reads it)
  names what ships, beside the manifest and `package.json` — for a plugin whose
  directory also holds what it is built from (a client package of a workspace).
- **A plugin kept in a repository of its own** is linked into `plugins-enabled/` from
  wherever it lives — and trusted with `plugins trust <name>` ("Secrets", the plugin and
  memory records) — and it takes React, flowtty and the host's sources for its tests
  through links to this checkout's packages (one React, never two). `bunfig.toml`
  keeps `bun test` here out of `plugins-enabled/`: such a plugin's tests run in its
  own repository.
- React 19 + `@flowtty/react` / `@flowtty/tty-backend`, zod 4.

## Repos

- `flow-assist` — this host. Plugin sources live under `plugins-available/`, each a package with its own dependencies; the host never imports a plugin or a plugin's dependency.

## Layout

```
flow-assist/
├── package.json               # host; root of plugins-available/*, workspace root for packages/*
├── docs/
│   ├── usage.md               # the user manual: working in the chat
│   ├── safety.md              # the user manual: what the assistant may do, and the limits of that
│   ├── config.md              # the user manual: config, scopes, environment, installing plugins
│   ├── plugins.md             # "Writing a plugin" — the contract for plugin authors
│   └── demo/                  # the GIFs of the README and docs/usage.md
├── examples/
│   ├── notes/                 # the plugin docs/plugins.md builds; run by the host's tests
│   └── remote-login/          # a remote plugin; docs/plugins.md, "A plugin in another language"
├── packages/
│   └── remote/                # @flow-assist/remote — the protocol's types, codec, runPlugin, its shared server
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
version, description, `hostApi`, `flowtty`, `deps`, `surfaces`, `tools`), and is enabled by symlinking
it into `plugins-enabled/`. At load time the host qualifies every registry key
with the plugin namespace (`<plugin>:<view>`, `<plugin>:<tool>`), while display
labels keep short names.

## Plugin contract (`shape`)

**The host API has a number, `HOST_API` (`src/version.ts`).** It covers everything the
host gives a plugin — the object each hook receives and what is on it (components,
hooks, services), the shape's hooks and their signatures, the manifest's fields — and a
change a plugin built for the previous number would break on bumps it, in the same
commit, with a CHANGELOG line saying what a plugin must change. A plugin names the
numbers it works with (`hostApi` in its manifest, a number or a list; none is 1) and the
flowtty it needs (`flowtty`, a semver range, checked against `FLOWTTY_VERSION`, which a
test holds equal to the installed `@flowtty/react`). One pure check, `pluginCompat`
(`src/loader/compat.ts`), answers for every place a plugin is met, from the manifest
alone and before its code is imported: `loadPlugins` skips it (a line into the log
through `loadNotes`), `plugins ls` shows `incompatible: …` (`RepoEntry.incompatible`;
`list()` also lists a plugin linked into `plugins-enabled/` from outside
`plugins-available/`, source `linked`, with its missing settings, and a link to
nothing as `broken link`), and install refuses it — a link, an archive before it is
moved into place, a registry fetch before it replaces the installed version (which is
set aside and restored unless the new one is compatible; a batch update names each
failure). A manifest.json that does not parse says `manifest.json is not valid JSON`
(`readPluginManifest` → null). A missing `flowtty` is loaded with a note; the bundled plugins and
both examples declare both fields (a test). A plugin reads the number it runs under
from `host.hostApi`.

A plugin module default-exports `build<Name>Plugin({ renders, config, make, z,
modelMaySet, modelMaySave, appliesOnRestart, toolsChanged })`.
The builder may be **async** — the loader awaits it, and the app draws after it, so it
must be short. A plugin whose tools are known only after it has asked someone (the
`mcp` plugin connects to its servers, over Streamable HTTP or, for a server that is a
command, its stdin and stdout) returns at once and says so with **`ready`**, a promise
on the plugin object that settles when it is done waiting, either way; it is the
plugin's job to bound that wait (see "The first frame waits for nobody" below). `z` is the host's
zod: a plugin with no bundler, and so no runtime dependencies (the compiled binary
cannot import a package from disk), still declares its `configSchema` with it. The
three registries beside it are the host's config marks (`src/config/schema.ts`, "Config
is the person's" below): a plugin registers a key of its own schema in them, and a mark
is found by its node in the host's registry, so it must be these. They are an addition:
`HOST_API` stays as it is, and a plugin that must also run on an older host checks that
they are there.
`toolsChanged` is for a plugin whose tool groups change while the app runs (the `mcp`
plugin's servers connect late, drop, are turned off): it sets `tools` on the plugin
object `make` returned and calls it, and `refreshToolRegistry` (`src/loader/tools.ts`)
assembles every group again INTO the registry object already handed out — the App, its
services and the context meter hold that object, so it is never replaced — with
`ai.disabledTools` read again and a name clash said once per registry. Every assemble
and refresh of the current registry moves `toolRegistryRevision()`, and `agentChat`
reads it before each round (`readTools`): when it moved, the catalog, the index, the
group descriptions, the wire names and the defs the y/n reads are worked out again, so
a group that arrives mid-turn is sent (and indexed) from the turn's next round; when
it did not, the round sends what the last one sent, byte for byte — a refresh costs one
prompt-cache miss, a round without one none. A def a refresh took away is KEPT in the
turn's `toolByName`: a call the model makes from an earlier list still asks the person
when the tool is a write. A call runs against the registry as it is; **a tool a refresh
took away never runs again**, for the turn in flight and for a model that remembers the
name later in the run. The registry keeps the group that last held it (`left` in
`assembleToolRegistry`) and THROWS why it is gone, never reaching that group's `exec`:
the group's own word when it has one (`ToolGroup.gone(name)` — the `mcp` plugin's server
state: `<name> is not connected — retrying in N s`, `<name> was removed by the person`),
else the host's — `<tool> is gone — <plugin> removed it`, `… — <plugin> was disabled`
(the person took the plugin's tools out, `registry.withhold`), `… — <plugin> is not
loaded` (the plugin left the list: a remote plugin being restarted). Never a bare
`Unknown tool`, and never a "call again" for a tool that is not coming back. A plugin's
ai-tool carries its own `run`, which `agentChat` calls itself: it does so only while the
registry still holds that def (`chatToolLive`) — a def the registry made and no longer
holds goes through `execChatTool` and gets the same answer; a caller's own `extraTools`
always run. `registry.refresh()` refreshes that registry alone (the App calls it when a
plugin joins); the process-wide `refreshToolRegistry` refreshes the last one assembled.
`make(name, shape)` injects `config.plugins.<name>` and qualified keys. The
returned `shape` has optional: `commands`, `keys`, `keyActions`, `views`,
`surface`, `modals`, `colors`, `modalColors`, `configSchema`, `components`, `tools`,
`services`, `aiTools`, `keycaps`, `entry`, `screens`, `setup`, `chatContext`,
`chatSubject` (deprecated), `afterWrite`, `ready`; every hook, and each
`components[slot] = ({ ui, host }) => Component`, receives the plugin's pair (below).
`services` expose host services through `host.services` — the host wins on every
key it owns, a plugin's same-named key never clobbers it. `setup` runs once,
before any of the plugin's components mount (it is where a plugin seeds its store). Tool groups are delivered by plugins — there is
**no** `tools-available/` → `tools-enabled/` repository; `ai.disabledTools` is
the blacklist.

- **What a plugin is given is `{ ui, host }`** (`src/runtime/plugin-api.ts`). The rule:
  `ui` is what React and flowtty ship, passed through unchanged — `h`, `useState`,
  `useEffect`, `useRef`, `Fragment`, flowtty's own `useInput`, `Box`, `Text`, `Markdown`, `Table`,
  `Link`, `ScrollBox`, `Select`, `ListSelect`, `ListMultiSelect`, `Checkbox`,
  `TextInput`, and @flowtty/core's `isPrintable` and `stringWidth` (a plugin cannot
  import its own: a second copy would not share the width policy the backend sets) —
  one object for every plugin, built by `makePluginUi` (`src/runtime/plugin-ui.ts`;
  `src/runtime/__tests__/plugin-ui.test.ts` holds it, and docs/plugins.md's table, to
  every member `PluginUi` declares); `host` is what the host implements or wraps — `services`,
  `store`, `config`, `keys`, `keyCap`, `useInputHandler`, `useSurfaceSize`,
  `useTerminalSize` (the plugin's side, not flowtty's whole terminal), `notify`,
  `viewRegistry`, `commandRegistry`, `helpFor`, `copyToClipboard`, `pluginToken`,
  `hostApi`, `open`, `close` (the plugin's screens, below — bound to the plugin where
  its pair is built) — one per plugin. `host.services` stays the live per-plugin view (host
  services on its prototype, rebound every render): never flatten it into `host` or
  spread it. Each pair is built once per App, where `apiMap` is filled, so a component
  factory makes one component type for the App's life. A change to either part a
  plugin would break on bumps `HOST_API`.
- **`ui`'s flowtty components** are `Box`, `Text`, `Markdown`, `Table`, `Link`,
  `ScrollBox`, `Checkbox` and the three pickers: `Select` (flowtty's dropdown — its popup is a floating dialog, so the
  App is rendered under a `<DialogHost>` at the frame's origin, and while a popup is
  open the host's key path is muted: the exit keys still take their two presses,
  Ctrl+] waits for the popup to close), `ListSelect` and `ListMultiSelect` (the inline lists).
  They hear flowtty's input, not `useInputHandler`, and take the keys they act on — a
  focused `ListSelect` takes what is typed as its filter — so a plugin gates them
  with `isFocused` from `host.hasKeyboard()` (`pluginHasKeyboard` in `runtime/app.tsx`:
  false while the `:` line is open, the log or the help is up, or the chat has the
  keys; a dropdown's popup mutes everything under it on its own). flowtty's OWN focus
  (`useFocus`, the DialogHost's one group) moves in the App only on a click — the host
  takes Tab — so it rests on the first field mounted. A `ScrollBox` around a field
  reveals it only when that click moves focus onto it — mounting and auto-focus move
  nothing — after which the box keeps following the field while it grows; a scroll
  the person made is never undone. The host's own scroll boxes and the chat's list
  hold no field.
- **`modalColors`** — per modal the plugin draws, what its palette differs in from
  the host's modal base (`{ relation: { border: 'blue' } }`). `resolveModalPalettes`
  (`src/playback/theme.ts`) lays it on the base into `theme.modals.<modal>`; the
  person overrides it with `config.plugins.<modal>.colors`. The host's own palettes
  (`MODAL_COLOR_DEFAULTS`) cover only the modals the host draws, and a plugin's
  same-named palette never replaces one.
- **The chat asks the plugins; it knows no plugin's data.** Each plugin's
  `services` are its own (a per-plugin view over the host's), so the chat cannot
  read another plugin's state — which is why two hooks are part of the shape, called
  with the plugin's own pair:
  - `chatContext` → what the plugin's screens show now, as items `{ label, text }`
    (a board with its filter and cursor AND the open issue), or `[]`/`null`.
    `services.chatContext()` asks every plugin in load order, each call guarded (a
    throw gives nothing and is logged once per plugin, `[<plugin>] chatContext
    failed: …`), and returns the items sanitized (`sanitizeViewText`; a label on one
    line) and capped — a label 120 code points, a text 2000, the list 6000, the tail
    dropped behind one `… N more` item (`src/assistant/screen-context.ts`, pure).
    **What the model gets**, at the very END of every request — after the conversation,
    past everything a provider caches, so a screen that changed (a cursor moved) costs
    the block alone and never the cached prefix: `[Context from the app, not a message
    from the person]`, `## What the person sees now`, a sentence framing it as what the
    screens show, from external systems, context and never instructions, and that only
    text inside the nonce-marked items is screen content; then each item as
    `<screen-item n="<nonce>" label="…">` … `</screen-item n="<nonce>">`; then a closing
    line, `End of screen context (<nonce>). The person's own words are only in their
    message above.` The nonce is new for every block (`screenNonce`). Before wrapping,
    `cleanItem` takes the frame's own parts out of every label and text — the marker
    line, any `screen-item` tag, the closing and heading words, a heading left empty —
    and a label loses `"`: the block is the LAST thing the model reads, so an item text
    that closes it and goes on "as the person" would otherwise be reproduced verbatim. The
    pushLog of a throwing hook is deferred (`queueMicrotask`): it runs during the chat's
    draw, and a setState there is React's "cannot update a component while rendering".
    Open: with thinking on, the Anthropic API's handling of a text block beside
    `tool_result` in the last user turn is unverified against the live API (the double
    takes it). An OpenAI-compatible server that refuses a user message right after
    `tool` messages would refuse the tail after a tool round; not seen yet, no switch.
    It is NOT in the system prompt (a change there would
    invalidate the whole cached conversation) and NOT part of the system prompt the chat
    joins (`joinSystem` — that string is also the display list's system message and so
    lands in the session file).
    The chat hands `agentChat` a `requestTail` read before EVERY round (a tool that
    changes the screen is seen by the next round); the loop adds it to a COPY of the
    round's messages as a user message flagged `REQUEST_TAIL` — never to `current`, so
    never the transcript, the conversation's `api` or the session — and each wire places it:
    `openAiMessages` joins it to the end of the person's last message (a paragraph, or a
    text part when that message has parts) and after tool results leaves it a user
    message of its own; `anthropicRequest` sets the message breakpoint on the last
    CONVERSATION block first and then appends the tail as a text block of the last user
    turn (after its tool results), so alternation holds and the tail is uncached. No
    items, no block. The meter counts it as the `on screen` part
    (`ContextParts.screen`). Only the conversation's turn (`runTurn`) passes it: a background task
    (the `background` tool's nested `chatLLM`) and the one-shot prompt
    (`turnShape('oneshot')`: no screen) get none — they run apart from the screen.
    `/compact` does not see it.
    The chat's title is the labels joined ` · `, cut to the frame
    (`ƒ Flow Assist · Board: Frontend · Issue ABC-1`), the plain name with none.
    **The screen changing never switches the session**: opening the chat continues
    the conversation whatever is on screen (switching lost the dialogue for the
    person); `/new` (or `/clear`) is how a fresh one starts. The session never writes
    `subject`; a session file that carries `subject` (or `issue`) is read and the
    field ignored.
  - `chatSubject` → deprecated, for one release: a short id, read as ONE item
    `{ label: <id>, text: '' }`; a plugin that has `chatContext` is not asked it.
  - `afterWrite` → called, for every plugin, after a chat turn in which a write
    tool was confirmed and APPLIED (not declined, not failed): reload what you show,
    or an open document keeps its text from before the write. It may return a
    promise; a rejection is logged as `[<plugin>] refresh after a write failed: …`.
  The host reaches them as `services.chatContext()` / `services.afterWrite()`
  (bound in `runtime/app.tsx`).

### The first frame waits for nobody

The interactive app draws before any plugin that waits on another party is ready
(`runInteractive`, `src/main.ts`). `loadPlugins` (`src/loader/build.ts`) loads every
enabled plugin AT ONCE — import, build, a remote plugin's transport — and puts them in
the list in the order they are enabled, whichever finished first (the order decides who
keeps a bare tool name and the `chatContext` order). Two modes:

- **Wait** (no `late`): every remote handshake and every plugin's `ready` is awaited.
  The one-shot prompt and `config set plugins.…` load this way — they read the tools
  once, have no screen to show sooner, and a remote plugin's `configSchema` is what
  validates its key.
- **Late** (`late`, a `LatePlugins` from `src/loader/late.ts`): a remote plugin is not
  awaited — its promise goes to `late.expect` — and a plugin's `ready` to `late.wait`.
  The hub keeps what is still starting (`starting()`) and turns each outcome into an
  event — `joined` with the plugin, `skipped` with the loader's own line (`skipLine`,
  `[plugins] skip <name>: <why>`, the reason redacted), `ready`, and `note` — every line the adapter and the
  transport say (the process's stderr, a restart during the handshake) — held until the
  App listens (a fast handshake can land before the first render), then appended to the
  app's log. None of it is `console.warn`ed: under the TTY backend the console bridge
  would log it a second time as `[console.warn] …` and print it again at exit.
- **An exit during a pending handshake** stops the process too: the stdio transport puts
  a child into its exit hook's `live` set the moment `spawn()` returns, before its
  `spawn` event, and nothing else knows of it yet (the adapter's stop is registered
  after `hello`). `remote-transports.e2e.test.ts` holds it with a real host process
  (`helpers/late-exit-host.ts`) that exits while the fake never answers.

**A plugin joins the running App without a remount** (`renderApp`, `listen` in an effect,
dropped at unmount so a test's late handshake never reaches the next test's App). It is
inserted into the SAME `plugins` array the tool registry was assembled from, at its place
in the enabled order (`joinIndex`, from `late.order`/`rank`, which the loader sets) — so
keys, the palette, `chatContext` and the start screen follow the config, not the timing
— and
`rebuildFromPlugins` builds again INTO the objects already handed out: `keys` (every
plugin's `host.keys`; a refused-key note said once, `keyNote`), the view and command
registries (the `:` line and the chat's plugin commands read them), the palette (as a
scheme change does), `tools.refresh()`, and `services.pluginAiTools`. The components are
built PER PLUGIN, once (`compsOf`, keyed by the plugin object): a plugin's `setup` and
factories run on the first render that sees it, and every plugin already mounted keeps
its component types — a memo over the whole list, rebuilt, would make new types and
React would mount the chat anew, its turn, draft and queue gone.
`src/__tests__/late-plugins.e2e.test.ts` holds it against a held handshake (the fake
remote's `holdHello`): the frame drawn with `starting: fake…`, the plugin joining with
its entry key and caps, a refused handshake as one skip line, and a turn begun before
the join sending its tools from the next round with the draft still in the field.
`bootApp`'s `opts.late` loads that way (a guest's `ready` included); without it the rig
waits for every plugin, as the one-shot prompt does. `opts.dirs` gives a boot a
plugins-available/ and plugins-enabled/ of its own through the real repository (and
`opts.trustFile` its trust record), which is what the `:plugins` tests lay plugins out in.
The `:plugins` panel's enable and restart join through the same hub
(`loadEnabledPlugin`, `src/loader/build.ts` — the loader's own one-plugin load).

### A plugin that starts a process owns its life

The `mcp` plugin starts a server given as a `command` and talks MCP over its stdin and
stdout (`plugins-available/mcp/src/stdio.ts`). One process per server at a time —
process-level state on purpose, unlike a conversation's; one that dies is started again
by the plugin's retry (below) — and the rules any plugin that spawns something
long-lived follows:

- **It never keeps the program alive.** The child and its pipes are unref'd, so
  `config set plugins.…` and a one-shot prompt still exit when their own work is done
  (`plugins ls` and `config get` load no plugins at all and spawn nothing; a
  `plugins.*` key does, because a plugin's key is validated by the plugin's schema). A
  request in flight holds the program through its ref'd timeout timer — without one a
  one-shot prompt could exit in the middle of a call whose answer was on its way.
- **It ends with the program.** `process.on('exit')` covers `:quit`, Ctrl+C (twice) in
  the app and a command running out of work; a signal ends a program WITHOUT that event, so
  SIGTERM/SIGHUP/SIGINT are heard too.
- **A signal handler must not swallow the signal.** flowtty decides whether to re-raise
  one by COUNTING listeners — with a second listener present it unmounts and leaves the
  signal to the app, and the app would then live through Ctrl+C. So the handler stops
  its processes, removes ITSELF, and re-raises only when no listener is left.

### A server that is not there is tried again

`plugins-available/mcp/src/servers.ts` holds each MCP server's life: `connecting`,
`connected`, `failed`, `disabled`. A server that fails to connect — at start or later —
or DROPS (a call's error is the transport's: `McpError.lost` from a fetch that threw or
a stdio process gone through `onDead`, a 502/503/504; a call that timed out, got another
5xx or a 404 asks the server `ping` within `connectTimeoutMs` — a JSON-RPC result or
error is an answer, and keeps it with the call's error for the model; a 404 to the ping
is a session the server forgot, so the client drops its session id, initializes anew
and the call is made again, once; anything else — no answer in time, the line down, any
other non-2xx — drops it — while a 401 or 400 is that call's error alone) loses its group and is tried again on `RETRY`: 5 s, 15 s, 60 s, then every 5 minutes. A
401/403 is the token and is never tried again (`authReason` says so and names `/mcp
restart`). Every attempt carries the server's generation; `disable`, `restart`,
`remove` and a drop start a new one, so an attempt that finishes under an older one lets
go of its client and brings back nothing. A call from a turn that saw a server's tools
before it left is told where the server stands (`notConnected`; the group's `gone` is the
same, but null while the server is connected — back without that tool, the host's own
`is gone` answers, never a "call again" that would loop): disabled, not connected and when it is tried next, or — after `/mcp remove` —
`<name> was removed by the person`; `connected again since — call the tool again` only
when it did come back. The first attempts are `start()`, which the
builder does not await: it is the plugin's `ready`. Every connect and every failure calls
`onChange` with its event: the plugin sets `plugin.tools` and calls the host's
`toolsChanged` (the group is in the next round's index), keeps the start screen's
`N of M servers connected` current, and logs it. A first attempt's event carries
`first`: its line goes to the log alone (`statusLine`, and the `readOnly` names the
server does not offer) — the start of a run is not news, and a continued conversation
would gain a row at every start. A connect after that also says `<name> connected — 1
tool` / `N tools` through `services.chatNote`, which the host draws as `[mcp] …`. A line
said before `setup` (a server that answers before the App is up) waits in `early` and is
flushed there. `:mcp help`, too long for the one-row toast, opens the chat and is
said there as a note. Timers are unref'd and cleared at exit (`process.once('exit')`
stops every manager). The clock and the schedule are injected (`timers`, `retry` —
builder options the loader never passes), so the tests run the schedule without waiting
it; `src/__tests__/mcp.e2e.test.ts` holds the late group reaching the index of the next
request, a 401 asked once, and a connect held past the first frame: the frame drawn,
`starting: mcp…` on it, and a turn begun before the connect sending the group from its
next round, its write still asking.

**`/mcp` is the person's lever over them** (`plugins-available/mcp/src/command.ts`, a
plugin command with `chat: true` and `complete`): bare, a panel in the chat (name,
transport, state, read-only count; `d` disable/enable, `r` restart, `t` tools) and one
line on the `:` line; `disable|enable <name> [--session]` act at once and save
`plugins.mcp.servers.<name>.enabled` through `services.setConfig`; `restart` resets the
backoff; `add <name> <url | command args…>` writes the whole entry (so the schema's
one-transport check holds; a command is split on spaces, never a shell line) and
`remove` unsets it, refusing — with `/mcp disable` as the way — when config.json still
sets it. `headers` and `env` are never taken from the chat (a secret in the chat's
history and session); the help says `config set`. A server `enabled: false` at start is
listed and never connected. There is no tool for the model: config is the person's.

### A handled key is followed by a redraw

A plugin usually keeps its state in ONE component (a workspace that publishes it on
`host.services`) and draws it in a SIBLING. A React `setState` in the first re-renders
the first only; the sibling redraws when the host re-renders. The host calls
`notify()` after every handled key, so a setter needs none of its own; a setter that
did would change the state and freeze it on screen, and the bug is easy to read as
intermittent — anything else nearby that keeps calling `notify()` on its own (data
still loading) keeps the sibling redrawing and hides the missing call, until that
stops.

The host guarantees it: `useInput` in `runtime/app.tsx` calls `notify()` after every
key that was handled (`twoPhaseDispatch` returned true). React batches it with
whatever the handler set. A plugin still calls `host.notify()` for changes that do NOT
come from a key — a fetch that finished, a timer.

### A plugin is a guest: whose screen it is

The app opens on the HOST's start screen (`src/views/home.ts`: the ƒ mark drawn
large, what can be done from here, the enabled plugins). A plugin is a guest on it:
mounting every plugin component from the first frame would draw a plugin's own
screen — a tracker's "No board data" — over an assistant nobody had asked for a
board.

- A plugin's **surface** — its own full screen — is the component slot named `view`,
  or named after `shape.surface`. Every other slot (modals, key triggers, the
  workspace that feeds them) is furniture and is always mounted, which is how a
  plugin's own key (`c`, the board picker) works from the start screen.
- The surface is mounted **only while the plugin says its context is active**:
  `keycaps` non-empty. That is the existing contract of `keycaps` ("returns `[]`
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
- While a plugin is still starting (below) the start screen names it on one dim line
  under the list, `starting: tutor, mcp…` (`startingLine`, `src/views/home.ts`,
  from `late.starting()`), gone once each has joined or failed. A plugin joins the list
  — and its entry key the start screen, its caps the footer — only once it has.
- An enabled plugin the person has not trusted ("Secrets") never starts, so it is never
  on that line: it has a dim row of its own at the end of the list, `<name>  not trusted
  — flow-assist plugins trust <name>` — for a retargeted link `not trusted — its link
  led to <was>, now to <now> — …`, for a refused name `"<name>"  refused — …` with no
  command (`untrustedText`; `renderHome`'s `untrusted`, handed over by `runInteractive`
  from `loadPlugins`' `untrusted`), shown under the `plugins` heading even when no
  plugin loaded. Under the list, dim lines say what the trust records say once
  (`trustNotes`: the plugins the first start trusted, a record that cannot be read —
  the loader's and `memoryRecordNotes()`).

### Screens the model can open

The host has no notion of which screen is up — a plugin's own state decides, and its
`keycaps` tell the host to mount the surface. So a screen the host can open is one the
plugin DECLARES (`shape.screens`, `src/runtime/screens.ts`): its name → `{ entry?, title?,
params? (JSON Schema), tools?, open(api, params), close?(api) }`. `open` lives in the shape,
not a component, and sets the plugin's own state, which is how it opens a screen whose
surface was never mounted. Two ways in, one set of rules (`createScreens`, made once in
`renderApp`, bound as `services.screens`, each plugin's `host.open` / `host.close` bound
to its name where its pair is built — a bare name is its own, `<plugin>:<screen>`
another's):

- `host.open(screen, params)` — a plugin's navigation tools (the migration path for a
  plugin whose tools called stubs its mounted screen replaced); `ui_open(plugin)` — the
  model's core tool, the entry screen (`entry: true`, else the only one), no params.
- Refused, as a readable `Not opened: …`: a built-in plugin or a `HOST_PANELS` name
  (`:plugins`, `/mcp`, the picker, settings, help, log — never a way for the model to lead
  the person to a trust key), a plugin in `disabledNow`, one in `site.untrusted` (the text
  names no trust command), one not loaded or still starting (its pair not built), an
  undeclared screen (the plugin's screens named), params that fail `toolArgsError`
  against the screen's `params`, or any params for a screen that declares none. A throw
  from the plugin's `open` is its reason.
- **Never over the person**: with the chat's draft non-empty while the chat has the keys
  (`store.chat.typing`), the
  `:` line open (`ui.cmdOpen`) or a y/n or question waiting (`store.chat.asking`), the
  open is DEFERRED and answers at once — a tool that awaited the turn it runs in would
  never end: `<plugin>:<screen> is not open yet: <why>. It opens when this turn ends.`
  (outside a turn — `store.chat.busy` false — `once the chat is free`). The conversation's
  `afterTurn` (`src/assistant/conversation.ts`) calls `screens.afterTurn(ok)`: a turn that ended opens what it held (the
  draft stays in the field — opening never moves the keyboard), unless a question still
  waits; a stopped or failed turn drops it with a log line, as it restores rather than
  sends the queue. Outside a turn, an App effect (`screens.settle`, after every render)
  opens it once nothing holds it back. A deferred open's own answer goes to the log, a
  failure to a toast too.
- Opened while an open chat covers the plugin's side (a window, `full`), the answer says
  it is behind the chat. Esc closes a screen as the plugin's own key does; `close` asks
  the plugin's `close` and says Esc when there is none.
- **The model's list**: `promptBlock()` — `## Screens`, one line per non-built-in plugin
  the person trusts and has not disabled, with screens or an `entry` key: the screens'
  titles (else the description), `key <glyph>` of each `entry` action's binding, and
  `open with` `ui_open("<plugin>")` (an entry screen with no `tools` of its own) and
  every screen's `tools` — else `the person opens it with its key`. Plugin text is one
  line, `sanitizeGroupDescription`ed and cut. It is part of the system prompt after the
  base (`systemParts.screens`, counted under `system` by the meter), and like the
  project's instructions it is read again for EVERY round (`AgentOpts.systemPrompt`): a
  plugin that joins mid-turn is offered `ui_open` from the next round (the tools
  refresh), and its line comes in the same round; an unchanged list is the same bytes,
  so the cached prefix holds. A `:plugins` disable or enable is in the next round too;
  '' with nothing to list.
- **A remote plugin's entry** is declared by the adapter (`src/remote/adapter.ts`): one
  screen named after its first bound `hello.entry` action, titled by its manifest's
  description, whose `open` presses that key only while the surface is closed (the last
  frame's `keycaps` empty — else it returns `ALREADY_OPEN`, answered `<key> is already
  open.`, and sends nothing: once up, the key may close or run something) and only
  through `deliverKey`, the person's own path less the keyboard-side check (the model
  asks from the chat, which has the keys): not stopped, and the frame's `keys.consume`
  takes it — else `it does not take its entry key S now`. The plugin answers it as it
  answers the key, and its next frame's `keycaps` bring the surface up. No screen with
  params crosses the wire, and a remote plugin has no `host.open`.
- **Background work opens nothing**: the `background` tool runs its nested `chatLLM`
  under `asBackgroundWork` (`src/runtime/background-work.ts`, an `AsyncLocalStorage`), so
  every await of it — a plugin's tool calling `host.open` included, which has no ctx of
  the chat's — reads `inBackgroundWork()`; `screens.open` and `ui_open` refuse there.
- A stopped or failed turn's `afterTurn(false)` drops what it deferred BEFORE looking at
  `asking()` — a settings y/n (`askConfigChanges`) may be up as the turn ends.
- The list caps a line's screens and tools at `LINE_ITEMS_MAX` (8, then `+N more`) and
  the block at `PROMPT_BLOCK_MAX` (4000 characters, then `+N more plugins`).
- The host sees only the chat's draft and the `:` line: a field on a plugin's own screen
  is not guarded, and docs/safety.md says so.
- A DEFERRED open is resolved and its params checked again when it runs (`flush`): a
  plugin disabled, untrusted or gone meanwhile is not opened — a log line and a toast.
- **`ui_open` is offered only when it can work**: `assembleToolRegistry`'s `screens`
  (the app's registry — `runInteractive`, `bootApp`; never the one-shot prompt's) and a
  non-withheld plugin with an entry screen; a refresh recomputes it, and a call from an
  older list answers the core group's `gone` (`no plugin in the app has a screen it can
  open now`). A refusal throws (the model reads an error), a background run
  (`_bgDepth`) and a run with no `services.screens` refuse too.

`src/__tests__/screens.e2e.test.ts` holds it. `HOST_API` stays: `screens` is an optional
field an older host ignores, and `host.open` / `close` are optional members a plugin
checks for before it calls them (docs/plugins.md, "Compatibility").

### Remote plugins

A plugin can be a separate process, in any language, speaking JSON-RPC 2.0 over its
stdin and stdout, or over a shared socket several hosts connect to at once — the
protocol as its authors read it is docs/plugins.md, "A plugin in another language".
`remotePlugin` (`src/remote/adapter.ts`) turns that conversation into an ordinary
`Plugin`; nothing else in the host knows a plugin is remote.

- The plugin sends its whole screen as a `frame` notification whenever it changes,
  never a diff; React reconciles it like any other render. `renderTree`
  (`src/remote/tree.ts`) turns a frame's tree into elements over the same `ui`
  components a JS plugin draws with; `children` and `ref` in a node's props are
  reserved and dropped.
- **A frame the host cannot draw never takes the App down.** `drawFrame` puts each
  root — the surface, each modal's overlay child — behind an error boundary
  (`FrameBoundary`) that draws a dim `▸ frame failed: <message>` in its place and logs
  it once; a new frame clears it through a frame counter passed as a prop, never a
  React `key` (a remount per frame would lose a field's caret and a list's filter).
  The slot components themselves stay outside it, so `RemoteModals`' key handler and
  effects survive a bad modal.
- **A stateful node's value is the host's, not the plugin's.** `src/remote/fieldState.ts`
  keeps it by `id` and checks a frame's value against a queue of the last 256 values the
  host itself sent as events for that id: a match is the plugin echoing a moment the
  host already knows, and is not a write. The one thing asked of the plugin: a field
  whose value it ever sets carries `value` from its model in every frame, so its echoes
  drain the queue and its own write lands (without them a write of a recently typed
  value is taken for an echo). A `ScrollBox` offset is held (`hold`), never queued —
  nothing is sent to echo — so a frame's differing `offset` is always a write. A node
  with a held value is CONTROLLED by it, so its own change redraws at once
  (`RenderCtx.redraw`, the host's `notify`): keys that arrive together — a paste, key
  repeat — would otherwise each start from the value before the last one.
- **Keys are consumed by what the frame declares** (`src/remote/keys.ts`): an entry
  naming one of the plugin's own actions (a key of `hello.keys`) takes the person's
  effective binding for it (`host.keys[action]`), any other is a key in the binding
  vocabulary — resolved once per frame, in the key handler, since a frame may arrive
  before `setup` hands over `host.keys`. The `key` event carries three names — the
  terminal's own, the canonical one bindings are compared by, and the action whenever
  the key is a declared action's effective binding. A plugin's actions share the one
  keymap with the host's and every other plugin's (`buildKeys`), as a JS plugin's do.
- **An open modal has the keyboard.** The surface renders with `hasKeyboard() &&` no
  modal open — the host's own modal-over-surface rule — so a surface field focused
  under a modal never hears what is typed into it. A root (the surface, a modal) with
  several `isFocused` nodes is said once in the log (`focusedCount`).
- `keycaps` with `{ action, label }` draws `` `${host.keyCap(action)} ${label}` ``, so
  a rebound key never needs the plugin to know.
- `viewRenderers` are built from the manifest's `views`, not `hello` — every renderer
  must exist before any tool has run. Each answers from a cache keyed by
  `(kind, data, width)`, behind a dim `▸ kind` placeholder while `view.render` is in
  flight.
- `hello` runs at load — in the app, in the background: the plugin joins the running
  app when it is answered (below) — and again after every restart, each with a 10 s timeout; the
  guest rule ("A plugin is a guest", above) still holds a remote plugin to it, since
  `keycaps` reads the last frame the same way for a remote plugin as for one in the
  host's own process.
- **The `Transport` seam** (`src/remote/transport.ts`) is what the protocol layer
  knows of a process: lines in, lines out, a close. Three things implement it: a
  child over stdio (`src/remote/transport-stdio.ts`), a shared server over a local
  socket (`src/remote/transport-socket.ts`), and a pair of in-memory streams
  `loadPlugins`'s own tests inject (`LoadPluginsOptions.remoteTransport`).
  `src/remote/transports.ts`'s `transportFor` picks between the first two from the
  manifest — `connect` for the socket, `run` alone for stdio — and wraps either in a
  restarting supervisor (`src/remote/supervisor.ts`).
- **A `run` child's rules are held here, not by the plugin**: started without a shell,
  its stderr going to the host's log. A close the host WAITS for — a refused
  handshake, on the first `hello` or a restart's — gets the full stop: stdin closed,
  then a grace period, then `SIGTERM`, then `SIGKILL` — the same shape "A plugin that
  starts a process owns its life" (above) holds any child to.
  `src/remote/transport-stdio.ts` follows the same rules as
  `plugins-available/mcp/src/stdio.ts` in code of its own, since the host imports no
  plugin.
- **A `connect` server is spawned detached**, with `run`'s command plus
  `--serve <socket path>`, and a host never kills it — only disconnects; another host
  may still be on it. Its stderr is `<socket>.log` beside the socket (opened for
  appending, 0600, emptied at a start past 1 MiB), never a pipe: the server outlives
  the host that started it, and a write to a pipe with no reader kills the writer. It
  ends itself, on its own idle timeout or a signal (`packages/remote/src/serve.ts`):
  `runPlugin` exits once `serveConnections` resolves, and a signal is re-raised after
  the cleanup when no other listener is left, so a handle the author holds never keeps
  an orphan alive with its socket gone. `shutdown` there is answered per CONNECTION,
  not per process: each client gets its own `hello` and its own protocol state, and
  what a server's clients share is whatever it holds outside a single connection.
- **Two hosts starting the same server at once are serialised by a lock beside the
  socket** (`src/remote/sockets.ts`): `<name>.lock`, holding `{ pid, at }`, taken with
  `O_EXCL`; a lock whose pid is no longer alive is stale and taken over, the rule the
  session lock also follows (`src/assistant/sessions.ts`) — an unreadable lock, a
  create whose write has not landed yet, is held while younger than that file's
  `UNREADABLE_HELD_MS`. The host that takes it probes the socket again before
  unlinking anything (the server may have come up in between), and releases only the
  lock it wrote itself.
- **The supervisor's backoff** (`src/remote/supervisor.ts`) lengthens each time
  another failure comes quickly — within a second of starting — 1, 2, 4, then 8 s; a
  fifth quick failure in a row gives up for good, logged as `disabled until restart`
  (the first of the five need not itself have been quick); a restart that stays up
  longer resets the count. A restart whose `hello` fails ends it the same way, at once
  (`src/remote/adapter.ts`'s `onRestart`). The very first `start()` is never a
  restart: if it fails, that rejects to the loader alone — a skip, said in the app's
  log when the app is already up — and nothing is scheduled.
- `src/remote/sockets.ts`'s `sockets/`, under `hostStateDir()` at 0700, is the host's
  own place for its sockets; a plugin names its socket, never a path.
- **The host's own exit** (`src/remote/lifecycle.ts`) asks every remote plugin's
  `shutdown` (1 s) then closes its transport, every plugin in parallel, bounded to
  `STOP_ALL_TIMEOUT_MS` (1.5 s) so one that never answers cannot hold the exit open;
  `src/main.ts` awaits it before its own `process.exit`. This is NOT the full stop
  above: the host does not wait past its own bound, so a `run` child still alive at it
  only ever gets the process's own exit hook's `SIGTERM` (`stopAllRemote`,
  `src/remote/transport-stdio.ts`) — never a `SIGKILL` from the host's own exit.
- **A crash**: the transport closes, the surface says `plugin stopped` with the last
  lines a `run` child wrote to stderr dim below it (`TransportClose.stderr`: five
  lines at most, 200 characters each, a last line without a newline included), every
  tool in flight and every new one throws the stop, and `onRestart` runs `hello` again
  from an empty frame.
- **`host.store` has no change hook**, so a JS plugin may read another's slice but is
  never told when it changes. **`host.store.set` by a remote plugin is different**: it
  fans out as a `store` notification to every OTHER remote plugin of the same app
  (`src/remote/index.ts`'s `storeBus`) — a JS plugin's own writes reach no one this
  way. A slice is a plain object, so `host.store.get`/`set` refuse `__proto__`,
  `constructor` and `prototype` as keys (`-32602`).
- `hello.locale` is read from the environment in gettext's own order
  (`src/remote/locale.ts`): `FLOW_ASSIST_LOCALE`, then `LC_ALL`, `LC_MESSAGES`, `LANG`.

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
  while one is up. Ctrl+C with a turn running still declines and stops.
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

## What the model can do (the `core` tool group)

`memory`, `workspace_read`, `config_schema`, `config_set`, `datetime`, `remind`,
`background`, `todo`, `ask_user`, `open_url`, `recall`, `ui_open` (a plugin's entry screen —
"Screens the model can open" above; offered while one can be opened), plus `host:plugins_list`;
`workspace_write` and `workspace_list` are the on-demand `workspace` group. Three rules
hold this set together:

- **A plugin's config key is validated by the plugin's schema — everywhere.**
  `configSchemaAt` (`src/config/load.ts`) resolves a key through the host schema and,
  for `plugins.<name>.*`, through the plugin's `configSchema`; `config set` in the CLI
  (which loads the plugins only for a `plugins.*` key), `:config set` in the app and
  the model's config tool all use it, so a plugin's key — `config set
  plugins.keycaps.enabled true` — is recognized by the tool and the commands alike,
  never known to one and "unknown key" to the other.
- **Config is the person's.** The model gets `config_schema` — keys, types,
  set/unset, active defaults, effective key bindings, each plugin's flags and what it
  may change itself — and **no values**. Config is the model's own leash
  (`disabledTools`, `baseUrl`, `tokenEnv`, plugin roots) and the assistant reads other
  people's text, so even a y/n-confirmed write is one prompt injection plus one tired
  keypress away. So **the model writes only a MARKED key, in the scope the mark
  allows**, through `config_set(key, value, scope)` (`scope` `session` — this run only
  — or `saved`); for every other key it answers with the `config set <key> <value>`
  command to run. `config_set` is `write: true` in effect — the y/n like any write, a
  background task declines it, the auto mode never answers it — but its write flag is
  a predicate (`configSetRefusal`) that is false for a call that will not happen: a key
  without the mark for the scope (a saved write of a key marked for the session only), a
  value the schema refuses. Such a call never reaches the y/n; `exec` throws the
  refusal, naming the key and the command the person can run instead. It runs only on
  the loop's own word that the person said yes to THIS call: `agentChat` sets
  `ctx.confirmedByPerson` for every call, after the caller's `toolCtx` so a caller cannot
  forge it, true only when the call went to `confirmWrite` and the answer was yes. A
  run with no confirmation never reaches it: the loop declines the write first (below,
  "a path to the model that cannot ask the person declines writes"). The y/n
  block shows the command line the call stands for — `config set --session ui.verbs
  '["Thinking"]'`, `config set ui.verbs …` — drawn as it is (`configLineOf` beside
  `shellCommandOf`, the block's `line` beside `command`), so what the person confirms
  reads as the CLI does, and typed on the `:` line as shown it sets the same value
  (`configSetLine` double-quotes a value holding an apostrophe, and `unquoteValue` reads
  `'\''` inside single quotes as one; a control character is drawn as its escape). Only
  the host's own bare `config_set` is drawn that way: a plugin's tool of the same name
  is registered qualified and keeps its arguments on the block. A confirmed call goes through `setConfigValue`, the path the
  person's own `config set` takes, laid on the app's live config, and answers whether the
  value is live now or `takes effect on restart`.
  **Every key is read-only to the model unless its schema node is marked**
  (`src/config/schema.ts`): two zod registries, `modelMaySet` (the model may change the
  key for the session) and `modelMaySave` (also in config.local.json — honoured only
  beside `modelMaySet`), each `{ reason }`, a node opting in with
  `.register(modelMaySet, { reason })`. Not `z.readonly()`: that marks a frozen parsed
  value, and a leash built from it would leave every NEW key writable until someone
  remembered to wrap it — the default has to be read-only, the safe keys the exception.
  `configMarks` walks the key's resolved path (a plugin's key through the plugin's
  schema, as `configSchemaAt` resolves it), looks for the mark on the key's own node
  through every wrapper (`optional`, `nullable`, `default` — `.partial()` wraps each field
  anew), and honours none on the model's leash (`isLeashKey`: anything under `ai`,
  `shell`, `web`, the legacy `fs`, `plugins.<name>.roots`, and a key holding one —
  `plugins`, `plugins.<name>`). `src/config/__tests__/marks.test.ts` walks the host
  schema and the built-ins' and asserts no mark under the leash and every save mark
  beside a set mark, and walks each bundled `plugins-available/*` schema (whatever is
  there — the suite still passes with it empty) and asserts it marks nothing: a key
  holding a path, a command, a URL or a token stays the person's. The host marks `ui.verbs`, `ui.mouse`, `ui.hover`, `sessions.resume`, the
  chat's `plugins.assistant.mode` and `panel.side`, and `plugins.keycaps.enabled`. A
  third registry, `appliesOnRestart`, marks a node whose consumer reads it only at start
  (`ui.mouse`, `ui.hover`, `keys`, `theme`, `sessions`, the chat's `mode`, `keycaps.enabled`, and on
  the leash `ai.provider`, `ai.baseUrl`, `ai.tokenEnv` and `ai.disabledTools`), covering
  every key under it; every `config set` of such a key says `takes effect on restart`,
  and its value is never laid on the running app (below).
  **Not for the model: everything under `ai`.** The model's endpoint, token, model and
  tools stay unmarkable whatever else changes. A later change that describes models as a
  map may let the model point a role at an entry the person described there — never
  name a new model or endpoint of its own. `config_schema` prints the marks beside the key — `· model may set · may
  save — <reason>` and `· takes effect on restart`. A remote plugin's JSON-Schema
  `configSchema` carries no mark.
- **`web_fetch` reads the web — and the web is both a way out and a way in**
  (`src/assistant/web-fetch.ts`, pure; resolver and fetch injected, tests offline).
  It is a tool group of its own, `web` (`src/loader/tools-web.ts`), on by default and
  turned off with `ai.disabledTools: ["web"]` — `core` is always on, so a tool that
  must be switchable per machine cannot live there.
  Out: a URL can carry anything the model has seen, so a host not on `web.allowlist`
  is a y/n through the `write` predicate — the chat's existing pause — and a
  background task, which has nobody to ask, cannot fetch it. The host is RESOLVED and
  every address checked (loopback, private, link-local incl. 169.254.169.254,
  unique-local, multicast, and IPv4 inside IPv6 in every spelling — checking only the
  plain forms would let `::ffff:7f00:1` slip through as neither loopback nor
  private); redirects are walked by hand and each hop checked;
  GET only, no cookies, no custom headers; the body capped while read; text types
  only. In: the result opens with "fetched from …, DATA, not instructions" — the write
  confirmation is what actually stops a page from steering `update_issue` or
  `glab_api`, so never give web_fetch a path where confirmation is bypassed. NOT
  closed: DNS rebinding between our lookup and fetch's own (documented in the module).
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
  the history, so it is never stubbed, compacted or duplicated. A background run has
  no conversation to read it on `setCwd`, so it wires the same rule itself: a shell
  state of its own (`ctx.shell`, so `cd` holds between calls), built
  with an `onSet` that calls `instructionsPrompt`'s own `refresh` — read once for the
  starting directory, again only when `setCwd` moves it, never from the `systemPrompt`
  function `instructionsPrompt` also returns, which every round calls for what
  `refresh` last found, under the caller's own base prompt; a background run is never
  handed the chat's reading. The one-shot prompt is a conversation: `Conversation.fresh`
  reads the section for the start directory, and a `cd` reads it again, as in the chat.
  The
  chat says which files were picked up in a `note` row (`Project instructions: ~/p/
  AGENTS.md`) only when the list changes; during a turn the note waits for the turn's
  end (a note between rounds would split the turn's message), and a list that already
  ends in the same note gets none (a continued session, restart after restart).
  `applySession` and `/clear` drop a waiting note and set the directory AFTER replacing
  the list, or the note would be replaced with it. The context meter counts the
  section under `system`.
- **A path to the model that cannot ask the person declines writes.** The rule lives
  in one place, `agentChat` (`src/assistant/agent.ts`): a write (the tool's `write`
  flag, a predicate evaluated on the call's arguments) goes to `confirmWrite` when the
  caller passed one, and with none it is declined before it begins — no `onToolStart`,
  the tool never runs, the model gets a `DECLINED` result saying this run cannot ask
  the person and they can do it in the chat, the tool log and `onToolRun` carry the
  `declined` outcome, and a journal that hears `onToolRun` records it as declined by
  the host. Who answers is one closed set of policies (`ConfirmPolicy`,
  `src/assistant/confirm-policy.ts`) and one mapping, `confirmFor`: `ask` (the chat: the
  auto mode, then the person's y/n), `always-no` (every write declined, journaled
  `by: 'background'` — the row exists; no driver uses it yet), `none` (nobody to ask:
  no `confirmWrite`), `allow-writes` (`--allow-writes`) and `caller` (a plugin's own
  confirmation).
  `confirm-policy.test.ts` holds each row. A read runs as ever. So passing a
  `confirmWrite` is a deliberate act, and leaving it out is safe. A caller can also
  withhold tools (`AgentOpts.withholdTools`): the names are left out of every request,
  of the index and of `tools_load`, and a call to one answers `Unknown tool` without
  running — the one-shot prompt withholds `background`, `subagent` and `remind`, which
  have nothing to deliver to without the app. Where each path stands:
  - the chat's turn — asks: its y/n closure, which the auto mode may answer;
  - a background task — declines: it passes a confirmation that always says no, which
    `journaledChatLLM` journals as a `confirm` line `by: 'background'`;
  - a tool's `ctx.chatLLM` in the chat (`journaledChatLLM` with no `taskLabel`) —
    declines unless the tool passes its own `confirmWrite`, whose answer is journaled
    `by: 'plugin'`; with none, the journal holds the declined call and no `confirm`;
  - the one-shot prompt (`runPrompt`, `src/main.ts`) — one `oneshot` conversation made
    where nobody can answer (`canAsk: false`), with the policy `none`: it declines.
    `--allow-writes`, given before the prompt, gives it the policy `allow-writes`
    instead — the person's yes in advance: it answers what the auto mode may answer
    with `shell.autoRun` on (`neverAutomatic` with both consents — so never
    `config_set`, an unlisted `web_fetch` or a plugin's `run_command`) and says each
    write it lets through on stderr as it runs (`[write] ! <command>`, else the tool
    and its arguments — through `sanitizeViewText`, each further line marked
    `[write]   `, so an escape code or a carriage return in the command cannot hide
    the line, and a known secret in it is its mark);
  - a plugin's `services.chatLLM` — declines unless the plugin passes a `confirmWrite`
    of its own (one that can ask the person);
  - a remote plugin's `host.chatLLM` (`src/remote/adapter.ts`) — always declines: a
    function cannot cross the wire;
  - `/compact` and the automatic compaction run no tools (`compactConversation`); the
    evals in `scripts/` call `agentChat` bare and so decline.
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
  person. The mode belongs to the CONVERSATION and is never saved: a restart, `/clear`
  and `/resume` all come back to `ask`, and the session file does not
  hold it. Three calls are not automatic in any mode on their own — `run_command` unless
  the person set `shell.autoRun` (the y/n is its only guard, and the command may have
  been written from a page the model just read), `web_fetch` (one that reaches the
  confirmation at all is to a host outside `web.allowlist`, which is exactly what its
  write flag tests) and `config_set` (config is the person's: even a key the model may
  change changes only with their yes); the last two never are. `shell.autoRun: true` is
  the person's second consent: with it AND the mode at `all`, the host's own
  `run_command` is answered like any other write; either alone changes nothing. "The
  host's own" is the def object the shell group made (`isHostShellTool`,
  `src/loader/tools-shell.ts`, passed to `confirmWrite` as `info.hostShell`), never the
  name: a plugin's tool called `run_command` — qualified, or holding the bare name while
  the host's shell is off — still asks. It sits under `shell`, on the leash, so the
  model can never set it. The chat reads it at each confirmation (`shellAutoRun`,
  `src/assistant/shell.ts`) and passes it into `autoConfirms` — live, not restart-only,
  since it only loosens a pause the person already chose with `/auto all`, so a
  `:config set --session shell.autoRun true` holds for the next command. A
  background task is
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
  that character in it (navigating to the "Other…" row first is not a step anyone
  guesses at), and a paste on the list opens it with its text. What does NOT open it: `1`–`9`,
  the shortcuts the list advertises — a numeric answer is typed once the field is open
  — and the space bar, which toggles in a multi-select. The hint line states that rule.
  **The field is the chat's own editor**: flowtty's `editorReducer` in its single-line
  mode, so the caret (`state.caret`, a UTF-16 index — `state.cursor` is the ROW in the
  list) moves by character and word, Home/End and the kill bindings work, and a paste
  goes in at the caret with its line breaks collapsed to spaces. Esc leaves the field
  for the list; Esc on the list dismisses the question.
- **The agent workspace is the model's own place** (`src/assistant/workspace.ts`). A
  directory per project that the HOST owns: `<workspace.dir>/<mirror of the project's
  path>/_workspace/`, the project and the mirror being the sessions' own (`projectOf`,
  `projectHome` — reused, never copied); no project is `<workspace.dir>/_global/_workspace/`,
  which is also where what holds for every project is kept (`scope: "global"`).
  `workspace.dir` defaults to `projects/` under `hostStateDir()`, resolved on every
  call. The `_workspace` leaf is there because mirrors nest: a repository inside a
  workspace root is a project of its own and its mirror sits inside the outer
  project's, so with the mirror itself as the workspace the outer project could list
  and read the inner one's memory; everything is confined to the leaf. In the mirror a
  path segment that starts with `_` gets one more (`_x` → `__x`, one-to-one), so no
  project — a repository named `_workspace`, a directory `/_global` — lands on another's
  leaf or on the global workspace. It holds
  `memory/` (the facts, below) and `artifacts/` — the model's working files: drafts,
  notes, plans, findings, a patch it was asked to keep. Directories 0700, files 0600.
  - `workspace_read(path, scope?)` is core — the memory index in every prompt points at
    it, and loading it per fact would cost a round each time — while
    `workspace_write(path, content, scope?)` and `workspace_list(path?, scope?)` are the
    `workspace` group (`workspaceTools`, one body `workspaceExec`), loaded on demand
    like any other and off with `ai.disabledTools: ["workspace"]`; the read tool's
    description names the `tools_load` call for them. A path is relative to the workspace, holds no `..`,
    is never absolute or `~`, and its REAL location — every link followed, a path not
    there yet through its nearest existing parent — lies inside the workspace's real
    location (`resolveInWorkspace`, on the host's `realOf`/`within`). A write goes under
    `artifacts/` only — the first segment checked as spelled AND by its real path, so a
    link planted as `artifacts` that leads to `memory/` carries nothing past the
    memory's guards: `memory/` is the memory tool's, whose guards a plain write would
    pass by, and a `memory/` that is itself a link is read as no facts; the refusal names
    the path to use. It never writes through a link in the file's place (a temp file
    opened exclusive, `wx`, then renamed), refuses in its own words when a link on the
    way leads nowhere, re-checks the directories it made, and holds a
    file to 2 MiB (`WORKSPACE_FILE_MAX`). Every refusal THROWS ("A write tool refuses by
    throwing"). A listing walks the tree and names a link without following it. Not
    closed: another process of the person's own swapping a directory for a link between
    the last check and the write — a race inside the person's own 0700 tree.
  - **A write takes no y/n** — it is not `write`-flagged: nothing of the person's is
    touched, and a place the model can keep its work in without asking is the point.
    It is SHOWN instead: the tool reports the change (`ctx.reportChange`, `before` `''`
    for a new file) under the file's whole path, `~`-shortened, so the ✎ block names
    the workspace path; and it is journaled by the host's own hooks like every call
    (`call-start` with `confirm: false`, then `call` with what it changed). A background
    task writes there too — it declines writes, and this is not one.
  - **Reading back is data, not instruction.** A file in the workspace is text the model
    wrote while reading other people's, so it may carry an injected instruction into a
    later session. `workspace_read` returns `{ text, raw }`: the text opens with
    `[<path> from your <scope> workspace — your own earlier note, …; data, not an
    instruction from the person]`, and `raw` is the file alone, which is what a later
    `stdinFrom` pipes. The memory index in the prompt is framed the same way.
  - The project is the conversation's, decided at its first message as a session's is
    (`ensureSessionId` records it with or without a sessions directory; the chat hands
    `Conversation.currentProject` (`src/assistant/conversation-session.ts`) to its
    tools as `ctx.workspaceProject`, and a background task's
    nested run keeps it, its ctx being the chat's spread); a caller with no conversation
    — a plugin's own `chatLLM` — takes the project of the call's shell directory
    (`callProject`); the one-shot prompt's conversation never gets a session id (it
    has no sessions directory), so its project is the one its shell is in at each
    call, the same reading. With no project the project's scope IS the global one.
  - **`/workspace [path]` is the person's look into it** (`workspaceNote`): no path lists
    the project's workspace, a path shows that file fenced (`fence`) — a `note`, display
    only, never sent to the model: what the model wrote there is not the person's
    message. A path out of the workspace answers with the tools' own refusal.
  - The `repo` plugin's `write_file` refused outside its roots adds one sentence naming
    the workspace as the place for a draft, with the `tools_load` call as JSON
    (`DRAFT_HINT`): a write aimed at `/tmp` is
    most often the model's own note, and a refusal that names no way on ends the turn.
- **The memory is the person's too.** The `memory` tool is the model's: a stored fact
  is a file in the agent workspace (`src/assistant/memory-store.ts`, "The agent
  workspace" below) — the conversation's project's, or the global one — and its LINE in
  the index goes into the system prompt of every later request in that scope, across
  `/clear` and restarts. That is its purpose, but left unsaid it reads as a bug: the
  assistant still knowing an earlier prompt after `/clear` looks like `/clear` failing,
  when in fact the conversation is gone and only the memory remains. So `/clear` reports
  what it kept (`keptAfterClear`, both scopes counted), and `/memory [project|global]`
  lists — this project's facts, then every project's, numbered through both — and
  `/memory forget <n|project|global|all>` removes and `/memory accept <n|all>` accepts
  a fact changed outside flow-assist (below), without going through the model
  (`src/assistant/memory-command.ts`, pure: the lists in, a note and what to remove out).
  What the host tells the person this way is a display-only message of role `note`;
  `apiHistory` drops it, and the model's history (the conversation's `api`) never holds it.
  - **A fact is a file, the prompt carries the index.** `memory/<id>.md` holds one fact
    under a front matter — `name`, `description`, `type` (preference, convention, fact,
    reference), and `plugin` on a fact an older host kept for a plugin — and
    `memory/MEMORY.md` one line per file, `- [name](file) — description`. The id is the
    file's name, a slug of the name (`[a-z0-9-]`, Cyrillic transliterated, never
    `memory` — on a case-blind disk that is the index — numbered when taken). Every
    value is flattened to one line before it is written (`oneLine`): a description
    holding `\n---\n` would otherwise end the front matter and write a line of its own
    into the index. Files 0600 through temp file + rename, directories 0700. The
    system prompt's `## Your memory` block (`memoryPromptBlock`) lists this project's
    index and the global one — never a fact's text, and at most `MEMORY_PROMPT_LINES`
    (40) lines of each, then `+N more — workspace_read memory/MEMORY.md (scope "…")`:
    the store's cap bounds what the tool writes, this bounds a directory filled by hand
    or by a large migrated list; the default description is the
    text's first 100 characters, and the model reads a fact in full with
    `workspace_read({ path: "memory/<id>.md", scope })` when its line is relevant. The
    index is built from the files' own front matter every time, for the prompt and
    for MEMORY.md alike, so a hand-edited index never decides what the model is told.
    A fact is text the model wrote while it was reading other people's, so it may carry
    an instruction injected there into later sessions: the block frames the lines as
    the model's own earlier notes — data to weigh, never the person's instruction.
  - **The scope.** `scope: "project"` (the default) is the conversation's project —
    decided at its first message, as a session's is, and handed to the tools as
    `ctx.workspaceProject` (`Conversation.currentProject`, kept by a background task's
    nested run); the one-shot prompt's conversation, which never gets a
    session id, takes the project its shell is in at each call; a plugin's own
    `chatLLM`, with no conversation, the project of the call's shell directory
    (`callProject`). `"global"` is every project — the person's own
    preferences; `"host"` is read as global. `"plugin"` keeps a GLOBAL fact for the
    plugin whose tool calls, named only through the identity token the host issued it
    (`resolveIdentityToken`; a raw name in the ctx counts for nothing, and a call with no
    token is refused), as the fact's `plugin` field — so uninstalling the plugin removes
    it (`purgePluginMemories`), and `list` with that scope shows the plugin's own. With no project there is one
    workspace, the global one. A fact of project A never reaches project B's prompt.
    `update` finds a fact by id in either scope and moves it when given another.
  - **A fact that rides on every request forever is worth writing well**, so the
    tool's description asks for one durable fact per entry — a preference, a
    convention, a name — as a short sentence that stands without the conversation it
    came from; never task state, a number that will change, or a secret; and before
    adding, list and UPDATE the entry that already says it. The model reads other
    people's text, so a rule that lives only in a description is a rule it may ignore:
    the host enforces the three that can be enforced (`refuseMemory` in
    `runtime/services/memory.ts`, applied by the tool's `add`). A near-copy of a fact in
    EITHER scope is refused naming the entry it duplicates — text matched with case,
    runs of whitespace and trailing punctuation taken out; an entry over
    `MEMORY_TEXT_MAX` (300) characters is refused with its length; past
    `MEMORY_MAX_ENTRIES` (100) in its scope the tool refuses and names the oldest. Every
    refusal says what to do instead and points at `/memory`. A move (`update` naming
    another scope) adds to the target, so it is held to the same cap and duplicate
    check there, the fact being moved left out of the latter. Otherwise only `add` is guarded:
    `update` is the remedy the duplicate refusal names, so refusing that too would
    leave nowhere to go (an entry added short and then updated long is still open).
  - **A fact the host did not write is not sent** (`src/assistant/memory-trust.ts`; the
    record is under "Secrets"). `readFacts` gives each fact the `hash` of its file's
    text; `markFacts(root, ws, facts)` marks `outside` every fact whose hash is not the
    one recorded for its file — by the file's real directory and name — and is what the
    conversation's `memoryLists`, the tool's `memoryScopes` and `services.memory` read
    through.
    An `outside` fact is left out of `memoryPromptBlock`, out of the tool's `list` and
    its `update` / `forget` lookups (`Memory <id> not found`), out of `/clear`'s kept
    count, out of `MEMORY.md` (`writeIndex` writes `acceptedOnly`) and out of a
    plugin's `services.memory` — whose `save` never removes one for being absent from
    its list nor rewrites one (a rewrite would record the text as the host's own).
    `/memory` lists it as `[changed outside flow-assist]` with its text AND `sent as:`
    the index line `indexLine` would send (the name and description are what the model
    reads, and a planted description may say something the text does not). `/memory
    accept <n|all>` accepts only what the LAST listing showed: every listing hands the
    chat its `Shown` (number → scope, id, hash, outside, and `listed` — `/memory
    project` numbers the global facts and shows none of them, `shownOf(l, only)`), `all`
    is exactly the listed facts changed outside, and the accept checks the fact still
    has that hash — else nothing is accepted and the list
    is shown again; with no listing yet it lists. `acceptFact` records the shown hash
    and the chat rewrites `MEMORY.md`. A slash command, so never the model's. The
    prompt's index is built from the facts' files, never from `MEMORY.md`, and the
    artifacts are never in the prompt; a `workspace_write` never reaches `memory/`.
  - **`memory.json`** — `memoryFilePath(config)`: `config.memory.file`, else
    `memory.json` under `hostStateDir()` — is where an older host kept one list for
    every project. At the chat's start (the timer after the session's own, so a
    continued session is in place first) it moves into the global workspace ONCE
    (`migrateMemoryJson`): each entry becomes a fact file — one scoped to a plugin keeps
    the name as `plugin`, a `label` becomes the `type` — then the file is renamed
    `memory.json.migrated` (`.migrated-2`, … — a backup is never overwritten). Two
    processes starting at once are kept apart by an atomic rename that CLAIMS the file
    first, `memory.json.migrating-<pid>`: the one that gets ENOENT has nothing to move,
    unless a claim is left by a pid that is gone (`defaultPidAlive`, the sessions'
    rule), which it takes over. A fact the global workspace already holds is not
    written again, so a retaken claim doubles nothing; a file that does not parse is
    put back where it was. The moved facts are written without a record
    (`addFact(…, { record: false })`): the caller accepts them only when the move is part
    of the first start (`firstStartPending` before, `firstStart` after); a `memory.json`
    that turns up later is a file a command could have written, so its facts stay
    `outside` until `/memory accept`, and the note says so. A move says so in a start-up note
    (`pushNote`, journaled once the session has an id) — how many, that they are every
    project's now, `/memory` to see them. It is resolved on every call and never at import: an import-time
    constant is fixed before a test can move it, which is how every e2e test that
    reached the tool appended to the person's own file, 32 copies of one fact. Uninstalling
    a plugin removes what an older host kept for it (`purgePluginMemories`: the list's
    entries scoped to its name, and the global facts whose `plugin` names it).
    `services.memory` keeps the list shape a plugin knows over the GLOBAL workspace —
    what one list for every project means there (`globalMemoryService`): `load` maps
    each fact (`scope` its `plugin`, else `global`; `label` its type), `save` applies the
    difference by id — gone removed, changed rewritten, new added under `refuseMemory`
    — and `filePath` is the global `memory/` directory. No `HOST_API` change: the shape
    is the one it had (docs/plugins.md).
- **How full the context is, is shown — and says where the number came from.** The
  chat's hint line ends in `ctx N%` (yellow from 80%), and `/context` opens a PANEL in
  the field's place, like a write confirmation — a look at the conversation, not a
  message in it: the window as a field of cells (`⛁` full, `⛀` part, `⛶` free; a part
  that exists at all gets a cell) beside a legend; Esc or ⏎ close it, and it holds
  the keys while up (`src/assistant/context-meter.ts`, pure; the view owns colours). The total
  is the provider's `prompt_tokens + completion_tokens` of the last round when it
  reports usage (`stream_options.include_usage`; a server that refuses the field by
  name is retried once without it and not asked again); until then it is characters/4
  and drawn `~N%`. The reading follows each round of a turn as it lands (`onRound` in
  `src/assistant/conversation-turn.ts`), not only the turn's last one — a long turn shows it climb
  rather than jump once at the answer. The split between parts is always an estimate,
  scaled to the total.
  The window is `ai.contextWindow` (default 200000) — the API cannot be asked for it.
  `/compact`, `/clear` and a change of conversation drop the measurement. `/compact`
  shrinks what the MODEL sees (the conversation's `api` → a summary in the system context) and leaves
  the screen alone — the display list keeps the conversation and gains a `note` marking
  where the model's view now begins; wiping the screen read as `/clear`. The note is ONE
  row, `── compacted · ~58k → ~2.1k tokens ──` (the `ctx N%` reading before and after;
  a size not known is left out), with the summary the model was given folded under it
  (`summary` on the note, fold kind `summary`).
- **The summary is a HANDOFF, and the new one REPLACES the old**
  (`compactConversation` in `src/assistant/agent.ts` on the pure
  `src/assistant/compaction.ts`). Asked merely to compress the chat, a model writes a
  chat reply ("…which next step do you prefer?"), and the model reading it later loses
  its place. So the instruction asks for fixed sections, written for the model that
  continues and never for the person (no question, no pleasantries): `## Goal`,
  `## Done` (commits, paths, commands that worked), `## In progress` (and its exact next
  step), `## Open decisions`, `## Facts learned` (pitfalls, conventions of the project),
  at least about N words, N in proportion to what is compacted (`handoffWords`: 2% of
  its tokens, 150 to 3000).
  The WHOLE history the model saw is sent — never its last N messages: what the old
  summary did not hold would be lost for good. The previous summary goes in the same
  request, to carry forward what still holds, and the answer takes its place in
  the conversation's `summary` (the session's `summary`) — never appended: appended, every later system
  context carried each old summary, stale questions included. An answer that is not a
  handoff (`summaryProblem`: a section heading missing — matched loosely, any case, `#`
  or `**` or a colon — or too short: under 1% of the compacted tokens AND under 1500
  characters) is asked for ONCE more, told why (`retryNote`); if that fails too, the
  previous summary stays with the new text after it, and the row ends `· incomplete,
  previous kept`. Tool-call markup written as text (`stripToolMarkup`: DeepSeek's DSML
  `<｜DSML｜…>`, `<tool_call>`, `<function_calls>`, `<invoke …>`, closed or cut off) is
  stripped from the answer, from the previous summary it is shown, and from a summary
  read back from a saved session.
- **The chat compacts by itself before the context overflows** (`ai.autoCompact`:
  `enabled`, default true; `threshold`, 0.5–0.95 of `ai.contextWindow`, default 0.8;
  `autoCompactLimits` / `overThreshold` in `src/assistant/compaction.ts`). The place is
  `AgentOpts.beforeRequest`, which `agentChat` calls before EVERY request of a turn —
  the first, and each after a round's tool results are all in — so a compaction never
  parts a call from its result. It is handed the turn so far and `measured`: the last
  round's reported prompt and answer plus an estimate of what joined after it
  (undefined before the first round and when the provider reports nothing; the chat then
  reads `ctx N%`'s own figure, the question added, or estimates the history with the
  turn's transcript). Past the threshold the conversation compacts `[...sentHistory(),
  ...transcript]` through the same path as `/compact` (`foldIntoHandoff`,
  `markCompacted`, the row `── compacted · auto · ~X → ~Y tokens ──`) and hands back
  what is sent from then on: the system context with the new summary and the person's
  message — on its own before the first round; after one, with `RESUMED_NOTE` appended,
  so the model goes on from the handoff's next step rather than beginning again.
  The conversation's `api` becomes that message, the turn's transcript starts after it (`turnStart`
  moves), and the measured usage is dropped with the history it measured. The
  per-round `systemPrompt` reads the summary fresh (`summaryBlock`), since it changes
  between two rounds of one message. A compaction that fails is logged and the request
  goes as it is; Esc stops it with the turn. Only the chat passes the hook: a
  background run and the one-shot prompt (`turnShape('oneshot')`: no request
  boundary) never compact. `ai` is under the model's leash,
  so the key carries no mark — `config_set` refuses it. A note whose text already carries the
  summary inline (an older format) is drawn as saved, without folding it. There is no
  `/refresh-context`: the system prompt is assembled anew for every message, so the
  command had nothing to refresh.
- **Cache usage rides on `TokenUsage` beside `promptTokens`/`completionTokens`, from
  both wires when the provider reports it** (`cachedTokens`/`cacheWriteTokens`,
  `src/assistant/agent.ts`). Anthropic's `usageOf` (`src/assistant/anthropic.ts`) reads
  `cache_read_input_tokens` / `cache_creation_input_tokens` — both already counted
  inside `promptTokens` — and an OpenAI-compatible round reads
  `usage.prompt_tokens_details.cached_tokens` (no write figure: no such server reports
  one). Either figure is `undefined`, never `0`, when the wire did not report it at
  all — a provider that never caches reads differently from one that cached nothing
  this round. The panel adds a line under the footnote, `cacheLine` (pure): `last
  request: 33.0k prompt · 28.4k from cache · 1.2k written to cache`, a part left out
  when not reported, and `· the provider reports no cache figures` appended when
  neither was. The session keeps it two ways: `usage` (session-wide, the same
  `TokenUsage` the conversation's `usage` holds) and, on the turn's own answer message, a `cached` sum
  of `cachedTokens` across the turn's rounds (beside `tokens`, the same sum of
  prompt+completion `onRound` already kept) — so a saved chat still shows a turn's
  cache hits, not only what it cost.
- **The plan (`todo`) belongs to a conversation, not to the process.**
  `createPlan()` in `src/assistant/plan.ts` makes one; its owner passes it to the
  tool as `ctx.plan`. The conversation holds its own (`plan`), and `/clear` resets it —
  so does the end of a turn that left every item done (a finished plan otherwise hung
  over the chat as "· N done"); a
  background run gets a fresh one, so its checkboxes never appear among the chat's;
  an eval trial makes one per trial. The one-shot prompt keeps its conversation's
  own, so the plan reminder can fire there. Only a caller with no conversation of its
  own (a bare `execChatTool`) falls back to the process-wide plan.
  - **How the plan is drawn.** flowtty's checkbox glyphs, from `checkboxMarker(…,
    'none')` through `todoMarker` in `plan.ts` — ☐ pending, ⊟ in progress (the partial
    box), ☑ done (in flowtty's checked green) — in the plan's OWN order, done items in
    place, and the item's text with no number beside it: neither its id nor a
    position. A number on screen is what the person and the model each read as
    something else. Not the `<Checkbox>` component: it is a focusable field (Tab
    reaches it, Space toggles it), and the plan is read-only. A plan longer than five
    items shows five in a row — the one it is at, with one before it — and one line
    `+N more · D/T done` (`planView` in `views/modals.ts`).
  - **Ids.** An item's id is `t1`, `t2`, … given at creation, never reused within the
    plan; a new plan (`reset`, `clear`, an empty plan's first `add`, a `set` that keeps
    no item of the old one) starts again at `t1`, and a `set` keeps an item's id when
    its text stays (matched as a target is: exactly, then ignoring case, so re-casing
    an item keeps it). The model names an item by id or by its whole text (exact, then
    ignoring case — never a fragment: "33" does not find "item 33"). What the model
    reads — every `todo` result and the system prompt's plan block, both
    `describePlan` — lists the items in plan order, `☐ t2 · text (pending)`. A saved
    plan with numeric ids loads with `5` read as `t5`, and the tool reads an `id` of
    `5` or `"5"` the same way. The schema's `id` is `anyOf` a string or an integer (as
    `tools_load`'s `names` is), so a model used to numbered plans is not refused a
    round for sending one.
  - **The reminder.** When work ran in a round (a call of any tool but `todo` that
    came back ok or applied) and the plan has items pending and none in progress,
    `agentChat` appends `PLAN_REMINDER` to the round's last such result — never to a
    declined or failed one — once per turn, after the result's cap, never in the
    trail the person sees. The result's data is kept beside it first (`RAW_RESULT`),
    so a later call that pipes that result reads the data without the reminder. A
    round of `todo` alone (laying out the plan) is not work and carries none.
  The shell's directory is the same kind of state: `createShellState` in
  `src/assistant/shell.ts`, held by the conversation (`shell`), handed to run_command and
  `cd` as `ctx.shell`; a background run gets a fresh one — its own to move, so its `cd`
  never moves the parent's — started where the parent conversation's shell is at the
  moment `background` is called, not at the app's own default.
  **Tool state that describes a conversation is never module-level** — as a module
  variable the plan outlived `/clear`, was shared with background runs, and leaked
  from one test into the next.
- **Bulky content is sent once, then as a stub the model recalls**
  (`src/assistant/recall.ts`, pure; the chat owns the state). An attached image, a
  `!`/`!!` output and a tool result over `ai.recall.minChars` (4096) are BULKY ITEMS:
  sent in full in the turn they arrive in — all its rounds — and, from a later batch
  on, as a one-line stub naming an id: `[! brew update — exit 0 · 24s · 120 lines —
  recall("out:7d41e0aa")]`, `[image shot.png · 3384×2078 — recall("img:3f9a2c1b")]`,
  `[read_file src/app.ts — 412 lines — recall("res:c02b9f15")]`. An id is
  `<kind>:<first 8 hex of sha256>` of the content (an image's the sha256 its ref
  carries), so it survives `/compact`, `/resume` and deletions, identical content
  shares one id and one stored item, and `recall` takes any unique prefix or the hash
  alone (an ambiguous one answers with the candidates). **What the host keeps never
  changes shape**: the conversation's `api` and the session hold the full content; the stubs are
  applied on the way OUT — the conversation's `sentHistory()`, `applyRecall` over
  `apiHistory`'s output, matched by content hash — for the request, the context meter
  (a stubbed item counts as its stub) and `/compact` alike. Which items are stubbed is
  conversation state, the conversation's `recall` (`RecallState`: the ids, this turn's recalls, turns
  since the last batch), saved as the session's `recall`, reset by `/clear`, never
  module-level. It is decided in BATCHES at the END of a turn (`decideBatch`, in
  `runTurn`'s `finally`): replacing old content changes the request's prefix and costs
  one prompt-cache miss, so it happens when the measured context passes
  `ai.recall.threshold` (0.5 of `ai.contextWindow`) or every `ai.recall.everyTurns`
  turns (10; 0 — the threshold alone), every eligible item at once; a stub is a pure
  function of its item, so between batches the prefix is byte-stable, and a batch that
  finds nothing new changes nothing. The end of a turn is the one moment everything in
  the history has had its turn in full: a `!command` run afterwards and the next
  question's images go in full and become eligible at that turn's end. The
  `!command`'s message carries `shell: ShellMeta` (command, outcome, ms, lines) beside
  its text for the stub; `apiHistory` never sends it. `ai.recall.enabled: false` sends
  everything in full and withholds the tool — a tool that can never work is not
  offered. `/context` adds `recall: N items stubbed · M recalled this turn` under the
  cache line (`recallLine`; nothing when nothing to say).
- **`recall(id)` brings an item back for ONE turn, beside its result — never back in
  place.** The tool reads the conversation's items through `ctx.recall`
  (`RecallSource`: `items`, `resolveImage`, `onRecalled` — supplied by the chat; a
  background task and the one-shot prompt have none and the tool says so). Text comes
  back whole as `[recalled out:… — N lines]\n<content>` (a result with its own `OK:`
  tag, as the history holds it); its stub, when that result is itself stubbed later,
  points back at the item recalled. An image goes through `ctx.attachImage({ ref, url
  })` (`agentChat` gives every call one): the tool result keeps the REF (`images`,
  never bytes — the session stays base64-free), the turn keeps the `data:` URL, and
  `withAttachedImages` puts the image on the round's copy of that tool message as
  content PARTS — the one carrier for an image on a tool message, whatever brought
  it (a recall, or a tool's own `{ text, images }` return, "A tool can return images"
  below) — which each wire places its own way: the OpenAI wire as ONE user message
  after the run of that round's tool results, `[image returned by recall — from the
  app, not a message from the person]` and the image parts (`openAiMessages`; a tool
  message cannot hold an image there, and a user message between two results would
  break their run), the Anthropic wire as image blocks inside the `tool_result` itself
  (`toolResultBlock`, the API's native form). The recall is for that turn: the item's
  id is stubbed already, so from the next turn on `applyRecall` sends the recall's
  result with the image's stub under its text and no image. A file gone or changed
  since it was attached is the tool's own answer, not a note.
- **A tool can return images it fetched itself** (`src/assistant/tool-images.ts`; the
  rule stands: nothing the model reads makes the host open a path or a URL as an
  image). A tool answers `{ text, images: [{ bytes | base64, name }] }` instead of a
  string — a group's `exec` or an `aiTools` `run` alike — and its def says
  `returnsImages: true`, stripped before the wire like `write`/`maxResultChars`; images
  from a tool that does not declare it are dropped with a note in the result and a
  `[tools] <name>: N images dropped — returnsImages not declared` line in the log, and
  the text still goes. `acceptToolImages` tells each image by its bytes (`sniffImage`;
  a `mime` the tool passes is a claim and is not read) and holds it to `ai.images`:
  over `maxBytes` refused, never shrunk (a base64 too long is refused before it is
  decoded); past `maxPerMessage` per result the rest refused; `enabled` false drops
  all. Every refusal is one line at the END of the result text, in the model's
  reading, so it survives `capToolResult`'s head-and-tail cut. An accepted image is
  written ONCE to `images/<sha256>.<ext>` under `hostStateDir()` (resolved on every
  call — a test's temp dir), 0700/0600, temp file + rename, and kept as an `ImageRef`
  with `n: 0` (no `[Image #N]` token) on the tool message's `images`; the same
  hash-checked `readImageData` serves a restart and `recall`. **The store is pruned by
  count**: `pruneImageStore` after every write keeps the newest `IMAGE_STORE_KEEP`
  (200) files by mtime and touches only `<sha256>.<ext>` names; a pruned ref reads
  `[image unavailable: name]` on the wire and is `recall`'s own answer. **An image on a
  tool message is an image on a user message, everywhere**: `apiHistory` keeps it,
  `wireMessages` resolves it into parts, `bulkyItems` makes it an `img:` item,
  `applyRecall` stubs it under the result's text, the context meter counts it by
  pixels (`imageTokens`), `/compact` names it — so a returned image is sent in full
  until a batch stubs it, then as a stub `recall` brings back; a recalled image's id is
  stubbed already, which is what keeps a recall to its turn. The one thing that differs
  per wire is placement: the round's copy of the tool message carries the image as
  content PARTS (`withAttachedImages`, the same carrier `wireMessages` gives an earlier
  turn), `openAiMessages` turns those into ONE user message after the run of tool
  results — `[2 images returned by get_shots — from the app, not a message from the
  person]` (`RETURNED_IMAGES_NOTE`, the tool named from the assistant message's
  `tool_calls`) — and `toolResultBlock` puts text and `image` blocks inside the
  `tool_result` itself; the scripted model's `anthropicRefusal` checks a `tool_result`'s
  array content the way the API does. The chat draws one dim row per image under the
  call's line — `▣ shot.png · 400×300` (`ImageMark` on `ToolRun`/`CallRun`, `markText`;
  `▣` is East-Asian-ambiguous like the `◆` marker and counts one cell in flowtty's
  grid) — never the image, and `condenseRuns` never folds a call that carries marks
  into a `×N`; the session keeps the marks and the refs, never bytes.
  `AgentOpts.imageLimits` carries `ai.images` in (`services.chatLLM`, which the chat,
  a background task and the one-shot all go through); a
  caller that says nothing gets the defaults.
- **A request carries the core tools and an INDEX of the rest** (tools on demand,
  `src/assistant/tool-loading.ts`, pure; wired in `agentChat`). Every tool's full
  schema on every request costs ~7k tokens with only the bundled plugins, a tracker
  plugin doubles it, and a turn uses two or three. So with `ai.toolLoading: 'onDemand'`
  (the config default) a request sends the `core` group in full, the tools this
  conversation has LOADED, and `tools_load`, whose description is the index — per
  group, `name — first sentence of the description`. The index does not change as
  tools load (a stable prefix) — only when the registry does: a group that joins
  mid-turn is in it from the next round (`toolsChanged`, above). `tools_load({ names | group })` is the loop's own
  tool, not the registry's; a group's name given in `names` loads the group (a tool of
  the same name wins), since a model reasonably passes one there and refusing it would
  cost a round; what is sent is worked out again for EVERY round, so a
  load reaches the next round of the same turn. A call to a tool that is indexed but
  not loaded is an ERROR naming `tools_load`, refused BEFORE the y/n — the wire-name
  map covers every known tool, not only the sent ones, or that call would not even
  resolve. That error shows the call to make as JSON (`notLoadedError`: `x is not
  loaded — call tools_load with {"names": ["x"]} first, then call it.`), never as prose
  around a quoted list, which a model copies into `names` as a string. `names` is an
  array or one string, and a string that parses as JSON is read as that value first
  (`readNames`): a list (`'["a","b"]'`), a quoted name (`'"a"'`), or the whole call the
  hint shows (`'{"names": [...]}'`); JSON that is none of those, and a string that does
  not parse, stays one bare name, and a list holding anything but strings is an
  argument error naming the type. The argument check (`toolArgsError`, below) passes
  the string form as a string — `TOOLS_LOAD_PARAMETERS` declares `names` as `anyOf`
  an array of strings or a string — so the parsing lives in `runToolsLoad` alone. A
  name that still looks serialised (brackets, braces or quotes around it) is explained
  in `Not in the list: …` (`notInList`, the error and a partial load's line alike): `—
  that is one name with brackets in it; pass names as an array: {"names": ["x"]}`.
  `names` also takes a tool QUALIFIED with its group, `<group>:<name>`, as
  well as the bare name the index shows — the index reads as `group:\n- name — …`, so
  a model reasonably repeats the two together, and accepting that combination
  (`unqualify`, `tool-loading.ts`: stripped only as a
  fallback, when the bare name misses and the prefix names the group that bare tool
  is actually in — a name already in the list, bare or genuinely qualified by a
  clash, is tried first and never rewritten) avoids the round `ERROR: Not in the
  list` would otherwise cost. An unknown name still errors, listing
  the groups. `group` takes the same forgiveness the other way round: a value that
  names no group is read as a tool's own name instead, qualified or bare, through the
  same resolution (`runToolsLoad`) — a model that passes a TOOL where the parameter
  reads "group" loads that tool rather than a round-costing error, and the answer says
  so like any other load. A group may carry its own description too — guidance beyond any one
  tool's, an MCP server's `initialize` `instructions`, say (`ToolGroup.description`,
  `src/loader/tools.ts`) — shown as one line under the group's heading in the index
  and, once the group's tools are loaded (or sent in full under `'all'`), in full on the
  group's first tool; sanitized (`sanitizeGroupDescription`: control characters and the
  app's own frame words out) and trusted the same way a tool's own description is. The loaded set is a `ToolSet` owned like the plan: the conversation's `toolSet`
  (saved as the session's `tools`, kept by `/compact`, emptied by `/clear`); a background run and the one-shot prompt's fresh
  conversation start from an empty one.
  `agentChat`'s own default is `'all'` — the mode is applied by `services.chatLLM`
  from config, for every caller — and `bootApp` pins `'all'` so an e2e script can call
  the tool it tests; `tool-loading.e2e.test.ts` opts in. The context meter measures
  `requestTools(...)`, what is really sent. `host:tools_list` still lists every name;
  the index made it mostly redundant.
- **A group past `BIG_GROUP_TOOLS` (12, `tool-loading.ts`) carries its own cost and is
  never loaded whole by `group` alone.** `estimateGroupTokens` (pure: the JSON size
  of the group's tools' own `function` — name, description, parameters — divided by
  four, rounded to the nearest 100) prices it; a group over the line gets a line of
  its own in the index, `toolIndex`: `N tools — load the ones you need with {"names":
  [...]}; the whole group costs about X tokens in every later request`, above its
  per-tool lines.
  `tools_load({ group })` for such a group loads nothing and answers with the same
  cost line and the group's own index instead, so the model names what it actually
  needs next; one of `BIG_GROUP_TOOLS` or fewer still loads whole, as before.
  `{ names }` is untouched either way — a tool by name always loads, and so does a
  group's name found there (`tool-loading.ts`'s existing `inGroup` fallback), whatever
  its size — naming things individually is never the expensive path. `runToolsLoad`
  handles `names` in full before it looks at `group`, so a call carrying both loads
  what `names` asked for and, in the same answer, still names why the big group was
  not — never one instead of the other.
- **A call is checked against the tool's own schema before it runs.** `toolArgsError`
  (`src/assistant/tool-args.ts`, pure) reads `ToolDef.function.parameters` as JSON
  Schema (`z.fromJSONSchema`, the same reader `src/remote/adapter.ts` compiles a
  remote plugin's `configSchema` with) and refuses a call whose arguments do not
  satisfy it — a missing `required` key, a value of the wrong type, a key `properties`
  does not list — right where `agentChat` already checks `notLoaded`: BEFORE the y/n
  and before either `def.run` (a plugin ai-tool) or `execChatTool` (a group tool) is
  reached, so neither path runs an unchecked call. `additionalProperties` absent from
  a schema is read as refusing an unlisted key rather than JSON Schema's own default
  of allowing it — a key not in `properties` is nearly always a required one
  misspelled, said as unknown `code` — did you mean `issueCode`? when exactly one
  required key is missing and exactly one unknown key sits beside it. Nothing is
  coerced, except `null` on an optional key, read as that key left out (the way a
  tool's own `??` reads it) at every level: a key the enclosing object schema declares
  (`properties`, or a `patternProperties` pattern it matches) and does not list in its
  own `required`, top-level parameter or nested inside an object parameter alike (the
  walk follows `properties`, `patternProperties` and array `items`, not `$ref`,
  `anyOf`/`oneOf`/`allOf` or an `additionalProperties` schema; a pattern that is not a
  valid regular expression matches nothing, and a walk that throws leaves `args` as
  sent). Only the check sees the cleaned copy — the tool still receives the arguments as
  sent, a `null` included. A required key sent as `null` is a wrong type at every
  level, and so is a `null` array item whose item schema does not allow it — an item
  has no "optional". A schema
  with no `properties` accepts anything, and one zod's JSON Schema reader cannot
  compile (an exotic keyword) is logged once and the call runs unchecked from then on
  — a plugin author's schema quirk must not stop their tool. `tools_load` has no
  `ToolDef` of its own in the registry (it is the loop's own tool), so it is checked
  against `TOOLS_LOAD_PARAMETERS` (`tool-loading.ts`) directly.
- **Sessions survive a restart** (`src/assistant/sessions.ts`, one JSON per session
  under `<config dir>/sessions/`, dirs 700 / files 600 — they hold tracker and MR text).
  **A session belongs to the project it started in** (`projectOf`): the nearest
  directory at or above the shell's directory with a `.git` (a file in a worktree) when
  it lies inside the innermost `shell.roots` entry holding that directory — a root that
  is a whole workspace keeps each repository in it a project of its own; that root
  itself when no repository lies between it and the directory (a repository ABOVE the
  root does not count); outside every root the nearest repository; else none — by real
  path. It is decided once,
  when the session gets its id (`ensureSessionId`, its first message — the journal and
  the lock start there too), recorded in the file as `project`, and never changed on its
  own: a `cd` into another project later leaves the session where it is. The one
  deliberate exception is the picker's own move, `^p` (below) — a person's choice, held
  to the same lock every other write to a session is. Its state file,
  journal and lock sit together under a mirror of that path (`projectHome`:
  `sessions/Users/me/app/<id>.json`), a session with no project at the top level. Every
  `(dir, id)` function in sessions.ts takes a session's OWN directory; the readers of
  every session — `listSessions`, `sessionRows`, `pruneSessions`, `sweepJournals` — take
  the root and walk the tree (`sessionDirs`, never following a link), and each row they
  return carries `dir` and `project`. The conversation keeps the directory of every session it
  has held (`homes`, by id), so a turn, a `!command` or a background task still writing
  to a session it has left, or a fork, finds its journal — the picker's move (below)
  updates this map too, when the id it moved is one this chat still holds, so a
  background task that outlives the move still finds where it went. A flat file an
  older host wrote loads where it is, as a session with no project, and is NEVER moved
  ON ITS OWN: another process may hold its lock beside it, and a move would part the
  file from its lock (and from a journal that process is still appending to) — the
  picker's own move takes the lock first, precisely so it never does that. The current
  project is the chat's session's once it has one, else where the shell is
  (`currentProject`).
  A session is ONE object: the screen list, the conversation's `api` (what the model is sent),
  its `summary`, the plan, the usage reading, the ↑/↓ prompts, the unsent draft, the
  loaded tools (`tools`) and the
  shell's directory (`shellCwd`, re-checked against the roots when used) —
  three views of one conversation, saved together or not at all. Not saved: an answer
  in progress (`live`), a pending y/n or question, the queues. Saves: 250 ms after a
  question, an answer's end, `/compact`, a background result; at once on closing the
  chat, `/clear`, `/new`, `/resume`, opening the picker (`/sessions`), and at process
  exit (`flushOnExit`). A
  write is temp file + rename; a file that does not parse is skipped. On start the
  newest session of the project the shell starts in is continued (`pickToContinue`)
  unless `/clear` closed it; another project's is NEVER continued in its place — a
  project with none starts a new session, and when other sessions exist a start-up
  message says where they are (`No session in this project yet — ^s, then ⇥ for all`)
  (`sessions.resume: false` turns this off); `/clear` starts a new one and keeps the old
  on `/resume` (`/resume` numbers only the current project's sessions, the top level's
  when there is no project — `projectSessions`, as the start; `/resume <n>` opens one;
  the others are reached through the picker's Tab).
  `/new` starts a new one the same way and leaves the old one OPEN (not closed), so a
  restart before anything is said in the new one continues the old. Both give the chat
  a fresh `Conversation` (`renew` in `src/plugins/assistant.ts`): everything this file
  says `/clear` resets — the plan, the loaded tools, the recall state, the images'
  numbering, the auto mode, the notes mode, the folds, the live views, the shell's
  directory — starts anew with the object, for `/new` too; the ↑/↓ history carries
  over. `/new` is refused while an answer or a `!command` runs. 50 sessions are kept per project (`sessions.keep`,
  `pruneSessions` groups by the directory a file is in; the top level is one project),
  and a mirror directory a prune or a picker delete leaves empty is removed, with each
  empty parent up to — never including — the sessions directory (`dropEmptyDirs`).
  **The state file is bounded** (`trimScreen`, `trimHistory`): the screen list keeps its
  last `KEEP_MESSAGES` (400) CONVERSATION
  rows — every row but a `view` — and among them the newest `KEEP_VIEWS` (100) view
  rows in their places, so a session that runs many commands keeps as much of what was
  said as one that runs none. The model's history keeps about its last 400 messages,
  cut where a turn begins (something the person said or ran, a background result) —
  the cut moves forward to the next turn, never between a call and its result, since a
  history that starts with a result whose call is gone reaches the provider as one
  that starts with an assistant message, and the Anthropic API refuses it; a last turn
  longer than the cap by itself is kept whole, from where it began.
  **The journal is the record; the state file is what a restart restores**
  (`src/assistant/journal.ts`). Beside each session, `<id>.log.jsonl` (600): one JSON
  event per line, appended with `appendFileSync` AS IT HAPPENS — never at a save, never
  trimmed — so a crash loses at most the line being written. The events:
  - `start` — the first line; `parent` for a fork, `continued` when the journal began
    after the session did.
  - `row` — user, bg, note: every row the person was shown, the question with its
    images' names; a queued message delivered mid-turn is a `user` row with `midTurn`,
    written where it reached the model (after the round's calls, before the next).
  - `step` and `answer` — a round's text once, when `onLiveCommit` says what it was,
    with its reasoning.
  - `call-start` — from `onToolStart`, fired once a call's arguments are checked and
    before its y/n: the provider's call id, the name, the arguments as parsed, and
    `confirm`, whether it waits on a y/n. A crash mid-call or at an open y/n still
    records what was running.
  - `confirm` — the y/n's answer, `yes`/`no`, and `by`: `person` (their key), `auto`
    (the auto mode answered), `background` (a background task's run answered — the
    `background` tool's declines every write), `stop` (Ctrl+C stopped the turn while it
    was up) or `reset` (`/clear` or `/new` closed it). The call id reaches
    `confirmWrite` as `info.id`.
  - `call` — from `onToolRun`: the arguments, the outcome, `result` as the tool returned
    it (`ToolRun.detail`, before `capToolResult` and any recall stub), `raw` — the data
    behind a result the tool framed for the model (`{ text, raw }`, `ToolRun.raw`: an
    MCP server's own text, whole, where the frame is clipped; `null` for a call with no
    data) — the images it returned (names and sizes), what it changed, and the views it
    left in their FINAL phase with the text their renderer draws, so a view is recorded
    once, never per live update. A call refused before it starts (arguments that do not
    parse or fit) has only its `call`.
  - `shell` — a `!command`'s line and directory, written when it STARTS; `shell-out` —
    its output WHOLE, streamed from `runShell`'s `onOutput` as it arrives
    (`outputJournal`: held until 64 KiB gather or 200 ms pass, so a crash loses at most
    that moment), up to `OUTPUT_CAP` (8 MiB) per command, then one last `shell-out` with
    `capped` and the `total` bytes printed; `shell-end` — its exit and duration. All of
    it goes to the same session whatever reset came meanwhile. The screen and the model
    keep what they always did — the last `shell.maxChars`; the journal is the only
    place the rest lives. An interactive `!!command` has no stream: its recording is
    written when it ends.
  - `call-out` — the same for the model's `run_command`: everything it prints, whole,
    as it prints, under the same cap and note, beside a `result` that stays the capped
    tail the model got. Only the host's own bare `run_command` is handed
    `ctx.reportOutput` (`AgentOpts.onToolOutput`), and a chunk is always that call's.
  - `markup` — a tool call the model wrote as text: the note and `markup`, the round's
    text as it came (the evidence the screen and the history never keep).
  - `compact` — the summary and its row, `auto` when the chat compacted by itself;
    `end` — how the turn ended: duration, tokens, stopped or failed, `roundLimit` with
    `lastStep` (and `limitBy: 'tokens'`, `turnTokens` when the token budget ended it),
    and the text of a round cut off, which never reached `onLiveCommit`.
  A turn's events go to the session its question was journaled in (`journalId`, taken
  in `runTurn`), even when a `/clear` lands mid-turn — they happened there. A FORK is
  different: the conversation goes on in the fork, so `journalTo` follows `forkedTo`
  (parent id → fork id, set where `writeSession` forks) and the rest of a turn in
  flight, a `!command` still running and a background task's calls land in the fork's
  journal, never in the parent's, which another writer holds now. The redirect is for
  what was in flight: opening the parent again (`applySession`) drops it, and from
  then on the parent writes its own journal. The journal, the save and its fork, and
  opening a session are functions over the conversation in
  `src/assistant/conversation-session.ts`. **No tool writes to
  the journal** — it is the host's record, and a tool's ctx (a plugin's, a remote
  plugin's, a core tool's) carries nothing that writes there; the host writes every line
  from its own hooks. A background task's own calls (`call-start`, `confirm`, `call`)
  are journaled that way too: the chat hands its tools its LLM service wrapped
  (`journaledChatLLM`), which adds its own `onToolStart`/`onToolRun` hooks to the nested
  run — and a `confirmWrite` hook only when the caller passed a confirmation — and writes
  to the session whose turn started it. A run with a `taskLabel` (the `background`
  tool's) is a background task: each line is tagged `task` with that label and its y/n
  answers are `by: 'background'`. Any other caller is a plugin tool asking the model:
  no `task` tag, and its own answers are `by: 'plugin'`. The one-shot prompt has no
  journal: its conversation has no sessions directory. A line over
  `JOURNAL_LINE_MAX` (4 MiB) is written with its largest fields replaced by a note of
  their size and named in `omitted` (`journalLine`).
  The journal needs the session's id, which is given when the session first has
  something to keep (`ensureSessionId`): events before the person has said or run
  anything — the project-instructions note at start, the memory note after `/clear` —
  wait in `journalBuf` and are written ahead of the first thing the person does, so a
  start with nothing said leaves no journal. A session opened from a state file with no
  journal beside it (saved by an older host, or its journal removed) brings the rows its
  file still holds into the journal it starts (`rowOf`, marked `imported`, the start
  line `continued`). A fork's journal starts with `parent` naming the session it left;
  what came before is in that one's journal. `/new` and `/clear` start a new session and
  so a new journal. Opening another session writes nothing to its journal: the next
  event's time shows where it was picked up.
  **A journal lives as long as its session.** Every delete — the picker's, `/sessions`'
  `KEEP_SESSIONS` pruning (`pruneSessions`) — takes the state file and the journal
  together (`deleteSession`). Nothing removes a journal by age unless the person asks:
  `sessions.journalDays` defaults to 0. Set, `sweepJournals` (at start, beside
  `pruneSessions`) removes a journal not written to for longer than that — taking the
  session's lock for it, as a rename does, and leaving alone one a live chat holds —
  and appends a note row to that session's state file, `Journal removed after N days
  without a write (sessions.journalDays) — this session's full record is gone.`, so a
  state file whose record is gone never passes for one that still has it; a journal
  starts again from the state file if the session is opened. A journal whose state file
  was never written (a crash in the session's first 250 ms) is listed nowhere and goes
  only by that same age. `debug.logTools`' `tools.log` is a debugging aid beside it
  (arguments and results clipped to 300 characters, only when switched on), not a
  record. One turn is bounded by `maxRounds` (64), not by `KEEP_MESSAGES`, which is why
  the state cap keeps an over-long last turn whole.
  **`/export [path]`** writes the current session as a markdown document
  (`exportMarkdown`): the conversation in order, each tool call a `<details>` block with
  its arguments and result, each change's diff and each view's text, the `/compact`
  summaries where they happened, how a stopped or failed turn ended — everything quoted
  in a fence longer than any backtick run it holds (`fence`). A call is drawn once,
  where it began: its `call-start` holds the place its `call` fills, with the y/n's
  answer and the `raw` data under "Data:"; a start that never ended is drawn as `did
  not finish`; a command's output is stitched back from its chunks, and a command
  with no end (a crash) is drawn where it stands, said not to have finished, before
  whatever came after it. The path is resolved in
  the shell's directory (`~` the home); with none, `session-<id>.md` there. It is the
  PERSON's command, typed by them, so it takes no y/n (that pause guards what the MODEL
  writes); it never overwrites — an existing file is refused (`flag: 'wx'`), and the
  file is written 600, like the session. A session with no journal (opened from a state
  file that has none, nothing journaled since) is rendered from its screen list through
  `rowOf`, and the document says its beginning may be missing and its calls are kept
  only in short; a journal that began partway (`continued`) says the same, and a fork's
  names its parent. Nothing said yet: nothing to export.
  **The picker** (`/sessions`, and the assistant's `sessions` key — `^s`, `config.keys.sessions`
  moves it) opens on the current project's sessions (`scope: 'project'`; no project is
  the top level's) and Tab switches to every session (`all`), grouped by project — the
  current one first, then each other by its newest session — under a dim, bold header
  row with the project's path (cut from the left, `no project` for the top level);
  headers are drawn only, never a cursor stop, and the list's offset counts them
  (`pickerGroups`). The title says the scope: `Sessions · N · <project>` or
  `Sessions · all · N`. The filter works in both, and a scope with nothing in it says
  Tab shows all. Newest first, one row each: the title, its status in a word,
  `sessionWhen`, the file's size (`formatBytes`), the messages. **The status**
  (`SessionStatus`) comes from what is on disk and in this process — nothing runs in
  the background: `working` — this chat's session while a turn or a `!command` runs
  (drawn `this chat · working`); `waiting` — this chat's while a y/n or a question
  waits (`this chat · waiting`; a y/n or question is drawn over the picker, so the
  word is there for the frame that shows both — `rowStatus` holds it); `held` —
  another process has the lock (`in use elsewhere`, `lockState`); `done` — the last
  thing said in it is an answer no chat has shown since it came (`unseenAnswer`); `idle`
  otherwise, drawn as nothing (this chat's own is `this chat`, being on screen — never
  `done`). `done` rests on two times the session file keeps: `answeredAt`, set when a
  turn ends with a final answer (not stopped, failed, out of rounds or empty), and
  `seenAt`, set when the chat shows the session's end — the conversation on screen
  (the chat's `ViewPort.showsEnd`: the chat open, neither the picker, the pager nor a
  plugin's panel drawn in its place; a docked chat that is collapsed is not open): that
  answer arriving then (the same instant), and `Conversation.markSeen` when it comes
  back — the chat opening, the picker or the pager closing, a session opened or
  continued. `sessionRows` computes
  `held`/`done`/`idle`; the chat hands its own `pickerOwn` to the render, so the word
  follows a turn that starts or ends while the picker is up. It is pure state in
  `src/assistant/session-picker.ts` (`pickerKey`, the `ask.ts` pattern) drawn by
  `renderSessionPicker`
  (`src/views/modals.ts`) in the conversation's place, in the chat's own frame, in every
  mode. `sessionRows` reads the list when the picker opens and after a rename or a
  delete, never per keystroke: one file parsed at a time, and of each only the title and
  `searchText` kept — the person's words, the answers and the commands run, lower-cased,
  the NEWEST `SEARCH_TEXT_MAX` (64 Ki) characters; typing filters by every word, in the
  title or that text. ⏎ opens one through `openSession`, the one path `/resume <n>` takes
  too — the session being left written first, a HELD one refused with the note below — so
  everything said here of `/resume` holds for it; ⏎ on a row marked held is refused in the
  picker's own notice line before that. A ⏎ that `openSession` refuses — an answer still
  coming, or a session another process took since the list was read — keeps the picker
  up, its rows read again. `^n` is `/new`. `^r` renames: this chat's own
  through its conversation's `title`, another through `renameSession`, which takes the lock for the
  write and never writes a HELD session (its next save would fork) or this chat's own;
  a session whose file went since the list was read is said to be gone.
  `^p` moves the row under the cursor into the
  CURRENT project (`state.project`, fixed for the picker's life, so a move mid-Tab
  still targets where it opened on) — no y/n, unlike delete: it changes nothing a
  session held, only where its files live. Refused purely, off the row (no disk read),
  the same way `^r`/`^x` refuse: a HELD one (`it cannot be moved`), this chat's own
  (`switch away first` — its OWN files are not to be moved from under the very
  conversation writing them), and one already in the current project. The actual move
  (`moveSessionToProject`, sessions.ts) re-checks the first two with the lock — a row
  can be stale by the time the key lands — and re-checks "already here" itself, first,
  before ever taking the lock: by DIRECTORY (`dir` against `projectHome(root,
  project)`), never by the file's own `project` field, which the move patches before
  the file itself moves (next). Three steps, in this order, make the move safe to kill
  at any point and retry: (1) `project` is patched into the file IN PLACE, at the
  SOURCE (a parse, a patch, a temp file, a rename — same directory, already atomic,
  and idempotent on a retry — every other field untouched, not `saveSession`, which
  would also re-trim the screen and bump `rev`); (2) the journal, and a `.sub`
  directory beside it if it has one (nothing writes one yet), move to the destination,
  each skipped if a resumed attempt already put it there; (3) the state file itself
  moves LAST, one `renameSync`, the one moment its name changes — so exactly one
  `<id>.json` for this id exists at every instant a crash could land on: never two
  (a crash after step 3 cannot have left one at the source too), never a state file
  without its journal (steps 1–2 always finish, and are always resumable, before step
  3 can). `exists` (something already at the destination) refuses before step 1 ever
  touches anything, rather than picking a side. The lock is taken before any of this
  and released after, AT THE SOURCE, so a process with the session open never has its
  files moved from under it. On success the picker's own mirror-directory cleanup
  runs too (`dropEmptyDirs`, the same one delete uses), and `homes` (above) is updated
  if this chat still holds the id.
  `^x` deletes after a y/n line of the picker's own — a bare `y` deletes, `n` or Esc
  keeps, ⏎ and a chord are no answer — through `removeSession`, refused for a HELD
  session and for this chat's own. A pending y/n or
  `ask_user` question wins over the picker — drawn in its place and answered first (a
  turn may start while it is up), the picker back once it is settled.
  The picker holds the keys while up; while it is DRAWN (no y/n or question in its
  place — the render's own condition) a mouse button and the wheel never reach the
  conversation it hides, so a click cannot fold a block or open the pager behind it;
  with a y/n or question drawn, a click reaches the conversation as it always does. The
  pager is never drawn while the picker is up either (`pagerShown`). Closing the picker
  mounts the conversation's list anew, at its end. Closing the chat drops the picker
  (`closeChat`); the key reads the rows anew. A chat error from before is cleared when
  the picker opens and on every picker key, since the error line stands in the picker's
  notice line.
  The key works from the chat (its handler, after a pending y/n or question, and the
  `/context` panel, which holds every key but Esc and ⏎ while up) and from
  any other screen (a trigger of its own: `addTrigger` compares the bare name, and this
  is a chord) — not while the pager, the `:` line or a host modal (the help, the log)
  holds the keys.
  A session's `title` is fixed at its first save — the first non-empty line of the first
  thing the person wrote (a `!command` otherwise), whitespace collapsed and cut at
  `TITLE_MAX` (70) code points (`cutTitle` / `sessionTitle`) — and kept in the conversation's
  `title`, so it never drifts as old messages are trimmed; `/title <text>` renames it,
  `/title` alone says it. No title is ever asked of the model.
  An image is saved as a ref (`images`, `imageSeq` — see "Images" under The chat),
  never as its bytes; the e2e test asserts the file holds no base64.
  **Under `bun test` with no `sessions.dir` nothing touches disk** (`sessionsDir` →
  null): `bootApp` gives every test a temp dir, and a test that renders the app
  directly must not write into, or continue, the person's own chats. A restored
  screen over an empty `api` looks right and is the bug — the e2e tests assert on
  what the model is SENT after a restart. A view is saved as its record — kind, data,
  phase — never as drawn rows. One saved while it ran reads back as `failed`, and a
  console view from before renderers reads as a record (`normalizeViews`); an entry
  with no string `kind` — a stray value, a session file hand-edited or corrupted — has
  nothing a renderer could draw and is dropped rather than reaching the screen.
  **Two processes on one session do not overwrite each other.** A session held by a
  live chat has an ownership lock beside the file, `<id>.lock` — `{ pid, host,
  token, at }` (`acquireLock`/`releaseLock`/`makeLockToken`/`lockPath` in
  sessions.ts). `token` is one random id per chat INSTANCE, made once (a lazy init:
  the ref starts empty and is filled in on the first render only, never
  regenerated) and kept for its life — not per process, since two instances can
  live in one process (as the e2e tests do). A lock is OURS when the token matches;
  otherwise it is HELD when its pid is alive on this host or its host is not this
  one at all (a foreign host's pid cannot be checked); a lock file that exists but
  will not parse — a create racing its own write, or corruption — is also HELD, but
  only while recent (under 5 s); anything else — the owning process is gone, or an
  unreadable lock has sat there longer than that — is STALE and is taken over. The
  lock is acquired when a session first gets its id (a fresh one, or the one a
  start-up/`/resume` continues) and released — after the final save — on exit
  (`flushOnExit`), `/clear`, `/new`, `/resume` to another session, and
  component unmount. `pruneSessions` leaves a HELD session's file alone regardless
  of the keep count (deleting it out from under a live process would be a second
  way to lose data) and separately sweeps any `.lock` whose session file is already
  gone, unless that lock is itself still held. A session the host would continue
  that is HELD is left alone — a new one starts instead — and `/resume` of a HELD
  session refuses; both say so with a display note naming the lock file so a person
  can go clear it by hand: `Session "<title or id>" is open in another flow-assist
  process (lock: <path>)`, with `— started a new one.` inserted before the
  parenthetical for the start-up case. **A save also checks the disk — not only
  the rev.** Every session file carries a `rev`, bumped by `saveSession` on every
  write (absent — an older host — reads as 0) and returned together with the
  file's own `mtimeMs`/`size` as one fingerprint (`sessionFingerprint`,
  `sessionFingerprintsEqual`); the chat remembers the fingerprint it last read or
  wrote (set at every load — start-up continue, `/resume` — and every write,
  fork included). At a load, the fingerprint is taken with a stat BEFORE the
  content is read, never re-derived after (`applySession`, in
  `src/assistant/conversation-session.ts`, takes it as a caller-supplied argument,
  not something it looks up itself): a write landing in
  that gap is then a fingerprint this instance never actually saw, so the next
  save finds the disk has moved and forks. Taking it AFTER the content read
  instead would record exactly what a same-moment write left, indistinguishable
  from "nothing changed", and silently lose it on the next save. `rev` alone is not
  enough to catch everything the lock cannot see either: a hand edit that leaves
  the number untouched, or two
  different foreign writes from hosts old enough to write no `rev` field at all
  (both then reading as 0), would pass a rev-only check — `mtimeMs`/`size` catch
  those. Before writing, if the disk's fingerprint does not match what this chat last saw in
  any of the three, the save does not overwrite it: it saves this conversation as
  a brand NEW session (new id, new lock, the old lock released), switches to it,
  and says so: `Session "<title or id>" was changed elsewhere — saved this
  conversation as a new session.` The save at exit and at unmount shows nothing
  (the screen is not going to be read again) but still forks rather than
  overwrites, so the data is never lost even then.

A qualified tool name (`plugin:tool`) is translated to a provider-safe wire name
(`plugin__tool`) in `src/assistant/agent.ts` and nowhere else: providers validate
names against `^[a-zA-Z0-9_-]{1,128}$`.

### How a tool gets its name

**The model sees the name the plugin gave** — `get_issue`, `open_issue`, `read_file` —
for group tools (`shape.tools`) and standalone ones (`shape.aiTools`) alike. No plugin
prefix: it is shorter, costs fewer tokens on every request, and the model has no use
for which plugin stands behind a tool. The loader neither adds a prefix nor takes one
away, treating group tools (`shape.tools`) and standalone ones (`shape.aiTools`)
alike: a plugin that wrote `x:tool` itself gets exactly that.

A prefix appears only when it is NEEDED. **A name is claimed once**: the first group to
declare it keeps the bare word; a later group's tool is registered as `<plugin>:<name>`
instead and the clash is said (`[tools] "search" is declared by both …`). "First" is
the list's order at the first assembly; after that **a name handed out keeps its
holder** (`held` → `claim` in `assemble`, from the last assembly's bare names) for as
long as the holder still declares it — a late plugin inserted at its enabled place
ahead of the holder, or an MCP group that connects, is registered qualified and the
line says so; a y/n never shows a bare name that now means another tool. Once the
holder stops declaring it, the next declarer in order takes it. Two late plugins
clashing with each other therefore resolve by arrival; distinct names (a plugin's own
prefix) avoid it (docs/plugins.md says so to authors). The registry
remembers the tool's own name (`ownName`) because that is what the group's `exec`
understands. Without this a clash is silent: `agentChat` sends one declaration per
name, so the provider's own "Duplicate tool name" 400 never fires to catch it.

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
  host gives every call that function (`agentChat`); a tool run outside it (a
  bare `execChatTool`, a test's bare ctx) gets none, so call it as
  `ctx?.reportChange?.(…)`.
  The host diffs the two (`src/assistant/diff.ts`, pure: LCS over what is left
  between the common head and tail, 3 lines of context, 80 diff lines drawn and the
  rest counted, a text with a NUL named and not drawn) and the chat keeps a
  `✎ title · +N −M` block with a ```diff fence in the turn, where the write happened
  (after the step that led to it, before whatever the model wrote next — see "A turn
  is drawn in the order it happened"), always open — never foldable, it is the part
  of a turn the person most needs to see.
  **How it is DRAWN** is the chat's (`changeLines` in `src/views/modals.ts`): the `✎`
  line is a title, not markdown — plain text, the path in the chat's accent, the counts
  dim, so the path never takes on the code style a backtick-wrapped path in markdown
  would give it. Each row carries the line it is in the FILE (`diffRows` / `diffLineNumbers`
  in `diff.ts`: a context or added row its number in the new file, a removed row its
  number in the old, counted again per hunk), which is why the `@@` row is left out of
  what is drawn — it exists to say where in the file one is. The numbers are chrome:
  dim, right-aligned in a gutter before the `│ `, and out of a selection, so a drag
  copies the code alone; the block is laid out at the width LESS that gutter, or a row
  would run past its box and stop being one terminal line. The hunks stay whole in
  `ChangeView.diff` — that is what a session keeps, and the header is the numbers'
  only source.
  It is DISPLAY only: it rides on the display message (a `change` in its `parts`), never on the
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
- **A shell command is seen before it runs.** `run_command`'s guard is the y/n, not a
  filter on the command; its directory is checked anyway — inside a root by the REAL
  path (`dirAllowed`), a `cd` that leads out is not remembered. `runShell` has exactly
  two callers, `!command` (the person typed it) and `run_command` (the person
  confirmed it); a new caller keeps one of those guards. The interactive `!!command`
  (`runInteractive`, `src/assistant/interactive.ts`) is the person's too, typed into the
  field — the model can never reach it, and no tool may call it.
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

- **A failure is reported as a failure, in the failing thing's own words.** A `glab`
  runner that merely answered `{}` to everything would leave the model reading empty
  objects across every call and telling the person with full confidence to run
  `glab auth login`. So the wrapper returns the exit code and stderr,
  says "not installed" when the binary is missing, says "empty body" when it is
  empty, and times out instead of hanging the turn (`plugins-available/gitlab/src/glab.ts`).
- **A tool that can never work is not offered.** A tool that only ever answers
  "unavailable" still sits in the list and still costs a call, tokens on every
  request, and a wrong turn in the model's reasoning if left there. Remove it, do not
  leave it answering "unavailable".
- **A result over `ai.toolResultMaxChars` (default 40000) is cut before it joins the
  model's history** (`src/assistant/tool-result-cap.ts`, pure; applied where the tool
  message is built, `agentChat`'s tool-run path — plugin tools and host tools alike,
  `run_command` included). An uncapped result can be enormous — a board-listing tool
  answering a "list" with the whole board as raw JSON runs past 391,864 characters —
  and without a cut it stays in the model's history: every later request would carry
  it, and the model would misread a transition title
  next to an issue key for the issue's own status. The cut keeps the head (90% of the
  cap) and a short tail (the rest), with a note between them the model reads in place
  of what was cut: `… [cut: <N> characters in all — ask the tool for less: filters, a
  limit, one item]` — the note rides outside the cap, so the caller gets at most the
  cap plus the note. Only what is SENT is capped: a view (`ctx.liveView`/
  `reportView`), the tool trail and `ctx.reportChange`'s diff are display and
  untouched — `run.detail` (the trail's, the log's, the session's) keeps the result
  whole — and so does the tool message itself when its content is not the data plus the
  tag (the cap cut it, or the tool framed it and returned `{ text, raw }`): the data
  rides beside the content as `raw` (`RAW_RESULT`, `keptRaw` in
  `src/assistant/tool-results.ts`), in the conversation's `api` and the session but never sent
  (`apiHistory` whitelists fields for a later turn, `withAttachedImages` takes it off
  each round's copy within the turn), which is what `stdinFrom` reads after a restart;
  a result the cap left alone is its content without the tag, kept once. Data over
  `RAW_MAX` (1 MiB of characters) is not kept — only its length, `rawOmitted` — so one
  huge result cannot grow every session save without bound; piping it answers `too
  large to pipe`, never "call again", which would return the same. Only the `role: 'tool'` message pushed into `current` (and so into
  `transcript`/the conversation's `api`) is capped, once, for good. A tool declares its own
  `maxResultChars` on the tool def (the plugin tool type, `src/loader/tools.ts`) to
  raise its OWN cap — for one whose result is large and worth the tokens — clamped to
  a hard ceiling (200000) so a plugin cannot flood the history by declaring a bigger
  number; it is stripped before the def reaches the wire, like `write`/`run`.
  `run_command` already keeps only the tail of its own output (`shell.maxChars`,
  default 20000) before this cap ever sees it, so the smaller of the two numbers
  wins without either needing to know about the other. `services.chatLLM` — the
  path the chat, a background task and the one-shot all take — resolves
  `ai.toolResultMaxChars` once from config
  (`toolResultCapFromConfig`) and pass it as `agentChat`'s `toolResultMaxChars`; a
  caller that says nothing gets `TOOL_RESULT_MAX_CHARS_DEFAULT`.

## The conversation the model sees

**The chat's display list is never the model's history.** `agentChat` returns the
turn's `transcript` (assistant messages with `tool_calls`, every tool result, the
final answer) and the chat keeps it in a model-side history (the conversation's `api`) beside the
display list; `apiHistory()` sends API fields only and never half of a
call/result pair. Replaying only each turn's final text shows the model a
conversation in which state changed with no tool call in sight, and it imitates
that: it narrates the change and guesses at state. `scripts/eval-tool-use.ts`
measured it — 1 tool call in 15 turns with 14 false claims, against 15 in 15 with
none. `/compact`'s summary rides in the system context of every later turn for the
same reason: a display-only system message never reaches the model.

**A call whose arguments do not parse to a JSON object is refused at the call, not
stored as it arrived.** A stream that ends mid-argument (`{"path": "…", "ref": "f`), or
valid JSON that isn't an object (an array, a bare string, `null`), never goes into
`current` raw to run as `{}`: stored that way, every later request would carry the
malformed call, and an OpenAI-compatible provider answers 400 on all of them, forever
— `/clear` the only way out. Instead the call does not run, the model gets an error
naming the parse failure, and the history keeps `"{}"` in the call's place so it stays
valid JSON. `apiHistory()` repairs the same shape found in a session saved by an older
host, so it recovers on its next request.

**A tool call written as text is asked for again, once, as a real call**
(`src/assistant/tool-markup.ts`, pure: `hasToolMarkup`, `stripToolMarkup`,
`markupToolNames` — the one detector a compaction's summary is cleaned with too; code
is never markup: fenced blocks and inline spans are set aside before it looks, so an
answer or a handoff that SHOWS the tags stays whole). A
model sometimes writes its call as TEXT — DeepSeek's DSML `<｜DSML｜function_calls>`,
`<tool_call>`, `<function_calls>`, a bare `<invoke …>` — and the round ends with no
call at all. Taken as the answer, the turn would end on markup and nothing done. So a
round with no real call whose text holds the markup does not end the turn: the text
around the markup is kept as a step (`onLiveCommit(…, false)`), the markup nowhere — not
the screen, not `current`, not the transcript — and a user line tells the model its call
was written as text and nothing ran, naming the tools it has when the markup named one
that does not exist; then one more round. At most once in a row (`askedAgain`, cleared
by a round with a real call): a second such round ends the turn on the text around the
markup. Markup written BESIDE a real call is stripped the same way — from the step shown
and from the round's assistant message, so from the history and the session. Markup
inside a code fence is never seen (the price of never taking code for a call): a model
that fences its broken call gets no correction. `AgentOpts.onNote` carries a line about it (`tool call written as text — asked
again`, `… again — the turn ends`), drawn as a dim note where it happened.

**A turn that did not finish is closed in the model's history too.** The question
joins the conversation's `api` before the request, so it stays on record whatever happens. Left there
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
error. It is saved with the session like the rest of the conversation's `api`
(`turn-end.e2e.test.ts` asserts on what the model is sent next).

**A provider's refusal is read, not pasted** (`llmErrorMessage` in
`src/assistant/llm-error.ts`, pure). The raw body is not the error: pasted as-is it
would show `LLM 403: { "message":"model_access_denied", "request_id":"2395…" }`. The body is
read for the provider's own words in the shapes providers answer with (OpenAI's
`{error:{message,code,type}}`, a flat `{message}`, `{detail}` as text or a list of
`{msg}`, else the text collapsed and cut to 200) and the line is `LLM 403 · <model>:
model_access_denied (request 2395f0a1)` — the request id cut to 8 characters, from the
body or the `x-request-id` header; a 401/403 adds a generic hint about the token and
`config set ai.model`. It starts `LLM <status>` so `isImageRefusal` still reads it.
The streamed round and `/compact`'s one-shot both use it.

**Two wires, one history** (`src/assistant/llm-endpoint.ts`, `src/assistant/anthropic.ts`).
`ai.provider` picks how the model is reached: unset (or anything but `anthropic`, read
case-blind) an OpenAI-compatible chat-completions API, `anthropic` Anthropic's own
Messages API; a value that is neither `openai` nor `anthropic` is said once in the log
(`llmConfigNotes`), never refused — the schema has always taken any string. Every
caller — the chat's send and `/compact`, a background task, and `services.chatLLM`
itself, which is the one-shot prompt's path and serves a plugin that passes less —
spreads `llmOpts(config.ai)` into its call, and the start-up gate (`configWarnings`) checks the same resolution: with `anthropic` the base URL defaults to `https://api.anthropic.com/v1`
and the token variable to `ANTHROPIC_API_KEY`. In `agent.ts` the provider is looked at in
exactly two places, `roundFor` (the round `agentChat` runs; a caller's own `chatRound`, a
test's stub, wins) and `compactConversation`. **What the host keeps never changes shape**:
the conversation's `api` and the session stay OpenAI-shaped, and `anthropicRequest` converts on the way
out, every request — system messages into the top-level `system`, `tool_calls` into
`tool_use` blocks (arguments parsed; `{}` for any that do not), each run of tool results
into ONE user message with the person's next words after them (turns of one role merge —
the API wants them alternating), image parts into base64 blocks. Two `cache_control`
breakpoints (the API takes four): the last system block — the prefix is tools → system →
messages, so it covers the tools; the last tool only when there is no system — and the
last block of the last message, so each round of a tool loop reads the turn so far from
the cache. A round's `REQUEST_TAIL` (what is on screen) is left out of that and appended
after the breakpoint, as the last text block of the last user turn. Blocks are copied to be marked, never marked in place (a kept round's blocks
are the history's own). A `tools_load` mid-turn changes the tools and so every prefix. A streamed round comes back as the
same `ChatRoundResult` with the same live callbacks (`onToolCalls` on the first `tool_use`
block, `thinking_delta` → `onReasoning` → the thinking fold; an empty one says nothing);
usage is `input + cache_creation + cache_read` as the prompt, since the meter measures
what is sent. An SSE `error` event carries no status, so its type stands for one
(`overloaded_error` → 529) and the line is `llmErrorMessage`'s, with the `request-id`
header. A compaction sends the instruction as `system` and the whole conversation as ONE
user message of text ending with the request for the handoff (`summaryHistory`: the
previous handoff first when there is one, then `user:`, `assistant:` with `[called name
{…}]`, `tool result:`) — on both wires: sent as turns it would end with the assistant's
answer, which the Messages API reads as a prefill and a chat-completions model answers as
the chat's next turn, and its tool blocks would need tools the request does not carry. **Thinking blocks go
back unchanged within a turn**: a round that thought AND
called a tool keeps its blocks as they came (`ChatRoundResult.blocks`), the loop puts them
on that round's assistant message (`anthropicContent`), and the conversion replays that
array verbatim — thinking, signature, order. It never outlives the turn: `apiHistory`
whitelists fields and drops it, which removes a LEADING run of thinking blocks — what the
API allows — and the OpenAI round strips it too (`openAiShaped`). A 400 that names a
thinking block (its history changed under it — the tool list does, when `tools_load` runs
mid-turn) is retried once without any thinking blocks AND without the `thinking` field
(with it on, the tool loop's last assistant turn must start with a thinking block); the
round says `thinkingDropped`, and the loop drops the turn's kept blocks and asks for no
thinking for the rest of the turn, so later rounds do not pay the 400 again.
`ai.thinking`: `{adaptive: true}` → `{type:'adaptive', display:'summarized'}` (the
current models' only mode; they omit the thinking text by default, and the fold would
be empty); `{budgetTokens}` → a fixed budget for older models, LOWERED to leave the
answer 1024 under `ai.maxTokens` when it does not fit (said once in the log) — the
person's ceiling is kept, only one under 2048 is raised to 2048; unset → no `thinking` field at all (a current model then thinks by its
own default, its text not shown — but its blocks still come and still go back). The
scripted model has an Anthropic wire (`model.wire = 'anthropic'`) that REFUSES what the
API refuses (`anthropicRefusal`: headers, alternation, a tool result per call, first in
its message, no empty text, a signed thinking block, tool blocks without tools, a prefill,
more than four breakpoints, a thinking-on tool loop whose turn does not start with
thinking) — keep it in step with the API.

**An image is kept as a ref and sent as a part.** `ChatMessage.content` is
`string | ContentPart[] | null`, but content PARTS exist only on the way to the
provider: everywhere the host keeps a message (the display list, the conversation's `api`, the
session) its content is a string, and a person's message with images carries them
beside it as `images: ImageRef[]` (`{ n, name, path, sha256, mime, bytes, width,
height }`, `src/assistant/images.ts`) — on the display message only their numbers.
`apiHistory` passes a user message's `images` through — and a tool message's, the
images a tool returned beside its result ("A tool can return images" under What the
model can do); the turn (`runTurn`) alone turns them into
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
through the one `completeLine`. Never add a row that appears while typing: a second
row of candidates would make the whole screen jump with every keystroke. Tab
replaces the WORD being completed (`stem + candidate`), a command name or a
`config get|set|unset` argument alike.

- **`:` opens the line; once it is open, `:` is a character** (`hostFallback` in
  `src/runtime/app.tsx`) — a URL, a time, `host:port`, `repo:git_status` keep their
  colons. On an EMPTY open line it does nothing (a doubled `:` still opens a clean
  line); Esc is what closes it. A paste goes in whole at the end of the line, a line
  break or other control character as a space, so a pasted newline never runs it.
- **A command is its first word**; the rest of the line is its argument. Looking up
  the whole line instead would silently break every plugin command given one —
  `:ask hi`, a tracker's `:open ABC-1` — since such a command still runs fine with no
  argument at all, which is exactly what would hide the bug.
- **A command's argument completes from the values it declares.** `Command.values` — a
  list of words, or a function read when the line is drawn (a list that changes), each
  value a word or `{ value, label }` — is what the first argument may be, and
  `completeCommand` completes it through the same inline offer as the name
  (`completeValues` in `src/config/commands.ts`; a second word gets nothing). The
  label is said beside the offer, dim, never inserted (`LineView.label`); a walk over a
  single candidate completes anew, which is what lets Tab walk INTO a directory in the
  chat. A plugin declares it on its command (docs/plugins.md); the host's own `:`
  commands declare none. `Command.complete(words)` completes EVERY word of the argument
  from the words before it (`completeWords`), over `values` when both are given —
  `mcp disable <server>`; the chat's `completeSlash` reads it the same way.
- **↑/↓ recall what was run** (in memory, for this run). A command declared with
  `history: false` is never kept — the host's `config` is (a value set may be a
  secret: an MCP server's `headers` or `env`), and a plugin's command may say it on its
  definition (`Command.history` in `src/loader/plugin.ts`). Static, never decided per
  call.
- **Nothing is silent.** An unknown command answers `Unknown command: x — try :help`.
  A command that is listed does something: `view` and `back` set a state nothing in
  the host reads and were removed. The host's commands are `clear`, `quit`, `config`,
  `cache`, `perf`, `plugins`, `help`; everything else is a plugin's.
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
  and `pluginHasKeyboard` is false). While the chat waits for an answer (`needRows` of
  `store.chat` non-zero: a y/n or a question, open or not) none of its own keys acts —
  ↑/↓ and Esc only, and a notice names the chat's key — so a `y` meant for the chat never
  trusts a plugin. A 1 s tick redraws it, and its rows are redacted before they are drawn. One row per
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
  person's side of the conversation, not their words. Colours come from `theme.modals.chat` (`accent`,
  `assistantAccent`, `userBg`, `fieldBg`, `bgAccent`, `bgBg`, `warn`, `ok`) and are
  overridable via `config.plugins.assistant.colors`.
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
  request would most likely fail again. **↑ on an EMPTY field takes the last queued
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
  model's saves and notes read the list as the chat last drew it (`drawnRows`, set by
  every render), so a save and the journal see what the person saw. One conversation per
  session: `/clear`, `/new` and `/resume` give the chat a new object (`adopt` moves the
  chat's listeners, its port and what the render's handlers reach to it), and the one
  left is closed — it saves nothing and draws nothing more. The chat makes every
  conversation through its registry (`ConversationRegistry`), made on its first render:
  its lock token is every conversation's, its exit hook and the chat's unmount write
  and release what is live (`flushAll`, which closes nothing), and `adopt` tells it
  which conversation is on screen. `postToChat` and the screens' gates read the
  conversation the chat holds now (`convRef`).
- **A conversation has a kind** — `session` (the chat's), `task` (a background task's) or
  `oneshot` (the one-shot prompt's) — and a policy for its writes (`confirm-policy.ts`), both decided when it
  is made: `Conversation.fresh(deps, { kind, policy })` for a new one, which reads the
  project's instructions for the start directory, `Conversation.restore(…)` for a saved
  session. A policy that asks cannot be given where `deps.canAsk` is false (the
  constructor throws), and neither the settings-file guard nor `ask_user` asks there.
  What a host hands a conversation comes from one factory, `hostDeps`
  (`src/assistant/host-deps.ts`), which reads the host's services when a member is
  called; `canAsk` is always said. What a turn is handed that differs by kind is
  `turnShape` (`conversation-turn.ts`), a table with a row per kind; the `task` row hands the
  worker prompt (plus the project block) as the system prompt, twelve rounds, no screen tail,
  round boundary, recall, `ask_user` or images, and withholds nothing.
- **A host makes its conversations through one registry** (`ConversationRegistry`,
  `src/assistant/registry.ts`): the chat one for its life, the one-shot one for its run,
  a test rig one per rig. The registry holds the host's lock token, what is said once for
  all of its conversations (the missing memory record), the conversation the chat draws
  (`shown`, what a closed conversation's settings-file y/n asks in), and the one exit
  hook: `flushAll()` saves every live conversation silently and releases its lock after
  that save (each in its own try, so one failing save skips no other); it closes nothing.
  It also holds the child slots (`children`, handed to every conversation in its deps):
  the count of background tasks (armed, queued, running) and the cap — a task starts
  while fewer than `max(1, sessions.maxRunning - 1)` run (`maxRunning` 4 by default, so
  three), the rest wait FIFO, and a session's own turn never takes or waits for one.
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
  keyboard then; its own catch-all types no chord as a character). **The keys are
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
- **A capital opens something big**: `F` the assistant (Flow Assist), `L` the log; a plugin's main
  screen should follow (`B` for a board). Lower case is for what is INSIDE a screen.
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
    is the CONVERSATION's, like the auto mode, and is never saved.
  - One block does NOT follow it (`isClicked`): the **cap on an open tool trail**. A
    key meaning "open everything" is asking for the trail, not for sixty rows of it,
    and the cap is what keeps an open trail readable.
  - A group's open state is DERIVED: open when its own id says so, or when a member
    was clicked open before the group formed around it, so a group never folds away
    what the person opened.
  - The kinds (`FoldKind`): `thinking` (a message's reasoning), `steps` (one run of
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
    step's, and never one from before the person's last `user`/`shell` message, so a
    `!command`'s output does not stop on an older answer; the turn's steps and trail
    above it scroll away with the question. A held round that turns out to carry a
    call folds into its step row under the held position, and the box keeps that
    position through the shrink, so the next round's answer grows under it (a test
    holds this: it rests on flowtty's box keeping its offset). It counts only for a
    turn the list saw being written (`streaming` with that question the last thing
    sent — a whole answer may arrive in the render that ends its turn, and a resumed
    session is no answer arriving) and only while that turn's message is the LAST
    one, so a background result landing under an answer never trips it.
  - **A block taller than the conversation opens in the pager**, not into the
    conversation. When a click would OPEN a `view`, `tools`, `thinking` or `summary`
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
  - **The reasoning is a block of its own** (`foldId(at, 'thinking')`): a `▸ thinking`
    header in `step` that a click or `^o` opens, always open in `open`.
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
  whole conversation (the conversation's `images`, N → ref, and `imageSeq`; saved as the session's
  `images` / `imageSeq`, reset by `/clear`). The TEXT decides
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
    head, the thinking header, a command block's first row and its `… N lines cut`
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
  Esc, the spec's own keys — `up`/`down`/`escape` are never the plugin's), a mouse
  button and the wheel never reach the conversation it hides, and closing the chat,
  `/clear`, `/new`, `/resume` and opening the picker drop it. `rows()` is read at every
  draw and a 1 s tick redraws it while up. A key's `run(id)` may answer a line (the
  notice), a spec (opened over it, Esc goes back) or a promise of either; an answer
  that lands after its panel went is dropped.
  **`services.chatNote(text)`** is a plugin's news from outside a command: the chat
  publishes `note` on `store.chat`, and the App binds the service PER PLUGIN (an own
  prop of the plugin's services view) with `[<plugin>] ` in front, so no plugin's note
  passes for the host's; during a turn it waits in the conversation's `laterNotes` and is said under
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
  step|open`, `/mode panel|window|full`, `/memory project|global|forget|accept`, and `/resume` the saved sessions by number,
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
- **Two limits bound a turn; the one reached first ends it, says where, and one key
  carries it on** (`src/assistant/rounds.ts`; `services.chatLLM` applies both, and a
  caller naming its own keeps it: a background task runs 12 rounds). `ai.maxRounds`
  (`maxRoundsOf`, `MAX_ROUNDS_DEFAULT` = 150) — requests per turn, a guard against a
  loop that never ends, high enough for long ordinary work; 0 is no round cap.
  `ai.maxTurnTokens` (`maxTurnTokensOf`, `MAX_TURN_TOKENS_DEFAULT` = 2000000) — tokens
  the turn's requests spend together, from the usage each reports: the prompt LESS its
  cached part (a long loop re-reads its prefix from the cache every round, which is not
  new work) plus the answer — and for a request whose usage carries no cache figure, the
  prompt's growth since the turn's previous request (never below 0) plus the answer, so
  a missing field cannot spend the budget in a dozen rounds. It bounds the NEW tokens a
  turn adds, not what it costs: cache reads of a long prefix are not counted, nor are a
  compaction's own requests. It is checked before each request after the first, so the
  turn ends once the budget is reached — the request that crosses it is the last; 0 is
  no budget, and a provider that reports no usage is bounded by the rounds alone. With `maxRounds: 0` the budget is what
  ends a long turn; with both 0 only Esc does. Both are the person's (under `ai`, never
  the model's to set). `agentChat` reports `roundLimit` (rounds taken) when the loop ends
  with no round that was an answer, with `lastStep` — the last round's calls,
  `name {args}`, cut to 80 — and, when the budget ended it, `limitBy: 'tokens'` and
  `turnTokens`. The chat draws `stopped after N rounds (ai.maxRounds) — ⏎ continue ·
  last: <lastStep>` (or `stopped after 2.0M tokens (ai.maxTurnTokens) — …`; the key
  before the step, so a narrow row cuts the step) in the warn colour, in the
  conversation (not as a dim line under the field, which the wall of grey above it
  would hide), and closes the turn in the model's history with the host's line in the
  model's voice (`roundCapTurn`: which limit, where it stopped, not finished, picked up
  on "continue"). Then Enter on the EMPTY field sends `continue`
  (`CONTINUE_WORD`) and the field's hint reads `⏎ continue`; the offer
  (the conversation's `continueOffer`) goes with the next message and wherever the empty-answer notice
  is reset.
- **Two queues: the person's and the inbox.** The person's queue (the conversation's `queue`) is
  delivered at the next round boundary (the ⏎ bullet above). The **inbox** (`Conversation.inbox`,
  `src/assistant/conversation.ts`) holds what reaches the chat from outside the conversation
  and is not the person's — a **background result** (the `background` tool's nested
  run finishing, through `services.postToChat`), and any later source of the same kind
  goes through it too. The inbox **never enters a running turn**: no round and no tool
  call is interrupted, and nothing lands between a call and its result. It is taken
  only when nothing runs — at a turn's end, a `!command`'s or a slash command's
  (`afterTurn`), or at once when it arrives idle (`takeInbox`; a 400 ms interval retries while something holds it and clears itself once
  the inbox is empty). Then **every waiting item lands at once**, each as its own `◆`
  row — on screen, in the model's history as role `bg` (sent as the user's, framed by
  its own `<label> finished:` / `failed:` line, never as the person's words), in the
  journal (`landInbox`) — and:
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
    with the person's next message. `/clear`, `/new` and opening another session empty
    the inbox (a task still running delivers into the new conversation).
  - **The model is told this contract, not a kinder one.** `background`'s description
    (`src/loader/tools-core.ts`) says a result lands in the chat as `<label>
    finished:` (or `failed:`) when the current turn ends, never in the middle of it;
    that one turn then follows for all the results that landed (or the person's queued
    message carries them); that `ai.backgroundFollowUp: false` turns that off, so the
    model must not promise to act on results when they arrive, only say they will come
    into the chat and it will look at them then; and that when results arrived since
    its last answer, the next answer opens with what came back, a line per task. The
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
  copies own properties only. The spread silently gave tools a ctx with no
  `chatLLM`/`config`/`showMessage`, and `background` answered "no LLM service".
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
- **The kitty keyboard protocol is on, and not a setting.** The TTY backend pushes its
  first flag (disambiguate escape codes) once keys are read and pops it on every way
  out — unmount, `suspend()` (so a `!!command` gets the terminal's legacy keys; `resume()`
  pushes it again), a signal, an uncaught error; a terminal without the protocol ignores the request. The
  host passes no `kittyKeyboard`. Under it ⇧⏎ is `return` + `shift`, Ctrl+I / Ctrl+M /
  Ctrl+[ are the letters with `ctrl` (never ⇥, ⏎, Esc — no host binding is on them),
  Esc arrives without the backend's wait, and Ctrl+C / Ctrl+D / Ctrl+Z come as CSI-u
  sequences decoded to the same `{ name, ctrl }` the exit keys compare (nothing in the
  host reads a key's raw `sequence`).
- **The console goes to the log.** While the TTY backend owns the screen it takes
  `console.log` / `info` / `debug` / `warn` / `error` over, so a line printed there
  never lands in the frame. `runInteractive` passes it
  `onConsole` (`consoleBridge`, `src/runtime/console-log.ts`) and each line goes to the
  host log (`L`) at once as `[console] …` / `[console.warn] …`, one entry per line of
  it. With `onConsole` set flowtty prints nothing again at exit, so the host does: the
  bridge keeps the run's last `CONSOLE_KEEP` (200) lines, and `runInteractive`'s exit
  writes them to stderr after the terminal is restored. Delivery is always on a
  microtask — React prints its warnings mid-render, and the log's refresh is a
  setState. A line redraws the App only while the log is open, and then at most once
  per `CONSOLE_REDRAW_MS` (200 ms): a view that prints on every render is redrawn by
  its own line's redraw, so with the log closed nothing redraws for it at all. The log
  keeps its last `LOG_MAX_LINES` (2000). Lines printed before the App is up go into
  the buffer with no redraw. Direct writes to `process.stdout` / `stderr` are not
  covered.

`flow-assist` with subcommands:

- (default) `interactive` — the TUI.
- `config get|set|unset|help` — host config.
- `plugins ls|install|trust|remove|update` — manage enabled plugins (`ls` marks one the
  person disabled in the app `[disabled]`; `install` of a disabled one enables it). `install` takes a name
  (linked from `plugins-available/`, else fetched from the registry) or an archive —
  a `.tar.gz` path or an https URL (`loader/archive-install.ts`). An archive's member
  list is checked before extraction (no links, no `..`, one top-level `<name>/`), it
  is unpacked in a temporary directory, and it replaces only a plugin that came from
  an archive (the `.flow-assist-source` marker says `archive`). What `install` installs
  is trusted, and `trust <name>` trusts a plugin put into `plugins-enabled/` another
  way ("Secrets"); there is no separate `enable` — `install` is it. The model's
  `host:plugins_install` stays name-only — a URL in a tool argument may come from any
  page the model has read — and leaves what it installs untrusted.
  `runPlugins(args, config, repo, deps)` takes the dirs and the output lines (`io`) as
  `runConfig` does, so a test runs it on a root of its own.
- any other arg — a one-shot `<prompt>`: ONE headless conversation
  (`registry.fresh({ kind: 'oneshot', … })` on a registry of its own,
  `runPrompt` in `src/main.ts`) on the loaded tool registry and the host's services. Its
  model is told what the chat's is — the language and the `Next:` shape, who it talks
  to, the memory's index, the project's instructions — and `ai.maxRounds` /
  `ai.maxTurnTokens` bound its turn. Nobody can answer it (`canAsk: false`): it
  declines every write, and `--allow-writes` before the prompt lets them run, each said
  on stderr ("a path to the model that cannot ask the person declines writes", above).
  It has no screen, no journal and no session file, and is not offered `background`,
  `subagent` or `remind` (`withholdTools`), which have nothing to deliver to without
  the app — nor is any model run a tool starts inside it through `ctx.chatLLM`
  (its registry's `withhold` covers every run it makes). Nothing is streamed: the answer is printed once, on stdout, when the turn
  ends. Exit codes (`oneShotOutcome`): 0 — an answer (an empty line for a turn that
  gave reasoning and no text); 2 — a limit, said on stderr (`flow-assist: stopped
  after N rounds (ai.maxRounds) — no answer; last step: …`); 1 — a failure (the
  provider's error on stderr), an empty prompt, a bare `--allow-writes` with no
  prompt, or anything that fails before the turn. Every stderr line about the turn —
  the failure, the limit, `[write]` — passes `redactSecrets`, as the chat's lines do,
  and so do the message of a throw before the turn and the loader's own lines on
  stderr: a plugin that fails to load is skipped, not thrown, and its
  `[plugins] skip <name>: <why>` (`skipLine`), a built-in's `builtin skipped` and a
  remote plugin's lines are redacted where they are made, for the app's log as well.
  The last step is redacted before it is cut to 80 characters, so the cut never
  leaves part of a secret. A
  signal ends it as ever. The settings-file guard never asks there and is never
  armed: a file changed since it was accepted is said at the start
  (`configStartupNotes`) and not used, and one that changes on disk during the run is
  said once at the end (`settings file changed outside flow-assist — not applied`,
  `settingsChangedSince` in `src/config/load.ts`), is not applied, and leaves the exit
  code as the turn made it; the next start that can ask asks about it.

## Config & environment

- Config: `~/.config/flow-assist/config.json` (schema from each plugin's `configSchema`).
  A change to either settings file that the host did not accept is asked about before
  it applies, at a start as while the app runs ("Secrets", the guard).
- **A value is set in one of two scopes, through one path** (`setConfigValue`,
  `src/config/load.ts` — the CLI's `config set`, the app's `:config set` and the model's
  `config_set` all call it). `config set <key> <value>` SAVES: checked against the
  schema (a plugin's key against the plugin's), written to `config.local.json` under
  `hostStateDir()`. `:config set --session <key> <value>` is for this run only: the value
  goes into the SESSION map, never a file. The map is one overlay laid over what
  `loadConfig()` merges, so a later `loadConfig()` answers with it; and either scope is
  also laid on the config object the caller holds — the running app's, which `host.config`,
  a tool's `ctx.config` and a plugin's `config` slice read — so a value is live at once
  wherever its consumer reads the config when it acts (`ui.verbs` per request, the
  panel's side per draw). **A key marked `appliesOnRestart` is never laid on it**: its
  value is written (or kept for the session) and read at the next start, and the answer
  says so. That is what keeps the endpoint whole — laid one key at a time, a saved
  `ai.baseUrl` would send the next request, with the old `ai.tokenEnv`'s token, to the
  new host — keeps `theme` (the palette resolved at start) whole, and keeps
  `ai.disabledTools` from reading as done while the tool is still there. A saved value
  takes over from a session value on the same key. A plugin's slice is the config's own
  object (`makeFactory` puts one in place when the config has none), so a value set
  while the app runs reaches a plugin that had no section at start.
  `config unset` is the reverse (`unsetConfigValue`): `:config unset --session <key>`
  drops only the session's value, and without it the key also leaves config.local.json;
  the value it falls back to (config.json's, or none) is laid on the running app at
  once, or waits for a restart as `set` does.
  `renderApp` resets the map as an app starts — every app the scripted rig boots in one
  process starts on an empty session (two alive at once share it), and a test that sets a
  session value outside an app resets it (`resetSessionConfig`). The CLI refuses
  `--session` and names the `:` line, since its own process ends with the command.
  `config get` says where a value comes from — `session`, `local` (config.local.json),
  `config` (config.json) or `default` (neither) — from the layers `loadConfig()` kept
  beside its result (`configSource`, and `configValue` for the value: for a key read at
  start, the one the next start reads; a config built by hand, a test's, reads as
  `config`, and its layers start at its first write), never a second read of the files.
  `editConfigArray` reads the files without the session (`loadConfig({ session: false })`),
  so a session value never reaches a file through it; the CLI prints it on stderr, so `config get x | jq`
  still reads the bare value. On the `:` line a value loses one layer of surrounding
  quotes (`unquoteValue`), as a shell takes it off, so a line reads the same in both
  places.
- Environment: the host reads `LLM_TOKEN` (or `ai.tokenEnv`; `ANTHROPIC_API_KEY` with `ai.provider: 'anthropic'`) and the optional `FLOW_ASSIST_PLUGIN_REGISTRY_URL` / `FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT` / `FLOW_ASSIST_PLUGIN_REGISTRY_TOKEN`; host variables take the `FLOW_ASSIST_` prefix. A plugin owns its own variables and declares them in `requiredSettings`.
- `ai.images` (`enabled` true, `maxBytes` 5 MB, `maxPerMessage` 4) — images in the
  chat. On by default: the API cannot be asked whether a model takes images, so a
  machine whose model cannot says `config set ai.images.enabled false`. Its
  `config_schema` note (`KEY_DEFAULTS['ai.images']`; a leaf takes the note of its
  nearest parent that has one) says how to attach and how to turn it off.
- `ai.recall` (`enabled` true, `threshold` 0.5, `minChars` 4096, `everyTurns` 10) —
  bulky content as stubs (see "What the model can do"). Its `config_schema` note
  (`KEY_DEFAULTS['ai.recall']`) says what a stub is and how to turn it off.
- `config.user` (`name`, `login`) is the only source of the person's identity in the chat context — never the environment or the OS account.
- **Roots: each consumer has its own key, and the host never reads a plugin's.** The
  host's shell (`!command`, `run_command`) is confined to `shell.roots` (`shellRoots`
  in `src/assistant/shell.ts`); `repo` to `plugins.repo.roots`, declared in its
  `configSchema`, and without it to `shell.roots`, which it reads from the host config
  every builder is handed (`repoRoots` in `plugins-available/repo/src/index.ts`, called
  on every tool call). `fs.roots` is a setting only `repo` should own; the schema still
  accepts it and reads it for one release
  as the last fallback of both (shell: `shell.roots` → `fs.roots`; repo:
  `plugins.repo.roots` → `shell.roots` → `fs.roots`). A key that is SET — an array, even
  `[]` — is the answer: nothing falls through an empty list. Because repo reaches
  `fs.roots` only when `shell.roots` is unset, which is exactly when the shell does,
  one note covers both: `legacyRootsNote`, logged once at start by `renderApp`
  (`[config] fs.roots is read as shell.roots / plugins.repo.roots — move it: …`). The
  one-shot prompt has no log and says nothing.

## Secrets

A command the model runs can print anything the process can see, so "secrets stay in
the environment" holds only with the rules below; each is enforced in ONE place, and
a new path for text keeps to it.

**What they stop is an accident, not a model that tries.** Redaction and the clean
environment keep a token out of what the model, the screen and the records see when it
turns up by mistake — `env | grep` while debugging, a config file printed whole. They do
not contain a command written to get one: it runs as the person, so it can read the
app's own start-time environment (`ps eww` of its parent), start an interactive shell
that sources the profile again, call the Keychain helper the profile uses, or have a
plugin's process with the full environment run something (`repo`'s `git` runs a
`core.fsmonitor` a command wrote into `.git/config`); and a token printed transformed —
`rev`, split over lines, a substring, hex or another encoding — is not recognised.
`/auto all` together with `shell.autoRun` is the person's decision to trust the model's
commands; docs and hints never present either mechanism as a boundary.

- **The host knows the secret values** (`src/assistant/secrets.ts`, `SecretSet`): every
  environment variable the config names — `${VAR}` in any string value, `ai.tokenEnv`
  (or its default) — every variable whose NAME matches `SECRET_NAME_RE`
  (`TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|API_?KEY|_KEY$`; a plugin's `requiredSettings`
  token is one of these — the plugin API has no other way to call a setting secret),
  and a literal string at a secret-looking key of the config itself (an MCP server's
  `headers.Authorization`, named by its key path; `Bearer x`'s credential on its own
  too), and a request header that names a variable, as it is sent — expanded
  (`tok=${TOKEN};v=2` under an MCP server's `headers`). A system variable (`PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `TERM`, `LANG`,
  `LC_*`, `XDG_*`, …) is never one, whatever names it: a stdio server's `env` passes
  `${PATH}` through. The set is built at start (`refreshSecrets` in `main()` and
  `renderApp`) and again whenever a value is set or unset (`setConfigValue`,
  `unsetConfigValue`); a value is never logged or journaled.
- **`redactSecrets(text)` replaces each occurrence with `‹secret NAME›`** — the value,
  and its base64 (unpadded), base64url and URL-encoded forms, the longest match first; a
  value under `SECRET_MIN_LENGTH` (8) is never redacted (it would match words). A match
  is looked for with terminal escape sequences taken out, so `grep --color` painting
  part of a token does not hide it (the sequences inside a match go with it). A stream
  (`secretStream`) holds back the shortest tail that could still grow into a secret — or
  an escape sequence cut off — so a chunk boundary never lets a split one through, and
  a held tail is never emitted in clear: at `flush`, a tail of 8 or more characters
  that begins a secret (output cut off inside a token, `${TOKEN%?}`) goes out as its
  mark. One stream per source: `runShell` keeps one for stdout and one for stderr, and
  `agentChat` flushes its answer and reasoning streams in a `finally`, so a stop or an
  error loses no text. Streamed text shows a few characters late when its end could
  begin a secret. The choke points, one per channel:
  - a tool's result — `agentChat`, where `detailStr` and the data behind a framed result
    (`raw`) are made: what the model is sent, the kept data a later call pipes, the
    trail, the tool log, the session and the journal all read them;
  - a view's data (`open`/`update` in `agentChat`, before `acceptData`) and a change's
    `before`/`after` (`reportChange`) — drawn, saved and journaled from there;
  - command output — inside `runShell`, before a chunk reaches `onOutput` or the kept
    tail, so `!command`, `run_command`, the live view, the journal's `shell-out` /
    `call-out` and the model all get it redacted, and a tail cut never starts inside a
    secret; the `!!` recording right after `cleanRecording`;
  - the model's answer and its reasoning — a stream per round in `agentChat`, so what
    is drawn live, committed, saved and journaled has none;
  - view text — `sanitizeViewText`, which every framed view line and every screen item
    the model is sent passes through;
  - the log — `LogService.append` and `logToolRun`, and `consoleLogLines` (so the lines
    kept for stderr at exit have none);
  - what a plugin says — `Conversation.pluginNote` (`services.chatNote`, a command's
    `ctx.say`), a command's error line, a command panel's rows, title and notice
    before they are drawn (`/mcp`'s list names server URLs), and every toast
    (`showMessage`, bound in `renderApp`);
  - the system prompt — `withSystemPrompt` in `agentChat`, the per-round prompt and a
    leading system message alike: project instructions and the memory index are text
    anyone may have written a token into (a group's description, an MCP server's
    `instructions`, passes `sanitizeViewText`);
  - the backstop — `appendJournal` and `saveSession` write `redactDeep` of what they
    are given, so a tool call's arguments and a tool round's text (kept in the model's
    history as they came) never reach the disk with a token. At write time only: what
    a call runs is what the model wrote. `moveSessionToProject`'s own patch write (the
    picker's `^p`, sessions.ts) goes through the same `redactDeep` — the content came
    from an earlier `saveSession` and should already be clean, and the one field it
    patches (`project`, a directory path) can never itself be a secret, but a move is
    still a write, and the backstop does not make exceptions for one that only touches
    one field.
  The person's own words — a message, a `!command` line — are shown and sent as they
  are; on disk the backstop takes a pasted token out of them too.
- **The model's commands run without the secrets.** `run_command` starts from the
  process's environment less every name of the set (`withheldEnv`), except those the
  person lists in `shell.passEnv` (under `shell`, so on the leash — the model can never
  set it; read per command). Its result names what was withheld at its head, once per
  conversation — `withheld from commands: WIKI_TOKEN, … — shell.passEnv lets a
  command see one` — kept in `ShellState.told`, which the chat empties on `/clear`,
  `/new` and opening another session. A background task has a shell state of its own
  and is told again. The person's own `!command` and `!!command` keep the whole
  environment; their output is still redacted.
- **A settings file the host did not accept is never applied silently**
  (`src/config/load.ts`, the guard). The host keeps, in its own state
  (`config.accepted.json`, 0600), the hash and the content of `config.json` and
  `config.local.json` as it last ACCEPTED them — its own writes (`saveConfigSetting`,
  `saveConfigUnset`, `saveConfig`: `:config set`, `config_set`, `editConfigArray`, a
  plugin's own `services.setConfig` / `unsetConfig`, and the CLI's `config set`) and a
  change the person said yes to; a first start with no record accepts the files as
  they are. A plugin runs in the host's process, so its write is the host's — which is
  why a plugin tool the MODEL can call never calls `setConfig` / `unsetConfig` without
  the person's y/n on that call (a `write` tool): otherwise it is a way round
  `config_set`'s marks. At a start a file whose hash differs is not
  applied: `loadConfig` serves the accepted content; the app asks about it, the CLI
  and the one-shot prompt print why (`configStartupNotes`) and go on without it. Once
  `runInteractive` arms the guard (`guardConfigFiles`), `loadConfig()` serves what the
  host last read or wrote (`SEEN`); `checkConfigFiles` is a stat per file, the file
  read only when the stat moved (a touch with the same text is no change), and reports
  a change with its key paths, a value at a secret-looking key (`TOKEN`, `KEY`,
  `authorization`, `headers`, `env`, …) masked: every key on the model's leash
  (`isLeashKey` — `ai.*` with `ai.disabledTools`, `shell.*`, `web.*`,
  `plugins.<name>.roots`) first and never cut (`ConfirmAsk.whole`), the rest up to
  eight and then `+N more keys`. The chat asks — `config.local.json
  changed outside flow-assist — apply? (y/n)` in the confirmation's place
  (`ConfirmAsk.title` / `hint`), through the `configChanges` host service `renderApp`
  binds — as it starts, before the next request of a turn (`beforeRequest` awaits it),
  after a `!command` and after a turn (`askConfigChanges`,
  `src/assistant/conversation-turn.ts`) — one that `/clear` stopped included: a
  conversation the chat has left asks in the one it draws now (`ConversationDeps.current`, the registry's `shown()`),
  so the y/n comes up in the cleared chat as the stopped work unwinds. Yes (`applyConfigChange`) accepts it and lays
  each key on the running config, a key marked `appliesOnRestart` left for the
  restart. No (`declineConfigChange`) writes the accepted content back into the file
  and keeps the rejected text beside it, `<file>.rejected-<time>` (0600), so a restart
  — a `kill` of the app included — starts on the accepted config. A write of the
  host's is made on top of the accepted content, and a file that held other text has it
  kept beside it the same way first. The auto mode never answers the question (it is
  not `confirmWrite`); a stop or a reset that closes it answers nothing, so the next
  check asks again. A `flow-assist config set` from another terminal is accepted by
  that process and still asked about by a running app. The model's commands
  (`run_command`, a background task's) run with `FLOW_ASSIST_MODEL_SHELL=1`
  (`MODEL_SHELL_ENV`); a host process that sees it — the CLI's `config set`/`unset` —
  writes the file but never updates the accepted record, and says the change waits for
  the person's yes, so the running app and the next start ask. The person's `!command`
  does not set it. Like the rest of this section it stops the accident, not intent: a
  same-user process that unsets the variable (`env -u FLOW_ASSIST_MODEL_SHELL`), writes
  `config.accepted.json` itself, or deletes it — the next start is then a first start,
  which accepts the files as they are — can still forge the record.
- **A plugin or a memory fact the host did not record does not reach the next start**
  (`src/loader/trust.ts`, `src/assistant/memory-trust.ts`). With commands running
  unasked, or one approved and not read closely, the model's shell could otherwise make
  itself persistent: a link in `plugins-enabled/` runs in the host's process (or as a
  child with its environment) at the next start, and a file in `memory/` is a line of
  every later request of its scope. Both records are the config guard's shape — the
  host's own state, 0600, written by the host's own acts and the person's, never from a
  process with `FLOW_ASSIST_MODEL_SHELL=1`, and the same limit: they stop the accident,
  not intent (a same-user process can rewrite or delete them; a deleted one makes the
  next start a first start).
  - **Plugins** — `plugins.trusted.json`: `firstStartDone`, and per
    `plugins-enabled/` directory, by its real path, each trusted plugin's name → the
    real path its link led to. `loadPlugins` (every path: the app, the one-shot prompt,
    `config set plugins.…`) checks it BEFORE a manifest is read, so an untrusted plugin
    is neither imported nor spawned, never `late.expect`ed or `wait`ed; it is a skip line
    (`[plugins] skip <name>: ` + `untrustedText`) and an entry in the caller's
    `untrusted` (`{ name, was?, now?, refused? }`). A trusted plugin is read and loaded
    from the target its trust was checked at (`TrustCheck.at`, `loadEnabledPlugin`'s
    `dir`), never through the link again — the same rule `loadTrustedPlugin` holds for
    the `:plugins` panel's loads. The name and the target, not a
    content hash: a `git pull`, or an installer that unpacks each version into the same
    `plugins-available/<name>` and makes the relative link `../plugins-available/<name>`
    again without the binary, keeps it; a plugin new to such an installer needs one
    `plugins trust`; a command editing a trusted plugin's code is out of scope.
    - **Names.** Only `PLUGIN_NAME` (`^[A-Za-z0-9][A-Za-z0-9._-]*$`) is a plugin: the
      loader refuses any other entry even at a first start, `repo.list` marks it
      `refused`, `install`, an archive's top directory and `trust` refuse it, and no
      command line is built from it (it is shown JSON-quoted, `shownName`). Every shown
      command goes through `trustCommand` / `shellWord` all the same.
    - **The first start is ONE per record**: only a MISSING record (or one the host wrote
      with `firstStartDone: false`, a `plugins trust` before any start) trusts every
      valid entry of the directory it checks, then sets the flag; the list goes to the
      log and to `trustNotes` (the start screen), and to stderr when not late. A
      directory first seen after that starts with nothing trusted. From the model's
      shell a missing record trusts nothing and writes nothing. A record that does not
      parse to its shape is UNREADABLE: nothing is trusted, `trustNotes` says so, and
      the next `plugins trust` moves it aside (`.unreadable-<time>`) and starts a new
      one with the flag set. `plugins ls` reads with `readOnly` — it never runs the
      first start or prunes.
    - **Disabled.** A link the person disabled waits in `plugins-enabled/.disabled/`:
      never loaded, and its trust forgotten as a removal forgets it (the tombstone kept):
      enabling it never trusts it, a command moving the link back loads nothing, and the
      person's `y` in `:plugins` trusts it again at once while it leads where it did.
    - **Stale entries.** A check forgets every recorded name whose entry is gone from
      the directory — from the model's shell too; `repo.remove` forgets
      (`untrustPlugin`), and the model's `host:plugins_install` calls `repo.untrust`
      once its install SUCCEEDED (a refused install forgets nothing), so a name the
      person trusted earlier never lends that word to what the model installed. A
      forgotten name keeps its target in `forgotten` (a tombstone): it never grants
      trust, but a link put back elsewhere is untrusted WITH `was`/`now` and
      `trustPlugin` asks for `yes`. Only the person clears a tombstone: `plugins trust`
      (recording the new target) or the CLI's `plugins remove`
      (`untrustPlugin(…, { clear: true })`); the model's `host:plugins_remove` keeps it.
    - **Retargets.** A name recorded with another target is untrusted with `was` and
      `now`, shown on the start screen and in the log; `trustPlugin` refuses to record
      the new target without `yes` and returns both (`confirm`), and `runPlugins trust`
      prints both and asks on a terminal (`deps.confirm`, a readline y/n on a TTY; none
      in a pipe) or takes `--yes`.
    - **What records**: `plugins install` (name or archive, trusting the target it
      installed, `installed and trusted`) and `plugins trust <name>` from the CLI
      (`runPlugins`, `src/main.ts`), and the person's `y` in the `:plugins` panel (The
      command line, `:plugins`) — a first trust and a retarget each confirmed with a
      second `y` over the place shown. Under the model's shell neither records: the install
      still happens, forgets any trust under the name (`untrustPlugin`) and says
      `installed, not trusted`. The model's `host:plugins_install` leaves the plugin untrusted and its
      result names the command: the auto mode may answer its y/n (`confirmedByPerson`
      does not tell it from the person's key), and the y/n shows a name, not what a
      command may have put in that directory. `plugins ls` marks an untrusted plugin
      `[active, not trusted — …]`.
  - **Memory** — `memory.accepted.json`: `firstStartDone`, and `files`, a fact file's
    real path → the hash of the text the host wrote (`addFact` / `saveFact` →
    `writeFactFile` → `recordFactFile`; `removeFact` forgets) or the person accepted.
    The first start is ONE per record, as for plugins, and runs ONLY in the chat's
    start-up pass (the timer that also moves `memory.json`: `firstStartPending` →
    migrate → `firstStart(workspaceRoot(config))`), never in `markFacts`: it walks the
    root (no link followed), accepts every fact file there and sets the flag; a root
    first met after that (another `workspace.dir`) accepts nothing. A record MISSING
    after that (deleted while the app runs) accepts nothing — `markFacts` compares
    against nothing — and the chat says so once (`memoryRecordNotes('later')` from
    `Conversation.memoryBlock`); at a start, a missing record, or one the host wrote before any
    first pass (`firstStartDone: false`, "pending" — its own fact writes, which it does
    compare against), is a line on the start screen (`memoryRecordNotes('start')`, in
    `runInteractive`'s `trustNotes`). An
    unreadable record accepts nothing, `memoryRecordNotes()` says so on the start
    screen, and the host's next write or the person's accept moves it aside and starts
    a new one. Checked at index build only: a hash of text `readFacts` reads anyway and
    one read of the record.
- **Tests start without either record** (`src/__tests__/helpers/test-setup.ts`, the
  `bunfig.toml` preload): the host's state is one directory per `bun test` process, and
  with one first start per record every test after the first would otherwise meet its
  own plugins and facts as put there from outside. A test that runs two "machines"
  names a record file of its own (`loadPlugins`' `trust.file`); `bootApp` gives every
  boot with a remote plugin one, as each boot's plugins directory is new.
- The test rig builds the set from what a test set itself (`setSecretsEnv` in
  `src/__tests__/helpers/scripted.ts`), never from the machine's own tokens, and its
  `LLM_TOKEN` starts with `^`, a character no streamed test text ends in.

## Testing

From the host root: `bun run typecheck && bun test ./src ./scripts ./packages` (the
path filter keeps a locally dropped-in plugin's suite out of the host run).
`./packages` is `@flow-assist/remote`'s own suite (the protocol, its codec, `runPlugin`,
`serveConnections`).
Plugin tests: `cd plugins-available/<name> && bun test`. A bundled plugin declares no
dependencies and keeps no lockfile or `node_modules` of its own: its sources import
only Node's modules, and a test that needs zod (to hand a builder the host's `z`)
resolves the host's own from the checkout's `node_modules`.
The host suite must pass with `plugins-available/` empty — a host test never loads a real plugin.

**A test never reaches the person's own files.** `hostStateDir()` (`src/config/load.ts`)
is where the host keeps what it writes for itself, and where it reads its settings:
the config directory normally, a temporary directory of this process under `bun test`.
The agent workspaces (`projects/`), the legacy memory file, the tool log and both settings files — `config.json` and
`config.local.json`, read by `loadConfig` and written by `config set` — all resolve
through it, so no test runs with the person's own settings; the cache keeps its
store in memory and writes no file at all under a test, and the sessions have their own
`null` (`sessionsDir`). Two rules hold it together, and a new file the host reads or
writes by default keeps both:

- **Resolve the path on every call, never at import.** A `bun test` run shares its
  module registry across every file, so an import-time constant is decided by whichever
  file imports the module first — before any test can point the directory anywhere.
  That is how `memory.json`, `cache.json` and `tools.log` all pointed at the person's
  own directory for the whole suite: their memory grew a copy of the same fact per run,
  and pressing `x` in an e2e test emptied their cache.
- **A temp directory is the floor; a file of the test's own is the isolation.**
  `bootApp` names a sessions dir, a legacy memory file and a workspace root
  (`workspace.dir`) of its own, so one test's stored fact or draft cannot ride into the
  next test's system prompt — every boot is in the same project (the checkout), and the
  host's state is one directory for the whole process; a test that reads the files back
  names them through `extra`.

- `src/__tests__/helpers/scripted.ts` — a scripted model and a booted app: the
  REAL TUI on a test backend with only the network replaced. Steps are text,
  a tool call, or a `hold` that freezes the stream until `release()`. Like a real
  fetch it honours the request's `signal`: an abort errors the body with an
  AbortError, so Esc stops a scripted answer, and a request made with a signal already
  aborted rejects before it is recorded. End-to-end
  tests drive the app through it; assert on the frame AND on cell styles
  (`backend.lastBuffer`).
- `src/__tests__/helpers/conversation.ts` — `conversationRig(model, opts)`: ONE
  conversation on the host's real services and tool registry with only the network
  replaced, and a sessions directory, memory, workspace and shell root of the test's own
  — no App. `await rig.conv.send(…)` resolves when the turn ends; `rig.sent(i)`,
  `rig.conv.api`, `rig.journal(id)`, `rig.sessionFile(id)` read what the model was sent,
  the history, the journal and the state file; `rig.pending()` / `rig.answerNext(ok)`
  the y/n; `rig.fresh()` makes another conversation as `/new` does, `rig.open(id)` opens
  a saved one as `/resume` does; `closeRigs()` in the file's `afterEach` closes every
  conversation a rig made and puts `LLM_TOKEN` back. Its conversations are made by a
  registry of its own (`rig.registry`), as the chat's are, one missing-memory note for
  all of them. A test whose claims are about what is sent, the history, the journal or
  the queue uses it (`*.rig.test.ts`); one about cells, keys or layout boots the App.
  `ScriptedModel.when(match)` gives a sub-script of its own turns and `hold` /
  `release()` to the requests `match` takes (`firstUser(req)`, a request's first user
  message, tells one conversation's from another's); `model.held` says a `hold` is
  reached.
- `src/__tests__/helpers/session-files.ts` — a booted app's sessions land under a
  mirror of the project the shell starts in (the checkout's git root under `bun test`,
  none where there is no `.git`): a test finds a session's files with `listTree` /
  `homeIn`, never by listing the sessions directory flat, so it holds either layout.
- `bun scripts/ui-frames.ts [--size WxH] [--color|--styles] [scenario…]` — the same
  rig for eyes: frames at named checkpoints, no network. Look at a display change
  before and after with it.
- `bun scripts/eval-tool-use.ts` — a behavioural eval against a LIVE model (costs
  money; `--fake` checks the harness): rates by turn, false claims, `--history
  display|api` as an A/B, `--show` prints the dialogue.
- `bun scripts/eval-tool-loading.ts` — the same kind of eval for tools on demand:
  does the model find the one tool a task needs among a dozen, in how many rounds,
  `--tools all|onDemand|both` as the A/B (live; `--fake` checks the harness).
- `src/__tests__/remote-transports.e2e.test.ts` — a remote plugin over real
  processes, through the App: a crash and its restart past the backoff, two hosts on
  one shared server, that server crashing under both (each comes back, one new server
  between them), a server ending on its idle, and the host's own exit letting the
  child end cleanly. The other
  side is `src/__tests__/helpers/remote-fake-plugin.ts`, a real process that speaks
  the protocol by hand, standalone or under `--serve`.
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
  A bundled plugin (`plugins-available/gitlab`, `mcp`, `repo`) ships from this repo
  with the same release, so it carries the host's own version too — bump its
  `manifest.json` and `package.json` alongside the host's (a test keeps every
  bundled plugin equal to `hostVersion()`, naming the one that drifts). A
  third-party plugin, kept in its own repository, versions itself.
  `packages/remote`'s own `package.json` version equals the host's the same way (a
  test holds the two together). It is published with each release by `bun publish`
  from `packages/remote`: `prepublishOnly` builds `dist/` (with `.d.ts`), and the
  package ships `dist` and `src` — the `bun` export condition points at the sources —
  but not `src/**/__tests__` (`package.test.ts` holds that, and that the package builds
  on its own with the root's `@types/bun`).