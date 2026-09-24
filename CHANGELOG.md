# Changelog

What each version of flow-assist brought, newest first. The version is the one in
`package.json` (and `hostVersion()`, which a test keeps equal to it).

## Unreleased

- **A tool can show the assistant images it fetched itself.** The screenshots attached
  to an issue, a design, a chart: a tool that has them returns them beside its text,
  and the assistant sees them — inside the tool result on Anthropic's API, in a
  message right after the tool's results on an OpenAI-compatible one — under the same
  limits as your own attachments (`ai.images.maxBytes` per image, `ai.images.maxPerMessage`
  per result, refused with a note and never shrunk; with `ai.images.enabled false` the
  text goes and a note says the images did not). The chat shows one row per image
  under the call, `▣ shot.png · 400×300`, never the image; the images stay in the
  conversation as attachments do — in full until a batch stubs them, then as a stub
  `recall` reads again — and the session keeps a ref into the host's own image store
  (`images/` in the config directory, the oldest pruned past 200), never the bytes.
  Your rule stands: nothing the assistant reads can make the host open a file or a URL
  as an image. On Anthropic's API a recalled image now goes inside its tool result as
  well. **For plugin authors:** return `{ text, images: [{ bytes | base64, name }] }`
  and mark the tool `returnsImages: true` (docs/plugins.md, "A tool can return
  images"); an undeclared tool's images are dropped with a note. The host API number
  is unchanged.
- **Bulky content is sent once, then as a stub the assistant can recall.** An attached
  image, the output of a `!command` and a tool result over 4 KB stay in the model's
  history for good and used to ride every later request in full — a screenshot re-sent
  with every message. Each now goes in full in the turn it arrives in and, from a later
  batch on, as one line naming an id — `[$ brew update — exit 0 · 24.7 s · 120 lines —
  recall("out:7d41e0aa")]` — that the new `recall` core tool reads again for one turn,
  an image as an image. Ids are hashes of the content, so identical content shares one
  and they survive `/compact`, `/resume` and a restart; the screen and the session
  keep everything in full. Stubbing happens in batches (every eligible item at once
  when the context passes `ai.recall.threshold`, half the window, or every
  `ai.recall.everyTurns` turns, 10), since replacing old content costs one prompt-cache
  miss. `/context` says how many items are stubbed and how many were recalled this
  turn. `ai.recall.enabled: false` sends everything in full, as before; `ai.recall.
  minChars` is the size that makes a tool result bulky. **For plugin authors:** a
  tool's `ctx` gains `attachImage({ ref, url })` — an image to send beside the result in
  the rounds that follow — and a large result of yours may reach the model as a stub
  on later turns; what the tool returned is unchanged.
- **The chat's field completes more than a command's name, and shell mode says where
  it runs.** In `!` and `!!` mode the hint row under the field starts with the shell's
  directory (`~`-shortened, cut from the left when long), so `!cd` is seen to take
  effect before the next command. Tab there completes the word being typed as a path
  under that directory, as a shell does — a unique match filled in, a directory with
  its `/` (Tab again walks into it), several walked in turn with the others named
  beside the field; hidden entries only for a word that starts with `.`, nothing
  outside `shell.roots` by real path (a link that leads out is not offered). A chat
  command's argument completes from the values it takes — `/notes step|open`, `/mode
  panel|window|full`, `/auto reads|all|off`, and `/resume` the saved sessions by
  number with each title said beside it. All of it is drawn as the `/command` name
  already was: the untyped rest after the caret, `⇥ a · b` for the rest. **For plugin
  authors:** a `:` command may declare `values` — a list, or a function returning one,
  each value a word or `{ value, label }` — and the `:` line completes its first
  argument from them (docs/plugins.md, "Commands, keys and the footer"). Optional; the
  host API number is unchanged.
- **A plugin is given `{ ui, host }` instead of `ft` — host API 2.** **For plugin
  authors — every plugin must change:** each hook of the shape (`components[slot]`,
  `setup`, `keycaps`, `chatContext`, `chatSubject`, `afterWrite`) receives
  `{ ui, host }`. `ui` holds what React and flowtty ship, unchanged: `h`, `useState`,
  `useEffect`, `useRef`, `useInput`, `Box`, `Text`, `Markdown`, `Table`, `Link`,
  `ScrollBox`, `Select`, `ListSelect`, `ListMultiSelect`, `Checkbox`, `TextInput`, and
  `isPrintable` — whether a key types a character. `host` holds what
  the host implements: `services` (`host.services.showMessage(…)`, `pushLog`,
  `chatLLM`, …), `store`, `config`, `keys`, `keyCap`, `useInputHandler`,
  `useSurfaceSize`, `useTerminalSize`, `notify`, `viewRegistry`, `commandRegistry`,
  `helpFor`, `copyToClipboard`, `pluginToken`, `hostApi`. There is no `ft`: `ft.h` is
  `ui.h`, `ft.services` is `host.services`, and so on by that table. A plugin
  declares `"hostApi": 2` and a `flowtty` range in its manifest; one that declares
  neither reads as host API 1 and is not loaded. A plugin that is a single file has no
  manifest, and so is not loaded either — make it a directory with a `manifest.json`.
- **Plugins say what they are built for.** **For plugin authors:** `manifest.json`
  takes `hostApi` — the host API numbers the plugin works with, a number or a list —
  and `flowtty`, a semver range of the flowtty its screens need. A plugin this host
  cannot run is not loaded, and said so: `plugins ls` shows `incompatible: built for
  host API 1, host provides 2` or `incompatible: needs flowtty …, host has …`, the log
  has a line, and `plugins install` refuses it. No `hostApi` reads as 1; no `flowtty`
  is loaded with a note. `host.hostApi` is the number the host provides. It goes up
  on any change to what the host gives plugins that a plugin would break on, and this
  page says what to change each time.
- **flowtty 1.0.0-alpha.28.** **For plugin authors:** `ui` offers flowtty's
  pickers — `ui.Select`, a dropdown (the host keeps the `<DialogHost>` its popup
  needs), and `ui.ListSelect` / `ui.ListMultiSelect`, the inline lists. flowtty
  renamed those lists in alpha.24 with no aliases: its old `Select` is `ListSelect`
  and its old `MultiSelect` is `ListMultiSelect`, props unchanged, and `Select` is
  now the dropdown — a plugin that took the old names from flowtty must rename them.
  They hear flowtty's own input, so a plugin gates them with `isFocused` from
  `host.hasKeyboard()` — false while the host has the keyboard (docs/plugins.md).
  While a dropdown is open every key is its own: Ctrl+] waits for it to close, and
  Ctrl+C still takes two presses. flowtty's components take the keys they act on — a focused `ListSelect` takes what
  is typed as its filter, so `F` or `:` do not reach the host while it has the focus.
  The host's own chords (Ctrl+], the collapse key, the exit keys) are heard before any
  component, and the host's other keys after them, whenever the plugin's screen was
  opened — so no picker in a plugin's screen can keep the person from the chat, and a
  focused one is never beaten to its keys by the host. Ctrl+] and the other control
  chords arrive as chords (`{ name: ']', ctrl: true }`), so a plugin that matched the
  raw byte matches the chord instead. Declare flowtty as the one alpha you built
  against — `"flowtty": ">=1.0.0-alpha.28 <1.0.0-alpha.29"`.
- **A stray `console.log` no longer lands on the screen.** What a plugin, a library or
  React prints through the console while the app runs goes to the log (`L`) at once,
  as `[console] …`, `[console.warn] …` or `[console.error] …`; the last 200 such
  lines are printed to stderr when the app exits. The log keeps its last 2000 lines.
- **The chat is a panel beside the plugin's screen.** It used to be a window over the
  screen, so the board the assistant was told about was hidden from the person talking
  about it. Now it is docked to the right by default (at the bottom on a terminal under
  120 columns; as a window on one too short for a panel and the plugin's screen both)
  and the plugin's screen is laid out in the rest. A question or a y/n is always shown
  whole — a bottom panel grows to it, or the chat is a window until it is answered. In
  a small panel the field is never squeezed: the assistant's plan folds to one row
  (`plan 2/3 · <item>`) and unfolds when there is room. Ctrl+] moves the
  keyboard between the two, the side that has it is marked, and the chat goes on
  answering while the plugin has the keys. Ctrl+\ folds the panel away and back — a
  running turn's status then sits on the plugin's bottom row, or on the one row a
  bottom panel keeps — and so does Esc Esc, which hands the keyboard to the plugin.
  Folding the chat away (or closing a window with Ctrl+]) never answers a y/n or a
  question for you: it waits, the folded chat says `? waiting for you`, and it is
  back when the chat is. Both keys are the host's before any plugin's, take only a
  chord (a key that types is refused and the default kept) and leave an open `:` line
  alone. `/mode window` brings the window back
  and `/mode full` gives the chat the whole terminal; `plugins.assistant.mode`,
  `panel.side` and `panel.size` set it from the start.
  **`/fullscreen` is gone** — it is `/mode full`; a config that says
  `plugins.assistant.fullscreen: true` is read as `mode: full`.
  **For plugin authors:** a surface may be given less than the terminal.
  `host.useSurfaceSize()` and `host.useTerminalSize()` report the plugin's side of the
  screen, and a modal laid out by them stays on it; a plugin that sizes itself by
  flowtty's own `useTerminalSize` still sees the whole terminal.
- **Cache usage is no longer invisible.** `/context` now has a `last request: …
  prompt · … from cache · … written to cache` line — the last request's cache
  breakdown, from either wire (Anthropic's `cache_read_input_tokens` /
  `cache_creation_input_tokens`, an OpenAI-compatible server's
  `usage.prompt_tokens_details.cached_tokens`) — with a part left out when the
  provider did not report it, and a plain note when it reported none at all. The
  session keeps it too: its `usage` and each turn's own message carry the cache
  figures, so a saved chat still shows where its tokens went, not only how many.

- **`!!` error messages no longer show the temp command file's path.** `!!asd` used to
  print `/var/folders/…/fa-tty-x/cmd: line 1: asd: command not found` — the shell's
  `$0` was the temp file it ran the command from. It now reads `!!: asd: command not
  found`.

- **A tool result over `ai.toolResultMaxChars` (default 40000) is cut before it joins
  the assistant's history.** A tool can return arbitrarily much, and it stayed in the
  conversation forever, costing tokens on every later request. A longer result now
  keeps its head and a short tail, with a note in between saying how much was cut and
  asking the tool for less — a filter, a limit, one item. Only what is sent is
  capped: a command's own block and the tool trail still show what really happened. A
  tool may declare its own higher cap for a result that is large and worth the
  tokens, up to a hard ceiling.
- **`tools_load` accepts a tool name qualified with its group** (`plugin:tool`), not
  only the bare name the index shows — the index reads naturally either way, and a
  model that qualified it used to lose a whole round to `ERROR: Not in the list`.

- **`!!command` runs a program that needs the terminal, and asks the assistant about
  it.** `!command` captures what a command prints, so a prompt, `git add -p`, `top` or
  a login flow could not run there. `!!command` gives the program the whole terminal
  and takes it back when the program ends. It has its own level of the chat field's
  bang prompt: `!` on an empty field enters shell mode (`! `), `!` again on the
  still-empty field steps to interactive mode (`!!`) — the same way Backspace steps
  back down, one bang at a time — so Enter always runs the field exactly as it reads,
  with no more guessing a leading `!` in the text meant `!!`. What the program printed
  is recorded with `script` — colours taken out, a progress bar in its last state —
  and shown like any command's output, marked `interactive`; then, whenever something
  was recorded, the assistant is asked at once to look at it. A full-screen program
  (`vim`, `less`, `top`) leaves nothing to look at, and without `script` nothing is
  recorded: then nothing is asked. Whatever
  the program echoes — a value typed at a prompt that shows it back — is recorded,
  sent to the assistant and saved with the session.

- **A message sent from the queue no longer undoes what just ended.** Under load, a
  message queued during a `!command` could put the finished command back into its
  running state (its seconds ticking forever), and one queued during an answer could
  cut that answer's last words.

- **The assistant knows what is on your screen.** A plugin can now describe what its
  screens show — a board with its filter and cursor and the issue open beside it —
  through a new hook, `chatContext`, as a list of items with a label and a text. Before
  every request the assistant is given them in a block of its own, `What the person
  sees now`, marked as data from outside systems and never as instructions; it follows
  the screen from one request to the next and is never stored in the conversation or
  the saved session. `/context` counts it as `on screen`. The chat's title shows the
  items' labels (`ƒ Flow Assist · Board: Frontend · Issue ABC-1`).

- **Opening the chat on another screen no longer starts a new conversation.** It used
  to switch to a fresh session whenever the plugin's subject changed, and the dialogue
  seemed lost. Now the conversation continues and only what the assistant sees of the
  screen changes; `/clear` starts a fresh one. `chatSubject` still works for this
  release, read as one item with no text, and is deprecated — move to `chatContext`.

- **Ctrl+C stops the answer, and quitting takes a second press.** Ctrl+C used to end
  the app at once, even in the middle of an answer, and Ctrl+Z to suspend it with a
  request in flight. Now Ctrl+C while an answer or a `!command` runs stops it, as Esc
  does. When nothing runs, the first Ctrl+C says `^c again to exit` and a second within
  two seconds quits; any other key takes it back. Ctrl+D on an empty field does the
  same, and Ctrl+Z says `^z again to suspend`. This holds on every screen, not only in
  the chat.

- **Esc stops the answer on the first press, even with a message waiting.** With a
  message queued and a tool running, the first Esc used to take the message back, the
  second cleared it (the message was lost), and only the third stopped the tool. Now
  Esc stops it at once. A stopped or failed answer no longer sends the waiting
  messages: they come back into the field in order, ahead of anything you had typed
  meanwhile, and you decide what to send. ↑ on an empty field takes the last waiting
  message back to edit (the hint says `↑ takes it back`).

- **`/compact` leaves one row, not the whole summary.** The note it left in the chat
  was the summary itself, often dozens of lines. It is now one separator row,
  `── compacted · ~58k → ~2.1k tokens ──` — how big the model's view was and is now —
  with the summary folded under it: a click or `^o` opens it. A conversation saved
  before shows its old note as it was.

- **`/compact` leaves the field at once.** It stayed in the field until the summary
  came back, as if it had not been sent. Now the field empties the moment you press ⏎
  (↑ brings the command back), a draft typed meanwhile is left alone, and a message
  queued behind it goes out after it — or comes back into the field when you stop it.

- **↑ repeats `/commands` too.** `/notes step`, `/compact`, `/resume 2` go into the
  ↑/↓ history like every other line you submit, as `!commands` and lines typed in
  shell mode already did (they come back in shell mode), and the history is saved with
  the session. A command
  whose argument may be a secret stays out of it: the `:config` command, and a
  plugin's command that declares `history: false`.

- **Anthropic's own Messages API: `ai.provider anthropic`.** Claude models were
  reachable only through Anthropic's OpenAI-compatible endpoint, which drops what the
  native API gives. With `config set ai.provider anthropic` and a Claude model id
  (`claude-sonnet-5`, `claude-opus-5-5`) the chat, `/compact`, a background task and
  the one-shot prompt talk to `/v1/messages`: the token comes from `ANTHROPIC_API_KEY`
  and the base URL defaults to `https://api.anthropic.com/v1`. The tools, the
  system prompt and the turn so far are cached between requests (and `ctx N%` counts
  the cached part);
  tool calls and results go natively; the model's thinking shows in the chat's
  thinking fold, and its blocks are sent back unchanged while a tool loop runs.
  New keys: `ai.maxTokens` (the cap on one answer, 8192) and `ai.thinking`
  (`{"adaptive":true}`, or `{"budgetTokens":N}` for older models). A saved
  conversation reads the same under either provider. Without `ai.provider` nothing
  changes.

- **The roots have a key per owner: `shell.roots` and `plugins.repo.roots`.** The
  directories `!command` and `run_command` start in and stay inside, and the ones
  `repo` may touch, were one host key, `fs.roots`, although only `repo` and the shell
  read it. The shell now reads `shell.roots`; `repo` reads `plugins.repo.roots`
  (`config set` checks it against repo's own settings) and, when that is not set,
  `shell.roots`. `fs.roots` keeps working for this release as the fallback of both,
  and the log (`L`) says once where to move it: `config set shell.roots '[…]'`.

- **The bundled plugins carry the host's own version.** `gitlab`, `mcp` and `repo`
  said `1.0.0` while the host was `0.1.0` — they ship from this repo, with this
  release, so a `repo-1.0.0.tar.gz` beside a `0.1.0` host read like a mismatch. A
  test now keeps every bundled plugin equal to `hostVersion()`, naming the one that
  drifts. Installing an archive over an already-installed one now says what it
  replaced when the version changed (`plugin 'notes' v0.2.0 replaced (was
  v0.1.0)`).

- **The status line says a word of its own while the model works** — `Pondering…`,
  `Brewing…`, `Tinkering…` — one picked for each request and drawn with the same
  shimmer as a running tool; magenta while it thinks, green while its text arrives.
  `writing…` is gone: it read as a promise of text that was not there yet.
  `config set ui.verbs '["Thinking"]'` puts your own words in.

- **A provider's refusal reads as a sentence.** A failed request used to show the
  provider's raw JSON — `LLM 403: { "message":"model_access_denied", "request_id":… }`.
  It now says `LLM 403 · <model>: model_access_denied (request 2395f0a1)`, and for a
  refused token or model adds what to check. `/compact` failing says why too, where it
  used to say only the status.

- **A turn reads in the order it happened, and nothing it wrote jumps away.** A turn
  used to be laid out by kind — what the assistant said, then every diff, then the
  answer — so text that turned out to come before a tool call moved up above all the
  diffs of the turn. With a tall diff it left the screen, and the chat looked as if
  text had been lost or a file written twice. Now what it said, each diff and the
  answer stand in the order they came, and a round's text stays where it was drawn:
  dim, with a spinner beside it, until it is known to be the answer, which then gets
  its `ƒ`. What it said between tool calls folds to one quiet line per stretch —
  a diff, a command or calls it made without a word end a stretch — showing the
  latest thing it said and how many steps there were (`▸ Now the tests.  (3 steps)`,
  no count for one); a click opens that stretch where it stands, with the calls each
  step made, `^o` opens them all. The tool calls are where they were made too — the
  one trail under the answer is gone; under the answer stay only the seconds and the
  cost. `/notes open` shows every step in the normal colour. The `Next:` the assistant
  writes before a tool call is never shown — the sentence after it is — while an answer
  is shown exactly as written. `/notes fold` and `/notes hidden` are gone — a config
  that still says either reads as the default — and so is the separate step line above
  the answer. Sessions keep the new order; older ones still open, their trail as one
  line before the answer. A round whose text and tool call
  arrived together could also be lost, depending on how the network split the reply;
  it is kept now.

- **Scrolling the chat is about twice as fast.** The app ran React's development
  build — Bun leaves `NODE_ENV` unset, and React takes that as "development", with
  checks and bookkeeping on every render. `flow-assist` and `bun src/cli.ts` now run
  the production build unless `NODE_ENV` says otherwise, and `bun run build:binary`
  compiles only the production build into the binary.

- **A scroll step redraws only what moved.** Every wheel step or PgUp used to
  re-render every row near the screen and paint the scrollbar twice; now a small step
  re-renders nothing and the bar moves with the rows. Needs flowtty 1.0.0-alpha.22.

- **flowtty 1.0.0-alpha.23.** A double click selects a word and a triple click a line,
  copied like any selection; Ctrl+Z suspends the process (`fg` resumes it, the screen
  and the conversation intact).

- **Two flow-assist processes no longer silently clobber one session.** A session
  held by a live chat now has an ownership lock: a second process starting up, or
  `/resume`, leaves a session another live instance holds alone (starts or stays on
  its own, with a note naming the lock file) instead of continuing it and racing
  the first process's saves; a lock whose owner is gone (or a corrupt lock file
  older than five seconds) is taken over. And a save that finds the file changed on
  disk since it last read or wrote it — an older host with no lock, a hand edit —
  no longer overwrites that change: it saves the conversation as a new session
  instead, so nothing is lost either way. The check is not the rev counter alone
  (a hand edit that leaves it untouched, or two rev-less writes from an old enough
  host, would slip past that) but the file's own size and modified time too — taken
  with a stat before a resumed or continued session's content is read, never after,
  so a write landing in between is caught rather than quietly recorded as seen.

- **A tool call with broken arguments no longer breaks the conversation for good.** A
  reply cut off mid-argument used to be stored as it arrived and run as `{}` anyway —
  every later message then failed the same way, since the provider rejects a history
  carrying invalid JSON, and `/clear` was the only way out. It's now refused at the
  call (the model is told why, and asked to call it again) and repaired if it's
  already sitting in a saved session.

- **A command shows its output while it runs: one line in the chat that a click opens to its last lines, and that stays — as you left it — once it ends.** The person's own `!command` too — its block still shows where it ran, and where a `cd` inside it left the conversation's directory.

- **A finished command, folded, is one line saying how it ended:** `✓ 4.2 s`, `✗ exit 1`, `stopped`, `timed out`.

- **Consecutive commands fold under one line,** `Ran 3 commands · ✓ 34.0 s`, **and open into their own blocks.**

- **Plugins: `viewRenderers` and `ctx.liveView`** — a tool can show a block of its own and update it while it runs. See `docs/plugins.md`.

- **The command line can be copied at last.** A drag over `:` picked up nothing: the
  whole bottom row was marked "not text", which is right for the prompt and the
  completion offered after the caret and wrong for the command you typed — so a long
  `config set plugins.mcp.servers.safari.readOnly …` could not be taken out to be
  fixed or shared. Dragging over it now copies exactly what you typed: no `: ` in
  front of it, nothing of the greyed-out offer after the caret, nothing of the `⇥ a · b`
  candidates beside it, and nothing of the hints or the message that have that row when
  the line is closed. The drag stays on its row, so it picks up nothing of the screen
  above either. The chat's own field is unchanged for now — its caret and placeholder
  sit in the middle of the text, which needs its own answer.

- **The tests no longer write into your memory, or empty your cache.** If you found
  the same fact in `/memory` over and over — "This repo prefers rebase over merge",
  thirty-odd times — nobody stored it thirty-odd times: the host's own test suite did,
  once per run. A test that booted the assistant and let it use its `memory` tool named
  no file of its own, so the entry landed in `~/.config/flow-assist/memory.json`, and
  the same went for `cache.json`, which a test emptied and rewrote. Under a test run
  the host now keeps what it writes for itself in a temporary directory, the cache
  keeps its store in memory, and each booted test gets a memory file of its own.
  Nothing already stored was touched: `/memory` lists what you have and
  `/memory forget <number>` or `/memory forget all` removes it — your file, your call.

- **The assistant is told how to write a memory, and the host holds it to it.** Every
  stored fact is sent with every later request, across `/clear` and across restarts,
  so a sloppy one is paid for forever. The `memory` tool now asks for one durable fact
  per entry — a preference, a convention, a name — in a short sentence that stands on
  its own, never the state of a task, a number that will change or a secret; and to
  update the entry that already says it instead of adding a near-copy. Three of those
  the host enforces rather than hopes for: the same fact in other spacing or case is
  refused, naming the entry it duplicates; an entry over 300 characters is refused with
  its length; and past 100 entries it refuses and names the oldest, so the memory
  cannot quietly grow into every future request. Each refusal says what to do instead,
  and `/memory` stays your own way to see and prune the list.

- **Click what you want to read.** Everything the chat folds answered to one key, and
  it opened EVERYTHING at once: to read the output of one command you unfolded the
  whole conversation and folded it back. Now a click opens the block under it — the
  `▸ N tools` line of a turn, the quiet line of narration, a command's
  `… N lines cut` — and a click anywhere inside an open block closes it again. A drag
  is still a selection: only a press and a release on one cell, with no drag between
  them, counts as a click, so copying text out of an open block never folds it. A
  block opens at its FIRST row, where reading starts, instead of dropping you at its
  end; closing one leaves the line you were on where it was. Nothing else on the
  screen became clickable. The key is now **`^o`** and it is the master switch: with
  anything folded it opens everything, pressed again it closes everything, and either
  way the blocks you clicked go back to following it — so there is always one
  keypress back to a screen you can describe. It is a bound action at last
  (`config set keys.details <key>` moves it, and every hint draws the key you bound);
  `^r`, which it used to be, still works and is in no hint any more.

- **A long tool trail is no longer a sheet of grey.** A turn that ran to the round
  limit printed one dim line per tool call — dozens of them — and what you needed,
  that the turn had ended without an answer, was somewhere in the middle. Consecutive
  calls of the same tool are now one line with a count (`read_file ×12`; the arguments
  are in the log, `L`), an open trail shows its last twelve lines with
  `… N earlier calls` above them (click that to see the rest), and the folded summary
  says what each tool cost in calls. When a turn stops because it ran out of rounds,
  it says so where the answer would be, in the warn colour:
  `stopped after 64 rounds — no answer; say "continue" to carry on`. A write that
  happened and a call that failed still each keep a line of their own — that is how
  you know why an answer is thin.

- **What a write changed reads like a diff again.** The block carried a dim `diff`
  label row under a line that already said this was a change to a file (and a
  `console` row under the `$ command` line that said it better) — both are gone, while
  the fence keeps its language, which is what colours a diff green and red. The `✎`
  title is a title now: plain text with the path in the chat's accent colour and
  `· +N −M` quietly beside it, instead of a fragment of inline code. And every row
  carries **the line it is in the FILE** — a context or added row its number in the
  new file, a removed row its number in the old one, counted again per hunk — so the
  `@@ -1,3 +1,3 @@` row could go. The numbers are chrome: dim, right-aligned, and out
  of a selection, so a drag still copies the code alone.

- **What you were reading is never taken away.** While a round streamed, its text was
  drawn as the answer — the chat could not know yet whether the round would end with a
  tool call — and when it did, the paragraph you were halfway through was
  reclassified as narration and vanished into the line above. A blink, and a lost
  sentence. A line that starts `Next:` is now narration from its first characters and
  is never drawn as answer text; a round that turns out to carry tool calls keeps
  whatever of its text was already on screen, dimmed where it stands, instead of
  disappearing. The answer is only ever added to.

- **One line instead of the folded notes: what it is doing now.** Between tool calls
  the assistant writes prose, and every answer carried a dim `▸ notes` header with the
  last two lines of it — a header for text that is mostly noise, with the one thing
  worth seeing, what it is about to do, hidden inside the fold. In its place there is
  now one quiet line: the last thing it said it is doing, cut to the width. It changes
  only on a finished sentence and at most once a second, so it settles instead of
  flickering, and the answer's own text never appears in it. `^r` still shows
  everything it said, word for word, and a drag over the answer copies the answer, not
  the line. A turn that said nothing on the way draws no line at all. The assistant is
  also asked for less: before a tool call, one short line starting `Next:` and nothing
  else — so there is one sentence per step and far less to fold. If you preferred the
  old look, `config set plugins.assistant.notes fold` brings it back, `open` shows the
  narration unfolded and `hidden` puts none of it on the screen once it has been
  written; `/notes [step|fold|open|hidden]` changes it for the conversation you are in.

- **A command you confirmed shows what it printed.** You said yes to a `run_command`,
  it ran on your machine, and all you saw of it was one dim line under `^r` — while
  your own `!command` shows its whole output. It now leaves the same block in the chat:
  the `$ command` line, what it printed, and `exit 0 · 1.2 s · ~/dir` under it. The
  last 20 lines stand there (`config set plugins.assistant.runOutputLines 40` for
  more), with `… N lines cut · ^r for all` when there was more and `^r` showing all of
  it. A command you declined leaves nothing — it never ran; one that failed shows what
  it printed before it died, with its exit code. The block is yours alone: the
  assistant reads the output through the tool's own result and is never sent a copy of
  it, so the conversation does not pay for it twice. Under it, a tool can now describe
  how its result should be SHOWN and the host draws the block — the first of several
  kinds to come.

- **The status line times the thing that is running, and says what the turn costs.** A
  turn that ran a build sat at `3m 12s`, which told you nothing about what was
  happening. The seconds are now the running thing's: a tool's while it runs
  (`⚙ run_command $ bun test… 8.1s`), the assistant's current round when none does, and
  they start again with the next tool. The turn's own total stays where it is read
  afterwards — the quiet line under the finished answer — and that line now also says
  what the turn cost: `· 12.4 s · ▸ 3 tools · 3.1k tok`, the tokens the provider
  reported for it, on the status line as it runs and under the answer when it is done.
  A provider that reports nothing shows no figure, never a guess.

- **Answering the assistant's question: just type, and the field is a real field.** A
  question with options used to take typing only after you walked to its "Other…" row;
  any printable character now opens the free-text field with that character already in
  it, while `1`–`9` still pick an option (the hint line says so). And that field is the
  chat's own editor at last: a visible caret, caret motion by character and word,
  Home/End, the kill bindings — and a paste goes in at the caret, where it used to be
  dropped entirely, so a path or a ticket's text can finally be given as an answer. It
  is one line, so a pasted line break becomes a space. Esc still leaves the field for
  the list, and Esc on the list still dismisses the question.

- **Stop confirming for a while: `⇧⇥` and `/auto`.** A long working session is a long
  series of y/n. Shift+Tab steps the chat through three modes — ask (where every
  conversation starts), `auto: reads` (only what the assistant itself reads runs
  unasked, every write still stops) and `auto: writes` (a write runs too) — and
  `/auto reads|all|off` says the same in words. The mode is on the hint line the whole
  time it is on, while an answer is coming as much as between turns, and it belongs to
  the conversation alone: a restart, `/clear`, `/resume` and a change of task all put it
  back to asking, and it is never written to the session file. Two things are never
  automatic, whatever the mode: `run_command`, whose y/n is its only guard, and a
  `web_fetch` to a host that is not on `web.allowlist`. A background task declines
  writes as before, and your own `!command` is unaffected. What ran without being asked
  about is still shown — the `✎` diff block and the tool trail are unchanged.

- **Tell the assistant which of a server's tools only read.** `config set
  plugins.mcp.servers.safari.readOnly '["list_tabs","page_info"]'` — the tools of that
  MCP server you have checked yourself, by the names the server uses; each of them runs
  without a confirmation. It is your claim, and it stands on its own: `trusted` is the
  other, narrower one ("I believe this server's own `readOnlyHint`"), and a server that
  makes no claims at all — a browser's does not — could not be helped by it. Everything
  else is unchanged: still a y/n, still declined in a background task. A name the server
  does not offer is said once in the log at start, so a typo does not sit there quietly
  doing nothing.

- **The running tool's name carries a band of light**, instead of the whole word
  changing colour four times a second, which read as blinking. Needs flowtty
  1.0.0-alpha.21.

- **The chat stays quick however long the conversation is.** Typing grew slower with
  every turn — a keystroke took 13 ms in a fresh chat, 75 ms after 40 questions and
  144 ms after 80, and an answer arriving paid the same for every word it wrote, so a
  long conversation stuttered as it came in. The conversation now lays out only the
  rows on screen, and a keystroke costs the same at any length. Needs flowtty
  1.0.0-alpha.20.

- **An MCP server can be a command now, not only a URL.** `config set
  plugins.mcp.servers.safari.command /usr/bin/safaridriver` and `… .args '["--mcp"]'`
  give the assistant Safari's 17 tools — the tabs, the page, a screenshot — and any
  other server that speaks MCP over stdin and stdout works the same way; `env` passes
  it variables, `${VAR}` and all. The process starts with the assistant and is stopped
  when it ends: on `:quit`, on Ctrl+C, on SIGTERM, and when a one-shot command has done
  its work. One that does not answer the handshake in time is stopped and skipped, as
  an unreachable URL is; one that dies is not restarted, and its calls then say which
  server it was and what it last wrote to stderr. Tools a browser offers carry no
  read-only claim, so even a `trusted` server asks before every call — Safari holds
  your logged-in sessions.

- **The installed binary finds its plugins from any directory.** Started as
  `./kit/flow-assist` from somewhere else, it looked for `plugins-enabled/` in the
  working directory, found none, and ran with the host's own tools only — saying
  nothing. It now looks beside itself (following a link to the binary), and the
  working directory is only the last resort. A `.env` beside the binary is read too,
  and never overrides a variable already set in the environment. When no plugin is
  enabled, the start screen, the log, `plugins ls` and a one-shot prompt say which
  directory was searched.
- **`tools_load` takes a group's name among `names`.** `tools_load({ names: ["web"] })`
  was refused as "not in the list" by an error that listed `web` as a group; it now
  loads the group. A tool of the same name still wins.

- **Show the assistant an image.** Drag a screenshot onto the terminal (or paste its
  path — quoted, `\ `-escaped, several at once), type `/image <path>`, or press Ctrl+V
  for the image on the clipboard (an empty Cmd+V paste does the same; macOS uses
  pngpaste or osascript, Linux wl-paste or xclip). The image becomes an `[Image #N]`
  token in your message: Backspace takes it away whole, the numbers go on for the
  whole conversation, and ↑ brings a message back with its images. It is sent as an
  image part (OpenAI-compatible) and stays in the model's view until `/compact` or
  `/clear`. PNG, JPEG, GIF and WebP, told apart by their bytes; up to 5 MB and 4 a
  message (`ai.images.maxBytes`, `ai.images.maxPerMessage`) — a larger one is refused
  with the reason, never shrunk. The session keeps the file's path and hash, not the
  picture; after a restart it is read again, and a file gone or changed is said in
  the chat and the text goes without it. `ctx N%` counts an image by its pixels. A
  model that cannot take images: `config set ai.images.enabled false`; when a provider
  refuses one, the chat quotes it once and names that command.

- **A turn stopped with Esc stays stopped.** The next message used to be answered
  together with the stopped one — the model went back to the work the person had
  interrupted, because to it the stopped question was still waiting. Now the model's
  history records the turn as stopped and not to be resumed unless asked, and keeps
  the tool calls that finished before Esc (a write that landed is no longer forgotten).
  A turn that fails is recorded the same way, as a failure, so asking to try again
  works as expected.
- **Your message is shown as you typed it.** A message written over several lines
  (⌥⏎, ⇧⏎ or `\`⏎) was drawn as one line, an indent was lost and `- a` became a
  bullet; now every line, blank line and leading space is kept, nothing is read as
  markdown, and a drag copies it back with its line breaks. What the model was sent
  never changed.

- **Tools on demand.** A request no longer carries the full definition of every
  enabled tool. It carries the core tools (`todo`, `ask_user`, `memory`, …) in full and
  an index of the rest — each tool's name and one line, grouped by plugin — and the
  model loads what a task needs with `tools_load`, by name or by group. A loaded tool
  stays for the rest of the conversation: it is saved with the session, kept through
  `/compact`, and `/clear` empties the set. A call to a tool that was not loaded is
  answered with an error that says how to load it. `ctx N%` and `/context` count
  what is actually sent. `config set ai.toolLoading all` goes back to the full list.

- **`/fullscreen [on|off]`** — the chat takes the whole terminal instead of a
  centred window, and its text wraps at the full width;
  `config set plugins.assistant.fullscreen true` starts it that way.

- **Readable on a light terminal theme.** The chat, the log, the help, the reminder and
  the keycaps panel paint a dark ground of their own; their text now takes the
  palette's `text` colour instead of the terminal's foreground, which on a light theme
  was black on black. Needs flowtty 1.0.0-alpha.16.
- **Text being selected with the mouse is readable on a light theme.** The selection
  used to vanish there: dark text on a dark band. The band now takes the colour of the
  text under it. Needs flowtty 1.0.0-alpha.18.
- **Follows the terminal between light and dark, while it runs.** The windows, the
  chat and the keycaps panel take a light or a dark palette by the terminal's scheme
  and repaint when it switches (macOS does at sunset and sunrise); a terminal that
  does not say gets its own background and ink. A plugin's colours written as
  `${token}` follow too. The person's `config.theme` wins over every scheme. Needs
  flowtty 1.0.0-alpha.17.
- **`ft.useSurfaceSize()`** — the room a plugin's surface has between the title bar
  and the command line. A surface sized by the terminal was four rows too tall and
  pushed the command line off the screen.

## 0.1.0 — 2026-09-22

The first version: a terminal assistant host that knows no company and no system,
with everything specific delivered by plugins.

- **Plugins** register surfaces, commands, keys, tool groups for the model, config
  schema, and the two chat hooks — what the screen is about, and a reload after a
  write. Installed from a package registry, from an archive (`plugins install
  ./notes-0.1.0.tar.gz` or its https URL — checked before it is unpacked, and never
  over a checked-out plugin), or linked from a repository of their own; a published
  plugin ships its build (`files` in its package.json names what goes).
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
