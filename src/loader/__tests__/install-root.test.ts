import { expect, test } from 'bun:test';
import { applyDotenv, loadRootDotenv, noPluginsNote, parseDotenv, resolveInstallRoot } from '../install-root';

// A filesystem of directories that exist, and links that lead somewhere.
const fs = (dirs: string[], links: Record<string, string> = {}) => ({
  exists: (p: string) => dirs.includes(p),
  realpath: (p: string) => {
    if (p in links) return links[p]!;
    return p;
  },
});
const withPlugins = (root: string) => [`${root}/plugins-available`, `${root}/plugins-enabled`];

test('a source checkout is its own root, wherever it is started from', () => {
  const r = resolveInstallRoot({ dirname: '/src/fa/src', execPath: '/usr/bin/bun', cwd: '/home/me', ...fs(withPlugins('/src/fa')) });
  expect(r).toEqual({ root: '/src/fa', source: 'checkout' });
});

test('a compiled binary finds the plugins beside itself, not in the working directory', () => {
  const r = resolveInstallRoot({ dirname: '/$bunfs/root', execPath: '/opt/kit/flow-assist', cwd: '/home/me', ...fs(withPlugins('/opt/kit')) });
  expect(r).toEqual({ root: '/opt/kit', source: 'binary' });
});

test('a link to the binary leads to the directory the binary is in', () => {
  const r = resolveInstallRoot({
    dirname: '/$bunfs/root', execPath: '/usr/local/bin/flow-assist', cwd: '/home/me',
    ...fs(withPlugins('/opt/kit'), { '/usr/local/bin/flow-assist': '/opt/kit/flow-assist' }),
  });
  expect(r).toEqual({ root: '/opt/kit', source: 'binary' });
});

test('the bundle\'s virtual directory is never taken for a checkout', () => {
  // Even if something answered for it, `bunfs` is not on disk.
  const r = resolveInstallRoot({ dirname: '/$bunfs/root', execPath: '/opt/kit/flow-assist', cwd: '/home/me', ...fs([...withPlugins('/$bunfs'), ...withPlugins('/home/me')]) });
  expect(r).toEqual({ root: '/home/me', source: 'cwd' });
});

test('with plugin directories nowhere else, the working directory is the root', () => {
  const r = resolveInstallRoot({ dirname: '/$bunfs/root', execPath: '/opt/kit/flow-assist', cwd: '/home/me', ...fs(['/opt/kit/plugins-available']) });
  expect(r).toEqual({ root: '/home/me', source: 'cwd' });
  const broken = resolveInstallRoot({
    dirname: '/$bunfs/root', execPath: '/gone', cwd: '/home/me',
    exists: () => false, realpath: () => { throw new Error('ENOENT'); },
  });
  expect(broken).toEqual({ root: '/home/me', source: 'cwd' });
});

test('a .env is read as KEY=VALUE lines, comments and quotes handled', () => {
  const vars = parseDotenv([
    '# a comment',
    '',
    'PLAIN=one',
    'export EXPORTED=two',
    'DOUBLE="three # not a comment"',
    "SINGLE='four'",
    'SPACED = five   # trailing comment',
    'EMPTY=',
    'EQUALS=a=b',
    'not a line',
    '  INDENTED=six\r',
  ].join('\n'));
  expect(vars).toEqual({
    PLAIN: 'one', EXPORTED: 'two', DOUBLE: 'three # not a comment', SINGLE: 'four', SPACED: 'five',
    EMPTY: '', EQUALS: 'a=b', INDENTED: 'six',
  });
});

test('a .env never overrides what the environment already has', () => {
  const env: Record<string, string | undefined> = { KEEP: 'from the shell', EMPTY_SET: '' };
  expect(applyDotenv({ KEEP: 'from the file', EMPTY_SET: 'file', NEW: 'file' }, env)).toEqual(['NEW']);
  expect(env).toEqual({ KEEP: 'from the shell', EMPTY_SET: '', NEW: 'file' });
});

test('the root\'s .env is read only when the root is not the working directory', () => {
  const read = (p: string) => (p === '/opt/kit/.env' ? 'TRACKER_USER=me\nLLM_TOKEN=file' : null);
  const env: Record<string, string | undefined> = { LLM_TOKEN: 'shell' };
  expect(loadRootDotenv('/opt/kit', '/opt/kit', env, read)).toBeNull();
  expect(env.TRACKER_USER).toBeUndefined();
  expect(loadRootDotenv('/opt/kit', '/home/me', env, read)).toBe('/opt/kit/.env');
  expect(env).toEqual({ LLM_TOKEN: 'shell', TRACKER_USER: 'me' });
  expect(loadRootDotenv('/elsewhere', '/home/me', env, read)).toBeNull();
});

test('with no plugins enabled, the note says where the host looked', () => {
  expect(noPluginsNote('/opt/kit/plugins-enabled', 2, () => true)).toBeNull();
  expect(noPluginsNote('/opt/kit/plugins-enabled', 0, () => true)).toBe('no plugins in /opt/kit/plugins-enabled');
  expect(noPluginsNote('/home/me/plugins-enabled', 0, () => false)).toBe('no plugins: /home/me/plugins-enabled does not exist');
});
