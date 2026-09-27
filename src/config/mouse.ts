// What the host asks the terminal to report of the mouse, from `ui.mouse` and
// `ui.hover` — read once, when the backend is opened; the chat reads the same answer
// to know whether its rows are drawn with hover.

// Whether the terminal reports the mouse to the app — the wheel, and the drag that
// selects and copies (flowtty's copy-on-select, wired in runtime/app.tsx). On unless
// `ui.mouse` is explicitly false: some people will rather have the terminal's own
// selection back.
export function mouseEnabled(config: Record<string, unknown>): boolean {
  return (config.ui as { mouse?: unknown } | undefined)?.mouse !== false;
}

// Whether the pointer's moves are reported too, so what a click acts on is underlined
// under it: with the mouse, unless `ui.hover` is explicitly false — any-event tracking
// sends a report for every cell the pointer crosses, which a slow link or a terminal
// that reports motion badly feels.
export function hoverEnabled(config: Record<string, unknown>): boolean {
  return mouseEnabled(config) && (config.ui as { hover?: unknown } | undefined)?.hover !== false;
}

// The TTY backend's `mouse` option for this config.
export function mouseOption(config: Record<string, unknown>): boolean | { hover: true } {
  return hoverEnabled(config) ? { hover: true } : mouseEnabled(config);
}
