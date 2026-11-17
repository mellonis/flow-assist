# Disposition — where every part of the old AGENTS.md went (2026-11-17)

Old file: 5395 lines / 441 698 bytes (git history: `chore/agents-md-slim`^).
New core: ~925 lines / 62 818 bytes — **over the host's 32 KiB
`INSTRUCTIONS_CAP`** (a session sees ~52% of it until the cap question is
settled, issue #124); that number is a product decision, not this table's. Extracted verbatim: 342 KB across the six
spec files in this directory. Everything named here is either kept as a
rule, moved as text, "covered by" a page, or deleted as something the code
already states.

| old lines | zone | disposition |
|---|---|---|
| 1–134 | title, language rule, comments, stack, repos, layout | core (condensed rules); the ASCII directory tree **deleted** — `ls plugins-available plugins-enabled docs packages` states it |
| 135–318 | plugin contract: `HOST_API`, builder, naming claims, `toolsChanged`, chat hooks | core (invariants); author-facing detail *covered by* `docs/plugins.md` |
| 319–732 | first frame / late loading, process life, server retry, handled key, guest rule, screens, remote plugins | `plugins-runtime-spec.md` (verbatim) |
| 733–771 | panel / window / full layout | `chat-spec.md` (verbatim) |
| 772–957 | subagent y/n block, agent tree, watching a child | `ask-children-spec.md` (verbatim) |
| 958–1032 | the plan yields, two slots, collapsed chat, closing ≠ answer, focus, mouse | `chat-spec.md` (verbatim) |
| 1033–1172 | tool list, plugin config keys, config is the person's, `web_fetch` | core (rules); the `subagent`/`skill` tool contracts and the confirm-policy path detail **deleted with evidence** (`agent-model.ts:104-108`, `skill-model.ts`, one-shot `runPrompt`) — git holds them |
| 1173–1395 | `run_command`, background shell jobs, `cd`, project instructions | `shell-jobs-spec.md` (verbatim) |
| 1396–1505 | decline-writes policy, whose claim excuses a y/n, auto mode, the log, `ask_user` | core (rules); the `ask_user` behaviour contract (typing starts it, the shortcuts that do not) and "no log tool" **deleted with evidence** (`plugins/assistant.ts:133`, `ask.ts:12,161`) |
| 1506–1688 | the agent workspace, the memory | `sessions-journal-spec.md` (verbatim) |
| 1689–1780 | context meter, the handoff, auto-compaction, cache usage | `model-wire-spec.md` (verbatim) |
| 1781–1825 | the plan (`todo`) | `sessions-journal-spec.md` (verbatim) |
| 1826–2015 | recall / bulky items, tool-returned images, tools on demand, schema check | `model-wire-spec.md` (verbatim) |
| 2016–2497 | sessions survive a restart, the journal, `/export`, the picker, locks and forks | `sessions-journal-spec.md` (verbatim) |
| 2498–2568 | tool naming, hostile arguments, a write shows what it changed | core (rules) |
| 2569–2633 | views and renderers | `chat-spec.md` (verbatim) |
| 2634–2663 | shell seen before it runs, magic flags, write refuses by throwing, git writes | core (rules); the git-write workflow (no default-branch push, `--force-with-lease`, …) and `runShell`'s two-callers rule **deleted with evidence** (`repo/src/git-write.ts:2-15`, `shell.ts:1`) |
| 2664–2902 | a result is what the model will tell the person; the conversation the model sees | `model-wire-spec.md` (verbatim) |
| 2903–2959 | the `:` line | core is silent; the completion/list machinery **deleted with evidence** (`src/runtime/app.tsx:970`, `src/config/commandline.ts:3`) |
| 2960–3226 | `:perf`, `:plugins`, the typed command's chrome, the chat's opening rules, the message order, the `Conversation` snapshot | `chat-spec.md` (verbatim) |
| 3227–3272 | conversation kinds, one model per conversation | `ask-children-spec.md` (verbatim) |
| 3273–3427 | the conversation registry, quiescence, what a parked session is owed | `sessions-journal-spec.md` (verbatim) |
| 3428–3727 | children and subagents, agent files, skills, tool allow-lists | `ask-children-spec.md` (verbatim) |
| 3728–4178 | keys and bindings, folds and clicks, the turn's order, ⇧⇥ auto, `/model` | `chat-spec.md` (verbatim) |
| 4179–4212 | images (the person attaches) | `model-wire-spec.md` (verbatim) |
| 4213–4293 | what a drag copies, mouse buttons, hover | `chat-spec.md` (verbatim) |
| 4294–4479 | `!command`, `!!command` | `shell-jobs-spec.md` (verbatim) |
| 4480–4591 | a plugin's chat commands, the field's completion, `/cd` | `chat-spec.md` (verbatim) |
| 4592–4633 | the two turn limits, the loop guard | `model-wire-spec.md` (verbatim) |
| 4634–4776 | the two queues, the inbox | `ask-children-spec.md` (verbatim) |
| 4777–4851 | one look for every host modal, the scroll list and row cache, the help | `chat-spec.md` (verbatim) |
| 4852–5027 | CLI, config and environment | core (rules) |
| 5028–5294 | secrets | core (rules); the guard's flow walkthrough *covered by* `docs/safety.md` |
| 5295–5395 | testing, git | core |

Notes:

- "core (condensed)" zones kept every binding rule but joined the prose; no
  kept rule was reworded softer (the modal force is preserved). Several
  mechanism blocks inside those zones were deleted outright — the rows above
  name each with the `file:line` that states it; git history holds the text.
- *Covered by* means the page already documents that ground for its own
  reader; the core keeps a pointer or a rule summary, never a second copy.
- Deletions: the ASCII directory tree (evidence: directory listings state
  it) and the narration inside core zones that merely described how code is
  arranged — each such deletion is a sentence the grep of the file it names
  reproduces. Git history holds everything.
- The mapping table above is the migration record; the trigger index at the
  bottom of `AGENTS.md` is what a working session reads.
