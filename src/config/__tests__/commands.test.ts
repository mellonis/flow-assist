import { expect, test } from 'bun:test';
import { stringWidth } from '@flowtty/core';
import { BASE_COMMANDS, completeCommand, parseCommand, validateCommand, argCount, findCommand, helpText } from '../commands';

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

test('a command that declares values has its first argument completed from them', () => {
  const got: string[] = [];
  const cmds = [
    ...BASE_COMMANDS,
    { name: 'mode', usage: 'mode <where>', minArgs: 1, maxArgs: 1, description: 'Move', values: ['panel', 'window', 'full'] },
    // A function is read when the line is drawn — for a list that changes — and a
    // value may carry a label, shown beside its word.
    { name: 'open', usage: 'open <n>', minArgs: 1, maxArgs: 1, description: 'Open', values: () => { got.push('asked'); return [{ value: '1', label: 'first' }, '2']; } },
  ];
  expect(completeCommand('mode ', cmds)).toMatchObject({ head: '', hasSpace: true, best: 'panel', candidates: ['panel', 'window', 'full'] });
  expect(completeCommand('mode wi', cmds)).toMatchObject({ head: 'wi', best: 'window', candidates: ['window'] });
  // Typed whole: nothing is left to offer (the walk from `mode ` is how the values
  // are stepped through).
  expect(completeCommand('mode panel', cmds)).toMatchObject({ head: 'panel', best: 'panel', candidates: ['panel'] });
  // The values are the first argument's only.
  expect(completeCommand('mode panel x', cmds).candidates).toEqual([]);
  const open = completeCommand('open ', cmds);
  expect(open.candidates).toEqual(['1', '2']);
  expect(open.labels).toEqual({ '1': 'first' });
  expect(got).toEqual(['asked']);
  // A command with no values still gets none for its argument.
  expect(completeCommand('help ', cmds).candidates).toEqual([]);
  // A function that throws is an empty list, not a broken line.
  expect(completeCommand('x ', [{ name: 'x', usage: 'x', minArgs: 0, maxArgs: 1, description: '', values: () => { throw new Error('no'); } }]).candidates).toEqual([]);
});
// A plugin's usage may carry a flag or a ZWJ sequence: one cluster, two cells. The
// descriptions start in one column, counted in cells, not in UTF-16 units.
test('helpText pads usage to one column by cells', () => {
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
  const flag = '\u{1F1F7}\u{1F1FA}';
  const lines = helpText([
    { name: 'a', usage: `a ${family}`, description: 'first' },
    { name: 'b', usage: `b ${flag}`, description: 'second' },
    { name: 'c', usage: 'c', description: 'third' },
  ] as never).split('\n');
  for (const [i, d] of [[0, 'first'], [1, 'second'], [2, 'third']] as const) {
    const line = lines[i]!;
    expect(stringWidth(line.slice(0, line.indexOf(d)))).toBe(25);
  }
});
