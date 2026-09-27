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
export function workspaceDir(root: string, project: string | null): string {
  return path.join(project ? projectHome(root, project) : path.join(root, GLOBAL_PROJECT), WORKSPACE_LEAF);
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
  const where = `paths are relative to the workspace, ${ws}`;
  if (path.isAbsolute(s) || /^~(?=\/|$)/.test(s) || /^[a-zA-Z]:[\\/]/.test(s)) return { error: `«${s}» is not in the workspace — ${where} (e.g. artifacts/notes.md)` };
  if (s.split(/[\\/]+/).includes('..')) return { error: `«${s}» leads out of the workspace — ${where}, and never contain ..` };
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

// A scope as the model wrote it: `project` (the default) or `global`; `host`, the word
// an older host used for "everywhere", reads as global.
export function readScope(raw: unknown): { scope: WorkspaceScope } | { error: string } {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s === 'project') return { scope: 'project' };
  if (s === 'global' || s === 'host') return { scope: 'global' };
  return { error: `invalid scope '${s}' — expected "project" or "global"` };
}
