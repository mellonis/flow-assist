import { expect, test } from 'bun:test';
import { loadPlugins } from '../loader/build';
import { assembleToolRegistry } from '../loader/tools';
import { createPluginRepo } from '../loader/repo';
import { makeFactory } from '../loader/plugin';
import type { PluginShape } from '../loader/plugin';
import { hostConfigSchema } from '../config/schema';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestBackend, flush } from '@flowtty/core/testing';
import { renderApp } from '../runtime/app';

test('host is tracker-agnostic and loads a plugin-delivered tool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fa-host-'));
  const avail = join(root, 'plugins-available');
  const enabled = join(root, 'plugins-enabled');
  mkdirSync(avail, { recursive: true });
  mkdirSync(enabled, { recursive: true });
  const repo = createPluginRepo({ availableDir: avail, enabledDir: enabled, projectRoot: root });

  // A tracker-plugin-shaped plugin that delivers ONE tool. Import would fail at
  // runtime (its dependencies are not installed here), so it is built
  // in-memory; the real plugins-enabled import path is exercised elsewhere.
  const make = makeFactory();
  const trackerPlugin = make('tracker', {
    tools: [
      {
        id: 'tracker',
        alwaysOn: true,
        tools: [
          {
            type: 'function',
            function: { name: 'tracker:open', description: 'open an issue', parameters: {} },
            run: async () => 'ok',
          },
        ],
        exec: async () => 'ok',
      },
    ],
  });

  // Real host wiring: built-ins load, registry assembles, config is tracker-free.
  const config: Record<string, unknown> = {};
  const plugins = await loadPlugins({ config, repo });
  const reg = assembleToolRegistry({ plugins: [...plugins, trackerPlugin], config, repo });

  // Acceptance #1: a built-in core tool flows through the assembled registry.
  expect(reg.tools.some((t) => t.function.name === 'memory')).toBe(true);
  // Acceptance #2: a plugin-delivered tool flows through the assembled registry.
  expect(reg.tools.some((t) => t.function.name === 'tracker:open')).toBe(true);
  // Acceptance #3: host is tracker-agnostic — no tracker/renamed keys in the schema.
  expect('trackerLanguage' in hostConfigSchema.shape).toBe(false);
  expect('tools' in hostConfigSchema.shape).toBe(false);
  const aiShape = hostConfigSchema.shape.ai.unwrap().shape;
  expect('chatLanguage' in aiShape).toBe(false);
  expect('tools' in aiShape).toBe(false);
});

test('renderApp mounts an empty shell (no plugins) without throwing', async () => {
  const backend = new TestBackend(80, 24);
  const handle = await renderApp(backend, { plugins: [], config: {}, onExit: () => {} });
  expect(handle).toBeTruthy();
  await flush();
  handle.unmount();
});

test('renderApp wires an enabled plugin: setup runs before mount, plugin services are visible, the host wins its own keys', async () => {
  // A throwaway plugin in a temp dir, enabled through the same symlink set the
  // real CLI uses. The host must stay testable with `plugins-available/` empty,
  // so nothing here may name a shipped plugin.
  const root = mkdtempSync(join(tmpdir(), 'fa-host-'));
  const available = join(root, 'plugins-available');
  const enabled = join(root, 'plugins-enabled');
  mkdirSync(join(available, 'demo'), { recursive: true });
  mkdirSync(enabled, { recursive: true });
  writeFileSync(join(available, 'demo', 'package.json'), JSON.stringify({ name: 'demo-plugin', type: 'module', main: './index.mjs' }));
  writeFileSync(join(available, 'demo', 'manifest.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
  writeFileSync(
    join(available, 'demo', 'index.mjs'),
    `const trace = (globalThis.__daDemoTrace = []);
     let store = null;
     const pluginShowMessage = () => {};
     export default ({ make }) => make('demo', {
       name: 'demo',
       services: {
         get detail() { return store; },
         showMessage: pluginShowMessage,
       },
       setup(ft) {
         store = { seeded: true };
         trace.push({ step: 'setup', ownDetail: ft.services.detail });
       },
       components: {
         overlay: (ft) => {
           trace.push({ step: 'factory', detail: ft.services.detail, clobbered: ft.services.showMessage === pluginShowMessage });
           return () => null;
         },
       },
     });`,
  );
  symlinkSync(join(available, 'demo'), join(enabled, 'demo'));

  try {
    const repo = createPluginRepo({ availableDir: available, enabledDir: enabled, projectRoot: root });
    const config: Record<string, unknown> = {};
    const plugins = await loadPlugins({ config, repo, enabledDir: enabled });
    expect(plugins.some((p) => p.name === 'demo')).toBe(true);

    const backend = new TestBackend(80, 24);
    const handle = await renderApp(backend, { plugins, config, onExit: () => {} });
    await flush();
    handle.unmount();

    const trace = (globalThis as unknown as { __daDemoTrace: Array<Record<string, unknown>> }).__daDemoTrace;
    const steps = trace.map((t) => t.step);
    // `setup` seeds the store before any component factory runs.
    expect(steps.indexOf('setup')).toBe(0);
    expect(steps.indexOf('factory')).toBeGreaterThan(0);
    const factory = trace.find((t) => t.step === 'factory') as Record<string, unknown>;
    // The plugin-owned lazy getter is live through ft.services…
    expect(factory.detail).toEqual({ seeded: true });
    // …and a plugin's same-named key never clobbers a host service.
    expect(factory.clobbered).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('command line: ESC-only close, buffer clear, and up/down history', async () => {
  // Host-only commands (no network): drive the `:` line and assert the three
  // command-line fixes — `:` opens but does NOT close a typed line, executing a
  // command clears the buffer for the next open, and up/down recall history.
  const config: Record<string, unknown> = {};
  const plugins: PluginShape[] = [];
  const backend = new TestBackend(80, 24);
  const handle = await renderApp(backend, { plugins, config, onExit: () => {} });
  await flush();

  // 1. `:` opens; after typing, a second `:` must NOT close the line.
  backend.press({ name: ':' });
  backend.type('help');
  await flush();
  backend.press({ name: ':' });
  await flush();
  // The line is still open (`help` in the buffer), not collapsed to the base shell.
  expect(backend.lastFrame).toContain(': help');

  // 2. Enter executes and clears the buffer for the next open.
  backend.press({ name: 'return' });
  await flush();
  // Help modal is up (command ran). Close it with Esc.
  backend.press({ name: 'escape' });
  await flush();
  backend.press({ name: ':' });
  await flush();
  // The buffer is empty on reopen (no leftover `help`).
  expect(backend.lastFrame).not.toContain(': help');

  // 3. Up recalls the executed command; Down returns to the empty buffer.
  backend.type('clear');
  backend.press({ name: 'return' });
  await flush();
  backend.press({ name: ':' });
  backend.press({ name: 'up' });
  await flush();
  expect(backend.lastFrame).toContain('clear');
  backend.press({ name: 'up' });
  await flush();
  expect(backend.lastFrame).toContain('help');
  backend.press({ name: 'down' });
  await flush();
  // Down past the newest entry lands on the empty buffer.
  expect(backend.lastFrame).not.toContain(': help');

  handle.unmount();
});