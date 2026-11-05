// The completion list: with two or more candidates a list opens over the chat's field
// and over the `:` line. ↑/↓ move, Tab and Enter take (Enter never sends or runs while
// it is open), Esc closes it until the text changes. The pure parts are in
// src/config/__tests__/commandline.test.ts.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Ui = Awaited<ReturnType<typeof bootApp>>;
const rows = (ui: Ui) => ui.backend.lastFrame.split('\n');
const fieldRow = (ui: Ui) => rows(ui).filter((r) => r.includes('› ')).at(-1) ?? '';
const lineRow = (ui: Ui) => rows(ui).findLast((r) => /^\s*:(\s|$)/.test(r)) ?? '';
const rowOf = (ui: Ui, text: RegExp) => rows(ui).findIndex((r) => text.test(r));

const echo = (got: string[]) => (make: any) => [make('boards', {
  name: 'boards',
  commands: [{ name: 'open', run: (_c: unknown, arg: string) => { got.push(arg); }, usage: 'open <key>', minArgs: 1, maxArgs: -1, description: 'Open a card', values: ['board', 'card', 'cart'] }],
})];

test('the field\'s list opens at two candidates, shows each one\'s description, and closes at one', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 28);
  await ui.press('F');
  await ui.type('/co');
  // compact, context, copy — each with what it does, none with the key hint of the inline walk.
  expect(ui.backend.lastFrame).toMatch(/compact +fold the conversation/);
  expect(ui.backend.lastFrame).toMatch(/context +what fills the model/);
  expect(ui.backend.lastFrame).toMatch(/copy +copy an answer/);
  expect(ui.backend.lastFrame).not.toContain('⇥');
  expect(fieldRow(ui)).toContain('› /compact');
  await ui.type('nt');
  expect(ui.backend.lastFrame).not.toContain('what fills the model');
  expect(fieldRow(ui)).toContain('› /content'.replace('content', 'context'));
  ui.app.unmount();
});

test('↑/↓ move the selection and wrap; the field offers the selected one; Tab takes it', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 28);
  await ui.press('F');
  await ui.type('/co');
  await ui.press('down');
  expect(fieldRow(ui)).toContain('› /context');
  await ui.press('down', 'down');
  expect(fieldRow(ui)).toContain('› /compact');
  await ui.press('up');
  expect(fieldRow(ui)).toContain('› /copy');
  ui.backend.press({ name: 'tab', shift: true });
  await settle(2);
  expect(fieldRow(ui)).toContain('› /context');
  await ui.press('tab');
  expect(fieldRow(ui)).toContain('› /context');
  expect(ui.backend.lastFrame).not.toContain('copy an answer');
  ui.app.unmount();
});

test('Enter takes the selection and does not run the line while the list is open; with it closed Enter runs', async () => {
  const model = new ScriptedModel();
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await ui.type('/m');
  await ui.press('down');
  expect(fieldRow(ui)).toContain('› /mode');
  await ui.press('return');
  // Taken, not run: the field holds the command and nothing was said or sent.
  expect(fieldRow(ui)).toContain('› /mode');
  expect(ui.backend.lastFrame).not.toContain('Unknown');
  expect(model.requests).toHaveLength(0);
  expect(ui.backend.lastFrame).not.toContain('what the assistant remembers');
  // The list is gone with the unique candidate: now Enter runs it, and the field empties.
  await ui.press('return');
  await settle(4);
  expect(fieldRow(ui)).not.toContain('/mode');
  ui.app.unmount();
});

test('Enter on the candidate the field already holds closes the list, then runs the line', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 28);
  await ui.press('F');
  // `/sub` is a whole command and a prefix of `/subagent`: the list holds both.
  await ui.type('/sub');
  expect(ui.backend.lastFrame).toMatch(/subagent/);
  // The selection starts on the word as typed, not on `/subagent`.
  expect(fieldRow(ui)).not.toContain('subagent');
  await ui.press('return');
  expect(ui.backend.lastFrame).not.toMatch(/subagent +start/);
  await ui.press('return');
  await settle(4);
  expect(fieldRow(ui)).not.toContain('› /sub');
  ui.app.unmount();
});

test('Esc closes the list and keeps the text, until the text changes', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 28);
  await ui.press('F');
  await ui.type('/c');
  expect(ui.backend.lastFrame).toContain('fold the conversation');
  await ui.press('escape');
  expect(ui.backend.lastFrame).not.toContain('fold the conversation');
  expect(fieldRow(ui)).toContain('› /c');
  // Still closed after keys that leave the text alone…
  await ui.press('down');
  expect(ui.backend.lastFrame).not.toContain('fold the conversation');
  // …and open again once it changes.
  await ui.type('o');
  expect(ui.backend.lastFrame).toContain('fold the conversation');
  ui.app.unmount();
});

test('with the list closed ↑ keeps its jobs in the field: recalling the last message', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'hi back' }]);
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await ui.type('hello there');
  await ui.press('return');
  await settle(20);
  await ui.press('up');
  expect(fieldRow(ui)).toContain('› hello there');
  // A `/c` recalled later is a draft; with the list open ↑ moves the selection instead.
  await ui.press('escape');
  await ui.type('/c');
  await ui.press('up');
  expect(fieldRow(ui)).toContain('› /cd');
  expect(fieldRow(ui)).not.toContain('hello there');
  ui.app.unmount();
});

test('the list keeps its place while typing narrows it, and a count says where the selection is in a long one', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 30);
  await ui.press('F');
  await ui.type('/c');
  const top = rowOf(ui, /compact +fold/);
  expect(top).toBeGreaterThan(0);
  const before = rows(ui).length;
  await ui.type('o');
  // Three candidates left of four: the list still takes its four rows, so the first stays put.
  expect(rowOf(ui, /compact +fold/)).toBe(top);
  expect(rows(ui)).toHaveLength(before);
  ui.app.unmount();

  // More candidates than eight rows: a count, scrolling around the selection.
  const big = await bootApp(new ScriptedModel(), 100, 30);
  await big.press('F');
  await big.type('/');
  expect(big.backend.lastFrame).toContain('1/23');
  await big.press('up');
  expect(big.backend.lastFrame).toContain('23/23');
  expect(big.backend.lastFrame).toMatch(/exit +close the chat/);
  expect(big.backend.lastFrame).not.toMatch(/compact +fold/);
  big.app.unmount();
});

test('a row is cut to the width, its detail first', async () => {
  const ui = await bootApp(new ScriptedModel(), 44, 28);
  await ui.press('F');
  await ui.type('/co');
  const row = rows(ui).find((r) => r.includes('compact'))!;
  expect(row).toContain('…');
  expect(row).toMatch(/compact +fold/);
  expect(Math.max(...rows(ui).map((r) => [...r].length))).toBeLessThanOrEqual(44);
  ui.app.unmount();
});

test('a single candidate still completes inline with Tab, with no list', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 28);
  await ui.press('F');
  await ui.type('/mod');
  expect(ui.backend.lastFrame).not.toContain('the chat\'s layout');
  expect(fieldRow(ui)).toContain('› /mode');
  await ui.press('tab');
  expect(fieldRow(ui)).toContain('› /mode');
  ui.app.unmount();
});

test('the `:` line has the same list: ↑/↓ move, Enter takes without running, Esc closes the list before the line', async () => {
  const got: string[] = [];
  const ui = await bootApp(new ScriptedModel(), 100, 24, echo(got));
  await ui.press(':');
  await ui.type('open ');
  // board, card, cart — three values of the plugin command's argument.
  expect(ui.backend.lastFrame).toMatch(/\bcard\b/);
  expect(ui.backend.lastFrame).toMatch(/\bcart\b/);
  expect(lineRow(ui)).toContain(': open board');
  await ui.press('down');
  expect(lineRow(ui)).toContain(': open card');
  await ui.press('down', 'down');
  expect(lineRow(ui)).toContain(': open board');
  await ui.press('up');
  expect(lineRow(ui)).toContain(': open cart');
  await ui.press('return');
  // Taken, not run.
  expect(got).toEqual([]);
  expect(lineRow(ui)).toContain(': open cart');
  // Esc on a list closes the list, keeping the line open and its text.
  await ui.press('backspace');
  expect(ui.backend.lastFrame).toMatch(/\bcard\b/);
  await ui.press('escape');
  expect(lineRow(ui)).toContain(': open car');
  expect(ui.backend.lastFrame).not.toMatch(/\bcard\b.*\n.*\bcart\b/);
  // The line runs once the list is out of the way.
  await ui.press('return');
  expect(got).toEqual(['car']);
  ui.app.unmount();
});

test('the `:` line\'s list describes commands, and ↑ with it closed still recalls the history', async () => {
  const got: string[] = [];
  const ui = await bootApp(new ScriptedModel(), 100, 24, echo(got));
  await ui.press(':');
  await ui.type('open x');
  await ui.press('return');
  expect(got).toEqual(['x']);
  await ui.press(':');
  await ui.press('up');
  expect(lineRow(ui)).toContain(': open x');
  await ui.press('escape');
  await ui.press(':');
  await ui.type('c');
  expect(ui.backend.lastFrame).toMatch(/cache +Turn the cache on or off/);
  expect(ui.backend.lastFrame).toMatch(/config +Show the whole config/);
  await ui.press('escape');
  expect(ui.backend.lastFrame).not.toMatch(/cache +Turn the cache/);
  // Esc on the closed list closes the line.
  await ui.press('escape');
  expect(lineRow(ui)).toContain(': commands');
  ui.app.unmount();
});

test('a config key is listed with its value', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 30, undefined, { shell: { maxChars: 5000, maxBackground: 2 } });
  await ui.press(':');
  await ui.type('config get shell.max');
  expect(ui.backend.lastFrame).toMatch(/shell\.maxBackground +2/);
  expect(ui.backend.lastFrame).toMatch(/shell\.maxChars +5000/);
  ui.app.unmount();
});
