// The host's own stop for its remote plugins, run once as the App exits: every
// registered stop (./adapter.ts registers one per remote plugin, after its `hello`
// succeeds) runs in parallel, bounded so a plugin that never answers cannot hold the
// host open. A leaf module with no imports, so ./adapter.ts and ../main.ts both reach
// it without pulling in anything else.
const stops = new Set<() => Promise<void>>();

export const STOP_ALL_TIMEOUT_MS = 1_500;

// Registers a stop; returns the function that removes it again. Idempotent: calling
// the returned function twice, or after `stopRemotePlugins` has already run it, is a
// no-op.
export function registerRemoteStop(stop: () => Promise<void>): () => void {
  stops.add(stop);
  return () => { stops.delete(stop); };
}

// Runs every currently-registered stop in parallel and waits for all of them to
// settle, or for `STOP_ALL_TIMEOUT_MS`, whichever comes first — a stop still running
// past the bound is left to finish on its own; nothing here waits on it further. A
// stop that throws synchronously, rather than returning a rejected promise, does not
// stop the others from running.
//
// The bound's timer is left ref'd, on purpose: this only runs from `onExit`, on the
// way out, once every transport (each already unref'd on its own) has nothing left
// to keep the loop alive — an unref'd timer here could let the process exit mid-
// `shutdown`, silently downgrading a clean stop to the stdio exit hook's SIGTERM
// backstop. Cleared on every path, so it never outlives this one wait.
export async function stopRemotePlugins(): Promise<void> {
  const settled = Promise.allSettled([...stops].map((stop) => {
    try {
      return stop();
    } catch (e) {
      return Promise.reject(e);
    }
  }));
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, STOP_ALL_TIMEOUT_MS);
    void settled.then(finish);
  });
}
