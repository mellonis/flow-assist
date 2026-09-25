// The author's runtime: Elm-shaped. `init` makes the model from `hello`, `update`
// folds a host event (or the author's own Msg) into it, `view` draws the frame, and
// every change — an event handled, a command run, an update that finished — sends the
// frame again. Tools answer `tool.run`; the host's services are async calls on `host`.
import { PROTOCOL_HOST_API, type Frame, type HelloParams, type HelloResult, type KeyEvent, type Size, type StyledSpan } from './protocol.js';
import { createPeer, PeerError, type Peer, type PeerIo } from './peer.js';
import { stdioIo } from './stdio.js';

export type HostEvent =
  | { type: 'key'; key: KeyEvent }
  | { type: 'changed' | 'submitted' | 'cancelled' | 'toggled'; id: string; value?: unknown }
  | { type: 'resize'; terminal: Size; surface: Size }
  | { type: 'focus' } | { type: 'blur' } | { type: 'visible'; surface: boolean }
  | { type: 'store'; key: string; value: unknown } | { type: 'cache.flushed' } | { type: 'afterWrite' };

export interface Host {
  showMessage(text: string): Promise<void>;
  pushLog(text: string): Promise<void>;
  copyToClipboard(text: string): Promise<void>;
  chatLLM(messages: unknown[]): Promise<{ content: string }>;
  store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  cache: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; del(key: string): Promise<void> };
  config(): Promise<Record<string, unknown>>;
  // Sends the current frame now — for a change made outside `update` (a timer).
  redraw(): void;
}

export interface PluginDef<M, Msg = HostEvent> {
  hello: Omit<HelloResult, 'hostApi' | 'commands' | 'tools'> & { hostApi?: number | number[]; commands?: HelloResult['commands']; tools?: HelloResult['tools'] };
  init(params: HelloParams): M;
  update(msg: Msg, model: M, host: Host): M | Promise<M>;
  view(model: M): Frame;
  tools?: Record<string, (args: Record<string, unknown>, model: M, host: Host) => unknown | Promise<unknown>>;
  commands?: Record<string, (arg: string, model: M, host: Host) => M | Promise<M>>;
  viewRenderers?: Record<string, (data: unknown, width: number) => StyledSpan[][]>;
  msg?: (event: HostEvent) => Msg | null;
}

export function hostOver(peer: Peer, redraw: () => void): Host {
  const call = (method: string, params?: unknown) => peer.request(method, params);
  return {
    showMessage: async (text) => { await call('host.showMessage', { text }); },
    pushLog: async (text) => { await call('host.pushLog', { text }); },
    copyToClipboard: async (text) => { await call('host.copyToClipboard', { text }); },
    chatLLM: (messages) => call('host.chatLLM', { messages }) as Promise<{ content: string }>,
    store: { get: (key) => call('host.store.get', { key }), set: async (key, value) => { await call('host.store.set', { key, value }); } },
    cache: { get: (key) => call('host.cache.get', { key }), set: async (key, value) => { await call('host.cache.set', { key, value }); }, del: async (key) => { await call('host.cache.del', { key }); } },
    config: () => call('host.config.get', {}) as Promise<Record<string, unknown>>,
    redraw,
  };
}

// Serves one host connection. Resolves when the host says `shutdown`.
export function servePlugin<M, Msg = HostEvent>(def: PluginDef<M, Msg>, io: PeerIo): Promise<void> {
  const peer = createPeer(io);
  let model: M | undefined;
  let queue: Promise<void> = Promise.resolve();
  const frame = () => { if (model !== undefined) peer.notify('frame', def.view(model)); };
  const host = hostOver(peer, frame);
  const fold = (msg: Msg) => { queue = queue.then(async () => { if (model === undefined) return; model = await def.update(msg, model, host); frame(); }); };
  const event = (e: HostEvent) => { const m = def.msg ? def.msg(e) : (e as unknown as Msg); if (m !== null && m !== undefined) fold(m); };

  const toolDecls = def.hello.tools ?? (def.tools ? [{ id: def.hello.name ?? 'tools', tools: Object.keys(def.tools).map((n) => ({ type: 'function' as const, function: { name: n, description: n, parameters: { type: 'object', properties: {} } } })) }] : []);
  const commandDecls = def.hello.commands ?? Object.keys(def.commands ?? {}).map((n) => ({ name: n }));

  return new Promise<void>((done) => {
    peer.onRequest('hello', (params) => {
      model = def.init(params as HelloParams);
      queueMicrotask(frame);
      return { hostApi: PROTOCOL_HOST_API, ...def.hello, commands: commandDecls, tools: toolDecls };
    });
    peer.onRequest('tool.run', async (p) => {
      const { name, args } = p as { name: string; args: Record<string, unknown> };
      const t = def.tools?.[name];
      if (!t || model === undefined) throw new PeerError(`unknown tool: ${name}`, PeerError.METHOD_NOT_FOUND);
      return { result: await t(args, model, host) };
    });
    peer.onRequest('command.run', async (p) => {
      const { name, arg } = p as { name: string; arg: string };
      const c = def.commands?.[name];
      if (!c) throw new PeerError(`unknown command: ${name}`, PeerError.METHOD_NOT_FOUND);
      await (queue = queue.then(async () => { if (model === undefined) return; model = await c(arg, model, host); frame(); }));
      return {};
    });
    peer.onRequest('view.render', (p) => {
      const { kind, data, width } = p as { kind: string; data: unknown; width: number };
      const r = def.viewRenderers?.[kind];
      if (!r) throw new PeerError(`no renderer for ${kind}`, PeerError.METHOD_NOT_FOUND);
      return { lines: r(data, width) };
    });
    // The answer itself goes out through the same peer, in a microtask queued after
    // this handler returns — closing on a `setTimeout` waits for the next macrotask,
    // safely after that microtask, so the answer is never dropped by a peer already
    // marked closed.
    peer.onRequest('shutdown', () => { setTimeout(() => { peer.close(); done(); }, 0); return {}; });
    peer.onNotify('key', (p) => event({ type: 'key', key: p as KeyEvent }));
    for (const t of ['changed', 'submitted', 'cancelled', 'toggled'] as const) peer.onNotify(t, (p) => event({ type: t, ...(p as { id: string; value?: unknown }) }));
    peer.onNotify('resize', (p) => event({ type: 'resize', ...(p as { terminal: Size; surface: Size }) }));
    peer.onNotify('focus', () => event({ type: 'focus' }));
    peer.onNotify('blur', () => event({ type: 'blur' }));
    peer.onNotify('visible', (p) => event({ type: 'visible', ...(p as { surface: boolean }) }));
    peer.onNotify('store', (p) => event({ type: 'store', ...(p as { key: string; value: unknown }) }));
    peer.onNotify('cache.flushed', () => event({ type: 'cache.flushed' }));
    peer.onNotify('afterWrite', () => event({ type: 'afterWrite' }));
  });
}

// The entry an author calls from `main`: stdio by default; `--serve <socket>` is the
// shared-server mode (./serve.ts).
export async function runPlugin<M, Msg = HostEvent>(def: PluginDef<M, Msg>, io?: PeerIo, argv: string[] = process.argv.slice(2)): Promise<void> {
  if (io) return servePlugin(def, io);
  const at = argv.indexOf('--serve');
  if (at !== -1) {
    const { serveConnections } = await import('./serve.js');
    return serveConnections((io) => servePlugin(def, io), argv[at + 1] ?? '');
  }
  await servePlugin(def, stdioIo());
  process.exit(0);
}
