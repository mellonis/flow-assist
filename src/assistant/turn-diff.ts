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
// Where a report goes is what its title says. A title that names a path — `~/…`, `/…`,
// or a relative path that resolves to a real file under one of the tops the walk knows —
// is a change to a file: it keeps the title as its path and is sectioned under the real
// root its path lies in — a repository's top when one holds the file, the file's own
// real location when none does — as the walk sections a git top. The real writers spell
// a relative path the way they know it: the repo plugin writes `basename(root)/rel`,
// `examples/notes` bare names — both resolve under a top. A relative title is matched on
// the real path and only where exactly one file answers it; anything else is reported,
// never guessed at. A path the turn reports again keeps every report its own row: the
// first is keyed by the file's own name under its root (the walk keys the file by that
// name too, so a mark carries across sources), a repeat by its place among the turn's
// reports. Any other title (`ABC-1 · description`) is a change to something that is not
// a file: one `reported` section for the turn's whole group, each report its own row
// keyed by its place among the group (a title may repeat). The reported group goes after
// the path sections, as the panel draws it.
//
// Pure: no React, no clock, no git. The only path work reads where a path lies: the
// `realOf` and `gitRootOf` of a title's file, and the one stat that says whether a
// relative title resolves to one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMsg } from './conversation-types.js';
import type { ChangeView } from './diff.js';
import { gitRootOf } from './sessions.js';
import { realOf } from './shell.js';
import type { DiffSection, FileDiff } from './working-tree.js';

// A title that names a file wherever it lies. Every other title names one only where it
// resolves under a top the walk knows (`titleFileUnder`); what resolves nowhere is a
// change to something that is not a file (`ABC-1 · description`) and is reported.
const isPathTitle = (title: string): boolean => title.startsWith('~/') || title.startsWith('/');

// Where a relative title names a file, or `null`. The tops the walk knows — its own git
// tops (`workingTreeDiff`'s, at the caller) and the roots the turn's path changes lie
// under — are probed both ways the real writers spell a path: bare `rel` under the top,
// and `basename(top)/rel` (the repo plugin writes `basename(root)/rel` where `root` is
// the top itself). The answer is the one real file those probes find: a title two tops
// both hold is a title that could be either file, and the classification never guesses —
// the change is reported. A title with `..` in it names no file a writer spells.
function titleFileUnder(title: string, tops: readonly string[]): string | null {
  const found = new Set<string>();
  for (const top of tops) {
    const base = path.basename(top);
    const rels = title.startsWith(`${base}/`) ? [title, title.slice(base.length + 1)] : [title];
    for (const rel of rels) {
      if (rel === '' || rel.split('/').includes('..')) continue;
      const abs = realOf(path.join(top, rel));
      try { if (fs.statSync(abs).isFile()) found.add(abs); } catch { /* nothing there */ }
    }
  }
  return found.size === 1 ? [...found][0]! : null;
}

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
// count of the lines it dropped (`note: 'cut'`). A row's `key`, when given, is either
// the file's own name under its root (where the drawn path is not that name) or an
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
// order; a title may repeat, and a reported row stays its own row (`key`). `tops` names
// the tops a relative title resolves under — the walk's own git tops, at the caller.
export function lastTurnChanges(messages: readonly ChatMsg[], tops: readonly string[] = []): DiffSection[] {
  // The person's last row starts the turn; a queued message delivered mid-turn is
  // marked `midTurn` and is part of the turn it arrived in. With no row at all the
  // whole conversation is the turn — a follow-up the inbox started has no row of its
  // own, and its reports answer here too.
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && !m.midTurn) { start = i + 1; break; }
  }
  const changes: ChangeView[] = [];
  for (let i = start; i < messages.length; i++) {
    for (const part of messages[i]!.parts ?? []) {
      if (part.kind === 'change') changes.push(part.change);
    }
  }
  // The tops a relative title is matched against: the walk's own, plus every root the
  // turn's path changes lie under — the sections this walk already has.
  const knownTops = new Set<string>(tops);
  for (const change of changes) {
    if (!isPathTitle(change.title)) continue;
    const root = gitRootOf(realOf(expandedTitle(change.title)));
    if (root) knownTops.add(root);
  }
  const topList = [...knownTops];
  const sectionsByRoot = new Map<string, DiffSection>();
  const reported: FileDiff[] = [];
  // The rows one file already got. The FIRST row of a file keys the file's own name
  // under its root — the walk keys the same file by that name
  // (`diffFileKey(root, key ?? path)`), so a mark carries across sources; a row drawn
  // as its own name keys nothing extra — and every later row of that file is keyed by
  // its place among the turn's reports. Two rows of one file then never share a key
  // (their hunks stay their own; reports are never merged).
  const seenFiles = new Set<string>();
  let reportIndex = 0;
  for (const change of changes) {
    const status = statusOf(change);
    const place = reportIndex++;
    const real = isPathTitle(change.title)
      ? realOf(expandedTitle(change.title))
      : titleFileUnder(change.title, topList);
    if (real === null) {
      reported.push(fileOf(change, status, `\u0000${reported.length}`));
      continue;
    }
    const root = gitRootOf(real) ?? real;
    let section = sectionsByRoot.get(root);
    if (!section) { section = { root, base: '', files: [] }; sectionsByRoot.set(root, section); }
    const name = path.relative(root, real).split(path.sep).join('/');
    const repeat = seenFiles.has(real);
    seenFiles.add(real);
    section.files.push(fileOf(change, status, repeat ? `\u0000${place}` : (name && name !== change.title ? name : undefined)));
  }
  return reported.length ? [...sectionsByRoot.values(), { root: '', base: '', kind: 'reported', files: reported }] : [...sectionsByRoot.values()];
}
