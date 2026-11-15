// The panel toggle's key contract: the plugin matches a press through its own
// `keyIdOf` — a copy of the host's `keyId` (src/playback/keys.ts) the plugin sources may
// not import — so the copy and the original are pinned here, and the panel itself is
// driven with the keys the host's canonicalizer spells for its binding. A spelling
// change on either side must fail here instead of dead-keying the toggle silently.
import { expect, test } from 'bun:test';
import { canonicalBinding, keyId } from '../playback/keys';
import { canvasPanel, keyIdOf } from '../../plugins-available/canvas/src/view.ts';
import { createStore, drawCanvas, type TStore } from '../../plugins-available/canvas/src/store.ts';
import { checkTree } from '../../plugins-available/canvas/src/tree.ts';

type TKey = { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean };
type TPanelOpts = { mode?: string; priority: (ui: unknown) => number; handler: (key: TKey, ui: unknown) => unknown };

// The panel's component with its input handler captured: the host shape it reads is
// just `useInputHandler`, `keys` and `notify`. A canvas is drawn first — over an empty
// registry the key is consumed and changes nothing (view.test pins that branch), so the
// toggle is only observable while there is one to open.
const panelOf = (binding: string[]): { press: (key: TKey) => unknown; store: TStore } => {
  const store = createStore();
  const checked = checkTree(['Text', {}, 'x']);
  if (!checked.ok) throw new Error(checked.error);
  drawCanvas(store, { id: 'ci', tree: checked.tree, stats: checked.stats });
  let held: TPanelOpts['handler'] | null = null;
  const host = {
    useInputHandler: (opts: TPanelOpts) => { held = opts.handler; },
    keys: { canvas: binding },
    notify: () => {},
    keyCap: () => '',
  };
  (canvasPanel({ host } as never, store) as () => unknown)();
  return { press: (key: TKey) => (held as unknown as TPanelOpts['handler'])(key, {}), store };
};

test('keyIdOf agrees with the host keyId over every shape the decoder reports', () => {
  const shapes: TKey[] = [
    {},
    { name: '' },
    { name: 'x' },
    { name: 'C' },                                     // a capital: shift is already in the char
    { name: ' ' },
    { name: 'tab' },
    { name: 'tab', shift: true },                      // a NAMED key keeps the shift marker
    { name: 'f1' },
    { name: 'f1', shift: true },
    { name: ']', ctrl: true },
    { name: 'o', meta: true },
    { name: 'left', ctrl: true, meta: true, shift: true },
    { name: 'a', shift: true },                        // shift on a character stays off
  ];
  for (const shape of shapes) expect(keyIdOf(shape)).toBe(keyId(shape));
});

test('the panel toggle answers exactly the keys the host canonicalizes its binding to', () => {
  // The binding `keys: { canvas: 'C' }` resolves to — and the key the decoder reports
  // for a plain C press (a capital; no shift flag).
  const pressed = panelOf(canonicalBinding('C'));
  expect(pressed.press({ name: 'C' })).toBe(true);
  expect(pressed.store.personOpened).toBe(true);
  // The lowercase spelling is a different key — the toggle must not take it.
  expect(pressed.press({ name: 'c' })).toBe(false);
  expect(pressed.store.personOpened).toBe(true);
  pressed.press({ name: 'C' });
  expect(pressed.store.personOpened).toBe(false);
});

test('a remapped binding moves the toggle with it', () => {
  const moved = panelOf(canonicalBinding('ctrl+t'));
  expect(moved.press({ name: 't', ctrl: true })).toBe(true);
  expect(moved.store.personOpened).toBe(true);
  expect(moved.press({ name: 't' })).toBe(false);       // bare t is not the binding
  expect(moved.press({ name: 'C' })).toBe(false);       // the old spelling is no longer it
  expect(moved.store.personOpened).toBe(true);
});
