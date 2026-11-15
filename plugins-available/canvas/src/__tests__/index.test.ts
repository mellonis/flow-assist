// The shape the builder hands `make`: the palette the host theme resolves, and the
// surface's three faces — `keycaps` (hints only while the person opened the side AND a
// canvas is drawn), `components.view` (the surface) and `components.panel` (always
// mounted; its key opens and closes the side).
import { expect, test } from 'bun:test';
import buildCanvasPlugin from '../index.ts';
import { TOKEN_COLOR } from '../render.ts';
import { checkTree } from '../tree.ts';
import { drawCanvas, type TStore } from '../store.ts';

const fakeMake = (name: string, shape: Record<string, unknown>) => ({ name, shape });

type TShape = {
  keycaps: (api: unknown) => string[];
  colors: unknown;
  keys: Record<string, string>;
  components: Record<string, (api: unknown) => unknown>;
  setup: (api: unknown) => void;
};
const build = (): { shape: TShape; store: TStore } => {
  const plugin = buildCanvasPlugin({ make: fakeMake as never, config: {} }) as { name: string; shape: TShape };
  // `setup` seeds the plugin's own store on the host's channel — the same one the
  // components and the tools read.
  const host: { store: Record<string, unknown> } = { store: {} };
  plugin.shape.setup({ host });
  return { shape: plugin.shape, store: host.store.canvas as TStore };
};

const apiFor = (): { host: { keyCap(action: string): string } } => ({ host: { keyCap: (action: string) => (action === 'canvas' ? 'C' : '') } });

test('the builder returns a canvas shape carrying the palette the host theme resolves', () => {
  const { shape, store } = build();
  expect(shape.colors).toEqual(TOKEN_COLOR);
  expect(shape.keys.canvas).toBe('C');
  expect(store.canvases.size).toBe(0);
});

test('keycaps is empty while the person opened nothing, and while nothing is drawn', () => {
  const { shape } = build();
  const keycaps = shape.keycaps;
  expect(keycaps(apiFor())).toEqual([]);
});

test('keycaps names the surface\'s keys only while the side is up and holds a canvas', () => {
  const { shape, store } = build();
  const checked = checkTree(['Text', {}, 'hi']);
  if (!checked.ok) throw new Error(checked.error);
  drawCanvas(store, { id: 'ci', title: 'Pipelines', tree: checked.tree, stats: checked.stats });
  // drawn, but the person opened nothing — no surface, no hints.
  expect(shape.keycaps(apiFor())).toEqual([]);
  store.personOpened = true;
  const hints = shape.keycaps(apiFor());
  expect(hints).toContain('C canvas');      // the cap comes from the binding, never a letter written here
  expect(hints).toContain('x x delete');
  expect(hints).toContain('esc close');
  expect(hints).not.toContain('press queued');
  store.pressed = 'ci';
  expect(shape.keycaps(apiFor())).toContain('press queued');
});

test('components.name is a factory per slot: the surface and the always-mounted panel', () => {
  const { shape } = build();
  const view = shape.components.view;
  const panel = shape.components.panel;
  expect(typeof view).toBe('function');
  expect(typeof panel).toBe('function');
});
