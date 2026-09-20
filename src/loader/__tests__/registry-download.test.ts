import { expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchPluginFromRegistry } from '../registry-download';

// Build a gzipped tarball (top-level `<name>/`) with the system `tar` — the SAME
// engine the fetcher extracts with — so the round-trip archive format matches.
function tarStub(name: string, version: string): Uint8Array {
  const root = mkdtempSync(join(tmpdir(), 'fa-tar-'));
  const pluginDir = join(root, name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, 'manifest.json'),
    JSON.stringify({ name, version, deps: {} }),
  );
  writeFileSync(join(pluginDir, 'index.ts'), 'export default function build() { return "ok"; }');
  const parent = join(root);
  const buf = execSync(`tar -czf - -C ${parent} ${name}`, { encoding: 'buffer' });
  return new Uint8Array(buf as Uint8Array);
}

test('downloads the tarball, extracts, and writes the provenance marker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fa-reg-'));
  const avail = join(root, 'plugins-available');
  mkdirSync(avail, { recursive: true });
  // fake transport returns a gzipped tarball containing manifest.json + index.ts
  const fakeFetch = async (url: string) => new Response(tarStub('tracker', '2.0.0'));
  const fetchOne = fetchPluginFromRegistry({
    baseUrl: 'https://x',
    projectId: 1,
    token: 't',
    availableDir: avail,
    fetch: fakeFetch as any,
  });
  const r = await fetchOne('tracker', '2.0.0');
  expect(r.version).toBe('2.0.0');
  expect(existsSync(join(avail, 'tracker', '.flow-assist-source'))).toBe(true);
  expect(JSON.parse(readFileSync(join(avail, 'tracker', 'manifest.json'), 'utf8')).name).toBe('tracker');
});
test('an unconfigured registry refuses to download and never touches the network', async () => {
  // No built-in registry: a host with no FLOW_ASSIST_PLUGIN_REGISTRY_URL/PROJECT must not
  // phone any default server — it names what to set instead.
  const saved = { url: process.env.FLOW_ASSIST_PLUGIN_REGISTRY_URL, project: process.env.FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT };
  delete process.env.FLOW_ASSIST_PLUGIN_REGISTRY_URL;
  delete process.env.FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT;
  try {
    const urls: string[] = [];
    const fetchOne = fetchPluginFromRegistry({
      token: 't',
      availableDir: mkdtempSync(join(tmpdir(), 'fa-reg-')),
      fetch: (async (url: string) => { urls.push(url); return new Response('', { status: 500 }); }) as any,
    });
    await expect(fetchOne('demo', '1.0.0')).rejects.toThrow(/FLOW_ASSIST_PLUGIN_REGISTRY_URL.*FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT/);
    expect(urls).toEqual([]);
  } finally {
    if (saved.url !== undefined) process.env.FLOW_ASSIST_PLUGIN_REGISTRY_URL = saved.url;
    if (saved.project !== undefined) process.env.FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT = saved.project;
  }
});
