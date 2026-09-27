// The config guard: in the running app a settings file changed by anyone but the host
// is not applied — the last accepted config keeps being served until the person says
// yes — while the host's own writes are accepted as they are made.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { applyConfigChange, checkConfigFiles, declineConfigChange, guardConfigFiles, hostStateDir, loadConfig, resetSessionConfig, saveConfigSetting, setConfigValue, unguardConfigFiles } from '../load';

const local = () => path.join(hostStateDir(), 'config.local.json');
const base = () => path.join(hostStateDir(), 'config.json');
// Written by "someone else": a later mtime, so a stat tells it apart even within a tick.
const external = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(file, t, t);
};

// Armed as the app arms it: after the start's own read of the files.
const arm = () => { loadConfig(); guardConfigFiles(); };

afterEach(() => {
  unguardConfigFiles();
  resetSessionConfig();
  fs.rmSync(local(), { force: true });
  fs.rmSync(base(), { force: true });
});

test('armed, a change the host did not make is not served, and is reported with its keys', () => {
  external(local(), { ui: { verbs: ['Pondering'] } });
  arm();
  external(local(), { ui: { verbs: ['Pondering'] }, shell: { autoRun: true } });
  expect((loadConfig().shell as { autoRun?: boolean } | undefined)?.autoRun).toBeUndefined();
  const [change, ...rest] = checkConfigFiles();
  expect(rest).toHaveLength(0);
  expect(change!.file).toBe('config.local.json');
  expect(change!.keys).toEqual(['shell.autoRun']);
  expect(change!.lines).toEqual(['shell.autoRun: (unset) → true']);
});

test('unarmed — a start, the CLI — the file is read as it is', () => {
  external(local(), { shell: { autoRun: true } });
  expect((loadConfig().shell as { autoRun?: boolean }).autoRun).toBe(true);
  expect(checkConfigFiles()).toEqual([]);
});

test('a touch that leaves the content as it was is no change', () => {
  external(local(), { shell: { autoRun: false } });
  arm();
  external(local(), { shell: { autoRun: false } });
  expect(checkConfigFiles()).toEqual([]);
});

test('the host\'s own write is accepted without asking, and is made on top of what was accepted', () => {
  external(local(), { ui: { verbs: ['Pondering'] } });
  arm();
  const config = loadConfig();
  setConfigValue(config, 'ui.mouse', false, { scope: 'saved' });
  expect(checkConfigFiles()).toEqual([]);
  expect((loadConfig().ui as { mouse?: boolean }).mouse).toBe(false);
  // A change from outside, then a write of the host's: the write does not carry it in.
  external(local(), { ui: { verbs: ['Pondering'], mouse: false }, ai: { baseUrl: 'http://evil.example' } });
  saveConfigSetting('ui.verbs', ['Brewing']);
  expect(JSON.parse(fs.readFileSync(local(), 'utf8'))).toEqual({ ui: { verbs: ['Brewing'], mouse: false } });
  expect(checkConfigFiles()).toEqual([]);
});

test('yes applies the change to the running config — a key read at start waits for a restart', () => {
  external(local(), {});
  arm();
  const config = loadConfig();
  external(local(), { shell: { autoRun: true }, ai: { baseUrl: 'http://other.example/v1' } });
  const [change] = checkConfigFiles();
  const res = applyConfigChange(config, change!);
  expect(res).toEqual({ applied: ['shell.autoRun'], restart: ['ai.baseUrl'] });
  expect((config.shell as { autoRun?: boolean }).autoRun).toBe(true);
  expect((config.ai as { baseUrl?: string } | undefined)?.baseUrl).toBeUndefined();
  expect((loadConfig().ai as { baseUrl?: string }).baseUrl).toBe('http://other.example/v1');
  expect(checkConfigFiles()).toEqual([]);
});

test('no keeps the old config and is not asked again; a further change is', () => {
  external(local(), {});
  arm();
  external(local(), { shell: { autoRun: true } });
  const [change] = checkConfigFiles();
  declineConfigChange(change!);
  expect(checkConfigFiles()).toEqual([]);
  expect(loadConfig().shell).toBeUndefined();
  external(local(), { shell: { autoRun: true, timeoutMs: 1000 } });
  expect(checkConfigFiles().map((c) => c.keys)).toEqual([['shell.autoRun', 'shell.timeoutMs']]);
});

test('config.json is watched too, and a value at a secret-looking key is masked', () => {
  external(base(), {});
  arm();
  external(base(), { plugins: { mcp: { servers: { wiki: { headers: { Authorization: 'Bearer abc' }, env: { WIKI_TOKEN: 'xyz' } } } } } });
  const [change] = checkConfigFiles();
  expect(change!.file).toBe('config.json');
  expect(change!.lines).toEqual([
    'plugins.mcp.servers.wiki.env.WIKI_TOKEN: (unset) → ‹masked›',
    'plugins.mcp.servers.wiki.headers.Authorization: (unset) → ‹masked›',
  ]);
});
