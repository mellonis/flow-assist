import { expect, test } from 'bun:test';
import buildCanvasPlugin from '../index.ts';

const fakeMake = (name: string, shape: Record<string, unknown>) => ({ name, shape });

test('the builder returns a canvas shape with no surface and no tools yet', () => {
  const plugin = buildCanvasPlugin({ make: fakeMake as never, config: {} }) as { name: string; shape: Record<string, unknown> };
  expect(plugin.name).toBe('canvas');
  expect(plugin.shape.keycaps?.()).toEqual([]);
});
