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
  expect(res).toEqual({ ok: false, error: `plugin 'old' is incompatible: built for host API ${OTHER}, host provides ${HOST_API}` });
  expect(existsSync(join(d.enabledDir, 'old'))).toBe(false);
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
  expect(res).toEqual({ ok: false, error: `plugin 'old' is incompatible: built for host API ${OTHER}, host provides ${HOST_API}` });
  expect(existsSync(join(d.availableDir, 'old'))).toBe(false);
  expect(existsSync(join(d.enabledDir, 'old'))).toBe(false);
});

test('the host\'s flowtty is the one installed', () => {
  expect(FLOWTTY_VERSION).toBe(JSON.parse(readFileSync('node_modules/@flowtty/react/package.json', 'utf8')).version);
});
