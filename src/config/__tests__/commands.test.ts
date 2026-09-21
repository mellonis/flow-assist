import { expect, test } from 'bun:test';
import { BASE_COMMANDS, parseCommand, validateCommand, argCount, findCommand } from '../commands';

test('BASE_COMMANDS has only generic host commands', () => {
  const names = BASE_COMMANDS.map(c => c.name);
  expect(names.sort()).toEqual(['cache', 'clear', 'config', 'help', 'quit']);
  // `view` and `back` set a state nothing in the host reads: listed, and silent.
  expect(names).not.toContain('view');
  expect(names).not.toContain('back');
  // The host's UI is English throughout.
  for (const c of BASE_COMMANDS) expect(c.description).not.toMatch(/[а-яё]/i);
  expect(names).not.toContain('open');
  expect(names).not.toContain('search');
});

test('parseCommand splits name and rawArgs', () => {
  const p = parseCommand('config set ai.model gpt');
  expect(p!.name).toBe('config');
  expect(p!.rawArgs).toBe('set ai.model gpt');
});

test('validateCommand checks arity and returns null when ok', () => {
  const cmd = findCommand('help')!;
  expect(validateCommand(cmd, 0)).toBeNull();
  expect(validateCommand({ ...cmd, minArgs: 1 }, 0)).toMatch(/Not enough arguments/);
});

test('argCount counts whitespace-separated words', () => {
  expect(argCount('a b  c')).toBe(3);
});