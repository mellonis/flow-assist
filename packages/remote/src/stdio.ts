// The plugin's end over its own stdin and stdout: lines in, lines out. Nothing but
// protocol goes to stdout — a plugin's own printing goes to stderr, which the host logs.
import { LineSplitter } from './codec.js';
import type { PeerIo } from './peer.js';

export function stdioIo(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): PeerIo {
  const listeners: Array<(l: string) => void> = [];
  const splitter = new LineSplitter((line) => listeners.forEach((f) => f(line)));
  input.setEncoding?.('utf8');
  input.on('data', (chunk: string | Buffer) => splitter.feed(chunk.toString()));
  return { send: (line) => { output.write(`${line}\n`); }, onLine: (f) => { listeners.push(f); } };
}
