import { expect, test } from 'bun:test';
import { createPluginRepo } from '../repo';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'da-repo-'));
  const avail = join(root, 'plugins-available');
  const enabled = join(root, 'plugins-enabled');
  mkdirSync(avail, { recursive: true }); mkdirSync(enabled, { recursive: true });
  mkdirSync(join(avail, 'tracker'), { recursive: true });
  writeFileSync(join(avail, 'tracker', 'manifest.json'), JSON.stringify({ name: 'tracker', version: '1.0.0', deps: {} }));
  return { root, avail, enabled, repo: createPluginRepo({ availableDir: avail, enabledDir: enabled, projectRoot: root }) };
}

test('list shows available, active, and built-in exclusion', async () => {
  const { repo, avail } = fakeRepo();
  mkdirSync(join(avail, 'core'), { recursive: true });
  writeFileSync(join(avail, 'core', 'manifest.json'), JSON.stringify({ name: 'core', version: '1.0.0', builtin: true }));
  const list = await repo.list();
  expect(list.find(e => e.name === 'tracker')?.active).toBe(false);
});

test('install symlinks into enabled; remove unlinks', async () => {
  const { repo, enabled } = fakeRepo();
  expect((await repo.install('tracker')).ok).toBe(true);
  expect(existsSync(join(enabled, 'tracker'))).toBe(true);
  expect((await repo.remove('tracker')).ok).toBe(true);
  expect(existsSync(join(enabled, 'tracker'))).toBe(false);
});

test('install downloads from the registry when source is absent, then symlinks; update re-fetches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'da-repo-'));
  const avail = join(root, 'plugins-available'); const enabled = join(root, 'plugins-enabled');
  mkdirSync(avail, { recursive: true }); mkdirSync(enabled, { recursive: true });
  const calls: string[] = [];
  const repo = createPluginRepo({
    availableDir: avail, enabledDir: enabled, projectRoot: root,
    fetchPlugin: async (name, version) => {
      calls.push(`${name}@${version ?? 'latest'}`);
      const dir = join(avail, name); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name, version: version ?? '9.9.9', deps: {} }));
      return { version: version ?? '9.9.9' };
    },
  });
  expect((await repo.install('tracker')).ok).toBe(true);   // downloaded + symlinked
  expect(existsSync(join(avail, 'tracker', '.da-source'))).toBe(true);
  expect((await repo.update('tracker')).ok).toBe(true);    // re-download, symlink intact
  expect(calls).toEqual(['tracker@latest', 'tracker@latest']);
});

test('rejects a path-traversal plugin name (defense-in-depth)', async () => {
  const { repo, avail, enabled } = fakeRepo();
  const before = [...readdirSync(avail), ...readdirSync(enabled)];
  expect((await repo.install('../escape')).ok).toBe(false);
  expect((await repo.remove('foo/bar')).ok).toBe(false);
  expect((await repo.update('..')).ok).toBe(false);
  // No directory/symlink escapes the plugin dirs, and channels/errors mention the name.
  expect(readdirSync(avail)).toEqual(before.filter((n) => n !== 'escape'));
  expect(existsSync(join(enabled, '..', 'escape'))).toBe(false);
});

test('list reports requiredSettings missing from the environment', async () => {
  const { repo, avail } = fakeRepo();
  const pluginDir = join(avail, 'tracker');
  writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify({ name: 'tracker', version: '1.0.0', requiredSettings: ['DA_TEST_REQUIRED_VAR'] }));
  // Unset (empty) → reported missing.
  process.env.DA_TEST_REQUIRED_VAR = '';
  let list = await repo.list();
  expect(list.find(e => e.name === 'tracker')?.missingSettings).toContain('DA_TEST_REQUIRED_VAR');
  // Set → not missing.
  process.env.DA_TEST_REQUIRED_VAR = 'set';
  list = await repo.list();
  expect(list.find(e => e.name === 'tracker')?.missingSettings).not.toContain('DA_TEST_REQUIRED_VAR');
  delete process.env.DA_TEST_REQUIRED_VAR;
});