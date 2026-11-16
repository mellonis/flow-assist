// Where the chat sits, and how much of the terminal a plugin's screen is left with.
// Pure: the App lays the screen out with it, the chat reads the result (its side,
// its place for a click), and a test can ask it without drawing anything.
//
// Three modes (`plugins.assistant.mode`, `/mode` for the session):
//   - `panel` (the default) — docked beside the plugin's screen, both visible. The
//     plugin's screen is laid out in what remains, as on a smaller terminal.
//   - `window` — a window over the plugin's screen, which steps back behind it.
//   - `full` — the whole terminal.
// A config written before the modes existed says `fullscreen: true`; it reads as `full`.

export type ChatMode = 'panel' | 'window' | 'full';
export type PanelSide = 'right' | 'bottom';

export const CHAT_MODES: readonly ChatMode[] = ['panel', 'window', 'full'];

// Below this many columns a right panel would leave either side a sliver, so it goes
// to the bottom by itself.
export const RIGHT_PANEL_MIN_COLS = 120;
// How much of the terminal the panel takes by default, in percent: of the width on the
// right, of the height at the bottom.
export const PANEL_SIZE_DEFAULT: Record<PanelSide, number> = { right: 35, bottom: 40 };
// The least a panel is given, and the least it leaves the plugin: a bottom panel needs
// its frame, the status line, the field and a few rows of conversation; a plugin's
// screen needs its title bar and its footer around a few rows of its own.
const MIN_PANEL: Record<PanelSide, number> = { right: 40, bottom: 12 };
const MIN_REST: Record<PanelSide, number> = { right: 60, bottom: 10 };
// The rows a panel's chat needs whichever side it is on (a right panel has the whole
// height, and needs this much of it).
const MIN_PANEL_ROWS = MIN_PANEL.bottom;

// The host's chrome around a plugin's surface: the title bar and the footer are one
// row of text each inside `padding: 1` (the App's render) — three rows apiece.
export const TITLE_ROWS = 3;
export const FOOTER_ROWS = 3;
// The least a plugin's side can be and still be one: its title bar, its footer and one
// row of its own between them. A terminal that cannot give the panel its least AND the
// plugin this is too small to dock on: the chat is drawn as a window there (`fits`).
export const PLUGIN_MIN_ROWS = TITLE_ROWS + FOOTER_ROWS + 1;

export interface AssistantLayoutConfig {
  mode?: unknown;
  fullscreen?: unknown;
  panel?: { side?: unknown; size?: unknown } | null;
}

// The mode a conversation starts in: the config's `mode`, else an old `fullscreen: true`
// as `full`, else the panel.
export function chatModeOf(cfg: AssistantLayoutConfig | undefined): ChatMode {
  const mode = cfg?.mode;
  if (mode === 'panel' || mode === 'window' || mode === 'full') return mode;
  return cfg?.fullscreen === true ? 'full' : 'panel';
}

export interface Rect { left: number; top: number; width: number; height: number }
export interface PanelLayout {
  side: PanelSide;
  // The plugin's side of the screen: title bar, surface and footer. Always at the
  // terminal's top-left corner.
  region: Rect;
  // The chat's. Collapsed on the right it has no width at all; collapsed at the bottom
  // it is one row, the turn's status.
  panel: Rect;
  collapsed: boolean;
  // Whether the terminal has room to dock at all — the panel's least beside the
  // plugin's (`PLUGIN_MIN_ROWS`). When it has not, the App draws the chat as a window
  // for this size (the config still says panel; a terminal grown back docks it again),
  // and the rects above are not used. Collapsed or not, the size alone decides it.
  fits: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// `need`: the rows the open chat needs right now — a question or a y/n it must show
// whole (0 otherwise). A bottom panel grows to it, as far as the plugin's least allows;
// past that, or past a right panel's whole height, it does not fit, and the chat is a
// window until the question is answered.
export function panelLayout({ width, height, side, size, collapsed = false, need = 0 }: {
  width: number;
  height: number;
  side?: unknown;
  size?: unknown;
  collapsed?: boolean;
  need?: number;
}): PanelLayout {
  const wanted: PanelSide = side === 'bottom' ? 'bottom' : 'right';
  const s: PanelSide = wanted === 'right' && width < RIGHT_PANEL_MIN_COLS ? 'bottom' : wanted;
  // A size is a percentage of the side's own dimension; one set for the right is still
  // a percentage when the panel went to the bottom, which is what a person set it for.
  const pct = typeof size === 'number' && size > 0 && size < 100 ? size : PANEL_SIZE_DEFAULT[s];
  if (s === 'right') {
    const full = clamp(Math.round((width * pct) / 100), Math.min(MIN_PANEL.right, width), Math.max(0, width - MIN_REST.right));
    const w = collapsed ? 0 : full;
    const fits = height >= Math.max(MIN_PANEL_ROWS, PLUGIN_MIN_ROWS, need);
    return { side: s, collapsed, fits, region: { left: 0, top: 0, width: width - w, height }, panel: { left: width - w, top: 0, width: w, height } };
  }
  // The panel's least wins over the plugin's preferred rest (`MIN_REST`) — and when
  // even the plugin's bare least is not left beside it, nothing is docked.
  const full = Math.max(need, clamp(Math.round((height * pct) / 100), Math.min(MIN_PANEL.bottom, height), Math.max(1, height - MIN_REST.bottom)));
  const fits = height - full >= PLUGIN_MIN_ROWS;
  const h = collapsed ? 1 : full;
  return { side: s, collapsed, fits, region: { left: 0, top: 0, width, height: height - h }, panel: { left: 0, top: height - h, width, height: h } };
}

// Where the chat's conversation column and the /diff panel go inside the chat's
// content rect (inside the frame, above the field strip).
export interface DiffPanelLayout {
  mode: 'side' | 'stacked';
  chat: { width: number; height: number };
  diff: { width: number; height: number };
}
export const DIFF_SIDE_MIN_COLS = 50; // a side split never squeezes a half under this

// Wide enough for a 1-column gap and two halves of at least `DIFF_SIDE_MIN_COLS`
// each, and tall enough for the conversation's least rows, the split is side by
// side: the chat takes the odd column, both halves the full height. Stacked, the
// panel takes half the rows left after the field strip, never more than that
// leaves the conversation its least; below two rows it is 0 — a one-row panel has
// no usable box inside its frame — and a 0 is read as "draw nothing" (the `fits`
// precedent in `panelLayout`).
export function diffPanelLayout({ width, height, fieldRows, minChatRows = 4 }: {
  width: number;       // the chat's content width (boxW - 4)
  height: number;      // rows available to the split (boxH - 4 - chrome rows below/around)
  fieldRows: number;   // rows the field strip takes when stacked (0 ignored in side mode)
  minChatRows?: number; // the conversation keeps at least this many rows (default 4)
}): DiffPanelLayout {
  if (width >= 2 * DIFF_SIDE_MIN_COLS + 1 && height >= minChatRows) {
    const chat = Math.ceil((width - 1) / 2);
    return { mode: 'side', chat: { width: chat, height }, diff: { width: width - 1 - chat, height } };
  }
  const rest = height - fieldRows;
  const half = Math.min(Math.floor(rest / 2), rest - minChatRows);
  const panel = half < 2 ? 0 : half;
  return { mode: 'stacked', chat: { width, height: rest - panel }, diff: { width, height: panel } };
}

export const inRect = (r: Rect, x: number, y: number) => x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;
