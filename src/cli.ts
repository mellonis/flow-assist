#!/usr/bin/env bun
// The program's entry point: the `bin`, `bun src/cli.ts` and what `build:binary`
// compiles. It only settles the environment and hands over to `main.ts`, which holds
// the CLI itself.
//
// NODE_ENV has to be set before React is loaded, and static imports are evaluated
// before any statement of the module that imports them — so `main.ts`, which loads
// React through its imports, is imported dynamically, inside the window where the
// variable is set. Once the modules are loaded the person's own value is put back
// (unset stays unset), so every command the program starts sees the environment the
// person's shell has. `node-env.ts` imports nothing.
import { withProductionDefault } from './node-env.js';

const { main } = await withProductionDefault(process.env, () => import('./main.js'));

// Not awaited: a pending top-level await keeps Bun's loop alive on its own, and the
// program must end when its work does (a one-shot prompt, `config set …`).
main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
