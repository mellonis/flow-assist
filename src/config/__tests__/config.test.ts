import { expect, test } from 'bun:test';
import { hostConfigSchema } from '../schema';
import { z } from 'zod';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDeep, setDeep, unsetDeep, parseValue, validateConfigWriteValue, configWarnings, saveConfigSetting, saveConfigUnset, configDir, hostStateDir, loadConfig, acceptedConfigPath, configMarks } from '../load';
import { oldThemeKeys } from '../../playback/palette-config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('schema has NO tracker-only keys at direct level', () => {
  const shape = (hostConfigSchema as any).shape;
  expect(shape.boardCode).toBeUndefined();
  expect(shape.reportsDir).toBeUndefined();
  expect(shape.namespaceCodes).toBeUndefined();
});

test('ai uses assistantLanguage + disabledTools, not chatLanguage/tools/trackerLanguage', () => {
  // hostConfigSchema.shape.ai is a ZodOptional wrapper (zod v4); unwrap to read the object's shape.
  const ai = (hostConfigSchema.shape as any).ai.unwrap().shape;
  expect(ai.assistantLanguage).toBeTruthy();
  expect(ai.disabledTools).toBeTruthy();
  expect(ai.chatLanguage).toBeUndefined();
  expect(ai.tools).toBeUndefined();
  expect(ai.trackerLanguage).toBeUndefined();
});

test('config write validation rejects an unknown key and a bad type', () => {
  expect(validateConfigWriteValue(hostConfigSchema, 'cache.enabled', 'yes').ok).toBe(false);
  expect(validateConfigWriteValue(hostConfigSchema, 'cache.enabled', true).ok).toBe(true);
});

test('a mode typed at `theme` is pointed at `ui.theme`', () => {
  // `theme` is the person's own palette record; the appearance (`system`, `light`,
  // `dark`) is `ui.theme`. Someone who typed the first meant the second.
  const refused = validateConfigWriteValue(hostConfigSchema, 'theme', 'dark') as { ok: false; error: string };
  expect(refused.ok).toBe(false);
  expect(refused.error).toContain('ui.theme');
  // A real palette record still passes, and no other key's refusal carries the hint.
  expect(validateConfigWriteValue(hostConfigSchema, 'theme', { dark: { base: { bg: 'black' } } }).ok).toBe(true);
  const other = validateConfigWriteValue(hostConfigSchema, 'cache.enabled', 'yes') as { ok: false; error: string };
  expect(other.error).not.toContain('ui.theme');
});

test('project.instructionsCap takes a non-negative integer — and the model may not set it', () => {
  expect(validateConfigWriteValue(hostConfigSchema, 'project.instructionsCap', 8192)).toEqual({ ok: true, value: 8192 });
  expect(validateConfigWriteValue(hostConfigSchema, 'project.instructionsCap', 0)).toEqual({ ok: true, value: 0 });
  expect(validateConfigWriteValue(hostConfigSchema, 'project.instructionsCap', -1).ok).toBe(false);
  expect(validateConfigWriteValue(hostConfigSchema, 'project.instructionsCap', 'big').ok).toBe(false);
  expect(validateConfigWriteValue(hostConfigSchema, 'project.instructionsCap', 1.5).ok).toBe(false);
  // No mark on it: how big the instructions ride is the developer's editorial call —
  // and it applies live (no `restart`), since every read of the chain takes it.
  expect(configMarks(hostConfigSchema, 'project.instructionsCap')).toMatchObject({ maySet: null, maySave: null, restart: false });
});

test('config set ai.backgroundFollowUp takes a boolean — what the chat reads with `!== false`', () => {
  expect(validateConfigWriteValue(hostConfigSchema, 'ai.backgroundFollowUp', true)).toEqual({ ok: true, value: true });
  expect(validateConfigWriteValue(hostConfigSchema, 'ai.backgroundFollowUp', false)).toEqual({ ok: true, value: false });
  expect(validateConfigWriteValue(hostConfigSchema, 'ai.backgroundFollowUp', 'yes').ok).toBe(false);
});

test('config set ai.retryDelay takes 0 to 60 seconds', () => {
  expect(validateConfigWriteValue(hostConfigSchema, 'ai.retryDelay', 60).ok).toBe(true);
  expect(validateConfigWriteValue(hostConfigSchema, 'ai.retryDelay', 0.5).ok).toBe(true);
  expect(validateConfigWriteValue(hostConfigSchema, 'ai.retryDelay', 61).ok).toBe(false);
  expect(validateConfigWriteValue(hostConfigSchema, 'ai.retryDelay', -1).ok).toBe(false);
});

// The shell's roots are the host's own key; the legacy `fs.roots` is still accepted, so
// a config file that sets it is not refused.
test('shell.roots is a host key; a config that still sets fs.roots is accepted', () => {
  expect(validateConfigWriteValue(hostConfigSchema, 'shell.roots', ['/w'])).toEqual({ ok: true, value: ['/w'] });
  expect(validateConfigWriteValue(hostConfigSchema, 'shell.roots', '/w').ok).toBe(false);
  expect(validateConfigWriteValue(hostConfigSchema, 'fs.roots', ['/w']).ok).toBe(true);
  expect(hostConfigSchema.safeParse({ fs: { roots: ['/w'] }, shell: { roots: ['/x'], timeoutMs: 1000 } }).success).toBe(true);
});

test('getDeep/setDeep/unsetDeep walk dot paths', () => {
  const o = { a: { b: 1 } };
  setDeep(o, 'a.b', 2);
  expect(getDeep(o, 'a.b')).toBe(2);
  unsetDeep(o, 'a.b');
  expect(getDeep(o, 'a.b')).toBeUndefined();
});

test('parseValue understands booleans, numbers, arrays, comma lists', () => {
  expect(parseValue('true')).toBe(true);
  expect(parseValue('3')).toBe(3);
  expect(parseValue('[1,2]')).toEqual([1, 2]);
  expect(parseValue('a,b')).toEqual(['a', 'b']);
});

test('configWarnings flags an incomplete LLM and a schema type error, silent for a complete config', () => {
  const saved = process.env.LLM_TOKEN;
  try {
    // No ai config → one precondition warning (baseUrl/model/token missing). The base
    // schema is all-optional, so an empty config is schema-valid.
    expect(configWarnings({})).toHaveLength(1);
    // A malformed ai.baseUrl (number, not string) → a schema warning in addition.
    expect(configWarnings({ ai: { baseUrl: 123 } as unknown as Record<string, unknown> })).toHaveLength(2);
    // Complete LLM config + the token env present → silent.
    process.env.LLM_TOKEN = 't';
    expect(configWarnings({ ai: { baseUrl: 'b', model: 'm' } })).toEqual([]);
  } finally {
    if (saved === undefined) delete process.env.LLM_TOKEN;
    else process.env.LLM_TOKEN = saved;
  }
});
test('a first `config set` on a fresh machine creates the config directory and persists', () => {
  // Writing the file without creating its directory first would swallow the ENOENT
  // and have the CLI print the value as if it had been saved —
  // so the very first setup on any new machine would silently do nothing.
  const dir = join(mkdtempSync(join(tmpdir(), 'fa-cfg-')), 'not', 'there', 'yet');
  const file = join(dir, 'config.local.json');
  expect(saveConfigSetting('ai.model', 'm1', file)).toEqual({ ai: { model: 'm1' } });
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ai: { model: 'm1' } });
  expect(saveConfigSetting('ai.baseUrl', 'http://x', file)).toEqual({ ai: { model: 'm1', baseUrl: 'http://x' } });
  expect(saveConfigUnset('ai.model', file)).toEqual({ ai: { baseUrl: 'http://x' } });
  // A path that cannot be written is reported, not hidden.
  const blocked = join(file, 'a-file-is-not-a-directory', 'config.local.json');
  expect(saveConfigSetting('ai.model', 'm2', blocked)).toBeNull();
});

test('the config directory is a flow-assist folder under XDG_CONFIG_HOME, never XDG_CONFIG_HOME itself', () => {
  expect(configDir({ XDG_CONFIG_HOME: '/x/cfg' }, '/home/me')).toBe('/x/cfg/flow-assist');
  expect(configDir({}, '/home/me')).toBe('/home/me/.config/flow-assist');
  expect(configDir({ XDG_CONFIG_HOME: '' }, '/home/me')).toBe('/home/me/.config/flow-assist');
});

// A plugin's key is checked by the plugin's own schema — `config set`, `:config set`
// and the model's config tool all resolve `plugins.<name>.<key>` through it, so none
// of them disagree on which keys exist.
test('a plugin key is written through the plugin\'s schema', () => {
  const plugins = { keycaps: z.object({ enabled: z.boolean().optional() }).optional(), 'acme-tracker': z.object({ storyPointsField: z.string().optional() }).optional() };
  expect(validateConfigWriteValue(hostConfigSchema, 'plugins.keycaps.enabled', true, plugins)).toEqual({ ok: true, value: true });
  expect(validateConfigWriteValue(hostConfigSchema, 'plugins.acme-tracker.storyPointsField', 'SP', plugins)).toEqual({ ok: true, value: 'SP' });
  const wrong = validateConfigWriteValue(hostConfigSchema, 'plugins.keycaps.enabled', 'yes', plugins);
  expect(wrong.ok).toBe(false);
  const unknown = validateConfigWriteValue(hostConfigSchema, 'plugins.nope.x', 1, plugins);
  expect(unknown).toEqual({ ok: false, error: 'config: unknown key plugins.nope.x — the plugin «nope» is not loaded or declares no settings' });
  expect(validateConfigWriteValue(hostConfigSchema, 'plugins.keycaps.bogus', 1, plugins).ok).toBe(false);
});

test('where the chat is — its mode and its panel — is a setting `config set` writes', async () => {
  const { buildAssistantPlugin } = await import('../../plugins/assistant');
  const assistant = buildAssistantPlugin({ renders: {}, config: {}, make: ((_: string, shape: unknown) => shape) as never }) as { configSchema?: z.ZodTypeAny };
  const plugins = { assistant: assistant.configSchema! };
  expect(validateConfigWriteValue(hostConfigSchema, 'plugins.assistant.mode', 'window', plugins)).toEqual({ ok: true, value: 'window' });
  expect(validateConfigWriteValue(hostConfigSchema, 'plugins.assistant.mode', 'sideways', plugins).ok).toBe(false);
  expect(validateConfigWriteValue(hostConfigSchema, 'plugins.assistant.panel.side', 'bottom', plugins)).toEqual({ ok: true, value: 'bottom' });
  expect(validateConfigWriteValue(hostConfigSchema, 'plugins.assistant.panel.size', 40, plugins)).toEqual({ ok: true, value: 40 });
  expect(validateConfigWriteValue(hostConfigSchema, 'plugins.assistant.panel.size', 95, plugins).ok).toBe(false);
  // The key a config written before the modes still has: read as `mode: full`.
  expect(validateConfigWriteValue(hostConfigSchema, 'plugins.assistant.fullscreen', true, plugins)).toEqual({ ok: true, value: true });
  expect(validateConfigWriteValue(hostConfigSchema, 'plugins.assistant.fullscreen', 'yes', plugins).ok).toBe(false);
});

// "A test never reaches the person's own files": under `bun test` the settings are read
// from the run's own directory (`hostStateDir`), exactly where `config set` writes them,
// and never from the config directory — the person's `config.json` and
// `config.local.json` there never reach a test.
test('under bun test the config is read from the run\'s own directory, never from the config directory', () => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-xdg-'));
  const was = process.env.XDG_CONFIG_HOME;
  const own = hostStateDir();
  const files = ['config.json', 'config.local.json'].map((n) => path.join(own, n));
  const kept = files.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null));
  try {
    // What the person's own directory would hold, where configDir() points.
    process.env.XDG_CONFIG_HOME = xdg;
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(path.join(configDir(), 'config.json'), JSON.stringify({ personBase: 'theirs' }));
    fs.writeFileSync(path.join(configDir(), 'config.local.json'), JSON.stringify({ personLocal: 'theirs' }));
    fs.writeFileSync(files[0]!, JSON.stringify({ runBase: 'ours' }));
    fs.writeFileSync(files[1]!, JSON.stringify({ runLocal: 'ours' }));
    // A first start: no accepted record yet, so the files are taken as they are.
    fs.rmSync(acceptedConfigPath(), { force: true });
    const read = loadConfig();
    expect(read.personBase).toBeUndefined();
    expect(read.personLocal).toBeUndefined();
    expect(read.runBase).toBe('ours');
    expect(read.runLocal).toBe('ours');
  } finally {
    if (was === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = was;
    files.forEach((f, i) => (kept[i] === null ? fs.rmSync(f, { force: true }) : fs.writeFileSync(f, kept[i]!)));
    fs.rmSync(acceptedConfigPath(), { force: true });
  }
});

test('a config in the old theme shape loads whole, warns of nothing, and refuses a write', () => {
  const file = path.join(hostStateDir(), 'config.json');
  const kept = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const old = { theme: { modals: { bg: 'black' }, selected: 'green' }, plugins: { chat: { colors: { userBg: '#232323' } } } };
  try {
    fs.writeFileSync(file, JSON.stringify(old));
    const read = loadConfig({ session: false });
    expect(read.theme).toEqual(old.theme);
    expect(oldThemeKeys(read)).toEqual(['theme.modals', 'theme.selected', 'plugins.chat.colors']);
    expect(configWarnings(read).filter((w) => w.includes('theme'))).toEqual([]);
    expect(validateConfigWriteValue(hostConfigSchema, 'theme.modals', { bg: 'black' }).ok).toBe(false);
  } finally {
    if (kept === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, kept);
  }
});
