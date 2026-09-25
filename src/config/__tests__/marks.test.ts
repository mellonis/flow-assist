// Which keys the model may change: two marks on the schema node (`modelMaySet`,
// `modelMaySave`), never under the model's own leash, seen through every zod wrapper,
// and a plugin marks its own keys the same way.
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { appliesOnRestart, hostConfigSchema, isLeashKey, modelMaySave, modelMaySet } from '../schema';
import { configMarks } from '../load';

// Every node of a schema with its dot path, each wrapper layer included — the way a
// mark could hide from a walk that only looked at the outer layer.
function nodes(schema: unknown, path = ''): { path: string; node: any }[] {
  const out: { path: string; node: any }[] = [];
  let cur = schema as any;
  while (cur) {
    out.push({ path, node: cur });
    if (cur.type === 'optional' || cur.type === 'nullable' || cur.type === 'default') { cur = cur.unwrap(); continue; }
    break;
  }
  if (cur?.shape) for (const [k, v] of Object.entries(cur.shape)) out.push(...nodes(v, path ? `${path}.${k}` : k));
  else if (cur?.type === 'record') out.push(...nodes(cur.valueType, path ? `${path}.*` : '*'));
  else if (cur?.type === 'array') out.push(...nodes(cur.element, path));
  return out;
}

const builtinSchemas = async () => {
  const { buildAssistantPlugin } = await import('../../plugins/assistant');
  const { buildKeycapsPlugin } = await import('../../plugins/keycaps');
  const make = ((_: string, shape: unknown) => shape) as never;
  const assistant = buildAssistantPlugin({ renders: {}, config: {}, make, z } as never) as { configSchema: unknown };
  const keycaps = buildKeycapsPlugin({ renders: {}, config: {}, make, z } as never) as { configSchema: unknown };
  return { assistant: assistant.configSchema, keycaps: keycaps.configSchema };
};

test('the host schema carries no mark under the model\'s leash, and may-save is always may-set', async () => {
  const all = [
    ...nodes(hostConfigSchema),
    ...Object.entries(await builtinSchemas()).flatMap(([name, s]) => nodes(s, `plugins.${name}`)),
  ];
  const marked = all.filter(({ node }) => modelMaySet.has(node) || modelMaySave.has(node));
  expect(marked.length).toBeGreaterThan(0);
  for (const { path } of marked) expect({ path, leash: isLeashKey(path) }).toEqual({ path, leash: false });
  // A save mark on a node without the set mark would be a key the model may write to
  // the file but not for the session — the narrower change refused, the wider allowed.
  const savedPaths = new Set(all.filter(({ node }) => modelMaySave.has(node)).map(({ path }) => path));
  const setPaths = new Set(all.filter(({ node }) => modelMaySet.has(node)).map(({ path }) => path));
  for (const p of savedPaths) expect({ p, set: setPaths.has(p) }).toEqual({ p, set: true });
});

test('the leash: ai, shell, web, the legacy fs roots, a plugin\'s roots — and every key holding one', () => {
  for (const key of ['ai', 'ai.disabledTools', 'ai.baseUrl', 'ai.tokenEnv', 'shell.roots', 'shell', 'web.allowlist', 'fs.roots', 'plugins.repo.roots', 'plugins.repo.roots.0', 'plugins.repo', 'plugins']) {
    expect({ key, leash: isLeashKey(key) }).toEqual({ key, leash: true });
  }
  for (const key of ['ui.verbs', 'ui.mouse', 'sessions.resume', 'plugins.assistant.mode', 'plugins.repo.rootsNote']) {
    expect({ key, leash: isLeashKey(key) }).toEqual({ key, leash: false });
  }
});

test('the host\'s own marks: what the model may set, save, and what waits for a restart', async () => {
  const plugins = await builtinSchemas();
  const marks = (key: string) => {
    const m = configMarks(hostConfigSchema, key, plugins);
    return { set: !!m.maySet, save: !!m.maySave, restart: m.restart };
  };
  expect(marks('ui.verbs')).toEqual({ set: true, save: true, restart: false });
  expect(marks('ui.mouse')).toEqual({ set: true, save: true, restart: true });
  expect(marks('sessions.resume')).toEqual({ set: true, save: true, restart: true });
  expect(marks('plugins.assistant.mode')).toEqual({ set: true, save: true, restart: true });
  expect(marks('plugins.assistant.panel.side')).toEqual({ set: true, save: true, restart: false });
  expect(marks('plugins.keycaps.enabled')).toEqual({ set: true, save: true, restart: true });
  // Unmarked: the default is read-only.
  expect(marks('ai.model')).toEqual({ set: false, save: false, restart: false });
  expect(marks('user.name')).toEqual({ set: false, save: false, restart: false });
  expect(marks('keys.chat')).toEqual({ set: false, save: false, restart: true });
  expect(marks('ui')).toEqual({ set: false, save: false, restart: false });
  // A mark says why, and the model is shown the reason.
  expect(configMarks(hostConfigSchema, 'ui.verbs', plugins).maySet?.reason).toBeTruthy();
});

test('a mark is seen through optional, default and partial, at any depth', () => {
  const inner = z.boolean().register(modelMaySet, { reason: 'r' }).register(modelMaySave, { reason: 'r' });
  const root = z.object({
    a: z.object({ flag: inner.optional() }).optional(),
    b: z.object({ flag: z.boolean().register(modelMaySet, { reason: 'r' }) }).partial().optional(),
    c: z.object({ flag: z.number().register(modelMaySet, { reason: 'r' }).default(3) }).optional(),
    d: z.object({ slow: z.boolean() }).register(appliesOnRestart, {}).optional(),
  });
  expect(configMarks(root, 'a.flag')).toMatchObject({ maySet: { reason: 'r' }, maySave: { reason: 'r' } });
  expect(configMarks(root, 'b.flag').maySet).toEqual({ reason: 'r' });
  expect(configMarks(root, 'b.flag').maySave).toBeNull();
  expect(configMarks(root, 'c.flag').maySet).toEqual({ reason: 'r' });
  // A restart mark on a node counts for every key under it.
  expect(configMarks(root, 'd.slow').restart).toBe(true);
  // An unknown key has no marks.
  expect(configMarks(root, 'a.nope')).toEqual({ maySet: null, maySave: null, restart: false });
});

test('a save mark without the set mark saves nothing; a mark under the leash is inert', () => {
  const plugins = {
    repo: z.object({
      roots: z.array(z.string()).register(modelMaySet, { reason: 'x' }).register(modelMaySave, { reason: 'x' }).optional(),
      theme: z.string().register(modelMaySave, { reason: 'x' }).optional(),
      shown: z.boolean().register(modelMaySet, { reason: 'x' }).register(modelMaySave, { reason: 'x' }).optional(),
    }).optional(),
  };
  expect(configMarks(hostConfigSchema, 'plugins.repo.roots', plugins)).toMatchObject({ maySet: null, maySave: null });
  expect(configMarks(hostConfigSchema, 'plugins.repo.theme', plugins)).toMatchObject({ maySet: null, maySave: null });
  expect(configMarks(hostConfigSchema, 'plugins.repo.shown', plugins)).toMatchObject({ maySet: { reason: 'x' }, maySave: { reason: 'x' } });
  // A root schema of its own that marks a key under `ai`: still the leash.
  const root = z.object({ ai: z.object({ model: z.string().register(modelMaySet, { reason: 'x' }) }).optional() });
  expect(configMarks(root, 'ai.model').maySet).toBeNull();
});
