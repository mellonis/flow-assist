import { expect, test } from 'bun:test';
import { parseCli } from '../../cli';

test('parseCli maps argv to a subcommand', () => {
  expect(parseCli(['config', 'get', 'ai.model'])).toEqual({ cmd: 'config', args: ['get', 'ai.model'] });
  expect(parseCli(['plugins', 'ls'])).toEqual({ cmd: 'plugins', args: ['ls'] });
  expect(parseCli(['plugins', 'update', 'tracker'])).toEqual({ cmd: 'plugins', args: ['update', 'tracker'] });
  expect(parseCli([])).toEqual({ cmd: 'interactive', args: [] });
  expect(parseCli(['what is the status of ABC-123'])).toEqual({ cmd: 'prompt', args: ['what is the status of ABC-123'] });
});