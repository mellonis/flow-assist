import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostStateDir } from '../../config/load.js';

// The assistant's memory lives outside the repo, beside the rest of what the host
// keeps for itself, so personal notes never end up in git. `hostStateDir()` is the one
// place that decides where that is — the config directory normally, a temporary
// directory under `bun test`.
//
// It is resolved on every call, never once at import: as an import-time constant it
// would be fixed before a test could point the directory anywhere, so every test that
// reaches the `memory` tool and names no file of its own would append to the person's
// own file — their `memory.json` gaining a copy of the same fact per run.
export function defaultMemoryPath(env: Record<string, string | undefined> = process.env): string {
  return path.join(hostStateDir(env), 'memory.json');
}

// A single stored memory: free text plus optional scope, an optional label (a
// classification the assistant can use to filter memories, e.g. the tool a fact
// relates to) and an epoch timestamp.
export interface Memory {
  id: string;
  text: string;
  scope: string;
  label?: string;
  ts: number;
}

// Resolves the real location of the memory file: config.memory.file (with `~`
// expansion to the home dir, and relative paths resolved from the process cwd)
// or the default beside the host's own state.
export function memoryFilePath(config: Record<string, unknown> | undefined, env: Record<string, string | undefined> = process.env): string {
  const memory = config?.memory as { file?: unknown } | undefined;
  const raw = memory?.file;
  if (!raw) return defaultMemoryPath(env);
  const expanded = String(raw).replace(/^~(?=\/|$)/, os.homedir());
  return path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
}

// Reads the memory file: { memories: [...] }. A missing file or invalid JSON
// yields an empty list — memory is optional and the host works without it.
export function loadMemories(filePath: string = defaultMemoryPath()): Memory[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed?.memories) ? parsed.memories : [];
  } catch {
    return [];
  }
}

// Writes the memory list as { memories: [...] }, creating the parent directory
// if needed. Write errors are silently swallowed (optional luxury).
export function saveMemories(list: Memory[], filePath: string = defaultMemoryPath()): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ memories: list }, null, 2), 'utf8');
  } catch {
    // If the file doesn't write, the chat keeps working without memory.
  }
}

// What the host holds a new entry to. A stored fact rides in the system prompt of
// EVERY later request, across /clear and across restarts, so sloppy writing is paid
// for forever — and the model reads other people's text, so a rule that lives only in
// the tool's description is a rule it may ignore. These two are enforced here.
export const MEMORY_TEXT_MAX = 300;
export const MEMORY_MAX_ENTRIES = 100;

// Two entries say the same thing when their text matches once case, runs of
// whitespace and trailing punctuation are taken out: "This repo prefers rebase over
// merge." and "this repo prefers  rebase over merge" are one fact, stored once.
export function normalizeMemoryText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?;,:…]+$/u, '').trim();
}

// Why a new entry is NOT stored, or null when it may be. Each refusal says what to do
// instead — update the entry that already says it, say it shorter, prune the list —
// and points at `/memory` and `/memory forget <n|all>`, which stay the person's own
// way in and out. Only adding is refused: `update` is the remedy the duplicate
// refusal names, and refusing that too would leave nowhere to go.
export function refuseMemory(list: Memory[], text: string): string | null {
  const one = text.trim();
  if (one.length > MEMORY_TEXT_MAX) {
    return `Not stored: ${one.length} characters, and an entry may hold at most ${MEMORY_TEXT_MAX} — one short fact per entry, in a sentence that stands on its own.`;
  }
  const same = list.find((m) => normalizeMemoryText(m.text) === normalizeMemoryText(one));
  if (same) {
    return `Not stored: already remembered as ${same.id} — "${clipMemory(same.text)}". Update that entry (memory action=update) if it should say something else; the person sees the list with /memory.`;
  }
  if (list.length >= MEMORY_MAX_ENTRIES) {
    const oldest = [...list]
      .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
      .slice(0, 3)
      .map((m) => `${m.id} "${clipMemory(m.text)}"`)
      .join(', ');
    return `Not stored: the memory is full (${list.length} entries, the cap is ${MEMORY_MAX_ENTRIES}). The oldest are ${oldest}. Forget what is no longer true, or ask the person to prune it with /memory forget <n|all>.`;
  }
  return null;
}

// A refusal names the entry it is about, and an entry may be a whole sentence; the
// refusal is read by the model, so it stays short.
const clipMemory = (text: string, max = 60): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

// Removes every memory whose scope is a plugin name (scope === pluginName) from the
// resolved memory file, so a plugin's facts don't linger after it is uninstalled.
// Returns the number of memories removed (0 if none / unreadable). The plugin's
// own memory file (if it opted into a per-plugin path) is not touched — the host
// only clears its own, scope-based memory store.
export function purgePluginMemories(config: Record<string, unknown> | undefined, pluginName: string, filePath?: string): number {
  const memFile = filePath ?? memoryFilePath(config);
  const list = loadMemories(memFile);
  const kept = list.filter((m) => m.scope !== pluginName);
  const removed = list.length - kept.length;
  if (removed) saveMemories(kept, memFile);
  return removed;
}
