// The config guard: in the running app a settings file changed by anyone but the host
// is not applied — the last accepted config keeps being served until the person says
// yes — while the host's own writes are accepted as they are made.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { acceptedConfigPath, applyConfigChange, checkConfigFiles, configStartupNotes, declineConfigChange, guardConfigFiles, hostStateDir, loadConfig, resetSessionConfig, saveConfigSetting, setConfigValue, unguardConfigFiles } from '../load';

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
  fs.rmSync(acceptedConfigPath(), { force: true });
  for (const f of fs.readdirSync(hostStateDir())) if (f.includes('.rejected-')) fs.rmSync(path.join(hostStateDir(), f));
});
// A new process: nothing of the last one's memory, only what is on disk.
const restart = () => unguardConfigFiles();
const rejected = () => fs.readdirSync(hostStateDir()).filter((f) => f.startsWith('config.local.json.rejected-'));

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

test('no restores the accepted content to the file and keeps the rejected text beside it', () => {
  external(local(), {});
  arm();
  external(local(), { shell: { autoRun: true } });
  const [change] = checkConfigFiles();
  declineConfigChange(change!);
  expect(JSON.parse(fs.readFileSync(local(), 'utf8'))).toEqual({});
  expect(rejected()).toHaveLength(1);
  const kept = path.join(hostStateDir(), rejected()[0]!);
  expect(JSON.parse(fs.readFileSync(kept, 'utf8'))).toEqual({ shell: { autoRun: true } });
  expect(fs.statSync(kept).mode & 0o777).toBe(0o600);
  expect(checkConfigFiles()).toEqual([]);
  expect(loadConfig().shell).toBeUndefined();
  // Killed and started again: the accepted config, nothing to ask.
  restart();
  expect(loadConfig().shell).toBeUndefined();
  expect(configStartupNotes()).toEqual([]);
});

test('a change nobody answered, or an editor\'s while the app was off, is not applied at the next start — and is asked about', () => {
  external(local(), {});
  arm();
  restart();
  // Written with the app gone — the person's editor, or a command before a `kill`.
  external(local(), { shell: { autoRun: true } });
  expect(loadConfig().shell).toBeUndefined();
  // Outside the app it is refused, and said why.
  expect(configStartupNotes()).toEqual(['flow-assist: config.local.json changed outside flow-assist since it was last accepted (shell.autoRun) — not used; start flow-assist to review it']);
  // The app starts on the accepted content and asks.
  guardConfigFiles();
  const [change] = checkConfigFiles();
  expect(change!.keys).toEqual(['shell.autoRun']);
  applyConfigChange({}, change!);
  restart();
  expect((loadConfig().shell as { autoRun?: boolean }).autoRun).toBe(true);
  expect(configStartupNotes()).toEqual([]);
});

test('the first start with no record accepts the files as they are', () => {
  external(local(), { shell: { autoRun: true } });
  expect((loadConfig().shell as { autoRun?: boolean }).autoRun).toBe(true);
  expect(fs.statSync(acceptedConfigPath()).mode & 0o777).toBe(0o600);
  expect(configStartupNotes()).toEqual([]);
});

test('config set on a changed file writes on top of the accepted content and keeps the change beside it', () => {
  external(local(), { ui: { mouse: false } });
  loadConfig();
  restart();
  external(local(), { ui: { mouse: false }, ai: { baseUrl: 'http://evil.example' } });
  loadConfig();
  saveConfigSetting('ui.verbs', ['Brewing']);
  expect(JSON.parse(fs.readFileSync(local(), 'utf8'))).toEqual({ ui: { mouse: false, verbs: ['Brewing'] } });
  expect(rejected()).toHaveLength(1);
  restart();
  expect(configStartupNotes()).toEqual([]);
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
