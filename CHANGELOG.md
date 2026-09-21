# Changelog

What each version of flow-assist brought, newest first. The version is the one in
`package.json` (and `hostVersion()`, which a test keeps equal to it).

## 0.1.0 — 2026-09-21

The first version: a terminal assistant host that knows no company and no system,
with everything specific delivered by plugins.

- **Plugins** register surfaces, commands, keys, tool groups for the model, config
  schema, and the two chat hooks — what the screen is about, and a reload after a
  write. Installed from a package registry or linked from a repository of their own;
  a published plugin ships its build (`files` in its package.json names what goes).
  Bundled: `repo` (read the configured clones; branch, commit, push), `gitlab`
  (merge requests through `glab`), `mcp` (tools from MCP servers).
- **The chat**: an LLM agent loop over an OpenAI-format API, with a y/n pause before
  every write; what a write changed stays in the chat as a diff, and is never sent
  back to the model. Streaming with a status line that says what happens now,
  a queue while an answer is written, `ask_user` questions, a plan (`todo`), memory,
  reminders, background tasks, `/compact`, `/context`, `/copy`, sessions that survive
  a restart (`/resume`), `!command` and shell mode, `run_command` behind the y/n,
  `web_fetch` with an allowlist and private addresses refused.
- **The screen**: a start screen, a command line (`:`) with inline completion, help,
  the log, keycaps, mouse wheel, and drag-to-copy through the terminal's clipboard.
- **Distribution**: runs with `bun src/cli.ts`, or as a compiled binary with built
  plugins beside it.
