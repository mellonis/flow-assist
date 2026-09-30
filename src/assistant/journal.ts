// A session's journal: `<id>.log.jsonl` beside its state file, one JSON event per line,
// appended as things happen and never trimmed. The state file (./sessions.ts) is what a
// restart restores, bounded and rewritten on every save; the journal is the record of
// what happened — every row the person saw, every tool call with its arguments and
// its result as the tool returned it (before the cap the model's history applies and
// before a recall stub), every `/compact` with its summary. A line is written with one
// `appendFileSync`, so a crash loses at most the event being written.
//
// The events (`t`):
//   start    the journal's first line: the session's id, `parent` when it was forked
//            from another session, `continued` when it began after the session did
//            (a session saved before it had a journal: its rows follow, `imported`)
//   row      a row of the conversation — `role` user, bg, note, assistant, view
//   step     the text of a round that went on to call tools
//   answer   the final text of a turn
//   call-start  a tool call beginning: `id`, `name`, `args` whole, `confirm` — whether
//            it waits on a y/n (so a crash mid-call still records what was running)
//   confirm  the y/n's answer: `answer` yes or no, and `by` — the person, the auto mode,
//            a background task's run, a stop (Esc or Ctrl+C on the turn), a reset
//   call-out the output of the host's run_command as it arrives (`id`, `text`), whole, as
//            `shell-out` is for a `!command`, with the same cap and note
//   call     one tool call ended: `name`, `args`, `outcome`, `result` (the text the tool
//            returned), `raw` (the data behind a framed result, whole; `null` — none),
//            the `images` it returned (names and sizes), what it `changes`d, the
//            `views` it left in their final state with their text
//            A call made by a background task carries `task`, the task's label.
//   shell    a `!command` the person ran, written when it starts: `command`, `cwd`
//            (from a state file: with its `output` too)
//   shell-out  its output as it arrives, in chunks (`text`), whole — more than the
//            screen and the model keep — up to OUTPUT_CAP per command; past it, one
//            last `shell-out` with `capped` and the `total` bytes the command printed
//   shell-end  how it ended: `status` (the exit), `ms`
//   compact  a `/compact`: the `summary` the model was given from then on
//   end      how a turn ended: its duration, what it cost, stopped or failed, and the
//            text of a round cut off
//   task-end a background task that stopped without finishing: `task` (its label),
//            `outcome` stopped, and `by` — what stopped it (`clear`: its session was
//            cleared)
//
// `/export` renders a journal as markdown (`exportMarkdown`).
//
// Pure but for the two file functions; the chat decides when an event happens.
import { redactDeep } from './secrets.js';
import fs from 'node:fs';
import path from 'node:path';
import { formatBytes } from './session-picker.js';
import { VIEW_CAPS, fence, resolveRenderer, type ViewRecord, type ViewRenderers } from './views.js';
import { readParts } from './step.js';
import { runMark } from './shell.js';
import { formatDuration } from './duration.js';

export type JournalEvent = Record<string, unknown> & { t: string; at?: string };

// One line's bound. A single event larger than this (a tool that returned a whole
// database dump) is written with its largest fields replaced by a note of their size:
// one such result must not make the journal unreadable or the append slow.
export const JOURNAL_LINE_MAX = 4 * 1024 * 1024;

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

// The event as one line, newline included, at most JOURNAL_LINE_MAX bytes before it:
// fields are replaced largest first until it fits, and `omitted` names each one with
// its size in bytes.
export function journalLine(ev: JournalEvent): string {
  const line = JSON.stringify(ev);
  if (bytes(line) <= JOURNAL_LINE_MAX) return `${line}\n`;
  const out: Record<string, unknown> = { ...ev };
  const sizes = Object.keys(out).filter((k) => k !== 't' && k !== 'at')
    .map((k) => [k, bytes(JSON.stringify(out[k]) ?? '')] as const)
    .sort((a, b) => b[1] - a[1]);
  const omitted: Record<string, number> = {};
  let fitted = line;
  for (const [key, size] of sizes) {
    out[key] = `[not kept: ${formatBytes(size)} — over the journal's ${formatBytes(JOURNAL_LINE_MAX)} line bound]`;
    omitted[key] = size;
    out.omitted = omitted;
    fitted = JSON.stringify(out);
    if (bytes(fitted) <= JOURNAL_LINE_MAX) break;
  }
  return `${fitted}\n`;
}

// Appends one event, stamped with the time it happened unless it carries one already
// (an event held until the session had an id). The directory is the sessions', 700;
// the file is created 600 — it holds whatever the conversation held.
// Every line is written without a known secret (./secrets.ts) — the backstop behind
// the choke points: a tool call's arguments, a round's text, anything an event carries.
// At write time only: what ran, ran as the model wrote it.
export function appendJournal(file: string, ev: JournalEvent): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, journalLine(redactDeep({ ...ev, at: ev.at ?? new Date().toISOString() })), { mode: 0o600 });
}

// Every event in order; a line that does not parse (a write cut by a crash, a hand
// edit) is skipped. null — there is no journal.
export function readJournal(file: string): JournalEvent[] | null {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const out: JournalEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as JournalEvent;
      if (ev && typeof ev === 'object' && typeof ev.t === 'string') out.push(ev);
    } catch { /* a broken line — skipped */ }
  }
  return out;
}

// A view as plain text, as its renderer draws it opened in full: the spans of each line
// joined, the chrome left out. '' when nothing can draw it (its plugin is gone) or the
// renderer throws.
export function viewText(rec: ViewRecord, renderers: ViewRenderers): string {
  if (!rec || typeof rec !== 'object' || typeof rec.kind !== 'string') return '';
  const render = resolveRenderer(renderers, rec.kind);
  if (!render) return '';
  try {
    const lines = render(rec.data, { width: 200, folded: false, live: false, failed: rec.phase === 'failed', elapsedMs: 0, lines: VIEW_CAPS.lines, moreKey: '' });
    if (!Array.isArray(lines)) return '';
    return lines.map((l) => (Array.isArray(l) ? l.filter((s) => !s?.chrome).map((s) => String(s?.text ?? '')).join('') : '')).join('\n');
  } catch { return ''; }
}

// A view as the journal keeps it: the record and what it drew.
export function viewEntry(rec: ViewRecord, renderers: ViewRenderers): Record<string, unknown> {
  return { kind: rec.kind, phase: rec.phase, data: rec.data, text: viewText(rec, renderers) };
}

// A command's output as it arrives, into the journal: held until a chunk fills
// (`chunkBytes`) or a moment has passed (`schedule`, 200 ms), so a command that prints
// line by line costs a few appends, not one per line — and a crash loses at most that
// moment. At most `capBytes` of it is written; `end()` flushes what is held and, when
// the cap was hit, writes the note with the total.
export const OUTPUT_CAP = 8 * 1024 * 1024;
export const OUTPUT_CHUNK = 64 * 1024;
export function outputJournal(
  write: (ev: JournalEvent) => void,
  opts: { capBytes?: number; chunkBytes?: number; schedule?: (fn: () => void) => void } = {},
): { push: (chunk: string) => void; end: () => void } {
  const cap = opts.capBytes ?? OUTPUT_CAP;
  const size = opts.chunkBytes ?? OUTPUT_CHUNK;
  const schedule = opts.schedule ?? ((fn: () => void) => { setTimeout(fn, 200); });
  let held = '';
  let heldBytes = 0;
  let kept = 0;
  let total = 0;
  let armed = false;
  const flush = () => {
    armed = false;
    if (!held) return;
    write({ t: 'shell-out', text: held });
    held = ''; heldBytes = 0;
  };
  return {
    push: (chunk: string) => {
      const n = bytes(chunk);
      total += n;
      if (kept >= cap) return;
      let take = chunk;
      if (kept + n > cap) {
        // Cut at the cap, never inside a character.
        let room = cap - kept;
        take = '';
        for (const ch of chunk) { const b = bytes(ch); if (b > room) break; take += ch; room -= b; }
      }
      const b = bytes(take);
      kept += b; held += take; heldBytes += b;
      if (heldBytes >= size || kept >= cap) flush();
      else if (!armed) { armed = true; schedule(flush); }
    },
    end: () => {
      flush();
      if (total > kept) write({ t: 'shell-out', capped: true, total });
    },
  };
}

// A call's two events, from what the agent loop reports (./agent.ts `onToolStart`,
// `onToolRun`). `extra` — `task` for a background task's call.
export function callStartEvent(call: { id?: string; name: string; args: Record<string, unknown>; confirm: boolean }, extra: Record<string, unknown> = {}): JournalEvent {
  return { t: 'call-start', ...(call.id ? { id: call.id } : {}), name: call.name, args: call.args, confirm: call.confirm, ...extra };
}
export function callEndEvent(run: { id?: string; name: string; args: Record<string, unknown>; outcome: string; write?: boolean; detail: unknown; raw?: string | null; images?: unknown[]; changes?: unknown[]; views?: ViewRecord[] }, renderers: ViewRenderers, extra: Record<string, unknown> = {}): JournalEvent {
  return {
    t: 'call', ...(run.id ? { id: run.id } : {}), name: run.name, args: run.args, outcome: run.outcome, ...(run.write ? { write: true } : {}),
    result: typeof run.detail === 'string' ? run.detail : JSON.stringify(run.detail ?? ''),
    ...(run.raw !== undefined ? { raw: run.raw } : {}),
    ...(run.images?.length ? { images: run.images } : {}),
    ...(run.changes?.length ? { changes: run.changes } : {}),
    ...(run.views?.length ? { views: run.views.map((v) => viewEntry(v, renderers)) } : {}),
    ...extra,
  };
}

// A row as the screen list keeps it, as a journal event — how a session saved before it
// had a journal brings what its state file still holds into the journal it starts. null
// for what the person never saw (the system prompt).
export function rowOf(m: Record<string, unknown>, renderers: ViewRenderers): JournalEvent | null {
  const text = typeof m.content === 'string' ? m.content : '';
  switch (m.role) {
    case 'user': case 'bg': return { t: 'row', role: m.role, text, ...(m.hostAsk ? { hostAsk: true } : {}) };
    case 'note': return typeof m.summary === 'string' ? { t: 'compact', summary: m.summary, note: text } : { t: 'row', role: 'note', text };
    case 'shell': {
      const v0 = Array.isArray(m.views) ? (m.views[0] as ViewRecord | undefined) : undefined;
      const interactive = (v0?.data as { interactive?: boolean } | undefined)?.interactive === true;
      return { t: 'shell', command: String(m.command ?? ''), output: text, ...(interactive ? { interactive: true } : {}) };
    }
    case 'view': {
      const views = Array.isArray(m.views) ? (m.views as ViewRecord[]).map((v) => viewEntry(v, renderers)) : [];
      return views.length ? { t: 'row', role: 'view', views } : null;
    }
    case 'assistant': {
      const parts = readParts(m.parts);
      const steps = parts.flatMap((p) => (p.kind === 'text' && p.text.trim() ? [p.text] : []));
      const calls = parts.flatMap((p) => (p.kind === 'tools' ? p.runs : []));
      const changes = parts.flatMap((p) => (p.kind === 'change' ? [p.change] : []));
      return {
        t: 'row', role: 'assistant', text,
        ...(steps.length ? { steps } : {}), ...(calls.length ? { calls } : {}), ...(changes.length ? { changes } : {}),
        ...(typeof m.reasoning === 'string' && m.reasoning ? { reasoning: m.reasoning } : {}),
      };
    }
    default: return null;
  }
}

// ─── /export ────────────────────────────────────────────────────────────────────
// A journal as a markdown document to read: the conversation in order, each tool call
// folded as a `<details>` block with its arguments and its result, each `/compact`'s
// summary where it happened. Everything the conversation quoted goes in a fence longer
// than any backtick run it holds (`fence`), so nothing it carries can close the fence
// and write markdown of its own. `noJournal` — the events were made from a state file
// (`rowOf`), for a session that has no journal.

const block = (text: string, lang = '') => { const f = fence(text); return `${f}${lang}\n${text.replace(/\n+$/, '')}\n${f}`; };
const quoted = (text: string) => text.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
const when = (at: unknown) => {
  const d = new Date(String(at ?? ''));
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return ` · ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const asText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '');

// Who settled a y/n, in words.
const CONFIRMED_BY: Record<string, string> = {
  person: 'the person', auto: 'the auto mode', background: 'the background task', plugin: 'the plugin that ran it',
  stop: 'a stop (the turn was stopped)', reset: 'a reset of the conversation',
};

// `confirm` — the y/n's answer, when the call waited on one.
function callBlock(ev: Record<string, unknown>, confirm?: Record<string, unknown>): string {
  const outcome = ev.t === 'call-start' ? 'did not finish' : String(ev.outcome ?? '');
  const head = `${String(ev.name ?? 'call')} · ${outcome}${ev.write ? ' · write' : ''}${typeof ev.task === 'string' ? ` · background task «${ev.task}»` : ''}`;
  const out = ['<details>', `<summary>${head.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)}</summary>`, ''];
  out.push('Arguments:', '', block(asText(ev.args ?? {}), 'json'), '');
  if (confirm) out.push(`Asked y/n — answered ${String(confirm.answer)} by ${CONFIRMED_BY[String(confirm.by)] ?? String(confirm.by)}.`, '');
  else if (ev.t === 'call-start' && ev.confirm) out.push('It was waiting on a y/n.', '');
  if (ev.result !== undefined) out.push('Result:', '', block(asText(ev.result)), '');
  if (typeof ev.output === 'string' && ev.output) out.push('Output, whole:', '', block(ev.output, 'console'), '', ...(ev.outputNote ? [String(ev.outputNote), ''] : []));
  if (ev.raw === null) out.push('Data: none.', '');
  else if (typeof ev.raw === 'string') out.push('Data:', '', block(ev.raw), '');
  for (const im of Array.isArray(ev.images) ? ev.images as { name?: unknown; width?: unknown; height?: unknown }[] : []) out.push(`Image: ${String(im.name ?? '')}${im.width ? ` · ${String(im.width)}×${String(im.height)}` : ''}`, '');
  for (const c of Array.isArray(ev.changes) ? ev.changes as { title?: unknown; diff?: unknown }[] : []) out.push(`Changed ${String(c.title ?? '')}:`, '', block(String(c.diff ?? ''), 'diff'), '');
  for (const v of Array.isArray(ev.views) ? ev.views as { kind?: unknown; text?: unknown }[] : []) if (v.text) out.push(`Shown (${String(v.kind ?? 'view')}):`, '', block(String(v.text)), '');
  out.push('</details>');
  return out.join('\n');
}

export function exportMarkdown(events: JournalEvent[], opts: { title: string; id: string; noJournal?: boolean }): string {
  const out: string[] = [`# ${opts.title.replace(/\s+/g, ' ').trim() || opts.id}`, '', `Session \`${opts.id}\``, ''];
  const start = events.find((e) => e.t === 'start');
  if (opts.noJournal) out.push('> This session has no journal (it was saved before journals were kept, or its journal was removed after `sessions.journalDays`): it is rendered from its saved state, whose beginning may be missing and whose tool calls are kept only in short.', '');
  else if (start?.continued) out.push('> The journal began partway through this session: the part before it comes from its saved state, whose beginning may be missing and whose tool calls are kept only in short.', '');
  if (typeof start?.parent === 'string') out.push(`> This session was forked from \`${start.parent}\` — what came before is in that session's journal and its export.`, '');
  // A call is drawn once, where it began: its start holds a place the end fills; a
  // start never ended is drawn as not finished. Keyed by call id and name — a provider
  // may reuse an id in a later round, after the first call with it has ended.
  const open = new Map<string, { slot: number; start: JournalEvent; confirm?: JournalEvent }>();
  // A command's output, stitched back from its chunks; drawn when the command ends (or
  // the next command begins, for one that never did).
  let output = '';
  let outputNote = '';
  let shellOpen = false;
  // `unfinished` — the command never ended (a crash): said where it stands.
  const flushOutput = (unfinished = false) => {
    if (output) out.push(block(output, 'console'), '');
    if (outputNote) out.push(outputNote, '');
    if (unfinished) out.push('*did not finish — the journal has no end for this command*', '');
    output = ''; outputNote = ''; shellOpen = false;
  };
  // A call's output, stitched the same way, by the call's key.
  const callOut = new Map<string, { text: string; note: string }>();
  const keyOf = (ev: JournalEvent) => `${String(ev.task ?? '')}\u0000${String(ev.id ?? '')}\u0000${String(ev.name ?? '')}`;
  for (const ev of events) {
    const at = when(ev.at);
    // Anything of the conversation after a command that never ended: its output is
    // drawn where it stands, not below what came after. A background task's calls run
    // beside a command and do not close it.
    if (shellOpen && ev.t !== 'shell-out' && ev.t !== 'shell-end' && typeof ev.task !== 'string') flushOutput(true);
    const text = typeof ev.text === 'string' ? ev.text : '';
    switch (ev.t) {
      case 'row':
        if (ev.role === 'user') out.push(`**${ev.hostAsk ? 'The host asked' : 'You'}**${at}${ev.midTurn ? ' (during the turn, after its last step)' : ''}`, '', text, '');
        else if (ev.role === 'bg') out.push(`**Background result**${at}`, '', text, '');
        else if (ev.role === 'note') out.push(`*Note${at}:* ${text.split('\n')[0]}`, ...(text.includes('\n') ? ['', block(text.split('\n').slice(1).join('\n'))] : []), '');
        else if (ev.role === 'view') for (const v of Array.isArray(ev.views) ? ev.views as { text?: unknown }[] : []) out.push(block(String(v.text ?? '')), '');
        else if (ev.role === 'assistant') {
          for (const st of Array.isArray(ev.steps) ? ev.steps as string[] : []) out.push(`*Step:* ${st}`, '');
          const calls = Array.isArray(ev.calls) ? ev.calls as { name?: unknown; outcome?: unknown; args?: unknown }[] : [];
          if (calls.length) out.push(...calls.map((c) => `- \`${String(c.name)}\` · ${String(c.outcome)}${c.args ? ` · ${JSON.stringify(c.args)}` : ''}`), '');
          if (text) out.push(`**Assistant**${at}`, '', text, '');
        }
        break;
      case 'step': out.push(`*Step${at}:* ${text}`, ''); break;
      case 'answer': out.push(`**Assistant**${at}`, '', text, ''); break;
      case 'call-start': open.set(keyOf(ev), { slot: out.length, start: ev }); out.push('', ''); break;
      case 'confirm': { const o = open.get(keyOf(ev)); if (o) o.confirm = ev; break; }
      case 'call-out': {
        const k = keyOf(ev);
        const c = callOut.get(k) ?? { text: '', note: '' };
        if (typeof ev.text === 'string') c.text += ev.text;
        if (ev.capped) c.note = `*the journal keeps the first ${formatBytes(OUTPUT_CAP)} of this output — ${String(ev.total)} bytes in all*`;
        callOut.set(k, c);
        break;
      }
      case 'call': {
        const k = keyOf(ev);
        const o = open.get(k);
        const c = callOut.get(k);
        callOut.delete(k);
        const whole = c ? { ...ev, output: c.text, outputNote: c.note } : ev;
        if (o) { out[o.slot] = callBlock(whole, o.confirm); open.delete(k); } else out.push(callBlock(whole), '');
        break;
      }
      case 'shell':
        shellOpen = true;
        out.push(`**${runMark(ev.interactive === true)} ${String(ev.command ?? '')}**${at}`, '');
        // A command from a state file carries the output that file kept.
        if (typeof ev.output === 'string') out.push(block(ev.output, 'console'), '');
        break;
      case 'shell-out':
        if (typeof ev.text === 'string') output += ev.text;
        if (ev.capped) outputNote = `*the journal keeps the first ${formatBytes(OUTPUT_CAP)} of this output — ${String(ev.total)} bytes in all*`;
        break;
      case 'shell-end':
        flushOutput();
        out.push(`*${String(ev.status ?? 'ended')}${typeof ev.ms === 'number' ? ` · ${formatDuration(ev.ms)}` : ''}*`, '');
        break;
      case 'markup': out.push(`*Note${at}:* ${String(ev.note ?? '')} — the model wrote:`, '', block(String(ev.markup ?? '')), ''); break;
      case 'compact': out.push('---', '', `**Compacted${ev.auto ? ' automatically' : ''}**${at} — from here on the model was given this summary instead of the conversation above:`, '', quoted(String(ev.summary ?? '')), '', '---', ''); break;
      case 'task-end': out.push(`*${String(ev.task ?? '')} stopped (${String(ev.by ?? '')})*`, ''); break;
      case 'end': {
        if (typeof ev.cut === 'string' && ev.cut) out.push(`**Assistant**${at} (cut off)`, '', ev.cut, '');
        const how = [ev.stopped ? `stopped (${String(ev.stopped)})` : '', ev.failed ? `failed: ${String(ev.failed)}` : '', ev.roundLimit ? `stopped after ${ev.limitBy === 'tokens' ? `${String(ev.turnTokens)} tokens (ai.maxTurnTokens)` : `${String(ev.roundLimit)} rounds (ai.maxRounds)`} — no answer${ev.lastStep ? `; last step: ${String(ev.lastStep)}` : ''}` : ''].filter(Boolean);
        if (how.length) out.push(`*${how.join(' · ')}*`, '');
        break;
      }
      default: break;
    }
  }
  if (shellOpen) flushOutput(true);
  for (const [k, o] of open) { const c = callOut.get(k); out[o.slot] = callBlock(c ? { ...o.start, output: c.text, outputNote: c.note } : o.start, o.confirm); }
  return `${out.join('\n').trimEnd()}\n`;
}
