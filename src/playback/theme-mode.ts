// The person's appearance, over the terminal's own: `ui.theme` and the chat's picker
// name a MODE, and the palette is resolved for the SCHEME that mode answers
// (src/playback/theme.ts, `themeFor`). `system` follows the terminal — macOS switches
// light and dark by itself and the terminal follows — while `light` and `dark` pin one
// whatever the terminal says.

import type { ColorScheme } from './theme.js';

export type ThemeMode = 'system' | 'light' | 'dark';

// Every mode, in the order a picker lists them.
export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

// The mode a command's argument names, or the line saying what the words are.
export function parseThemeArg(arg: string): ThemeMode | { error: string } {
  const word = String(arg ?? '').trim();
  const mode = THEME_MODES.find((m) => m === word);
  if (mode) return mode;
  return { error: `theme: ${word || 'nothing'} is not a mode — ${THEME_MODES.join(', ')}` };
}

// The scheme a mode answers: a pinned mode answers its own, `system` the terminal's.
export function schemeFor(mode: ThemeMode, terminal: ColorScheme): ColorScheme {
  return mode === 'system' ? terminal : mode;
}
