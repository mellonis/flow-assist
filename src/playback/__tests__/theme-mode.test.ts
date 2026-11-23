// The person's appearance is a MODE (`ui.theme`): `system` follows the terminal's
// light/dark scheme, `light` and `dark` pin one whatever the terminal says. What the
// palette is resolved for — the scheme — is this module's one question.
import { expect, test } from 'bun:test';
import { schemeFor } from '../theme-mode';

test('schemeFor pins and follows', () => {
  expect(schemeFor('light', 'dark')).toBe('light');
  expect(schemeFor('dark', 'light')).toBe('dark');
  expect(schemeFor('system', 'dark')).toBe('dark');
  expect(schemeFor('system', 'unknown')).toBe('unknown');
});
