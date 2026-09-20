import { expect, test } from 'bun:test';
import { loadPlugins } from '../build';
import { createPluginRepo } from '../repo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('built-ins are always present and not removable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fa-build-'));
  const repo = createPluginRepo({ availableDir: join(root, 'plugins-available'), enabledDir: join(root, 'plugins-enabled'), projectRoot: root });
  const plugins = await loadPlugins({ config: {}, repo });
  const names = plugins.map(p => p.name);
  expect(names).toContain('core');
  expect(names).toContain('assistant');
  expect(names).toContain('keycaps');
  expect(names).toContain('log');
});