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
  }).optional(),
  user: z.object({ name: z.string().optional(), login: z.string().optional() }).optional(),
  // `mouse` reports the wheel to the app (it scrolls the conversation). On by
  // default; the cost is the terminal's own drag-to-select. iTerm2 selects with Option
  // held, most Linux terminals with Shift; Apple Terminal with neither — there, View →
  // Allow Mouse Reporting (⌘R) turns it off. `config set ui.mouse false` gives it back
  // everywhere, and `/copy` in the chat copies an answer without the mouse.
  ui: z.object({ mouse: z.boolean().optional() }).optional(),
  memory: z.object({ file: z.string() }).optional(),
  fs: z.object({ roots: z.array(z.string()) }).optional(),
  // web_fetch: hosts fetched without asking (`*.example.com` for subdomains), and limits.
  web: z.object({ allowlist: z.array(z.string()).optional(), maxBytes: z.number().int().positive().optional(), timeoutMs: z.number().int().positive().optional() }).optional(),
  plugins: z.record(z.string(), z.unknown()).optional(),
}).passthrough();