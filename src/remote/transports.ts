// Where the loader gets a transport for a remote plugin's manifest. A child over stdio
// for `run`, a shared server over a local socket for `connect` (./transport-stdio.ts,
// ./transport-socket.ts, both under a restarting supervisor). The tests inject a
// transport of their own through `LoadPluginsOptions.remoteTransport`.
import { socketPath } from './sockets.js';
import { socketTransport } from './transport-socket.js';
import { stdioTransport } from './transport-stdio.js';
import { supervise } from './supervisor.js';
import type { RemoteManifest, RestartingTransport } from './transport.js';

export interface TransportDeps { log: (line: string) => void }

// `connect: "unix:<name>"` → a shared server on that socket, started with `run
// --serve` when nothing listens; `run` alone → a child over stdio. Either under the
// supervisor, so a crash restarts it and the adapter says hello again.
//
// The grace the adapter passes as `close(3_000)` — on a failed handshake and on the
// host's own stop alike (./adapter.ts, ./lifecycle.ts) — gives a stdio child: stdin
// closes at once, then 1 500 ms for the process to end on its own, then SIGTERM, then
// SIGKILL 1 500 ms after that (transport-stdio.ts's own split of `graceMs`). A socket
// transport ignores the grace outright — it only disconnects.
export function transportFor(manifest: RemoteManifest, dir: string, deps: TransportDeps): RestartingTransport {
  const { name } = manifest;
  if (manifest.connect) {
    const m = /^unix:(.+)$/.exec(manifest.connect);
    if (!m) throw new Error(`${name}: connect must be "unix:<socket name>", got ${JSON.stringify(manifest.connect)}`);
    const sock = socketPath(m[1]!);
    return supervise(
      () => socketTransport({ name, socketPath: sock, run: manifest.run, cwd: dir, log: deps.log }),
      { name, log: deps.log },
    );
  }
  return supervise(
    () => stdioTransport({ name, command: manifest.run!, cwd: dir, log: deps.log }),
    { name, log: deps.log },
  );
}
