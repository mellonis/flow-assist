# mcp

The tools of MCP servers, as the assistant's tools.

    plugins install mcp
    config set plugins.mcp.servers.webstorm.url http://127.0.0.1:64542/stream
    config set plugins.mcp.servers.rustrover.url http://127.0.0.1:64522/stream

Restart the assistant: the servers are asked for their tools at start. The log (`L`)
says what each one answered — `webstorm: WebStorm 2026.2, 23 tools`, or why it did not.

## Settings — `plugins.mcp.servers.<name>`

| key | |
|---|---|
| `url` | the server's Streamable HTTP endpoint |
| `headers` | extra request headers; `${VAR}` is taken from the environment, so a token stays in env: `{"Authorization": "Bearer ${MCP_TOKEN}"}` |
| `trusted` | `true` — the server's read-only tools run without asking |
| `enabled` | `false` — keep the entry, do not connect |
| `timeoutMs` | per request, default 5000 |

## What the model sees

Each server is a tool group `mcp:<name>` — `ai.disabledTools: ["mcp:webstorm"]` turns
one off — and its tools are named `<name>:<tool>` (`webstorm:get_file_text`): two
servers often offer the same tool, and which one answered is worth knowing.

## Safety

A server's tools run code on its side, and the `readOnlyHint` a tool carries is the
server's own claim. So every call asks you first (the chat's y/n; a background task,
with nobody to ask, declines it) — except the read-only tools of a server you marked
`trusted`. A result reaches the model framed as data from the server, not instructions.

## Not yet

The stdio transport (a server started as a command — it needs a way to stop the
process when the assistant exits), OAuth, resources and prompts. No runtime
dependencies: the settings schema is built with the host's zod.
