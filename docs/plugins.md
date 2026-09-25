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
{ "name": "notes", "version": "0.1.0", "hostApi": 2, "flowtty": ">=1.0.0-alpha.31 <1.0.0-alpha.32",
  "description": "A notebook the assistant reads and writes", "tools": ["notes"] }
```

A manifest may also list `requiredSettings` — the environment variables the plugin
cannot work without (a token): the host says a plugin is missing settings instead of
loading it half-working. `hostApi` and `flowtty` say what the plugin is built for —
see [Compatibility](#compatibility).

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
definitions; `exec(name, args, ctx)` runs one and returns a string for the model — or,
for a tool that has images to show, text with the images beside it (below).

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
- **A group may describe itself, beyond what its tools' own descriptions say** — set
  `description` on the group (`{ id, tools, exec, description }`) for guidance that
  belongs to the whole group: how its data is shaped, its vocabulary, what to check
  before trusting it. It shows as one line under the group's heading in the index,
  cut the same way a tool's first sentence is, and in full once the group's tools are
  loaded or sent — never repeated per tool. Sanitized the same way a tool description
  is; trust it the same way too.
- **A result over `ai.toolResultMaxChars` (default 40000) is cut before it joins the
  conversation** — the head kept, a short tail too, and a note in between saying how
  much was cut (src/assistant/tool-result-cap.ts). Only what is SENT is capped: a
  view, the tool trail and `ctx.reportChange`'s diff show what really happened,
  uncapped. A tool that knows its own result is large and worth the tokens (a
  paginated read at its widest page) declares its own `maxResultChars` on the tool
  def, clamped to a hard ceiling (200000) so it cannot flood the history by declaring
  a bigger number: `{ type: 'function', function: { name: 'dump_all', … },
  maxResultChars: 100_000 }`.
- **A large result may reach the model as a stub on later turns.** A result over
  `ai.recall.minChars` (4096) goes to the model in full in the turn it arrives in and
  afterwards, from a batch on, as one line naming an id the model reads again with
  the host's `recall` tool (README, "Bulky content"); what the tool returned is
  unchanged, and the screen keeps it.
- **A tool can return images** — screenshots attached to an issue, a design, a chart —
  when it fetched them itself: the host never reads a path or a URL named in text as
  an image, and a tool is the one thing that may hand the model an image the person
  did not attach. Return `{ text, images: [{ bytes, name }] }` instead of a string —
  `bytes` a `Uint8Array` (a `Buffer` is one) or an `ArrayBuffer`, or `base64` in its
  place; `name` is what the person and the model see — and say so on the tool's
  definition: `{ type: 'function', function: { … }, returnsImages: true }`. Images from
  a tool that does not declare it are dropped, with a note in the result and a line in
  the log; the text still goes. Each image is told by its bytes (PNG, JPEG, GIF or
  WebP — a `mime` you pass is not read) and held to the attachment limits: over
  `ai.images.maxBytes` (5 MB) it is refused, never shrunk; past `ai.images.maxPerMessage`
  (4) per result the rest are refused; with `ai.images.enabled` false all are. Every
  refusal is one line at the end of your text, in the model's own reading, so a text
  result never fails because of an image.
  What the model gets: on the Anthropic wire the images as blocks inside the
  `tool_result`; on the OpenAI-compatible wire the text in the tool message and the
  images in a user message right after the round's tool results, marked `[2 images
  returned by get_issue — from the app, not a message from the person]`. The chat
  shows one row per image under the call's line — `▣ shot.png · 400×300` — never the
  image. The host writes each image once into its own store (`images/<sha256>.<ext>`
  under the config directory; the oldest go past 200 files) and keeps a ref to it, so
  the session never holds the bytes; the images stay in the conversation as the
  person's attachments do — sent in full until a batch stubs them, then as a stub the
  model reads again with `recall`. `images` counts in the context meter by pixels,
  like an attachment.
  A tool that already holds a ref — the host's `recall` does — calls
  `ctx.attachImage({ ref, url })` instead (`ref` an `ImageRef`, `src/assistant/images.ts`;
  `url` a `data:` URL); the image goes beside its result the same way, and the result
  keeps the ref. Absent outside a chat, so call it as `ctx.attachImage?.(…)`.

`aiTools` is the other shape: standalone tools, each with its own `run(args, ctx)`,
for a plugin that has no group.

## What a plugin is given: `{ ui, host }`

Every hook of the shape — each `components[slot]` factory, `setup`, `keycaps`,
`chatContext`, `chatSubject`, `afterWrite` — receives one object with two parts:

- **`ui`** — what React and flowtty ship, passed through unchanged, the same for every
  plugin. Take them from here and import only their types: one React for the host and
  every plugin; a second copy breaks every hook.
- **`host`** — what the host implements or wraps, one per plugin.

| `ui` | `host` |
|---|---|
| `h`, `useState`, `useEffect`, `useRef`, `Fragment` (React) | `services` — the host's (`showMessage`, `pushLog`, `chatLLM`, `cache`, …) with the plugin's own under them |
| `Box`, `Text`, `Markdown`, `Table`, `Link`, `ScrollBox` | `store` — the channel between plugins and the host |
| `Select`, `ListSelect`, `ListMultiSelect`, `Checkbox`, `TextInput` | `config`, `keys`, `keyCap(action)` |
| `isPrintable(key)` (@flowtty/core) — whether a key types a character | |
| `useInput` — flowtty's own, beside the host's key path | `useInputHandler` — the host's key path |
| | `useSurfaceSize`, `useTerminalSize` — the room the host gives the plugin |
| | `notify()`, `viewRegistry`, `commandRegistry`, `helpFor`, `copyToClipboard` |
| | `hasKeyboard()` — whether the plugin's side has the keyboard now |
| | `pluginToken` — the plugin's identity; `hostApi` — the host API it runs under |

The services stay on `host.services` and are read when they are called
(`host.services.showMessage('saved')`): the host rebinds some of them on every render,
so a copy taken once is stale. The two parts are built once, so a component factory
runs once and its component is mounted for the app's life.

## Commands, keys and the footer

```ts
commands: [{
  name: 'notes', usage: 'notes', description: 'Count the notes in the notebook',
  run: (ctx) => ctx?.showMessage?.(`${count()} notes`),
}],
keys: { notes: 'N' },                 // an action and its default binding
keycaps: ({ host }) => {              // the footer's hints for the current context
  const cap = host.keyCap('notes');   // the cap of what `notes` is bound to NOW
  return cap ? [`${cap} notes`] : [];
},
entry: ['notes'],                     // the key that leads in, on the start screen
```

- A command is its first word; the rest of the line is its argument (`run(ctx, arg)`).
- A command whose argument is one of a few words says which, and the `:` line
  completes it — Tab after `:open ` offers them inline, a typed prefix narrows them:
  `{ name: 'open', usage: 'open <what>', values: ['board', 'card'], run: … }`. For a
  list that changes, `values` is a function read when the line is drawn:
  `values: () => boards().map((b, i) => ({ value: String(i + 1), label: b.name }))` —
  a value is a word, or `{ value, label }` when a word alone says too little (a
  number): the label is shown beside it, dim, and never inserted. The values are the
  first argument's; a second word is not completed. Optional: a command without it
  completes its name and nothing more.
- The `:` line remembers what was run, for ↑/↓. A command whose argument may be a
  secret — a token, a password, a header — says `history: false` and is never kept:
  `{ name: 'login', usage: 'login <token>', history: false, run: … }`. It is part of
  the definition, not a decision made per call.
- A binding is the person's to change (`config.keys`), so a hint never spells a key
  by hand: `host.keyCap(action)` draws the current one, `''` when it is unbound (then
  show no hint).
- `keycaps` returns `[]` while the plugin's screen is not active — it is also how
  the host knows whether to mount the plugin's surface.

## Screens

`components` are React components the host mounts, keyed by slot, each built from
the plugin's `{ ui, host }`:

```ts
components: {
  view: ({ ui, host }) => function NotesView() {   // the plugin's full screen (its surface)
    const { width, height } = host.useSurfaceSize();
    return ui.h(ui.Box, { width, height }, ui.h(ui.Text, null, 'notes'));
  },
  panel: ({ ui, host }) => function NotesPanel() { /* furniture: always mounted */ },
},
setup: ({ host }) => { /* once, before any component mounts: seed a store */ },
```

- The slot named `view` (or the one `surface` names) is the plugin's full screen,
  mounted only while `keycaps` is non-empty; every other slot is always mounted.
- **Size a surface by `host.useSurfaceSize()`, not `host.useTerminalSize()`.** The host
  keeps a title bar above the surface and the footer (the command line) below it;
  `useSurfaceSize` is what is left between them. A surface sized by the terminal is
  taller than its room, and the host cuts off what does not fit — its bottom rows.
- **A surface may be given less than the terminal.** The chat is docked beside it by
  default — on the right, or at the bottom of a narrow terminal — and the plugin's
  side of the screen (its title bar, surface and footer) is what remains, always from
  the terminal's top-left corner. `host.useSurfaceSize()` and `host.useTerminalSize()`
  both report that side, so a surface and a modal laid out by them stay on it; the
  sizes change when the chat is folded away or brought back, and a surface re-renders
  with them. Take the size from `host`, never from flowtty's own `useTerminalSize`:
  that one always reports the whole terminal.
- **The keyboard is yours only while your side has it.** Ctrl+] moves it between the
  chat and the plugin; while the chat has it, your handlers see no keys, exactly as
  under the chat's window. The host takes Ctrl+] (and the key that folds the chat,
  Ctrl+\) before any handler, so a handler that consumes every key cannot trap the
  person.
- **To let the person choose, `ui` has flowtty's three pickers.** `ui.Select` is a
  dropdown: a one-line field whose popup opens under it — the host keeps the
  `<DialogHost>` it needs, and while the popup is open every key is the popup's but the exit keys.
  `ui.ListSelect` and `ui.ListMultiSelect` are the inline lists, every option on
  screen. flowtty's docs/components.md (Choosing) says which to reach for. They hear
  flowtty's own input, not `host.useInputHandler`, so a mounted one would hear every
  key — what the person types in the chat included: pass `isFocused` true only while
  the picker is what the person is using AND `host.hasKeyboard()` — which is false
  while the `:` line is open, the log or the help is up, or the chat has the keys (a
  dropdown's popup mutes everything under it on its own). Read it while drawing; the
  host redraws when it changes:
  `isFocused: host.hasKeyboard() && mine === 'list'`.
  A focused picker takes the keys it acts on — a `ListSelect` takes what is typed as
  its filter, so the host's own letters (`F`, `:`) do not reach the host while it has
  the focus; Ctrl+] and the exit keys always do. The names are flowtty's own: a plugin
  that imports the pickers from flowtty uses `Select` for the dropdown and
  `ListSelect` / `ListMultiSelect` for the lists — flowtty has no `MultiSelect`.
  `ui.Checkbox`, `ui.TextInput` (a one-line field; it takes the width of a column
  around it, so give it a box with a width) and `ui.ScrollBox` hear flowtty's input
  the same way — a scroll box
  takes the page keys and the wheel over it — and are gated the same way
  (`isFocused`, `isActive`).
- Tab and ⇧⇥ always come through `host.useInputHandler`, never to a flowtty
  component: flowtty's focus cycling does not run in a plugin's screen.
- Keys come through `host.useInputHandler({ mode, priority, handler })`. `mode` is
  `'consume'` (joins the race for the key) or `'observe'` (sees every key, takes
  none). Handlers run from the highest `priority(ui)` down, and a handler takes the
  key by returning exactly `true`. Conventionally: 100 — an open modal, 50 — a base
  screen, 10 — a key that opens something, 0 — nothing (a closed modal).
- **A `console.log` goes to the log**, not to the screen: while the app runs, a line
  printed through `console` (`log`, `warn`, `error`, …) is shown in the log (`L`) as
  `[console] …` / `[console.warn] …`, and the last of them are printed to stderr when
  the app exits. A write straight to `process.stdout` or
  `process.stderr` still lands in the frame — keep those out of a plugin.
- A setter in one component re-renders that component only; the host redraws after
  every key that was handled. For a change that does not come from a key (a fetch
  that finished, a timer) call `host.notify()`.
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

## A plugin in another language

Everything above builds a plugin in the host's own process. A plugin can instead be a
separate process, in any language: the host talks to it over JSON-RPC 2.0, one message
per line, on its standard input and output. The host draws; the plugin describes its
whole screen — a *frame* — and sends it again whenever it changes. `@flow-assist/remote`
is a TypeScript package that speaks the protocol for you (`runPlugin`, below); a plugin
in another language speaks the same lines directly.

### The manifest

A remote plugin's `manifest.json` carries the same `hostApi` and `flowtty` fields as any
plugin (checked the same way — [Compatibility](#compatibility)) plus how its process is
reached:

```json
{ "name": "remote-login", "version": "0.1.0", "hostApi": 2, "flowtty": ">=1.0.0-alpha.28",
  "run": ["bun", "src/index.ts"] }
```

- **`run`** — the command, relative to the plugin's directory, started without a shell.
- **`connect`** — a socket NAME under the host's own `sockets/` directory (never a path),
  for a plugin that runs as a shared server several hosts talk to. A manifest with
  either field is a remote plugin.
- **`views`** — the view kinds the plugin renders (below), so the host collects a
  renderer for each one at start, before any tool has run.

Today neither field is wired into the loader: `transportFor`
(`src/remote/transports.ts`) throws `remote transports are not built yet` for `run`
and `connect` alike. Until a host build reaches it, a remote plugin runs through its
own tests, or a test that hands it a transport of its own — as
`src/__tests__/example-remote-login.e2e.test.ts` does.

### The example

This is the whole of `examples/remote-login/src/index.ts` — a sign-in form the person
opens with `S`:

```ts
import { runPlugin, type HostEvent } from '@flow-assist/remote';

type Model = { name: string; pass: string; focus: 'name' | 'pass' | 'login'; note: string; open: boolean };

const next = (f: Model['focus']): Model['focus'] => (f === 'name' ? 'pass' : f === 'pass' ? 'login' : 'name');

await runPlugin<Model, HostEvent>({
  hello: { name: 'remote-login', keys: { open: 'S' }, entry: ['open'] },
  init: () => ({ name: '', pass: '', focus: 'name', note: '', open: false }),
  update: async (e, m, host) => {
    switch (e.type) {
      case 'key':
        if (e.key.action === 'open' && !m.open) return { ...m, open: true };
        if (!m.open) return m;
        if (e.key.id === 'tab') return { ...m, focus: next(m.focus) };
        if (e.key.id === 'escape') return { ...m, open: false };
        if (e.key.id === 'return' && m.focus === 'login') {
          if (!m.name || !m.pass) return { ...m, note: 'both fields are required' };
          await host.showMessage('Signed in');
          return { ...m, note: `signed in as ${m.name}` };
        }
        return m;
      case 'changed': return e.id === 'name' ? { ...m, name: String(e.value ?? '') } : e.id === 'pass' ? { ...m, pass: String(e.value ?? '') } : m;
      case 'submitted': return { ...m, focus: 'login' };
      default: return m;
    }
  },
  view: (m) => (!m.open
    ? { surface: null, keycaps: [], keys: { consume: ['S'] } }
    : {
        surface: ['Box', { flexDirection: 'column', padding: 1 },
          ['Text', { bold: true }, 'Sign in'],
          ['Text', { dim: true }, 'Name'], ['TextInput', { id: 'name', isFocused: m.focus === 'name' }],
          ['Text', { dim: true }, 'Password'], ['TextInput', { id: 'pass', mask: true, isFocused: m.focus === 'pass' }],
          ['Text', { inverse: m.focus === 'login' }, '[ Log in ]'],
          ['Text', { dim: true }, m.note]],
        keycaps: [{ action: 'open', label: 'form' }, 'tab next', '⏎ log in', 'esc close'],
        context: [{ label: 'Sign in', text: `name: ${m.name || '(empty)'} · focus: ${m.focus}` }],
        keys: { consume: ['tab', 'enter', 'esc'] },
      }),
});
```

`view` returns `null` for `surface` and an empty `keycaps` while closed — a plugin's
surface is mounted only while its `keycaps` is non-empty, the same rule any plugin's
`view` slot follows ("Screens", above).

### The conversation

Every message is `{"jsonrpc": "2.0", ...}`, one per line, ids independent in each
direction. The host makes these requests:

| Request | Params | Result |
|---|---|---|
| `hello` | `{ hostApi, flowtty, size: { terminal, surface }, config, idleMs, locale? }` | the plugin's registration: `{ hostApi, name?, commands?, keys?, entry?, tools?, aiTools?, configSchema?, colors?, modalColors?, usesCache? }` |
| `tool.run` | `{ name, args, call: { id } }` | `{ result, views? }` — `views` is `[{ kind, data }]`, each a block the manifest's `views` declares (below) |
| `command.run` | `{ name, arg }` | `{}` |
| `view.render` | `{ kind, data, width }` | `{ lines: StyledSpan[][] }` — a line is a list of spans, each `{ text, bold?, dim?, color? }`; `underline` and `background` are accepted but not drawn |
| `shutdown` | — | `{}` |

`hello` times out at 10 s; a plugin that answers late, with a `hostApi` the host does
not carry, or whose registration is malformed (its own name, keys, tools or
`configSchema` do not match the shape the host expects) is refused and the process is
stopped like any other refused handshake. `shutdown` waits for an update already in
flight up to 1 000 ms before closing the connection; a plugin over stdio also ends on
its own once its stdin closes, which is what happens when the host that spawned it is
gone.

The host sends these notifications — what changed, told once, by itself:

| Notification | Params |
|---|---|
| `key` | `{ name, id, ctrl?, meta?, shift?, action? }` |
| `changed` / `submitted` / `cancelled` / `toggled` | `{ id, value? }` |
| `resize` | `{ terminal, surface }` |
| `focus` / `blur` | — |
| `visible` | `{ surface }` |
| `store` | `{ key, value }` — another remote plugin's write: `key` its name, `value` its whole `host.store` slice, told to every OTHER remote plugin of the same app |
| `cache.flushed` | — |
| `afterWrite` | — |

The plugin sends exactly one notification back, whenever its state changes: `frame`,
whose params are the plugin's whole visible state —
`{ surface?, modals?, keycaps?, context?, keys? }` — never a diff. A frame over 4 MiB,
or nested past 64 deep, is dropped whole and the previous one stays on screen.

The plugin also makes requests of its own, the services `@flow-assist/remote`'s `Host`
wraps. The host's own handlers answer most of these with nothing to report, which a
JSON-RPC result with no value carries as `null`, never `{}`:

| Request | Params | Result |
|---|---|---|
| `host.showMessage` | `{ text }` | `null` |
| `host.pushLog` | `{ text }` | `null` |
| `host.chatLLM` | `{ messages }` | `{ content, transcript }` |
| `host.copyToClipboard` | `{ text }` | `null` |
| `host.store.get` | `{ key }` | the plugin's own value, or `null` |
| `host.store.set` | `{ key, value }` | `null` |
| `host.cache.get` / `.set` / `.del` | `{ key }` / `{ key, value }` / `{ key }` | the value or `null` / `null` / `null` |
| `host.config.get` | — | the plugin's own slice of the config |

### The tree

`surface` and each of `modals` is a node: `[type, props?, ...children]` — `type` one
of the host's own components (`Box`, `Text`, `Markdown`, `Table`, `Link`, `ScrollBox`,
`Select`, `ListSelect`, `ListMultiSelect`, `Checkbox`, `TextInput`), `props` a JSON
object, children more nodes or strings. `props` may be left out, so `[type, child,
...]` is also a node. Four props are reserved: `key` (a list's, React's own), `id` —
a stateful node's, and the source of its events — and `children` and `ref`, which are
dropped (a node's children are the ones that follow its props, and a ref has nothing to
point at across a process). A function prop never crosses the wire; a node with an
`id` gets its events by name instead:

| Type | Value prop | Events |
|---|---|---|
| `TextInput`, `ListSelect`, `ListMultiSelect` | `value` | `changed`, `submitted`, `cancelled` |
| `Select` | `value` | `changed` |
| `Checkbox` | `checked` | `toggled` |
| `ScrollBox` | `offset` | none — the offset is kept for the host's own scrolling, never told to the plugin |

An unknown `type` draws as one dim `▸ <type>` line, as a missing view renderer does
(below). `props.error` on a `TextInput` is shown as its validation message. A root the
host cannot draw — a prop of the wrong shape that a component throws on, a
`ListSelect` sent without `items` — draws as one dim `▸ frame failed: <message>` line
in its own place (the surface, or that one modal), said once in the host's log; the
rest of the screen and the plugin's keys go on, and the next frame is drawn afresh.

### Field state and the echo rule

A stateful node's value — a field's text, a list's cursor, a checkbox, a scroll
offset — lives on the host, keyed by its `id`, so typing never waits on a round trip
to the plugin. A frame's value for that id is checked against the last 32 values the
host itself sent as an event for it: a match is the plugin echoing a moment the host
already knows and changes nothing, while a value that is neither queued nor already
held is a deliberate write from the plugin, applied at once. An id missing from a
whole frame loses its state.

### Keys

A frame's `keys.consume` says which keys the plugin takes, written in the same words
a person writes a binding in (`enter`, `esc`, `ctrl+r`), plus `'printable'` for
anything that types a character and `'*'` for every key — canonicalised once per
frame, so a plugin authoring `consume` never needs the terminal's own vocabulary
(`return` for Enter, `escape` for Esc). The `key` event, in the other direction, IS in
that vocabulary: `name` is exactly what the terminal reports, and `id` is that same
name with any held modifiers folded in, in a fixed order (`ctrl+`, `alt+`, `shift+` —
the last only on a named key, since Shift on a bare character is already the
character); for an unmodified key the two are equal (`{ name: "return", id: "return"
}`). `action` is present only when the key resolves, under the person's own config, to
one of the actions the plugin's `hello.keys` declares. The mouse is never consumable,
whatever `consume` says.

`keycaps` is the footer's hints for the plugin's current screen: each entry is a
literal string (drawn as it is) or `{ action, label }`, drawn as the action's CURRENT
binding — `host.keyCap(action)` — followed by the label, and left out entirely while
the action is unbound.

### Modals

`frame.modals` is `{ name: Tree | null }` — a modal that is not null is open. An open
modal of the plugin's takes keys before its own surface, drawn as its own root over
the plugin's own side of the screen, the same way the host's own modals are.

### Views

The manifest's `views` lists the kinds the plugin can draw a block for; the host
builds a renderer for each one when the plugin loads, from `view.render` — never from
`hello` — since every renderer must exist before any tool has run. A tool's result may
report `{ kind, data }` views alongside its `result` (the `tool.run` table, above); a
kind the manifest does not declare is dropped, said once. While a rendered block is
first asked for, it draws as a dim `▸ <kind>` placeholder; the answer is cached by
`(kind, data, width)`, a refusal (an undeclared kind, say) is not asked again, and a
timeout is retried on the next redraw. Attaching views from `runPlugin`'s own tools —
the TypeScript runtime below — is not yet exposed; a tool there returns its bare
result.

### Locale

`hello.locale` is read the way gettext reads the environment:
`FLOW_ASSIST_LOCALE` first, then `LC_ALL`, `LC_MESSAGES`, `LANG` — the first non-empty
wins, `C` and `POSIX` mean no language, and a POSIX spelling becomes a BCP 47 tag
(`ru_RU.UTF-8` → `ru-RU`). Absent when nothing says a language.

### Errors

A JSON-RPC error's `code`:

- `-32000` — no answer inside the request's own timeout (`hello`'s 10 s, `view.render`'s
  2 s, `command.run`'s 5 s, 60 s default for a request the plugin makes of the host).
- `-32001` — the connection ended while the request was pending.
- `-32601` — the method is not one either side answers.
- `-32602` — a required field on a `host.*` request is missing or the wrong type.
- `-32603` — a handler threw.

A line that does not parse as a JSON-RPC message is dropped, never answered with an
error.

### The wire, for any language

What follows is the host and the example above, captured live over stdio (frames
trimmed where the shape repeats — the same one shown in full elsewhere in this
transcript): `→` is the host writing to the plugin's stdin, `←` the plugin writing to
its stdout. Nothing here is specific to `@flow-assist/remote` — a plugin in C, or any
language that reads stdin and writes stdout, exchanges lines exactly like these:

```
→ {"jsonrpc":"2.0","id":1,"method":"hello","params":{"hostApi":2,"flowtty":"1.0.0-alpha.28","size":{"terminal":{"width":80,"height":24},"surface":{"width":80,"height":22}},"config":{},"idleMs":60000}}
← {"jsonrpc":"2.0","method":"frame","params":{"surface":null,"keycaps":[],"keys":{"consume":["S"]}}}
← {"jsonrpc":"2.0","id":1,"result":{"hostApi":2,"name":"remote-login","keys":{"open":"S"},"entry":["open"],"commands":[],"tools":[]}}
→ {"jsonrpc":"2.0","method":"resize","params":{"terminal":{"width":100,"height":29},"surface":{"width":100,"height":23}}}
→ {"jsonrpc":"2.0","method":"focus"}
← {"jsonrpc":"2.0","method":"frame","params":{"surface":null,"keycaps":[],"keys":{"consume":["S"]}}}
→ {"jsonrpc":"2.0","method":"key","params":{"name":"S","id":"S","action":"open"}}
← {"jsonrpc":"2.0","method":"frame","params":{"surface":["Box",{"flexDirection":"column","padding":1},["Text",{"bold":true},"Sign in"],["Text",{"dim":true},"Name"],["TextInput",{"id":"name","isFocused":true}],["Text",{"dim":true},"Password"],["TextInput",{"id":"pass","mask":true,"isFocused":false}],["Text",{"inverse":false},"[ Log in ]"],["Text",{"dim":true},""]],"keycaps":[{"action":"open","label":"form"},"tab next","⏎ log in","esc close"],"context":[{"label":"Sign in","text":"name: (empty) · focus: name"}],"keys":{"consume":["tab","enter","esc"]}}}
→ {"jsonrpc":"2.0","method":"changed","params":{"id":"name","value":"a"}}
→ {"jsonrpc":"2.0","method":"changed","params":{"id":"name","value":"an"}}
→ {"jsonrpc":"2.0","method":"changed","params":{"id":"name","value":"ann"}}
← {"jsonrpc":"2.0","method":"frame", … "context":[{"label":"Sign in","text":"name: ann · focus: name"}], …}
→ {"jsonrpc":"2.0","method":"key","params":{"name":"tab","id":"tab"}}
← {"jsonrpc":"2.0","method":"frame", … "context":[{"label":"Sign in","text":"name: ann · focus: pass"}], …}
→ {"jsonrpc":"2.0","method":"changed","params":{"id":"pass","value":"s"}}
→ … five more "changed", one per letter of "secret" …
→ {"jsonrpc":"2.0","method":"key","params":{"name":"tab","id":"tab"}}
← {"jsonrpc":"2.0","method":"frame", … "context":[{"label":"Sign in","text":"name: ann · focus: login"}], …}
→ {"jsonrpc":"2.0","method":"key","params":{"name":"return","id":"return"}}
← {"jsonrpc":"2.0","id":1,"method":"host.showMessage","params":{"text":"Signed in"}}
→ {"jsonrpc":"2.0","id":1,"result":null}
← {"jsonrpc":"2.0","method":"frame","params":{"surface":["Box",{"flexDirection":"column","padding":1},["Text",{"bold":true},"Sign in"],["Text",{"dim":true},"Name"],["TextInput",{"id":"name","isFocused":false}],["Text",{"dim":true},"Password"],["TextInput",{"id":"pass","mask":true,"isFocused":false}],["Text",{"inverse":true},"[ Log in ]"],["Text",{"dim":true},"signed in as ann"]],"keycaps":[{"action":"open","label":"form"},"tab next","⏎ log in","esc close"],"context":[{"label":"Sign in","text":"name: ann · focus: login"}],"keys":{"consume":["tab","enter","esc"]}}}
→ {"jsonrpc":"2.0","id":2,"method":"shutdown","params":{}}
← {"jsonrpc":"2.0","id":2,"result":{}}
```

`resize` and `focus` arrive right after `hello`, before any key: the host tells a
freshly connected plugin its real size and that it has the keyboard, once the App is
up (a test's own defaults differ from a real terminal's). Typing `ann` sends one
`changed` PER LETTER, not one for the whole word — this is what the echo rule above
guards against: the host's own field already reads `ann` by the time the plugin's own
frame catches up, and none of the three lag it back down. The host's answer to the
plugin's own request is `null` (a JSON-RPC result with nothing in it), never `{}` —
only the plugin answers `shutdown` that way, since it has something to send back.

### The TypeScript runtime

[`packages/remote/README.md`](../packages/remote/README.md) covers `runPlugin` — the
Elm-shaped runtime that speaks this protocol for a plugin written in TypeScript, so
its author writes `init`/`update`/`view` and never a JSON-RPC line by hand. A throwing
`update` or `view` there — the author's own bug — fails only that one step: the model
stays exactly what it was, one line goes to stderr
(`[<name>] update failed: <message>`), and the next event runs normally.

### What a remote plugin cannot do

- **Read another plugin's part of the store synchronously.** `host.store.get` answers
  only the calling plugin's own slice; another plugin's writes arrive as `store`
  events instead, never as a value to fetch.
- **Be told when a JS plugin writes to the store.** `host.store` is a plain record
  with no change hook: a JS plugin may read it, but nothing tells it, or any other JS
  plugin, when it changes. Only a remote plugin's own writes are told to anyone — as
  `store` events to every OTHER remote plugin of the same app.

Running a plugin as a shared server (`connect`, `--serve`) is documented once the
transport that runs it exists.

## The chat's two hooks

- `chatContext({ ui, host })` — what the plugin's screens show right now, as a list of items
  `{ label, text }`, or `[]` / `null` when nothing is on screen. A screen may show
  several things at once — a board and an open issue — so it is a list:

  ```ts
  chatContext: ({ host }: any) => {
    const { board, issue } = host.store.tracker ?? {}; // whatever your screen keeps
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
- `chatSubject({ ui, host })` — **deprecated**, kept for one release: a short id of what the
  screen is about, read as one item `{ label: <id>, text: '' }`. A plugin that has
  `chatContext` is not asked it. Move to `chatContext`.
- `afterWrite({ ui, host })` — called after a turn in which a write the person confirmed went
  through: reload what the screen shows, or it keeps the text from before the write.

## Compatibility

Two fields in `manifest.json` say what a plugin is built for, and the host reads them
before any of the plugin's code runs — when it lists plugins, loads them and installs
one:

- **`hostApi`** — the host API numbers the plugin works with: a number (`1`) or a list
  (`[1, 2]`). The host API is everything the host gives a plugin: the object each hook
  receives and what is on it (components, hooks, services), the hooks of the plugin
  shape and their signatures, the fields of the manifest. It goes up by one on any
  change a plugin built for the previous number would break on. A plugin whose list
  does not hold the host's number is not loaded. No field reads as `1`. A plugin that
  names several numbers tells them apart by what its hooks receive: under host API 2
  and later the pair `{ ui, host }`, with the number at `host.hostApi`; under 1 the
  single `ft` object, which has no `host` — `const api2 = 'host' in arg`.
- **`flowtty`** — a semver range of the flowtty versions the plugin's screens need,
  checked against the flowtty the host runs. While flowtty is in alpha, name the one
  alpha you built against: `>=1.0.0-alpha.31 <1.0.0-alpha.32` — an alpha may change what the next one gives. A
  prerelease is matched only by a range that names one: `^1.0.0`, and even `*`, do not
  take `1.0.0-alpha.31`. A plugin with no field is loaded unchecked, and the log says
  so — a plugin with no screens has nothing to check; the bundled ones declare it.

A plugin that cannot run here is skipped — the rest load — and said so: `plugins ls`
shows `incompatible: built for host API 1, host provides 2` (or `incompatible: needs
flowtty ^1.1.0, host has 1.0.0-alpha.31`) beside it — a plugin linked into
`plugins-enabled/` from a repository of its own is listed too, marked `(linked)` — the log (`L`) has a line, and
`plugins install` refuses it — an archive before anything is unpacked into place. A
plugin that is a single file has no manifest, so it reads as host API 1 with no
flowtty range; a plugin is a directory with a `manifest.json`.

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
