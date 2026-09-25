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

// `--session` is a flag, not a key: the key after it completes as it does without it,
// and the flag itself is offered where a key would start with `-`.
test('config set --session completes the key after the flag, and offers the flag', () => {
  const cfg = { ui: { verbs: ['x'] } };
  const key = completeCommand('config set --session ui.v', BASE_COMMANDS, cfg);
  expect(key).toMatchObject({ head: 'ui.v', best: 'ui.verbs' });
  const flag = completeCommand('config set --se', BASE_COMMANDS, cfg);
  expect(flag).toMatchObject({ head: '--se', best: '--session', candidates: ['--session'] });
  // A value after the flag and the key completes like any other value.
  expect(completeCommand('config set --session cache.enabled t', BASE_COMMANDS, { cache: { enabled: true } })).toMatchObject({ best: 'true' });
});

test('the words after `config` read the same on the line and in the CLI', async () => {
  const { parseConfigArgs, unquoteValue, describeConfigValue } = await import('../commands');
  expect(parseConfigArgs(['set', '--session', 'ui.verbs', '["a",', '"b"]'])).toEqual({ sub: 'set', key: 'ui.verbs', value: '["a", "b"]', session: true });
  expect(parseConfigArgs(['set', 'ui.mouse', 'false'])).toEqual({ sub: 'set', key: 'ui.mouse', value: 'false', session: false });
  expect(parseConfigArgs(['get', 'ui.mouse'])).toEqual({ sub: 'get', key: 'ui.mouse', session: false });
  expect(unquoteValue(`'["Thinking"]'`)).toBe('["Thinking"]');
  expect(unquoteValue('"Ada Lovelace"')).toBe('Ada Lovelace');
  expect(unquoteValue(`'half"`)).toBe(`'half"`);
  expect(describeConfigValue('ui.verbs', ['a'], 'session')).toBe('["a"] · session');
  expect(describeConfigValue('ui.verbs', undefined, 'default')).toBe('no key ui.verbs · default');
});

// What the y/n block shows must be typable on the `:` line as shown: the line read back
// through the `:` line's own parsing gives the same value. (The line joins its words with
// one space, so a run of spaces inside quotes comes back as one — not tried here.)
test('the config set line reads back as the value it shows', async () => {
  const { configSetLine, parseConfigArgs, unquoteValue } = await import('../commands');
  const { parseValue } = await import('../load');
  const values: unknown[] = [["Don't panic"], "Don't", 'Ada Lovelace', 'a#b', ['say "hi"', "it's"], ['Thinking'], false, 42, 'plain'];
  for (const value of values) {
    const line = configSetLine('ui.verbs', value, 'session');
    const args = parseConfigArgs(line.split(/\s+/).filter(Boolean).slice(1));
    expect({ line, back: parseValue(unquoteValue(args.value ?? '')) }).toEqual({ line, back: value });
  }
  expect(configSetLine('user.name', "Don't", 'saved')).toBe(`config set user.name "Don't"`);
  // A control character is drawn as its escape: the line stays one line.
  expect(configSetLine('user.name', 'a\nb', 'saved')).toBe(`config set user.name 'a\\nb'`);
});
