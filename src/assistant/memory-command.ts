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
// `changed outside flow-assist`, with the index line the prompt would carry for it
// (name — description, which is what the model reads) as well as its text: it is not in
// the prompt until the person accepts it with `/memory accept` — their action, never the
// model's. An accept takes only what the last listing showed (`Shown`, kept by the
// chat): a number names that listing's fact, and one whose file changed since, or a
// number no listing showed, is refused and the list shown again.
//
// Pure: the two lists in, text (and what to remove or accept) out. The numbers run
// through both lists — this project's first, then the global one — as they are shown.
import { indexLine, MEMORY_DIR, type Fact } from './memory-store.js';
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
// A listing as the person saw it, by its numbers: which fact each was, the hash of its
// file then, whether it was changed outside flow-assist, and whether the listing showed
// it at all (`/memory project` numbers the global facts too, and shows none of them).
export interface Shown extends Accept { outside: boolean; listed: boolean }

export interface MemoryCommandResult {
  // What to show the person (a note in the chat — never sent to the model).
  note: string;
  // Present when something must be removed.
  forget?: Forget[];
  // Present when facts changed outside flow-assist are to be accepted.
  accept?: Accept[];
  // Present when the note lists the memory: what each number stands for, for the next
  // accept to be checked against.
  shown?: Shown[];
}

export const OUTSIDE_MARK = 'changed outside flow-assist';

const clip = (text: string, max = 160) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
// Inline code, so the note's markdown draws the line as it would be sent: a fence one
// backtick longer than any run inside it.
const code = (text: string): string => {
  const run = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const tick = '`'.repeat(run + 1);
  return `${tick} ${text} ${tick}`;
};
const plural = (n: number) => `${n} ${n === 1 ? 'memory' : 'memories'}`;
const numbered = (l: MemoryLists): { scope: WorkspaceScope; fact: Fact }[] => [
  ...l.project.map((fact) => ({ scope: 'project' as const, fact })),
  ...l.global.map((fact) => ({ scope: 'global' as const, fact })),
];

export function memoryNote(l: MemoryLists, only?: WorkspaceScope): string {
  const all = numbered(l);
  if (!all.length) return 'Memory is empty. The assistant stores a fact with its `memory` tool when you ask it to remember something.';
  const row = (i: number, f: Fact) => {
    const line = `${i + 1}. ${f.outside ? `[${OUTSIDE_MARK}] ` : ''}${f.type && f.type !== 'fact' ? `[${f.type}] ` : ''}${clip(f.text)}`;
    // What the prompt would carry for it, which the text alone does not show.
    return f.outside ? `${line}\n   sent as: ${code(clip(indexLine(f, `${MEMORY_DIR}/`), 240))}` : line;
  };
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

// What each number of a listing stands for.
export function shownOf(l: MemoryLists, only?: WorkspaceScope): Shown[] {
  return numbered(l).map((e) => ({ scope: e.scope, id: e.fact.id, hash: e.fact.hash ?? '', outside: !!e.fact.outside, listed: !only || e.scope === only }));
}

// `shown` — the last listing the person saw (null before the first).
export function memoryCommand(arg: string, l: MemoryLists, shown: Shown[] | null = null): MemoryCommandResult {
  const [verb = '', target = ''] = arg.trim().split(/\s+/);
  if (!verb || verb === 'list') return { note: memoryNote(l), shown: shownOf(l) };
  if (verb === 'project' || verb === 'global') return { note: memoryNote(l, verb), shown: shownOf(l, verb) };
  if (verb === 'accept') return acceptCommand(target, l, shown);
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
// prompt — as the last listing showed it. Its file changed since, or no listing showed
// it: nothing is accepted, and the list is shown again.
function acceptCommand(target: string, l: MemoryLists, shown: Shown[] | null): MemoryCommandResult {
  const again = (why: string): MemoryCommandResult => ({ note: `${why}\n${memoryNote(l)}`, shown: shownOf(l) });
  if (!shown) return again('/memory accept takes a number from a list you have seen — here it is:');
  const current = numbered(l);
  const still = (s: Shown) => current.some((e) => e.scope === s.scope && e.fact.id === s.id && e.fact.hash === s.hash && e.fact.outside);
  // Only what the listing showed: `all` is exactly its facts changed outside.
  const acceptable = (s: Shown | undefined) => !!s && s.listed && s.outside;
  const picked = target === 'all' ? shown.filter(acceptable) : (() => {
    const n = Number(target);
    const s = Number.isInteger(n) ? shown[n - 1] : undefined;
    return acceptable(s) ? [s!] : null;
  })();
  if (!picked) {
    const which = shown.flatMap((s, i) => (acceptable(s) ? [String(i + 1)] : [])).join(', ');
    return { note: which ? `/memory accept needs the number of a memory ${OUTSIDE_MARK} (${which}) or "all".` : `Nothing to accept — no memory listed was ${OUTSIDE_MARK}.` };
  }
  if (!picked.length) return { note: `Nothing to accept — no memory listed was ${OUTSIDE_MARK}.` };
  if (!picked.every(still)) return again(`Changed since it was listed — nothing accepted. The list as it is now:`);
  const accept = picked.map(({ scope, id, hash }) => ({ scope, id, hash }));
  const one = picked.length === 1 ? current.find((e) => e.scope === picked[0]!.scope && e.fact.id === picked[0]!.id)!.fact : null;
  return {
    note: one ? `Accepted: ${clip(one.text, 100)} — its line is sent from the next message.` : `Accepted ${plural(picked.length)} ${OUTSIDE_MARK}; their lines are sent from the next message.`,
    accept,
  };
}

// What `/clear` says about what it did NOT clear.
export function keptAfterClear(count: number): string {
  if (!count) return '';
  return `Conversation cleared. ${count === 1 ? '1 memory is' : `${count} memories are`} kept — the assistant still knows ${count === 1 ? 'it' : 'them'}. /memory shows and removes.`;
}
