# developer-assistant

A standalone, **domain-agnostic** TUI/CLI assistant host. It has no notion of
"issue", "board", or "sprint" in its core, and none of any company's systems. Functionality is delivered as
**plugins** that register surfaces, commands, keybindings, LLM tool groups, and
config schema. The bundled `gitlab` and `repo` are tool-group-only plugins; a
plugin with surfaces (views, modals, keys) lives in its own repository and is
dropped into `plugins-available/`, which ignores everything not bundled.

## Language rule

Specs, implementation plans, and **code comments are written in English**. Help
strings shown to the user may stay in the session language. Russian comments
from ported source are translated during the port and are never left in the new
tree.

## Stack

- TypeScript **7.0.2** (native `tsc`), module `NodeNext`, target `ES2022`, `strict`.
- Bun **1.3.x** — `bun run`, `bun test`, `bun build --compile` (the TUI runs as a Bun-executable via `bun src/cli.ts`; `--compile` is retired — it produces a two-React-instance bundle).
- React 19 + `@flowtty/react` / `@flowtty/tty-backend`, zod 4.

## Repos

- `developer-assistant` — this host. Plugin sources live under `plugins-available/`, each a package with its own dependencies; the host never imports a plugin or a plugin's dependency.

## Layout

```
developer-assistant/
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
`aiTools`. `components[slot] = (ft) => Component`; `services` expose host
services through `ft.services`. Tool groups are delivered by plugins — there is
**no** `tools-available/` → `tools-enabled/` repository; `ai.disabledTools` is
the blacklist.

## CLI

`developer-assistant` with subcommands:

- (default) `interactive` — the TUI.
- `config get|set|unset|help` — host config.
- `plugins ls|install|remove|update` — manage enabled plugins.
- any other arg — a one-shot `<prompt>` chat with the loaded tool registry.

## Config & environment

- Config: `~/.config/developer-assistant/config.json` (schema from each plugin's `configSchema`).
- Environment: the host reads `LLM_TOKEN` (or `ai.tokenEnv`) and the optional `DA_PLUGIN_REGISTRY_URL` / `DA_PLUGIN_REGISTRY_PROJECT` / `DA_PLUGIN_REGISTRY_TOKEN`; host variables take the `DA_` prefix. A plugin owns its own variables and declares them in `requiredSettings`.
- `config.user` (`name`, `login`) is the only source of the person's identity in the chat context — never the environment or the OS account.

## Testing

From the host root: `bun run build && bun run typecheck && bun test`.
Plugin tests: `cd plugins-available/<name> && bun test`.
The host suite must pass with `plugins-available/` empty — a host test never loads a real plugin.

## Git

- **Never** append a `Co-Authored-By: Claude` trailer (or any Claude
  `Co-Authored-By`) to a commit message.
- Branch from `master`; the default branch here is `master`.