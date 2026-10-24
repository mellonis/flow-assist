import { expect, test } from 'bun:test';
import { agentPluginsOf } from '../agent-plugins.ts';

const plugins = [
  { name: 'core', dir: '/p/core' },
  { name: 'kit', dir: '/p/kit' },
  { name: 'off', dir: '/p/off' },
  { name: 'wait', dir: '/p/wait' },
  { name: 'nodir' },
];

test('a plugin offers agents unless it is built in, disabled in this run, untrusted or has no directory', () => {
  const skip = { builtins: ['core'], disabled: new Set(['off']), untrusted: [{ name: 'wait' }] };
  expect(agentPluginsOf(plugins, skip)).toEqual([{ name: 'kit', dir: '/p/kit' }]);
  expect(agentPluginsOf(plugins, { ...skip, disabled: new Set() }).map((p) => p.name)).toEqual(['kit', 'off']);
});
