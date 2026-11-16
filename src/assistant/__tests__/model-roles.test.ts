import { describe, expect, test } from 'bun:test';
import { baseModel, modelWindow, roleModel, roleStart } from '../model-roles.ts';
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
