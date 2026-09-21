// `/memory` — the person's own view of what the assistant remembers.
//
// The `memory` tool is the MODEL's: it stores a fact, and the fact is put into the
// system prompt of every later request — across `/clear`, across restarts. That is
// what it is for. But nothing showed the person what had been stored, and nothing but
// asking the model could remove it: after `/clear` the assistant "still knew" an
// earlier prompt, which read as `/clear` not working. Like the config and the log,
// the memory is the person's, so they get a command that does not go through the model.
//
// Pure: text in, text (and possibly a new list) out.
import type { Memory } from '../runtime/services/memory.js';

export interface MemoryCommandResult {
  // What to show the person (a note in the chat — never sent to the model).
  note: string;
  // Present when the list changed and must be saved.
  next?: Memory[];
}

const clip = (text: string, max = 160) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

export function memoryNote(list: Memory[]): string {
  if (!list.length) return 'Memory is empty. The assistant stores a fact with its `memory` tool when you ask it to remember something.';
  const rows = list.map((m, i) => `${i + 1}. ${m.scope && m.scope !== 'host' ? `[${m.scope}] ` : ''}${clip(m.text)}`);
  return [
    `${list.length} ${list.length === 1 ? 'memory' : 'memories'} — sent with every request, kept across /clear and restarts:`,
    ...rows,
    'Remove one with /memory forget <number>, or everything with /memory forget all.',
  ].join('\n');
}

export function memoryCommand(arg: string, list: Memory[]): MemoryCommandResult {
  const [verb = '', target = ''] = arg.trim().split(/\s+/);
  if (!verb || verb === 'list') return { note: memoryNote(list) };
  if (verb !== 'forget') return { note: `Unknown: /memory ${verb}. Use /memory, /memory forget <number> or /memory forget all.` };
  if (!list.length) return { note: 'Memory is already empty.' };
  if (target === 'all') return { note: `Forgot all ${list.length} ${list.length === 1 ? 'memory' : 'memories'}.`, next: [] };
  const n = Number(target);
  if (!Number.isInteger(n) || n < 1 || n > list.length) {
    return { note: `/memory forget needs a number from 1 to ${list.length}, or "all". /memory shows the list.` };
  }
  const gone = list[n - 1]!;
  return { note: `Forgot: ${clip(gone.text, 100)}`, next: list.filter((_, i) => i !== n - 1) };
}

// What `/clear` says about what it did NOT clear.
export function keptAfterClear(list: Memory[]): string {
  if (!list.length) return '';
  return `Conversation cleared. ${list.length} ${list.length === 1 ? 'memory is' : 'memories are'} kept — the assistant still knows ${list.length === 1 ? 'it' : 'them'}. /memory shows and removes.`;
}
