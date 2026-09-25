// A host that starts a shared server and is gone at once: it runs `socketTransport`
// with `run`, closes the connection and exits, so the server it started outlives the
// process that started it. `bun remote-start-and-leave.ts <socket path> <run…>`; the
// server's environment is this process's own.
import { socketTransport } from '../../remote/transport-socket';

const [socketPath, ...run] = process.argv.slice(2);
const t = socketTransport({ name: 'fake', socketPath: socketPath!, run, cwd: process.cwd(), log: (l) => process.stdout.write(`${l}\n`) });
await t.start();
await t.close(0);
process.exit(0);
