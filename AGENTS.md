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
- Bun **1.3.x** — `bun run`, `bun test`, `bun build --compile` (the TUI runs as a Bun-executable via `bun src/cli.ts`; `--compile` is retired — it produces a two-React-instance bundle).
- React 19 + `@flowtty/react` / `@flowtty/tty-backend`, zod 4.

## Repos

- `flow-assist` — this host. Plugin sources live under `plugins-available/`, each a package with its own dependencies; the host never imports a plugin or a plugin's dependency.

## Layout

```
flow-assist/
├── package.json               # host; workspace root for plugins-available/*
├── plugins-available/
│   ├── gitlab/                # glab_api tool group (no UI)
│   └── repo/                  # list_dir/read_file/search/git_* tool group (no UI)
└── plugins-enabled/           # symlinks → plugins-available/*, gitignored
```

A plugin lives in `plugins-available/<name>/`, ships a `manifest.json` (name,
version, description, `deps`, `surfaces`, `tools`), and is enabled by symlinking
it into `plugins-enabled/`. At load time the host qualifies every registry key
with the plugin namespace (`<plugin>:<view>`, `<plugin>:<tool>`), while display
labels keep short names.

## Plugin contract (`shape`)

A plugin module default-exports `build<Name>Plugin({ renders, config, make })`.
`make(name, shape)` injects `config.plugins.<name>` and qualified keys. The
returned `shape` has optional: `commands`, `keys`, `keyActions`, `views`,
`surface`, `modals`, `colors`, `configSchema`, `components`, `tools`, `services`,
`aiTools`, `keycaps(ft)`, `setup(ft)`. `components[slot] = (ft) => Component`;
`services` expose host services through `ft.services` — the host wins on every
key it owns, a plugin's same-named key never clobbers it. `setup(ft)` runs once,
before any of the plugin's components mount (it is where a plugin seeds its store). Tool groups are delivered by plugins — there is
**no** `tools-available/` → `tools-enabled/` repository; `ai.disabledTools` is
the blacklist.

## What the model can do (the `core` tool group)

`memory`, `config_schema`, `datetime`, `remind`, `background`, `todo`, `ask_user`,
`open_url`, plus `host:plugins_list`. Three rules hold this set together:

- **Config is the person's.** The model gets `config_schema` — keys, types,
  set/unset, active defaults, effective key bindings, each plugin's flags — and
  **no values and no write**. Config is the model's own leash (`disabledTools`,
  `baseUrl`, `tokenEnv`, plugin roots) and the assistant reads other people's text,
  so even a y/n-confirmed write is one prompt injection plus one tired keypress
  away. The model answers with the `config set <key> <value>` command to run.
- **The log is the person's too.** No log tool; `/log [N]` shares the tail of the
  host log as the person's own message.
- **`ask_user`** (1–4 questions, 2–4 options each, optional multi-select, an
  "Other…" row the UI always adds) is a pure state machine in
  `src/assistant/ask.ts`; the chat owns only the pause and the render. A
  background task is never given the hook — a question popping up would seize the
  keyboard mid-sentence — so there the tool answers "nobody to ask".

A qualified tool name (`plugin:tool`) is translated to a provider-safe wire name
(`plugin__tool`) in `src/assistant/agent.ts` and nowhere else: providers validate
names against `^[a-zA-Z0-9_-]{1,128}$`.

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
- **No "magic" flags**: glab's `--field` reads `@path` from disk; strings go through
  `--raw-field`. Check the same before wrapping any other CLI (`gh api -F` is alike —
  this applies to the planned `github` plugin).

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
  `layoutMarkdown`. The host adds nothing but the soft `▍` heading marker; a gap in
  that layout is fixed in flowtty, not papered over here.
- **⏎** sends; while an answer is coming it **queues** instead (sent in order when
  the turn ends). **Esc**: clear the field → take the last queued message back →
  stop the answer → arm/close. **Alt+⏎** (drawn `⌥⏎` on macOS) is a newline (`NEWLINE_KEY` in
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
      `A chat` hint do this. Host-side code uses `bindingGlyph(keys[action])`.
    - the key is fixed (the chat's own Enter / Esc / Tab) → `keyGlyph(…)`, as the
      `CAP` table in `src/views/modals.ts` does.
    A bundled plugin that still spells caps by hand in its `keycaps(ft)` (acme-tracker)
    shows the default key after a remap — that is the bug this rule prevents.
- **↑/↓** walk the prompt history, only while the field is empty or still shows a
  history entry untouched. The **wheel** and **PgUp/PgDn** scroll. **^r** unfolds
  thinking, notes and the tool calls behind the one-line `▸ N tools` summary.
- A **paste** is one key, `{ name: 'paste', text }` (flowtty's bracketed paste): it
  goes in at the caret with its line breaks kept. It is never decoded into keys, so
  a pasted newline does not send and pasted letters fire no binding — any new
  key handler must keep it that way (match on `key.name`, never on characters of
  pasted text).
- The wheel is reported because the TTY backend is opened with `{ mouse }`, on
  unless `ui.mouse` is `false`. The cost is the terminal's own drag-to-select,
  which then needs Shift (Option on macOS); the active default in `config_schema`
  says so, because "why can't I select text" is asked of the assistant.
- A `/command` **completes inline**, like a shell's autosuggestion: the part not
  typed yet is drawn after the caret in the dimmed accent colour, the other
  candidates follow as `⇥ a · b`, **Tab** takes the offer and then walks the rest.
  Only with the caret at the end of a one-line `/word`. In the field, dim means
  "offered, not yours yet" — the person's own text is never dimmed, on either side
  of the caret.
- A **background result** (the `background` tool's nested run finishing) is SHOWN as
  soon as no turn is being written — a half-typed draft does not hold it back. It
  does not open the chat and does not spend a model turn: it joins the model's
  history and is read with the person's next message. Landing while the chat is
  closed, it is counted as unread; the host footer shows `A chat · ◆ N new` through
  the chat plugin's `keycaps`, and opening the chat clears the count.
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
    row's index as its line. A row that wraps would break it.
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

`flow-assist` with subcommands:

- (default) `interactive` — the TUI.
- `config get|set|unset|help` — host config.
- `plugins ls|install|remove|update` — manage enabled plugins.
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
  a tool call, or a `hold` that freezes the stream until `release()`. End-to-end
  tests drive the app through it; assert on the frame AND on cell styles
  (`backend.lastBuffer`).
- `bun scripts/ui-frames.ts [--size WxH] [--color|--styles] [scenario…]` — the same
  rig for eyes: frames at named checkpoints, no network. Look at a display change
  before and after with it.
- `bun scripts/eval-tool-use.ts` — a behavioural eval against a LIVE model (costs
  money; `--fake` checks the harness): rates by turn, false claims, `--history
  display|api` as an A/B, `--show` prints the dialogue.
- A fake for a validating route must reject what the real one rejects; prove a
  new test fails on the bug before trusting it.

## Git

- **Never** append a `Co-Authored-By: Claude` trailer (or any Claude
  `Co-Authored-By`) to a commit message.
- Branch from `master`; the default branch here is `master`.