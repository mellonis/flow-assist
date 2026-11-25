// The last turn's write reports, as the `/diff` panel's one non-git source.
//
// A write tool reports what it changed (`ctx.reportChange`); the chat keeps each report
// among the turn's parts, as a change's diff (./diff.ts). This module maps the LAST
// turn's reports into the same `DiffSection[]` the working-tree walk answers
// (./working-tree.ts), so the panel draws both sources with one renderer.
//
// The last turn is everything after the person's last row (`role === 'user'`, never a
// queued message delivered mid-turn) — the row the turn started at. Its `kind: 'change'`
// parts are the reports, oldest first. A turn with no reports answers `[]`: the panel
// words that, and no section here ever reads as a clean working tree.
//
// Where a report goes is what its title says. A title that names a path (`~/…`, `/…`)
// is a change to a file: it keeps the title as its path and is sectioned under the real
// root its path lies in — a repository's top when one holds the file, the file's own
// real location when none does — as the walk sections a git top. A path the turn
// reports again keeps every report its own row: the first is keyed by its path (a mark
// carries across sources), a repeat by its place among the turn's reports. Any other
// title (`ABC-1 · description`) is a change to something that is not a file: one
// `reported` section for the turn's whole group, each report its own row keyed by its
// place among the group (a title may repeat). The reported group goes after the path
// sections, as the panel draws it.
//
// Pure: no React, no clock, no git. The only path work is `realOf` and `gitRootOf`,
// reading where a path lies.

import os from 'node:os';
import path from 'node:path';
import type { ChatMsg } from './conversation-types.js';
import type { ChangeView } from './diff.js';
import { gitRootOf } from './sessions.js';
import { realOf } from './shell.js';
import type { DiffSection, FileDiff } from './working-tree.js';

// A title that names a file. Every other title is a change to something that is not
// one (`ABC-1 · description`) and is reported, not walked.
const isPathTitle = (title: string): boolean => title.startsWith('~/') || title.startsWith('/');

// What a record's diff says about the two texts behind it. The texts themselves are
// not kept (the record holds the diff), but `unifiedDiff` writes what they held into
// the hunk headers: `@@ -0,0 …` is a change made FROM empty text — the report created
// the thing (`A`) — and `+0,0` a change made TO empty text — it deleted the thing
// (`D`). A header that is not that shape (a hand-edited session) reads as `M`, which
// is also what a record with no hunks at all reads as.
function statusOf(change: ChangeView): 'A' | 'M' | 'D' {
  const headers = change.diff.split('\n').filter((line) => line.startsWith('@@ '));
  if (headers.length > 0 && headers.every((h) => /^@@ -0,0 /.test(h))) return 'A';
  if (headers.length > 0 && headers.every((h) => /^@@ -\d+,\d+ \+0,0 @@/.test(h))) return 'D';
  return 'M';
}

// The title of a path change, as the path the file lies at: `~/…` under the home it
// names, an absolute path as it is. The row still draws the title as given.
const expandedTitle = (title: string): string =>
  title.startsWith('~/') ? path.join(os.homedir(), title.slice(2)) : title;

// What a report carries on its row: the title as the path the row draws (for a path
// change the title IS the file's name, as the tool spelled it), the record's hunk text
// as kept, and — where the record did not keep the change whole — the note and the
// count of the lines it dropped (`note: 'cut'`). A row's `key`, when given, is an
// index: a reported row's place among the turn's reported changes, a repeated path
// row's place among all the turn's reports — its title may repeat either way.
const fileOf = (change: ChangeView, status: 'A' | 'M' | 'D', key?: string): FileDiff => ({
  status,
  path: change.title,
  ...(key !== undefined ? { key } : {}),
  added: change.added,
  removed: change.removed,
  hunks: change.diff,
  ...(change.hidden > 0 ? { note: 'cut' as const, hidden: change.hidden } : {}),
});

// The last turn's reports as `DiffSection[]` — the walk's shape, one section per root
// the turn's path changes lie under (`kind` absent — a tree section), the turn's other
// titles in one `reported` section at the end. Sections and files keep the turn's
// order; a title may repeat, and a reported row stays its own row (`key`).
export function lastTurnChanges(messages: readonly ChatMsg[]): DiffSection[] {
  // The person's last row starts the turn; a queued message delivered mid-turn is
  // marked `midTurn` and is part of the turn it arrived in. With no row at all the
  // whole conversation is the turn — a follow-up the inbox started has no row of its
  // own, and its reports answer here too.
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && !m.midTurn) { start = i + 1; break; }
  }
  const sectionsByRoot = new Map<string, DiffSection>();
  const reported: FileDiff[] = [];
  // Titles the turn mapped once already. The FIRST row of a path keeps the
  // path-derived key — the walk keys the same file by its path too, so a mark carries
  // across sources — and every later row of that path is keyed by its place among the
  // turn's reports. Two rows of one file then never share a key (their hunks stay
  // their own; reports are never merged).
  const seenPaths = new Set<string>();
  let reportIndex = 0;
  for (let i = start; i < messages.length; i++) {
    for (const part of messages[i]!.parts ?? []) {
      if (part.kind !== 'change') continue;
      const change = part.change;
      const status = statusOf(change);
      const place = reportIndex++;
      if (isPathTitle(change.title)) {
        const real = realOf(expandedTitle(change.title));
        const root = gitRootOf(real) ?? real;
        let section = sectionsByRoot.get(root);
        if (!section) { section = { root, base: '', files: [] }; sectionsByRoot.set(root, section); }
        const repeat = seenPaths.has(change.title);
        seenPaths.add(change.title);
        section.files.push(fileOf(change, status, repeat ? `\u0000${place}` : undefined));
      } else {
        reported.push(fileOf(change, status, `\u0000${reported.length}`));
      }
    }
  }
  return reported.length ? [...sectionsByRoot.values(), { root: '', base: '', kind: 'reported', files: reported }] : [...sectionsByRoot.values()];
}
