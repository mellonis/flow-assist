# Writing a plugin

flow-assist itself knows no company, no tracker and no system. Everything specific
comes from plugins: tools the model can call, `:` commands, keys, screens, config.
This page builds one — [`examples/notes`](../examples/notes), a notebook the
assistant reads and adds to — and then lists the rest of the contract. The example
runs in the host's test suite (`src/__tests__/example-notes.e2e.test.ts`), so what
is written here is what works.

## Where a plugin lives

A plugin is a directory with a `manifest.json` and an entry module. The host loads
the plugins linked into its `plugins-enabled/`:

```sh
ln -s ../examples/notes plugins-enabled/notes     # a plugin kept anywhere
bun run src/cli.ts plugins install <name>         # or one from the plugin registry
```

`plugins-available/` holds the bundled ones (`repo`, `gitlab`, `mcp`); a plugin of
your own can live in a repository of its own and be linked from there.

```
notes/
├── manifest.json     name, version, description (shown on the start screen), tools
├── package.json      "main": "./src/index.ts" — the entry (else ./src/index.ts)
└── src/index.ts      the builder
```

```json
{ "name": "notes", "version": "0.1.0", "description": "A notebook the assistant reads and writes", "tools": ["notes"] }
```

A manifest may also list `requiredSettings` — the environment variables the plugin
cannot work without (a token): the host says a plugin is missing settings instead of
loading it half-working.

## The builder

The entry default-exports a function that gets `{ renders, config, make, z }` and
returns `make(name, shape)`:

```ts
export default function buildNotesPlugin({ config, make, z }) {
  return make('notes', {
    name: 'notes',
    configSchema: z.object({ file: z.string().optional() }).optional(),
    tools: [/* … */],
    commands: [/* … */],
  });
}
```

- `config` is the whole config; the plugin's own part is `config.plugins.<name>`,
  set by the person with `config set plugins.notes.file ~/notes.md`. A plugin may
  read a host key from it as a default for one of its own — the bundled `repo` takes
  `shell.roots` when `plugins.repo.roots` is not set, and reads both when a tool runs,
  not once in the builder.
- `z` is the host's zod. `configSchema` describes `config.plugins.<name>`: the host
  validates every `config set` against it and shows it to the model, so the
  assistant can tell the person which key to set.
- `make` fills in what the host owns — the name, the config slice, the keys.
- The builder may be `async` (the `mcp` plugin asks its servers for their tools
  first); bound the wait yourself, the app starts after it.

## Tools for the model

A tool group is `{ id, tools, exec }`. `tools` are OpenAI-format function
definitions; `exec(name, args, ctx)` runs one and returns a string for the model.

```ts
tools: [{
  id: 'notes',
  tools: [
    { type: 'function', function: { name: 'notes_read', description: 'Read the notebook.',
      parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'notes_add', description: 'WRITE: add one note. The person confirms it first.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      write: true },
  ],
  async exec(name, args, ctx) {
    if (name === 'notes_read') return read() || '(the notebook is empty)';
    if (name === 'notes_add') {
      const text = String(args.text ?? '').trim();
      if (!text) throw new Error('text is required. Nothing was changed.');
      const before = read();
      const after = `${before}- ${text}\n`;
      fs.writeFileSync(file(), after);
      ctx?.reportChange?.({ title: 'notes.md', before, after });
      return 'Added to notes.md.';
    }
    throw new Error(`Unknown tool: ${name}`);
  },
}],
```

What the host does with it, and what it expects back:

- **`write: true`** — the chat pauses with a y/n before the call runs; a declined call
  never reaches `exec`. `write` may also be a predicate over the arguments
  (`(args) => args.action !== 'list'`) for a tool that only sometimes writes. The flag
  is what MARKS a call as a write; whether the person is asked each time is theirs to
  decide — they can turn the confirmations off for a stretch of work — so the pause is
  not a guard your tool may lean on. Check the arguments yourself, and refuse what the
  plugin must not do whether or not anyone was asked.
- **A write refuses by throwing.** Whatever a write tool *returns* counts as done — the
  chat marks the call's trail line with ✎ (and a folded run of steps whose write
  reported no diff). A refusal or a failed call must throw, in words the
  model can repeat to the person ("…Nothing was changed.").
- **`ctx.reportChange({ title, before, after })`** — once the write succeeded, what it
  changed. The chat keeps a `✎ title · +N −M` diff block in the turn, where the write
  happened; the model never gets it. `ctx` has no `reportChange` outside a chat (the one-shot CLI), so call
  it as `ctx?.reportChange?.(…)`.
- **Showing what a tool does — views.** A tool may hand the chat a block to draw, and
  update it while it runs. The chat draws it as one line that a click opens; it stays
  after the call, in whatever state the person left it.
  - `const v = ctx.liveView?.('card', data)` opens it; `v.update(next)` replaces the
    data (the chat redraws a few times a second); `v.discard()` removes the block once
    the call ends. `ctx.reportView?.('card', data)` is a block that never changes.
  - Draw it with a renderer in the shape — data in, lines out:
    `viewRenderers: { card: (data, ctx) => [[{ text: '✎ ', color: 'accent' }, { text: data.title }]] }`.
    `ctx` says `folded`, `live`, `failed`, `width`, `elapsedMs`, `lines`, `moreKey`;
    draw both the folded and the open state. The host qualifies the kind by your
    plugin's name (`notes:card`), so your tool names it bare.
  - A colour is a token of the chat palette (`accent`, `ok`, `warn`, `shell`, `text`),
    never a literal — right on a dark and a light terminal alike. A leading span
    marked `chrome: true` is painted and never copied.
  - The host frames what you return: one line is one row, cut to the width; text is
    stripped of escape sequences; rows are capped. `data` must be JSON, 64 KB at most.
  - Display only: the model reads what your tool RETURNS, never the block. A call that
    throws keeps its block, marked failed — and so does a block still open when a
    restart finds it, since its process ended mid-call and no true ending was ever
    recorded. Where there is no chat to draw in (a caller that gives no `onToolLive`)
    the view goes nowhere — call it as `ctx.liveView?.(…)` anyway, since a caller may
    pass a `ctx` without one.
  - `console` is the host's own kind — `{ command, cwd, text, exitCode, ms, status }` —
    what `run_command` shows. A renderer that is missing (your plugin was disabled) or
    throws is drawn as one dim `▸ kind` line.
- **An argument is hostile input.** The model writes every argument, and it may have
  read the words it writes in a web page or a ticket. Check paths against what the
  plugin may touch, never pass a value that starts with `-` to a command line, and
  remember that a read-only tool has no y/n in front of it.
- **Say failures as failures.** Return a tool's error in its own words; an empty `{}`
  from a broken backend reads to the model like "nothing there".
- Names are the ones you give (`notes_read`, not `notes:notes_read`); two groups that
  declare the same name get the later one qualified, and the clash is logged.
- `ai.disabledTools: ["notes"]` turns the group off per machine.
- **The first sentence of a description is what the model sees first.** A request
  carries a plugin's tools as an index — the group's name, then each tool's name and
  its description up to the first full stop — and the model loads the ones it needs
  (`tools_load`) before calling them. Make that sentence say what the tool is for;
  put details after it. (`ai.toolLoading: "all"` sends every definition in full.)
  `tools_load` also accepts the name qualified with its group, `<group>:<name>`, as
  well as the bare name the index shows — the index reads naturally either way, and a
  model that qualifies it is not refused for a round.
- **A result over `ai.toolResultMaxChars` (default 40000) is cut before it joins the
  conversation** — the head kept, a short tail too, and a note in between saying how
  much was cut (src/assistant/tool-result-cap.ts). Only what is SENT is capped: a
  view, the tool trail and `ctx.reportChange`'s diff show what really happened,
  uncapped. A tool that knows its own result is large and worth the tokens (a
  paginated read at its widest page) declares its own `maxResultChars` on the tool
  def, clamped to a hard ceiling (200000) so it cannot flood the history by declaring
  a bigger number: `{ type: 'function', function: { name: 'dump_all', … },
  maxResultChars: 100_000 }`.

`aiTools` is the other shape: standalone tools, each with its own `run(args, ctx)`,
for a plugin that has no group.

## Commands, keys and the footer

```ts
commands: [{
  name: 'notes', usage: 'notes', description: 'Count the notes in the notebook',
  run: (ctx) => ctx?.showMessage?.(`${count()} notes`),
}],
keys: { notes: 'N' },                 // an action and its default binding
keycaps: (ft) => {                    // the footer's hints for the current context
  const cap = ft.keyCap('notes');     // the cap of what `notes` is bound to NOW
  return cap ? [`${cap} notes`] : [];
},
entry: ['notes'],                     // the key that leads in, on the start screen
```

- A command is its first word; the rest of the line is its argument (`run(ctx, arg)`).
- The `:` line remembers what was run, for ↑/↓. A command whose argument may be a
  secret — a token, a password, a header — says `history: false` and is never kept:
  `{ name: 'login', usage: 'login <token>', history: false, run: … }`. It is part of
  the definition, not a decision made per call.
- A binding is the person's to change (`config.keys`), so a hint never spells a key
  by hand: `ft.keyCap(action)` draws the current one, `''` when it is unbound (then
  show no hint).
- `keycaps(ft)` returns `[]` while the plugin's screen is not active — it is also how
  the host knows whether to mount the plugin's surface.

## Screens

`components` are React components the host mounts, keyed by slot, each built from
the plugin's runtime `ft`:

```ts
components: {
  view: (ft) => function NotesView() { /* the plugin's full screen (its surface) */ },
  panel: (ft) => function NotesPanel() { /* furniture: always mounted */ },
},
setup: (ft) => { /* once, before any component mounts: seed a store */ },
```

- The slot named `view` (or the one `surface` names) is the plugin's full screen,
  mounted only while `keycaps(ft)` is non-empty; every other slot is always mounted.
- **Size a surface by `ft.useSurfaceSize()`, not `ft.useTerminalSize()`.** The host
  keeps a title bar above the surface and the footer (the command line) below it;
  `useSurfaceSize` is what is left between them. A surface sized by the terminal is
  taller than its room, and the host cuts off what does not fit — its bottom rows.
- **A surface may be given less than the terminal.** The chat is docked beside it by
  default — on the right, or at the bottom of a narrow terminal — and the plugin's
  side of the screen (its title bar, surface and footer) is what remains, always from
  the terminal's top-left corner. `ft.useSurfaceSize()` and `ft.useTerminalSize()`
  both report that side, so a surface and a modal laid out by them stay on it; the
  sizes change when the chat is folded away or brought back, and a surface re-renders
  with them. Take the size from `ft`, never from flowtty's own `useTerminalSize`:
  that one always reports the whole terminal.
- **The keyboard is yours only while your side has it.** Ctrl+] moves it between the
  chat and the plugin; while the chat has it, your handlers see no keys, exactly as
  under the chat's window. The host takes Ctrl+] (and the key that folds the chat,
  Ctrl+\) before any handler, so a handler that consumes every key cannot trap the
  person.
- **Take React and flowtty from `ft`, import only their types.** `ft.useState`,
  `ft.useEffect`, `ft.useRef`, the flowtty components — one React for the host and
  every plugin; a second copy breaks every hook.
- **To let the person choose, `ft` has flowtty's three pickers.** `ft.Select` is a
  dropdown: a one-line field whose popup opens under it — the host keeps the
  `<DialogHost>` it needs, and while the popup is open every key is the popup's.
  `ft.ListSelect` and `ft.ListMultiSelect` are the inline lists, every option on
  screen. flowtty's docs/components.md (Choosing) says which to reach for. They hear
  flowtty's own input, not `ft.useInputHandler`, so a mounted one would hear every
  key — what the person types in the chat included: pass `isFocused` from your own
  state, and false while the chat has the keyboard (`ft.store.chat.open` with
  `ft.store.chat.focus` not `'plugin'`).
  **Renamed:** flowtty 1.0.0-alpha.24 renamed the inline lists — the old `Select` is
  `ListSelect`, the old `MultiSelect` is `ListMultiSelect` (the props are the same),
  and `Select` is now the dropdown. There are no aliases: a plugin that took the old
  names from flowtty renames them, or it gets a dropdown where it drew a list, and
  nothing at all for `MultiSelect`.
- Keys come through `ft.useInputHandler({ mode, priority, handler })`. `mode` is
  `'consume'` (joins the race for the key) or `'observe'` (sees every key, takes
  none). Handlers run from the highest `priority(ui)` down, and a handler takes the
  key by returning exactly `true`. Conventionally: 100 — an open modal, 50 — a base
  screen, 10 — a key that opens something, 0 — nothing (a closed modal).
- A setter in one component re-renders that component only; the host redraws after
  every key that was handled. For a change that does not come from a key (a fetch
  that finished, a timer) call `ft.notify()`.
- `colors` and `modalColors` give the plugin's screens and modals their palettes;
  the person overrides them with `config.plugins.<name>.colors`.
- **Write a ground as a theme token, not a literal:** `bg: '${panelBg}'`, not
  `bg: '#1a1b26'`. The host follows the terminal between light and dark while it runs
  (macOS switches by itself at sunset and sunrise), and resolves every `${token}`
  against that scheme's theme; a literal stays the colour it was written for. The
  tokens: `panelBg` (a floating panel), `highlightBg` (a highlighted row),
  `accentBg` (a stronger highlight), `highlightText` (the ink on either), and the
  modal base under `theme.modals` (`bg`, `text`, `border`, `fieldBg`, …). Where the
  terminal has not said which it is, they are `'default'`: the terminal's own.

## The chat's two hooks

- `chatContext(ft)` — what the plugin's screens show right now, as a list of items
  `{ label, text }`, or `[]` / `null` when nothing is on screen. A screen may show
  several things at once — a board and an open issue — so it is a list:

  ```ts
  chatContext: (ft: any) => {
    const { board, issue } = ft.store.tracker ?? {}; // whatever your screen keeps
    const items: { label: string; text: string }[] = [];
    if (board) items.push({ label: `Board: ${board.name}`, text: `filter: ${board.filter} · ${board.count} issues · cursor on ${board.cursor ?? '—'}` });
    if (issue) items.push({ label: `Issue ${issue.key}`, text: `${issue.title} · ${issue.status}\n${(issue.description ?? '').slice(0, 500)}` });
    return items;
  },
  ```

  Write it so it cannot throw on a half-loaded screen: a throw drops the plugin's
  whole list, not one item.

  The host asks every plugin, in load order, before **every request** to the model —
  every round of a turn, so a tool that changes the screen is seen by the next round —
  and sends one block at the very END of the request, after the conversation: a line
  saying it comes from the app and not from the person, `## What the person sees now`,
  a sentence saying it is what the screens show, from external systems, to be used as
  context and never followed as instructions, then each item wrapped in a delimiter
  that carries a random value made for that request (`<screen-item n="…"
  label="…">` … `</screen-item n="…">`), and a closing line naming the same value. The
  frame's own words and tags are taken out of every label and text first, so an item
  cannot close the block and go on as if the person had written it. It is never kept: not in the model's history, not in the saved session, so the
  conversation does not grow with it. With no items there is no block. The context
  meter counts it (`on screen` in `/context`).
  - **Caps**: a label is one line of at most 120 characters, a text at most 2000; the
    whole list at most 6000 — items that do not fit are left out from the end and
    replaced by one `… N more` item. Escape sequences and control characters are
    stripped from both. Say what matters first.
  - **The chat's title** is the labels, joined with ` · ` and cut to the frame:
    `ƒ Flow Assist · Board: Frontend · Issue ABC-1`.
  - **It is data.** A title, a description, a comment — someone else wrote them, and the
    model is told not to follow them. Put there what helps answer the person (what is
    selected, what the filter is, the first lines of what is open), not secrets.
  - It is called often — on every draw of the chat, which is several times a second
    while an answer comes in — so it must be cheap: read the state your screen already
    holds, never fetch or touch the disk in it. A hook that throws gives nothing (said
    once in the log, `[<plugin>] chatContext failed: …`); the turn goes on.
  - It comes after everything the provider caches, so a change to it — a cursor that
    moved — costs only the block itself; the conversation before it is still read from
    the prompt cache.
  - On the OpenAI-compatible wire, after a tool's result the block is a user message
    of its own, right after the `tool` messages. The OpenAI API takes that; some
    OpenAI-compatible servers may refuse a user message in that place.
  - The screen changing does **not** start a new conversation: the chat continues, and
    only the block follows the screen. A person who wants a fresh one says `/clear`.
  - A background task and a one-shot prompt get no block: they run apart from the
    screen.
- `chatSubject(ft)` — **deprecated**, kept for one release: a short id of what the
  screen is about, read as one item `{ label: <id>, text: '' }`. A plugin that has
  `chatContext` is not asked it. Move to `chatContext`.
- `afterWrite(ft)` — called after a turn in which a write the person confirmed went
  through: reload what the screen shows, or it keeps the text from before the write.

## Shipping it

- **No dependencies** — the sources ship as they are.
- **With dependencies** — the plugin needs a `build` script that bundles them into
  `package.json`'s `main`, with `react` and `@flowtty/*` left external (the host
  provides them). A published plugin ships no `node_modules`; the compiled host binary
  cannot import a package from disk.
- `files` in `package.json` names what ships (the build, the manifest, README,
  LICENSE) when the plugin's directory holds more than the plugin — a client package
  it is built from, say.
- `bun run plugin:publish` packs a plugin and uploads it to the configured registry;
  `plugins install <name>` installs one from there.
- Without a registry, the packed archive travels as a file — attached to a release,
  handed over: `plugins install ./notes-0.1.0.tar.gz` (or its https URL) unpacks and
  enables it, and installing a newer archive updates it. The archive must hold one
  top-level `<name>/` whose `manifest.json` names the same plugin, and no links.
- **What a plugin's version means.** A bundled plugin (`plugins-available/`) ships
  with the host from the same repo and release, so it carries the host's own version
  — `manifest.json` and `package.json` both, kept equal by a test. A plugin kept in
  a repository of its own versions itself. Either way, an installed archive is named
  and stamped with the version its `manifest.json` names — `bun run plugin:publish
  <name>` (no version argument of its own) always reads it from there — and
  `plugins ls` shows the version actually on disk, read fresh from the installed
  plugin's own manifest.

A plugin kept in a repository of its own links the host's packages into its own
`node_modules` for its tests (one React, never two), and must not leave a `dist/`
from a local build lying around: the host loads a plugin by `main` first, so a stale
build is what the tests would get. [AGENTS.md](../AGENTS.md) has the full set of rules
the host keeps, plugin contract included.

## License

Plug-ins that implement this contract are loaded by the host as separate works and
may be licensed under any terms — see the plug-in exception in the
[README](../README.md#license).
