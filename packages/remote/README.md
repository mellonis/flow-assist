# @flow-assist/remote

Write a flow-assist plugin as a separate process. The host talks to it over JSON-RPC 2.0, one message per line; the plugin keeps its own state and sends a *frame* — its whole screen as a JSON tree — whenever it changes; the host draws it. This package is the protocol's types, its line codec, and `runPlugin`, a runtime that speaks it for you.

The protocol's number is the host API's (`PROTOCOL_HOST_API`); the package ships with each host release under the same version.

## A sign-in form

This is the whole of `examples/remote-login/src/index.ts` — a form the person opens
with `S`, fills in, and submits with Enter:

```ts
import { runPlugin, type HostEvent } from '@flow-assist/remote';

type Model = { name: string; pass: string; focus: 'name' | 'pass' | 'login'; note: string; open: boolean };

const next = (f: Model['focus']): Model['focus'] => (f === 'name' ? 'pass' : f === 'pass' ? 'login' : 'name');

await runPlugin<Model, HostEvent>({
  hello: { name: 'remote-login', keys: { open: 'S', next: 'tab', login: 'enter', close: 'esc' }, entry: ['open'] },
  init: () => ({ name: '', pass: '', focus: 'name', note: '', open: false }),
  update: async (e, m, host) => {
    switch (e.type) {
      case 'key':
        if (e.key.action === 'open' && !m.open) return { ...m, open: true };
        if (!m.open) return m;
        if (e.key.action === 'next') return { ...m, focus: next(m.focus) };
        if (e.key.action === 'close') return { ...m, open: false };
        if (e.key.action === 'login' && m.focus === 'login') {
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
    ? { surface: null, keycaps: [], keys: { consume: ['open'] } }
    : {
        surface: ['Box', { flexDirection: 'column', padding: 1 },
          ['Text', { bold: true }, 'Sign in'],
          ['Text', { dim: true }, 'Name'], ['TextInput', { id: 'name', isFocused: m.focus === 'name' }],
          ['Text', { dim: true }, 'Password'], ['TextInput', { id: 'pass', mask: true, isFocused: m.focus === 'pass' }],
          ['Text', { inverse: m.focus === 'login' }, '[ Log in ]'],
          ['Text', { dim: true }, m.note]],
        keycaps: [{ action: 'open', label: 'form' }, { action: 'next', label: 'next' }, { action: 'login', label: 'log in' }, { action: 'close', label: 'close' }],
        context: [{ label: 'Sign in', text: `name: ${m.name || '(empty)'} · focus: ${m.focus}` }],
        keys: { consume: ['open', 'next', 'login', 'close'] },
      }),
});
```

`update` is folded one event at a time — an author's own bug in it, or a thrown
promise, fails only that step: the model stays what it was, one line goes to stderr,
and the plugin keeps serving the events after it.

## `runPlugin`

`runPlugin<Model, Msg = HostEvent>(def: PluginDef<Model, Msg>)` is the whole of a
plugin's `main`: it answers `hello`, folds every event into the model through
`update`, and sends the `view`'s frame after each step. `PluginDef`'s fields:

- **`hello`** — the plugin's registration, sent back as `hello`'s answer: `name`,
  `keys` (an action and its default binding), `entry` (the actions that lead in from
  the host's start screen), `commands`, `tools`, `aiTools`, `configSchema`, `colors`,
  `modalColors`, `usesCache` — the same shape a plugin in the host's own process
  declares (docs/plugins.md). `hostApi` is filled in for you
  (`PROTOCOL_HOST_API`); `commands` and `tools` are built from the maps below unless
  given here directly.
- **`init(params: HelloParams): Model`** — the model, built once, from the host's own
  `hello` — the terminal and surface size, the plugin's slice of the config, `idleMs`,
  the person's `locale`.
- **`update(msg: Msg, model: Model, host: Host): Model | Promise<Model>`** — folds one
  message into the model. Runs to completion before the next one starts; a `view`
  follows every step that succeeds.
- **`view(model: Model): Frame`** — the plugin's whole visible state:
  `{ surface?, modals?, keycaps?, context?, keys? }` (docs/plugins.md, "A plugin in
  another language" covers the tree `surface` and each of `modals` is built from).
- **`tools?: Record<string, (args, model, host) => unknown | Promise<unknown>>`** —
  answers `tool.run` by name; the tool's return value is sent back as `tool.run`'s
  `result`. Left for `hello.tools` to declare, each tool here is registered with its
  bare name as its description and no parameters — give `hello.tools` real
  descriptions and a schema once the model needs to tell them apart. Attaching views
  to a tool's answer (`ToolRunResult.views`) is not yet exposed here — a tool returns
  its bare result.
- **`commands?: Record<string, (arg, model, host) => Model | Promise<Model>>`** —
  answers `command.run` by name, as another way to fold a message in.
- **`viewRenderers?: Record<string, (data, width) => StyledSpan[][]>`** — answers
  `view.render` for a kind the manifest's `views` declares.
- **`msg?: (event: HostEvent) => Msg | null`** — translates a host event into the
  author's own message type; the default is `HostEvent` itself. Returning `null`
  drops the event: no `update` runs for it.

## `Host`

The second argument to `update`, a `command`, or a tool: the services the host
answers as requests over the same connection.

```ts
interface Host {
  showMessage(text: string): Promise<void>;
  pushLog(text: string): Promise<void>;
  copyToClipboard(text: string): Promise<void>;
  chatLLM(messages: unknown[]): Promise<{ content: string }>;
  store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  cache: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; del(key: string): Promise<void> };
  config(): Promise<Record<string, unknown>>;
  redraw(): void; // sends the current frame now, for a change made outside `update` (a timer)
}
```

`store` is the plugin's own slice: `get` never reads another plugin's, and a write
made with `set` is told to every other remote plugin as a `store` event
(docs/plugins.md).

## `HostEvent`

The default `Msg`, and what a `msg` hook translates from:

```ts
type HostEvent =
  | { type: 'key'; key: KeyEvent }
  | { type: 'changed' | 'submitted' | 'cancelled' | 'toggled'; id: string; value?: unknown }
  | { type: 'resize'; terminal: Size; surface: Size }
  | { type: 'focus' } | { type: 'blur' } | { type: 'visible'; surface: boolean }
  | { type: 'store'; key: string; value: unknown } | { type: 'cache.flushed' } | { type: 'afterWrite' };
```

## Running it

A remote plugin's `manifest.json` names the process instead of an entry module:

```json
{ "name": "remote-login", "version": "0.1.0", "hostApi": 2, "flowtty": ">=1.0.0-alpha.28",
  "run": ["bun", "src/index.ts"] }
```

and is meant to be enabled the same way any plugin is, once the host reaches the
process a manifest names:

```sh
ln -s ../my-remote-plugin plugins-enabled/my-remote-plugin
```

Today that wiring is not built — `transportFor` (`src/remote/transports.ts`) throws
`remote transports are not built yet` — so a remote plugin runs through its own
tests, or a test that hands it a transport of its own, as
`src/__tests__/example-remote-login.e2e.test.ts` runs this package's own example
(docs/plugins.md, "A plugin in another language").

## Writing a client in another language

The wire is plain JSON-RPC 2.0 over stdin and stdout, whatever language reads it —
docs/plugins.md, "A plugin in another language" has the message tables and a
line-by-line transcript of this same example.
