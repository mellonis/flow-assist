// Plugin «keycaps»: an observer-«keyboard» — a panel with the last pressed keys
// (like the keycaps on YouTube screencasts). mode:'observe' — sees every key
// without consuming it.

import { z } from 'zod';
import type { Make } from '../loader/plugin.js';
import type { Plugin } from '../loader/plugin.js';
import { isMouseButton, keyGlyph } from '../playback/keys.js';

// The app-glue dispatched to by the :keycaps command.
interface KeycapsCtx {
  toggleKeycaps?(arg?: string): unknown;
}

// The `ft` runtime the keycaps component receives (typed by shape).
interface KeycapsFT {
  useState<T>(init: T): [T, (v: T | ((prev: T) => T)) => void];
  useInputHandler(opts: {
    mode: 'observe';
    priority: () => number;
    handler: (key: { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) => void;
  }): void;
  store: Record<string, unknown>;
  services: Record<string, unknown>;
  config: Record<string, unknown>;
  h: (...args: unknown[]) => unknown;
  Box: unknown;
  Text: unknown;
}

type BuildKeycapsParams = {
  renders: Record<string, unknown>;
  config: Record<string, unknown>;
  make: Make;
};

export function buildKeycapsPlugin({ renders, config, make }: BuildKeycapsParams): Plugin {
  return make('keycaps', {
    name: 'keycaps',
    commands: [
      { name: 'keycaps', run: (ctx, arg) => (ctx as KeycapsCtx).toggleKeycaps?.(arg ?? ''), usage: 'keycaps [on|off]', minArgs: 0, maxArgs: 1, description: 'Show/hide the panel of the last pressed keys' },
    ],
    keys: {},
    views: {},
    // The panel's own palette (not a modal, so not MODAL_COLOR_DEFAULTS): via the
    // generic non-modal plugin pass-through it becomes theme.keycaps, like the board
    // theme.board. Override — config.plugins.keycaps.colors.bg (and .text for the ink;
    // without it the modal base's text color). A `${token}`, not a literal: the
    // panel follows the terminal between light and dark.
    colors: { bg: '${panelBg}' },
    // Schema of the config.plugins.keycaps namespace: enabled — show the panel at
    // startup, colors — palette override (→ theme.keycaps).
    configSchema: z.object({ enabled: z.boolean().optional(), colors: z.record(z.string(), z.unknown()).optional() }).optional(),
    components: {
      keycaps: (ft) => {
        const f = ft as KeycapsFT;
        return function Keycaps() {
          // Default from the plugin config (config.plugins.keycaps.enabled) or hidden.
          const initEnabled = !!(f.config as Record<string, any>)?.plugins?.keycaps?.enabled;
          const [enabled, setEnabled] = f.useState(initEnabled);
          const [recent, setRecent] = f.useState<string[]>([]);
          f.useInputHandler({
            mode: 'observe',
            priority: () => 1000,
            // The cap is what is printed on the key — ⏎, ␣, ^r — not the terminal's name
            // for it: 'return' reads as a word, and ' ' drew an EMPTY cap. The panel is
            // for someone watching a screen, who knows keys by their caps.
            // The wheel is not a key: one flick is a dozen events and would flush the panel.
            // Nor is a drag, one event per cell crossed (the host stops mouse buttons
            // before dispatch; this says so where the panel is).
            handler: (key) => { if (enabled && !key.name.startsWith('wheel') && !isMouseButton(key.name)) setRecent(r => [...r, keyGlyph(key)].slice(-6)); },
          });
          // API for the :keycaps command — toggles/enables/disables the panel. Reads
          // `enabled` from the latest render (the toggle is recreated each render).
          (f.store as Record<string, any>).keycaps = {
            enabled,
            setEnabled,
            toggle: (arg: string) => {
              const v = String(arg ?? '').trim().toLowerCase();
              const next = v === 'off' ? false : v === 'on' ? true : !enabled;
              setEnabled(next);
              (f.services as Record<string, any>).showMessage?.(`Keycaps ${next ? 'enabled' : 'disabled'}`);
            },
          };
          if (!enabled || !recent.length) return null;
          // Panel fill is its own theme.keycaps palette (colors above), not another
          // modal's: otherwise an override of config.plugins.log.colors.bg would paint
          // keycaps for nothing. Without a palette the panel is transparent and the
          // frame is unreadable. Fallback — the abstract modal base theme.modals.bg.
          const cfg = f.config as Record<string, any>;
          const panelBg = cfg?.theme?.keycaps?.bg ?? cfg?.theme?.modals?.bg;
          // The ink goes with the ground: the caps and the frame inherit it, so a light
          // terminal theme does not draw them black on the dark fill.
          const panelText = cfg?.theme?.keycaps?.text ?? cfg?.theme?.modals?.text;
          // flowtty frame prop is `border` (not borderStyle); 'round' is the default,
          // but we set it explicitly. Inner «keys» are also frames, single.
          const caps = recent.map((k, i) =>
            (f.h as (...args: unknown[]) => unknown)(f.Box, { key: `${k}-${i}`, border: 'single', paddingX: 1 },
              (f.h as (...args: unknown[]) => unknown)(f.Text, {}, k)),
          );
          return (f.h as (...args: unknown[]) => unknown)(f.Box, {
            position: 'absolute', bottom: 1, right: 1, flexDirection: 'column',
            border: 'round', borderTitle: 'keycaps', paddingX: 1, zIndex: 10, backgroundColor: panelBg, color: panelText,
            // Floats over whatever is on screen: a drag across it copies no cap.
            selectable: false,
          },
            (f.h as (...args: unknown[]) => unknown)(f.Box, { flexDirection: 'row' }, caps),
          );
        };
      },
    },
  });
}

export default buildKeycapsPlugin;