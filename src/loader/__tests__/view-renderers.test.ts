// A plugin brings its own view kinds; the host qualifies them by the plugin's name,
// and a tool's bare kind reaches its own plugin's renderer.
import { expect, test } from 'bun:test';
import { collectViewRenderers } from '../registry';
import { scopeViews } from '../tools';
import { renderConsole } from '../../assistant/console-view';

test('renderers are qualified by plugin, and the host brings console', () => {
  const card = () => [];
  const table = collectViewRenderers([{ name: 'notes', viewRenderers: { card } }, { name: 'bad', viewRenderers: { x: 42 as never } }]);
  expect(table['notes:card']).toBe(card);
  expect(table.console).toBe(renderConsole);
  expect(table['bad:x']).toBeUndefined();
});

test('a plugin\'s tool names its kind bare and reports it qualified', () => {
  const seen: string[] = [];
  const ctx = {
    liveView: (kind: string) => { seen.push(kind); return { update() {}, discard() {} }; },
    reportView: (kind: unknown) => { seen.push(String(kind)); },
  };
  const scoped = scopeViews(ctx as never, 'notes') as unknown as typeof ctx;
  scoped.liveView('card');
  scoped.reportView('x:other');
  expect(seen).toEqual(['notes:card', 'x:other']);
  expect(scopeViews({} as never, 'notes')).toEqual({});
});

test('the old one-argument reportView passes through untouched', () => {
  const seen: unknown[] = [];
  const scoped = scopeViews({ reportView: (v: unknown) => seen.push(v) } as never, 'notes') as unknown as { reportView: (v: unknown) => void };
  const old = { kind: 'console', command: 'ls', text: '' };
  scoped.reportView(old);
  expect(seen).toEqual([old]);
});
