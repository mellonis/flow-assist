// The git writes on real repositories: a bare `origin` and clones in a temp dir, so a
// push, a rebase, a conflict and --force-with-lease behave as they do for the person.
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildRepoGroup } from '../tools.ts';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir: string, file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
const ident = (dir: string) => { sh(dir, 'config', 'user.name', 'Test Person'); sh(dir, 'config', 'user.email', 'test@example.com'); };

function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-git-write-')));
  const origin = path.join(base, 'origin.git');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
  const seed = path.join(base, 'seed');
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  ident(seed);
  write(seed, 'README.md', 'routes\n');
  write(seed, 'app.ts', 'export const a = 1;\n');
  sh(seed, 'add', '.'); sh(seed, 'commit', '-q', '-m', 'init');
  sh(seed, 'remote', 'add', 'origin', origin); sh(seed, 'push', '-q', 'origin', 'main');
  const clone = (name: string) => { const d = path.join(base, name); execFileSync('git', ['clone', '-q', origin, d]); ident(d); return d; };
  const mine = clone('clone');
  const other = clone('other');
  const group = buildRepoGroup({ clip: (x: unknown) => x, roots: [mine] });
  const run = (name: string, args: Record<string, unknown> = {}) => group.exec(name, args, {});
  return { base, origin, mine, other, run, group };
}

describe('git writes', () => {
  it('are all write tools', () => {
    const { group } = setup();
    for (const n of ['git_branch_create', 'git_switch', 'git_commit', 'git_push', 'git_sync']) {
      expect((group.tools.find((t: any) => t.function.name === n) as any).write).toBe(true);
    }
  });

  it('a branch starts from freshly fetched origin/main', async () => {
    const { mine, other, run } = setup();
    // origin moved on after this clone was made — the new branch must include it.
    write(other, 'app.ts', 'export const a = 2;\n'); sh(other, 'commit', '-qam', 'bump'); sh(other, 'push', '-q', 'origin', 'main');
    const out = await run('git_branch_create', { name: 'feature/ROUTE-3-dates' });
    expect(String(out)).toContain('created «feature/ROUTE-3-dates» from origin/main');
    expect(sh(mine, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/ROUTE-3-dates');
    expect(fs.readFileSync(path.join(mine, 'app.ts'), 'utf8')).toBe('export const a = 2;\n');
    await expect(run('git_branch_create', { name: 'feature/ROUTE-3-dates' })).rejects.toThrow(/already exists/);
  });

  it('a name git rejects, or one that reads as an option, is refused', async () => {
    const { mine, run } = setup();
    for (const bad of ['a..b', 'with space', '--upload-pack=touch /tmp/x', 'x.lock', '']) {
      await expect(run('git_branch_create', { name: bad })).rejects.toThrow(/Nothing was changed/);
    }
    expect(sh(mine, 'branch', '--list').split('\n').map((s) => s.replace('*', '').trim())).toEqual(['main']);
  });

  it('nothing is committed to the default branch, and nothing is pushed to it', async () => {
    const { mine, origin, run } = setup();
    write(mine, 'app.ts', 'export const a = 3;\n');
    await expect(run('git_commit', { message: 'on main' })).rejects.toThrow(/default branch — nothing is committed/);
    sh(mine, 'commit', '-qam', 'the person did it by hand');
    await expect(run('git_push', {})).rejects.toThrow(/never pushes to it/);
    expect(sh(origin, 'log', '--oneline', 'main')).not.toContain('by hand');
  });

  it('a commit takes changed tracked files — a new file only when named', async () => {
    const { mine, run } = setup();
    await run('git_branch_create', { name: 'feature/x' });
    write(mine, 'app.ts', 'export const a = 5;\n');
    write(mine, 'scratch.log', 'junk');
    write(mine, 'dates.ts', 'export const d = 1;\n');
    const out = String(await run('git_commit', { message: 'Date filter: the model\n\nBody line.' }));
    expect(out).toMatch(/committed \w+ on «feature\/x»: Date filter: the model/);
    expect(sh(mine, 'show', '--name-only', '--format=', 'HEAD')).toBe('app.ts');
    // Verbatim message, nothing appended.
    expect(sh(mine, 'log', '-1', '--format=%B')).toBe('Date filter: the model\n\nBody line.');
    await run('git_commit', { message: 'Add dates', paths: ['dates.ts'] });
    expect(sh(mine, 'show', '--name-only', '--format=', 'HEAD')).toBe('dates.ts');
    expect(sh(mine, 'status', '--porcelain')).toBe('?? scratch.log');
    await expect(run('git_commit', { message: 'again' })).rejects.toThrow(/nothing to commit/);
  });

  it('a path outside the clone is not staged', async () => {
    const { base, run } = setup();
    await run('git_branch_create', { name: 'feature/x' });
    write(base, 'outside.txt', 'x');
    await expect(run('git_commit', { message: 'm', paths: [path.join(base, 'outside.txt')] })).rejects.toThrow(/Nothing was committed/);
    await expect(run('git_commit', { message: 'm', paths: ['../outside.txt'] })).rejects.toThrow(/Nothing was committed/);
  });

  it('push sends the current branch under its name, with upstream', async () => {
    const { mine, origin, run } = setup();
    await run('git_branch_create', { name: 'feature/x' });
    write(mine, 'app.ts', 'export const a = 6;\n');
    await run('git_commit', { message: 'six' });
    const out = String(await run('git_push', {}));
    expect(out).toContain('pushed «feature/x» to origin');
    expect(sh(origin, 'log', '--format=%s', '-1', 'feature/x')).toBe('six');
    expect(sh(mine, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feature/x');
  });

  it('sync rebases onto the new origin/main; the pushed branch then needs the lease', async () => {
    const { mine, other, run } = setup();
    await run('git_branch_create', { name: 'feature/x' });
    write(mine, 'feature.ts', 'export const f = 1;\n');
    await run('git_commit', { message: 'feature', paths: ['feature.ts'] });
    await run('git_push', {});
    write(other, 'README.md', 'routes, updated\n'); sh(other, 'commit', '-qam', 'readme'); sh(other, 'push', '-q', 'origin', 'main');

    const synced = String(await run('git_sync', {}));
    expect(synced).toContain('rebased «feature/x» onto origin/main');
    expect(synced).toContain('forceWithLease: true');
    expect(sh(mine, 'log', '--format=%s', '-3')).toBe('feature\nreadme\ninit');

    await expect(run('git_push', {})).rejects.toThrow(/Nothing was pushed/);
    expect(String(await run('git_push', { forceWithLease: true }))).toContain('--force-with-lease');
  });

  it('the lease fails when someone else pushed to the branch meanwhile', async () => {
    const { mine, other, run } = setup();
    await run('git_branch_create', { name: 'feature/x' });
    write(mine, 'feature.ts', 'export const f = 1;\n');
    await run('git_commit', { message: 'mine', paths: ['feature.ts'] });
    await run('git_push', {});
    // A colleague pushes onto the same branch; this clone does not know.
    sh(other, 'fetch', '-q', 'origin'); sh(other, 'switch', '-q', 'feature/x');
    write(other, 'feature.ts', 'export const f = 2;\n'); sh(other, 'commit', '-qam', 'theirs'); sh(other, 'push', '-q', 'origin', 'feature/x');
    // A local rewrite, then a lease push against the stale origin/feature/x.
    sh(mine, 'commit', '-q', '--amend', '-m', 'mine, amended');
    await expect(run('git_push', { forceWithLease: true })).rejects.toThrow(/someone else pushed|Nothing was pushed/);
    expect(sh(other, 'log', '--format=%s', '-1', 'origin/feature/x')).toBe('theirs');
  });

  it('a conflict aborts the rebase and names the file', async () => {
    const { mine, other, run } = setup();
    await run('git_branch_create', { name: 'feature/x' });
    write(mine, 'app.ts', 'export const a = 100;\n');
    await run('git_commit', { message: 'mine' });
    write(other, 'app.ts', 'export const a = 200;\n'); sh(other, 'commit', '-qam', 'theirs'); sh(other, 'push', '-q', 'origin', 'main');
    await expect(run('git_sync', {})).rejects.toThrow(/conflicts in: app\.ts\. The rebase was aborted/);
    expect(sh(mine, 'status', '--porcelain')).toBe('');
    expect(sh(mine, 'log', '--format=%s', '-1')).toBe('mine');
  });

  it('sync refuses uncommitted changes; push refuses a detached HEAD', async () => {
    const { mine, run } = setup();
    await run('git_branch_create', { name: 'feature/x' });
    write(mine, 'app.ts', 'dirty\n');
    await expect(run('git_sync', {})).rejects.toThrow(/uncommitted changes/);
    sh(mine, 'checkout', '-q', '--', 'app.ts');
    sh(mine, 'switch', '-q', '--detach', 'HEAD');
    await expect(run('git_push', {})).rejects.toThrow(/HEAD is detached/);
  });

  it('with origin/HEAD unset the default is found by probing; with none it refuses', async () => {
    const { mine, run } = setup();
    sh(mine, 'remote', 'set-head', 'origin', '-d');
    expect(String(await run('git_branch_create', { name: 'feature/y' }))).toContain('from origin/main');
    sh(mine, 'branch', '-q', '-m', 'main', 'mainline');
    sh(mine, 'update-ref', '-d', 'refs/remotes/origin/main');
    await expect(run('git_branch_create', { name: 'feature/z' })).rejects.toThrow(/cannot tell the default branch/);
  });

  it('git_switch goes to an existing or remote-only branch', async () => {
    const { mine, other, run } = setup();
    sh(other, 'switch', '-q', '-c', 'feature/theirs'); write(other, 't.ts', '1'); sh(other, 'add', 't.ts'); sh(other, 'commit', '-qm', 't'); sh(other, 'push', '-q', 'origin', 'feature/theirs');
    sh(mine, 'fetch', '-q', 'origin');
    expect(String(await run('git_switch', { name: 'feature/theirs' }))).toContain('tracking origin/feature/theirs');
    await expect(run('git_switch', { name: 'feature/none' })).rejects.toThrow(/no branch/);
  });
});
