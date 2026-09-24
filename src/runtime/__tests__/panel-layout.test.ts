import { expect, test } from 'bun:test';
import { chatModeOf, inRect, panelLayout } from '../panel-layout';

test('the mode: the config says it, an old fullscreen reads as full, else the panel', () => {
  expect(chatModeOf(undefined)).toBe('panel');
  expect(chatModeOf({})).toBe('panel');
  expect(chatModeOf({ mode: 'window' })).toBe('window');
  expect(chatModeOf({ fullscreen: true })).toBe('full');
  expect(chatModeOf({ fullscreen: false })).toBe('panel');
  // A mode that is said wins over the old key.
  expect(chatModeOf({ mode: 'window', fullscreen: true })).toBe('window');
  expect(chatModeOf({ mode: 'sideways' })).toBe('panel');
});

test('on the right: ~35% of the width, the plugin keeps the rest from the top-left corner', () => {
  const l = panelLayout({ width: 160, height: 40 });
  expect(l.side).toBe('right');
  expect(l.panel).toEqual({ left: 104, top: 0, width: 56, height: 40 });
  expect(l.region).toEqual({ left: 0, top: 0, width: 104, height: 40 });
  expect(panelLayout({ width: 160, height: 40, size: 50 }).panel.width).toBe(80);
});

test('under 120 columns a right panel goes to the bottom by itself', () => {
  const l = panelLayout({ width: 100, height: 40, side: 'right' });
  expect(l.side).toBe('bottom');
  expect(l.panel).toEqual({ left: 0, top: 24, width: 100, height: 16 });
  expect(l.region).toEqual({ left: 0, top: 0, width: 100, height: 24 });
  expect(panelLayout({ width: 200, height: 40, side: 'bottom' }).side).toBe('bottom');
});

test('neither side is left a sliver', () => {
  // A small terminal: the bottom panel keeps its least, the plugin its least.
  const small = panelLayout({ width: 80, height: 24 });
  expect(small.panel.height).toBe(12);
  expect(small.region.height).toBe(12);
  // A size that would leave the plugin nothing is held back.
  expect(panelLayout({ width: 130, height: 40, size: 90 }).region.width).toBe(60);
});

test('collapsed: gone on the right, one row at the bottom', () => {
  const right = panelLayout({ width: 160, height: 40, collapsed: true });
  expect(right.panel.width).toBe(0);
  expect(right.region.width).toBe(160);
  const bottom = panelLayout({ width: 100, height: 40, collapsed: true });
  expect(bottom.panel).toEqual({ left: 0, top: 39, width: 100, height: 1 });
  expect(bottom.region.height).toBe(39);
  expect(inRect(bottom.panel, 5, 39)).toBe(true);
  expect(inRect(bottom.panel, 5, 38)).toBe(false);
});
