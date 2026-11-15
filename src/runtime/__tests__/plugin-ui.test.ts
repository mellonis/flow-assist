// The `ui` object a plugin is given, held to the type that describes it. The literal
// and `PluginUi` are written apart, so a member added to one and not the other is
// caught here: the interface is read from its source, the object from the factory the
// App calls.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { stringWidth } from '@flowtty/core';
import * as flowtty from '@flowtty/react';
import { makePluginUi } from '../plugin-ui.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const read = (rel: string) => fs.readFileSync(path.join(here, rel), 'utf8');

// The member names `interface PluginUi { … }` declares, in order — a property or a
// method.
function declaredMembers(): string[] {
  const src = read('../plugin-api.ts');
  const start = src.indexOf('export interface PluginUi {');
  expect(start).toBeGreaterThanOrEqual(0);
  const body = src.slice(start, src.indexOf('\n}\n', start));
  return [...body.matchAll(/^ {2}(\w+)\??[:(]/gm)].map((m) => m[1]!);
}

test('the ui object carries every member PluginUi declares, and nothing else', () => {
  const declared = declaredMembers();
  expect(declared.length).toBeGreaterThan(10);
  const ui = makePluginUi() as unknown as Record<string, unknown>;
  expect(Object.keys(ui).sort()).toEqual([...declared].sort());
  for (const name of declared) expect(ui[name]).toBeDefined();
});

test('the plugin guide names every member of ui', () => {
  const doc = read('../../../docs/plugins.md');
  const section = doc.slice(doc.indexOf('## What a plugin is given'), doc.indexOf('## Commands, keys and the footer'));
  // A whole name: `h` must not pass on `host`, nor `useInput` on `useInputHandler`.
  for (const name of declaredMembers()) expect(section).toMatch(new RegExp(`\`${name}[\`(]`));
});

// A flag and a ZWJ sequence are one cluster of two cells: what a column a plugin
// sizes from a name must count.
test('ui.stringWidth is @flowtty/core\'s own, measuring by grapheme cluster', () => {
  const ui = makePluginUi();
  expect(ui.stringWidth).toBe(stringWidth);
  expect(ui.stringWidth('\u{1F1F7}\u{1F1FA}')).toBe(2);
  expect(ui.stringWidth('\u{1F468}‍\u{1F469}‍\u{1F467}')).toBe(2);
  expect(ui.stringWidth('✅ done')).toBe(7);
  expect(ui.stringWidth('漢字')).toBe(4);
});

// The components a plugin draws a state with, and the ones a plugin's own surface needs
// (a press, a focus group, a form), are flowtty's own — passed through, never copied.
// A copy would drift from the host's rendering, and a second React copy breaks every
// hook (the guide's first rule about `ui`).
test('ui carries flowtty\'s own widgets and hooks, not copies', () => {
  const ui = makePluginUi() as unknown as Record<string, unknown>;
  const own = flowtty as unknown as Record<string, unknown>;
  const members = [
    // A state the person watches while a turn runs.
    'Spinner', 'Shimmer', 'ProgressBar', 'TaskList', 'useTicker',
    // Text a plugin's own layout is made of.
    'Span', 'Title', 'HRule', 'HelpBar',
    // The widgets whose keys a plugin gates itself.
    'TextArea', 'Button', 'ScrollList',
    // A surface's own focus and its clicks.
    'FocusGroup', 'useFocus', 'useClick', 'useHover',
    // A form over fields the plugin declares.
    'Form', 'useField', 'Confirm',
  ];
  for (const name of members) {
    expect(own[name]).toBeDefined();
    expect(`${name}:${typeof ui[name]}`).toBe(`${name}:${typeof own[name]}`);
    expect(ui[name]).toBe(own[name]);
  }
});

// The guide's promise that a plugin's surface can be made deaf in one move: `Box inert`
// is flowtty's own input layer, and a plugin that owns no keyboard writes it once
// instead of gating every control. Nothing tests the behaviour here — the host's
// `hasKeyboard()` is not flowtyt's — but the recipe must be written down where a person
// building a plugin reads it.
test('the guide names `<Box inert>` as how a plugin goes deaf when the chat has the keys', () => {
  const doc = read('../../../docs/plugins.md');
  const section = doc.slice(doc.indexOf('## What a plugin is given'), doc.indexOf('## Commands, keys and the footer'));
  expect(section).toContain('inert');
});
