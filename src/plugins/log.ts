// Plugin «log»: the log modal (the host's last messages). Self-sufficient: owns
// its state (open/closed, scroll) and input. Its state lives in `ft.useState`
// (a plugin may not import react directly), and `addTrigger` is taken from the
// host's registry.

import { addTrigger } from '../loader/registry.js';
import type { Make } from '../loader/plugin.js';
import type { Plugin } from '../loader/plugin.js';

// The `ft` runtime the log component receives (typed by shape).
interface LogFT {
  useTerminalSize(): { width: number; height: number };
  useState<T>(init: T): [T, (v: T | ((prev: T) => T)) => void];
  // `key`/`ui` are typed `any` so the same interface is structurally compatible with
  // the host's `TriggerFT` (used by `addTrigger`) AND accepts the direct
  // `(key) => boolean` handlers the component passes — the runtime is the
  // real source of these shapes.
  useInputHandler(opts: {
    mode: string;
    priority: (ui: any) => number;
    handler: (key: any, ui: any) => boolean;
  }): void;
  store: Record<string, unknown>;
  services: Record<string, unknown>;
  viewRegistry: Record<string, unknown>;
  config: Record<string, unknown>;
  notify(): void;
  keys: Record<string, string | string[]>;
}

type BuildLogParams = {
  renders: Record<string, unknown>;
  config: Record<string, unknown>;
  make: Make;
};

export function buildLogPlugin({ renders, config, make }: BuildLogParams): Plugin {
  return make('log', {
    name: 'log',
    commands: [],
    keys: { log: 'l' },
    views: { log: renders.log },
    components: {
      // The log modal — fully self-sufficient: owns its state (open/closed, scroll)
      // and input. Opened by the host via ft.store.log.openLog() (from the monolithic
      // dispatcher keys.log), closed by l/q/Esc, paged by ↑↓/PgUp/PgDn/Home/End.
      // Registers a consumer: priority 100 when open, 0 otherwise — so a closed modal
      // intercepts nothing, while an open one eats input like the monolithic branch.
      log: (ft) => {
        const f = ft as LogFT;
        return function LogModal() {
          const { width, height } = f.useTerminalSize();
          // Inline of the tracker's useLog hook: the plugin may not import react, so
          // it reads `ft.useState` instead. `pushLog` is the host's (ft.services), so
          // the log-tick re-render channel lives on the host side — here we keep only
          // the modal/scroll state.
          const [logModal, setLogModal] = f.useState(false);
          const [logScroll, setLogScroll] = f.useState(0);
          const logs = ((f.services as Record<string, { length: number } | undefined>).logs ?? []) as { length: number }[];
          const logModalRows = Math.max(3, Math.floor(height * 0.7) - 4);
          f.useInputHandler({
            mode: 'consume',
            priority: (ui) => (ui.cmdOpen || ui.welcome) ? 0 : (logModal ? 100 : 0),
            handler: (key) => {
              if (!logModal) return false;
              const maxScroll = Math.max(0, (logs ?? []).length - logModalRows);
              if (key.name === 'l' || key.name === 'q' || key.name === 'escape') setLogModal(false);
              if (key.name === 'up') setLogScroll(s => Math.min(s + 1, maxScroll));
              if (key.name === 'down') setLogScroll(s => Math.max(0, s - 1));
              if (key.name === 'pageup') setLogScroll(s => Math.min(s + logModalRows, maxScroll));
              if (key.name === 'pagedown') setLogScroll(s => Math.max(0, s - logModalRows));
              if (key.name === 'home') setLogScroll(maxScroll);
              if (key.name === 'end') setLogScroll(0);
              return true;
            },
          });
          // Publish the API to the host so it can open the modal from the monolith.
          (f.store as Record<string, any>).log = {
            openLog: () => { setLogScroll(0); setLogModal(true); f.notify(); },
          };
          // Trigger-open: the plugin itself knows `l` opens the log, not the host.
          addTrigger({ ft: f, action: 'log', isOpen: () => logModal, open: () => { setLogScroll(0); setLogModal(true); f.notify(); } });
          if (!logModal) return null;
          return (f.viewRegistry.log as (p: Record<string, unknown>) => unknown)({ width, height, theme: f.config.theme, logs: (f.services as Record<string, unknown>).logs, logModalRows, logScroll });
        };
      },
    },
  });
}

export default buildLogPlugin;