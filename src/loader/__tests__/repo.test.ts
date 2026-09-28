import { expect, test } from 'bun:test';
import { createPluginRepo } from '../repo';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST_API } from '../../version';

function fakeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'fa-repo-'));
  const avail = join(root, 'plugins-available');
  const enabled = join(root, 'plugins-enabled');
  mkdirSync(avail, { recursive: true }); mkdirSync(enabled, { recursive: true });
  mkdirSync(join(avail, 'tracker'), { recursive: true });
  writeFileSync(join(avail, 'tracker', 'manifest.json'), JSON.stringify({ name: 'tracker', hostApi: HOST_API, version: '1.0.0', deps: {} }));
  return { root, avail, enabled, repo: createPluginRepo({ availableDir: avail, enabledDir: enabled, projectRoot: root }) };
}

test('list shows available, active, and built-in exclusion', async () => {
  const { repo, avail } = fakeRepo();
  mkdirSync(join(avail, 'core'), { recursive: true });
  writeFileSync(join(avail, 'core', 'manifest.json'), JSON.stringify({ name: 'core', hostApi: HOST_API, version: '1.0.0', builtin: true }));
  const list = await repo.list();
  expect(list.find(e => e.name === 'tracker')?.active).toBe(false);
});

// A plugin in another language (docs/plugins.md): its manifest carries `run`, so it
// lists as `remote` — what it IS, not how it got enabled.
test('an enabled plugin whose manifest carries run lists as source: remote', async () => {
  const { repo, avail, enabled } = fakeRepo();
  mkdirSync(join(avail, 'fake'), { recursive: true });
  writeFileSync(join(avail, 'fake', 'manifest.json'), JSON.stringify({ name: 'fake', hostApi: HOST_API, version: '1.0.0', run: ['bun', 'index.ts'] }));
  symlinkSync(join(avail, 'fake'), join(enabled, 'fake'));
  const list = await repo.list();
  expect(list.find((e) => e.name === 'fake')?.source).toBe('remote');
});

// plugins-enabled/ is gitignored, so a fresh checkout has none: the first install made it
// fail with ENOENT.
test('install works in a fresh checkout — plugins-enabled/ is created', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fa-repo-fresh-'));
  const avail = join(root, 'plugins-available');
  const enabled = join(root, 'plugins-enabled');
  mkdirSync(join(avail, 'mcp'), { recursive: true });
  writeFileSync(join(avail, 'mcp', 'manifest.json'), JSON.stringify({ name: 'mcp', hostApi: HOST_API, version: '1.0.0' }));
  const repo = createPluginRepo({ availableDir: avail, enabledDir: enabled, projectRoot: root });
  expect(existsSync(enabled)).toBe(false);
  expect(await repo.install('mcp')).toEqual({ ok: true });
  expect(existsSync(join(enabled, 'mcp'))).toBe(true);
});

test('install symlinks into enabled; remove unlinks', async () => {
  const { repo, enabled } = fakeRepo();
  expect((await repo.install('tracker')).ok).toBe(true);
  expect(existsSync(join(enabled, 'tracker'))).toBe(true);
  expect((await repo.remove('tracker')).ok).toBe(true);
  expect(existsSync(join(enabled, 'tracker'))).toBe(false);
});

test('install downloads from the registry when source is absent, then symlinks; update re-fetches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fa-repo-'));
  const avail = join(root, 'plugins-available'); const enabled = join(root, 'plugins-enabled');
  mkdirSync(avail, { recursive: true }); mkdirSync(enabled, { recursive: true });
  const calls: string[] = [];
  const repo = createPluginRepo({
    availableDir: avail, enabledDir: enabled, projectRoot: root,
    fetchPlugin: async (name, version) => {
      calls.push(`${name}@${version ?? 'latest'}`);
      const dir = join(avail, name); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name, hostApi: HOST_API, version: version ?? '9.9.9', deps: {} }));
      return { version: version ?? '9.9.9' };
    },
  });
  expect((await repo.install('tracker')).ok).toBe(true);   // downloaded + symlinked
  expect(existsSync(join(avail, 'tracker', '.flow-assist-source'))).toBe(true);
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

// The model's `host:plugins_install` goes through `install(name)`: an archive URL is
// the CLI's alone (archive-install.ts), so here it is not a name and nothing is fetched.
test('install by name takes no archive URL', async () => {
  const { root, avail, enabled } = fakeRepo();
  const fetched: string[] = [];
  const repo = createPluginRepo({ availableDir: avail, enabledDir: enabled, projectRoot: root, fetchPlugin: async (n) => { fetched.push(n); return { version: '1' }; } });
  const res = await repo.install('https://example.com/notes-0.1.0.tar.gz');
  expect(res.error).toMatch(/invalid name/);
  expect(fetched).toEqual([]);
});

test('list reports requiredSettings missing from the environment', async () => {
  const { repo, avail } = fakeRepo();
  const pluginDir = join(avail, 'tracker');
  writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify({ name: 'tracker', hostApi: HOST_API, version: '1.0.0', requiredSettings: ['FLOW_ASSIST_TEST_REQUIRED_VAR'] }));
  // Unset (empty) → reported missing.
  process.env.FLOW_ASSIST_TEST_REQUIRED_VAR = '';
  let list = await repo.list();
  expect(list.find(e => e.name === 'tracker')?.missingSettings).toContain('FLOW_ASSIST_TEST_REQUIRED_VAR');
  // Set → not missing.
  process.env.FLOW_ASSIST_TEST_REQUIRED_VAR = 'set';
  list = await repo.list();
  expect(list.find(e => e.name === 'tracker')?.missingSettings).not.toContain('FLOW_ASSIST_TEST_REQUIRED_VAR');
  delete process.env.FLOW_ASSIST_TEST_REQUIRED_VAR;
});
test('a built plugin carries its dependencies inside: none of them is reported missing', async () => {
  const { repo, avail } = fakeRepo();
  const dir = join(avail, 'tracker');
  const manifest = { name: 'tracker', hostApi: HOST_API, version: '1.0.0', deps: { '@acme/client': 'file:../client' } };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  // From source, with the dependency not there: it IS missing, and said so.
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.ts'), '');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ main: './dist/index.mjs' }));
  expect((await repo.list()).find((e) => e.name === 'tracker')?.missingDeps).toEqual(['@acme/client']);

  // As `plugin:publish` ships it — the bundle, and no src/ — nothing can be missing:
  // "missing: @acme/client" beside a plugin that loads and works is a false alarm.
  const built = join(avail, 'built');
  mkdirSync(join(built, 'dist'), { recursive: true });
  writeFileSync(join(built, 'manifest.json'), JSON.stringify({ ...manifest, name: 'built' }));
  writeFileSync(join(built, 'package.json'), JSON.stringify({ main: './dist/index.mjs' }));
  writeFileSync(join(built, 'dist', 'index.mjs'), 'export default 1;');
  expect((await repo.list()).find((e) => e.name === 'built')?.missingDeps).toEqual([]);
});

// The person turns a plugin off from the app's `:plugins` panel: its link waits in
// plugins-enabled/.disabled/ — not loaded, still installed — and its trust is forgotten
// as a removal forgets it, keeping where it led: enabling it again never trusts it, and a
// command moving the link back loads nothing at the next start. A relative link keeps
// leading where it did from its new place.
test('disable moves the link aside and forgets the trust; enable brings the link back untrusted', async () => {
  const { checkPluginTrust, pluginTrustOf, trustPlugin } = await import('../trust');
  const root = mkdtempSync(join(tmpdir(), 'fa-repo-'));
  const avail = join(root, 'plugins-available');
  const enabled = join(root, 'plugins-enabled');
  mkdirSync(join(avail, 'tracker'), { recursive: true }); mkdirSync(enabled);
  writeFileSync(join(avail, 'tracker', 'manifest.json'), JSON.stringify({ name: 'tracker', hostApi: HOST_API, version: '1.0.0' }));
  const trust = { file: join(root, 'plugins.trusted.json'), modelShell: false };
  const repo = createPluginRepo({ availableDir: avail, enabledDir: enabled, projectRoot: root, trust });
  // An installer's relative link.
  symlinkSync('../plugins-available/tracker', join(enabled, 'tracker'));
  checkPluginTrust(enabled, ['tracker'], trust); // the first start trusts it
  expect(checkPluginTrust(enabled, ['tracker'], trust).trusted).toEqual(['tracker']);
  expect(await repo.disable!('tracker')).toEqual({ ok: true });
  expect(await repo.enabledPlugins()).toEqual([]);
  expect(await repo.disabledPlugins!()).toEqual(['tracker']);
  expect((await repo.list()).find((e) => e.name === 'tracker')).toMatchObject({ active: false, disabled: true });
  expect(await repo.disable!('tracker')).toEqual({ ok: false, error: "plugin 'tracker' is disabled already" });
  // The model's command moves it back: the next start does not load it.
  renameSync(join(enabled, '.disabled', 'tracker'), join(enabled, 'tracker'));
  expect(checkPluginTrust(enabled, ['tracker'], trust)).toMatchObject({ trusted: [], untrusted: [{ name: 'tracker' }] });
  renameSync(join(enabled, 'tracker'), join(enabled, '.disabled', 'tracker'));
  // Enabled by the person: untrusted too, the tombstone saying where it led.
  expect(await repo.enable!('tracker')).toEqual({ ok: true });
  expect(await repo.enabledPlugins()).toEqual(['tracker']);
  expect(readdirSync(join(enabled, '.disabled'))).toEqual([]);
  const state = pluginTrustOf(enabled, 'tracker', trust);
  expect(state.recorded).toBeUndefined();
  expect(state.forgotten).toBe(state.target!);
  expect(checkPluginTrust(enabled, ['tracker'], trust).trusted).toEqual([]);
  // The person's word brings it back, at once: it leads where it did.
  expect(trustPlugin(enabled, 'tracker', trust)).toMatchObject({ ok: true });
  expect(checkPluginTrust(enabled, ['tracker'], trust).trusted).toEqual(['tracker']);
});

// plugins-enabled/.disabled/ is a directory of the host's own: made a link, it is never
// read as the disabled plugins, and nothing is moved through it. A name that is not a
// plugin name there is not listed.
test('a .disabled that is a link is refused; a non-plugin name there is not listed', async () => {
  const { repo, avail, enabled } = fakeRepo();
  symlinkSync(join(avail, 'tracker'), join(enabled, 'tracker'));
  mkdirSync(join(enabled, '.disabled'));
  symlinkSync(join(avail, 'tracker'), join(enabled, '.disabled', '-bad name'));
  expect(await repo.disabledPlugins!()).toEqual([]);
  rmSync(join(enabled, '.disabled'), { recursive: true });
  const elsewhere = mkdtempSync(join(tmpdir(), 'fa-repo-elsewhere-'));
  symlinkSync(join(avail, 'tracker'), join(elsewhere, 'other'));
  symlinkSync(elsewhere, join(enabled, '.disabled'));
  expect(await repo.disabledPlugins!()).toEqual([]);
  expect((await repo.list()).some((e) => e.name === 'other')).toBe(false);
  const res = await repo.disable!('tracker');
  expect(res.ok).toBe(false);
  expect(res.error).toContain('is a link, not a directory');
  expect(existsSync(join(enabled, 'tracker'))).toBe(true);
  expect((await repo.enable!('other')).ok).toBe(false);
});

test('install turns a disabled plugin on again; remove takes a disabled one out too', async () => {
  const { repo, enabled } = fakeRepo();
  expect((await repo.install('tracker')).ok).toBe(true);
  expect((await repo.disable!('tracker')).ok).toBe(true);
  expect(await repo.install('tracker')).toEqual({ ok: true });
  expect(await repo.enabledPlugins()).toEqual(['tracker']);
  expect(await repo.disabledPlugins!()).toEqual([]);
  expect((await repo.disable!('tracker')).ok).toBe(true);
  expect(await repo.remove('tracker')).toEqual({ ok: true });
  expect(existsSync(join(enabled, '.disabled', 'tracker'))).toBe(false);
  expect((await repo.list()).find((e) => e.name === 'tracker')).toMatchObject({ active: false });
  expect(await repo.enable!('tracker')).toEqual({ ok: false, error: "plugin 'tracker' is not installed" });
});
