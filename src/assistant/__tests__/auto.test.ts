// The auto mode's decision: which confirmation it answers for the person, and what
// the hint line and the change message say — with `shell.autoRun` off and on.
import { expect, test } from 'bun:test';
import { autoBadge, autoConfirms, autoSaid, neverAutomatic } from '../auto';

test('without shell.autoRun only `all` answers, and never for the three guarded calls', () => {
  for (const mode of ['ask', 'reads'] as const) {
    for (const name of ['notes_write', 'run_command', 'web_fetch', 'config_set']) expect(autoConfirms(mode, name, false)).toBe(false);
  }
  expect(autoConfirms('all', 'notes_write', false)).toBe(true);
  for (const name of ['run_command', 'web_fetch', 'config_set', 'x:run_command', 'x:config_set']) {
    expect({ name, auto: autoConfirms('all', name, false) }).toEqual({ name, auto: false });
  }
});

test('with shell.autoRun `all` answers the host\'s run_command too — nothing else changes', () => {
  expect(autoConfirms('all', 'run_command', true)).toBe(true);
  expect(autoConfirms('all', 'notes_write', true)).toBe(true);
  // A plugin's tool of the same name is not the host's shell.
  for (const name of ['x:run_command', 'web_fetch', 'config_set', 'x:web_fetch']) {
    expect({ name, auto: autoConfirms('all', name, true) }).toEqual({ name, auto: false });
  }
  // The key alone is not a consent: the mode has to be `all` as well.
  for (const mode of ['ask', 'reads'] as const) expect(autoConfirms(mode, 'run_command', true)).toBe(false);
  expect(neverAutomatic('run_command', true)).toBe(false);
  expect(neverAutomatic('run_command', false)).toBe(true);
});

test('the hint line says everything only when both hold', () => {
  expect(autoBadge('all', true)).toBe('auto: everything — commands run without asking');
  expect(autoBadge('all', false)).toBe('auto: writes');
  expect(autoBadge('reads', true)).toBe('auto: reads');
  expect(autoBadge('ask', true)).toBe('');
});

test('the change message names what still asks', () => {
  expect(autoSaid('all', false)).toContain('run_command, an unlisted web_fetch and config_set still ask');
  const both = autoSaid('all', true);
  expect(both).toContain('commands');
  expect(both).toContain('an unlisted web_fetch and config_set still ask');
  expect(both).not.toContain('run_command,');
  expect(autoSaid('reads', true)).toBe(autoSaid('reads', false));
});
