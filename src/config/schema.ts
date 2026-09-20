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
    language: z.string().optional(),
    assistantLanguage: z.string().optional(),
    disabledTools: z.array(z.string()).optional(),
  }).optional(),
  user: z.object({ name: z.string().optional(), login: z.string().optional() }).optional(),
  // `mouse` reports the wheel to the app (it scrolls the conversation). On by
  // default; the cost is the terminal's own drag-to-select, which then needs
  // Shift (or Option on macOS) held — `config set ui.mouse false` gives it back.
  ui: z.object({ mouse: z.boolean().optional() }).optional(),
  memory: z.object({ file: z.string() }).optional(),
  fs: z.object({ roots: z.array(z.string()) }).optional(),
  plugins: z.record(z.string(), z.unknown()).optional(),
}).passthrough();