import { expect, test } from 'bun:test';
import { localeFromEnv } from '../locale';

test('the locale is read the way gettext reads it, and turned into a tag', () => {
  expect(localeFromEnv({ FLOW_ASSIST_LOCALE: 'ru' })).toBe('ru');
  expect(localeFromEnv({ FLOW_ASSIST_LOCALE: 'ru', LANG: 'en_US.UTF-8' })).toBe('ru');
  expect(localeFromEnv({ LC_ALL: 'ru_RU.UTF-8', LANG: 'en_US.UTF-8' })).toBe('ru-RU');
  expect(localeFromEnv({ LC_MESSAGES: 'de_DE', LANG: 'en_US.UTF-8' })).toBe('de-DE');
  expect(localeFromEnv({ LANG: 'en_US.UTF-8' })).toBe('en-US');
  expect(localeFromEnv({ LANG: 'C' })).toBeUndefined();
  expect(localeFromEnv({ LC_ALL: 'POSIX', LANG: 'ru_RU' })).toBeUndefined(); // LC_ALL wins, and says none
  expect(localeFromEnv({ LANG: '' })).toBeUndefined();
  expect(localeFromEnv({})).toBeUndefined();
  expect(localeFromEnv({ LANG: 'sr_RS@latin' })).toBe('sr-RS'); // a modifier is dropped
});
