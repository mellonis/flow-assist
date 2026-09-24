// Plugin «core»: base commands (view/quit/back/clear/config/cache/help) and the
// help modal (components.help). Commands are a bare dispatcher over the app-glue
// (ctx); there are almost no view components: the host keeps only the `help`
// modal and `views.help` — a plugin brings its own views.

import type { Make } from '../loader/plugin.js';
import type { Plugin } from '../loader/plugin.js';
import type { PluginApi } from '../runtime/plugin-api.js';

// The app-glue dispatched to by core commands. All members are optional because a
// plugin command may be merged with a base command of the same name, or the host
// may not provide every glue method.
interface CoreCtx {
  setView?(view: string): void;
  showMessage?(msg: string): void;
  onExit?(): void;
  back?(): void;
  clearCache?(): void;
  runConfigCommand?(arg: string): unknown;
  runCacheCommand?(arg: string): unknown;
  setHelpModal?(open: boolean): void;
}

type BuildCoreParams = {
  renders: Record<string, unknown>;
  config: Record<string, unknown>;
  make: Make;
};

export function buildCorePlugin({ renders, config, make }: BuildCoreParams): Plugin {
  // `name` is in the shape too: PluginShape requires it, and `make` re-injects it
  // (the make arg wins) — harmless, just satisfies the type.
  return make('core', {
    name: 'core',
    commands: [
      { name: 'quit', run: (ctx) => (ctx as CoreCtx).onExit?.() },
      { name: 'clear', run: (ctx) => { (ctx as CoreCtx).clearCache?.(); (ctx as CoreCtx).showMessage?.('Cache cleared'); } },
      { name: 'config', run: (ctx, arg) => (ctx as CoreCtx).runConfigCommand?.(arg ?? '') },
      { name: 'cache', run: (ctx, arg) => (ctx as CoreCtx).runCacheCommand?.(arg ?? '') },
      { name: 'help', run: (ctx) => (ctx as CoreCtx).setHelpModal?.(true) },
    ],
    // The host's hotkeys (commandLine/quit/back/…) live in HOST_DEFAULT_KEYS — core
    // keeps its own `keys` field empty.
    keys: {},
    // The host's base views.
    views: {
      help: renders.help,
      reminder: renders.reminder,
    },
    components: {
      // Help — a self-sufficient modal on core: owns its state and input. Opened by
      // the :help command (via ctx.setHelpModal), closed by Esc/Enter/q/l. It is a
      // consumer: priority 100 when open, 0 otherwise.
      help: (api) => {
        const { ui, host } = api as PluginApi;
        return function HelpModal() {
          const { width, height } = host.useTerminalSize();
          const [helpModal, setHelpModal] = ui.useState(false);
          host.useInputHandler({
            mode: 'consume',
            priority: (ui) => ui.cmdOpen ? 0 : (helpModal ? 100 : 0),
            handler: (key) => {
              if (!helpModal) return false;
              // PgUp/PgDn and the wheel are the scroll box's; everything else is swallowed.
              if (key.name === 'escape' || key.name === 'q') setHelpModal(false);
              return true;
            },
          });
          host.store.help = { setHelpModal, helpModal };
          if (!helpModal) return null;
          return (host.viewRegistry.help as (p: Record<string, unknown>) => unknown)({ width, height, theme: host.config.theme, helpOpen: helpModal, commands: host.commandRegistry, keys: host.keys });
        };
      },
      // Reminder — a centered, top-most NON-blocking banner (like keycaps), driven
      // by services.reminder (set by the `remind` tool's timer, cleared by the
      // App-bound dismissReminder). It consumes ONLY the close keys (Esc/Enter) so
      // it never hijacks the keyboard — every other key falls through to whatever
      // was active. Priority 200 beats the modals (100) so it truly sits on top;
      // the renderer uses zIndex 20 (keycaps is 10) for the same reason.
      reminder: (api) => {
        const { ui, host } = api as PluginApi;
        const sx = host.services as { reminder?: string | null; dismissReminder?: () => void };
        return function Reminder() {
          const { width, height } = host.useTerminalSize();
          const active = !!sx.reminder;
          host.useInputHandler({
            mode: 'consume',
            priority: () => (active ? 200 : 0),
            handler: (key) => {
              if (!active) return false;
              if (key.name === 'escape' || key.name === 'return') {
                sx.dismissReminder?.();
                return true;
              }
              return false;
            },
          });
          if (!active) return null;
          return (host.viewRegistry.reminder as (p: Record<string, unknown>) => unknown)({ width, height, theme: host.config.theme, text: sx.reminder });
        };
      },
    },
  });
}

export default buildCorePlugin;