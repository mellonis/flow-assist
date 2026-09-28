import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostStateDir } from '../../config/load.js';
import { addFact, MEMORY_DIR, normalizeMemoryText, readFacts, removeFact, saveFact, type Fact } from '../../assistant/memory-store.js';
import { workspaceFor, workspaceRoot } from '../../assistant/workspace.js';
import { markFacts } from '../../assistant/memory-trust.js';

// The memory list an older host kept, one JSON file for every project. It is read to
// be moved into the global workspace once (src/assistant/memory-store.ts,
// `migrateMemoryJson`); the facts themselves are files in the workspaces.
//
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

export { normalizeMemoryText };

// Why a new entry is NOT stored, or null when it may be. `list` is the scope the entry
// goes to — the cap is counted there — and `others` every other fact the conversation
// can see (the other scope): a fact the model already has in either is a duplicate.
// Each refusal says what to do instead — update the entry that already says it, say it
// shorter, prune the list — and points at `/memory` and `/memory forget`, which stay
// the person's own way in and out. Only adding is refused: `update` is the remedy the
// duplicate refusal names, and refusing that too would leave nowhere to go.
export function refuseMemory(list: Pick<Memory, 'id' | 'text' | 'ts'>[], text: string, others: Pick<Memory, 'id' | 'text' | 'ts'>[] = []): string | null {
  const one = text.trim();
  if (one.length > MEMORY_TEXT_MAX) {
    return `Not stored: ${one.length} characters, and an entry may hold at most ${MEMORY_TEXT_MAX} — one short fact per entry, in a sentence that stands on its own.`;
  }
  const same = [...list, ...others].find((m) => normalizeMemoryText(m.text) === normalizeMemoryText(one));
  if (same) {
    return `Not stored: already remembered as ${same.id} — "${clipMemory(same.text)}". Update that entry (memory action=update) if it should say something else; the person sees the list with /memory.`;
  }
  if (list.length >= MEMORY_MAX_ENTRIES) {
    const oldest = [...list]
      .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
      .slice(0, 3)
      .map((m) => `${m.id} "${clipMemory(m.text)}"`)
      .join(', ');
    return `Not stored: the memory is full (${list.length} entries, the cap is ${MEMORY_MAX_ENTRIES}). The oldest are ${oldest}. Forget what is no longer true, or ask the person to prune it with /memory forget <number>.`;
  }
  return null;
}

// A refusal names the entry it is about, and an entry may be a whole sentence; the
// refusal is read by the model, so it stays short.
const clipMemory = (text: string, max = 60): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

// Removes what an older host kept for a plugin (an entry whose scope was the plugin's
// name), so a plugin's facts don't linger after it is uninstalled: the facts moved into
// the global workspace carry the name as `plugin`, and a list not moved yet is cleaned
// where it is. Returns how many were removed.
export function purgePluginMemories(config: Record<string, unknown> | undefined, pluginName: string, filePath?: string): number {
  const memFile = filePath ?? memoryFilePath(config);
  const list = loadMemories(memFile);
  const kept = list.filter((m) => m.scope !== pluginName);
  let removed = list.length - kept.length;
  if (removed) saveMemories(kept, memFile);
  const global = workspaceFor(config, null, 'global');
  for (const f of readFacts(global)) if (f.plugin === pluginName && removeFact(global, f.id)) removed++;
  return removed;
}

// `services.memory` for a plugin: the list shape it has always had, over the global
// workspace's facts — what one list for every project means there. `load` maps each
// fact (`scope` its plugin's name, else `global`; `label` its type); `save` takes the
// list back and applies the difference by id — an entry gone is removed, a changed one
// rewritten, a new one added under the memory tool's own guards (`refuseMemory`: a
// refused entry is not stored). `filePath` is the global `memory/` directory. A fact
// changed outside flow-assist (src/assistant/memory-trust.ts) is not in the list `load`
// gives, and `save` leaves it as it is — never removed for being absent, never rewritten
// (a rewrite would record the text as the host's own).
const asEntry = (f: Fact): Memory => ({ id: f.id, text: f.text, scope: f.plugin ?? 'global', label: f.type, ts: f.mtimeMs });
const pluginOf = (scope: unknown) => (typeof scope === 'string' && scope && scope !== 'global' && scope !== 'host' ? scope : undefined);
export function globalMemoryService(config: Record<string, unknown> | undefined) {
  const dir = () => workspaceFor(config, null, 'global');
  const marked = (ws: string) => markFacts(workspaceRoot(config), ws, readFacts(ws));
  return {
    load: (): Memory[] => marked(dir()).filter((f) => !f.outside).map(asEntry),
    save: (list: Memory[]): void => {
      const ws = dir();
      const all = marked(ws);
      const outside = new Set(all.filter((f) => f.outside).map((f) => f.id));
      const current = new Map(all.filter((f) => !f.outside).map((f) => [f.id, f]));
      const wanted = new Set(list.map((m) => m.id));
      for (const id of current.keys()) if (!wanted.has(id)) { removeFact(ws, id); current.delete(id); }
      for (const m of list) {
        const f = current.get(m.id);
        if (!f || typeof m.text !== 'string') continue;
        if (f.text !== m.text.trim() || (m.label && m.label !== f.type)) saveFact(ws, { ...f, text: m.text.trim(), ...(f.description === f.text ? { description: m.text.trim() } : {}), ...(m.label ? { type: m.label } : {}) });
      }
      for (const m of list) {
        if (current.has(m.id) || outside.has(m.id) || typeof m.text !== 'string' || !m.text.trim()) continue;
        const have = readFacts(ws).map((f) => ({ id: f.id, text: f.text, ts: f.mtimeMs }));
        if (refuseMemory(have, m.text)) continue;
        addFact(ws, { text: m.text, ...(m.label ? { type: m.label } : {}), ...(pluginOf(m.scope) ? { plugin: pluginOf(m.scope) } : {}) });
      }
    },
    filePath: (): string => path.join(dir(), MEMORY_DIR),
  };
}
