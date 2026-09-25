// The shared-server mode of `runPlugin` (`--serve <socket path>`): several hosts
// connect to one process over a local socket, each connection its own client. Plan B
// builds it; until then it says so.
import type { PeerIo } from './peer.js';

export async function serveConnections(_onConnection: (io: PeerIo) => Promise<void>, _socketPath: string, _opts?: { defaultIdleMs?: number; onListening?: () => void }): Promise<void> {
  process.stderr.write('--serve is not built yet\n');
  process.exit(2);
}
