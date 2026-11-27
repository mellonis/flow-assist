// A plugin's palette and its preview come from its manifest.json: `colors` as one record
// for both schemes or as `{ dark, light }`, `preview` a node tree in the frame format. A
// value or a tree the host cannot take is dropped with a note; the plugin still loads.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestSurfaceKeys, readManifestPalette } from '../palette-manifest';
import { loadEnabledPlugin } from '../build';
import { THIS_HOST, pluginCompat } from '../compat';
import { HOST_API } from '../../version';

test('one record of colors stands on both schemes', () => {
  const out = readManifestPalette({ colors: { lane: '${base.highlight}', mark: '#123456' } });
  expect(out.palette).toEqual({
    dark: { lane: '${base.highlight}', mark: '#123456' },
    light: { lane: '${base.highlight}', mark: '#123456' },
  });
  expect(out.notes).toEqual([]);
});

test('{ dark, light } keeps the two schemes apart', () => {
  const out = readManifestPalette({ colors: { dark: { lane: '#111111' }, light: { lane: '#eeeeee' } } });
  expect(out.palette).toEqual({ dark: { lane: '#111111' }, light: { lane: '#eeeeee' } });
  expect(out.notes).toEqual([]);
});

test('a value that is not a colour is dropped, and the note names it', () => {
  const out = readManifestPalette({ colors: { a: '#12', b: 'red' } });
  expect(out.palette).toEqual({ dark: { b: 'red' }, light: { b: 'red' } });
  expect(out.notes).toHaveLength(1);
  expect(out.notes[0]).toContain('colors.a');
  const split = readManifestPalette({ colors: { dark: { a: '${highlightBg}' }, light: { a: 'blue' } } });
  expect(split.palette).toEqual({ dark: {}, light: { a: 'blue' } });
  expect(split.notes[0]).toContain('colors.dark.a');
});

test('colors that are not a record give no palette, with a note', () => {
  const out = readManifestPalette({ colors: ['red'] });
  expect(out.palette).toBeUndefined();
  expect(out.notes[0]).toContain('colors');
  expect(readManifestPalette({})).toEqual({ notes: [] });
});

test('a preview that is a node tree is kept; one that is not is dropped with a note', () => {
  const tree = ['Box', { backgroundColor: '${lane}' }, ['Text', { color: '${base.text}' }, 'Lane']];
  expect(readManifestPalette({ preview: tree })).toEqual({ preview: tree, notes: [] });
  const bad = readManifestPalette({ preview: { type: 'Box' } });
  expect(bad.preview).toBeUndefined();
  expect(bad.notes[0]).toContain('preview');
  const deepBad = readManifestPalette({ preview: ['Box', {}, 42] });
  expect(deepBad.preview).toBeUndefined();
  expect(deepBad.notes).toHaveLength(1);
});

test('the loader hands a plugin the palette and preview its manifest declares; a bad preview does not stop it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'palette-manifest-'));
  const dir = join(root, 'boards');
  mkdirSync(dir);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'boards', hostApi: HOST_API, colors: { lane: '${base.highlight}', x: 'nope' }, preview: 'not a node' }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'boards', type: 'module', main: 'index.js' }));
  writeFileSync(join(dir, 'index.js'), "export default ({ make }) => make('boards', {});\n");
  const lines: string[] = [];
  const plugin = await loadEnabledPlugin('boards', { config: {}, enabledDir: root, log: (l) => lines.push(l) });
  expect(plugin.name).toBe('boards');
  expect(plugin.palette).toEqual({ dark: { lane: '${base.highlight}' }, light: { lane: '${base.highlight}' } });
  expect(plugin.preview).toBeUndefined();
  expect(lines.some((l) => l.includes('boards') && l.includes('colors.x'))).toBe(true);
  expect(lines.some((l) => l.includes('boards') && l.includes('preview'))).toBe(true);
});

test('a manifest built for host API 2 is incompatible on this host', () => {
  expect(pluginCompat({ hostApi: 2 }, THIS_HOST)).toEqual({ ok: false, reason: 'incompatible: built for host API 2, host provides 3' });
});

test('the keys a plugin surface draws come from its manifest, and an unreadable one answers nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fa-surface-keys-'));
  const plugin = (name: string, manifest: string) => {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'manifest.json'), manifest);
  };
  plugin('board', JSON.stringify({ colors: { dark: { swimlaneBg: 'red' }, light: { cardBg: 'blue' } } }));
  plugin('plain', JSON.stringify({ name: 'plain' }));
  plugin('broken', '{ not json');
  const keys = manifestSurfaceKeys(dir, ['board', 'plain', 'broken', 'gone']);
  expect(keys('board')?.has('swimlaneBg')).toBe(true);
  expect(keys('board')?.has('cardBg')).toBe(true);
  expect(keys('board')?.has('text')).toBe(true);
  expect(keys('board')?.has('zzz')).toBe(false);
  // A manifest with no colors: its surface draws the roles only.
  expect(keys('plain')?.has('text')).toBe(true);
  expect(keys('plain')?.has('swimlaneBg')).toBe(false);
  // Not readable, not installed, not enabled: nothing to check against.
  expect(keys('broken')).toBeNull();
  expect(keys('gone')).toBeNull();
  expect(keys('elsewhere')).toBeNull();
});
