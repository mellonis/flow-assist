import { describe, it, expect } from 'bun:test';
import { buildRepoGroup } from '../tools.ts';

describe('repo tool group', () => {
  it('detect is false with no roots configured', async () => {
    const group = buildRepoGroup({ clip: (x: unknown) => x, roots: [] });
    expect(await group.detect()).toBe(false);
  });
  it('read_file rejects paths outside the roots', async () => {
    const group = buildRepoGroup({ clip: (x: unknown) => x, roots: ['/tmp/r'], homeDir: '/home/u' });
    const out = await group.exec('read_file', { path: '/etc/passwd' }, {});
    expect(String(out)).toContain('outside');
  });
});

// The allowlist is the only thing between a model and the rest of the disk, so each
// way round it gets a test that really tries it, on real files and a real git repo.
describe('repo tool group: the ways round the allowlist', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const setup = () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-guards-')));
    const root = path.join(base, 'clone');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'the secret');
    fs.writeFileSync(path.join(root, 'a.txt'), 'inside');
    const group = buildRepoGroup({ clip: (x: unknown) => x, roots: [root] });
    return { base, root, outside, group };
  };

  it('a symlink inside the root does not lead out of it — read, write or delete', async () => {
    const { root, outside, group } = setup();
    fs.symlinkSync(outside, path.join(root, 'docs'));
    fs.symlinkSync(path.join(outside, 'not-yet.txt'), path.join(root, 'dangling'));
    expect(String(await group.exec('read_file', { path: 'docs/secret.txt' }, {}))).toContain('outside the configured roots');
    expect(String(await group.exec('list_dir', { path: 'docs' }, {}))).toContain('outside the configured roots');
    expect(String(await group.exec('write_file', { path: 'docs/new.txt', content: 'x' }, {}))).toContain('outside the configured roots');
    expect(String(await group.exec('write_file', { path: 'dangling', content: 'x' }, {}))).toContain('outside the configured roots');
    expect(String(await group.exec('delete_file', { path: 'docs/secret.txt' }, {}))).toContain('outside the configured roots');
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
    expect(fs.existsSync(path.join(outside, 'not-yet.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('the secret');
    // An honest path still works, including one that does not exist yet.
    expect(String(await group.exec('read_file', { path: 'a.txt' }, {}))).toContain('inside');
    expect(String(await group.exec('write_file', { path: 'sub/dir/b.txt', content: 'ok' }, {}))).toContain('wrote');
  });

  it('a root reached through a link is still a root', async () => {
    const { base, root } = setup();
    const alias = path.join(base, 'alias');
    fs.symlinkSync(root, alias);
    const group = buildRepoGroup({ clip: (x: unknown) => x, roots: [alias] });
    expect(String(await group.exec('read_file', { path: 'a.txt' }, {}))).toContain('inside');
  });

  it('the root itself is never deleted, recursive or not', async () => {
    const { root, group } = setup();
    expect(String(await group.exec('delete_file', { path: root, recursive: true }, {}))).toContain('configured root');
    expect(String(await group.exec('delete_file', { path: '.', recursive: true }, {}))).toContain('configured root');
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(true);
  });

  it('a ref that is really an option writes nothing: read-only git tools stay read-only', async () => {
    const { root, outside, group } = setup();
    const git = (...argv: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...argv], { stdio: 'pipe' });
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'one');
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed');
    const target = path.join(outside, 'written-by-git.txt');
    for (const [tool, args] of [
      ['git_diff', { ref: `--output=${target}` }],
      ['git_diff', { base: `--output=${target}`, ref: 'HEAD' }],
      ['git_log', { ref: `--output=${target}` }],
      ['git_show', { ref: `--output=${target}`, path: 'a.txt' }],
      ['git_ls_tree', { ref: `--output=${target}` }],
    ] as const) {
      expect(String(await group.exec(tool, args, {}))).toContain('cannot start with "-"');
    }
    expect(fs.existsSync(target)).toBe(false);
    // Real refs are unharmed by `--end-of-options`.
    expect(String(await group.exec('git_diff', {}, {}))).toContain('changed');
    expect(String(await group.exec('git_diff', { ref: 'HEAD' }, {}))).toContain('git_diff(HEAD..HEAD)');
    expect(String(await group.exec('git_log', { ref: 'HEAD' }, {}))).toContain('one');
    expect(String(await group.exec('git_show', { ref: 'HEAD', path: 'a.txt' }, {}))).toContain('inside');
    expect(String(await group.exec('git_ls_tree', { ref: 'HEAD' }, {}))).toContain('a.txt');
  });
});