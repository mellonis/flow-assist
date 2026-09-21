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
    // A write refuses by throwing: a returned string would read as a change made.
    await expect(group.exec('write_file', { path: 'docs/new.txt', content: 'x' }, {})).rejects.toThrow('outside the configured roots');
    await expect(group.exec('write_file', { path: 'dangling', content: 'x' }, {})).rejects.toThrow('outside the configured roots');
    await expect(group.exec('delete_file', { path: 'docs/secret.txt' }, {})).rejects.toThrow('outside the configured roots');
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
    await expect(group.exec('delete_file', { path: root, recursive: true }, {})).rejects.toThrow('configured root');
    await expect(group.exec('delete_file', { path: '.', recursive: true }, {})).rejects.toThrow('configured root');
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

// The chat shows what a file write changed as a diff; the tool is the one that knows
// the text before, so it reports both sides through `ctx.reportChange`.
describe('repo tool group: a file write reports what it changed', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const setup = () => {
    const root = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-diff-'))), 'clone');
    fs.mkdirSync(root);
    const group = buildRepoGroup({ clip: (x: unknown) => x, roots: [root] });
    const changes: { title: string; before: string; after: string }[] = [];
    return { root, group, changes, ctx: { reportChange: (c: any) => changes.push(c) } };
  };

  it('write_file: a new file is reported with an empty before; an overwrite with the old text', async () => {
    const { root, group, changes, ctx } = setup();
    await group.exec('write_file', { path: 'src/a.ts', content: 'one\n' }, ctx);
    await group.exec('write_file', { path: 'src/a.ts', content: 'two\n' }, ctx);
    expect(changes).toEqual([
      { title: 'clone/src/a.ts', before: '', after: 'one\n' },
      { title: 'clone/src/a.ts', before: 'one\n', after: 'two\n' },
    ]);
    expect(fs.readFileSync(path.join(root, 'src/a.ts'), 'utf8')).toBe('two\n');
  });

  it('edit_file reports the whole file before and after; a miss reports nothing', async () => {
    const { root, group, changes, ctx } = setup();
    fs.writeFileSync(path.join(root, 'b.txt'), 'a\nb\nc\n');
    await group.exec('edit_file', { path: 'b.txt', old: 'b', new: 'B' }, ctx);
    expect(changes).toEqual([{ title: 'clone/b.txt', before: 'a\nb\nc\n', after: 'a\nB\nc\n' }]);
    await expect(group.exec('edit_file', { path: 'b.txt', old: 'zzz', new: 'y' }, ctx)).rejects.toThrow('not found');
    expect(changes).toHaveLength(1);
  });

  it('delete_file reports a file going; a directory is not diffed', async () => {
    const { root, group, changes, ctx } = setup();
    fs.writeFileSync(path.join(root, 'gone.txt'), 'bye\n');
    fs.mkdirSync(path.join(root, 'dir'));
    fs.writeFileSync(path.join(root, 'dir', 'x'), 'x');
    await group.exec('delete_file', { path: 'gone.txt' }, ctx);
    await group.exec('delete_file', { path: 'dir', recursive: true }, ctx);
    expect(changes).toEqual([{ title: 'clone/gone.txt', before: 'bye\n', after: '' }]);
  });

  it('a ctx without reportChange (the one-shot CLI) writes all the same', async () => {
    const { root, group } = setup();
    expect(String(await group.exec('write_file', { path: 'c.txt', content: 'c' }, {}))).toContain('wrote');
    expect(fs.readFileSync(path.join(root, 'c.txt'), 'utf8')).toBe('c');
  });
});
// The host counts whatever a write tool RETURNS as done (✎ in the chat), so every
// refusal and every failure of a file write throws — and one that changed nothing
// says so. The read-only tools keep answering with a string.
describe('repo tool group: a file write refuses by throwing', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const setup = () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-refuse-')));
    const root = path.join(base, 'clone');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'a.txt'), 'inside\n');
    fs.mkdirSync(path.join(root, 'dir'));
    const changes: unknown[] = [];
    const group = buildRepoGroup({ clip: (x: unknown) => x, roots: [root] });
    const run = (name: string, args: Record<string, unknown>) => group.exec(name, args, { reportChange: (c: unknown) => changes.push(c) });
    // Everything under the base, as text — what "nothing was changed" is checked against.
    const snapshot = (): string => execFileSync('find', [base, '-print'], { encoding: 'utf8' }).split('\n').sort().join('\n') + fs.readFileSync(path.join(root, 'a.txt'), 'utf8');
    return { base, root, group, run, changes, snapshot };
  };

  const refusals: [string, string, Record<string, unknown>, string][] = [
    ['write_file', 'outside the roots', { path: '/etc/flow-assist-test', content: 'x' }, 'outside the configured roots'],
    ['edit_file', 'outside the roots', { path: '/etc/hosts', old: 'a', new: 'b' }, 'outside the configured roots'],
    ['edit_file', 'no old text', { path: 'a.txt', new: 'b' }, 'edit_file: old is required'],
    ['edit_file', 'no such file', { path: 'missing.txt', old: 'a', new: 'b' }, 'edit_file: no such file'],
    ['edit_file', 'old not found', { path: 'a.txt', old: 'zzz', new: 'b' }, 'not found in'],
    ['delete_file', 'outside the roots', { path: '/etc/hosts' }, 'outside the configured roots'],
    ['delete_file', 'the root', { path: '.', recursive: true }, 'is a configured root'],
    ['delete_file', 'no such path', { path: 'missing.txt' }, 'delete_file: no such path'],
    ['delete_file', 'a directory without recursive', { path: 'dir' }, 'pass recursive: true'],
  ];
  for (const [tool, what, args, message] of refusals) {
    it(`${tool}: ${what} — throws, changes nothing and says so`, async () => {
      const { run, changes, snapshot } = setup();
      const before = snapshot();
      await expect(run(tool, args)).rejects.toThrow(message);
      await expect(run(tool, args)).rejects.toThrow('Nothing was changed.');
      expect(snapshot()).toBe(before);
      expect(changes).toEqual([]);
    });
  }

  // A failure the filesystem reports is thrown in its own words. Whether it changed
  // anything is the filesystem's to say (a full disk can leave half a file), so the
  // tool does not claim that it did not.
  const failures: [string, string, Record<string, unknown>, RegExp][] = [
    ['write_file', 'a parent that is a file', { path: 'a.txt/b.txt', content: 'x' }, /^write_file: mkdir failed: .*(ENOTDIR|EEXIST)/],
    ['write_file', 'a directory as the file', { path: 'dir', content: 'x' }, /^write_file: .*EISDIR/],
    ['edit_file', 'a directory as the file', { path: 'dir', old: 'a', new: 'b' }, /^edit_file: .*EISDIR/],
  ];
  for (const [tool, what, args, message] of failures) {
    it(`${tool}: ${what} — the filesystem's error is thrown`, async () => {
      const { run, changes, snapshot } = setup();
      const before = snapshot();
      await expect(run(tool, args)).rejects.toThrow(message);
      expect(snapshot()).toBe(before);
      expect(changes).toEqual([]);
    });
  }

  it('delete_file: a thing that is neither file nor directory is refused', async () => {
    const { root, run, changes } = setup();
    execFileSync('mkfifo', [path.join(root, 'pipe')]);
    await expect(run('delete_file', { path: 'pipe' })).rejects.toThrow('is not a file or directory. Nothing was changed.');
    expect(fs.existsSync(path.join(root, 'pipe'))).toBe(true);
    expect(changes).toEqual([]);
  });

  it('delete_file: a failed unlink throws in the filesystem\'s own words', async () => {
    if (process.getuid?.() === 0) return; // root deletes through any mode
    const { root, run, changes } = setup();
    fs.writeFileSync(path.join(root, 'dir', 'kept.txt'), 'k');
    fs.chmodSync(path.join(root, 'dir'), 0o555);
    try {
      await expect(run('delete_file', { path: 'dir/kept.txt' })).rejects.toThrow(/^delete_file: .*(EACCES|EPERM|permission)/i);
      expect(fs.existsSync(path.join(root, 'dir', 'kept.txt'))).toBe(true);
      expect(changes).toEqual([]);
    } finally {
      fs.chmodSync(path.join(root, 'dir'), 0o755);
    }
  });

  it('with no roots configured a write throws; a read answers', async () => {
    const group = buildRepoGroup({ clip: (x: unknown) => x, roots: [] });
    await expect(group.exec('write_file', { path: 'x.txt', content: 'x' }, {})).rejects.toThrow('Nothing was changed.');
    await expect(group.exec('edit_file', { path: 'x.txt', old: 'a', new: 'b' }, {})).rejects.toThrow('Nothing was changed.');
    await expect(group.exec('delete_file', { path: 'x.txt' }, {})).rejects.toThrow('Nothing was changed.');
    expect(String(await group.exec('read_file', { path: 'x.txt' }, {}))).toContain('no read roots configured');
  });

  it('a read-only tool still answers a refusal with a string', async () => {
    const { run } = setup();
    expect(String(await run('read_file', { path: 'missing.txt' }))).toContain('no such file');
    expect(String(await run('list_dir', { path: '/etc' }))).toContain('outside the configured roots');
  });
});
