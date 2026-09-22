// A short-lived program that starts a stdio server the way the plugin does, then either
// lets its work run out (`return`, as `config set plugins.…` does), makes a call whose
// answer takes a moment (`call`, as a one-shot prompt does) or waits to be signalled
// (`wait`, as the app does). It prints the server's pid on stdout; the test then checks
// that this program ended as it should and took the server along.
//
// The work is done inside a function and NOT awaited at the top level, exactly as
// `cli.ts` calls `main(...)`: a pending top-level await keeps bun's loop alive on its
// own and would hide whether the client holds the program itself.
//
// The server keeps running when its stdin closes (`--ignore-eof`), so only our own kill
// can be what stopped it.
import { connectServers, parseServers } from '../../index.ts';
import { liveServerPids } from '../../stdio.ts';

const mode = process.argv[2] ?? 'return';
const server = new URL('./fake-stdio-server.ts', import.meta.url).pathname;

async function run() {
  const modes = mode === 'call' ? ['--slow-call'] : [];
  const { groups, status } = await connectServers(parseServers({ fake: { command: process.execPath, args: [server, '--ignore-eof', ...modes] } }));
  process.stdout.write(`${JSON.stringify({ pids: liveServerPids(), status })}\n`);
  if (mode === 'call') process.stdout.write(`${JSON.stringify(await groups[0]!.exec('fake:list_tabs', {}))}\n`);
  if (mode === 'wait') setInterval(() => { /* the app's own life: only a signal ends it */ }, 1_000);
}

run().catch((e) => { process.stderr.write(`${(e as Error).message}\n`); process.exit(1); });
