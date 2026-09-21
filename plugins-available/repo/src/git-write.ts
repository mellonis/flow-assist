// Git operations that change a clone: a branch, a commit, a push, a sync with the
// default branch. Each is a write tool — the chat asks y/n first — and each refuses by
// THROWING: the host counts whatever a write tool returns as done (✎ under the answer).
//
// The workflow they enforce is the person's own:
//   - a feature branch starts from a freshly fetched origin/<default>;
//   - nothing is committed to, or pushed to, the default branch (or main / master /
//     develop / trunk, whatever the default is);
//   - the branch is brought up to date by a rebase onto origin/<default>, never by a
//     merge; a conflict is aborted and named, never resolved here;
//   - no plain force-push; after a rebase the branch goes out with --force-with-lease,
//     which fails if someone else pushed to it meanwhile.
// A push takes no refspec and no remote from the model: it is always the current
// branch to origin under the same name, built from a validated name.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type GitResult = { out: string; err: string };
export type GitRun = (repo: string, argv: string[]) => Promise<GitResult>;

// git with no prompt (a missing credential fails instead of waiting on a terminal
// nobody sees), English messages (they are matched below), and a time limit.
export function makeGitRun(timeoutMs = 120_000): GitRun {
  return (repo, argv) => new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' };
    if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
    const c = spawn('git', ['-C', repo, ...argv], { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => { if (!done) { done = true; c.kill('SIGKILL'); reject(new Error(`git ${argv[0]} did not finish in ${Math.round(timeoutMs / 1000)} s`)); } }, timeoutMs);
    c.stdout!.on('data', (d) => { out += d; });
    c.stderr!.on('data', (d) => { err += d; });
    c.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(new Error(`git: ${e.message}`)); } });
    c.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(Object.assign(new Error(`git ${argv[0]} failed (exit ${code}): ${(err || out).trim().slice(0, 1200)}`), { stderr: err, stdout: out }));
    });
  });
}

const ALWAYS_PROTECTED = new Set(['main', 'master', 'develop', 'trunk']);

export async function defaultBranch(run: GitRun, repo: string): Promise<string> {
  try {
    const head = (await run(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).out.trim();
    if (head.startsWith('origin/')) return head.slice('origin/'.length);
  } catch { /* unset in many clones — probe below */ }
  for (const b of ['main', 'master', 'develop', 'trunk']) {
    try { await run(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`]); return b; } catch { /* next */ }
  }
  throw new Error('cannot tell the default branch: origin/HEAD is not set and there is no origin/main, master, develop or trunk. Nothing was changed. (In the clone, `git remote set-head origin --auto` sets it.)');
}

export async function currentBranch(run: GitRun, repo: string): Promise<string> {
  const b = (await run(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
  if (!b || b === 'HEAD') throw new Error('HEAD is detached — switch to a branch first (git_switch / git_branch_create). Nothing was changed.');
  return b;
}

// git itself decides what a branch name may be (`..`, `~`, `^`, `:`, spaces, `.lock`…).
export async function checkBranchName(run: GitRun, repo: string, name: string): Promise<string> {
  const n = String(name ?? '').trim();
  if (!n) throw new Error('name is required — the branch name. Nothing was changed.');
  if (n.startsWith('-')) throw new Error(`«${n}» is not a branch name — it cannot start with "-". Nothing was changed.`);
  try { await run(repo, ['check-ref-format', '--branch', n]); } catch {
    throw new Error(`«${n}» is not a valid branch name. Nothing was changed.`);
  }
  return n;
}

const isProtected = (branch: string, def: string) => branch === def || ALWAYS_PROTECTED.has(branch);

// A rebase, merge or cherry-pick left half done — nothing else should start on top.
async function inProgress(run: GitRun, repo: string): Promise<string | null> {
  for (const p of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
    const rel = (await run(repo, ['rev-parse', '--git-path', p])).out.trim();
    if (fs.existsSync(path.resolve(repo, rel))) return p.startsWith('rebase') ? 'a rebase' : p === 'MERGE_HEAD' ? 'a merge' : 'a cherry-pick';
  }
  return null;
}
async function refuseInProgress(run: GitRun, repo: string) {
  const what = await inProgress(run, repo);
  if (what) throw new Error(`${what} is in progress in ${repo} — finish or abort it first. Nothing was changed.`);
}

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
const exists = async (run: GitRun, repo: string, ref: string) => { try { await run(repo, ['rev-parse', '--verify', '--quiet', ref]); return true; } catch { return false; } };
const short = async (run: GitRun, repo: string, ref: string) => (await run(repo, ['rev-parse', '--short', ref])).out.trim();

// origin's project path, for the gitlab tools: git@host:group/sub/proj.git → group/sub/proj.
export async function originProject(run: GitRun, repo: string): Promise<string | null> {
  try {
    const url = (await run(repo, ['remote', 'get-url', 'origin'])).out.trim();
    const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?[^:/]+(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec(url);
    return m ? m[1]! : null;
  } catch { return null; }
}

export async function branchCreate(run: GitRun, repo: string, name: string): Promise<string> {
  const n = await checkBranchName(run, repo, name);
  await refuseInProgress(run, repo);
  if (await exists(run, repo, `refs/heads/${n}`)) throw new Error(`branch «${n}» already exists — git_switch to it. Nothing was changed.`);
  const def = await defaultBranch(run, repo);
  await run(repo, ['fetch', 'origin', `refs/heads/${def}:refs/remotes/origin/${def}`]);
  const dirty = lines((await run(repo, ['status', '--porcelain', '--untracked-files=no'])).out).length;
  await run(repo, ['switch', '--no-track', '-c', n, `refs/remotes/origin/${def}`]);
  return `created «${n}» from origin/${def} (${await short(run, repo, 'HEAD')}, just fetched) and switched to it${dirty ? `; ${dirty} uncommitted change(s) came along` : ''}.`;
}

export async function switchBranch(run: GitRun, repo: string, name: string): Promise<string> {
  const n = await checkBranchName(run, repo, name);
  await refuseInProgress(run, repo);
  const local = await exists(run, repo, `refs/heads/${n}`);
  if (!local && !(await exists(run, repo, `refs/remotes/origin/${n}`))) throw new Error(`no branch «${n}» here or on origin — git_branch_create makes a new one. Nothing was changed.`);
  // An existing local branch by its full name; a remote-only one is created tracking origin.
  await run(repo, local ? ['switch', n] : ['switch', '--track', '-c', n, `refs/remotes/origin/${n}`]);
  const st = (await run(repo, ['status', '--short', '--branch'])).out.trim();
  return `on «${n}»${local ? '' : ` (new, tracking origin/${n})`}:\n${st}`;
}

// Stages `paths` (each already resolved inside the clone) or, with none, the tracked
// files that changed — never an untracked file unless it is named.
export async function commit(run: GitRun, repo: string, message: string, relPaths: string[]): Promise<string> {
  const msg = String(message ?? '').trim();
  if (!msg) throw new Error('message is required — the commit message. Nothing was changed.');
  await refuseInProgress(run, repo);
  const branch = await currentBranch(run, repo);
  const def = await defaultBranch(run, repo);
  if (isProtected(branch, def)) throw new Error(`«${branch}» is the default branch — nothing is committed to it. Create a feature branch first (git_branch_create). Nothing was changed.`);
  await run(repo, relPaths.length ? ['add', '--', ...relPaths] : ['add', '--update']);
  const staged = lines((await run(repo, ['diff', '--cached', '--name-status'])).out);
  if (!staged.length) throw new Error(`nothing to commit on «${branch}»${relPaths.length ? ' in the given paths' : ' — no tracked file changed (a new file must be named in paths)'}.`);
  // The message goes as it is — no trailer, no attribution added.
  await run(repo, ['commit', '-m', msg]);
  return `committed ${await short(run, repo, 'HEAD')} on «${branch}»: ${msg.split('\n')[0]}\n${staged.map((l) => `  ${l}`).join('\n')}`;
}

export async function push(run: GitRun, repo: string, forceWithLease: boolean): Promise<string> {
  await refuseInProgress(run, repo);
  const branch = await checkBranchName(run, repo, await currentBranch(run, repo));
  const def = await defaultBranch(run, repo);
  if (isProtected(branch, def)) throw new Error(`«${branch}» is the default branch — the assistant never pushes to it. Nothing was pushed.`);
  const argv = ['push', ...(forceWithLease ? ['--force-with-lease'] : []), '--set-upstream', 'origin', `refs/heads/${branch}:refs/heads/${branch}`];
  let res: GitResult;
  try {
    res = await run(repo, argv);
  } catch (e) {
    const text = String((e as { stderr?: string }).stderr ?? (e as Error).message);
    if (/stale info|\(stale info\)/i.test(text)) throw new Error(`origin/${branch} changed since this clone last saw it — someone else pushed to it. Nothing was pushed; git_sync, look at what came, then push again.`);
    if (/non-fast-forward|fetch first|\[rejected\]/i.test(text)) throw new Error(`origin/${branch} has commits this branch does not${forceWithLease ? '' : ' (after a rebase this is expected — push with forceWithLease: true)'}. Nothing was pushed.`);
    throw e;
  }
  const project = await originProject(run, repo);
  // GitLab answers a push with the merge request link on stderr ("remote: …").
  const remote = lines(res.err).filter((l) => l.startsWith('remote:')).map((l) => l.replace(/^remote:\s*/, '')).filter(Boolean);
  return `pushed «${branch}» to origin${forceWithLease ? ' (--force-with-lease)' : ''} at ${await short(run, repo, 'HEAD')}${project ? `; project ${project}` : ''}${remote.length ? `\n${remote.join('\n')}` : ''}`;
}

export async function sync(run: GitRun, repo: string): Promise<string> {
  await refuseInProgress(run, repo);
  const branch = await currentBranch(run, repo);
  const dirty = lines((await run(repo, ['status', '--porcelain', '--untracked-files=no'])).out);
  if (dirty.length) throw new Error(`«${branch}» has uncommitted changes (${dirty.length}) — commit them first. Nothing was changed.`);
  const def = await defaultBranch(run, repo);
  await run(repo, ['fetch', 'origin', `refs/heads/${def}:refs/remotes/origin/${def}`]);
  const onto = `refs/remotes/origin/${def}`;
  if (branch === def) {
    try { await run(repo, ['merge', '--ff-only', onto]); } catch {
      throw new Error(`«${def}» has local commits origin/${def} does not — nothing is committed to the default branch; move them to a feature branch. Nothing was changed.`);
    }
    return `«${def}» is at origin/${def} (${await short(run, repo, 'HEAD')}).`;
  }
  try {
    await run(repo, ['rebase', onto]);
  } catch (e) {
    const conflicts = await run(repo, ['diff', '--name-only', '--diff-filter=U']).then((r) => lines(r.out), () => []);
    await run(repo, ['rebase', '--abort']).catch(() => {});
    if (conflicts.length) throw new Error(`rebasing «${branch}» onto origin/${def} conflicts in: ${conflicts.join(', ')}. The rebase was aborted — the branch is as it was. Resolving is for the person.`);
    throw e;
  }
  const ahead = (await run(repo, ['rev-list', '--count', `${onto}..HEAD`])).out.trim();
  const pushed = await exists(run, repo, `refs/remotes/origin/${branch}`);
  return `rebased «${branch}» onto origin/${def} (${await short(run, repo, onto)}): ${ahead} commit(s) on top.${pushed ? ' The branch was pushed before, so the next push needs forceWithLease: true.' : ''}`;
}
