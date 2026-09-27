// A session's files sit under a mirror of its project's path (src/assistant/sessions.ts,
// `projectHome`) — under a test, the git root of the checkout the suite runs in, or no
// project at all where there is none. These find them wherever they are, so a test
// holds whichever layout the run has.
import fs from 'node:fs';
import path from 'node:path';
import { projectHome, projectOf } from '../../assistant/sessions';

// Every file under `dir`, as paths relative to it (`path.join(dir, name)` reaches one).
export function listTree(dir: string): string[] {
  let names: string[];
  try { names = fs.readdirSync(dir, { recursive: true }) as string[]; } catch { return []; }
  return names.filter((n) => { try { return fs.statSync(path.join(dir, n)).isFile(); } catch { return false; } });
}

// The directory a session's files are in: where its state file, journal or lock is;
// `dir` itself when there is none yet.
export function homeIn(dir: string, id: string): string {
  const hit = listTree(dir).find((n) => [`${id}.json`, `${id}.log.jsonl`, `${id}.lock`].includes(path.basename(n)));
  return hit ? path.join(dir, path.dirname(hit)) : dir;
}

// A session's id from a file's name.
export const sessionIdOf = (name: string) => path.basename(name).replace(/\.(json|lock|log\.jsonl)$/, '');

// The project an app booted with no `shell.roots` starts in — this checkout's git root,
// or none — and its sessions directory under `dir`: where a fixture a start should
// continue is written, with that project recorded in it.
export const hereProject = (): string | null => projectOf(process.cwd(), []);
export const hereHome = (dir: string): string => projectHome(dir, hereProject());
