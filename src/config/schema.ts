import { z } from 'zod';

export const hostConfigSchema = z.object({
  cache: z.object({ enabled: z.boolean() }).optional(),
  keys: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  theme: z.record(z.string(), z.unknown()).optional(),
  debug: z.object({ logTools: z.boolean() }).optional(),
  ai: z.object({
    // 'anthropic' — Anthropic's own Messages API; anything else, or unset, an
    // OpenAI-compatible chat-completions API (src/assistant/llm-endpoint.ts).
    provider: z.string().optional(),
    baseUrl: z.string().optional(),
    model: z.string().optional(),
    tokenEnv: z.string().optional(),
    stream: z.boolean().optional(),
    // The Anthropic wire only (`provider: 'anthropic'`, src/assistant/anthropic.ts):
    // the ceiling on one answer, which that API requires (default 8192), and how the
    // model is asked to think — `adaptive` (the current models) or a fixed
    // `budgetTokens` (older ones; at least 1024). Unset: the model's own default.
    maxTokens: z.number().int().positive().optional(),
    thinking: z.object({ adaptive: z.boolean().optional(), budgetTokens: z.number().int().min(1024).optional() }).optional(),
    // The model's context window in tokens — the API cannot be asked for it. The
    // chat's `ctx N%` and `/context` measure against it (default 200000).
    contextWindow: z.number().int().positive().optional(),
    language: z.string().optional(),
    assistantLanguage: z.string().optional(),
    disabledTools: z.array(z.string()).optional(),
    // 'onDemand' (default): a request carries the core tools in full and an index of
    // the rest, which the model loads by name (src/assistant/tool-loading.ts). 'all':
    // every tool in full on every request.
    toolLoading: z.enum(['all', 'onDemand']).optional(),
    // The cap on ONE tool result before it joins the model's history (default 40000
    // characters, src/assistant/tool-result-cap.ts). A longer result is cut, the head
    // kept and a short tail, with a note naming how much was cut. Display — a view, the
    // tool trail — is never capped, only what is sent. A plugin tool may declare its
    // own `maxResultChars` (docs/plugins.md), clamped to a hard ceiling (200000).
    toolResultMaxChars: z.number().int().positive().optional(),
    // Images the person attaches in the chat (src/assistant/images.ts): on unless
    // `enabled` is false (a model that cannot take them), the largest file sent as it
    // is (5 MB — a bigger one is refused, never shrunk), how many one message carries (4).
    images: z.object({ enabled: z.boolean(), maxBytes: z.number().int().positive(), maxPerMessage: z.number().int().positive() }).partial().optional(),
    // Bulky content — an attached image, a `!command`'s output, a tool result over
    // `minChars` (4096) — goes to the model in full in its own turn and as a stub it can
    // `recall` afterwards (src/assistant/recall.ts). Stubs are applied in batches: when
    // the context passes `threshold` (0.5 of `ai.contextWindow`) or every `everyTurns`
    // turns (10; 0 — the threshold alone). `enabled: false` sends everything in full.
    recall: z.object({ enabled: z.boolean(), threshold: z.number().positive().max(1), minChars: z.number().int().positive(), everyTurns: z.number().int().min(0) }).partial().optional(),
  }).optional(),
  user: z.object({ name: z.string().optional(), login: z.string().optional() }).optional(),
  // `mouse` reports the mouse to the app: the wheel scrolls the conversation, and a drag
  // selects text inside one pane and copies it on release (flowtty's copy-on-select —
  // the terminal's clipboard sequence, else pbcopy / wl-copy / xclip / xsel). On by
  // default. `config set ui.mouse false` gives the mouse back to the terminal, whose own
  // selection takes whole screen rows, borders included; `/copy` in the chat copies an
  // answer with no mouse at all.
  // `verbs` — the words the chat's status line picks from while the model works (one
  // per request, src/assistant/verbs.ts); an empty list keeps the built-in ones.
  ui: z.object({ mouse: z.boolean().optional(), verbs: z.array(z.string()).optional() }).optional(),
  memory: z.object({ file: z.string() }).optional(),
  // Chat sessions on disk (src/assistant/sessions.ts): where, whether the app
  // continues the latest one on start, how many are kept.
  sessions: z.object({ dir: z.string(), resume: z.boolean(), keep: z.number().int().positive() }).partial().optional(),
  // Legacy: `shell.roots` and `plugins.repo.roots` replace this. Still accepted and
  // read for one release —
  // as `shell.roots` by the shell, and after `plugins.repo.roots` / `shell.roots` by
  // the repo plugin — with one note in the log saying where it moved.
  fs: z.object({ roots: z.array(z.string()) }).optional(),
  // web_fetch: hosts fetched without asking (`*.example.com` for subdomains), and limits.
  web: z.object({ allowlist: z.array(z.string()).optional(), maxBytes: z.number().int().positive().optional(), timeoutMs: z.number().int().positive().optional() }).optional(),
  // Shell commands — `!command` in the chat and the model's run_command
  // (src/assistant/shell.ts): the time limit, how much of the output is kept, and
  // `roots` — the directories commands start in (the first) and may `cd` within.
  shell: z.object({ timeoutMs: z.number().int().positive(), maxChars: z.number().int().positive(), roots: z.array(z.string()) }).partial().optional(),
  plugins: z.record(z.string(), z.unknown()).optional(),
}).passthrough();