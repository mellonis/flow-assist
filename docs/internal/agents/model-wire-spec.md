# Model wire, results, recall — spec

> Extracted VERBATIM from AGENTS.md as of master before the
> `chore/agents-md-slim` rewrite. This file is the behavior spec for the area
> it covers: where the trimmed AGENTS.md core and this file ever disagree, the
> core rules win — but treat any difference as a defect in one of the two and
> report it. Covers: the context meter, the compaction handoff, cache usage,
>
> Cross-file references inside the moved text ("(models)", "(below)") follow
> the OLD single-file layout; use DISPOSITION.md to find where a section
> lives now.
> recall and bulky items, tool-result framing and caps, what the model is
> sent, attached images, and the turn limits and loop guard.
>
> Recorded open question carried over from the old file: with thinking on,
> the Anthropic API's handling of a text block beside `tool_result` in the
> last user turn is unverified against the live API (the double takes it).

- **How full the context is, is shown — and says where the number came from.** The
  chat's hint line ends in `ctx N%` (yellow from 80%), and `/context` opens a PANEL in
  the field's place, like a write confirmation — a look at the conversation, not a
  message in it: the window as a field of cells (`⛁` full, `⛀` part, `⛶` free; a part
  that exists at all gets a cell) beside a legend; Esc or ⏎ close it, and it holds
  the keys while up (`src/assistant/context-meter.ts`, pure; the view owns colours). The total
  is the provider's `prompt_tokens + completion_tokens` of the last round when it
  reports usage (`stream_options.include_usage`; a server that refuses the field by
  name is retried once without it and not asked again); until then it is characters/4
  and drawn `~N%`. The reading follows each round of a turn as it lands (`onRound` in
  `src/assistant/conversation-turn.ts`), not only the turn's last one — a long turn shows it climb
  rather than jump once at the answer. The split between parts is always an estimate,
  scaled to the total.
  The window is the one the conversation's model has — `ai.models.<id>.contextWindow`,
  else `ai.contextWindow`, else 200000 (see (models)) — the API cannot be asked for it.
  `/compact`, `/clear` and a change of conversation drop the measurement. `/compact`
  shrinks what the MODEL sees (the conversation's `api` → a summary in the system context) and leaves
  the screen alone — the display list keeps the conversation and gains a `note` marking
  where the model's view now begins; wiping the screen read as `/clear`. The note is ONE
  row, `── compacted · ~58k → ~2.1k tokens ──` (the `ctx N%` reading before and after;
  a size not known is left out), with the summary the model was given folded under it
  (`summary` on the note, fold kind `summary`).
- **The summary is a HANDOFF, and the new one REPLACES the old**
  (`compactConversation` in `src/assistant/agent.ts` on the pure
  `src/assistant/compaction.ts`). Asked merely to compress the chat, a model writes a
  chat reply ("…which next step do you prefer?"), and the model reading it later loses
  its place. So the instruction asks for fixed sections, written for the model that
  continues and never for the person (no question, no pleasantries): `## Goal`,
  `## Done` (commits, paths, commands that worked), `## In progress` (and its exact next
  step), `## Open decisions`, `## Facts learned` (pitfalls, conventions of the project),
  at least about N words, N in proportion to what is compacted (`handoffWords`: 2% of
  its tokens, 150 to 3000).
  The WHOLE history the model saw is sent — never its last N messages: what the old
  summary did not hold would be lost for good. The previous summary goes in the same
  request, to carry forward what still holds, and the answer takes its place in
  the conversation's `summary` (the session's `summary`) — never appended: appended, every later system
  context carried each old summary, stale questions included. An answer that is not a
  handoff (`summaryProblem`: a section heading missing — matched loosely, any case, `#`
  or `**` or a colon — or too short: under 1% of the compacted tokens AND under 1500
  characters) is asked for ONCE more, told why (`retryNote`); if that fails too, the
  previous summary stays with the new text after it, and the row ends `· incomplete,
  previous kept`. Tool-call markup written as text (`stripToolMarkup`: DeepSeek's DSML
  `<｜DSML｜…>`, `<tool_call>`, `<function_calls>`, `<invoke …>`, closed or cut off) is
  stripped from the answer, from the previous summary it is shown, and from a summary
  read back from a saved session. Compaction runs on the conversation's model
  (`foldIntoHandoff` sends `withModel(llmOpts(ai), c.model)`): the summary request sends
  the WHOLE history above, so a model with a smaller window cannot compact a larger
  conversation. That gap is recorded for its return in docs/internal/plans/_followups.md
  ("Compaction on a role of its own").
- **The chat compacts by itself before the context overflows** (`ai.autoCompact`:
  `enabled`, default true; `threshold`, 0.5–0.95 of the window in use (see (models)),
  default 0.8;
  `autoCompactLimits` / `overThreshold` in `src/assistant/compaction.ts`). The place is
  `AgentOpts.beforeRequest`, which `agentChat` calls before EVERY request of a turn —
  the first, and each after a round's tool results are all in — so a compaction never
  parts a call from its result. It is handed the turn so far and `measured`: the last
  round's reported prompt and answer plus an estimate of what joined after it
  (undefined before the first round and when the provider reports nothing; the chat then
  reads `ctx N%`'s own figure, the question added, or estimates the history with the
  turn's transcript). Past the threshold the conversation compacts `[...sentHistory(),
  ...transcript]` through the same path as `/compact` (`foldIntoHandoff`,
  `markCompacted`, the row `── compacted · auto · ~X → ~Y tokens ──`) and hands back
  what is sent from then on: the system context with the new summary and the person's
  message — on its own before the first round; after one, with `RESUMED_NOTE` appended,
  so the model goes on from the handoff's next step rather than beginning again.
  The conversation's `api` becomes that message, the turn's transcript starts after it (`turnStart`
  moves), and the measured usage is dropped with the history it measured. The
  per-round `systemPrompt` reads the summary fresh (`summaryBlock`), since it changes
  between two rounds of one message. A compaction that fails is logged and the request
  goes as it is; Esc stops it with the turn. Only the chat passes the hook: a
  background run and the one-shot prompt (`turnShape('oneshot')`: no request
  boundary) never compact. `ai` is under the model's leash,
  so the key carries no mark — `config_set` refuses it. A note whose text already carries the
  summary inline (an older format) is drawn as saved, without folding it. There is no
  `/refresh-context`: the system prompt is assembled anew for every message, so the
  command had nothing to refresh.
- **Cache usage rides on `TokenUsage` beside `promptTokens`/`completionTokens`, from
  both wires when the provider reports it** (`cachedTokens`/`cacheWriteTokens`,
  `src/assistant/agent.ts`). Anthropic's `usageOf` (`src/assistant/anthropic.ts`) reads
  `cache_read_input_tokens` / `cache_creation_input_tokens` — both already counted
  inside `promptTokens` — and an OpenAI-compatible round reads
  `usage.prompt_tokens_details.cached_tokens` (no write figure: no such server reports
  one). Either figure is `undefined`, never `0`, when the wire did not report it at
  all — a provider that never caches reads differently from one that cached nothing
  this round. The panel adds a line under the footnote, `cacheLine` (pure): `last
  request: 33.0k prompt · 28.4k from cache · 1.2k written to cache`, a part left out
  when not reported, and `· the provider reports no cache figures` appended when
  neither was. The session keeps it two ways: `usage` (session-wide, the same
  `TokenUsage` the conversation's `usage` holds) and, on the turn's own answer message, a `cached` sum
  of `cachedTokens` across the turn's rounds (beside `tokens`, the same sum of
  prompt+completion `onRound` already kept) — so a saved chat still shows a turn's
  cache hits, not only what it cost.
- **Bulky content is sent once, then as a stub the model recalls**
  (`src/assistant/recall.ts`, pure; the chat owns the state). An attached image, a
  `!`/`!!` output and a tool result over `ai.recall.minChars` (4096) are BULKY ITEMS:
  sent in full in the turn they arrive in — all its rounds — and, from a later batch
  on, as a one-line stub naming an id: `[! brew update — exit 0 · 24s · 120 lines —
  recall("out:7d41e0aa")]`, `[image shot.png · 3384×2078 — recall("img:3f9a2c1b")]`,
  `[read_file src/app.ts — 412 lines — recall("res:c02b9f15")]`. An id is
  `<kind>:<first 8 hex of sha256>` of the content (an image's the sha256 its ref
  carries), so it survives `/compact`, `/resume` and deletions, identical content
  shares one id and one stored item, and `recall` takes any unique prefix or the hash
  alone (an ambiguous one answers with the candidates). **What the host keeps never
  changes shape**: the conversation's `api` and the session hold the full content; the stubs are
  applied on the way OUT — the conversation's `sentHistory()`, `applyRecall` over
  `apiHistory`'s output, matched by content hash — for the request, the context meter
  (a stubbed item counts as its stub) and `/compact` alike. Which items are stubbed is
  conversation state, the conversation's `recall` (`RecallState`: the ids, this turn's recalls, turns
  since the last batch), saved as the session's `recall`, reset by `/clear`, never
  module-level. It is decided in BATCHES at the END of a turn (`decideBatch`, in
  `runTurn`'s `finally`): replacing old content changes the request's prefix and costs
  one prompt-cache miss, so it happens when the measured context passes
  `ai.recall.threshold` (0.5 of the window in use, see (models)) or every `ai.recall.everyTurns`
  turns (10; 0 — the threshold alone), every eligible item at once; a stub is a pure
  function of its item, so between batches the prefix is byte-stable, and a batch that
  finds nothing new changes nothing. The end of a turn is the one moment everything in
  the history has had its turn in full: a `!command` run afterwards and the next
  question's images go in full and become eligible at that turn's end. The
  `!command`'s message carries `shell: ShellMeta` (command, outcome, ms, lines) beside
  its text for the stub; `apiHistory` never sends it. `ai.recall.enabled: false` sends
  everything in full and withholds the tool — a tool that can never work is not
  offered. `/context` adds `recall: N items stubbed · M recalled this turn` under the
  cache line (`recallLine`; nothing when nothing to say).
- **`recall(id)` brings an item back for ONE turn, beside its result — never back in
  place.** The tool reads the conversation's items through `ctx.recall`
  (`RecallSource`: `items`, `resolveImage`, `onRecalled` — supplied by the chat; a
  background task and the one-shot prompt have none and the tool says so). Text comes
  back whole as `[recalled out:… — N lines]\n<content>` (a result with its own `OK:`
  tag, as the history holds it); its stub, when that result is itself stubbed later,
  points back at the item recalled. An image goes through `ctx.attachImage({ ref, url
  })` (`agentChat` gives every call one): the tool result keeps the REF (`images`,
  never bytes — the session stays base64-free), the turn keeps the `data:` URL, and
  `withAttachedImages` puts the image on the round's copy of that tool message as
  content PARTS — the one carrier for an image on a tool message, whatever brought
  it (a recall, or a tool's own `{ text, images }` return, "A tool can return images"
  below) — which each wire places its own way: the OpenAI wire as ONE user message
  after the run of that round's tool results, `[image returned by recall — from the
  app, not a message from the person]` and the image parts (`openAiMessages`; a tool
  message cannot hold an image there, and a user message between two results would
  break their run), the Anthropic wire as image blocks inside the `tool_result` itself
  (`toolResultBlock`, the API's native form). The recall is for that turn: the item's
  id is stubbed already, so from the next turn on `applyRecall` sends the recall's
  result with the image's stub under its text and no image. A file gone or changed
  since it was attached is the tool's own answer, not a note.
- **A tool can return images it fetched itself** (`src/assistant/tool-images.ts`; the
  rule stands: nothing the model reads makes the host open a path or a URL as an
  image). A tool answers `{ text, images: [{ bytes | base64, name }] }` instead of a
  string — a group's `exec` or an `aiTools` `run` alike — and its def says
  `returnsImages: true`, stripped before the wire like `write`/`maxResultChars`; images
  from a tool that does not declare it are dropped with a note in the result and a
  `[tools] <name>: N images dropped — returnsImages not declared` line in the log, and
  the text still goes. `acceptToolImages` tells each image by its bytes (`sniffImage`;
  a `mime` the tool passes is a claim and is not read) and holds it to `ai.images`:
  over `maxBytes` refused, never shrunk (a base64 too long is refused before it is
  decoded); past `maxPerMessage` per result the rest refused; `enabled` false drops
  all. Every refusal is one line at the END of the result text, in the model's
  reading, so it survives `capToolResult`'s head-and-tail cut. An accepted image is
  written ONCE to `images/<sha256>.<ext>` under `hostStateDir()` (resolved on every
  call — a test's temp dir), 0700/0600, temp file + rename, and kept as an `ImageRef`
  with `n: 0` (no `[Image #N]` token) on the tool message's `images`; the same
  hash-checked `readImageData` serves a restart and `recall`. **The store is pruned by
  count**: `pruneImageStore` after every write keeps the newest `IMAGE_STORE_KEEP`
  (200) files by mtime and touches only `<sha256>.<ext>` names; a pruned ref reads
  `[image unavailable: name]` on the wire and is `recall`'s own answer. **An image on a
  tool message is an image on a user message, everywhere**: `apiHistory` keeps it,
  `wireMessages` resolves it into parts, `bulkyItems` makes it an `img:` item,
  `applyRecall` stubs it under the result's text, the context meter counts it by
  pixels (`imageTokens`), `/compact` names it — so a returned image is sent in full
  until a batch stubs it, then as a stub `recall` brings back; a recalled image's id is
  stubbed already, which is what keeps a recall to its turn. The one thing that differs
  per wire is placement: the round's copy of the tool message carries the image as
  content PARTS (`withAttachedImages`, the same carrier `wireMessages` gives an earlier
  turn), `openAiMessages` turns those into ONE user message after the run of tool
  results — `[2 images returned by get_shots — from the app, not a message from the
  person]` (`RETURNED_IMAGES_NOTE`, the tool named from the assistant message's
  `tool_calls`) — and `toolResultBlock` puts text and `image` blocks inside the
  `tool_result` itself; the scripted model's `anthropicRefusal` checks a `tool_result`'s
  array content the way the API does. The chat draws one dim row per image under the
  call's line — `▣ shot.png · 400×300` (`ImageMark` on `ToolRun`/`CallRun`, `markText`;
  `▣` is East-Asian-ambiguous like the `◆` marker and counts one cell in flowtty's
  grid) — never the image, and `condenseRuns` never folds a call that carries marks
  into a `×N`; the session keeps the marks and the refs, never bytes.
  `AgentOpts.imageLimits` carries `ai.images` in (`services.chatLLM`, which the chat,
  a background task and the one-shot all go through); a
  caller that says nothing gets the defaults.
- **A request carries the core tools and an INDEX of the rest** (tools on demand,
  `src/assistant/tool-loading.ts`, pure; wired in `agentChat`). Every tool's full
  schema on every request costs ~7k tokens with only the bundled plugins, a tracker
  plugin doubles it, and a turn uses two or three. So with `ai.toolLoading: 'onDemand'`
  (the config default) a request sends the `core` group in full, the tools this
  conversation has LOADED, and `tools_load`, whose description is the index — per
  group, `name — first sentence of the description`. The index does not change as
  tools load (a stable prefix) — only when the registry does: a group that joins
  mid-turn is in it from the next round (`toolsChanged`, above). `tools_load({ names | group })` is the loop's own
  tool, not the registry's; a group's name given in `names` loads the group (a tool of
  the same name wins), since a model reasonably passes one there and refusing it would
  cost a round; what is sent is worked out again for EVERY round, so a
  load reaches the next round of the same turn. A call to a tool that is indexed but
  not loaded is an ERROR naming `tools_load`, refused BEFORE the y/n — the wire-name
  map covers every known tool, not only the sent ones, or that call would not even
  resolve. That error shows the call to make as JSON (`notLoadedError`: `x is not
  loaded — call tools_load with {"names": ["x"]} first, then call it.`), never as prose
  around a quoted list, which a model copies into `names` as a string. `names` is an
  array or one string, and a string that parses as JSON is read as that value first
  (`readNames`): a list (`'["a","b"]'`), a quoted name (`'"a"'`), or the whole call the
  hint shows (`'{"names": [...]}'`); JSON that is none of those, and a string that does
  not parse, stays one bare name, and a list holding anything but strings is an
  argument error naming the type. The argument check (`toolArgsError`, below) passes
  the string form as a string — `TOOLS_LOAD_PARAMETERS` declares `names` as `anyOf`
  an array of strings or a string — so the parsing lives in `runToolsLoad` alone. A
  name that still looks serialised (brackets, braces or quotes around it) is explained
  in `Not in the list: …` (`notInList`, the error and a partial load's line alike): `—
  that is one name with brackets in it; pass names as an array: {"names": ["x"]}`.
  `names` also takes a tool QUALIFIED with its group, `<group>:<name>`, as
  well as the bare name the index shows — the index reads as `group:\n- name — …`, so
  a model reasonably repeats the two together, and accepting that combination
  (`unqualify`, `tool-loading.ts`: stripped only as a
  fallback, when the bare name misses and the prefix names the group that bare tool
  is actually in — a name already in the list, bare or genuinely qualified by a
  clash, is tried first and never rewritten) avoids the round `ERROR: Not in the
  list` would otherwise cost. An unknown name still errors, listing
  the groups. `group` takes the same forgiveness the other way round: a value that
  names no group is read as a tool's own name instead, qualified or bare, through the
  same resolution (`runToolsLoad`) — a model that passes a TOOL where the parameter
  reads "group" loads that tool rather than a round-costing error, and the answer says
  so like any other load. A group may carry its own description too — guidance beyond any one
  tool's, an MCP server's `initialize` `instructions`, say (`ToolGroup.description`,
  `src/loader/tools.ts`) — shown as one line under the group's heading in the index
  and, once the group's tools are loaded (or sent in full under `'all'`), in full on the
  group's first tool; sanitized (`sanitizeGroupDescription`: control characters and the
  app's own frame words out) and trusted the same way a tool's own description is. The loaded set is a `ToolSet` owned like the plan: the conversation's `toolSet`
  (saved as the session's `tools`, kept by `/compact`, emptied by `/clear`); a background run and the one-shot prompt's fresh
  conversation start from an empty one.
  `agentChat`'s own default is `'all'` — the mode is applied by `services.chatLLM`
  from config, for every caller — and `bootApp` pins `'all'` so an e2e script can call
  the tool it tests; `tool-loading.e2e.test.ts` opts in. The context meter measures
  `requestTools(...)`, what is really sent. `host:tools_list` still lists every name;
  the index made it mostly redundant.
- **A group past `BIG_GROUP_TOOLS` (12, `tool-loading.ts`) carries its own cost and is
  never loaded whole by `group` alone.** `estimateGroupTokens` (pure: the JSON size
  of the group's tools' own `function` — name, description, parameters — divided by
  four, rounded to the nearest 100) prices it; a group over the line gets a line of
  its own in the index, `toolIndex`: `N tools — load the ones you need with {"names":
  [...]}; the whole group costs about X tokens in every later request`, above its
  per-tool lines.
  `tools_load({ group })` for such a group loads nothing and answers with the same
  cost line and the group's own index instead, so the model names what it actually
  needs next; one of `BIG_GROUP_TOOLS` or fewer still loads whole, as before.
  `{ names }` is untouched either way — a tool by name always loads, and so does a
  group's name found there (`tool-loading.ts`'s existing `inGroup` fallback), whatever
  its size — naming things individually is never the expensive path. `runToolsLoad`
  handles `names` in full before it looks at `group`, so a call carrying both loads
  what `names` asked for and, in the same answer, still names why the big group was
  not — never one instead of the other.
- **A call is checked against the tool's own schema before it runs.** `toolArgsError`
  (`src/assistant/tool-args.ts`, pure) reads `ToolDef.function.parameters` as JSON
  Schema (`z.fromJSONSchema`, the same reader `src/remote/adapter.ts` compiles a
  remote plugin's `configSchema` with) and refuses a call whose arguments do not
  satisfy it — a missing `required` key, a value of the wrong type, a key `properties`
  does not list — right where `agentChat` already checks `notLoaded`: BEFORE the y/n
  and before either `def.run` (a plugin ai-tool) or `execChatTool` (a group tool) is
  reached, so neither path runs an unchecked call. `additionalProperties` absent from
  a schema is read as refusing an unlisted key rather than JSON Schema's own default
  of allowing it — a key not in `properties` is nearly always a required one
  misspelled, said as unknown `code` — did you mean `issueCode`? when exactly one
  required key is missing and exactly one unknown key sits beside it. Nothing is
  coerced, except `null` on an optional key, read as that key left out (the way a
  tool's own `??` reads it) at every level: a key the enclosing object schema declares
  (`properties`, or a `patternProperties` pattern it matches) and does not list in its
  own `required`, top-level parameter or nested inside an object parameter alike (the
  walk follows `properties`, `patternProperties` and array `items`, not `$ref`,
  `anyOf`/`oneOf`/`allOf` or an `additionalProperties` schema; a pattern that is not a
  valid regular expression matches nothing, and a walk that throws leaves `args` as
  sent). Only the check sees the cleaned copy — the tool still receives the arguments as
  sent, a `null` included. A required key sent as `null` is a wrong type at every
  level, and so is a `null` array item whose item schema does not allow it — an item
  has no "optional". A schema
  with no `properties` accepts anything, and one zod's JSON Schema reader cannot
  compile (an exotic keyword) is logged once and the call runs unchecked from then on
  — a plugin author's schema quirk must not stop their tool. `tools_load` has no
  `ToolDef` of its own in the registry (it is the loop's own tool), so it is checked
  against `TOOLS_LOAD_PARAMETERS` (`tool-loading.ts`) directly.
### A tool's result is what the model will tell the person

- **A failure is reported as a failure, in the failing thing's own words.** A `glab`
  runner that merely answered `{}` to everything would leave the model reading empty
  objects across every call and telling the person with full confidence to run
  `glab auth login`. So the wrapper returns the exit code and stderr,
  says "not installed" when the binary is missing, says "empty body" when it is
  empty, and times out instead of hanging the turn (`plugins-available/gitlab/src/glab.ts`).
- **A tool that can never work is not offered.** A tool that only ever answers
  "unavailable" still sits in the list and still costs a call, tokens on every
  request, and a wrong turn in the model's reasoning if left there. Remove it, do not
  leave it answering "unavailable".
- **A result over `ai.toolResultMaxChars` (default 40000) is cut before it joins the
  model's history** (`src/assistant/tool-result-cap.ts`, pure; applied where the tool
  message is built, `agentChat`'s tool-run path — plugin tools and host tools alike,
  `run_command` included). An uncapped result can be enormous — a board-listing tool
  answering a "list" with the whole board as raw JSON runs past 391,864 characters —
  and without a cut it stays in the model's history: every later request would carry
  it, and the model would misread a transition title
  next to an issue key for the issue's own status. The cut keeps the head (90% of the
  cap) and a short tail (the rest), with a note between them the model reads in place
  of what was cut: `… [cut: <N> characters in all — ask the tool for less: filters, a
  limit, one item]` — the note rides outside the cap, so the caller gets at most the
  cap plus the note. Only what is SENT is capped: a view (`ctx.liveView`/
  `reportView`), the tool trail and `ctx.reportChange`'s diff are display and
  untouched — `run.detail` (the trail's, the log's, the session's) keeps the result
  whole — and so does the tool message itself when its content is not the data plus the
  tag (the cap cut it, or the tool framed it and returned `{ text, raw }`): the data
  rides beside the content as `raw` (`RAW_RESULT`, `keptRaw` in
  `src/assistant/tool-results.ts`), in the conversation's `api` and the session but never sent
  (`apiHistory` whitelists fields for a later turn, `withAttachedImages` takes it off
  each round's copy within the turn), which is what `stdinFrom` reads after a restart;
  a result the cap left alone is its content without the tag, kept once. Data over
  `RAW_MAX` (1 MiB of characters) is not kept — only its length, `rawOmitted` — so one
  huge result cannot grow every session save without bound; piping it answers `too
  large to pipe`, never "call again", which would return the same. Only the `role: 'tool'` message pushed into `current` (and so into
  `transcript`/the conversation's `api`) is capped, once, for good. A tool declares its own
  `maxResultChars` on the tool def (the plugin tool type, `src/loader/tools.ts`) to
  raise its OWN cap — for one whose result is large and worth the tokens — clamped to
  a hard ceiling (200000) so a plugin cannot flood the history by declaring a bigger
  number; it is stripped before the def reaches the wire, like `write`/`run`.
  `run_command` already keeps only the tail of its own output (`shell.maxChars`,
  default 20000) before this cap ever sees it, so the smaller of the two numbers
  wins without either needing to know about the other. `services.chatLLM` — the
  path the chat, a background task and the one-shot all take — resolves
  `ai.toolResultMaxChars` once from config
  (`toolResultCapFromConfig`) and pass it as `agentChat`'s `toolResultMaxChars`; a
  caller that says nothing gets `TOOL_RESULT_MAX_CHARS_DEFAULT`.

## The conversation the model sees

**The chat's display list is never the model's history.** `agentChat` returns the
turn's `transcript` (assistant messages with `tool_calls`, every tool result, the
final answer) and the chat keeps it in a model-side history (the conversation's `api`) beside the
display list; `apiHistory()` sends API fields only and never half of a
call/result pair. Replaying only each turn's final text shows the model a
conversation in which state changed with no tool call in sight, and it imitates
that: it narrates the change and guesses at state. `scripts/eval-tool-use.ts`
measured it — 1 tool call in 15 turns with 14 false claims, against 15 in 15 with
none. `/compact`'s summary rides in the system context of every later turn for the
same reason: a display-only system message never reaches the model.

**A call whose arguments do not parse to a JSON object is refused at the call, not
stored as it arrived.** A stream that ends mid-argument (`{"path": "…", "ref": "f`), or
valid JSON that isn't an object (an array, a bare string, `null`), never goes into
`current` raw to run as `{}`: stored that way, every later request would carry the
malformed call, and an OpenAI-compatible provider answers 400 on all of them, forever
— `/clear` the only way out. Instead the call does not run, the model gets an error
naming the parse failure, and the history keeps `"{}"` in the call's place so it stays
valid JSON. `apiHistory()` repairs the same shape found in a session saved by an older
host, so it recovers on its next request.

**A tool call written as text is asked for again, once, as a real call**
(`src/assistant/tool-markup.ts`, pure: `hasToolMarkup`, `stripToolMarkup`,
`markupToolNames` — the one detector a compaction's summary is cleaned with too; code
is never markup: fenced blocks and inline spans are set aside before it looks, so an
answer or a handoff that SHOWS the tags stays whole). A
model sometimes writes its call as TEXT — DeepSeek's DSML `<｜DSML｜function_calls>`,
`<tool_call>`, `<function_calls>`, a bare `<invoke …>` — and the round ends with no
call at all. Taken as the answer, the turn would end on markup and nothing done. So a
round with no real call whose text holds the markup does not end the turn: the text
around the markup is kept as a step (`onLiveCommit(…, false)`), the markup nowhere — not
the screen, not `current`, not the transcript — and a user line tells the model its call
was written as text and nothing ran, naming the tools it has when the markup named one
that does not exist; then one more round. At most once in a row (`askedAgain`, cleared
by a round with a real call): a second such round ends the turn on the text around the
markup. Markup written BESIDE a real call is stripped the same way — from the step shown
and from the round's assistant message, so from the history and the session. Markup
inside a code fence is never seen (the price of never taking code for a call): a model
that fences its broken call gets no correction. `AgentOpts.onNote` carries a line about it (`tool call written as text — asked
again`, `… again — the turn ends`), drawn as a dim note where it happened.

**A turn that did not finish is closed in the model's history too.** The question
joins the conversation's `api` before the request, so it stays on record whatever happens. Left there
alone after Esc, it read to the model as a question still waiting: the next request
showed two user messages in a row, and the model answered both — going back to the
work the person had stopped. So when `agentChat` throws it hangs the turn's
transcript so far on the SAME error (`transcriptSoFar(e)`; the `name` still says
`AbortError`), and the chat appends it — the tool calls that completed, a write that
landed included; `apiHistory` drops a call left without its result — and then an
assistant message in the model's own voice: `STOPPED_TURN` after Esc (stopped by the
person, not to be resumed unless they ask), `failedTurn(message)` after an error
(it failed, with the error's first 200 characters — a retry the person asks for then
reads as one). The text of the round that was cut off is not kept. The closing
message is model-side only: the screen already says `stopped (Esc)` or shows the
error. It is saved with the session like the rest of the conversation's `api`
(`turn-end.e2e.test.ts` asserts on what the model is sent next).

**A turn the loop guard stopped is closed the same way, without an error.** The text
before the cut is pushed as the answer and stays the answer; the chat appends
`loopTurn(dropped, kept)` — the model's own voice saying where it stopped, or that
nothing of the answer was kept (`kept` is whether any text survived the cut) — beside
`roundCapTurn`, so `⏎ continue` writes on from there, or again from the start. No
whole repeat goes back into the history, which is what keeps the next rounds from
repeating it.

**A provider's refusal is read, not pasted** (`llmErrorMessage` in
`src/assistant/llm-error.ts`, pure). The raw body is not the error: pasted as-is it
would show `LLM 403: { "message":"model_access_denied", "request_id":"2395…" }`. The body is
read for the provider's own words in the shapes providers answer with (OpenAI's
`{error:{message,code,type}}`, a flat `{message}`, `{detail}` as text or a list of
`{msg}`, else the text collapsed and cut to 200) and the line is `LLM 403 · <model>:
model_access_denied (request 2395f0a1)` — the request id cut to 8 characters, from the
body or the `x-request-id` header; a 401/403 adds a generic hint about the token and
`config set ai.model`. It starts `LLM <status>` so `isImageRefusal` still reads it.
The streamed round and `/compact`'s one-shot both use it.

**A request that fails for a reason that passes is made again** (`src/assistant/llm-retry.ts`).
`withRetry` runs one attempt of a request and decides whether to make another; the
OpenAI-compatible round (`realChatRound`), the Anthropic round (`anthropicChatRound`) and
both compaction paths (`compactConversation`'s `ask`) all go through it. A failed request is
an `LlmRequestError` (`failedRequest` builds it from the response, `reach` turns a `fetch`
that rejected into one with `network: true`, and `readChunk` does the same for one
`reader.read()` of the body, cancelling the reader; both tell the network by a connection
code on the error or its cause, never by `TypeError` alone, so an invalid URL or header
fails at once; an abort and any other throw pass through untouched; the URL, headers and
body are built before the closure `reach` runs) whose message is `llmErrorMessage`'s
text, so `isImageRefusal` and every test that reads the text hold; it carries `status` and the `Retry-After` in `retryAfterMs`. An
SSE `error` event (the Anthropic wire's; the OpenAI wire has none) is the same error, its
status read from its type (`errorStatus`). Repeated: 429, 500, 502, 503, 504, 529 and a
network failure, of the request or of reading its body. **A round that gave anything to its
callbacks is never repeated**: `withRetry` hands the attempt its own `onDelta`, `onReasoning`
and `onToolCalls`, which note the delivery before they forward, so no caller has to remember
the rule. The wait is `ai.retryDelay` seconds (3) or `Retry-After` (seconds, or an HTTP date in its
IMF-fixdate form that lies in the future; capped at 60 s; `ai.retryDelay` is at most 60), up to `ai.retries` repeats (10; `llmOpts` reads both and every caller
spreads them with the endpoint); the last failure's message ends `— gave up after N
retries`. The abort is read as the turn reads it (`signal.aborted` or `name ===
'AbortError'`): never repeated, and it ends a wait at once. The two one-shot fallbacks
(`stream_options`, a refused thinking block) run inside the attempt and are not counted.
`onRetry(info)` is told before each wait and may return a function called when the wait
ends: a turn (`retryWait`, `conversation-turn.ts`) logs a line and, for a session's own turn
(no `parent`), puts `LLM 429 · retry 2/10 in 3 s` on the status line (`toolLabel`) with a
one-second tick; a child's turn, a compaction and a tool's nested run log only (an `onRetry` that throws is swallowed). A host with no log to show it in passes `retryNotice` in the conversation's
deps, told the same line `retryWait` logs: the one-shot prompt writes it to stderr,
redacted. A model request a plugin or a tool makes itself waits without showing it. Time, the
wait and the tick go through `retryClock`, which tests replace.

**Two wires, one history** (`src/assistant/llm-endpoint.ts`, `src/assistant/anthropic.ts`).
`ai.provider` picks how the model is reached: unset (or anything but `anthropic`, read
case-blind) an OpenAI-compatible chat-completions API, `anthropic` Anthropic's own
Messages API; a value that is neither `openai` nor `anthropic` is said once in the log
(`llmConfigNotes`), never refused — the schema has always taken any string. Every
caller — the chat's send and `/compact`, a background task, and `services.chatLLM`
itself, which is the one-shot prompt's path and serves a plugin that passes less —
spreads `llmOpts(config.ai)` into its call, and the start-up gate (`configWarnings`) checks the same resolution: with `anthropic` the base URL defaults to `https://api.anthropic.com/v1`
and the token variable to `ANTHROPIC_API_KEY`. In `agent.ts` the provider is looked at in
exactly two places, `roundFor` (the round `agentChat` runs; a caller's own `chatRound`, a
test's stub, wins) and `compactConversation`. On the OpenAI wire a round's thinking
arrives under `delta.reasoning_content` (vLLM, SGLang) or `delta.reasoning` (DeepSeek,
OpenRouter and other compatible servers); either reaches `onReasoning`, and a chunk
carrying both is said once. **What the host keeps never changes shape**:
the conversation's `api` and the session stay OpenAI-shaped, and `anthropicRequest` converts on the way
out, every request — system messages into the top-level `system`, `tool_calls` into
`tool_use` blocks (arguments parsed; `{}` for any that do not), each run of tool results
into ONE user message with the person's next words after them (turns of one role merge —
the API wants them alternating), image parts into base64 blocks. Two `cache_control`
breakpoints (the API takes four): the last system block — the prefix is tools → system →
messages, so it covers the tools; the last tool only when there is no system — and the
last block of the last message, so each round of a tool loop reads the turn so far from
the cache. A round's `REQUEST_TAIL` (what is on screen) is left out of that and appended
after the breakpoint, as the last text block of the last user turn. Blocks are copied to be marked, never marked in place (a kept round's blocks
are the history's own). A `tools_load` mid-turn changes the tools and so every prefix. A streamed round comes back as the
same `ChatRoundResult` with the same live callbacks (`onToolCalls` on the first `tool_use`
block, `thinking_delta` → `onReasoning` → the thinking fold; an empty one says nothing);
usage is `input + cache_creation + cache_read` as the prompt, since the meter measures
what is sent. An SSE `error` event carries no status, so its type stands for one
(`overloaded_error` → 529) and the line is `llmErrorMessage`'s, with the `request-id`
header. A compaction sends the instruction as `system` and the whole conversation as ONE
user message of text ending with the request for the handoff (`summaryHistory`: the
previous handoff first when there is one, then `user:`, `assistant:` with `[called name
{…}]`, `tool result:`) — on both wires: sent as turns it would end with the assistant's
answer, which the Messages API reads as a prefill and a chat-completions model answers as
the chat's next turn, and its tool blocks would need tools the request does not carry. **Thinking blocks go
back unchanged within a turn**: a round that thought AND
called a tool keeps its blocks as they came (`ChatRoundResult.blocks`), the loop puts them
on that round's assistant message (`anthropicContent`), and the conversion replays that
array verbatim — thinking, signature, order. It never outlives the turn: `apiHistory`
whitelists fields and drops it, which removes a LEADING run of thinking blocks — what the
API allows — and the OpenAI round strips it too (`openAiShaped`). A 400 that names a
thinking block (its history changed under it — the tool list does, when `tools_load` runs
mid-turn) is retried once without any thinking blocks AND without the `thinking` field
(with it on, the tool loop's last assistant turn must start with a thinking block); the
round says `thinkingDropped`, and the loop drops the turn's kept blocks and asks for no
thinking for the rest of the turn, so later rounds do not pay the 400 again.
`ai.thinking`: `{adaptive: true}` → `{type:'adaptive', display:'summarized'}` (the
current models' only mode; they omit the thinking text by default, and the fold would
be empty); `{budgetTokens}` → a fixed budget for older models, LOWERED to leave the
answer 1024 under the ceiling the request is handed (`answerCeiling`) when it does not
fit (said once in the log, for the start-time reading) — the
person's ceiling is kept, only one under 2048 is raised to 2048; unset → no `thinking` field at all (a current model then thinks by its
own default, its text not shown — but its blocks still come and still go back). The
scripted model has an Anthropic wire (`model.wire = 'anthropic'`) that REFUSES what the
API refuses (`anthropicRefusal`: headers, alternation, a tool result per call, first in
its message, no empty text, a signed thinking block, tool blocks without tools, a prefill,
more than four breakpoints, a thinking-on tool loop whose turn does not start with
thinking) — keep it in step with the API.

**An image is kept as a ref and sent as a part.** `ChatMessage.content` is
`string | ContentPart[] | null`, but content PARTS exist only on the way to the
provider: everywhere the host keeps a message (the display list, the conversation's `api`, the
session) its content is a string, and a person's message with images carries them
beside it as `images: ImageRef[]` (`{ n, name, path, sha256, mime, bytes, width,
height }`, `src/assistant/images.ts`) — on the display message only their numbers.
`apiHistory` passes a user message's `images` through — and a tool message's, the
images a tool returned beside its result ("A tool can return images" under What the
model can do); the turn (`runTurn`) alone turns them into
`[{type:'text'}, {type:'image_url', image_url:{url:'data:…'}}]` (`wireMessages`) right
before `chatLLM`, from bytes read when the image was attached or, after a restart,
read again from the path with the hash checked. A file gone or changed is a `note` in
the chat (once per image) and the message goes as its text + `[image unavailable:
name]`; with `ai.images.enabled` false every image goes as `[image not sent: name]`.
So the session file never holds base64, and the context meter never counts it — it
counts an image by its pixels (`imageTokens`: w×h/750 after the providers' scaling,
1600 when the size is unknown), as a part of its own. `/compact` sends text with
`[image: name]` and the image leaves with the history it replaced; `/clear` drops it.
A provider 400 that talks about images is quoted once as a `note` naming
`config set ai.images.enabled false` — the image stays in the history, so without
that every later message fails too. A background task never gets images.

- **Images** (`src/assistant/images.ts`; the model's side is under "The conversation
  the model sees"). The person attaches; the model can never make the host read a
  file as an image. An attachment is a TOKEN in the field's text, `[Image #N]`, put
  in at the caret with a space after it, drawn in `accent` (in the field and in the
  sent message — not dim, which in the field means "offered"). N counts up for the
  whole conversation (the conversation's `images`, N → ref, and `imageSeq`; saved as the session's
  `images` / `imageSeq`, reset by `/clear`). The TEXT decides
  what is sent — the tokens it holds that the map knows, in the order written, each
  once — so a queued message, ↑/↓ recall and the draft carry their images by their
  text alone; a token edited away is not sent, one typed by hand with nothing behind
  it is text. Ways in, all refused the same way (`not attached: <why>` on the error
  line — too big, too many, not an image, missing, `IMAGES_OFF`; nothing shrunk):
  - a PASTE that is wholly paths of image files (a file dragged onto the terminal
    arrives as its path; quoted, `\ `-escaped, several, `file://`), decided on the
    paste key, never on characters; a refused one goes in as text. Not in shell mode
    or a `/`/`!` field — there a path is the command's argument.
  - `/image <path>` (any word is a path there, relative to the shell's directory);
    `/image` alone, **Ctrl+V** (free in the editor reducer) and an EMPTY paste — the
    only signal a terminal gives for Cmd+V with an image on the clipboard — take the
    clipboard's image through `services.clipboardImage` (`readClipboardImage`:
    pngpaste → osascript; wl-paste → xclip; a private temp file). From a key an empty
    clipboard is only a toast. `bootApp`'s `opts.clipboardImage` fakes it; without
    one a test's clipboard is empty.
  - The file is taken by its real path, told by its magic bytes (png, jpeg, gif,
    webp), its size read from the header. The chat's key handler runs first:
    Backspace right after a token (Delete right before one) removes it whole.
- The mouse is reported because the TTY backend is opened with `{ mouse }`, on
  unless `ui.mouse` is `false`: the wheel scrolls, and a **drag selects and copies**
  (flowtty ≥ 1.0.0-alpha.15 copy-on-select — no host code draws the band or reads the
  cells). The terminal's own selection still works with its bypass held (Option in
  iTerm2, Shift in most Linux terminals, fn in Apple Terminal) and takes whole screen
  rows, borders included. The active default in `config_schema` describes all this,
  because "how do I copy text" is asked of the assistant. Without the mouse, `/copy`
  copies the last answer's code block (`/copy answer` — all of it).
- **Two limits bound a turn; the one reached first ends it, says where, and one key
  carries it on** (`src/assistant/rounds.ts`; `services.chatLLM` applies both, and a
  caller naming its own keeps it: a background task takes `ai.taskRounds` — `taskRoundsOf`, `TASK_ROUNDS_DEFAULT` = 12, 0 no cap — through the `taskCap` of its turn shape). `ai.maxRounds`
  (`maxRoundsOf`, `MAX_ROUNDS_DEFAULT` = 150) — requests per turn, a guard against a
  loop that never ends, high enough for long ordinary work; 0 is no round cap.
  `ai.maxTurnTokens` (`maxTurnTokensOf`, `MAX_TURN_TOKENS_DEFAULT` = 2000000) — tokens
  the turn's requests spend together, from the usage each reports: the prompt LESS its
  cached part (a long loop re-reads its prefix from the cache every round, which is not
  new work) plus the answer — and for a request whose usage carries no cache figure, the
  prompt's growth since the turn's previous request (never below 0) plus the answer, so
  a missing field cannot spend the budget in a dozen rounds. It bounds the NEW tokens a
  turn adds, not what it costs: cache reads of a long prefix are not counted, nor are a
  compaction's own requests. It is checked before each request after the first, so the
  turn ends once the budget is reached — the request that crosses it is the last; 0 is
  no budget, and a provider that reports no usage is bounded by the rounds alone. With `maxRounds: 0` the budget is what
  ends a long turn; with both 0 only Esc does. Both are the person's (under `ai`, never
  the model's to set). `agentChat` reports `roundLimit` (rounds taken) when the loop ends
  with no round that was an answer, with `lastStep` — the last round's calls,
  `name {args}`, cut to 80 — and, when the budget ended it, `limitBy: 'tokens'` and
  `turnTokens`. The chat draws `stopped after N rounds (ai.maxRounds) — ⏎ continue ·
  last: <lastStep>` (or `stopped after 2.0M tokens (ai.maxTurnTokens) — …`; the key
  before the step, so a narrow row cuts the step) in the warn colour, in the
  conversation (not as a dim line under the field, which the wall of grey above it
  would hide), and closes the turn in the model's history with the host's line in the
  model's voice (`roundCapTurn`: which limit, where it stopped, not finished, picked up
  on "continue"). Then Enter on the EMPTY field sends `continue`
  (`CONTINUE_WORD`) and the field's hint reads `⏎ continue`; the offer
  (the conversation's `continueOffer`) goes with the next message and wherever the empty-answer notice
  is reset.
- **A looped answer is stopped where the repeat began, and the same `⏎ continue`
  carries the work on** (`src/assistant/loop-guard.ts`, pure: one guard per answer, fed
  the round's accumulated text, firing once — a unit of 1–32 code units repeating
  EXACTLY, whole repeats counted back from the text's end, `LOOP_MIN_RUN` = 400 code
  units of run, with `LOOP_TAIL` = 512 looked at for candidate units). On the hit
  `agentChat` keeps the text before the run and records `looped` on the result, aborts
  the round's own stream — `roundStop`, a controller the turn's own signal feeds, so the
  person's Esc still stops the turn — and drops the call fragments it had begun: a
  stopped round is the answer round, and nothing asks the model again. The chat draws
  the kept answer, then `⚠ stopped — the answer was looping (N chars dropped); it is
  not kept in the model's history` in the warn colour, and sets the same
  `continueOffer`. The guard is always on and has no config key: a false positive costs
  a visible trim, a silent loop costs the session.
