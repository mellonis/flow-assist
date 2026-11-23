// The person's appearance, over the terminal's own: `ui.theme` names a MODE, and the
// palette is resolved for the SCHEME that mode answers (src/playback/theme.ts,
// `themeFor`). `system` follows the terminal — macOS switches light and dark by itself
// and the terminal follows — while `light` and `dark` pin one whatever the terminal
// says.

import type { ColorScheme } from './theme.js';

export type ThemeMode = 'system' | 'light' | 'dark';

// The scheme a mode answers: a pinned mode answers its own, `system` the terminal's.
export function schemeFor(mode: ThemeMode, terminal: ColorScheme): ColorScheme {
  return mode === 'system' ? terminal : mode;
}
