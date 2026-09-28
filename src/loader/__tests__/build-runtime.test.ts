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
// A plugin marks which of its keys the model may change with the host's own
// registries, handed to its builder beside `z` — a mark is found by the node, so it
// must be the host's registry the node is registered in.
test('a builder gets the host\'s mark registries beside z, and a key it marks is the model\'s to set', async () => {
  const { configMarks } = await import('../../config/load');
  const { hostConfigSchema, modelMaySet, modelMaySave, appliesOnRestart } = await import('../../config/schema');
  const { pluginConfigs } = await import('../tools');
  const root = mkdtempSync(join(tmpdir(), 'fa-marks-'));
  const avail = join(root, 'plugins-available');
  const enabled = join(root, 'plugins-enabled');
  const dir = join(avail, 'marked');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(enabled, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'marked', main: './src/index.ts' }));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'marked', version: '1.0.0', hostApi: HOST_API }));
  writeFileSync(join(dir, 'src', 'index.ts'), `
    export default function build({ make, z, modelMaySet, modelMaySave, appliesOnRestart }) {
      globalThis.__markedGot = { modelMaySet, modelMaySave, appliesOnRestart };
      return make('marked', { configSchema: z.object({
        compact: z.boolean().register(modelMaySet, { reason: 'a display flag' }).optional(),
        token: z.string().optional(),
      }).optional() });
    }`);
  symlinkSync(dir, join(enabled, 'marked'));
  const repo = createPluginRepo({ availableDir: avail, enabledDir: enabled, projectRoot: root });
  const plugins = await loadPlugins({ config: {}, repo, enabledDir: enabled });
  expect((globalThis as Record<string, unknown>).__markedGot).toEqual({ modelMaySet, modelMaySave, appliesOnRestart });
  const schemas = pluginConfigs(plugins);
  expect(configMarks(hostConfigSchema, 'plugins.marked.compact', schemas).maySet).toEqual({ reason: 'a display flag' });
  expect(configMarks(hostConfigSchema, 'plugins.marked.token', schemas).maySet).toBeNull();
});

// A plugin whose tools are known only later sets them on its plugin object and calls
// `toolsChanged`, handed to its builder: the registry assembled at start reads them.
test('a builder gets toolsChanged: the groups it sets later reach the registry assembled at start', async () => {
  const { assembleToolRegistry } = await import('../tools');
  const root = mkdtempSync(join(tmpdir(), 'fa-later-'));
  const avail = join(root, 'plugins-available');
  const enabled = join(root, 'plugins-enabled');
  const dir = join(avail, 'later');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(enabled, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'later', main: './src/index.ts' }));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'later', version: '1.0.0', hostApi: HOST_API }));
  writeFileSync(join(dir, 'src', 'index.ts'), `
    export default function build({ make, toolsChanged }) {
      const plugin = make('later', { tools: [] });
      globalThis.__later = () => {
        plugin.tools = [{ id: 'later', tools: [{ type: 'function', function: { name: 'later_ping', description: 'Ping.', parameters: { type: 'object', properties: {} } } }], exec: async () => 'pong' }];
        toolsChanged();
      };
      return plugin;
    }`);
  symlinkSync(dir, join(enabled, 'later'));
  const repo = createPluginRepo({ availableDir: avail, enabledDir: enabled, projectRoot: root });
  const config = {};
  const plugins = await loadPlugins({ config, repo, enabledDir: enabled });
  const reg = assembleToolRegistry({ plugins, config, repo });
  expect(reg.tools.map((t) => t.function.name)).not.toContain('later_ping');
  ((globalThis as Record<string, unknown>).__later as () => void)();
  expect(reg.tools.map((t) => t.function.name)).toContain('later_ping');
});

// Writes an enabled plugin `name` whose builder body is `body` (it has `make` in scope).
function plugin(root: string, name: string, body: string) {
  const dir = join(root, 'plugins-available', name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(root, 'plugins-enabled'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, main: './src/index.ts' }));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name, version: '1.0.0', hostApi: HOST_API }));
  writeFileSync(join(dir, 'src', 'index.ts'), `export default async function build({ make }) { ${body} }`);
  symlinkSync(dir, join(root, 'plugins-enabled', name));
}

// One plugin waiting does not hold up the next: `slow` finishes only once `quick` has been
// built — loaded one after another, this would never end. The list keeps the order they
// are enabled in, whichever finished first.
test('enabled plugins load at once and join in the order they are enabled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fa-parallel-'));
  const g = globalThis as Record<string, unknown>;
  g.__quickBuilt = new Promise((r) => { g.__quickDone = r; });
  plugin(root, 'aslow', `await globalThis.__quickBuilt; return make('aslow', {});`);
  plugin(root, 'bquick', `globalThis.__quickDone(); return make('bquick', {});`);
  const enabled = join(root, 'plugins-enabled');
  const repo = { enabledPlugins: async () => ['aslow', 'bquick'] } as never;
  const plugins = await loadPlugins({ config: {}, repo, enabledDir: enabled });
  const names = plugins.map((p) => p.name);
  expect(names.indexOf('aslow')).toBeGreaterThan(-1);
  expect(names.indexOf('aslow')).toBeLessThan(names.indexOf('bquick'));
});

// `ready` — a plugin waiting on someone of its own: awaited by default (the one-shot
// prompt reads its tools once), only noted with `late` (the app draws without it).
test('a plugin\'s ready is waited for by default; with late it is starting until it settles', async () => {
  const { createLatePlugins } = await import('../late');
  const root = mkdtempSync(join(tmpdir(), 'fa-ready-'));
  const g = globalThis as Record<string, unknown>;
  plugin(root, 'waiter', `const p = make('waiter', {}); p.ready = new Promise((r) => { globalThis.__waiterReady = r; }); return p;`);
  const enabled = join(root, 'plugins-enabled');
  const repo = createPluginRepo({ availableDir: join(root, 'plugins-available'), enabledDir: enabled, projectRoot: root });

  let loaded = false;
  const waiting = loadPlugins({ config: {}, repo, enabledDir: enabled }).then((p) => { loaded = true; return p; });
  await Bun.sleep(20);
  expect(loaded).toBe(false);
  (g.__waiterReady as () => void)();
  expect((await waiting).some((p) => p.name === 'waiter')).toBe(true);

  const late = createLatePlugins();
  const events: unknown[] = [];
  late.listen((e) => events.push(e));
  const plugins = await loadPlugins({ config: {}, repo, enabledDir: enabled, late });
  expect(plugins.some((p) => p.name === 'waiter')).toBe(true);
  expect(late.starting()).toEqual(['waiter']);
  (g.__waiterReady as () => void)();
  await Bun.sleep(0);
  expect(late.starting()).toEqual([]);
  expect(events).toEqual([{ kind: 'ready', name: 'waiter' }]);
});

// A remote plugin with `late`: the loader returns before its handshake; the plugin joins
// when it completes, and a refused one is a skip, said in the loader's own words.
test('with late, a remote plugin is not waited for: it joins after its handshake, or is skipped', async () => {
  const { createLatePlugins } = await import('../late');
  const { fakeRemote } = await import('../../__tests__/helpers/remote-fake');
  for (const outcome of ['answer', 'refuse'] as const) {
    const fake = fakeRemote();
    fake.holdHello();
    const enabled = mkdtempSync(join(tmpdir(), 'fa-late-remote-'));
    mkdirSync(join(enabled, 'fake'));
    writeFileSync(join(enabled, 'fake', 'manifest.json'), JSON.stringify(fake.manifest));
    const repo = { enabledPlugins: async () => ['fake'], list: async () => [] } as never;
    const late = createLatePlugins();
    // What the transport says before the handshake (a process's stderr) is a line for the
    // app's log, never the console: the screen holds the console by then.
    const warned: unknown[] = [];
    const realWarn = console.warn;
    console.warn = (m: unknown) => { warned.push(m); };
    // Each round is a machine of its own: its first start trusts its plugin
    // (src/loader/trust.ts — one first start per record).
    const trust = { file: join(mkdtempSync(join(tmpdir(), 'fa-late-trust-')), 'plugins.trusted.json'), modelShell: false };
    const plugins = await loadPlugins({ config: {}, repo, enabledDir: enabled, late, trust, remoteTransport: (_m, _d, deps) => { deps.log('[fake] warming up'); return fake.transport; } }).finally(() => { console.warn = realWarn; });
    expect(warned).toEqual([]);
    expect(plugins.some((p) => p.name === 'fake')).toBe(false);
    expect(late.starting()).toEqual(['fake']);
    const events: Array<{ kind: string; plugin?: { name: string }; line?: string }> = [];
    late.listen((e) => events.push(e as never));
    if (outcome === 'answer') fake.answerHello(); else fake.refuseHello('nope');
    for (let i = 0; i < 50 && events.length < 2; i++) await Bun.sleep(2);
    expect(late.starting()).toEqual([]);
    expect(events[0]).toEqual({ kind: 'note', line: '[fake] warming up' });
    if (outcome === 'answer') expect(events.slice(1).map((e) => [e.kind, e.plugin?.name])).toEqual([['joined', 'fake']]);
    else expect(events.slice(1)).toEqual([{ kind: 'skipped', name: 'fake', line: '[plugins] skip fake: hello: nope', why: 'hello: nope' } as never]);
  }
});

test('a plugin that joins goes before the first plugin that comes after it in the enabled order', async () => {
  const { joinIndex } = await import('../late');
  const order = ['a', 'b', 'c'];
  const rank = (n: string) => { const i = order.indexOf(n); return i === -1 ? undefined : i; };
  const list = (...names: string[]) => names.map((name) => ({ name }));
  expect(joinIndex(list('core', 'a', 'c'), 'b', rank)).toBe(2);
  expect(joinIndex(list('core', 'c'), 'a', rank)).toBe(1);
  expect(joinIndex(list('core', 'a', 'b'), 'c', rank)).toBe(3);
  expect(joinIndex(list('core', 'a'), 'guest', rank)).toBe(2);
});
