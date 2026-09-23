import { expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { loadPlugins } from '../loader/build';
import { createPluginRepo } from '../loader/repo';
import { hostConfigSchema } from '../config/schema';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// C1 — the repo is a separate git project that builds and type-checks.
test('C1: host builds and type-checks (bun run build && bun run typecheck)', () => {
  expect(() => execSync('bun run build && bun run typecheck', { stdio: 'ignore' })).not.toThrow();
}, 120000);

// C2 — CLI subcommands parse (interactive / config / plugins / one-shot prompt).
test('C2: CLI subcommands classify correctly', async () => {
  const { parseCli } = await import('../main');
  expect(parseCli([]).cmd).toBe('interactive');
  expect(parseCli(['config', 'set', 'ai.model', 'gpt']).cmd).toBe('config');
  expect(parseCli(['plugins', 'ls']).cmd).toBe('plugins');
  expect(parseCli(['what is the status of ABC-123']).cmd).toBe('prompt');
});

// C3 — the host config schema is tracker-agnostic (no tracker keys).
test('C3: host schema exposes no tracker keys', () => {
  const shape = hostConfigSchema.shape;
  expect(shape.boardCode).toBeUndefined();
  expect(shape.reportsDir).toBeUndefined();
  expect(shape.trackerLanguage).toBeUndefined();
  expect('tools' in shape).toBe(false);
});

// C6 — built-in core/assistant are always present (loadPlugins) and never repo-removable.
test('C6: built-ins (core/assistant) are always present and not repo-removable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fa-crit-'));
  const avail = join(root, 'plugins-available');
  const enabled = join(root, 'plugins-enabled');
  mkdirSync(avail, { recursive: true });
  mkdirSync(enabled, { recursive: true });
  const repo = createPluginRepo({ availableDir: avail, enabledDir: enabled, projectRoot: root });
  // Built-ins live in src/plugins/, not plugins-available — so repo.list() never exposes them.
  const list = await repo.list();
  expect(list.some((e) => e.name === 'core')).toBe(false);
  expect(list.some((e) => e.name === 'assistant')).toBe(false);
  // loadPlugins always injects core+assistant, regardless of the repo.
  const plugins = await loadPlugins({ config: {}, repo });
  expect(plugins.some((p) => p.name === 'core')).toBe(true);
  expect(plugins.some((p) => p.name === 'assistant')).toBe(true);
});