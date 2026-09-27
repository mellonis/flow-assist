// `/memory` — the person's own view of what the assistant remembers.
//
// The `memory` tool is the MODEL's: it stores a fact in the workspace (./memory-store.ts),
// and the fact's line in the index goes into the system prompt of every later request
// in that project (a global fact's in every project) — across `/clear`, across
// restarts. That is what it is for, but left unsaid it reads as a bug: after `/clear`
// the assistant "still knows" an earlier prompt, which reads as `/clear` not working,
// with nothing showing the person what was stored and nothing but asking the model able
// to remove it. Like the config and the log, the memory is the person's, so they get a
// command that does not go through the model.
//
// Pure: the two lists in, text (and what to remove) out. The numbers run through both
// lists — this project's first, then the global one — as they are shown.
import type { Fact } from './memory-store.js';
import type { WorkspaceScope } from './workspace.js';

export interface MemoryLists {
  project: Fact[];
  global: Fact[];
  // The project as the person reads it (`~/p/app`); '' when the conversation has none.
  projectLabel: string;
}
export interface Forget { scope: WorkspaceScope; id: string }

export interface MemoryCommandResult {
  // What to show the person (a note in the chat — never sent to the model).
  note: string;
  // Present when something must be removed.
  forget?: Forget[];
}

const clip = (text: string, max = 160) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const plural = (n: number) => `${n} ${n === 1 ? 'memory' : 'memories'}`;
const numbered = (l: MemoryLists): { scope: WorkspaceScope; fact: Fact }[] => [
  ...l.project.map((fact) => ({ scope: 'project' as const, fact })),
  ...l.global.map((fact) => ({ scope: 'global' as const, fact })),
];

export function memoryNote(l: MemoryLists, only?: WorkspaceScope): string {
  const all = numbered(l);
  if (!all.length) return 'Memory is empty. The assistant stores a fact with its `memory` tool when you ask it to remember something.';
  const row = (i: number, f: Fact) => `${i + 1}. ${f.type && f.type !== 'fact' ? `[${f.type}] ` : ''}${clip(f.text)}`;
  const section = (scope: WorkspaceScope, title: string, empty: string) => {
    if (only && only !== scope) return [];
    const rows = all.flatMap((e, i) => (e.scope === scope ? [row(i, e.fact)] : []));
    return [title, ...(rows.length ? rows : [empty])];
  };
  return [
    `${plural(all.length)} — each one's line of the index is sent with every request (the assistant reads a memory in full when it needs it), kept across /clear and restarts:`,
    ...section('project', l.projectLabel ? `This project (${l.projectLabel}):` : 'This conversation has no project:', '  (none)'),
    ...section('global', 'Every project:', '  (none)'),
    'Remove one with /memory forget <number>; /memory forget project or /memory forget global empties that list, /memory forget all both.',
  ].join('\n');
}

export function memoryCommand(arg: string, l: MemoryLists): MemoryCommandResult {
  const [verb = '', target = ''] = arg.trim().split(/\s+/);
  if (!verb || verb === 'list') return { note: memoryNote(l) };
  if (verb === 'project' || verb === 'global') return { note: memoryNote(l, verb) };
  if (verb !== 'forget') return { note: `Unknown: /memory ${verb}. Use /memory [project|global], /memory forget <number>, /memory forget project|global or /memory forget all.` };
  const all = numbered(l);
  if (!all.length) return { note: 'Memory is already empty.' };
  const many = (entries: typeof all, what: string) => (entries.length
    ? { note: `Forgot ${what} ${plural(entries.length)}.`, forget: entries.map((e) => ({ scope: e.scope, id: e.fact.id })) }
    : { note: `There is nothing to forget in ${what === 'all' ? 'the memory' : `the ${what} list`}.` });
  if (target === 'all') return many(all, 'all');
  if (target === 'project' || target === 'global') {
    const r = many(all.filter((e) => e.scope === target), target);
    return r.forget ? { ...r, note: `Forgot ${plural(r.forget.length)} of ${target === 'project' ? 'this project' : 'every project'}.` } : r;
  }
  const n = Number(target);
  if (!Number.isInteger(n) || n < 1 || n > all.length) {
    return { note: `/memory forget needs a number from 1 to ${all.length}, "project", "global" or "all". /memory shows the list.` };
  }
  const gone = all[n - 1]!;
  return { note: `Forgot: ${clip(gone.fact.text, 100)}`, forget: [{ scope: gone.scope, id: gone.fact.id }] };
}

// What `/clear` says about what it did NOT clear.
export function keptAfterClear(count: number): string {
  if (!count) return '';
  return `Conversation cleared. ${count === 1 ? '1 memory is' : `${count} memories are`} kept — the assistant still knows ${count === 1 ? 'it' : 'them'}. /memory shows and removes.`;
}
