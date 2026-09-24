import { expect, test } from 'bun:test';
import { z } from 'zod';
import { makeFactory } from '../plugin';
import type { PluginShape } from '../plugin';
import { buildCommandRegistry, buildViewRegistry, buildKeys, buildConfigSchema, buildPlugins, chatUser, composeFooterHints, commandContextFor, findIn, partitionInput, runConsumers } from '../registry';

test('makeFactory injects name, config slice and keys', () => {
  const make = makeFactory({ plugins: { tracker: { language: 'en' } } });
  const p = make('tracker', { keys: { open: 'enter' } });
  expect(p.name).toBe('tracker');
  expect(p.config).toEqual({ language: 'en' });
  expect(p.keys).toEqual({ open: 'enter' });
});

test('buildCommandRegistry merges plugin commands over base and namespaces', () => {
  const reg = buildCommandRegistry([{ name: 'tracker', commands: [{ name: 'open', run() {} }] }]);
  expect(reg.find(c => c.name === 'tracker:open')).toBeTruthy();
});

test('buildViewRegistry qualifies surface keys with the package name', () => {
  const reg = buildViewRegistry([{ name: 'tracker', views: { board: () => 'B' } }]);
  expect(reg['tracker:board']).toBeTruthy();
});

test('buildViewRegistry also registers a bare surface alias (first plugin wins)', () => {
  const reg = buildViewRegistry([
    { name: 'core', views: { help: () => 'H' } },
    { name: 'log', views: { log: () => 'L' } },
    { name: 'log2', views: { log: () => 'L2' } },
  ]);
  // The plugin modals read the bare surface name source-faithfully (core reads
  // viewRegistry.help, log reads viewRegistry.log), so it must resolve with the
  // FIRST plugin that claims it; a later same-named surface does not overwrite.
  expect(reg['help']).toBeTruthy();
  expect(reg['log']).toBeTruthy();
  expect(reg['log2:log']).toBeTruthy();
  expect(reg['log']).not.toBe(reg['log2:log']);
});

test('partitionInput splits observe vs consume, sorted by priority', () => {
  const reg = [
    { get: () => ({ mode: 'consume', priority: () => 5, handler: () => false }) },
    { get: () => ({ mode: 'observe', priority: () => 1000, handler: () => {} }) },
  ];
  const { observers, consumers } = partitionInput(reg, {});
  expect(observers.map(o => o.priority?.())).toEqual([1000]);
  expect(consumers.length).toBe(1);
});

test('runConsumers stops at the first strict-true handler', () => {
  let hit = 0;
  const consumers = [
    { handler: () => { hit++; return true; } },
    { handler: () => { hit++; return 1; } },
  ];
  expect(runConsumers(consumers as any, {})).toBe(true);
  expect(hit).toBe(1);
});

test('findIn resolves by name or alias, case-insensitive', () => {
  const reg = [{ name: 'quit', aliases: ['q'] }];
  expect(findIn(reg, 'Quit')?.name).toBe('quit');
  expect(findIn(reg, 'q')?.name).toBe('quit');
});

test('findIn resolves a namespaced plugin command by its bare name or alias', () => {
  const reg = buildCommandRegistry([
    { name: 'assistant', commands: [{ name: 'ask', aliases: ['chat'], run() {} }] },
    { name: 'tracker', commands: [{ name: 'open', run() {} }] },
  ]);
  // Bare name → namespaced command (`:ask` finds assistant:ask, `:open` finds tracker:open).
  expect(findIn(reg, 'ask')?.name).toBe('assistant:ask');
  expect(findIn(reg, 'open')?.name).toBe('tracker:open');
  // Alias still resolves (`:chat`).
  expect(findIn(reg, 'chat')?.name).toBe('assistant:ask');
});

test('findIn prefers an exact base-command match over a namespaced suffix collision', () => {
  // The host base owns bare `help`; a plugin namespaced command `core:help` must
  // NOT shadow it — the command line `:help` keeps hitting the base command.
  const reg = buildCommandRegistry(
    [{ name: 'core', commands: [{ name: 'help', run() {} }] }],
    [{ name: 'help', description: 'base help' }],
  );
  expect(findIn(reg, 'help')?.name).toBe('help');
  expect(findIn(reg, 'help')?.description).toBe('base help');
});

test('buildViewRegistry substitutes a safe no-op for an absent surface render (no crash)', () => {
  // The built-ins set views.help/chat/log from the `renders` bundle, which the
  // host hands `{}` at startup → each is undefined. buildViewRegistry must not
  // leave a call of that renderer crashing.
  const plugins = [
    { name: 'core', views: { help: undefined } },
    { name: 'assistant', views: { chat: undefined } },
    { name: 'log', views: { log: undefined } },
  ];
  const reg = buildViewRegistry(plugins);
  expect(typeof reg.help).toBe('function');
  expect(typeof reg.chat).toBe('function');
  expect(typeof reg.log).toBe('function');
  // Invoking the fallback renderer must not throw and must render nothing.
  expect(() => (reg.help as (p: unknown) => unknown)({})).not.toThrow();
  expect((reg.help as (p: unknown) => unknown)({})).toBe(null);
});

test('buildConfigSchema keeps plugins optional and passthrough (no required-key regression)', () => {
  const make = makeFactory();
  const plugins = [
    make('tracker', { configSchema: z.object({ language: z.string() }) }),
    make('keycaps', {}),
  ];
  const schema = buildConfigSchema(plugins as PluginShape[]);

  // A config WITHOUT a `plugins` key must still parse (the host is tracker-agnostic):
  // the base hostConfigSchema has `plugins` optional — the built schema must not make
  // it required.
  expect(schema.safeParse({ ai: { baseUrl: 'x' } }).success).toBe(true);

  // A known plugin namespace is validated against its configSchema.
  expect(schema.safeParse({ plugins: { tracker: { language: 'en' } } }).success).toBe(true);
  expect(schema.safeParse({ plugins: { tracker: { language: 42 } } }).success).toBe(false);

  // An undeclared plugin-namespace key is preserved (passthrough), not stripped.
  const parsed = schema.safeParse({ plugins: { unknownPlugin: { a: 1 } } });
  expect(parsed.success).toBe(true);
  expect((parsed.data.plugins as Record<string, unknown>).unknownPlugin).toEqual({ a: 1 });
});

test('chatUser comes from config.user only, and guesses no name out of a login', () => {
  expect(chatUser({})).toBeNull();
  expect(chatUser({ user: {} })).toBeNull();
  expect(chatUser({ user: { name: '  Ada  ' } })).toEqual({ name: 'Ada', login: '' });
  expect(chatUser({ user: { login: 'a.lovelace4' } })).toEqual({ name: 'a.lovelace4', login: 'a.lovelace4' });
  expect(chatUser({ user: { name: 'Ada', login: 'a.lovelace4' } })).toEqual({ name: 'Ada', login: 'a.lovelace4' });
});

test('commandContextFor passes a base command ctx through unchanged', () => {
  const cmd = { name: 'help', description: 'base help' };
  const base = { showMessage: () => {}, back: () => {} };
  expect(commandContextFor(cmd, base)).toBe(base);
  expect(commandContextFor(cmd, base, { tracker: { host: { services: { openIssue: () => {} } } } })).toBe(base);
});

test('commandContextFor merges the owning plugin services into a plugin command ctx', () => {
  const cmd = { name: 'tracker:open', description: 'open' };
  const base = { showMessage: () => {} };
  const services = { openIssue: (code: string) => code, openBoard: () => {} };
  const ctx = commandContextFor(cmd, base, { tracker: { host: { services } } });
  // Both the plugin's services and the host base closures land on the ctx.
  expect((ctx as { openIssue: (c: string) => string }).openIssue('ABC-1')).toBe('ABC-1');
  expect(typeof (ctx as { openBoard: () => void }).openBoard).toBe('function');
  expect(typeof (ctx as { showMessage: () => void }).showMessage).toBe('function');
});

test('commandContextFor lets the host base ctx win a name collision with a plugin service', () => {
  // A plugin's no-op `showMessage` must never shadow the host's real toast.
  const cmd = { name: 'tracker:open', description: 'open' };
  const base = { showMessage: 'host-toast' as unknown, back: () => {} };
  const services = { showMessage: 'plugin-noop' as unknown, openIssue: () => {} };
  const ctx = commandContextFor(cmd, base, { tracker: { host: { services } } });
  expect((ctx as { showMessage: unknown }).showMessage).toBe('host-toast');
});

test('commandContextFor returns the base ctx for a plugin that is not mounted', () => {
  const cmd = { name: 'tracker:open', description: 'open' };
  const base = { showMessage: () => {} };
  // No `tracker` entry in apiMap (the plugin is not mounted) → base ctx unchanged.
  expect(commandContextFor(cmd, base, {})).toBe(base);
});

// ─── Footer composition (spec: plugin footer hints + universal openBrowser) ────

// Note: this file uses `test`, not `describe` — the cases are flat.

test('composeFooterHints collapses to host base when no plugin is active', () => {
  const keys = { commandLine: [':'], quit: ['q'], clearCache: ['x'] };
  const hints = composeFooterHints([], {}, keys);
  // No content → no `x flush cache`, no plugin hints.
  expect(hints).toEqual([': commands', 'q quit']);
});

test('composeFooterHints appends a plugin that returns hints and gates x flush cache', () => {
  const keys = { commandLine: [':'], quit: ['q'], clearCache: ['x'] };
  const plugin: PluginShape = {
    name: 'tracker',
    keycaps: () => ['f: filters', 'c: board', 'b: browser'],
  };
  const hints = composeFooterHints([plugin], { tracker: {} }, keys);
  expect(hints).toEqual([': commands', 'q quit', 'x flush cache', 'f: filters', 'c: board', 'b: browser']);
});

test('composeFooterHints omits a plugin whose keycaps() returns [] (inactive context)', () => {
  const keys = { commandLine: [':'], quit: ['q'], clearCache: ['x'] };
  const plugin: PluginShape = { name: 'tracker', keycaps: () => [] };
  const hints = composeFooterHints([plugin], { tracker: {} }, keys);
  // No content → also no `x flush cache`.
  expect(hints).toEqual([': commands', 'q quit']);
});

test('composeFooterHints omits a plugin that declares no keycaps (default inactive)', () => {
  const keys = { commandLine: [':'], quit: ['q'], clearCache: ['x'] };
  const plugin: PluginShape = { name: 'plain' };
  const hints = composeFooterHints([plugin], { plain: {} }, keys);
  expect(hints).toEqual([': commands', 'q quit']);
});

test('composeFooterHints omits a plugin whose pair is not built yet', () => {
  const keys = { commandLine: [':'], quit: ['q'], clearCache: ['x'] };
  const plugin: PluginShape = { name: 'tracker', keycaps: () => ['f: filters'] };
  // No entry → the keycaps fn is never called.
  const hints = composeFooterHints([plugin], {}, keys);
  expect(hints).toEqual([': commands', 'q quit']);
});

test('the footer names the key the action is bound to NOW, as its cap', () => {
  // The person remapped quit to Enter-or-space and turned the command line off.
  const keys = buildKeys([], { keys: { quit: ['enter', 'space'], commandLine: [] } });
  const hints = composeFooterHints([], {}, keys);
  // Drawn as caps, not as the terminal's names ('return', ' ') — and an unbound
  // action gets no hint: it used to fall back to its default letter, advertising a
  // key that did nothing.
  expect(hints).toEqual(['⏎/␣ quit']);
});

test('the keys the App takes before any handler take only a chord: a key that types falls back to the default, said once', () => {
  const chat = { name: 'assistant', keys: { chatFocus: 'ctrl+]', chatCollapse: 'ctrl+\\', chat: 'F' } } as PluginShape;
  const said: string[] = [];
  const keys = (cfg: Record<string, unknown>) => buildKeys([chat], cfg as never, undefined, (line) => said.push(line));
  // A letter, a named key, a shifted letter: each would be taken from every field.
  for (const bad of ['x', 'enter', 'space', 'F', 'tab', ['ctrl+g', 'y']]) {
    said.length = 0;
    expect(keys({ keys: { chatFocus: bad } }).chatFocus).toEqual(['ctrl+]']);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('chatFocus');
  }
  // Through the plugin's own keys too.
  said.length = 0;
  expect(keys({ plugins: { assistant: { keys: { chatCollapse: 'q' } } } }).chatCollapse).toEqual(['ctrl+\\']);
  expect(said).toHaveLength(1);
  // A chord, an F-key, a control byte, or nothing at all is taken as it is, silently.
  said.length = 0;
  expect(keys({ keys: { chatFocus: 'ctrl+g' } }).chatFocus).toEqual(['ctrl+g']);
  expect(keys({ keys: { chatFocus: 'alt+c' } }).chatFocus).toEqual(['alt+c']);
  expect(keys({ keys: { chatFocus: 'f2' } }).chatFocus).toEqual(['f2']);
  expect(keys({ keys: { chatFocus: '\x1f' } }).chatFocus).toEqual(['ctrl+_']);
  expect(keys({ keys: { chatCollapse: [] } }).chatCollapse).toEqual([]);
  expect(said).toEqual([]);
  // Any other action binds a letter as before.
  expect(keys({ keys: { chat: 'x' } }).chat).toEqual(['x']);
});
