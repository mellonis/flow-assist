// A remote plugin, as the loader sees it: `remotePlugin` builds one from a manifest and
// a transport (./adapter.ts), `transportFor` reaches its process (./transports.ts).
//
// The one thing kept here rather than in an adapter is the `store` event's fan-out: a
// remote plugin's `host.store.set` is told to every OTHER remote plugin of the same App
// (the same `host.store` record), as `store { key, value }` — the App's top-level store
// key, which is the writer's name, and its slice whole, what a JS plugin reading
// `host.store.<name>` would see. The registry is process-level state on purpose, like
// the `mcp` plugin's live servers: the adapters are separate objects built one by one
// and have no other place to find each other. It is keyed by the App's store object,
// weakly, so two Apps in one process (every e2e test boots its own) never hear each
// other and a finished App's adapters are let go with it. A JS plugin's store writes are
// not observed: `host.store` is a plain record with no change hook.
import type { StoreEvent } from '@flow-assist/remote';
import { remotePlugin as buildRemotePlugin, type RemotePluginOpts, type StoreBus } from './adapter.js';

type Hear = (ev: StoreEvent) => void;
const live = new WeakMap<object, Set<Hear>>();

export const storeBus: StoreBus = {
  join(store, hear) {
    let members = live.get(store);
    if (!members) live.set(store, (members = new Set()));
    members.add(hear);
  },
  said(store, from, ev) {
    for (const hear of live.get(store) ?? []) if (hear !== from) hear(ev);
  },
};

export const remotePlugin = (opts: RemotePluginOpts) => buildRemotePlugin({ storeBus, ...opts });
export { transportFor } from './transports.js';
export { isRemoteManifest } from './transport.js';
export type { Transport, RestartingTransport, RemoteManifest } from './transport.js';
