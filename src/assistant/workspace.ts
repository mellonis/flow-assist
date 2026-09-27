// The agent workspace: a directory per project that the host owns, beside the rest of
// what it keeps for itself — the model's memory as files (`memory/`, ./memory-store.ts)
// and its working files (`artifacts/`: drafts, notes, plans, findings it was asked to
// keep). Nothing in it is the person's, which is why a write there takes no y/n.
//
// Where: `<workspace root>/<mirror of the project's path>/_workspace/`, the project and
// the mirror being the sessions' own (`projectOf`, `projectHome` in ./sessions.ts); no
// project is `<root>/_global/_workspace/`, which also holds what is kept for every
// project. The leaf matters because mirrors nest: a repository inside a workspace root
// is a project of its own, and its mirror sits inside the outer project's — with the
// mirror itself as the workspace, the outer project could list and read the inner one's
// memory. Everything is confined to the leaf.
//
// The root is `workspace.dir`, else `projects/` under `hostStateDir()` — resolved on
// every call, never at import (AGENTS.md, "A test never reaches the person's own
// files"). Directories 0700, files 0600: a fact or a draft may hold whatever the
// conversation held.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostStateDir } from '../config/load.js';
import { projectHome, projectOf } from './sessions.js';
import { realOf, shellRoots, within } from './shell.js';

export const WORKSPACE_LEAF = '_workspace';
export const GLOBAL_PROJECT = '_global';
export type WorkspaceScope = 'project' | 'global';

export function workspaceRoot(config: Record<string, unknown> | undefined, env: Record<string, string | undefined> = process.env): string {
  const raw = (config?.workspace as { dir?: unknown } | undefined)?.dir;
  if (!raw) return path.join(hostStateDir(env), 'projects');
  const expanded = String(raw).replace(/^~(?=\/|$)/, os.homedir());
  return path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
}

// A project's workspace under a root; `null` — no project — is the global one.
// Every segment of the project's path that starts with `_` gets one more in the
// mirror (`_x` → `__x`, one-to-one), so no project's mirror can be the `_workspace`
// leaf of another or the `_global` one.
const escapeSegments = (project: string) => project.split(/([\\/])/).map((seg) => (seg.startsWith('_') ? `_${seg}` : seg)).join('');
export function workspaceDir(root: string, project: string | null): string {
  return path.join(project ? projectHome(root, escapeSegments(project)) : path.join(root, GLOBAL_PROJECT), WORKSPACE_LEAF);
}

// The workspace a call works in: the project's, or the global one.
export function workspaceFor(config: Record<string, unknown> | undefined, project: string | null, scope: WorkspaceScope = 'project'): string {
  return workspaceDir(workspaceRoot(config), scope === 'global' ? null : project);
}

// Creates the directory (and its parents) 0700. `mkdir`'s mode reaches only what it
// creates, so a leaf that was already there is set too.
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
}
export const ensureWorkspace = ensureDir;

// A path the model gave, inside a workspace: relative to it, no `..` anywhere, and its
// REAL location — every link on the way followed, a path that does not exist yet
// through its nearest existing parent — inside the workspace's real location. The
// refusal names the workspace, so the model knows where a path must lead.
export function resolveInWorkspace(ws: string, rel: string): { abs: string } | { error: string } {
  const s = String(rel ?? '').trim();
  // The path to use instead, whole — a model copies what a refusal shows.
  const use = `artifacts/${path.basename(s.replace(/[\\/]+$/, '')).replace(/^\.+$/, '') || 'notes.md'}`;
  const where = `paths are relative to the workspace, ${ws} — e.g. ${use}`;
  if (path.isAbsolute(s) || /^~(?=\/|$)/.test(s) || /^[a-zA-Z]:[\\/]/.test(s)) return { error: `«${s}» is not in the workspace — ${where}` };
  if (s.split(/[\\/]+/).includes('..')) return { error: `«${s}» leads out of the workspace — ${where}; a path never holds ..` };
  const abs = s ? path.join(ws, s) : ws;
  if (!within(realOf(abs), realOf(ws))) return { error: `«${s}» resolves through a link to ${realOf(abs)}, outside the workspace — ${where}` };
  return { abs };
}

// The project a tool call works in: the conversation's, when its owner says
// (`workspaceProject` — the chat's, decided at its first message as a session's is);
// else where the call's shell is, else the process's directory, by the sessions' rule.
export function callProject(config: Record<string, unknown> | undefined, ctx: { workspaceProject?: () => string | null; shell?: unknown } | undefined): string | null {
  if (typeof ctx?.workspaceProject === 'function') return ctx.workspaceProject();
  const shell = ctx?.shell as { cwd?: () => string } | undefined;
  const cwd = typeof shell?.cwd === 'function' ? shell.cwd() : process.cwd();
  try { return projectOf(cwd, shellRoots((config ?? {}) as Parameters<typeof shellRoots>[0])); } catch { return null; }
}

// A scope as the model wrote it: `project` (the default) or `global`; `host` is read as
// global.
export function readScope(raw: unknown): { scope: WorkspaceScope } | { error: string } {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s === 'project') return { scope: 'project' };
  if (s === 'global' || s === 'host') return { scope: 'global' };
  return { error: `invalid scope '${s}' — expected "project" or "global"` };
}

// A file written whole or not at all, 0600: a temp file beside it, renamed over it —
// the rename also replaces a link in the file's place rather than writing through it.
export function writePrivate(file: string, content: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}

// ─── The model's working files ────────────────────────────────────────────────────
// `workspace_write` / `workspace_read` / `workspace_list` (src/loader/tools-core.ts).
// A write goes under `artifacts/` only: `memory/` is the memory tool's, whose guards a
// plain write would pass by. Reading reaches the whole workspace — a fact is read that
// way. Every refusal throws, naming what to use instead, and a write's says nothing
// was changed (AGENTS.md, "A write tool refuses by throwing").
export const ARTIFACTS_DIR = 'artifacts';
export const WORKSPACE_FILE_MAX = 2 * 1024 * 1024;
const LIST_MAX = 500;

const refuseWrite = (msg: string): never => { throw new Error(`workspace_write: ${msg}. Nothing was changed.`); };

export function writeArtifact(ws: string, rel: string, content: string): { abs: string; before: string | null } {
  const r = resolveInWorkspace(ws, rel);
  if ('error' in r) return refuseWrite(r.error);
  // The first segment is checked as spelled AND as it really is: a link planted as
  // `artifacts` that leads to `memory/` must not carry a write past the memory's guards.
  const segs = path.relative(ws, r.abs).split(path.sep).filter(Boolean);
  const real = path.relative(realOf(ws), realOf(r.abs)).split(path.sep).filter(Boolean);
  if (segs[0] === 'memory' || real[0] === 'memory') refuseWrite(`memory/ is kept by the memory tool, which holds each fact to its rules — store a fact with memory action=add`);
  if (segs[0] !== ARTIFACTS_DIR || real[0] !== ARTIFACTS_DIR || segs.length < 2) refuseWrite(`working files go under ${ARTIFACTS_DIR}/ — write it as ${ARTIFACTS_DIR}/${segs.filter((s) => s !== ARTIFACTS_DIR).join('/') || 'notes.md'} (the workspace is ${ws})`);
  if (Buffer.byteLength(content, 'utf8') > WORKSPACE_FILE_MAX) refuseWrite(`the content is ${Buffer.byteLength(content, 'utf8')} bytes, and a workspace file may hold at most ${WORKSPACE_FILE_MAX}`);
  let before: string | null = null;
  try {
    const st = fs.lstatSync(r.abs);
    if (st.isSymbolicLink()) refuseWrite(`«${rel}» is a link — a workspace file is written in place, never through a link`);
    if (!st.isFile()) refuseWrite(`«${rel}» is a directory`);
    before = fs.readFileSync(r.abs, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  try { ensureDir(path.dirname(r.abs)); } catch (e) {
    refuseWrite(`the directories for «${rel}» cannot be made (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}) — a link on the way leads nowhere, or a file stands where a directory should`);
  }
  // The directories just made are checked again: nothing on the way may lead out. What
  // this cannot close is another process of the person's own swapping a directory for a
  // link between this check and the write below; the temp file is opened exclusive.
  if (!within(realOf(path.dirname(r.abs)), realOf(ws))) refuseWrite(`«${rel}» leads outside the workspace, ${ws}`);
  writePrivate(r.abs, content);
  return { abs: r.abs, before };
}

export function readWorkspaceFile(ws: string, rel: string): string {
  const r = resolveInWorkspace(ws, rel);
  if ('error' in r) throw new Error(`workspace_read: ${r.error}`);
  let st: fs.Stats;
  try { st = fs.statSync(r.abs); } catch { throw new Error(`workspace_read: no such file «${rel}» — workspace_list shows what is there`); }
  if (!st.isFile()) throw new Error(`workspace_read: «${rel}» is not a file — workspace_list shows what is in it`);
  if (st.size > WORKSPACE_FILE_MAX) throw new Error(`workspace_read: «${rel}» is ${st.size} bytes, over ${WORKSPACE_FILE_MAX}`);
  return fs.readFileSync(r.abs, 'utf8');
}

// Every entry under `rel`, as paths from the workspace's root: a file with its size, a
// directory once with a slash, a link named and never followed.
export function listWorkspace(ws: string, rel = ''): string {
  const r = resolveInWorkspace(ws, rel);
  if ('error' in r) throw new Error(`workspace_list: ${r.error}`);
  const out: string[] = [];
  let more = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, e.name);
      const shown = path.relative(ws, abs).split(path.sep).join('/');
      if (out.length >= LIST_MAX) { more++; continue; }
      if (e.isSymbolicLink()) out.push(`${shown} → a link, not followed`);
      else if (e.isDirectory()) { out.push(`${shown}/`); walk(abs); }
      else if (e.isFile()) { let size = 0; try { size = fs.lstatSync(abs).size; } catch { /* gone */ } out.push(`${shown} (${size} B)`); }
    }
  };
  walk(r.abs);
  if (!out.length) return `The workspace${rel ? ` at ${rel}` : ''} is empty (${ws}). Write working files under ${ARTIFACTS_DIR}/ with workspace_write.`;
  return [`${ws}${rel ? `/${rel}` : ''}:`, ...out, ...(more ? [`… ${more} more`] : [])].join('\n');
}

// `/workspace [path]` — the person's own look into the project's workspace: no path
// lists it, a path shows that file. What it says is a note in the chat, for the person
// only — never sent to the model (a file the model wrote is not the person's message).
export function workspaceNote(arg: string, ws: string, fenceOf: (text: string) => string): string {
  const rel = arg.trim();
  try {
    if (!rel) return `${listWorkspace(ws, '')}\n/workspace <path> shows a file here — to you, not to the assistant.`;
    const text = readWorkspaceFile(ws, rel);
    const f = fenceOf(text);
    return `${rel} — in the workspace, shown to you only:\n${f}\n${text.replace(/\n$/, '')}\n${f}`;
  } catch (e) {
    return (e as Error).message.replace(/^workspace_(read|list): /, '/workspace: ');
  }
}
