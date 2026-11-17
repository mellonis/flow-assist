// The person's appearance is a MODE (`ui.theme`): `system` follows the terminal's
// light/dark scheme, `light` and `dark` pin one whatever the terminal says. What the
// palette is resolved for — the scheme — is this module's one question.
import { expect, test } from 'bun:test';
import { THEME_MODES, parseThemeArg, schemeFor } from '../theme-mode';

test('schemeFor pins and follows', () => {
  expect(schemeFor('light', 'dark')).toBe('light');
  expect(schemeFor('dark', 'light')).toBe('dark');
  expect(schemeFor('system', 'dark')).toBe('dark');
  expect(schemeFor('system', 'unknown')).toBe('unknown');
});

test('parseThemeArg takes the three words and names them in its refusal', () => {
  expect(THEME_MODES).toEqual(['system', 'light', 'dark']);
  for (const mode of THEME_MODES) expect(parseThemeArg(mode)).toBe(mode);
  const refused = parseThemeArg('sepia');
  expect(refused).toHaveProperty('error');
  const message = (refused as { error: string }).error;
  for (const word of THEME_MODES) expect(message).toContain(word);
});
