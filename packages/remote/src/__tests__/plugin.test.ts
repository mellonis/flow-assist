import { expect, test } from 'bun:test';
import { createPeer, type PeerIo } from '../peer';
import { runPlugin } from '../plugin';

function pair(): [PeerIo, PeerIo] {
  const a2b: Array<(l: string) => void> = []; const b2a: Array<(l: string) => void> = [];
  return [
    { send: (l) => queueMicrotask(() => a2b.forEach((f) => f(l))), onLine: (f) => { b2a.push(f); } },
    { send: (l) => queueMicrotask(() => b2a.forEach((f) => f(l))), onLine: (f) => { a2b.push(f); } },
  ];
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('runPlugin answers hello with the def, draws init\'s frame, updates on events and frames again', async () => {
  const [hostIo, pluginIo] = pair();
  const host = createPeer(hostIo);
  const frames: unknown[] = [];
  host.onNotify('frame', (f) => frames.push(f));
  const run = runPlugin<{ n: number }, { type: string }>({
    hello: { name: 'counter', keys: { up: 'k' } },
    init: () => ({ n: 0 }),
    update: (msg, m) => (msg.type === 'key' ? { n: m.n + 1 } : m),
    view: (m) => ({ surface: ['Text', {}, `n=${m.n}`], keycaps: ['k up'], keys: { consume: ['k'] } }),
    tools: { count: (_a, m) => `n is ${m.n}` },
    commands: { reset: () => ({ n: 0 }) },
  }, pluginIo);
  expect(await host.request('hello', { hostApi: 2, config: {} })).toMatchObject({ hostApi: 2, name: 'counter', keys: { up: 'k' }, commands: [{ name: 'reset' }], tools: [{ id: 'counter', tools: [{ function: { name: 'count' } }] }] });
  await tick();
  expect(frames.at(-1)).toMatchObject({ surface: ['Text', {}, 'n=0'] });
  host.notify('key', { name: 'k', id: 'k', action: 'up' });
  await tick();
  expect(frames.at(-1)).toMatchObject({ surface: ['Text', {}, 'n=1'] });
  expect(await host.request('tool.run', { name: 'count', args: {}, call: { id: '1' } })).toEqual({ result: 'n is 1' });
  await host.request('command.run', { name: 'reset', arg: '' });
  await tick();
  expect(frames.at(-1)).toMatchObject({ surface: ['Text', {}, 'n=0'] });
  await host.request('shutdown');
  await run; // resolves once shutdown was answered
});

test('an update may be async and call host services; a throwing tool is an error the host sees', async () => {
  const [hostIo, pluginIo] = pair();
  const host = createPeer(hostIo);
  const shown: string[] = [];
  host.onRequest('host.showMessage', (p) => { shown.push((p as { text: string }).text); });
  const run = runPlugin<{ ok: boolean }, { type: string }>({
    hello: { name: 'login' },
    init: () => ({ ok: false }),
    update: async (msg, m, h) => { if (msg.type === 'submitted') { await h.showMessage('Signed in'); return { ok: true }; } return m; },
    view: (m) => ({ surface: ['Text', {}, m.ok ? 'in' : 'out'] }),
    tools: { fail: () => { throw new Error('no'); } },
  }, pluginIo);
  await host.request('hello', { hostApi: 2, config: {} });
  host.notify('submitted', { id: 'pass', value: 'x' });
  await tick(); await tick();
  expect(shown).toEqual(['Signed in']);
  await expect(host.request('tool.run', { name: 'fail', args: {}, call: { id: '1' } })).rejects.toThrow('no');
  await host.request('shutdown');
  await run;
});
