// What a test leaves running is stopped before the next test begins: `bootApp`
// registers its handles here and the moment between tests closes them. The hook
// itself is registered by the preload (preload-hooks.ts) — a hook a cached helper
// module registers reaches the first test file alone, and this cleanup must hold
// across the whole run.
export type Disposable = { close(): Promise<void> | void };

const live: Disposable[] = [];

export const trackDisposable = (item: Disposable): void => {
  live.push(item);
};

export const drainDisposables = async (): Promise<void> => {
  while (live.length) await live.pop()!.close();
};
