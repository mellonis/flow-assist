// Where the loader gets a transport for a remote plugin's manifest. A child over stdio
// for `run`, a shared server over a local socket for `connect` (./transport-stdio.ts,
// ./transport-socket.ts, both under a restarting supervisor). The tests inject a
// transport of their own through `LoadPluginsOptions.remoteTransport`.
import type { RemoteManifest, RestartingTransport } from './transport.js';

export interface TransportDeps { log: (line: string) => void }

export function transportFor(_manifest: RemoteManifest, _dir: string, _deps: TransportDeps): RestartingTransport {
  throw new Error('remote transports are not built yet');
}
