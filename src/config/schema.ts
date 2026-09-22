import { z } from 'zod';

export const hostConfigSchema = z.object({
  cache: z.object({ enabled: z.boolean() }).optional(),
  keys: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  theme: z.record(z.string(), z.unknown()).optional(),
  debug: z.object({ logTools: z.boolean() }).optional(),
  ai: z.object({
    provider: z.string().optional(),
    baseUrl: z.string().optional(),
    model: z.string().optional(),
    tokenEnv: z.string().optional(),
    stream: z.boolean().optional(),
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
    // Images the person attaches in the chat (src/assistant/images.ts): on unless
    // `enabled` is false (a model that cannot take them), the largest file sent as it
    // is (5 MB — a bigger one is refused, never shrunk), how many one message carries (4).
    images: z.object({ enabled: z.boolean(), maxBytes: z.number().int().positive(), maxPerMessage: z.number().int().positive() }).partial().optional(),
  }).optional(),
  user: z.object({ name: z.string().optional(), login: z.string().optional() }).optional(),
  // `mouse` reports the mouse to the app: the wheel scrolls the conversation, and a drag
  // selects text inside one pane and copies it on release (flowtty's copy-on-select —
  // the terminal's clipboard sequence, else pbcopy / wl-copy / xclip / xsel). On by
  // default. `config set ui.mouse false` gives the mouse back to the terminal, whose own
  // selection takes whole screen rows, borders included; `/copy` in the chat copies an
  // answer with no mouse at all.
  ui: z.object({ mouse: z.boolean().optional() }).optional(),
  memory: z.object({ file: z.string() }).optional(),
  // Chat sessions on disk (src/assistant/sessions.ts): where, whether the app
  // continues the latest one on start, how many are kept.
  sessions: z.object({ dir: z.string(), resume: z.boolean(), keep: z.number().int().positive() }).partial().optional(),
  fs: z.object({ roots: z.array(z.string()) }).optional(),
  // web_fetch: hosts fetched without asking (`*.example.com` for subdomains), and limits.
  web: z.object({ allowlist: z.array(z.string()).optional(), maxBytes: z.number().int().positive().optional(), timeoutMs: z.number().int().positive().optional() }).optional(),
  // Shell commands — `!command` in the chat and the model's run_command
  // (src/assistant/shell.ts): the time limit and how much of the output is kept.
  shell: z.object({ timeoutMs: z.number().int().positive(), maxChars: z.number().int().positive() }).partial().optional(),
  plugins: z.record(z.string(), z.unknown()).optional(),
}).passthrough();