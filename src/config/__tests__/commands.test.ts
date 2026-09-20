import { expect, test } from 'bun:test';
import { BASE_COMMANDS, parseCommand, validateCommand, argCount, findCommand } from '../commands';

test('BASE_COMMANDS has only generic host commands', () => {
  const names = BASE_COMMANDS.map(c => c.name);
  expect(names).toEqual(expect.arrayContaining(['view', 'quit', 'back', 'clear', 'config', 'cache', 'help']));
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