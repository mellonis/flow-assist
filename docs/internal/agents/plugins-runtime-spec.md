# Plugin host mechanics — spec

> Extracted VERBATIM from AGENTS.md as of master before the
> `chore/agents-md-slim` rewrite. This file is the behavior spec for the area
> it covers: where the trimmed AGENTS.md core and this file ever disagree, the
> core rules win — but treat any difference as a defect in one of the two and
> report it. Covers: late loading and the first frame, a plugin process and
> the MCP server retry, handled keys, the guest rule and the start screen,
> screens and their refusals, and remote plugins end to end.

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
  `afterTurn` (`src/assistant/conversation.ts`) calls `screens.afterTurn(ok)` unless the
  chat left it (`headless`): a turn that ended opens what it held (the
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
- **A screen is its session's: two refusals by whose work asks**
  (`src/runtime/background-work.ts`, two `AsyncLocalStorage`s, each carried through
  every await of the work — a plugin's tool calling `host.open` included, which has no
  ctx of the chat's):
  - **background work opens nothing** — a background task's conversation runs its turn
    under `asBackgroundWork` (`Conversation.startChild`); `screens.open` answers `Not
    opened: screens are not opened from background work.`, `ui_open` throws `ui_open:
    screens are not opened from background work — ask in the chat.`;
  - **a session not on screen opens nothing** — every `Conversation.send` runs its turn
    as its own work (`asConversationWork(this, …)`; `workOwner()` hands back a
    `WorkOwner`, `{ attached, kind }`, so the runtime layer imports no `Conversation`),
    and `inUnattachedWork()` is "the owner is a `session` and no view draws it NOW" —
    asked at the call, since a turn may be left or taken back midway: `screens.open`
    answers `Not opened: this session is not on screen — the person is in another
    one.`, `ui_open` throws `ui_open: this session is not on screen — the person is in
    another one; ask when they come back.` (after its "no screen here" check, so a run
    with no app still reads that). The background check comes first, so a task reads
    its own text; this is the ONE rule that asks "attached right now" — the others
    about a session left read `headless` (a bare conversation, or one `/clear` just
    closed, has no port either).

  Every `send` sets its own owner, a task's too, and none reads the one it was called
  in: a queued task is started from the `done()` of the run that freed its slot
  (`ChildSlots.admit`), in that run's context. A `session`'s `send` also runs outside
  the background mark (`asForegroundWork`): a follow-up turn started by a grandchild's
  result is started from inside a task's run; a task's own turn stays marked.
- **A deferred open records whose work deferred it** (`workOwner()` at the defer;
  undefined for a plugin's own key). `screens.dropFor(owner)` removes that owner's
  entries, each with `[screens] <key> not opened — its session was left` in the log;
  the registry's `retire` calls it first, for a session parked and one kept alike —
  `screens.settle` would otherwise open it over the next session, which is idle. A
  left session's `afterTurn` flushes nothing (above); `/clear` closes the conversation,
  port and all, before its stopped turn's `afterTurn(false)`, which still drops what
  that turn deferred — why the gate reads `headless`, not `attached`.
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
  open now`). A refusal throws (the model reads an error); background work, a run
  with no `services.screens` and a session not on screen refuse too.

`src/__tests__/screens.e2e.test.ts` holds it; whose work asks is held by
`src/runtime/__tests__/work-owner.test.ts` and the `leave-busy` rig and e2e files. `HOST_API` stays: `screens` is an optional
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

