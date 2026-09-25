import { expect, test } from 'bun:test';
import { createPeer, PROTOCOL_HOST_API, type Peer } from '@flow-assist/remote';
import { makeFactory } from '../../loader/plugin';
import { HELLO_TIMEOUT_MS, remotePlugin } from '../adapter';
import type { RestartingTransport } from '../transport';
import { HOST_API } from '../../version';

// An in-memory transport and the plugin's end of it.
function fakeTransport(): { transport: RestartingTransport; plugin: Peer; closeFromPlugin: () => void; restart: () => void; started: number; closedWith: number[] } {
  const toHost: Array<(l: string) => void> = []; const toPlugin: Array<(l: string) => void> = [];
  const closes: Array<(why: { code?: number }) => void> = []; const restarts: Array<() => void> = [];
  const state = { started: 0 };
  const closedWith: number[] = [];
  const transport: RestartingTransport = {
    send: (l) => queueMicrotask(() => toPlugin.forEach((f) => f(l))),
    onLine: (f) => { toHost.push(f); },
    onClose: (f) => { closes.push(f); },
    close: async (graceMs) => { closedWith.push(graceMs); },
    start: async () => { state.started++; },
    onRestart: (f) => { restarts.push(f); },
  };
  const plugin = createPeer({ send: (l) => queueMicrotask(() => toHost.forEach((f) => f(l))), onLine: (f) => { toPlugin.push(f); } });
  return { transport, plugin, closeFromPlugin: () => closes.forEach((f) => f({ code: 1 })), restart: () => restarts.forEach((f) => f()), get started() { return state.started; }, closedWith };
}
const manifest = { name: 'fake', hostApi: 2, run: ['fake'] };
const hello = (plugin: Peer, extra: Record<string, unknown> = {}) => plugin.onRequest('hello', () => ({ hostApi: 2, keys: { open: 'o' }, entry: ['open'], commands: [{ name: 'lesson', usage: 'lesson <n>', values: ['1', '2'] }], tools: [{ id: 'tutor', tools: [{ type: 'function', function: { name: 'check', description: 'Check', parameters: { type: 'object', properties: {} } } }] }], configSchema: { type: 'object', properties: { lessons: { type: 'string' } } }, ...extra }));
const tick = () => new Promise((r) => setTimeout(r, 5));

test('hello registers what the manifest does not say, and the plugin is an ordinary Plugin', async () => {
  const { transport, plugin } = fakeTransport();
  const seen: unknown[] = [];
  plugin.onRequest('hello', (p) => { seen.push(p); return { hostApi: 2, keys: { open: 'o' }, entry: ['open'] }; });
  const p = await remotePlugin({ manifest, transport, config: { plugins: { fake: { lessons: 'x' } } }, make: makeFactory({}), env: { LANG: 'ru_RU.UTF-8' } });
  expect(p.name).toBe('fake');
  expect(p.keys).toEqual({ open: ['o'] });
  expect(p.entry).toEqual(['open']);
  expect(seen[0]).toMatchObject({ hostApi: 2, config: { lessons: 'x' }, locale: 'ru-RU', idleMs: 60_000 });
  expect(typeof p.components?.view).toBe('function');
});

test('the frame feeds keycaps and chatContext synchronously; a frame before hello is kept', async () => {
  const { transport, plugin } = fakeTransport();
  plugin.onRequest('hello', () => { plugin.notify('frame', { surface: ['Text', {}, 'early'], keycaps: ['x quit'], context: [{ label: 'L', text: 't' }] }); return { hostApi: 2 }; });
  const p = await remotePlugin({ manifest, transport, config: {}, make: makeFactory({}) });
  await tick();
  expect(p.keycaps!({} as never)).toEqual(['x quit']);
  expect(p.chatContext!({} as never)).toEqual([{ label: 'L', text: 't' }]);
  plugin.notify('frame', { surface: null });
  await tick();
  expect(p.keycaps!({} as never)).toEqual([]);
});

test('a keycap with an action draws the bound key and is dropped when the action is unbound', async () => {
  const { transport, plugin } = fakeTransport();
  hello(plugin);
  const p = await remotePlugin({ manifest, transport, config: {}, make: makeFactory({}) });
  plugin.notify('frame', { keycaps: [{ action: 'open', label: 'open' }, { action: 'nope', label: 'x' }] });
  await tick();
  const api = { host: { keyCap: (a: string) => (a === 'open' ? 'o' : '') } } as never;
  expect(p.keycaps!(api)).toEqual(['o open']);
});

test('tool.run reaches the plugin; its answer shapes; an error is the tool throwing', async () => {
  const { transport, plugin } = fakeTransport();
  hello(plugin);
  const calls: unknown[] = [];
  plugin.onRequest('tool.run', (params) => {
    calls.push(params);
    const { args } = params as { args: { mode: string } };
    if (args.mode === 'string') return 'bare';
    if (args.mode === 'shape') return { result: 'shaped' };
    if (args.mode === 'null') return null;
    throw new Error('nothing to check. Nothing was changed.');
  });
  const p = await remotePlugin({ manifest, transport, config: {}, make: makeFactory({}) });
  const group = (p.tools as Array<{ id: string; exec: (n: string, a: Record<string, unknown>, c: unknown) => Promise<unknown> }>)[0]!;
  expect(group.id).toBe('tutor');
  expect(await group.exec('check', { mode: 'string' }, {})).toBe('bare');
  expect(await group.exec('check', { mode: 'shape' }, {})).toBe('shaped');
  await expect(group.exec('check', { mode: 'null' }, {})).rejects.toThrow('answered with null, not { result }');
  await expect(group.exec('check', { mode: 'throw' }, {})).rejects.toThrow('nothing to check');
  expect(calls[0]).toMatchObject({ name: 'check', args: { mode: 'string' }, call: { id: expect.any(String) } });
});

test('a command runs in the plugin, with its values for completion', async () => {
  const { transport, plugin } = fakeTransport();
  hello(plugin);
  const ran: unknown[] = [];
  plugin.onRequest('command.run', (p) => { ran.push(p); return {}; });
  const p = await remotePlugin({ manifest, transport, config: {}, make: makeFactory({}) });
  const cmd = p.commands![0]!;
  expect(cmd.name).toBe('lesson');
  expect(cmd.values).toEqual(['1', '2']);
  await cmd.run!({}, '2');
  expect(ran).toEqual([{ name: 'lesson', arg: '2' }]);
});

test('configSchema arrives as JSON Schema and validates as zod', async () => {
  const { transport, plugin } = fakeTransport();
  hello(plugin);
  const p = await remotePlugin({ manifest, transport, config: {}, make: makeFactory({}) });
  const schema = p.configSchema as { safeParse: (v: unknown) => { success: boolean } };
  expect(schema.safeParse({ lessons: 'a' }).success).toBe(true);
  expect(schema.safeParse({ lessons: 3 }).success).toBe(false);
});

test('host.* requests reach the services; store.set fires nothing back to the caller', async () => {
  const { transport, plugin } = fakeTransport();
  hello(plugin);
  const p = await remotePlugin({ manifest, transport, config: {}, make: makeFactory({}) });
  const messages: string[] = []; const logs: string[] = [];
  const store: Record<string, unknown> = {};
  const api = { ui: {}, host: { services: { showMessage: (m: string) => messages.push(m), pushLog: (l: string) => logs.push(l), cache: { get: async () => 'cached', set: async () => {}, del: async () => {} } }, store, notify: () => {}, config: { plugins: { fake: { lessons: 'q' } } } } } as never;
  p.setup!(api);
  expect(await plugin.request('host.showMessage', { text: 'hi' })).toBeNull();
  expect(messages).toEqual(['hi']);
  await plugin.request('host.pushLog', { text: 'a line' });
  expect(logs).toEqual(['[fake] a line']);
  await plugin.request('host.store.set', { key: 'progress', value: 3 });
  expect(await plugin.request('host.store.get', { key: 'progress' })).toBe(3);
  expect(store.fake).toEqual({ progress: 3 });
  expect(await plugin.request('host.cache.get', { key: 'k' })).toBe('cached');
  expect(await plugin.request('host.config.get', {})).toEqual({ lessons: 'q' });
});

test('hello that never comes stops the transport and rejects', async () => {
  const { transport } = fakeTransport();
  await expect(remotePlugin({ manifest, transport, config: {}, make: makeFactory({}), helloTimeoutMs: 20 })).rejects.toThrow('hello');
  expect(HELLO_TIMEOUT_MS).toBe(10_000);
});

test('a close draws "plugin stopped" and a restart says hello again', async () => {
  const t = fakeTransport();
  let hellos = 0;
  t.plugin.onRequest('hello', () => { hellos++; return { hostApi: 2 }; });
  const p = await remotePlugin({ manifest, transport: t.transport, config: {}, make: makeFactory({}) });
  t.plugin.notify('frame', { surface: ['Text', {}, 'alive'], keycaps: ['x'] });
  await tick();
  t.closeFromPlugin();
  await tick();
  expect(p.keycaps!({} as never)).toEqual([]); // the surface is gone with the process
  const group = (p.tools as Array<{ exec: (n: string, a: Record<string, unknown>, c: unknown) => Promise<unknown> }>)[0];
  if (group) await expect(group.exec('check', {}, {})).rejects.toThrow('plugin stopped');
  t.restart();
  await tick(); await tick();
  expect(hellos).toBe(2);
});

test('the protocol speaks the host API the host provides', () => {
  expect(PROTOCOL_HOST_API).toBe(HOST_API);
});

test('hello is said after the transport starts; a refused hello stops it with the factory grace and says hello:', async () => {
  const t = fakeTransport();
  t.plugin.onRequest('hello', () => { throw new Error('no config'); });
  await expect(remotePlugin({ manifest, transport: t.transport, config: {}, make: makeFactory({}) })).rejects.toThrow(/^hello: no config/);
  expect(t.started).toBe(1);
  expect(t.closedWith).toEqual([3_000]);
  const u = fakeTransport();
  u.plugin.onRequest('hello', () => ({ hostApi: 1 }));
  await expect(remotePlugin({ manifest, transport: u.transport, config: {}, make: makeFactory({}) })).rejects.toThrow(/^hello: built for host API 1/);
});

test('a tool in flight when the process goes throws "plugin stopped"; after a restart tools run again without waiting for a frame', async () => {
  const t = fakeTransport();
  hello(t.plugin);
  let answer = true;
  t.plugin.onRequest('tool.run', () => (answer ? { result: 'ok' } : new Promise(() => {})));
  const p = await remotePlugin({ manifest, transport: t.transport, config: {}, make: makeFactory({}) });
  const group = (p.tools as Array<{ exec: (n: string, a: Record<string, unknown>, c: unknown) => Promise<unknown> }>)[0]!;
  answer = false;
  const inFlight = group.exec('check', {}, {});
  await tick();
  t.closeFromPlugin();
  await expect(inFlight).rejects.toThrow('plugin stopped');
  answer = true;
  t.restart();
  await tick(); await tick();
  expect(await group.exec('check', {}, {})).toBe('ok');
});
