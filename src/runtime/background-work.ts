// Whether the code running now is a background task's (the `background` tool's nested
// run), carried through every await of that run — a plugin's tool the task calls
// included, which has no ctx of the chat's to tell it. What only the chat's own turn may
// do (open a screen, src/runtime/screens.ts) asks this.
import { AsyncLocalStorage } from 'node:async_hooks';

const work = new AsyncLocalStorage<true>();

// Runs `fn` as background work: everything it awaits reads `inBackgroundWork()` as true.
export const asBackgroundWork = <T>(fn: () => T): T => work.run(true, fn);
export const inBackgroundWork = (): boolean => work.getStore() === true;
