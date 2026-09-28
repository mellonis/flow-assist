# Safety: what the assistant may do

Everything about trust in one place: what the assistant asks you about, how to ask
less, the paths where nobody can answer, how your tokens, settings, plugins and memory
are kept from it, and what these measures do not do. For maintainers, the rules behind this page
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

## Plugins and memory changed behind the app's back

A command can leave something the app trusts at its next start: a link in
`plugins-enabled/` is a plugin that runs with the app's rights, and a file in the
assistant's `memory/` is a line in every later request of its project — every project,
for the global one. So the app keeps a record of what it put there itself.

- **A plugin loads only when you trust it.** `flow-assist plugins install` (a name or an
  archive) trusts what it installs, and `flow-assist plugins trust <name>` trusts a plugin
  put into `plugins-enabled/` another way — by hand, or by an installer script that
  unpacks and links. Any other plugin there is not loaded — none of its code runs — and
  the start screen and the log say `not trusted — flow-assist plugins trust <name>`.
  Trust is the plugin's name and the place its link leads. An installer that unpacks
  each version into the same `plugins-available/<name>` and links
  `../plugins-available/<name>` keeps a plugin trusted across updates; a plugin new to
  it needs one `plugins trust`. A link that now leads elsewhere is not trusted: the
  start screen shows where it led and where it leads now, and `plugins trust` shows both
  and asks before it records the new place (`--yes` answers for you). A name made of
  anything but letters, digits, `.`, `_` and `-` is refused outright — never loaded, and
  no command is shown for it. A plugin the assistant installs (`host:plugins_install`)
  is not trusted until you run `plugins trust` yourself, even under a name you trusted
  before; `plugins remove`, or a link that is simply gone at a start, forgets the trust.
  A name forgotten any way but your own `plugins remove` keeps where it led, so a link
  put back somewhere else still shows both places and `plugins trust` still asks.
  `plugins install` from your terminal trusts what it installed and says `installed and
  trusted`; run by the assistant's command it says `installed, not trusted`, and is.
- **A memory the app did not write is not sent.** The app keeps the hash of each fact
  file as it wrote it (through the assistant's `memory` tool, or a plugin's use of the
  memory) or as you accepted it. A fact file that was changed or added some other way is
  left out of every request, out of the `memory` tool's and a plugin's list, and out of
  the index file `memory/MEMORY.md`, and `/memory` shows it as `changed outside
  flow-assist` — its text, and the line a request would carry for it (its name and
  description, which is what the assistant reads). `/memory accept <n>` (or `all`) sends
  it again exactly as that listing showed it — `all` is the facts changed outside that
  that listing showed, so after `/memory project` it never takes a global one: if a file
  changed since, nothing is accepted and the list is shown again. What an older version kept in `memory.json` is
  accepted with the first start; a `memory.json` that turns up after that is moved into
  files as usual, but its facts wait for `/memory accept`. The assistant's working files
  (`artifacts/`) are never sent; it reads them only when it asks for one.
- **The first start, and a record that cannot be read.** Both records are files in the
  app's own directory, `plugins.trusted.json` and `memory.accepted.json`. The first start
  after upgrading — with no record at all — trusts the plugins already enabled and
  accepts the facts already stored, once, and the start screen says so: it names the
  plugins it trusted, and says the memory record is missing. So deleting either record
  shows on the next start's screen. A memory record deleted while the app runs sends no
  fact at all from then on, and the chat says so; only the next start's pass accepts
  facts again. After that, a `plugins-enabled/` directory or a memory directory the app
  meets for the first time (starting from another install, another `workspace.dir`)
  starts with nothing trusted. A record that is there but cannot be read — emptied,
  cut short, not the app's shape — trusts and accepts nothing, and the start screen
  says so: trust plugins one by one with `plugins trust` and facts with `/memory
  accept`, and the app writes a new record, keeping the old text beside it.

A command the assistant runs carries the same marker as for the settings: from there,
`flow-assist plugins trust` is refused, `plugins install` installs without trusting, and
nothing the app does in that process updates either record.

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

The plugin and memory records are the same, with the same limits: a command can rewrite
them, or take the marker off. A record that is damaged fails closed — nothing is trusted
until you say so — but one that is deleted makes the next start a first start, which
trusts or accepts whatever is there then, a plugin or fact the command put there
included — the start screen says it happened, and nothing stops it; so does a record
rewritten to look like one from before the first start (`{"firstStartDone": false}`). Beyond that, trust in a plugin is
where it lives, not what its code says: a command that edits the code inside a trusted
plugin's directory is not caught, nor one that writes into a trusted plugin's
repository. A fact file the assistant reads by its path with `workspace_read` reaches
it as data, whether or not you accepted it.
