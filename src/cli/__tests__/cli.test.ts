import { expect, test } from 'bun:test';
import { interactiveRefusal, mouseEnabled, parseCli } from '../../cli';
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
test('the interactive screen is refused without a terminal, in a sentence — not a stack trace', () => {
  const yes = () => true;
  const no = () => false;
  // A terminal on both ends: go ahead.
  expect(interactiveRefusal({ isTTY: true }, { isTTY: true }, yes)).toBeNull();
  // stdout is a pipe / CI / TERM=dumb: flowtty's TtyBackend would throw.
  const piped = interactiveRefusal({ isTTY: false }, { isTTY: true }, no)!;
  expect(piped).toContain('needs a terminal');
  // The way that DOES work without one is named.
  expect(piped).toContain('flow-assist "your question"');
  // stdin redirected: keys cannot arrive, and the app used to quit at once, silently.
  expect(interactiveRefusal({ isTTY: true }, { isTTY: false }, yes)).toContain('needs a terminal');
});
