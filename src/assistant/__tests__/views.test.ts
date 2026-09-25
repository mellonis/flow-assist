// A view is a block a TOOL describes and a renderer draws; this file holds what is
// common to every kind. What is tested here: the record's own kind lookup, the framing
// every renderer's rows go through on the way to the screen, and the text sanitising
// that keeps a command's own output from passing for the host's.
import { expect, test } from 'bun:test';
import { stringWidth } from '@flowtty/core';
import { VIEW_CAPS, VIEW_DATA_MAX, acceptData, fence, frameView, isConsoleKind, qualifyKind, readLegacyView, resolveRenderer, sanitizeViewText, type ViewRecord, type ViewRenderCtx } from '../views';

test('escape sequences and control characters never reach the screen', () => {
  const raw = '\u001B[31mred\u001B[0m\u001B]0;a title\u0007 plain\u0000\u0007 end';
  expect(sanitizeViewText(raw)).toBe('red plain end');
  // A tab is spaces (the grid counts cells, not tab stops), and a carriage return is a
  // line of its own — a progress bar rewriting one line keeps its LAST state instead
  // of gluing every state into one row.
  expect(sanitizeViewText('a\tb')).toBe(`a${' '.repeat(4)}b`);
  expect(sanitizeViewText('10%\r50%\r100%\r\ndone')).toBe('10%\n50%\n100%\ndone');
});

// ── renderers: a renderer draws, the host frames ─────────────────────────────
const rctx: ViewRenderCtx = { width: 20, folded: true, live: false, failed: false, elapsedMs: 0, lines: 20, moreKey: '^o' };
const rec = (kind: string, data: unknown = {}): ViewRecord => ({ kind, data, phase: 'done', startedAt: 0 });
const palette = { ok: 'green', warn: 'yellow', accent: 'cyan' };
const texts = (lines: { spans: { text: string }[] }[]) => lines.map((l) => l.spans.map((s) => s.text).join(''));

test('whatever a renderer returns is stripped of escapes before it is drawn', () => {
  expect(texts(frameView(rec('k'), { k: () => [[{ text: '\u001B[2Kbuild\u0007ing' }]] }, rctx, palette))).toEqual(['building']);
});

test('a line is cut to the width, never wrapped: one line is one row', () => {
  const out = frameView(rec('k'), { k: () => [[{ text: 'x'.repeat(30) }], [{ text: 'a\nb' }]] }, rctx, palette);
  expect(texts(out)).toEqual([`${'x'.repeat(19)}…`, 'a b']);
});

test('the number of rows is capped', () => {
  const many = Array.from({ length: VIEW_CAPS.rows + 10 }, (_, i) => [{ text: `r${i}` }]);
  expect(frameView(rec('k'), { k: () => many }, rctx, palette)).toHaveLength(VIEW_CAPS.rows);
});

test('a colour is a palette token; an unknown token draws plain', () => {
  const [line] = frameView(rec('k'), { k: () => [[{ text: 'a', color: 'ok' }, { text: 'b', color: '#ff0000' }]] }, rctx, palette);
  expect(line!.spans[0]!.color).toBe('green');
  expect(line!.spans[1]!.color).toBeUndefined();
});

test('leading chrome spans are counted, so a drag never copies them', () => {
  const [line] = frameView(rec('k'), { k: () => [[{ text: '│ ', chrome: true }, { text: 'out' }]] }, rctx, palette);
  expect(line!.chrome).toBe(1);
});

test('a missing or broken renderer is one dim row naming the kind, and says why', () => {
  const said: string[] = [];
  const onFail = (k: string, why: string) => said.push(`${k}: ${why}`);
  expect(texts(frameView(rec('tracker:issue'), {}, rctx, palette, onFail))).toEqual(['▸ tracker:issue']);
  expect(texts(frameView(rec('k'), { k: () => { throw new Error('boom'); } }, rctx, palette, onFail))).toEqual(['▸ k']);
  expect(texts(frameView(rec('k'), { k: () => 'nope' as never }, rctx, palette, onFail))).toEqual(['▸ k']);
  expect(said).toEqual(['tracker:issue: no renderer', 'k: boom', 'k: not a list of lines']);
});

test('a kind is qualified by its plugin, and resolved back to the host kind when the plugin has none', () => {
  expect(qualifyKind('notes', 'card')).toBe('notes:card');
  expect(qualifyKind('notes', 'x:card')).toBe('x:card');
  const host = () => [];
  const card = () => [];
  expect(resolveRenderer({ console: host }, 'notes:console')).toBe(host);
  expect(resolveRenderer({ 'notes:card': card, card: host }, 'notes:card')).toBe(card);
  expect(resolveRenderer({}, 'notes:card')).toBeNull();
});

test('a console kind is the host\'s console, bare or qualified — not any kind ending in the word', () => {
  expect(isConsoleKind('console')).toBe(true);
  expect(isConsoleKind('notes:console')).toBe(true);
  expect(isConsoleKind('x:myconsole')).toBe(false);
});

test('data must be JSON and bounded', () => {
  expect(acceptData({ a: 1 })).toBe(true);
  expect(acceptData({ a: 'x'.repeat(VIEW_DATA_MAX) })).toBe(false);
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  expect(acceptData(loop)).toBe(false);
  expect(acceptData(undefined)).toBe(false);
});

test('a fence is longer than any run of backticks in the text', () => {
  expect(fence('plain')).toBe('```');
  expect(fence('a ````` b')).toBe('``````');
});

test('an old console view is read as the console renderer\'s data', () => {
  const r = readLegacyView({ kind: 'console', command: 'bun test', text: 'ok', exitCode: 0, ms: 1200, cwd: '~/a', status: 'exit 0' });
  expect(r).toEqual({ kind: 'console', data: { command: 'bun test', text: 'ok', exitCode: 0, ms: 1200, cwd: '~/a', status: 'exit 0' }, phase: 'done', startedAt: 0 });
  expect(readLegacyView({ kind: 'console', data: {}, phase: 'done', startedAt: 1 })).toBeNull(); // already a record
  expect(readLegacyView({ kind: 'table' })).toBeNull();
});

test('a kind with escape sequences and newlines in the fallback row is sanitised', () => {
  const out = frameView(rec('\u001b[2Jx\ny'), {}, rctx, palette);
  expect(texts(out)).toEqual(['▸ x y']);
});

test('prototype property lookups are prevented in resolveRenderer', () => {
  expect(resolveRenderer({}, 'x:constructor')).toBeNull();
  expect(resolveRenderer({}, 'toString')).toBeNull();
});

test('a non-string kind never throws — resolveRenderer and frameView both fall back', () => {
  expect(resolveRenderer({ k: () => [] }, undefined as unknown as string)).toBeNull();
  expect(resolveRenderer({ k: () => [] }, 42 as unknown as string)).toBeNull();
  expect(resolveRenderer({ k: () => [] }, null as unknown as string)).toBeNull();
  expect(texts(frameView(42 as unknown as ViewRecord, { k: () => [] }, rctx, palette))).toEqual(['▸ view']);
  expect(texts(frameView('a-string' as unknown as ViewRecord, { k: () => [] }, rctx, palette))).toEqual(['▸ view']);
  expect(texts(frameView(null as unknown as ViewRecord, { k: () => [] }, rctx, palette))).toEqual(['▸ view']);
  expect(texts(frameView({ phase: 'done' } as unknown as ViewRecord, { k: () => [] }, rctx, palette))).toEqual(['▸ view']);
});

test('prototype property lookups are prevented in palette resolution', () => {
  const [line] = frameView(rec('k'), { k: () => [[{ text: 'a', color: 'constructor' }, { text: 'b', color: 'toString' }]] }, rctx, palette);
  expect(line!.spans[0]!.color).toBeUndefined();
  expect(line!.spans[1]!.color).toBeUndefined();
});

// A frame counts cells per grapheme cluster, as the grid draws them: a ZWJ sequence is
// one cluster of two cells, an emoji two, so a line that fits by cells is not cut and
// one that does not is cut before it runs past the block.
test('a line is cut by the cells it takes, per grapheme cluster', () => {
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
  const fits = family.repeat(9); // 18 cells, 45 code points
  expect(texts(frameView(rec('k'), { k: () => [[{ text: fits }]] }, rctx, palette))).toEqual([fits]);
  const [wide] = texts(frameView(rec('k'), { k: () => [[{ text: '✅'.repeat(15) }]] }, rctx, palette)); // 30 cells, 15 code points
  expect(stringWidth(wide!)).toBeLessThanOrEqual(20);
  expect(wide!.endsWith('…')).toBe(true);
  // Spans share the row: a wide first span leaves the second only what is left.
  const [two] = texts(frameView(rec('k'), { k: () => [[{ text: '✅'.repeat(8) }, { text: 'abcdefgh' }]] }, rctx, palette));
  expect(stringWidth(two!)).toBeLessThanOrEqual(20);
});
