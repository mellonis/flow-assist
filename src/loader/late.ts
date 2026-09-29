// The plugins that are still starting when the first frame is drawn, and what becomes of
// them. The interactive app draws at once (`loadPlugins`' `late`): a remote plugin's
// process and its handshake, and a plugin's own `ready` (the `mcp` plugin's first
// connect to every server), go on in the background. The App takes each event as it
// comes — a plugin that joins goes into its list, a skip goes to its log — and the start
// screen names what is still starting.
//
// Events that come before the App listens (a fast handshake lands between the loader
// and the first render) wait here and are handed over when it does.
import type { Plugin } from './plugin.js';
import { redactSecrets } from '../assistant/secrets.js';

export type LateEvent =
  // A plugin that was on its way joins the list.
  | { kind: 'joined'; plugin: Plugin }
  // It did not make it: the loader's own skip line, `[plugins] skip <name>: <why>`, and
  // the why alone.
  | { kind: 'skipped'; name: string; line: string; why: string }
  // A plugin already in the list is done with what it was waiting on.
  | { kind: 'ready'; name: string }
  // A line for the app's log from a plugin still on its way — its process's stderr, a
  // restart during the handshake — or from its transport later on.
  | { kind: 'note'; line: string };

export interface LatePlugins {
  // A plugin that joins once `plugin` resolves; a rejection is its skip.
  expect(name: string, plugin: Promise<Plugin>): void;
  // A plugin in the list that is still waiting on someone (its `ready`); settled either
  // way, it is no longer starting.
  wait(name: string, ready: Promise<unknown>): void;
  // What is still starting, in the order it started.
  starting(): string[];
  // The enabled order (the loader's), and a plugin's place in it — a plugin that joins
  // takes its place there, not the end of the list.
  order(names: string[]): void;
  rank(name: string): number | undefined;
  // A line for the app's log.
  note(line: string): void;
  // Where the events go from now on; what waited is handed over at once. Returns the
  // way to stop listening (the App's unmount).
  listen(sink: (event: LateEvent) => void): () => void;
}

// The reason is redacted (src/assistant/secrets.ts): a plugin's error can carry a secret,
// and the line goes to stderr and the app's log as it is.
export const skipLine = (name: string, why: string) => `[plugins] skip ${name}: ${redactSecrets(why)}`;

// Where a plugin that joins goes in the list: before the first plugin that comes after
// it in the enabled order. A plugin with no place in it (a built-in) is passed over, so
// one that comes after every ranked plugin goes at the end.
export function joinIndex(list: Array<{ name: string }>, name: string, rank: (name: string) => number | undefined): number {
  const own = rank(name);
  if (own === undefined) return list.length;
  const at = list.findIndex((p) => { const r = rank(p.name); return r !== undefined && r > own; });
  return at === -1 ? list.length : at;
}

export function createLatePlugins(): LatePlugins {
  const pending: string[] = [];
  let enabled: string[] = [];
  const waiting: LateEvent[] = [];
  let sink: ((event: LateEvent) => void) | null = null;
  const emit = (event: LateEvent) => { if (sink) sink(event); else waiting.push(event); };
  const settle = (name: string, event: LateEvent) => {
    const at = pending.indexOf(name);
    if (at >= 0) pending.splice(at, 1);
    emit(event);
  };
  return {
    expect(name, plugin) {
      pending.push(name);
      plugin.then(
        (p) => {
          settle(name, { kind: 'joined', plugin: p });
          // A plugin that joined late may still be waiting on someone of its own.
          if (p.ready) this.wait(p.name, p.ready);
        },
        (e: unknown) => { const why = (e as Error)?.message ?? String(e); settle(name, { kind: 'skipped', name, line: skipLine(name, why), why }); },
      );
    },
    wait(name, ready) {
      pending.push(name);
      const done = () => settle(name, { kind: 'ready', name });
      ready.then(done, done);
    },
    starting: () => [...pending],
    order(names) { enabled = [...names]; },
    rank(name) { const at = enabled.indexOf(name); return at === -1 ? undefined : at; },
    note(line) { emit({ kind: 'note', line }); },
    listen(next) {
      sink = next;
      for (const event of waiting.splice(0)) next(event);
      return () => { if (sink === next) sink = null; };
    },
  };
}
