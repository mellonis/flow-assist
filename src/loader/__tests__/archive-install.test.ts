import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installPluginArchive, isArchiveSource } from '../archive-install';
import { createPluginRepo } from '../repo';
import { packPlugin } from '../../../scripts/publish';

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'fa-archive-'));
  const availableDir = join(root, 'plugins-available');
  const enabledDir = join(root, 'plugins-enabled');
  return { root, availableDir, enabledDir, repo: createPluginRepo({ availableDir, enabledDir, projectRoot: root }) };
}

// A plugin directory under a fresh root; `extra` adds files (path → content).
function pluginTree(name: string, manifest: object, extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'fa-archive-src-'));
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(root, name, 'index.ts'), 'export default () => null;\n');
  for (const [file, content] of Object.entries(extra)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

// tar the given members of `root` into an archive; returns its path.
function tarOf(root: string, members: string[]): string {
  const file = join(mkdtempSync(join(tmpdir(), 'fa-archive-tgz-')), 'plugin.tar.gz');
  execFileSync('tar', ['-czf', file, '-C', root, ...members]);
  return file;
}

test('an archive source is a URL or a .tar.gz / .tgz path; a name is not', () => {
  expect(isArchiveSource('./notes-0.1.0.tar.gz')).toBe(true);
  expect(isArchiveSource('notes.tgz')).toBe(true);
  expect(isArchiveSource('https://example.com/notes')).toBe(true);
  expect(isArchiveSource('notes')).toBe(false);
});

test('a file is unpacked into plugins-available, enabled, and marked as an archive', async () => {
  const d = dirs();
  const archive = tarOf(pluginTree('notes', { name: 'notes', version: '0.2.0' }), ['notes']);
  const res = await installPluginArchive(archive, d);
  expect(res).toEqual({ ok: true, name: 'notes', version: '0.2.0', replaced: false });
  expect(existsSync(join(d.availableDir, 'notes', 'index.ts'))).toBe(true);
  expect(lstatSync(join(d.enabledDir, 'notes')).isSymbolicLink()).toBe(true);
  const listed = (await d.repo.list()).find((e) => e.name === 'notes');
  expect(listed).toMatchObject({ version: '0.2.0', active: true, source: 'archive' });
  // `update` does not pretend it can fetch it.
  expect((await d.repo.update('notes')).error).toMatch(/installed from an archive — install the newer archive/);
});

test('what `plugin:publish` packs installs as it is — the release round trip', async () => {
  const d = dirs();
  const tgz = join(mkdtempSync(join(tmpdir(), 'fa-archive-pack-')), 'notes-0.1.0.tar.gz');
  // The example plugin, packed the way a release packs it.
  const packed = packPlugin(resolve(import.meta.dir, '../../../examples/notes'), tgz, () => {});
  expect(packed.ok).toBe(true);
  const res = await installPluginArchive(tgz, d);
  expect(res).toMatchObject({ ok: true, name: 'notes', version: '0.1.0' });
  expect(existsSync(join(d.availableDir, 'notes', 'src', 'index.ts'))).toBe(true);
});

test('an https URL is downloaded and installed; http is refused before any request', async () => {
  const d = dirs();
  const bytes = readFileSync(tarOf(pluginTree('notes', { name: 'notes', version: '1.0.0' }), ['notes']));
  const urls: string[] = [];
  const fetch = (async (url: string) => { urls.push(url); return new Response(bytes); }) as any;
  expect(await installPluginArchive('https://example.com/notes-1.0.0.tar.gz', { ...d, fetch })).toMatchObject({ ok: true, name: 'notes' });
  expect(urls).toEqual(['https://example.com/notes-1.0.0.tar.gz']);

  const d2 = dirs();
  const res = await installPluginArchive('http://example.com/notes-1.0.0.tar.gz', { ...d2, fetch });
  expect(res.error).toMatch(/https only/);
  expect(urls).toHaveLength(1);
  expect(existsSync(d2.availableDir)).toBe(false);
});

test('a failed download says so and writes nothing', async () => {
  const d = dirs();
  const fetch = (async () => new Response('nope', { status: 404 })) as any;
  const res = await installPluginArchive('https://example.com/notes.tar.gz', { ...d, fetch });
  expect(res.error).toMatch(/HTTP 404/);
  expect(existsSync(d.availableDir)).toBe(false);
});

// Each refused archive must leave plugins-available untouched — nothing extracted.
async function refused(archive: string, why: RegExp) {
  const d = dirs();
  const res = await installPluginArchive(archive, d);
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(why);
  expect(existsSync(d.availableDir) ? readdirSync(d.availableDir) : []).toEqual([]);
  expect(existsSync(d.enabledDir)).toBe(false);
}

test('a member that climbs out of the directory is refused unread', async () => {
  const root = pluginTree('notes', { name: 'notes' }, { 'evil/x': 'x' });
  await refused(tarOf(root, ['notes/manifest.json', 'notes/../evil/x']), /path outside its directory: notes\/\.\.\/evil\/x/);
});

test('a link inside the archive is refused unread', async () => {
  const root = pluginTree('notes', { name: 'notes' });
  symlinkSync('/etc', join(root, 'notes', 'etc'));
  await refused(tarOf(root, ['notes']), /holds a link/);
});

test('two top-level directories, a missing manifest, a mismatched name and a non-archive are refused', async () => {
  const two = pluginTree('notes', { name: 'notes' }, { 'other/x': 'x' });
  await refused(tarOf(two, ['notes', 'other']), /one top-level directory, this one has 2/);
  const bare = mkdtempSync(join(tmpdir(), 'fa-archive-bare-'));
  mkdirSync(join(bare, 'notes'));
  writeFileSync(join(bare, 'notes', 'index.ts'), '');
  await refused(tarOf(bare, ['notes']), /no manifest\.json in notes\//);
  await refused(tarOf(pluginTree('notes', { name: 'tracker' }), ['notes']), /manifest names 'tracker', the archive's directory is 'notes'/);
  const junk = join(mkdtempSync(join(tmpdir(), 'fa-archive-junk-')), 'notes.tar.gz');
  writeFileSync(junk, 'not a tarball');
  await refused(junk, /not a plugin archive/);
  await refused('/no/such/notes.tar.gz', /no such file/);
});

test('a newer archive replaces one installed from an archive; a checkout is never overwritten', async () => {
  const d = dirs();
  await installPluginArchive(tarOf(pluginTree('notes', { name: 'notes', version: '1.0.0' }), ['notes']), d);
  const newer = await installPluginArchive(tarOf(pluginTree('notes', { name: 'notes', version: '1.1.0' }), ['notes']), d);
  expect(newer).toMatchObject({ ok: true, version: '1.1.0', replaced: true, previousVersion: '1.0.0' });
  // Installing the same version again is still a replace, but there is no "was …" to say.
  const same = await installPluginArchive(tarOf(pluginTree('notes', { name: 'notes', version: '1.1.0' }), ['notes']), d);
  expect(same).toMatchObject({ ok: true, version: '1.1.0', replaced: true });
  expect(same.previousVersion).toBeUndefined();
  expect(JSON.parse(readFileSync(join(d.availableDir, 'notes', 'manifest.json'), 'utf8')).version).toBe('1.1.0');

  mkdirSync(join(d.availableDir, 'repo'), { recursive: true });
  writeFileSync(join(d.availableDir, 'repo', 'manifest.json'), JSON.stringify({ name: 'repo', version: 'mine' }));
  const res = await installPluginArchive(tarOf(pluginTree('repo', { name: 'repo', version: '9.9.9' }), ['repo']), d);
  expect(res.error).toMatch(/already in plugins-available, a checkout — update it with git/);
  expect(JSON.parse(readFileSync(join(d.availableDir, 'repo', 'manifest.json'), 'utf8')).version).toBe('mine');
});
