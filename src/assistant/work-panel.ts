// The work picker's rows: the session's subagents and background shells as one list the
// picker draws under its two group headers. Pure — data in, rows out, no app import:
// the picker maps the live tree and the host jobs into `WorkSub` and `WorkJob` and
// draws what this returns as the panel's rows.
//
// A row is ended when its state is an end word (`ended …`, `exited …`, `killed …`);
// every other state — `running`, `stopping`, `waiting …` — is live, and an ended row
// sits after the live ones of its group, input order kept inside each.
//
// The detail words: a subagent's is its state — `running` (with its running title,
// `running — <title>`, when it has one), `waiting for you — <title>`, `ended —
// <verdict>` — and a row the person must answer (`asking`) says `? waiting for you`
// and takes the `warn` tone. A shell's is `<state> — <owner>`. The renderer cuts long
// rows, not this mapping.

export interface WorkSub { key: string; path: readonly string[]; state: string; asking: boolean; title?: string }
export interface WorkJob { id: string; command: string; state: string; owner: string }
export interface WorkRow { id: string; group: 'subagents' | 'shells'; text: string; detail?: string; tone?: 'ok' | 'warn' | 'error' }

const ENDED_STATE = /^(ended|exited|killed)/;

const subRow = (s: WorkSub): WorkRow => ({
  id: `sub:${s.key}`,
  group: 'subagents',
  text: s.path.join(' › '),
  detail: s.asking ? '? waiting for you' : s.state === 'running' && s.title ? `running — ${s.title}` : s.state,
  ...(s.asking ? { tone: 'warn' as const } : {}),
});

const jobRow = (j: WorkJob): WorkRow => ({
  id: `shell:${j.id}`,
  group: 'shells',
  text: `${j.id} · ${j.command}`,
  detail: `${j.state} — ${j.owner}`,
});

// `now` is accepted so the caller passes its clock uniformly; the mapping does no clock
// math — the words are the state words as given.
export function workRows(subs: readonly WorkSub[], jobs: readonly WorkJob[], now?: number): WorkRow[] {
  void now;
  const byState = <T,>(items: readonly T[], state: (t: T) => string, toRow: (t: T) => WorkRow): WorkRow[] =>
    [...items.filter((t) => !ENDED_STATE.test(state(t))), ...items.filter((t) => ENDED_STATE.test(state(t)))].map(toRow);
  return [...byState(subs, (s) => s.state, subRow), ...byState(jobs, (j) => j.state, jobRow)];
}
