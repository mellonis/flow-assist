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
//   call     one tool call: `name`, `args`, `outcome`, `result`, what it `changes`d,
//            the `views` it left in their final state with their text
//   shell    a `!command` the person ran, written when it starts: `command`, `cwd`
//            (from a state file: with its `output` too)
//   shell-end  how it ended: `output`, `status` (the exit), `ms`
//   compact  a `/compact`: the `summary` the model was given from then on
//   end      how a turn ended: its duration, what it cost, stopped or failed, and the
//            text of a round cut off
//
// `/export` renders a journal as markdown (`exportMarkdown`).
//
// Pure but for the two file functions; the chat decides when an event happens.
import fs from 'node:fs';
import path from 'node:path';
import { formatBytes } from './session-picker.js';
import { VIEW_CAPS, fence, resolveRenderer, type ViewRecord, type ViewRenderers } from './views.js';
import { readParts } from './step.js';

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
export function appendJournal(file: string, ev: JournalEvent): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, journalLine({ ...ev, at: ev.at ?? new Date().toISOString() }), { mode: 0o600 });
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

// A row as the screen list keeps it, as a journal event — how a session saved before it
// had a journal brings what its state file still holds into the journal it starts. null
// for what the person never saw (the system prompt).
export function rowOf(m: Record<string, unknown>, renderers: ViewRenderers): JournalEvent | null {
  const text = typeof m.content === 'string' ? m.content : '';
  switch (m.role) {
    case 'user': case 'bg': return { t: 'row', role: m.role, text, ...(m.hostAsk ? { hostAsk: true } : {}) };
    case 'note': return typeof m.summary === 'string' ? { t: 'compact', summary: m.summary, note: text } : { t: 'row', role: 'note', text };
    case 'shell': return { t: 'shell', command: String(m.command ?? ''), output: text };
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

function callBlock(ev: Record<string, unknown>): string {
  const head = `${String(ev.name ?? 'call')} · ${String(ev.outcome ?? '')}${ev.write ? ' · write' : ''}`;
  const out = ['<details>', `<summary>${head.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)}</summary>`, ''];
  out.push('Arguments:', '', block(asText(ev.args ?? {}), 'json'), '');
  if (ev.result !== undefined) out.push('Result:', '', block(asText(ev.result)), '');
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
  for (const ev of events) {
    const at = when(ev.at);
    const text = typeof ev.text === 'string' ? ev.text : '';
    switch (ev.t) {
      case 'row':
        if (ev.role === 'user') out.push(`**${ev.hostAsk ? 'The host asked' : 'You'}**${at}`, '', text, '');
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
      case 'call': out.push(callBlock(ev), ''); break;
      case 'shell':
        out.push(`**$ ${String(ev.command ?? '')}**${at}`, '');
        if (typeof ev.output === 'string') out.push(block(ev.output, 'console'), '');
        break;
      case 'shell-end': out.push(block(String(ev.output ?? ''), 'console'), '', `*${String(ev.status ?? 'ended')}${typeof ev.ms === 'number' ? ` · ${(ev.ms / 1000).toFixed(1)} s` : ''}*`, ''); break;
      case 'compact': out.push('---', '', `**Compacted**${at} — from here on the model was given this summary instead of the conversation above:`, '', quoted(String(ev.summary ?? '')), '', '---', ''); break;
      case 'end': {
        if (typeof ev.cut === 'string' && ev.cut) out.push(`**Assistant**${at} (cut off)`, '', ev.cut, '');
        const how = [ev.stopped ? `stopped (${String(ev.stopped)})` : '', ev.failed ? `failed: ${String(ev.failed)}` : '', ev.roundLimit ? `stopped after ${String(ev.roundLimit)} rounds — no answer` : ''].filter(Boolean);
        if (how.length) out.push(`*${how.join(' · ')}*`, '');
        break;
      }
      default: break;
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}
