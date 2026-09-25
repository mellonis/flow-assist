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
- Bun **1.3.x** — `bun run`, `bun test`. The TUI runs as `bun src/cli.ts`.
  **A `bun build --compile` binary WORKS, given plugins are shipped BUILT** (probed
  end to end on Bun 1.3.14, 2026-09-21: pack → install → the compiled host draws the
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
  set (not under `NODE_ENV=test`). `install.ts` is `main.ts`'s FIRST import: the config
  directory is fixed when `config/load.ts` is evaluated, so a `.env` loaded from
  `main` would reach only half of the program.
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
├── package.json               # host; root of plugins-available/*, workspace root for packages/*
├── docs/
│   ├── plugins.md             # "Writing a plugin" — the contract for plugin authors
│   └── demo/                  # the README's GIFs
├── examples/
│   ├── notes/                 # the plugin docs/plugins.md builds; run by the host's tests
│   └── remote-login/          # a remote plugin; docs/plugins.md, "A plugin in another language"
├── packages/
│   └── remote/                # @flow-assist/remote — the protocol's types, codec, runPlugin
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
`examples/notes` declare both fields (a test). A plugin reads the number it runs under
from `host.hostApi`.

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
`services`, `aiTools`, `keycaps`, `entry`, `setup`, `chatContext`,
`chatSubject` (deprecated), `afterWrite`; every hook, and each
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
  `TextInput`, and @flowtty/core's `isPrintable` — one object for every plugin; `host` is what the host implements or wraps — `services`,
  `store`, `config`, `keys`, `keyCap`, `useInputHandler`, `useSurfaceSize`,
  `useTerminalSize` (the plugin's side, not flowtty's whole terminal), `notify`,
  `viewRegistry`, `commandRegistry`, `helpFor`, `copyToClipboard`, `pluginToken`,
  `hostApi` — one per plugin. `host.services` stays the live per-plugin view (host
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
  keys; a dropdown's popup mutes everything under it on its own).
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
    never the transcript, `apiRef` or the session — and each wire places it:
    `openAiMessages` joins it to the end of the person's last message (a paragraph, or a
    text part when that message has parts) and after tool results leaves it a user
    message of its own; `anthropicRequest` sets the message breakpoint on the last
    CONVERSATION block first and then appends the tail as a text block of the last user
    turn (after its tool results), so alternation holds and the tail is uncached. No
    items, no block. The meter counts it as the `on screen` part
    (`ContextParts.screen`). Only the chat's `send()` passes it: a background task
    (the `background` tool's nested `chatLLM`) and the one-shot CLI (no mounted
    plugins) get none — they run apart from the screen. `/compact` does not see it.
    The chat's title is the labels joined ` · `, cut to the frame
    (`ƒ Flow Assist · Board: Frontend · Issue ABC-1`), the plain name with none.
    **The screen changing never switches the session**: opening the chat continues
    the conversation whatever is on screen (switching lost the dialogue for the
    person); `/clear` is how a fresh one starts. The session never writes
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
- **It ends with the program.** `process.on('exit')` covers `:quit`, Ctrl+C (twice) in
  the app and a command running out of work; a signal ends a program WITHOUT that event, so
  SIGTERM/SIGHUP/SIGINT are heard too.
- **A signal handler must not swallow the signal.** flowtty decides whether to re-raise
  one by COUNTING listeners — with a second listener present it unmounts and leaves the
  signal to the app, and the app would then live through Ctrl+C. So the handler stops
  its processes, removes ITSELF, and re-raises only when no listener is left.

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

### Remote plugins

A plugin can be a separate process, in any language, speaking JSON-RPC 2.0 over its
stdin and stdout — the protocol as its authors read it is docs/plugins.md, "A plugin
in another language". `remotePlugin` (`src/remote/adapter.ts`) turns that conversation
into an ordinary `Plugin`; nothing else in the host knows a plugin is remote.

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
- `hello` runs once, at load, with a 10 s timeout; the guest rule
  ("A plugin is a guest", above) still holds a remote plugin to it, since `keycaps`
  reads the last frame the same way for a remote plugin as for one in the host's own
  process.
- **The `Transport` seam** (`src/remote/transport.ts`) is what the protocol layer
  knows of a process: lines in, lines out, a close. `src/remote/transports.ts` is
  where the loader gets one for a manifest's `run` or `connect` — a stub today
  (`transportFor` throws `remote transports are not built yet` for either field);
  `loadPlugins`'s tests inject their own (`LoadPluginsOptions.remoteTransport`).
- **A crash**: the transport closes, the surface says `plugin stopped`, every tool in
  flight and every new one throws it, and `onRestart` runs `hello` again from an
  empty frame.
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
  what yields: whole when it fits, else ONE row — `▸ plan 2/3 · <item>`, the item in
  progress (else the first pending) by its place in the plan, cut to the width — and
  whole again when there is room (`planFit` / `planLine` in `views/modals.ts`, the
  rows counted from the same pieces the blocks draw). Past even that it is not drawn.
- **Two slots, in every mode, in the same order** — the plugin's side, then the panel;
  only their props change (the row/column direction, a width, `position: 'absolute'`
  over the whole terminal for `window`/`full`). A component moved to another parent is
  mounted anew: `/mode` would lose the turn being written, the draft and the queue,
  and a plugin's screen its state. A third place holds what floats over everything,
  the chat included — the reminder and the keycaps panel (`TOP_LAYER`): layers of no
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
  a click on a fold in the panel works whichever side has the keys. The wheel scrolls
  whatever list is under it (flowtty's lists check the pointer; the chat's own, when not
  focused, through its handler). Plugins get no mouse buttons.
- `bootApp` opens the chat as a WINDOW unless a test says otherwise (`opts.chatMode`,
  `null` for a fresh config): most e2e tests are about what the chat draws.
  `chat-modes.e2e.test.ts` holds the modes, the keys, the layout and a row check at a
  panel's width.

## What the model can do (the `core` tool group)

`memory`, `config_schema`, `datetime`, `remind`, `background`, `todo`, `ask_user`,
`open_url`, `recall`, plus `host:plugins_list`. Three rules hold this set together:

- **A plugin's config key is validated by the plugin's schema — everywhere.**
  `configSchemaAt` (`src/config/load.ts`) resolves a key through the host schema and,
  for `plugins.<name>.*`, through the plugin's `configSchema`; `config set` in the CLI
  (which loads the plugins only for a `plugins.*` key), `:config set` in the app and
  the model's config tool all use it, so a plugin's key — `config set
  plugins.keycaps.enabled true` — is recognized by the tool and the commands alike,
  never known to one and "unknown key" to the other.
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
  tool opens a live view (`ctx.liveView`, see "A tool describes what it shows, a
  renderer draws it, the host frames it") and fills it as the command prints, and the
  chat draws the `$ …` block. A declined call leaves none — nothing ran; a failed one
  shows its output and its exit code.
  Folded, the block is ONE line saying how it ended — `cmd · ✓ 4.2 s`, `✗ exit 1 · 4.2
  s`, `stopped`, `timed out`; a CLICK opens it to the last
  `plugins.assistant.runOutputLines` lines (20) with `… N lines cut · ^o for all` above
  them — a display cap of its own, quite apart from `shell.maxChars`, which is how much
  the MODEL is given; `^o` opens every block in full (`VIEW_CAPS.lines`, everything the
  view kept), which is what makes `^o for all` true rather than a second, still-capped
  state. Consecutive commands of a turn (no other call between them) fold under one
  `ƒ Ran N commands · ✓ 34.0 s` head — `Running N commands · $ cmd · 4 s` while one runs —
  which also takes in the rounds between them that said nothing but their plan (a
  step that is only its `Next:` line, `isPlanOnly`: the head says what ran, which is
  what the plan said would). Opened, they are the commands alone, each its own block
  (`src/assistant/view-groups.ts`). Groups form only in the `step` notes mode, and a
  message that says more — a step of its own, a call, a change, reasoning — is never
  folded into one. A call that left a view is shown by its view and never a second
  time as a trail line.
- **`cd` moves the shell's directory for the model** (`src/loader/tools-shell.ts`, the
  `shell` group, so `ai.disabledTools: ["shell"]` takes it too). `{ path }`, relative to
  the conversation's directory or absolute (`~` the home), held to `shell.roots` by the
  same spelled-and-real check as run_command's `cwd` (`cdTarget`); outside them it
  THROWS naming the roots, and with no roots configured it refuses — it is read-only
  (no y/n), so nothing but the roots guards it. It sets `ctx.shell` the way `!cd` does,
  so the hint row and every later run_command follow, and answers `now in <dir>` and
  the AGENTS.md files the chat picks up there (or `no AGENTS.md between here and
  <root>`) — one call enters a project.
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
  non-file. Each file is capped at 32 KiB (`INSTRUCTIONS_CAP`), cut at a line break
  with `… (cut at 32 KiB — N more lines)`; only the head is held, the rest counted. The
  section is `## Project instructions` — a framing line, then each file under `###
  <path>` — after the memory and before the plan (`joinSystem`). The rest of the system
  prompt is taken once per message; this section is read again before EVERY round
  (`AgentOpts.systemPrompt`, laid over the round's copy, never the history), so a `cd`
  is seen by the next round of the same turn and an unchanged round sends the message
  it had — re-reading the plan per round would miss the cache after every `todo`. It is
  never a message in the history, so it is never stubbed, compacted or duplicated. The
  chat says which files were picked up in a `note` row (`Project instructions: ~/p/
  AGENTS.md`) only when the list changes; during a turn the note waits for the turn's
  end (a note between rounds would split the turn's message), and a list that already
  ends in the same note gets none (a continued session, restart after restart).
  `applySession` and `/clear` set the directory AFTER replacing the list, or the note
  would be replaced with it. The context meter counts the section under `system`.
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
  that character in it (navigating to the "Other…" row first is not a step anyone
  guesses at), and a paste on the list opens it with its text. What does NOT open it: `1`–`9`,
  the shortcuts the list advertises — a numeric answer is typed once the field is open
  — and the space bar, which toggles in a multi-select. The hint line states that rule.
  **The field is the chat's own editor**: flowtty's `editorReducer` in its single-line
  mode, so the caret (`state.caret`, a UTF-16 index — `state.cursor` is the ROW in the
  list) moves by character and word, Home/End and the kill bindings work, and a paste
  goes in at the caret with its line breaks collapsed to spaces. Esc leaves the field
  for the list; Esc on the list dismisses the question.
- **The memory is the person's too.** The `memory` tool is the model's: a stored fact
  goes into the system prompt of EVERY later request — across `/clear`, across
  restarts. That is its purpose, but left unsaid it reads as a bug: the assistant
  still knowing an earlier prompt after `/clear` looks like `/clear` failing, when in
  fact the conversation is gone and only the memory remains. So `/clear` reports what it kept
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
  where the model's view now begins; wiping the screen read as `/clear`. The note is ONE
  row, `── compacted · ~58k → ~2.1k tokens ──` (the `ctx N%` reading before and after;
  a size not known is left out), with the summary the model was given folded under it
  (`summary` on the note, fold kind `summary`). A note whose text already carries the
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
  `TokenUsage` `usageRef` holds) and, on the turn's own answer message, a `cached` sum
  of `cachedTokens` across the turn's rounds (beside `tokens`, the same sum of
  prompt+completion `onRound` already kept) — so a saved chat still shows a turn's
  cache hits, not only what it cost.
- **The plan (`todo`) belongs to a conversation, not to the process.**
  `createPlan()` in `src/assistant/plan.ts` makes one; its owner passes it to the
  tool as `ctx.plan`. The chat holds its own (`planRef`), and `/clear` resets it —
  so does the end of a turn that left every item done (a finished plan otherwise hung
  over the chat as "· N done"); a
  background run gets a fresh one, so its checkboxes never appear among the chat's;
  an eval trial makes one per trial. Only a caller with no conversation of its own
  (the one-shot CLI, a bare `execChatTool`) falls back to the process-wide plan.
  The shell's directory is the same kind of state: `createShellState` in
  `src/assistant/shell.ts`, held by the chat (`shellRef`), handed to run_command and
  `cd` as `ctx.shell`; a background run gets a fresh one.
  **Tool state that describes a conversation is never module-level** — as a module
  variable the plan outlived `/clear`, was shared with background runs, and leaked
  from one test into the next.
- **Bulky content is sent once, then as a stub the model recalls**
  (`src/assistant/recall.ts`, pure; the chat owns the state). An attached image, a
  `!`/`!!` output and a tool result over `ai.recall.minChars` (4096) are BULKY ITEMS:
  sent in full in the turn they arrive in — all its rounds — and, from a later batch
  on, as a one-line stub naming an id: `[$ brew update — exit 0 · 24.7 s · 120 lines —
  recall("out:7d41e0aa")]`, `[image shot.png · 3384×2078 — recall("img:3f9a2c1b")]`,
  `[read_file src/app.ts — 412 lines — recall("res:c02b9f15")]`. An id is
  `<kind>:<first 8 hex of sha256>` of the content (an image's the sha256 its ref
  carries), so it survives `/compact`, `/resume` and deletions, identical content
  shares one id and one stored item, and `recall` takes any unique prefix or the hash
  alone (an ambiguous one answers with the candidates). **What the host keeps never
  changes shape**: `apiRef` and the session hold the full content; the stubs are
  applied on the way OUT — `sentHistory()` in the chat, `applyRecall` over
  `apiHistory`'s output, matched by content hash — for the request, the context meter
  (a stubbed item counts as its stub) and `/compact` alike. Which items are stubbed is
  conversation state, `recallRef` (`RecallState`: the ids, this turn's recalls, turns
  since the last batch), saved as the session's `recall`, reset by `/clear`, never
  module-level. It is decided in BATCHES at the END of a turn (`decideBatch`, in
  `send()`'s `finally`): replacing old content changes the request's prefix and costs
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
  `AgentOpts.imageLimits` carries `ai.images` in (`services.chatLLM`, `runPrompt`); a
  caller that says nothing gets the defaults.
- **A request carries the core tools and an INDEX of the rest** (tools on demand,
  `src/assistant/tool-loading.ts`, pure; wired in `agentChat`). Every tool's full
  schema on every request costs ~7k tokens with only the bundled plugins, a tracker
  plugin doubles it, and a turn uses two or three. So with `ai.toolLoading: 'onDemand'`
  (the config default) a request sends the `core` group in full, the tools this
  conversation has LOADED, and `tools_load`, whose description is the index — per
  group, `name — first sentence of the description`. The index does not change as
  tools load (a stable prefix). `tools_load({ names | group })` is the loop's own
  tool, not the registry's; a group's name given in `names` loads the group (a tool of
  the same name wins), since a model reasonably passes one there and refusing it would
  cost a round; what is sent is worked out again for EVERY round, so a
  load reaches the next round of the same turn. A call to a tool that is indexed but
  not loaded is an ERROR naming `tools_load`, refused BEFORE the y/n — the wire-name
  map covers every known tool, not only the sent ones, or that call would not even
  resolve. `names` also takes a tool QUALIFIED with its group, `<group>:<name>`, as
  well as the bare name the index shows — the index reads as `group:\n- name — …`, so
  a model reasonably repeats the two together, and accepting that combination
  (`unqualify`, `tool-loading.ts`: stripped only as a
  fallback, when the bare name misses and the prefix names the group that bare tool
  is actually in — a name already in the list, bare or genuinely qualified by a
  clash, is tried first and never rewritten) avoids the round `ERROR: Not in the
  list` would otherwise cost. An unknown name still errors, listing
  the groups. A group may carry its own description too — guidance beyond any one
  tool's, an MCP server's `initialize` `instructions`, say (`ToolGroup.description`,
  `src/loader/tools.ts`) — shown as one line under the group's heading in the index
  and, once the group's tools are loaded (or sent in full under `'all'`), in full on the
  group's first tool; sanitized (`sanitizeGroupDescription`: control characters and the
  app's own frame words out) and trusted the same way a tool's own description is. The loaded set is a `ToolSet` owned like the plan: the chat's `toolSetRef`
  (saved as the session's `tools`, kept by `/compact`, emptied by `/clear`); a background run and the one-shot CLI start from an empty one.
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
  chat, `/clear`, `/resume`, and at process exit (`flushOnExit`). A
  write is temp file + rename; a file that does not parse is skipped. On start the
  newest session is continued unless `/clear` closed it (`sessions.resume: false`
  turns this off); `/clear` starts a new one and keeps the old on
  `/resume` (`/resume <n>` opens it). The last 400 messages are kept, 50 sessions.
  An image is saved as a ref (`images`, `imageSeq` — see "Images" under The chat),
  never as its bytes; the e2e test asserts the file holds no base64.
  **Under `bun test` with no `sessions.dir` nothing touches disk** (`sessionsDir` →
  null): `bootApp` gives every test a temp dir, and a test that renders the app
  directly must not write into, or continue, the person's own chats. A restored
  screen over an empty `apiRef` looks right and is the bug — the e2e tests assert on
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
  (`flushOnExit`), `/clear`, `/resume` to another session, and
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
  content is read, never re-derived after (`applySession` takes it as a
  caller-supplied argument, not something it looks up itself): a write landing in
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
instead and the clash is said (`[tools] "search" is declared by both …`). The registry
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
  host gives every call that function (`agentChat`); a caller with no chat (the
  one-shot CLI, a test's bare ctx) gives none, so call it as `ctx?.reportChange?.(…)`.
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
  - **The chat's half of `onToolLive`** (`src/plugins/assistant.ts`): the message a
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
  - **A reset — `/clear` and `/resume`, the same places `planRef`
    resets — clears `liveBuf`, `liveSeen` and any pending `liveTimer`, and bumps an
    `epochRef`** (`resetLiveViews` in `src/plugins/assistant.ts`); `turnRef` is NOT
    reset there, it belongs to the conversation's whole history, not one turn.
    `send()` and the `!command` runner each capture `epochRef.current` when they
    START; every one of their callbacks that could still fire after a LATER reset —
    a tool's own view (`offerLive`), its `changes` (`onToolRun`), the turn's own
    final `flushLive()`, `!command`'s own completion — compares its captured value
    against the ref's CURRENT one and drops the update if they differ, rather than
    finding no message for the old `callId` (the buffer forgot it) and pushing a NEW
    one into the fresh conversation: without this, a command still running when
    `/clear` fires would reappear, with its final phase, in the cleared chat.
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
  whole; only the `role: 'tool'` message pushed into `current` (and so into
  `transcript`/`apiRef`) is capped, once, for good. A tool declares its own
  `maxResultChars` on the tool def (the plugin tool type, `src/loader/tools.ts`) to
  raise its OWN cap — for one whose result is large and worth the tokens — clamped to
  a hard ceiling (200000) so a plugin cannot flood the history by declaring a bigger
  number; it is stripped before the def reaches the wire, like `write`/`run`.
  `run_command` already keeps only the tail of its own output (`shell.maxChars`,
  default 20000) before this cap ever sees it, so the smaller of the two numbers
  wins without either needing to know about the other. `services.chatLLM` and the
  one-shot CLI resolve `ai.toolResultMaxChars` once from config
  (`toolResultCapFromConfig`) and pass it as `agentChat`'s `toolResultMaxChars`; a
  caller that says nothing gets `TOOL_RESULT_MAX_CHARS_DEFAULT`.

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

**A call whose arguments do not parse to a JSON object is refused at the call, not
stored as it arrived.** A stream that ends mid-argument (`{"path": "…", "ref": "f`), or
valid JSON that isn't an object (an array, a bare string, `null`), never goes into
`current` raw to run as `{}`: stored that way, every later request would carry the
malformed call, and an OpenAI-compatible provider answers 400 on all of them, forever
— `/clear` the only way out. Instead the call does not run, the model gets an error
naming the parse failure, and the history keeps `"{}"` in the call's place so it stays
valid JSON. `apiHistory()` repairs the same shape found in a session saved by an older
host, so it recovers on its next request.

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
caller — the chat's send and `/compact`, a background task, the one-shot prompt, and
`services.chatLLM` itself for a plugin that passes less — spreads `llmOpts(config.ai)`
into its call, and the start-up gate (`configWarnings`) checks the same resolution: with `anthropic` the base URL defaults to `https://api.anthropic.com/v1`
and the token variable to `ANTHROPIC_API_KEY`. In `agent.ts` the provider is looked at in
exactly two places, `roundFor` (the round `agentChat` runs; a caller's own `chatRound`, a
test's stub, wins) and `compactConversation`. **What the host keeps never changes shape**:
`apiRef` and the session stay OpenAI-shaped, and `anthropicRequest` converts on the way
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
header. `/compact` sends the instruction as `system` and the whole conversation as ONE
user message of text ending with the request for the summary (`summaryHistory`: `user:`,
`assistant:` with `[called name {…}]`, `tool result:`) — sent as turns it would end with
the assistant's answer, which the API reads as a prefill, and its tool blocks would need
tools the request does not carry. **Thinking blocks go
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
provider: everywhere the host keeps a message (the display list, `apiRef`, the
session) its content is a string, and a person's message with images carries them
beside it as `images: ImageRef[]` (`{ n, name, path, sha256, mime, bytes, width,
height }`, `src/assistant/images.ts`) — on the display message only their numbers.
`apiHistory` passes a user message's `images` through — and a tool message's, the
images a tool returned beside its result ("A tool can return images" under What the
model can do); `send()` alone turns them into
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
  commands declare none.
- **↑/↓ recall what was run** (in memory, for this run). A command declared with
  `history: false` is never kept — the host's `config` is (a value set may be a
  secret: an MCP server's `headers` or `env`), and a plugin's command may say it on its
  definition (`Command.history` in `src/loader/plugin.ts`). Static, never decided per
  call.
- **Nothing is silent.** An unknown command answers `Unknown command: x — try :help`.
  A command that is listed does something: `view` and `back` set a state nothing in
  the host reads and were removed. The host's commands are `clear`, `quit`, `config`,
  `cache`, `help`; everything else is a plugin's.
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
  ground for a background result, `$` on the user ground for the person's own
  `!command` and on none for a command the MODEL ran and they confirmed (a `view`
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
- **⏎** sends; while an answer is coming it **queues** instead (sent in order when
  the turn ends; the line over the field shows the LAST one, and `↑ takes it back`
  while the field is empty). **Esc** while an answer or a `!command` runs **stops it,
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
  **A queued message never undoes what just ended**: `send` lays its message onto the
  list with an UPDATER over the list as React has it, never onto `msgsRef` (what was
  last DRAWN). The queue goes out from a zero-delay timer after a turn, a `!command`
  or a slash command (and `!!`'s ask likewise), and that timer can run before the
  render carrying the end: a list built from `msgsRef` would throw the end away — a
  finished command's block would come back live and tick forever, an answer would
  lose its last words. This shows up under load; `queued-send-race.e2e.test.ts` makes it deterministic by running
  zero-delay timers as microtasks. **A stopped or failed turn does not send the queue** (`restoreQueue` in
  `src/plugins/assistant.ts`): the queued messages come back into the field in order,
  joined by blank lines, AHEAD of whatever was typed meanwhile — the order they would
  have gone out in; a `!`/`!!`-mode draft keeps its bang(s) and the level drops to 0. A failed
  request would most likely fail again. **↑ on an EMPTY field takes the last queued
  message back** before it steps into the history. **Alt+⏎** (drawn `⌥⏎` on macOS) is a newline (`NEWLINE_KEY` in
  `src/views/modals.ts` — the one spelling every hint uses); a blank line is kept.
  ⇧⏎ works too where the terminal sends it (decoded since flowtty 1.0.0-alpha.7),
  but the hint names the key that works in every terminal that has an Alt.
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
  claimed only while there is something to stop** (`canStop`: a live `abortRef` not yet
  aborted) — for Esc as well: a run that goes on after its abort (a tool that ignores
  its signal) no longer holds them, so the next Ctrl+C arms and the one after exits,
  Esc goes back to its idle steps, and the status line drops `Esc stops`. `/compact`
  (`runAsyncCommand`) has a controller of its own, passes the signal to its request and
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
  - **Where the eye is left.** Opening a block scrolls so its FIRST row is the top row
    — landing on its LAST line instead would show the end of the thing the person
    opened it to read, past where they meant to start; closing keeps the clicked block's first row
    where it was; the key, which has no one block to anchor on, keeps the message the
    top row belongs to where it was. With the list resting at the END nothing scrolls
    at all: the rows are added above the reader and the bottom is already their place.
    The ask travels as `scrollTo: { row, n }` and is carried out inside the metrics
    callback, where the box has just measured the rows the fold added or took away.
  - Following the bottom belongs to a message ARRIVING (`scrollToEnd` on the count of
    questions asked), never to rows appearing above the viewport.
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
    `stopped (Esc)`, what it cost.
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
    run carries marks after its text so what happened inside is seen without a click
    (`runMarks`): `✗` in the error colour when one of its calls failed or was
    declined, `✎` in the warn colour when a write ran and showed no diff; the summary
    is cut to leave them room. Every cut in the chat's chrome counts cells, not code
    units (`cutStep` / `cellWidth` on flowtty's `charWidth`), so a wide character
    never pushes a row onto a second line. A trail is
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
    streamed carries a call is a ref (`roundToolsRef`), set by `onRoundKind`, read by
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
    keeps the call as it was made; it is sent it again). A session file saved by an older host keeps the text of the tool
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
  (`!bun test src/features`); the model never reaches this path. The field carries a
  **bang LEVEL** — 0 normal, 1 shell mode, 2 interactive mode (`!!command` below) —
  and `!` typed into an EMPTY field steps it UP one level instead of being inserted
  (like Claude Code's bash mode, taken one step further): the prompt glyph reads `! `
  at level 1 and `!!` at level 2 in place of `› `, both in `theme.modals.chat.shell`
  (a colour of its own, distinct from `accent` — pick it from
  `MODAL_COLOR_DEFAULTS.chat` in `src/playback/theme.ts`, checked against flowtty's
  `NAMED_COLORS` by the theme test; `!!` reuses the same colour rather than getting a
  second one — one shell identity at two depths). Both glyphs are exactly `GUTTER`
  (2) columns, `!!` with no trailing space, so a wrapped command's continuation rows
  still line up under the first. Enter runs the field text as it reads — level 1 as
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
  it runs the chat is busy exactly as while an answer is written (`streamRef`, the
  spinner, `$ cmd` as the tool label, Esc stops it); a `!` meanwhile is refused, not
  queued. The result is a message of role `shell` — `$ ` in the SAME shell colour as
  the mode's prompt (a command reads as one thing from typing to result) on the
  person's ground, the same live block as the model's commands (one line while it
  runs; `✓ 1.2 s · ~/dir` when it ends, opened by a click to its last lines) — the
  message is still role `shell` and still joins `apiRef` (`apiHistory` maps `shell` →
  `user`) and is read with the next message; no turn is spent. It is saved with the session and
  its line goes into ↑/↓ as `!cmd`; recalling one with ↑ shows it the way it was
  typed — level 1, the field holding `cmd` with the `!` stripped (see the bang-level
  paragraph above). The bang level itself is UI state of the field only, never saved
  and never restored across a restart; a `!…`/`!!…` or a non-zero-level field is not
  a draft. **The directory is remembered**
  between commands, as in a terminal, and shared with `run_command`: it starts at the
  first `shell.roots` directory (else the process's), a `cd` moves it only within the
  roots by real path (the shell writes `pwd -P` to a private temp file after the
  command — a 4th stdio pipe under Bun lost the report now and then), `exit N` or a
  kill keeps it, run_command's `cwd` argument is a `cd` that stays, `/clear` goes back
  to the root, `/resume` and a restart bring it back. Variables
  and functions are not kept — every command is a fresh shell. While the field is in
  `!` or `!!` mode the hint row under it STARTS with that directory (`~`-shortened,
  cut from the left when long — `cutFromLeft` in `views/modals.ts`; the chat passes
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
  (`src/assistant/interactive.ts`; the chat's side is `runShellCommand(cmd, true)`) — a
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
  It asks whenever something was recorded: the recording joins `apiRef` as `The person
  ran an interactive program …`, and a turn starts at once with `INTERACTIVE_ASK` as
  the person's message — `send(…, { hostAsk: true })`: drawn dim, gutter and all
  (`hostAsk` on the display message, `quiet` rows), never put into ↑/↓, and the field
  is left alone (it did not come from there). Nothing recorded — no `script`, or nothing
  left once a full-screen program's own screen is dropped (`!!vim`, `less`, `top`) —
  and the run is a block on screen only: no `apiRef` entry, no turn, a dim `note`
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
- **The field completes inline, through the `:` line's own `lineView` / `lineTab`** —
  one vocabulary: the untyped rest of the offer after the caret in the dimmed accent,
  its label beside it, the other candidates as `⇥ a · b`, Tab taking the offer and then
  walking the rest. What is offered is `chatComplete`'s (`src/config/fieldcomplete.ts`,
  pure): a `/command`'s name in the declared order (a bare `/` lists them all), then
  its argument from `CHAT_COMMAND_DEFS`' `values` — `/auto reads|all|off`, `/notes
  step|open`, `/mode panel|window|full`, and `/resume` the saved sessions by number,
  newest first, each labelled with its title (`chatCommandDefs`, bound where `sessDir`
  is known and read when the field is drawn) — or, at a non-zero bang level, the last
  word as a PATH under the shell's directory (`completePath`): `~` is the home, a
  directory gets `/`, hidden entries only for a word starting with `.`, a name with a
  space escaped `\ `, and nothing outside `shell.roots` by REAL path — the listed
  directory itself, and any link that leads out (`dirAllowed`'s rule; only the
  directory and its links are resolved, never every entry). The listing and the
  real-path check are injected (`listDirectory`, `realOf`), so the tests use a
  directory of their own. Only with the caret at the end of a one-line field; the walk
  is `tabRef` (a `TabWalk`), over the moment the field is anything else. In the field,
  dim means "offered, not yours yet" — the person's own text is never dimmed, on
  either side of the caret.
- The **status line** while a turn runs says what happens NOW: a running tool's label
  (`⚙ name(args)…`, `$ command`) pulses through bright colours; once the tool ends
  (`onToolRun`) the label goes. With no tool running the line says a WORD — a gerund
  picked at random for each model request (`Pondering…`, `Brewing…`;
  `src/assistant/verbs.ts`, `ui.verbs` replaces the list) — with the same shimmer as
  a tool's label. It is picked when the request goes out (`send`, then `onRound` for
  the next one) and held in state, never in the render, so it never changes within a
  round, and a new round never repeats the last word. The PHASE is the colour:
  magenta while the model thinks — before the first token, while it reasons, between
  tools while it works out the next call — and the assistant's accent only while its
  text arrives; spelling that out as `thinking…`/`writing…` instead would have
  `writing…` read as a promise of text that is not there yet. The stream callbacks are
  closures made when the message was sent, so anything they READ (the tool label
  they clear) is kept in a ref beside the state — reading the state there would see
  its send-time value, and a finished tool's label would stay up for the rest of the turn.
  - **The seconds are the running THING's, not the turn's.** They start again whenever
    the line changes hands: a tool the moment it is called (`onTool`), the model's
    round the moment the tool ends (`segRef`, `beginSegment` in the chat; `t0Ref` still
    times the turn). One timer from the question to the answer sat at `3m 12s` through
    a build, which says nothing about what is happening. The TURN's total, and what it
    cost, stay on the quiet line under the finished answer (`12.4 s · 3.1k tok`), where
    they are read afterwards and distract nobody.
  - **What the turn costs is said** (`3.1k tok`, `tokensBadge`): every round's prompt
    plus its completion as the provider reports them (`onRound`'s `usage`), added up
    for the turn. It is not `ctx N%` beside it — that one is how big the NEXT request
    is, from the last round alone (`usageRef`, the context meter). A provider that
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
- What the footer reads from a plugin (`host.store.<x>`) must be patched
  synchronously when it changes: the host draws its footer BEFORE the plugin's
  component re-renders, so a value assigned during render is one frame stale.
- A tool's ctx is built with `allServices(host.services)`, never `...host.services`:
  host services sit on the PROTOTYPE of the per-plugin services view, and a spread
  copies own properties only. The spread silently gave tools a ctx with no
  `chatLLM`/`config`/`showMessage`, and `background` answered "no LLM service".
- The conversation is a flowtty **`<ScrollList anchor="bottom" rowHeight={1}>`**
  (`ChatMessages` in `src/views/modals.ts`): it takes the rows the column leaves,
  follows new rows until the person scrolls up, and hears PgUp/PgDn and the wheel
  ITSELF — the chat's key handler must not. No heights are added up for the
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
  - The empty conversation is still a `<ScrollBox>`: it holds the invitation, not rows.
  - The **wheel scrolls only while the pointer is over the box**. In a test pass
    coordinates — `backend.wheel('up', 20, 8)`; the default `(0, 0)` is the app title.
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
  do not rebuild the absolute box by hand (there were four copies of it). The one
  exception is the docked chat, a plain box in its panel (see "Where the chat is").
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
  - The caret (`cursor`) is a **UTF-16 index into the value, resting on a grapheme-
    cluster boundary** — flowtty's unit. `value.slice(0, cursor)` works; `Array.from(value)`
    indices do not. Columns are counted in display width, so a wide cluster (an emoji,
    a CJK character) takes two.
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

## Testing

From the host root: `bun run typecheck && bun test ./src ./scripts ./packages` (the
path filter keeps a locally dropped-in plugin's suite out of the host run).
`./packages` is `@flow-assist/remote`'s own suite (the protocol, its codec, `runPlugin`).
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