import { expect, test } from 'bun:test';
import { createPeer, type PeerIo } from '../peer';
import { runPlugin, servePlugin, type HostEvent } from '../plugin';
import { stdioIo } from '../stdio';

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

// A fake `NodeJS.ReadableStream`/`WritableStream` pair, just enough for `stdioIo`:
// `on('data'|'end', …)` and `write`. Drives the stdin-EOF path without a real process.
function fakeStdio() {
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  const written: string[] = [];
  const input = {
    setEncoding: () => {},
    on: (event: string, cb: (...a: unknown[]) => void) => { (handlers[event] ??= []).push(cb); },
  };
  const emit = (event: string, ...a: unknown[]) => { (handlers[event] ?? []).forEach((f) => f(...a)); };
  const output = { write: (s: string) => { written.push(s); } };
  return { input, output, emit, written };
}

test('shutdown waits, bounded, for an update already in flight to finish its own side effects', async () => {
  const [hostIo, pluginIo] = pair();
  const host = createPeer(hostIo);
  const frames: unknown[] = [];
  host.onNotify('frame', (f) => frames.push(f));
  let settled = false;
  const run = runPlugin<{ n: number }, { type: string }>({
    hello: { name: 'slow' },
    init: () => ({ n: 0 }),
    update: async (msg, m) => {
      if (msg.type !== 'afterWrite') return m;
      await new Promise((r) => setTimeout(r, 40)); // the update's own side effect
      settled = true;
      return { n: m.n + 1 };
    },
    view: (m) => ({ surface: ['Text', {}, `n=${m.n}`] }),
  }, pluginIo);
  await host.request('hello', { hostApi: 2, config: {} });
  host.notify('afterWrite'); // starts the update; nothing else is awaiting a host reply
  await tick(); // the update is now mid-flight, awaiting its own 40 ms timer
  await host.request('shutdown'); // answered at once — it does not wait on the drain
  expect(settled).toBe(false); // the update's side effect has not landed yet
  await run; // resolves once the update settles (well inside the 1 000 ms bound)
  expect(settled).toBe(true);
  expect(frames.at(-1)).toMatchObject({ surface: ['Text', {}, 'n=1'] }); // its frame reached the host
});

test('over stdio, an update in flight gets the same bounded chance to finish when stdin ends — no real process needed to show it', async () => {
  const { input, output, emit } = fakeStdio();
  let settled = false;
  const run = servePlugin<{ n: number }, HostEvent>({
    hello: { name: 'slow' },
    init: () => ({ n: 0 }),
    update: async (msg, m) => {
      if (msg.type !== 'afterWrite') return m;
      await new Promise((r) => setTimeout(r, 40));
      settled = true;
      return { n: m.n + 1 };
    },
    view: (m) => ({ surface: ['Text', {}, `n=${m.n}`] }),
  }, stdioIo(input as unknown as NodeJS.ReadableStream, output as unknown as NodeJS.WritableStream));
  emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: { hostApi: 2, config: {} } })}\n`);
  await tick();
  emit('data', `${JSON.stringify({ jsonrpc: '2.0', method: 'afterWrite' })}\n`);
  await tick(); // the update is mid-flight
  emit('end'); // the host's end of the pipe closed — no `shutdown` was ever sent
  expect(settled).toBe(false);
  await run;
  expect(settled).toBe(true);
});
