import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostVersion } from '../version';
import { THIS_HOST, pluginCompat } from '../loader/compat';

test('host reports a semver version', () => {
  expect(hostVersion()).toMatch(/^\d+\.\d+\.\d+/);
});
test('the host version is the one in package.json', () => {
  expect(hostVersion()).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
});

// Which `plugins-available/*` are bundled (shipped with this repo, checked in),
// as opposed to a name someone dropped in locally (`plugins install`, a registry
// fetch, a company plugin) — the ONLY source of truth for that is the root
// `.gitignore`, which excludes `plugins-available/*` wholesale and un-ignores each
// bundled one by name (`!/plugins-available/<name>/`). A hand-dropped plugin has
// no marker of its own that says "not bundled", so this is read rather than
// hardcoded: a name added here without updating `.gitignore` would never ship.
function bundledPluginNames(): string[] {
  let gitignore: string;
  try {
    gitignore = readFileSync('.gitignore', 'utf8');
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const line of gitignore.split('\n')) {
    const m = line.match(/^!\/plugins-available\/([^/]+)\/$/);
    if (m) names.push(m[1]!);
  }
  return names;
}

// A bundled plugin ships with the host from the same repo and release, so it
// carries the host's own version — a `repo-1.0.0.tar.gz` beside a `0.1.0` host
// reads like a mismatch. A plugin dropped into `plugins-available/` locally (an
// installed archive, a company plugin) is not bundled and versions itself, so it
// is not checked here. `plugins-available/` may be absent or emptied (the host
// suite must pass without it), in which case there is nothing to check.
test('every bundled plugin shares the host version', () => {
  const version = hostVersion();
  const availableDir = 'plugins-available';
  for (const name of bundledPluginNames()) {
    const manifestPath = join(availableDir, name, 'manifest.json');
    if (!existsSync(manifestPath)) continue; // not installed in this checkout
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string };
    expect(manifest.version, `${name}/manifest.json`).toBe(version);
    const packageJsonPath = join(availableDir, name, 'package.json');
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    expect(pkg.version, `${name}/package.json`).toBe(version);
  }
});

// A bundled plugin and the example ship with this host, so they say what they are built
// for — the host API and the flowtty range, both — and this host loads them. The loader
// itself takes a manifest with no `flowtty` (a plugin with no screens), with a note.
test('every bundled plugin and the example declare the host API and flowtty they are built for', () => {
  const manifests = [
    ...bundledPluginNames().map((name) => join('plugins-available', name, 'manifest.json')),
    join('examples', 'notes', 'manifest.json'),
  ].filter((p) => existsSync(p));
  for (const path of manifests) {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(manifest.hostApi, path).toBeDefined();
    expect(typeof manifest.flowtty, path).toBe('string');
    expect(pluginCompat(manifest, THIS_HOST), path).toEqual({ ok: true });
  }
});
