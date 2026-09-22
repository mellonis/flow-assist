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
  set by the person with `config set plugins.notes.file ~/notes.md`.
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
  (`(args) => args.action !== 'list'`) for a tool that only sometimes writes.
- **A write refuses by throwing.** Whatever a write tool *returns* counts as done — the
  chat marks the turn with ✎. A refusal or a failed call must throw, in words the
  model can repeat to the person ("…Nothing was changed.").
- **`ctx.reportChange({ title, before, after })`** — once the write succeeded, what it
  changed. The chat keeps a `✎ title · +N −M` diff block above the answer; the model
  never gets it. `ctx` has no `reportChange` outside a chat (the one-shot CLI), so call
  it as `ctx?.reportChange?.(…)`.
- **An argument is hostile input.** The model writes every argument, and it may have
  read the words it writes in a web page or a ticket. Check paths against what the
  plugin may touch, never pass a value that starts with `-` to a command line, and
  remember that a read-only tool has no y/n in front of it.
- **Say failures as failures.** Return a tool's error in its own words; an empty `{}`
  from a broken backend reads to the model like "nothing there".
- Names are the ones you give (`notes_read`, not `notes:notes_read`); two groups that
  declare the same name get the later one qualified, and the clash is logged.
- `ai.disabledTools: ["notes"]` turns the group off per machine.

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
- **Take React and flowtty from `ft`, import only their types.** `ft.useState`,
  `ft.useEffect`, `ft.useRef`, the flowtty components — one React for the host and
  every plugin; a second copy breaks every hook.
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

- `chatSubject(ft)` — a short id of what the plugin's screen is about now (an open
  document, a ticket), or `null`. The chat shows it in its title, and opening the chat
  on another subject starts a new session.
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

A plugin kept in a repository of its own links the host's packages into its own
`node_modules` for its tests (one React, never two), and must not leave a `dist/`
from a local build lying around: the host loads a plugin by `main` first, so a stale
build is what the tests would get. [AGENTS.md](../AGENTS.md) has the full set of rules
the host keeps, plugin contract included.

## License

Plug-ins that implement this contract are loaded by the host as separate works and
may be licensed under any terms — see the plug-in exception in the
[README](../README.md#license).
