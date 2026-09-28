# mcp

The tools of MCP servers, as the assistant's tools.

    plugins install mcp
    config set plugins.mcp.servers.webstorm.url http://127.0.0.1:64542/stream
    config set plugins.mcp.servers.rustrover.url http://127.0.0.1:64522/stream

A server that is a command instead of a URL — Safari's, say, which is a program on
every Mac with Safari 27:

    config set plugins.mcp.servers.safari.command /usr/bin/safaridriver
    config set plugins.mcp.servers.safari.args '["--mcp"]'

Restart the assistant: the servers are asked for their tools at start, in the
background — the screen is drawn at once, the start screen says `starting: mcp…` until
every server has answered or failed, and each server's tools join as it answers (a
message already on its way gets them from its next step). The log (`L`) says what each
one answered — `webstorm: WebStorm 2026.2, 23 tools`, `safari: Safari 1.0.0, 17
tools`, or why it did not. A one-shot prompt (`flow-assist "…"`) waits for them before
it asks the model.

## A server that is not there

A server that does not answer at start — a gateway that said 502 at that moment, an IDE
not open yet — is tried again in the background: after 5 s, 15 s and 60 s, then every
5 minutes, until it answers. So is one that drops later: a call whose connection is
refused or reset, a gateway's 502, 503 or 504, a process that exits. Its tools are not offered while it is gone, and when it
answers they join at once — a message already on its way gets them from its next
step, no restart — and the chat says so: `[mcp] tracker connected — 12 tools`. A call with no answer within `timeoutMs`, another 5xx or
a 404 is that call's error — a slow search takes no other tool away — unless the
server, asked at once whether it is there (MCP's `ping`), does not answer either: then
it has dropped. A 404 to the ping too is a session the server has forgotten (sessions
expire): a new one is started and the call is made again, once. A call the assistant
makes to a server that dropped meanwhile is answered `<name> is not connected —
retrying in N s`.

A 401 or a 403 is not tried again: that is the token, not the network, and trying again
would only be refused again. The reason says so; fix the token, then `/mcp restart
<name>`.

## `/mcp` — the servers, from the chat

`/mcp` in the chat lists the servers in the conversation's place — each one's name,
transport (`http` or `stdio`), state (`connected · 23 tools`, `failed — HTTP 502 ·
retrying in 12 s`, `disabled`) and how many of its tools run without asking — with keys:
`d` disables or enables the one under the cursor, `r` restarts it, `t` lists its tools,
Esc closes. `:mcp` on the command line says the same in one line (each server in the
log too).

    /mcp disable <name> [--session]   off at once — its tools gone, a command's process stopped
    /mcp enable <name> [--session]    on again, connected now
    /mcp restart <name>               try now; the backoff starts over
    /mcp add <name> <url>             a new HTTP server
    /mcp add <name> <command> [args…] a new server started as a command (split on spaces, no shell)
    /mcp remove <name>                out of config.local.json and this run
    /mcp tools <name>                 its tools, the read-only ones marked

`disable`, `enable`, `add` and `remove` write `config.local.json` as `config set`
does (`plugins.mcp.servers.<name>.enabled`, the server's whole entry); `--session`
keeps the change for this run only. A server set in `config.json` is removed there, by
hand — `/mcp disable` turns it off meanwhile. A call the assistant makes to a server's
tool after it went — from a step it began before — is told why: disabled, not connected
and when it is tried next, or removed by you. `headers` and `env` are never taken
from the chat: they hold tokens, and what is typed in the chat is kept in its history
and its session. Set them with `config set plugins.mcp.servers.<name>.headers '{…}'`.
The names complete with Tab. The model has no tool for any of this: which servers run
is yours to say.

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
| `enabled` | `false` — keep the entry, do not connect (`/mcp disable <name>` sets it) |
| `connectTimeoutMs` | the handshake and the tool list, default 1500 — how long a first attempt may take before the server counts as not there (the app does not wait for it; a one-shot prompt does, at most this much) |
| `timeoutMs` | a tool call, default 60000 |

`command` and `args` are taken literally: they are an argv, never a shell line, and no
`${VAR}` is expanded in them — a variable that grew an extra space would otherwise turn
into an argument nobody wrote.

## A server that is a command: its process

One process per server at a time, started while the assistant starts and stopped when
it ends — on `:quit`, on Ctrl+C, on SIGTERM/SIGHUP, and when a one-shot
command (`flow-assist "…"`, `config set plugins.…`) has done its work. A server that
does not finish the handshake within `connectTimeoutMs` is stopped and tried again
later, like an HTTP server that is down.

A server that dies fails the calls that were waiting, saying which server it was and
what it last wrote to stderr, and is started again in the background as a new process
(above). A call that runs past `timeoutMs` fails alone, and the server keeps its tools
as long as it answers a `ping`.

stdout is the protocol, one JSON-RPC message per line; any other line the server prints
there is skipped. stderr is its log — kept for the error messages above, never read as
protocol.

## What the model sees

Each server is a tool group `mcp:<name>` — `ai.disabledTools: ["mcp:webstorm"]` turns
one off — and its tools are named `<name>:<tool>` (`webstorm:get_file_text`): two
servers often offer the same tool, and which one answered is worth knowing.

A server that answers `initialize` with `instructions` (how its data is shaped, its
vocabulary, what to check before trusting it) has that text become its tool group's own
description — the model sees it in the `tools_load` index and in full once the group's
tools are loaded, trusted the way a tool's own description is.

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
