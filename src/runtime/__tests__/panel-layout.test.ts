import { expect, test } from 'bun:test';
import { PLUGIN_MIN_ROWS, chatModeOf, inRect, panelLayout } from '../panel-layout';

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

test('a terminal too small for the panel and the plugin\'s least does not dock: it is drawn as a window', () => {
  // The plugin's least is its title bar, its footer and one row of its own.
  expect(PLUGIN_MIN_ROWS).toBe(7);
  // 12 rows of panel + 7 of plugin: 19 is the least that docks at the bottom.
  for (const height of [19, 22, 24, 40]) {
    const l = panelLayout({ width: 100, height });
    expect(l.fits).toBe(true);
    expect(l.region.height).toBeGreaterThanOrEqual(PLUGIN_MIN_ROWS);
  }
  for (const height of [18, 16, 12, 8]) {
    expect(panelLayout({ width: 100, height }).fits).toBe(false);
    // Collapsed or not: the size decides, not the state.
    expect(panelLayout({ width: 100, height, collapsed: true }).fits).toBe(false);
  }
  // On the right the panel has the whole height, and it needs its least of it too.
  expect(panelLayout({ width: 160, height: 12 }).fits).toBe(true);
  expect(panelLayout({ width: 160, height: 11 }).fits).toBe(false);
});

test('what a pending question needs: a bottom panel grows to it while the plugin keeps its least; past that it is a window', () => {
  const grown = panelLayout({ width: 100, height: 40, need: 17 });
  expect(grown.fits).toBe(true);
  expect(grown.panel).toEqual({ left: 0, top: 23, width: 100, height: 17 });
  // Never smaller than it would be anyway.
  expect(panelLayout({ width: 100, height: 40, need: 5 }).panel.height).toBe(16);
  expect(panelLayout({ width: 100, height: 40, need: 33 }).fits).toBe(true);
  expect(panelLayout({ width: 100, height: 40, need: 34 }).fits).toBe(false);
  expect(panelLayout({ width: 100, height: 22, need: 17 }).fits).toBe(false);
  // On the right it has the whole height, or nothing.
  expect(panelLayout({ width: 160, height: 20, need: 20 }).fits).toBe(true);
  expect(panelLayout({ width: 160, height: 20, need: 21 }).fits).toBe(false);
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
