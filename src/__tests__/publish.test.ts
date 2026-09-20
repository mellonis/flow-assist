import { expect, test } from 'bun:test';
import { publishPlugin } from '../../scripts/publish';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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
