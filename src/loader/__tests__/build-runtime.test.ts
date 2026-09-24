import { expect, test } from 'bun:test';
import { loadPlugins } from '../build';
import { createPluginRepo } from '../repo';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST_API } from '../../version';

test('loads an enabled runtime plugin; skips broken/missing-deps plugin with a warn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fa-buildrt-'));
  const avail = join(root, 'plugins-available');
  const enabled = join(root, 'plugins-enabled');
  mkdirSync(avail, { recursive: true });
  mkdirSync(enabled, { recursive: true });
  // A real plugin dir whose default builder throws — linked into plugins-enabled
  // via symlink so the symlink-only `enabledPlugins()` filter picks it up.
  const badDir = join(avail, 'bad');
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, 'index.ts'), 'export default function build(){ throw new Error("bad build"); }');
  symlinkSync(badDir, join(enabled, 'bad'));
  const repo = createPluginRepo({ availableDir: avail, enabledDir: enabled, projectRoot: root });
  const plugins = await loadPlugins({ config: {}, repo, enabledDir: enabled });
  // bad plugin is skipped; built-ins still load
  expect(plugins.some((p) => p.name === 'bad')).toBe(false);
  expect(plugins.some((p) => p.name === 'core')).toBe(true);
});

test('loads a plugin dir via its package.json main; a single-file plugin has no manifest and is refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fa-entry-'));
  const avail = join(root, 'plugins-available');
  const enabled = join(root, 'plugins-enabled');
  mkdirSync(avail, { recursive: true });
  mkdirSync(enabled, { recursive: true });
  // A directory plugin whose entry is a nested `package.json` `main` — the shape the
  // tracker/gitlab/repo plugins all use. Importing the directory (rather than the
  // entry FILE) is what the compiled binary cannot resolve.
  const dirPlug = join(avail, 'dirplug');
  mkdirSync(join(dirPlug, 'src'), { recursive: true });
  writeFileSync(join(dirPlug, 'package.json'), JSON.stringify({ name: 'dirplug', main: './src/index.ts' }));
  writeFileSync(join(dirPlug, 'manifest.json'), JSON.stringify({ name: 'dirplug', version: '1.0.0', hostApi: HOST_API }));
  writeFileSync(join(dirPlug, 'src', 'index.ts'), 'export default function build(){ return { name: "dirplug" }; }');
  symlinkSync(dirPlug, join(enabled, 'dirplug'));
  // A single-file plugin (a symlink straight to a .ts, no directory).
  const filePlug = join(avail, 'fileplug.ts');
  writeFileSync(filePlug, 'export default function build(){ return { name: "fileplug" }; }');
  symlinkSync(filePlug, join(enabled, 'fileplug'));
  const repo = createPluginRepo({ availableDir: avail, enabledDir: enabled, projectRoot: root });
  const notes: string[] = [];
  const warn = console.warn;
  console.warn = () => {};
  const plugins = await loadPlugins({ config: {}, repo, enabledDir: enabled, notes }).finally(() => { console.warn = warn; });
  expect(plugins.some((p) => p.name === 'dirplug')).toBe(true);
  // No manifest: host API 1, which this host does not provide.
  expect(plugins.some((p) => p.name === 'fileplug')).toBe(false);
  expect(notes).toContain(`[plugins] skip fileplug: incompatible: built for host API 1, host provides ${HOST_API}`);
});