// Whether a plugin can run here, from its manifest: the host API numbers it names and
// the flowtty range it needs. The same answer wherever a plugin is listed, loaded or
// installed — and the loader asks before any of the plugin's code runs.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostApiSet, pluginCompat } from '../compat';
import { loadPlugins } from '../build';
import { createPluginRepo } from '../repo';
import { installPluginArchive } from '../archive-install';
import { FLOWTTY_VERSION, HOST_API } from '../../version';

const HOST = { api: 2, flowtty: '1.0.0-alpha.26' };

test('hostApi is a number or a list of numbers; missing is 1', () => {
  expect(hostApiSet(undefined)).toEqual([1]);
  expect(hostApiSet(2)).toEqual([2]);
  expect(hostApiSet([1, 2])).toEqual([1, 2]);
  expect(hostApiSet('2')).toBeNull();
  expect(hostApiSet([])).toBeNull();
  expect(hostApiSet([1.5])).toBeNull();
});

test('a plugin loads when the host\'s number is one it names', () => {
  expect(pluginCompat({ hostApi: 2, flowtty: '^1.0.0-alpha.26' }, HOST)).toEqual({ ok: true });
  expect(pluginCompat({ hostApi: [1, 2], flowtty: '^1.0.0-alpha.26' }, HOST)).toEqual({ ok: true });
  expect(pluginCompat({}, HOST)).toEqual({ ok: false, reason: 'incompatible: built for host API 1, host provides 2' });
  expect(pluginCompat({ hostApi: [3] }, HOST)).toEqual({ ok: false, reason: 'incompatible: built for host API 3, host provides 2' });
  expect(pluginCompat({ hostApi: [1, 3] }, HOST)).toEqual({ ok: false, reason: 'incompatible: built for host APIs 1, 3, host provides 2' });
  expect(pluginCompat({ hostApi: 'two' }, HOST)).toMatchObject({ ok: false, reason: expect.stringContaining('not a number or a list of numbers') });
});

test('the flowtty range is checked against the host\'s flowtty — a prerelease only by a range that names one', () => {
  const at = (flowtty: unknown) => pluginCompat({ hostApi: 2, flowtty }, HOST);
  expect(at('>=1.0.0-alpha.26 <1.1.0')).toEqual({ ok: true });
  expect(at('^1.0.0-alpha.26')).toEqual({ ok: true });
  expect(at('>=1.0.0-alpha.27')).toEqual({ ok: false, reason: 'incompatible: needs flowtty >=1.0.0-alpha.27, host has 1.0.0-alpha.26' });
  expect(at('^1.0.0')).toEqual({ ok: false, reason: 'incompatible: needs flowtty ^1.0.0, host has 1.0.0-alpha.26' });
  expect(at(42)).toMatchObject({ ok: false, reason: expect.stringContaining('not a semver range') });
  // Missing: loaded, with a note.
  expect(at(undefined)).toEqual({ ok: true, note: 'declares no flowtty range — loaded unchecked' });
});

// A plugins dir with one plugin per entry: its manifest, and an entry that throws when
// imported — so a plugin the loader refuses proves it refused before importing.
function pluginsDir(plugins: Record<string, { manifest: object; throws?: boolean }>) {
  const root = mkdtempSync(join(tmpdir(), 'fa-compat-'));
  const availableDir = join(root, 'plugins-available');
  const enabledDir = join(root, 'plugins-enabled');
  mkdirSync(enabledDir, { recursive: true });
  for (const [name, p] of Object.entries(plugins)) {
    const dir = join(availableDir, name);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name, version: '0.1.0', ...p.manifest }));
    writeFileSync(join(dir, 'src', 'index.ts'), p.throws
      ? `throw new Error('${name} was imported');\n`
      : `export default ({ make }: any) => make('${name}', { name: '${name}' });\n`);
    symlinkSync(dir, join(enabledDir, name));
  }
  return { availableDir, enabledDir, repo: createPluginRepo({ availableDir, enabledDir, projectRoot: root }) };
}

const OTHER = HOST_API + 1;
const FITS = `^${FLOWTTY_VERSION}`;

test('the loader skips a plugin built for another host API before importing it; the rest load', async () => {
  const d = pluginsDir({
    old: { manifest: { hostApi: OTHER, flowtty: FITS }, throws: true },
    both: { manifest: { hostApi: [OTHER, HOST_API], flowtty: FITS } },
    fits: { manifest: { hostApi: HOST_API, flowtty: FITS } },
    newer: { manifest: { hostApi: HOST_API, flowtty: '>=99.0.0' }, throws: true },
  });
  const notes: string[] = [];
  const warn = console.warn;
  console.warn = () => {};
  let plugins;
  try {
    plugins = await loadPlugins({ config: {}, repo: d.repo, enabledDir: d.enabledDir, notes });
  } finally {
    console.warn = warn;
  }
  const names = plugins.map((p) => p.name);
  expect(names).toContain('fits');
  expect(names).toContain('both');
  expect(names).toContain('assistant'); // the host runs
  expect(names).not.toContain('old');
  expect(names).not.toContain('newer');
  expect(notes).toContain(`[plugins] skip old: incompatible: built for host API ${OTHER}, host provides ${HOST_API}`);
  expect(notes).toContain(`[plugins] skip newer: incompatible: needs flowtty >=99.0.0, host has ${FLOWTTY_VERSION}`);
  expect(notes.join('\n')).not.toContain('was imported');
});

test('plugins ls names why a plugin cannot load; install refuses it', async () => {
  const d = pluginsDir({ fits: { manifest: { hostApi: HOST_API, flowtty: FITS } } });
  const dir = join(d.availableDir, 'old');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'old', version: '0.1.0', hostApi: OTHER }));
  const listed = await d.repo.list();
  expect(listed.find((e) => e.name === 'old')?.incompatible).toBe(`incompatible: built for host API ${OTHER}, host provides ${HOST_API}`);
  expect(listed.find((e) => e.name === 'fits')?.incompatible).toBeUndefined();
  const res = await d.repo.install('old');
  expect(res).toEqual({ ok: false, error: `plugin 'old': incompatible: built for host API ${OTHER}, host provides ${HOST_API}` });
  expect(existsSync(join(d.enabledDir, 'old'))).toBe(false);
});

test('plugins ls lists a plugin linked in from elsewhere, with why it cannot load', async () => {
  const d = pluginsDir({ fits: { manifest: { hostApi: HOST_API, flowtty: FITS } } });
  // A plugin kept in a repository of its own, linked into plugins-enabled/.
  const elsewhere = mkdtempSync(join(tmpdir(), 'fa-compat-own-'));
  writeFileSync(join(elsewhere, 'manifest.json'), JSON.stringify({ name: 'corp', version: '3.0.0', hostApi: OTHER }));
  symlinkSync(elsewhere, join(d.enabledDir, 'corp'));
  const listed = await d.repo.list();
  expect(listed.find((e) => e.name === 'corp')).toMatchObject({
    version: '3.0.0', active: true, source: 'linked',
    incompatible: `incompatible: built for host API ${OTHER}, host provides ${HOST_API}`,
  });
  // One linked from plugins-available/ is listed once, from there.
  expect(listed.filter((e) => e.name === 'fits')).toHaveLength(1);
  expect(listed.find((e) => e.name === 'fits')?.source).not.toBe('linked');
});

test('an archive of a plugin this host cannot load is refused up front, nothing unpacked into place', async () => {
  const d = pluginsDir({});
  const src = mkdtempSync(join(tmpdir(), 'fa-compat-src-'));
  mkdirSync(join(src, 'old'));
  writeFileSync(join(src, 'old', 'manifest.json'), JSON.stringify({ name: 'old', version: '0.1.0', hostApi: OTHER }));
  writeFileSync(join(src, 'old', 'index.ts'), 'export default () => null;\n');
  const archive = join(mkdtempSync(join(tmpdir(), 'fa-compat-tgz-')), 'old.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', src, 'old']);
  const res = await installPluginArchive(archive, d);
  expect(res).toEqual({ ok: false, error: `plugin 'old': incompatible: built for host API ${OTHER}, host provides ${HOST_API}` });
  expect(existsSync(join(d.availableDir, 'old'))).toBe(false);
  expect(existsSync(join(d.enabledDir, 'old'))).toBe(false);
});

test('the host\'s flowtty is the one installed', () => {
  expect(FLOWTTY_VERSION).toBe(JSON.parse(readFileSync('node_modules/@flowtty/react/package.json', 'utf8')).version);
});

// A fake registry: each fetch writes the next manifest it was given into the plugin's
// directory, as the real download untars into it; `fail` throws instead.
function registry(root: string, next: (object | 'fail')[]) {
  const availableDir = join(root, 'plugins-available');
  const enabledDir = join(root, 'plugins-enabled');
  mkdirSync(availableDir, { recursive: true });
  const repo = createPluginRepo({
    availableDir, enabledDir, projectRoot: root,
    fetchPlugin: async (name) => {
      const m = next.shift();
      if (m === 'fail' || m === undefined) throw new Error('registry: 503');
      const dir = join(availableDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name, ...m }));
      writeFileSync(join(dir, 'index.ts'), `export const v = ${JSON.stringify((m as { version?: string }).version)};\n`);
      return { version: String((m as { version?: string }).version) };
    },
  });
  return { availableDir, enabledDir, repo };
}

test('an update this host cannot load keeps the installed version, linked and working', async () => {
  const d = registry(mkdtempSync(join(tmpdir(), 'fa-compat-reg-')), [
    { version: '1.0.0', hostApi: HOST_API },
    { version: '2.0.0', hostApi: OTHER },
  ]);
  expect((await d.repo.install('tracker')).ok).toBe(true);
  const res = await d.repo.update('tracker');
  expect(res.ok).toBe(false);
  expect(res.error).toContain(`incompatible: built for host API ${OTHER}`);
  expect(res.error).toContain('the installed version is kept');
  expect(JSON.parse(readFileSync(join(d.availableDir, 'tracker', 'manifest.json'), 'utf8')).version).toBe('1.0.0');
  expect(readFileSync(join(d.enabledDir, 'tracker', 'index.ts'), 'utf8')).toContain('1.0.0');
  expect(existsSync(join(d.availableDir, 'tracker.flow-assist-previous'))).toBe(false);
});

test('a failed fresh install leaves nothing behind; a failed fetch keeps the installed version', async () => {
  const d = registry(mkdtempSync(join(tmpdir(), 'fa-compat-reg-')), [
    { version: '1.0.0', hostApi: OTHER },
    { version: '1.0.0', hostApi: HOST_API },
    'fail',
  ]);
  expect((await d.repo.install('tracker')).ok).toBe(false);
  expect(existsSync(join(d.availableDir, 'tracker'))).toBe(false);
  expect(existsSync(join(d.enabledDir, 'tracker'))).toBe(false);
  expect((await d.repo.install('tracker')).ok).toBe(true);
  const res = await d.repo.update('tracker');
  expect(res).toEqual({ ok: false, error: 'registry: 503' });
  expect(JSON.parse(readFileSync(join(d.availableDir, 'tracker', 'manifest.json'), 'utf8')).version).toBe('1.0.0');
});

test('a batch update goes on past a failure and names each one', async () => {
  const d = registry(mkdtempSync(join(tmpdir(), 'fa-compat-reg-')), [
    { version: '1.0.0', hostApi: HOST_API },
    { version: '1.0.0', hostApi: HOST_API },
    { version: '1.0.0', hostApi: HOST_API },
  ]);
  for (const n of ['a', 'b', 'c']) expect((await d.repo.install(n)).ok).toBe(true);
  // a fails, b is incompatible, c updates.
  const next: Record<string, object | 'fail'> = { a: 'fail', b: { version: '2.0.0', hostApi: OTHER }, c: { version: '2.0.0', hostApi: HOST_API } };
  const d2 = createPluginRepo({
    availableDir: d.availableDir, enabledDir: d.enabledDir, projectRoot: '/',
    fetchPlugin: async (name) => {
      const m = next[name];
      if (m === 'fail') throw new Error('registry: 503');
      mkdirSync(join(d.availableDir, name), { recursive: true });
      writeFileSync(join(d.availableDir, name, 'manifest.json'), JSON.stringify({ name, ...(m as object) }));
      return { version: '2.0.0' };
    },
  });
  const res = await d2.update();
  expect(res.ok).toBe(false);
  expect(res.error).toContain("update 'a': registry: 503");
  expect(res.error).toContain(`update 'b': plugin 'b': incompatible: built for host API ${OTHER}`);
  expect(JSON.parse(readFileSync(join(d.availableDir, 'c', 'manifest.json'), 'utf8')).version).toBe('2.0.0');
  expect(JSON.parse(readFileSync(join(d.availableDir, 'a', 'manifest.json'), 'utf8')).version).toBe('1.0.0');
  expect(JSON.parse(readFileSync(join(d.availableDir, 'b', 'manifest.json'), 'utf8')).version).toBe('1.0.0');
});

test('a manifest.json that does not parse is said as such — at load, in plugins ls, at install', async () => {
  const d = pluginsDir({});
  const dir = join(d.availableDir, 'bent');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), '{ "name": "bent", ');
  writeFileSync(join(dir, 'src', 'index.ts'), "throw new Error('bent was imported');\n");
  expect(pluginCompat(null, HOST)).toEqual({ ok: false, reason: 'manifest.json is not valid JSON' });
  expect((await d.repo.list()).find((e) => e.name === 'bent')?.incompatible).toBe('manifest.json is not valid JSON');
  expect(await d.repo.install('bent')).toEqual({ ok: false, error: "plugin 'bent': manifest.json is not valid JSON" });
  symlinkSync(dir, join(d.enabledDir, 'bent'));
  const notes: string[] = [];
  const warn = console.warn;
  console.warn = () => {};
  await loadPlugins({ config: {}, repo: d.repo, enabledDir: d.enabledDir, notes }).finally(() => { console.warn = warn; });
  expect(notes).toContain('[plugins] skip bent: manifest.json is not valid JSON');
});

test('a linked plugin is listed with its missing settings, and a link to nothing as broken', async () => {
  const d = pluginsDir({});
  const elsewhere = mkdtempSync(join(tmpdir(), 'fa-compat-own-'));
  writeFileSync(join(elsewhere, 'manifest.json'), JSON.stringify({ name: 'corp', version: '1.0.0', hostApi: HOST_API, requiredSettings: ['FLOW_ASSIST_TEST_NEVER_SET'] }));
  symlinkSync(elsewhere, join(d.enabledDir, 'corp'));
  symlinkSync(join(elsewhere, 'gone'), join(d.enabledDir, 'gone'));
  const listed = await d.repo.list();
  expect(listed.find((e) => e.name === 'corp')?.missingSettings).toEqual(['FLOW_ASSIST_TEST_NEVER_SET']);
  expect(listed.find((e) => e.name === 'gone')).toMatchObject({ source: 'linked', broken: true });
});
