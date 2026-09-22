# mcp

The tools of MCP servers, as the assistant's tools.

    plugins install mcp
    config set plugins.mcp.servers.webstorm.url http://127.0.0.1:64542/stream
    config set plugins.mcp.servers.rustrover.url http://127.0.0.1:64522/stream

A server that is a command instead of a URL — Safari's, say, which is a program on
every Mac with Safari 27:

    config set plugins.mcp.servers.safari.command /usr/bin/safaridriver
    config set plugins.mcp.servers.safari.args '["--mcp"]'

Restart the assistant: the servers are asked for their tools at start. The log (`L`)
says what each one answered — `webstorm: WebStorm 2026.2, 23 tools`,
`safari: Safari 1.0.0, 17 tools`, or why it did not.

## Settings — `plugins.mcp.servers.<name>`

A server is reached one of two ways, and exactly one: `url` or `command`.

| key | |
|---|---|
| `url` | the server's Streamable HTTP endpoint |
| `headers` | extra request headers (with `url`); `${VAR}` is taken from the environment, so a token stays in env: `{"Authorization": "Bearer ${MCP_TOKEN}"}` |
| `command` | the program to run as the server, spoken to over its stdin and stdout (the MCP stdio transport) — a path or a name on PATH, started without a shell |
| `args` | its arguments, a list of strings, passed as written: `["--mcp"]` |
| `env` | environment for the server's process, on top of the assistant's own; `${VAR}` is taken from the environment here too |
| `trusted` | `true` — you believe THIS SERVER's own read-only claims: a tool with `readOnlyHint: true` runs without asking |
| `readOnly` | YOUR OWN list of this server's tools you have checked and call read-only, by the name the server gives them — each runs without asking. It needs no `trusted`, and it is the only thing that helps a server which makes no claims at all |
| `enabled` | `false` — keep the entry, do not connect |
| `connectTimeoutMs` | the handshake and the tool list, default 1500 — the assistant waits for them at start, so a server that is down (or a command that never answers) costs at most this much |
| `timeoutMs` | a tool call, default 60000 |

`command` and `args` are taken literally: they are an argv, never a shell line, and no
`${VAR}` is expanded in them — a variable that grew an extra space would otherwise turn
into an argument nobody wrote.

## A server that is a command: its process

One process per server for the whole run, started while the assistant starts and
stopped when it ends — on `:quit`, on Ctrl+C, on SIGTERM/SIGHUP, and when a one-shot
command (`flow-assist "…"`, `config set plugins.…`) has done its work. A server that
does not finish the handshake within `connectTimeoutMs` is stopped and skipped, like an
HTTP server that is down.

A server that dies is **not** restarted: its calls fail from then on, saying which
server it was and what it last wrote to stderr. Start the assistant again. A single
call that runs past `timeoutMs` fails alone and leaves the server be.

stdout is the protocol, one JSON-RPC message per line; any other line the server prints
there is skipped. stderr is its log — kept for the error messages above, never read as
protocol.

## What the model sees

Each server is a tool group `mcp:<name>` — `ai.disabledTools: ["mcp:webstorm"]` turns
one off — and its tools are named `<name>:<tool>` (`webstorm:get_file_text`): two
servers often offer the same tool, and which one answered is worth knowing.

## Safety

A server's tools run code on its side, and the `readOnlyHint` a tool carries is the
server's own claim. So every call asks you first (the chat's y/n; a background task,
with nobody to ask, declines it) — unless one of two claims excuses it, and they are
different claims by different people:

- `trusted` — "I believe this server's own read-only claims". A tool with
  `readOnlyHint: true` then runs without asking.
- `readOnly` — "I checked these tools myself". The names go as the server writes them,
  and each of those tools runs without asking, `trusted` or not:

      config set plugins.mcp.servers.safari.readOnly '["list_tabs","page_info","get_page_content"]'

  A name on the list the server does not offer is said once in the log at start, so a
  typo is visible rather than silent.

A result reaches the model framed as data from the server, not instructions.

A server started as a command often carries no `readOnlyHint` at all — Safari's 17
tools carry none — so `trusted` alone asks for every call, and `readOnly` is the only
thing that helps. Put a tool on that list only after reading what it does: a browser
holds your logged-in sessions, "read the page" reads whatever you are signed in to, and
a tool that takes a URL is a way of carrying data out however much it only "reads".

## Not yet

OAuth, resources and prompts. No runtime dependencies: the settings schema is built
with the host's zod.
