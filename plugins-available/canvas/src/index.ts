// Canvas plugin builder — the `canvas` tool group, the screen its navigation tools
// open, what the model reads back (one context item per canvas, then the selected
// canvas's outline), and the surface: `keycaps` mounts it only while the person opened
// the side and a canvas is drawn, `components.view` draws it, `components.panel` (always
// mounted) holds the key that opens and closes the side (docs/plugins.md, "Screens").
//
// `Make` mirrors the host's `make(name, shape)` (src/loader/plugin.ts): it fills the
// name, the plugin's config slice and its keys into the shape the builder returns.
// It is restated here, and so is the slice of `host` this builder reads — a plugin's
// typechecked sources stay under its own rootDir (src/runtime/plugin-api.ts is where
// the real `PluginApi` lives).
import { createStore, outline, registryItems, selectCanvas, selectedCanvas } from './store.ts';
import { buildGroup, SHOW_SCREEN, missingCanvas } from './tools.ts';
import { TOKEN_COLOR } from './render.ts';
import { canvasKeycaps, canvasPanel, canvasView, type TSurfaceApi } from './view.ts';
import type { TStore } from './store.ts';

type Make = (name: string, shape: Record<string, unknown>) => Record<string, unknown>;
type THost = {
  store: Record<string, unknown>;
  notify: () => void;
  services: { showMessage?: (text: string) => void };
  open?: (screen: string, params?: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
};
type TApi = { host: THost };

export default function buildCanvasPlugin({ config, make, z }: { config?: unknown; make: Make; z: unknown }): unknown {
  // One store for the run, made once — before the group is built, and put on
  // `host.store.canvas` in `setup`, the channel the host hands a plugin's components.
  const store: TStore = createStore();
  const now = () => Date.now();
  // What the group asks the host to do. `host` arrives in `setup`, later than the
  // shape, so the deps resolve it when they are called, never when they are built.
  let host: THost | undefined;
  const group = buildGroup({
    store,
    now,
    notify: () => host?.notify(),
    note: (text) => host?.services.showMessage?.(text),
    open: (screen, params) => host?.open?.(screen, params),
  });

  // The screen the navigation tools open: it selects the canvas it was given and
  // marks the person's side as up, which is what the surface's keycaps read (the
  // host mounts a plugin's surface only while its keycaps say its context is active).
  const showScreen = (_api: unknown, params: Record<string, unknown>): string => {
    const id = typeof params.canvas === 'string' ? params.canvas.trim() : '';
    if (id !== '' && !selectCanvas(store, id)) throw new Error(missingCanvas(id));
    const selected = selectedCanvas(store);
    if (selected === undefined) throw new Error('no canvas is drawn yet — canvas_draw draws one');
    store.personOpened = true;
    return `canvas «${selected.id}»`;
  };
  const hideScreen = (): void => { store.personOpened = false; };

  // The person's screens as the model reads them: one short item per canvas (capped
  // by `registryItems` for the chat's shared context budget), then, for the selected
  // canvas only, its outline — which carries every bind's CURRENT value, so a session
  // that did not draw the canvas still sees what was typed into it.
  const chatContext = (): Array<{ label: string; text: string }> => {
    const selected = selectedCanvas(store);
    return [
      ...registryItems(store, now),
      ...(selected === undefined
        ? []
        : [{ label: selected.title !== '' ? selected.title : `Outline: «${selected.id}»`, text: outline(selected) }]),
    ];
  };

  return make('canvas', {
    name: 'canvas',
    // The canvas palette: the vocabulary's tones as the named colours flowtty paints
    // in. The host resolves it into `theme.canvas`, a person overrides an entry with
    // `config.plugins.canvas.colors`, and the surface hands the resolved map to the
    // renderer's ctx.
    colors: TOKEN_COLOR,
    // The action the person's side opens on: its cap is drawn in the footer hints, and
    // `components.panel` answers the key it is bound to now — never a letter written
    // here, since the person may remap it (`config.keys.canvas`).
    keys: { canvas: 'C' },
    keycaps: (api: unknown) => canvasKeycaps(api as { host: { keyCap(action: string): string } }, store),
    components: {
      view: (api: unknown) => canvasView(api as TSurfaceApi, store),
      panel: (api: unknown) => canvasPanel(api as TSurfaceApi, store),
    },
    tools: [group],
    screens: {
      [SHOW_SCREEN]: {
        entry: true,
        title: 'canvas',
        params: {
          type: 'object',
          properties: { canvas: { type: 'string', description: 'The canvas to show — canvas_list names them.' } },
        },
        tools: ['canvas_open', 'canvas_focus'],
        open: showScreen,
        close: hideScreen,
      },
    },
    setup: (api: TApi) => {
      host = api.host;
      api.host.store.canvas = store;
    },
    chatContext,
  });
}
