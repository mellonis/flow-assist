// The seam between a remote plugin's protocol and the way its process is reached.
//
// A remote plugin (docs/plugins.md, "A plugin in another language") is a process the
// host talks to over JSON-RPC, one message per line. The protocol layer — the adapter
// that turns that conversation into an ordinary `Plugin` (./adapter.ts) — knows lines
// and "the connection closed", nothing else. A transport knows processes and sockets:
// a child over its stdin and stdout (./transport-stdio.ts), a shared server over a
// local socket (./transport-socket.ts), a pair of in-memory streams for the tests.
// This file holds the interface alone, so either side can be built against it.
//
// `close` is the transport's own stop, after the protocol has already said
// `shutdown`: a stdio transport stops its child (SIGTERM, then SIGKILL after
// `graceMs`); a socket transport disconnects and never touches the server — another
// client may be on it. A supervisor that restarts a transport after a crash presents
// the same interface, plus `onRestart` for the layer above to run its handshake again.

export interface TransportClose {
  // How the other side went: an exit code or a signal for a child, an error for a
  // connection that broke. All absent: it closed cleanly.
  code?: number;
  signal?: string;
  error?: string;
  // The last lines a child wrote to its stderr (a few, each cut short), when it wrote
  // any — what a crash left to say; the adapter draws them under the stop.
  stderr?: string[];
}

export interface Transport {
  // One line, without its newline. Nothing is sent after `onClose` has fired.
  send(line: string): void;
  // Every line the other side writes, without its newline, in order — split by
  // `@flow-assist/remote`'s `LineSplitter`, which is where the 64 MiB line guard lives;
  // the peer above has no cap of its own.
  onLine(fn: (line: string) => void): void;
  // Fires once, when the other side is gone.
  onClose(fn: (why: TransportClose) => void): void;
  close(graceMs: number): Promise<void>;
}

export interface RestartingTransport extends Transport {
  // Brings the process up (or connects) for the first time; rejects when it cannot.
  start(): Promise<void>;
  // Fires after every restart or reconnection that followed a close: the layer above
  // sends `hello` again and starts from an empty frame.
  onRestart(fn: () => void): void;
}

// The manifest fields that make a plugin remote (docs/plugins.md). `run` is the
// command, relative to the plugin's directory, started without a shell; `connect` a
// socket NAME under the host's own `sockets/` directory, never a path.
export interface RemoteManifest {
  name: string;
  run?: string[];
  connect?: string;
}

export function isRemoteManifest(m: Record<string, unknown> | null): m is Record<string, unknown> & RemoteManifest {
  if (!m || typeof m.name !== 'string') return false;
  const run = Array.isArray(m.run) && m.run.length > 0 && m.run.every((s) => typeof s === 'string');
  const connect = typeof m.connect === 'string' && m.connect.length > 0;
  return run || connect;
}
