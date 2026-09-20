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
  memory: z.object({ file: z.string() }).optional(),
  fs: z.object({ roots: z.array(z.string()) }).optional(),
  plugins: z.record(z.string(), z.unknown()).optional(),
}).passthrough();