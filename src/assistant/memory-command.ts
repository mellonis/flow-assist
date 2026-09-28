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
// A fact whose file the host did not write (./memory-trust.ts, `outside`) is listed as
// `changed outside flow-assist`: it is not in the prompt until the person accepts it
// with `/memory accept` — their action, never the model's.
//
// Pure: the two lists in, text (and what to remove or accept) out. The numbers run
// through both lists — this project's first, then the global one — as they are shown.
import type { Fact } from './memory-store.js';
import type { WorkspaceScope } from './workspace.js';

export interface MemoryLists {
  project: Fact[];
  global: Fact[];
  // The project as the person reads it (`~/p/app`); '' when the conversation has none.
  projectLabel: string;
}
export interface Forget { scope: WorkspaceScope; id: string }
// A fact to accept: its text as the person was shown it, by its hash.
export interface Accept { scope: WorkspaceScope; id: string; hash: string }

export interface MemoryCommandResult {
  // What to show the person (a note in the chat — never sent to the model).
  note: string;
  // Present when something must be removed.
  forget?: Forget[];
  // Present when facts changed outside flow-assist are to be accepted.
  accept?: Accept[];
}

export const OUTSIDE_MARK = 'changed outside flow-assist';

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
  const row = (i: number, f: Fact) => `${i + 1}. ${f.outside ? `[${OUTSIDE_MARK}] ` : ''}${f.type && f.type !== 'fact' ? `[${f.type}] ` : ''}${clip(f.text)}`;
  const outside = all.filter((e) => e.fact.outside && (!only || e.scope === only)).length;
  const section = (scope: WorkspaceScope, title: string, empty: string) => {
    if (only && only !== scope) return [];
    const rows = all.flatMap((e, i) => (e.scope === scope ? [row(i, e.fact)] : []));
    return [title, ...(rows.length ? rows : [empty])];
  };
  return [
    `${plural(all.length)} — each one's line of the index is sent with every request (the assistant reads a memory in full when it needs it), kept across /clear and restarts:`,
    ...section('project', l.projectLabel ? `This project (${l.projectLabel}):` : 'This conversation has no project:', '  (none)'),
    ...section('global', 'Every project:', '  (none)'),
    ...(outside ? [`${outside === 1 ? '1 memory was' : `${outside} memories were`} ${OUTSIDE_MARK} — not sent until you accept it: /memory accept <number>, or /memory accept all.`] : []),
    'Remove one with /memory forget <number>; /memory forget project or /memory forget global empties that list, /memory forget all both.',
  ].join('\n');
}

export function memoryCommand(arg: string, l: MemoryLists): MemoryCommandResult {
  const [verb = '', target = ''] = arg.trim().split(/\s+/);
  if (!verb || verb === 'list') return { note: memoryNote(l) };
  if (verb === 'project' || verb === 'global') return { note: memoryNote(l, verb) };
  if (verb === 'accept') return acceptCommand(target, numbered(l));
  if (verb !== 'forget') return { note: `Unknown: /memory ${verb}. Use /memory [project|global], /memory forget <number>, /memory forget project|global, /memory forget all or /memory accept <number|all>.` };
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

// `/memory accept <number|all>`: a fact changed outside flow-assist goes back into the
// prompt, as its text is now.
function acceptCommand(target: string, all: ReturnType<typeof numbered>): MemoryCommandResult {
  const outside = all.filter((e) => e.fact.outside);
  if (!outside.length) return { note: `Nothing to accept — no memory was ${OUTSIDE_MARK}.` };
  const of = (entries: typeof all): Accept[] => entries.map((e) => ({ scope: e.scope, id: e.fact.id, hash: e.fact.hash ?? '' }));
  if (target === 'all') return { note: `Accepted ${plural(outside.length)} ${OUTSIDE_MARK}; ${outside.length === 1 ? 'its line is' : 'their lines are'} sent from the next message.`, accept: of(outside) };
  const n = Number(target);
  const picked = Number.isInteger(n) ? all[n - 1] : undefined;
  if (!picked || !picked.fact.outside) {
    const which = all.flatMap((e, i) => (e.fact.outside ? [String(i + 1)] : [])).join(', ');
    return { note: `/memory accept needs the number of a memory ${OUTSIDE_MARK} (${which}) or "all". /memory shows the list.` };
  }
  return { note: `Accepted: ${clip(picked.fact.text, 100)} — its line is sent from the next message.`, accept: of([picked]) };
}

// What `/clear` says about what it did NOT clear.
export function keptAfterClear(count: number): string {
  if (!count) return '';
  return `Conversation cleared. ${count === 1 ? '1 memory is' : `${count} memories are`} kept — the assistant still knows ${count === 1 ? 'it' : 'them'}. /memory shows and removes.`;
}
