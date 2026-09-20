import { expect, test } from 'bun:test';
import { packPlugin, publishPlugin } from '../../scripts/publish';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('publish builds a {name}-{version}.tar.gz and uploads it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fa-pub-'));
  const dir = join(root, 'plugins-available', 'tracker');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'tracker', version: '2.0.0', deps: {} }));
  let uploaded = '';
  let uploadedTo = '';
  const r = await publishPlugin({
    availableDir: join(root, 'plugins-available'),
    name: 'tracker',
    version: '2.0.0',
    token: 'w',
    baseUrl: 'https://registry.example/api/v4',
    projectId: 'group/plugins',
    upload: async (url, file) => {
      uploaded = file;
      uploadedTo = url;
    },
  });
  expect(r.ok).toBe(true);
  expect(uploadedTo.startsWith('https://registry.example/api/v4/projects/group%2Fplugins/packages/generic/tracker/2.0.0/')).toBe(true);
  expect(uploaded.endsWith('tracker-2.0.0.tar.gz')).toBe(true);
});
test('publish refuses when no registry is configured, and uploads nothing', async () => {
  const saved = { url: process.env.FLOW_ASSIST_PLUGIN_REGISTRY_URL, project: process.env.FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT };
  delete process.env.FLOW_ASSIST_PLUGIN_REGISTRY_URL;
  delete process.env.FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT;
  try {
    let uploads = 0;
    const r = await publishPlugin({ availableDir: '/nonexistent', name: 'demo', version: '1.0.0', token: 'w', upload: async () => { uploads++; } });
    expect(r.ok).toBe(false);
    expect(String((r as { error?: string }).error)).toMatch(/FLOW_ASSIST_PLUGIN_REGISTRY_URL.*FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT/);
    expect(uploads).toBe(0);
  } finally {
    if (saved.url !== undefined) process.env.FLOW_ASSIST_PLUGIN_REGISTRY_URL = saved.url;
    if (saved.project !== undefined) process.env.FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT = saved.project;
  }
});

// ── What goes into a published plugin ─────────────────────────────────────────
const listTar = (file: string) => execSync(`tar -tzf '${file}'`).toString().split('\n').filter(Boolean).map((l) => l.replace(/\/$/, ''));
const makePlugin = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'fa-pack-'));
  const dir = join(root, 'plugins-available', 'demo');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return { dir, tar: join(root, 'demo.tar.gz') };
};

test('a plugin with dependencies is built, and ships its build — no node_modules, no sources', () => {
  const { dir, tar } = makePlugin({
    'manifest.json': '{"name":"demo","version":"1.0.0"}',
    'package.json': JSON.stringify({ main: './dist/index.mjs', scripts: { build: 'x' }, dependencies: { 'some-dep': '^1.0.0' } }),
    'README.md': 'demo',
    'LICENSE': 'GPL',
    'src/index.ts': 'export default 1;',
    'src/__tests__/a.test.ts': '',
    'node_modules/some-dep/package.json': '{"exports":"./i.js"}',
    'bun.lock': '',
    'tsconfig.json': '{}',
    '.gitignore': 'dist',
    '.env': 'SECRET=1',
  });
  const ran: string[] = [];
  const r = packPlugin(dir, tar, (cmd, cwd) => {
    ran.push(`${cmd} @ ${cwd}`);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist/index.mjs'), 'export default 1;');
  });
  expect(r).toMatchObject({ ok: true, built: true });
  expect(ran).toEqual([`bun run build @ ${dir}`]);
  const files = listTar(tar);
  expect(files).toContain('demo/dist/index.mjs');
  expect(files).toContain('demo/manifest.json');
  expect(files).toContain('demo/package.json');
  expect(files).toContain('demo/LICENSE');
  expect(files.filter((f) => /node_modules|\/src\/|__tests__|bun\.lock|tsconfig|\/\./.test(f))).toEqual([]);
});

test('a dependency-free plugin ships its sources as they are', () => {
  const { dir, tar } = makePlugin({
    'manifest.json': '{"name":"demo","version":"1.0.0"}',
    'package.json': JSON.stringify({ main: './src/index.ts' }),
    'src/index.ts': 'export default 1;',
    'src/__tests__/a.test.ts': '',
    'node_modules/dev-only/package.json': '{}',
  });
  const r = packPlugin(dir, tar, () => { throw new Error('must not build'); });
  expect(r).toMatchObject({ ok: true, built: false });
  const files = listTar(tar);
  expect(files).toContain('demo/src/index.ts');
  expect(files.some((f) => f.includes('node_modules'))).toBe(false);
});

test('dependencies without a build script are refused: nothing would carry them', () => {
  const { dir, tar } = makePlugin({
    'manifest.json': '{"name":"demo","version":"1.0.0"}',
    'package.json': JSON.stringify({ main: './src/index.ts', dependencies: { 'some-dep': '^1.0.0' } }),
    'src/index.ts': '',
  });
  const r = packPlugin(dir, tar);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/some-dep/);
  expect(r.error).toMatch(/no "build" script/);
  expect(existsSync(tar)).toBe(false);
});

test('a build that does not produce "main" is a failed publish, not an empty plugin', () => {
  const { dir, tar } = makePlugin({
    'manifest.json': '{"name":"demo","version":"1.0.0"}',
    'package.json': JSON.stringify({ main: './dist/index.mjs', scripts: { build: 'x' } }),
    'src/index.ts': '',
  });
  const r = packPlugin(dir, tar, () => {});
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/did not produce/);
  expect(existsSync(tar)).toBe(false);
});
