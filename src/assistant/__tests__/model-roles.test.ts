import { describe, expect, test } from 'bun:test';
import { baseModel, modelChoice, modelRows, modelWindow, roleModel, roleStart } from '../model-roles.ts';
import { withModel, llmOpts } from '../llm-endpoint.ts';
import { DEFAULT_CONTEXT_WINDOW } from '../context-meter.ts';
import { hostConfigSchema } from '../../config/schema.ts';

const ai = { model: 'default-model', roles: { fast: 'small-model' }, models: { 'small-model': { contextWindow: 256_000 }, 'big-model': { contextWindow: 512_000 } }, contextWindow: 300_000 };

describe('roles', () => {
  test('a role is the model id ai.roles names for it', () => {
    expect(roleModel(ai, 'fast')).toBe('small-model');
    expect(roleModel(ai, '  fast  ')).toBe('small-model');
  });
  test('a role nothing defines has no model', () => {
    expect(roleModel(ai, 'deep')).toBeUndefined();
    expect(roleModel(ai, '')).toBeUndefined();
    expect(roleModel(ai, '   ')).toBeUndefined();
    expect(roleModel(ai, 42)).toBeUndefined();
    expect(roleModel(ai, undefined)).toBeUndefined();
  });
  test('ai.model is a model id, never read as a role', () => {
    expect(baseModel({ model: 'fast', roles: { fast: 'small-model' } })).toBe('fast');
    expect(baseModel({})).toBeUndefined();
  });
  test('a start that asks for a role gets the model, or one note', () => {
    expect(roleStart(ai, 'fast')).toEqual({ model: 'small-model' });
    expect(roleStart(ai, 'deep')).toEqual({ note: 'role "deep" is not defined (ai.roles) — using the conversation\'s model' });
    expect(roleStart(ai, '')).toEqual({});
  });
});

// The names `/model` offers: the reset, then the roles, then the catalogue's own ids.
const catalogue = {
  model: 'default-model',
  roles: { fast: 'small-model', deep: 'big-model' },
  models: { 'small-model': { contextWindow: 256_000 }, 'big-model': { contextWindow: 512_000 }, 'other-model': { contextWindow: 128_000 } },
  contextWindow: 300_000,
};

describe('the chooser', () => {
  test('a name from the config is the model it runs', () => {
    expect(modelChoice(catalogue, 'fast')).toEqual({ model: 'small-model' });
    expect(modelChoice(catalogue, '  deep  ')).toEqual({ model: 'big-model' });
    expect(modelChoice(catalogue, 'other-model')).toEqual({ model: 'other-model' });
  });
  test('default is the reset: no model of the session\'s own', () => {
    expect(modelChoice(catalogue, 'default')).toEqual({ model: null });
  });
  test('a name neither a role nor a catalogue id is refused, and the list named', () => {
    expect(modelChoice(catalogue, 'nope')).toEqual({ error: 'no model or role "nope" here (/model lists them)' });
    expect(modelChoice(catalogue, 'unlisted-model')).toEqual({ error: 'no model or role "unlisted-model" here (/model lists them)' });
  });
  test('a role wins over a catalogue id of the same name', () => {
    const clash = { model: 'default-model', roles: { deep: 'big-model' }, models: { deep: { contextWindow: 128_000 }, 'big-model': { contextWindow: 512_000 } } };
    expect(modelChoice(clash, 'deep')).toEqual({ model: 'big-model' });
    expect(modelRows(clash).filter((r) => r.name === 'deep')).toEqual([{ name: 'deep', model: 'big-model', label: 'deep → big-model', window: 512_000 }]);
  });
  test('the chooser accepts the rows and nothing else', () => {
    const names = modelRows(catalogue).map((r) => r.name);
    for (const n of names) expect('model' in modelChoice(catalogue, n)).toBe(true);
    expect(modelChoice(catalogue, 'fast → small-model')).toEqual({ error: 'no model or role "fast → small-model" here (/model lists them)' });
  });
});

describe('the rows', () => {
  test('default first, then the roles, then the ids no role names', () => {
    expect(modelRows(catalogue).map((r) => r.name)).toEqual(['default', 'fast', 'deep', 'other-model']);
    expect(modelRows(catalogue)[0]).toEqual({ name: 'default', model: null, label: 'default (default-model)', window: 300_000 });
  });
  test('each row carries the window the conversation would measure against', () => {
    const rows = modelRows(catalogue);
    expect(rows.find((r) => r.name === 'fast')?.window).toBe(256_000);
    expect(rows.find((r) => r.name === 'deep')?.window).toBe(512_000);
    expect(rows.find((r) => r.name === 'other-model')?.window).toBe(128_000);
  });
  test('an id is listed only when ai.models names it', () => {
    expect(modelRows(catalogue).some((r) => r.name === 'unlisted-model')).toBe(false);
    const withIt = { ...catalogue, models: { ...catalogue.models, 'unlisted-model': {} } };
    expect(modelRows(withIt).at(-1)).toEqual({ name: 'unlisted-model', model: 'unlisted-model', label: 'unlisted-model', window: 300_000 });
  });
  test('a role\'s id is listed once, as the role\'s row', () => {
    expect(modelRows(catalogue).map((r) => r.name).filter((n) => n === 'fast')).toHaveLength(1);
    expect(modelRows(catalogue).some((r) => r.label === 'small-model')).toBe(false);
  });
  test('the labels read the reset, a role\'s target and a bare id', () => {
    const labels = Object.fromEntries(modelRows(catalogue).map((r) => [r.name, r.label]));
    expect(labels.default).toBe('default (default-model)');
    expect(labels.deep).toBe('deep → big-model');
    expect(labels['other-model']).toBe('other-model');
  });
  test('with no ai.model the reset names no model', () => {
    expect(modelRows({ roles: { fast: 'small-model' } })[0]).toEqual({ name: 'default', model: null, label: 'default', window: DEFAULT_CONTEXT_WINDOW });
  });
});

describe('the window', () => {
  test('a model in the catalogue has its own', () => {
    expect(modelWindow(ai, 'big-model')).toBe(512_000);
    expect(modelWindow(ai, 'small-model')).toBe(256_000);
  });
  test('a model the catalogue does not name falls back to ai.contextWindow', () => {
    expect(modelWindow(ai, 'unlisted-model')).toBe(300_000);
    expect(modelWindow(ai, undefined)).toBe(300_000);
  });
  test('with neither, 200k — and a nonsense value is no value', () => {
    expect(modelWindow({}, undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(modelWindow({ models: { x: { contextWindow: 0 } }, contextWindow: -1 }, 'x')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(modelWindow({ models: { x: { contextWindow: 0.5 } }, contextWindow: -1 }, 'x')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(modelWindow({ models: { x: { contextWindow: 1.5 } }, contextWindow: -1 }, 'x')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(modelWindow({ contextWindow: 0.5 }, undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(modelWindow({ contextWindow: true }, undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(modelWindow({ contextWindow: '250000' }, undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

describe('withModel', () => {
  test('a conversation on its own model overrides ai.model, and nothing else', () => {
    const base = llmOpts({ model: 'default-model', maxTokens: 4096 });
    expect(withModel(base, 'small-model')).toMatchObject({ model: 'small-model', maxTokens: 4096 });
    expect(withModel(base, 'small-model').provider).toBe(base.provider);
  });
  test('no model of its own leaves the options as they are', () => {
    const base = llmOpts({ model: 'default-model' });
    expect(withModel(base, undefined)).toBe(base);
    expect(withModel(base, '   ')).toBe(base);
  });
});

describe('the schema', () => {
  test('takes the catalogue and the roles', () => {
    const parsed = hostConfigSchema.parse({ ai: { models: { 'big-model': { contextWindow: 512_000 } }, roles: { fast: 'small-model' } } });
    expect(parsed.ai?.models).toEqual({ 'big-model': { contextWindow: 512_000 } });
    expect(parsed.ai?.roles).toEqual({ fast: 'small-model' });
  });
  test('refuses a window that is not a positive integer', () => {
    expect(hostConfigSchema.safeParse({ ai: { models: { 'big-model': { contextWindow: 0 } } } }).success).toBe(false);
    expect(hostConfigSchema.safeParse({ ai: { models: { 'big-model': { contextWindow: 1.5 } } } }).success).toBe(false);
  });
});
