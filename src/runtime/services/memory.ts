import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The assistant's memory lives outside the repo, under the user's home config
// dir, so personal notes never end up in git. This mirrors the source tracker
// path but under the host's own config directory.
export const DEFAULT_MEMORY_PATH = path.join(
  os.homedir(),
  '.config',
  'developer-assistant',
  'memory.json',
);

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
// or the default under the home config dir.
export function memoryFilePath(config: Record<string, unknown> | undefined): string {
  const memory = config?.memory as { file?: unknown } | undefined;
  const raw = memory?.file;
  if (!raw) return DEFAULT_MEMORY_PATH;
  const expanded = String(raw).replace(/^~(?=\/|$)/, os.homedir());
  return path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
}

// Reads the memory file: { memories: [...] }. A missing file or invalid JSON
// yields an empty list — memory is optional and the host works without it.
export function loadMemories(filePath: string = DEFAULT_MEMORY_PATH): Memory[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed?.memories) ? parsed.memories : [];
  } catch {
    return [];
  }
}

// Writes the memory list as { memories: [...] }, creating the parent directory
// if needed. Write errors are silently swallowed (optional luxury).
export function saveMemories(list: Memory[], filePath: string = DEFAULT_MEMORY_PATH): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ memories: list }, null, 2), 'utf8');
  } catch {
    // If the file doesn't write, the chat keeps working without memory.
  }
}

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
