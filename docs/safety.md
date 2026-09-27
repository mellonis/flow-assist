# Safety: what the assistant may do

Everything about trust in one place: what the assistant asks you about, how to ask
less, the paths where nobody can answer, how your tokens and settings are kept from
it, and what these measures do not do. For maintainers, the rules behind this page
are in [AGENTS.md](../AGENTS.md), "What the model can do" and "Secrets".

## The y/n: what is a write

A read — listing a directory, reading a file, searching — runs without asking. A
write — a command, a file edit, a tracker change, a setting — pauses for your y/n
first, one call at a time. The confirmation shows what you are saying yes to: a
command the assistant wants to run is shown as its command line (`! …`), and a setting
it wants to change as the `config set` line you would have typed. A write that ran
leaves a `✎` block in the turn with the diff of what it changed, always open. A
tool of an MCP server runs without asking only when the server itself marks it
read-only and you set `trusted` for that server, or when you list it yourself in
`plugins.mcp.servers.<name>.readOnly`; `plugins-available/mcp/README.md` has the
details. The assistant installs a plugin only by its name, never from a URL: a URL in
its request may come from any page it has read.

## Asking less: the auto mode and `shell.autoRun`

Shift+Tab — or `/auto reads|all|off` — says how much you want to confirm while you
work: `auto: reads` leaves every write asking, `auto: writes` lets writes run without
the y/n, and the chat's hint line says which is on for as long as it is. It belongs to
the conversation you are in: a restart, `/clear`, `/new`, opening another session and
a new task all go back to asking, and nothing about it is saved. Two things always ask,
whatever you set — reading a page from a host that is not on `web.allowlist`, and the
assistant's `config_set`. A command the assistant runs (`run_command`) asks too, unless
you also said so yourself: `config set shell.autoRun true` (or `:config set --session
shell.autoRun true` for this run) together with `auto: writes` lets commands run without
the y/n, and the hint line then says `auto: writes + commands`.
Either alone changes nothing, and the assistant can never set `shell.autoRun` itself.
What ran is still shown: the ✎ diff, the command's block and the tool trail are the same
either way.

## The one-shot prompt and `--allow-writes`

```sh
bun run src/cli.ts --allow-writes "fix the typo in README.md"   # one-shot, writes allowed
```

A one-shot prompt has nobody to answer a y/n, so it declines every write — a command,
a file edit, a tracker change — and the model is told to leave it to you in the chat;
reads run as usual. `--allow-writes`, given before the prompt, lets writes run without
asking and says each one on stderr as it runs (`[write] ! <command>`, or the tool and
its arguments). Even then `config_set`, a `web_fetch` outside `web.allowlist` and a
plugin's own `run_command` are declined: config stays yours, a URL can carry out
anything the model has read, and only the host's shell tool is covered by the flag.
Only pass it for a prompt whose tools read nothing you do not trust.
A bare `--allow-writes` with no prompt is an error.

## Where nobody can answer, writes are declined

A path to the model that cannot ask you declines every write before it starts: the
tool never runs, and the assistant is told that this run cannot ask you and that you
can do it in the chat. Reads run as usual. That holds for:

- a background task — it has nobody to ask, so it declines every write, cannot fetch a
  host you have not listed, and its questions to you are answered "nobody to ask";
- a plugin's own use of the model (`chatLLM`), in the chat or not — unless the plugin
  passes a confirmation of its own that asks you; a plugin in another language, over
  the remote protocol, always declines;
- the one-shot prompt, unless you pass `--allow-writes` (above).

`/compact` and the automatic compaction run no tools at all.

## Reading the web

The assistant reads a page with its `web_fetch` tool. Every fetch asks you first,
unless the host is on `web.allowlist` (`example.com`, or `*.example.com` for its subdomains); a
background task cannot fetch a host you have not listed. Local and private
addresses are refused unless listed. `web.maxBytes` / `web.timeoutMs` set the limits.
The tool is on by default; `config set ai.disabledTools '["web"]'` turns it off.
A page the assistant fetches reaches it as data, not instructions.

## Secrets

Tokens stay out of the conversation. Every secret the app knows — the variables your
config names (`${VAR}`, `ai.tokenEnv`), any variable whose name says it is a token, key,
secret, password or cookie, and a credential written into the config itself — is
replaced by `‹secret NAME›` wherever it turns up: a tool's result, a command's output
(yours too), what a view shows, the assistant's answer and the log. The assistant, the
screen, the saved session and its journal only ever see the mark. A command the
assistant runs starts without those variables, and the assistant is told their names
once; `config set shell.passEnv '["GH_TOKEN"]'` lets its commands see the ones you
list. Your own `!command` keeps the whole environment.

## Settings changed behind the app's back

The app applies only settings it accepted: when `config.local.json` or `config.json`
holds something it did not write or you did not approve — a command changed it, another
terminal did, or you edited it while the app was off — it keeps using the accepted
settings and the chat says `config.local.json changed outside flow-assist — apply? (y/n)`
with the keys that changed (values of token-like keys masked). `y` applies it; `n` puts
the accepted settings back into the file and keeps the change beside it as
`config.local.json.rejected-<time>`, so neither a restart nor a crash brings it in. A
one-shot prompt or a `config` command on a changed file does not use it and says why.
`config set`, `:config set` and the assistant's `config_set` are the app's own writes;
a `flow-assist config set` the assistant runs as a command is not — it waits for your yes.

## What the assistant may set or save

The assistant may change nothing that decides what it can reach — its model, token, tools, the shell's and the web's reach, a plugin's roots. A few
keys that could hurt nobody are marked as its to change (`ui.verbs`, `ui.mouse`, `ui.hover`,
`sessions.resume`, where the chat opens and which side its panel docks on, the
keycaps panel): asked, it changes one with `config_set` — for this run, or saved when
the key allows — and you confirm the same `config set` line you would have typed.
Asked about any other key, it gives you the command to run.
Everything under `ai` — its model, endpoint, token, tools and the limits of a turn —
stays yours whatever else is marked. `config_schema`, which the assistant reads, shows
the marks beside each key.

## What these measures do not do

The secret rules stop accidents — a debugging `env | grep`, a config file printed whole — not an
assistant that sets out to get a token. A command runs as you, so it can read the
environment of the app itself (`ps eww` of its parent process), start an interactive
shell that loads your profile again, ask the Keychain helper your profile uses, or have
a plugin's own `git` (which runs with the whole environment) run something for it; and a
token it prints transformed — reversed with `rev`, split over lines, re-encoded — is
not recognised. Letting commands run unasked (`auto: writes` together with
`shell.autoRun`) is your decision to trust what the assistant writes; with it off,
read each command before you say yes.

The settings guard is the same. A command the assistant runs carries a marker in its
environment, so a `flow-assist config set` it runs writes the file but waits for your
yes. Like the token rules above, this stops accidents, not a command that sets out to
get round it: one running as you can also rewrite or delete the app's own record of
what you accepted, or take the marker off — and a record that is deleted makes the
next start a first start, which accepts the files as they are.
