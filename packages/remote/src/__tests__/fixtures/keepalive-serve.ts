// A plugin whose author holds a handle of their own — a timer, a connection — that
// keeps the event loop alive, run with `--serve <path>`: `serve.test.ts` checks that
// it still ends, on its idle timer and on SIGTERM.
import { runPlugin } from '../../plugin';

setInterval(() => {}, 1_000);
await runPlugin({ hello: { name: 'keepalive' }, init: () => ({}), update: (_e, m) => m, view: () => ({ surface: null }) });
