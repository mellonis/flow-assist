// The surface the person reads: one canvas at a time — the header line, the tab strip
// when there is more than one, and the tree as the renderer draws it — plus the keys
// that drive it and the press that speaks to the agent.
//
// This is the `view` slot: mounted only while `keycaps` is non-empty (the person opened
// the side AND a canvas is drawn), sized by `host.useSurfaceSize()`. Everything it
// stores is the store's (`store.ts`): the surface keeps only what is between two keys —
// the focus key and the armed delete — and drops a focus key a redraw took away.
//
// The keys come through `host.useInputHandler` at the base screen's priority (50), so
// the chat's own handler (100 while it has the keys) outranks them and a keystroke
// while the chat is focused never reaches here. A focused `input`/`select` takes its
// printable keys in flowtty's own pass, before this path ever runs — which is exactly
// the design's "while a control has focus the surface's own keys do not fire".
//
// A press is a message, never an action: the button's label and every bind's value at
// press time go through `services.postToChat` — one framed plugin message the model
// answers with its own tools — and the footer says `queued` until the next redraw the
// model's answer brings.
import { fit } from './parts.ts';
import { actionOf, focusKeys, nextKey } from './focus.ts';
import { TOKEN_COLOR, toElement, type TRenderCtx, type TUi } from './render.ts';
import { deleteCanvas, formatAge, pressMessage, selectCanvas, selectedCanvas, setValue, type TCanvas, type TValue, type TStore } from './store.ts';

type TInputKey = { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean };
type TUiState = { cmdOpen?: boolean; modalActive?: boolean };

// What a live component is handed: the renderer's `ui` plus the React pieces a
// component of its own keeps state with, and `stringWidth` — the host's measure, which
// `TRenderCtx` takes beside the tree. A plugin's sources import only their types from
// each other and nothing from the host (`docs/plugins.md`, "What a plugin is given").
type TSurfaceUi = TUi & {
  useState: <T>(init: T | (() => T)) => [T, (next: T | ((prev: T) => T)) => void];
  stringWidth: (text: string) => number;
};

export type TSurfaceApi = {
  ui: TSurfaceUi;
  host: {
    useSurfaceSize: () => { width: number; height: number };
    useInputHandler: (opts: { mode?: string; priority?: (ui: TUiState) => number; handler: (key: TInputKey, ui: TUiState) => unknown; mouse?: boolean }) => void;
    hasKeyboard: () => boolean;
    services: Record<string, unknown>;
    notify: () => void;
    keyCap: (action: string) => string;
    keys?: Record<string, string[]>;
    config?: Record<string, unknown>;
  };
};

// The key map's vocabulary: the terminal's name with what was held with it. The host
// builds `host.keys` in exactly this shape (its `keyId`, `src/playback/keys.ts`), so a
// plugin matches a binding against a pressed key by building the same string — never
// by comparing a binding's spelling, which a remap would break.
const keyIdOf = (key: TInputKey): string => {
  const name = String(key.name ?? '');
  const named = Array.from(name).length !== 1;
  return `${key.ctrl === true ? 'ctrl+' : ''}${key.meta === true ? 'alt+' : ''}${key.shift === true && named ? 'shift+' : ''}${name}`;
};

// The palette the surface paints in: the plugin's named tones with the person's
// override laid over (`config.plugins.canvas.colors` lands in `theme.canvas`). The
// renderer REPLACES its default map with what it is given, so the whole map goes —
// the plugin's own tokens first, the theme's on top.
const paletteOf = (host: TSurfaceApi['host']): Record<string, string> => {
  const theme = (host.config as { theme?: { canvas?: Record<string, string> } } | undefined)?.theme;
  return { ...TOKEN_COLOR, ...(theme?.canvas ?? {}) };
};

// The header line: `canvas · «title» · owner · drawn 2m ago` — the title, or the id
// when the model drew none. The age is the store's own words (`formatAge`), so the
// header and the model's registry line never disagree about how old a canvas is.
const headerLine = (canvas: TCanvas): string => {
  const title = canvas.title !== '' ? canvas.title : canvas.id;
  const parts: string[] = ['canvas', `«${title}»`];
  if (canvas.owner !== '') parts.push(canvas.owner);
  const age = formatAge(Date.now() - canvas.updatedAt);
  parts.push(age === 'now' ? 'drawn now' : `drawn ${age} ago`);
  return parts.join(' · ');
};

const TAB_GAP = '  ';

// The tab strip, one row: the selected canvas in `[ brackets ]` (the header names it
// too, but a glance at the strip should say where the person is), the rest bare. Past
// the width the strip keeps just where they are — `‹3 of 11› [ Alpha ]` — instead of
// cutting the selected tab away.
const tabLine = (store: TStore, width: number, stringWidth: (text: string) => number): string => {
  const entries = [...store.canvases.values()];
  const at = entries.findIndex((canvas) => canvas.id === store.selectedId);
  const parts = entries.map((canvas, index) => {
    const label = canvas.title !== '' ? canvas.title : canvas.id;
    return index === at ? `[ ${label} ]` : label;
  });
  const joined = parts.join(TAB_GAP);
  if (stringWidth(joined) <= width) return joined;
  return fit(`‹${at + 1} of ${entries.length}› ${parts[at] ?? ''}`, width, stringWidth);
};

// The `component.panel` slot: always mounted, it only holds the plugin's own key —
// the one that opens the person's side and closes it again (`keys.canvas`, whose cap
// `host.keyCap('canvas')` draws). It toggles whether the surface is up; the surface
// itself appears only while there is a canvas to show.
export function canvasPanel(api: TSurfaceApi, store: TStore): () => unknown {
  const { host } = api;
  return function CanvasPanel() {
    host.useInputHandler({
      mode: 'consume',
      // A key that opens something: below an open modal (100) and the chat while it has
      // the keys (100), above nothing. The `:` line and a modal keep it entirely.
      priority: (ui: TUiState) => (ui.cmdOpen === true || ui.modalActive === true ? 0 : 10),
      handler: (key: TInputKey) => {
        const binding = host.keys?.canvas ?? [];
        if (!binding.includes(keyIdOf(key))) return false;
        store.personOpened = !store.personOpened;
        host.notify();
        return true;
      },
    });
    return null;
  };
}

// The footer's hints for the current context — the host draws them under the surface.
// Only while the side is up (their presence is what mounts the surface), and the key a
// hint names comes from the resolved binding, never spelled here: the person may
// remap it. The surface's own keys are fixed (`tab`, `[`, `]`, `x`, `esc`), so their
// caps are written as they are printed. `press queued` is the design's word for a
// press waiting in the inbox — never silently swallowed.
export function canvasKeycaps(api: { host: { keyCap(action: string): string } }, store: TStore): string[] {
  if (!store.personOpened || store.canvases.size === 0) return [];
  const hints: string[] = [];
  const cap = api.host.keyCap('canvas');
  if (cap !== '') hints.push(`${cap} canvas`);
  hints.push('tab focus');
  if (store.canvases.size > 1) hints.push('[ ] canvases');
  hints.push('x x delete');
  hints.push('esc close');
  if (store.pressed !== null) hints.push('press queued');
  return hints;
}

// The `component.view` slot: one canvas, its keys, and the press. The factory runs
// once — the component is mounted for as long as the side is up.
export function canvasView(api: TSurfaceApi, store: TStore): () => unknown {
  const { ui, host } = api;
  return function CanvasView() {
    const { width, height } = host.useSurfaceSize();
    // Read while drawing: the host redraws when it changes, and it is what gates a
    // control's own key-taking (`isFocused`) and the body's scrolling.
    const hasKeyboard = host.hasKeyboard();
    const [focusKey, setFocusKey] = ui.useState<string | null>(null);
    const [armed, setArmed] = ui.useState<boolean>(false);
    const canvas = selectedCanvas(store);
    // The keycaps promise a canvas is drawn, but a delete can empty the registry
    // between two frames: with none there is nothing to draw, and the host unmounts.
    if (canvas === undefined) return null;
    // A held focus key a redraw took away (a rebuilt tree, one button fewer) is dropped
    // on this render — kept, `actionOf` would press nothing and `x`/`[`/`]` would stand
    // down for a control that is no longer there.
    const keys = focusKeys(canvas.tree);
    const focus = focusKey !== null && keys.includes(focusKey) ? focusKey : null;
    if (focus !== focusKey) setFocusKey(focus);

    // A press is one message to the agent: the framed press text — the button's label
    // and every bind's value at press time — with the button's action sentence after
    // it, verbatim. Nothing is executed here: the model answers with its tools, and
    // every write still pauses on its y/n.
    const press = (label: string, action: string): void => {
      const current = selectedCanvas(store);
      if (current === undefined) return;
      const message = pressMessage(current, label);
      const text = action === '' ? message : `${message}\naction: ${action}`;
      const postToChat = (host.services as { postToChat?: (text: string) => void }).postToChat;
      postToChat?.(text);
      // The press waits in the inbox while a turn runs: the footer says so until the
      // redraw the model's answer brings clears it (`drawCanvas`), and another
      // canvas's press keeps waiting when one canvas is deleted.
      store.pressed = current.id;
      host.notify();
    };

    host.useInputHandler({
      mode: 'consume',
      // The base screen's priority (docs/plugins.md, "Commands, keys and the footer"):
      // below an open modal, and below the chat while it holds the keyboard.
      priority: () => 50,
      mouse: true,
      handler: (key: TInputKey) => {
        const current = selectedCanvas(store);
        if (current === undefined) return false;
        const name = String(key.name ?? '');
        if (name === 'tab') {
          const cycle = focusKeys(current.tree);
          if (cycle.length === 0 && focus === null) return false;
          setFocusKey(nextKey(cycle, focus, key.shift === true ? -1 : 1));
          setArmed(false);
          return true;
        }
        if (name === 'escape') {
          // Esc leaves a control first, and only then closes the person's side.
          if (focus !== null) {
            setFocusKey(null);
            setArmed(false);
            return true;
          }
          store.personOpened = false;
          setArmed(false);
          host.notify();
          return true;
        }
        const button = focus === null ? null : actionOf(current.tree, focus);
        if ((name === 'return' || name === ' ') && button !== null) {
          setArmed(false);
          press(button.label, button.action);
          return true;
        }
        // With a control focused the surface's own keys stand down: what is typed is
        // the control's. A field eats its printable keys before this path runs; a
        // checkbox or a select does not, so the rule is checked here too.
        if (focus !== null) return false;
        const ids = [...store.canvases.keys()];
        if (name === ']' || name === '[') {
          // The tabs in draw order, wrapping — not a neighbour of the selection the
          // store fell back to after a delete (it keeps the oldest surviving one).
          const at = ids.indexOf(current.id);
          const next = ids[(at + (name === ']' ? 1 : -1) + ids.length) % ids.length];
          if (next !== undefined) selectCanvas(store, next);
          setArmed(false);
          host.notify();
          return true;
        }
        if (name === 'x') {
          if (!armed) {
            setArmed(true);
            return true;
          }
          setArmed(false);
          deleteCanvas(store, current.id);
          host.notify();
          return true;
        }
        return false;
      },
    });

    const header = headerLine(canvas) + (armed ? ' — press x again to delete' : '');
    const body = toElement(canvas.tree, {
      ui,
      width,
      stringWidth: ui.stringWidth,
      focusKey: focus,
      hasKeyboard,
      values: canvas.values,
      onValue: (bind: string, value: TValue) => {
        // A controlled field takes its value back through the store on every edit, and
        // nothing else redraws the view: the host redraws the keys it handled, and this
        // edit arrives in flowtty's own pass. Without the redraw the next keystroke is
        // computed against a stale value and clobbers the typing (the remote plugin's
        // `fieldState` guards exactly this).
        setValue(store, canvas.id, bind, value);
        host.notify();
      },
      onPress: press,
      colors: paletteOf(host),
    } satisfies TRenderCtx);
    // Keys on the rows: the tab strip appears and disappears as canvases come and go,
    // and a row without a key would drag the body's controls through a remount — the
    // caret of a field being typed into included.
    return ui.h(ui.Box, { width, height, flexDirection: 'column' },
      ui.h(ui.Text, { key: 'canvas-header', dim: true }, fit(header, width, ui.stringWidth)),
      ...(store.canvases.size > 1 ? [ui.h(ui.Text, { key: 'canvas-tabs', dim: true }, tabLine(store, width, ui.stringWidth))] : []),
      ui.h(ui.ScrollBox, { key: 'canvas-body', height: Math.max(1, height - 3), isActive: hasKeyboard }, body),
    );
  };
}
