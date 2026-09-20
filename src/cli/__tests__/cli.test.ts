import { expect, test } from 'bun:test';
import { mouseEnabled, parseCli } from '../../cli';
import { hostConfigSchema } from '../../config/schema';
import { validateConfigWriteValue } from '../../config/load';

test('the wheel is reported unless ui.mouse is explicitly false, and the key can be set', () => {
  expect(mouseEnabled({})).toBe(true);
  expect(mouseEnabled({ ui: {} })).toBe(true);
  expect(mouseEnabled({ ui: { mouse: true } })).toBe(true);
  // The way back to the terminal's own drag-to-select.
  expect(mouseEnabled({ ui: { mouse: false } })).toBe(false);
  expect(validateConfigWriteValue(hostConfigSchema, 'ui.mouse', false).ok).toBe(true);
  expect(validateConfigWriteValue(hostConfigSchema, 'ui.mouse', 'sometimes').ok).toBe(false);
});

test('parseCli maps argv to a subcommand', () => {
  expect(parseCli(['config', 'get', 'ai.model'])).toEqual({ cmd: 'config', args: ['get', 'ai.model'] });
  expect(parseCli(['plugins', 'ls'])).toEqual({ cmd: 'plugins', args: ['ls'] });
  expect(parseCli(['plugins', 'update', 'tracker'])).toEqual({ cmd: 'plugins', args: ['update', 'tracker'] });
  expect(parseCli([])).toEqual({ cmd: 'interactive', args: [] });
  expect(parseCli(['what is the status of ABC-123'])).toEqual({ cmd: 'prompt', args: ['what is the status of ABC-123'] });
});