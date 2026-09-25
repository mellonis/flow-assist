// A remote plugin the e2e tests drive: the plugin's end of an in-memory transport, a
// Peer with the handlers a test sets, and the transport the loader is handed.
import { createPeer, type Frame, type HelloResult, type Peer } from '@flow-assist/remote';
import type { RemoteManifest, RestartingTransport } from '../../remote/transport';

export interface FakeRemote {
  transport: RestartingTransport;
  peer: Peer;
  manifest: RemoteManifest & Record<string, unknown>;
  frame(f: Frame): void;
  events: Array<[string, unknown]>;
  crash(): void;
  restart(): void;
  hello: HelloResult;
}

export function fakeRemote(hello: Partial<HelloResult> = {}, manifest: Partial<RemoteManifest & Record<string, unknown>> = {}): FakeRemote {
  const toHost: Array<(l: string) => void> = []; const toPlugin: Array<(l: string) => void> = [];
  const closes: Array<(why: { code?: number }) => void> = []; const restarts: Array<() => void> = [];
  const transport: RestartingTransport = {
    send: (l) => queueMicrotask(() => toPlugin.forEach((f) => f(l))),
    onLine: (f) => { toHost.push(f); },
    onClose: (f) => { closes.push(f); },
    close: async () => {},
    start: async () => {},
    onRestart: (f) => { restarts.push(f); },
  };
  const peer = createPeer({ send: (l) => queueMicrotask(() => toHost.forEach((f) => f(l))), onLine: (f) => { toPlugin.push(f); } });
  const full: HelloResult = { hostApi: 2, ...hello };
  peer.onRequest('hello', () => full);
  const events: Array<[string, unknown]> = [];
  for (const m of ['key', 'changed', 'submitted', 'cancelled', 'toggled', 'resize', 'focus', 'blur', 'visible', 'store', 'cache.flushed', 'afterWrite']) peer.onNotify(m, (p) => events.push([m, p]));
  return {
    transport, peer, events, hello: full,
    manifest: { name: 'fake', hostApi: 2, run: ['fake'], ...manifest },
    frame: (f) => peer.notify('frame', f),
    crash: () => closes.forEach((f) => f({ code: 1 })),
    restart: () => restarts.forEach((f) => f()),
  };
}
