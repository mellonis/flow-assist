// The session scope: `config set --session` lays a value over the files for this run
// only. It is one map laid over what `loadConfig()` merges, so every reader sees it;
// it never reaches a file; a new run (a restart) starts without it; and `config get`
// says where a value comes from.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSource, configValue, loadConfig, resetSessionConfig, setConfigValue, unsetConfigValue, getDeep } from '../load';

afterEach(() => resetSessionConfig());

const tempLocal = (content?: Record<string, unknown>): string => {
  const file = join(mkdtempSync(join(tmpdir(), 'fa-session-')), 'config.local.json');
  if (content) writeFileSync(file, JSON.stringify(content, null, 2));
  return file;
};

test('a session value changes what loadConfig() answers, and leaves the file untouched', () => {
  const file = tempLocal({ ui: { mouse: true } });
  const before = readFileSync(file, 'utf8');
  const live = loadConfig({ localPath: file });
  const res = setConfigValue(live, 'ui.verbs', ['Thinking'], { scope: 'session', filePath: file });
  expect(res).toMatchObject({ ok: true, value: ['Thinking'] });
  // The object the app reads is laid over in place…
  expect(getDeep(live, 'ui.verbs')).toEqual(['Thinking']);
  // …and so is every later load: one map over the merged result.
  expect(getDeep(loadConfig({ localPath: file }), 'ui.verbs')).toEqual(['Thinking']);
  expect(getDeep(loadConfig({ localPath: file }), 'ui.mouse')).toBe(true);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(configSource(live, 'ui.verbs')).toBe('session');
  expect(configSource(live, 'ui.mouse')).toBe('local');
});

test('a restart loses the session value', () => {
  const file = tempLocal();
  setConfigValue(loadConfig({ localPath: file }), 'ui.verbs', ['Brewing'], { scope: 'session', filePath: file });
  // A new process starts with an empty session — the app resets it as it starts.
  resetSessionConfig();
  const next = loadConfig({ localPath: file });
  expect(getDeep(next, 'ui.verbs')).not.toEqual(['Brewing']);
  expect(existsSync(file)).toBe(false);
});

test('config get names the source: session, local, config or default', () => {
  const file = tempLocal({ sessions: { keep: 7 } });
  const cfg = loadConfig({ localPath: file });
  expect(configSource(cfg, 'sessions.keep')).toBe('local');
  expect(configSource(cfg, 'zz.nothing')).toBe('default');
  setConfigValue(cfg, 'sessions.keep', 3, { scope: 'session', filePath: file });
  expect(configSource(cfg, 'sessions.keep')).toBe('session');
  // A key under a session value, or holding one, comes from the session too.
  expect(setConfigValue(cfg, 'ai.thinking', { adaptive: true }, { scope: 'session', filePath: file }).ok).toBe(true);
  expect(configSource(cfg, 'ai.thinking.adaptive')).toBe('session');
  expect(configSource(cfg, 'ai')).toBe('session');
  // A config the caller built itself (a test's) has no files behind it: what it holds
  // reads as `config`.
  const own = { ai: { model: 'm' } };
  expect(configSource(own, 'ai.model')).toBe('config');
  expect(configSource(own, 'ai.baseUrl')).toBe('default');
});

test('a saved value goes to the file, is live at once, and takes over from a session value', () => {
  const file = tempLocal();
  const live = loadConfig({ localPath: file });
  setConfigValue(live, 'ui.verbs', ['Session'], { scope: 'session', filePath: file });
  const res = setConfigValue(live, 'ui.verbs', ['Saved'], { scope: 'saved', filePath: file });
  expect(res).toMatchObject({ ok: true, value: ['Saved'] });
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ui: { verbs: ['Saved'] } });
  expect(getDeep(live, 'ui.verbs')).toEqual(['Saved']);
  expect(configSource(live, 'ui.verbs')).toBe('local');
  expect(getDeep(loadConfig({ localPath: file }), 'ui.verbs')).toEqual(['Saved']);
});

test('a value the schema refuses changes nothing, in either scope', () => {
  const file = tempLocal();
  const live = loadConfig({ localPath: file });
  for (const scope of ['session', 'saved'] as const) {
    const res = setConfigValue(live, 'ui.mouse', 'sometimes', { scope, filePath: file });
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toMatch(/ui\.mouse — expected true\|false/);
  }
  expect(getDeep(live, 'ui.mouse')).not.toBe('sometimes');
  expect(existsSync(file)).toBe(false);
  expect(setConfigValue(live, 'nope.nothing', 1, { scope: 'session', filePath: file })).toEqual({ ok: false, error: 'config: unknown key nope.nothing' });
});

test('the resolved theme the app holds is never overwritten under it', () => {
  // The app resolves `theme` into the palette every renderer reads; a value laid over
  // it would leave a partial palette. It is written, and read at the next start.
  const file = tempLocal();
  const palette = { modals: { chat: { accent: 'cyan' } } };
  const live: Record<string, unknown> = { theme: palette };
  const res = setConfigValue(live, 'theme', { accent: 'red' }, { scope: 'session', filePath: file });
  expect(res.ok).toBe(true);
  expect(live.theme).toBe(palette);
  expect(getDeep(loadConfig({ localPath: file }), 'theme')).toEqual({ accent: 'red' });
});

test('a key read only at start is reported so, in both scopes', () => {
  const file = tempLocal();
  const live = loadConfig({ localPath: file });
  expect(setConfigValue(live, 'ui.mouse', false, { scope: 'session', filePath: file })).toMatchObject({ ok: true, restart: true });
  expect(setConfigValue(live, 'ui.mouse', false, { scope: 'saved', filePath: file })).toMatchObject({ ok: true, restart: true });
  expect(setConfigValue(live, 'ui.verbs', ['a'], { scope: 'session', filePath: file })).toMatchObject({ ok: true, restart: false });
});

// The model's endpoint changes together or not at all: laid on a running app one key at
// a time, the next request would carry the old token to a new host. So the endpoint and
// the tool list wait for the next start, and say so.
test('the endpoint and the tool list are never laid on the running app, and say restart', () => {
  const file = tempLocal();
  const live: Record<string, unknown> = { ai: { baseUrl: 'https://mine.example', tokenEnv: 'MY_TOKEN', provider: 'openai', disabledTools: [] } };
  for (const [key, value] of [['ai.baseUrl', 'https://other.example'], ['ai.tokenEnv', 'OTHER'], ['ai.provider', 'anthropic'], ['ai.disabledTools', ['shell']]] as const) {
    expect(setConfigValue(live, key, value, { scope: 'saved', filePath: file })).toMatchObject({ ok: true, restart: true });
    // What `config get` answers is what the next start reads.
    expect(configValue(live, key)).toEqual(value);
    expect(configSource(live, key)).toBe('local');
  }
  expect(live.ai).toEqual({ baseUrl: 'https://mine.example', tokenEnv: 'MY_TOKEN', provider: 'openai', disabledTools: [] });
  // `ai.model` is read per request and harmless: live at once.
  expect(setConfigValue(live, 'ai.model', 'm2', { scope: 'saved', filePath: file })).toMatchObject({ ok: true, restart: false });
  expect(getDeep(live, 'ai.model')).toBe('m2');
});

test('unset is the reverse of set: the session value, the saved one, and the live fallback', () => {
  const file = tempLocal({ ui: { verbs: ['Saved'] } });
  const live = loadConfig({ localPath: file });
  setConfigValue(live, 'ui.verbs', ['Session'], { scope: 'session', filePath: file });
  // --session drops only this run's value: the saved one is back, live at once.
  expect(unsetConfigValue(live, 'ui.verbs', { scope: 'session', filePath: file })).toMatchObject({ ok: true, value: ['Saved'], restart: false });
  expect(getDeep(live, 'ui.verbs')).toEqual(['Saved']);
  expect(configSource(live, 'ui.verbs')).toBe('local');
  // Without it, the saved value goes too — and a session value with it.
  setConfigValue(live, 'ui.verbs', ['Session'], { scope: 'session', filePath: file });
  const res = unsetConfigValue(live, 'ui.verbs', { scope: 'saved', filePath: file });
  expect(res.ok).toBe(true);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ui: {} });
  expect(configSource(live, 'ui.verbs')).not.toBe('session');
  expect(configSource(live, 'ui.verbs')).not.toBe('local');
  expect(getDeep(live, 'ui.verbs')).toEqual(configValue(live, 'ui.verbs'));
  expect(getDeep(loadConfig({ localPath: file }), 'ui.verbs')).toEqual(configValue(live, 'ui.verbs'));
});

test('a config built by hand falls back to what it held before the first write', () => {
  const file = tempLocal();
  const live: Record<string, unknown> = { ui: { verbs: ['Own'] } };
  setConfigValue(live, 'ui.verbs', ['Session'], { scope: 'session', filePath: file });
  expect(unsetConfigValue(live, 'ui.verbs', { scope: 'session', filePath: file })).toMatchObject({ ok: true, value: ['Own'] });
  expect(getDeep(live, 'ui.verbs')).toEqual(['Own']);
  expect(configSource(live, 'ui.verbs')).toBe('config');
  setConfigValue(live, 'ui.mouse', false, { scope: 'saved', filePath: file });
  // A key read at start is not touched on the running app by an unset either.
  expect(unsetConfigValue(live, 'ui.mouse', { scope: 'saved', filePath: file })).toMatchObject({ ok: true, restart: true });
  expect(getDeep(live, 'ui.mouse')).toBeUndefined();
  expect(configSource(live, 'ui.mouse')).toBe('default');
});

test('an array edit writes the files\' value back, never a session value', async () => {
  const { editConfigArray } = await import('../load');
  const file = tempLocal();
  setConfigValue(loadConfig({ localPath: file }), 'ui.verbs', ['Session'], { scope: 'session', filePath: file });
  // editConfigArray reads the person's own files; only what it pushed may be new.
  const res = editConfigArray('ui.verbs', 'push', { value: 'Pushed' }, undefined, file);
  expect(res.ok).toBe(true);
  expect(JSON.stringify(JSON.parse(readFileSync(file, 'utf8')))).not.toContain('Session');
});
