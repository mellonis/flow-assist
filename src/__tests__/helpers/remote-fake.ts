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
  // How many times the host said `hello` — once per start, again after a restart.
  hellos(): number;
  // Holds the next `hello` unanswered until `answerHello()` — or `refuseHello(why)`,
  // which answers it with an error — so a test can act while the handshake is pending.
  holdHello(): void;
  answerHello(): void;
  refuseHello(why: string): void;
}

export function fakeRemote(hello: Partial<HelloResult> = {}, manifest: Partial<RemoteManifest & Record<string, unknown>> = {}): FakeRemote {
  const toHost: Array<(l: string) => void> = []; const toPlugin: Array<(l: string) => void> = [];
  const closes: Array<(why: { code?: number }) => void> = []; const restarts: Array<() => void> = [];
  const transport: RestartingTransport = {
    send: (l) => queueMicrotask(() => toPlugin.forEach((f) => f(l))),
    onLine: (f) => { toHost.push(f); },
    onClose: (f) => { closes.push(f); },
    // Closed for good: the host that closed it hears nothing more — a transport reached
    // again (a restart from the `:plugins` panel) is heard by the one that reached it.
    close: async () => { toHost.length = 0; closes.length = 0; restarts.length = 0; },
    start: async () => {},
    onRestart: (f) => { restarts.push(f); },
  };
  const peer = createPeer({ send: (l) => queueMicrotask(() => toHost.forEach((f) => f(l))), onLine: (f) => { toPlugin.push(f); } });
  const full: HelloResult = { hostApi: 2, ...hello };
  let held: { answer: () => void; refuse: (e: Error) => void } | null = null;
  let holding = false;
  let hellos = 0;
  peer.onRequest('hello', () => {
    hellos++;
    if (!holding) return full;
    holding = false;
    return new Promise<HelloResult>((resolve, reject) => { held = { answer: () => resolve(full), refuse: reject }; });
  });
  const events: Array<[string, unknown]> = [];
  for (const m of ['key', 'changed', 'submitted', 'cancelled', 'toggled', 'resize', 'focus', 'blur', 'visible', 'store', 'cache.flushed', 'afterWrite']) peer.onNotify(m, (p) => events.push([m, p]));
  return {
    transport, peer, events, hello: full, hellos: () => hellos,
    manifest: { name: 'fake', hostApi: 2, run: ['fake'], ...manifest },
    frame: (f) => peer.notify('frame', f),
    crash: () => closes.forEach((f) => f({ code: 1 })),
    restart: () => restarts.forEach((f) => f()),
    holdHello: () => { holding = true; },
    answerHello: () => { held?.answer(); held = null; },
    refuseHello: (why) => { held?.refuse(new Error(why)); held = null; },
  };
}
