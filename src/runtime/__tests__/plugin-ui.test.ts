// The `ui` object a plugin is given, held to the type that describes it. The literal
// and `PluginUi` are written apart, so a member added to one and not the other is
// caught here: the interface is read from its source, the object from the factory the
// App calls.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { stringWidth } from '@flowtty/core';
import { makePluginUi } from '../plugin-ui.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const read = (rel: string) => fs.readFileSync(path.join(here, rel), 'utf8');

// The member names `interface PluginUi { … }` declares, in order.
function declaredMembers(): string[] {
  const src = read('../plugin-api.ts');
  const start = src.indexOf('export interface PluginUi {');
  expect(start).toBeGreaterThanOrEqual(0);
  const body = src.slice(start, src.indexOf('\n}\n', start));
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!);
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
  for (const name of declaredMembers()) expect(section).toContain(`\`${name}`);
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
