import { expect, test } from 'bun:test';
import { hostConfigSchema } from '../schema';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDeep, setDeep, unsetDeep, parseValue, validateConfigWriteValue, configWarnings, saveConfigSetting, saveConfigUnset, configDir } from '../load';

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
  // The regression: the file was written without creating its directory, the
  // ENOENT was swallowed, and the CLI printed the value as if it had been saved —
  // so the very first setup on any new machine silently did nothing.
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
