// The surface's contracts the e2e cannot pin: `canvasView` registers its input handler
// on EVERY render — the no-canvas guard must not skip a hook, or two renders' hook
// counts fall out of step (Rules of Hooks, reachable when a delete empties the registry
// mid-life); the handler yields every key while the `:` line is open; a press arms the
// footer's `press queued` only when the host actually took the message; and the panel
// key leaves `personOpened` alone while there is no canvas to show.
import { expect, test } from 'bun:test';
import { canvasPanel, canvasView, type TSurfaceApi } from '../view.ts';
import { checkTree } from '../tree.ts';
import { deleteCanvas, drawCanvas, createStore, type TStore } from '../store.ts';

type TKey = { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean };
type TUiState = { cmdOpen?: boolean; modalActive?: boolean };
type TOpts = { mode?: string; priority: (ui: TUiState) => number; handler: (key: TKey, ui: TUiState) => unknown };

type THarness = {
  render: () => unknown;
  opts: () => TOpts;
  press: (key: TKey) => unknown;
  notifies: () => number;
  registrations: () => number;
};

// Direct-call harness: the component runs outside React, so every render must place its
// hooks in the same order and count — exactly the invariant under test. `useState` is a
// slot per call, read at render and written by the setters.
const harnessOf = (store: TStore, services: Record<string, unknown>): THarness => {
  const registered: TOpts[] = [];
  let notifies = 0;
  const slots: unknown[] = [];
  const h = (type: unknown, props: Record<string, unknown> = {}, ...children: unknown[]) => ({ type: String(type), props, children });
  // One slot per useState call, in call order — the hook contract the component must
  // keep. The counter restarts on every render, so a hook moving order lands in
  // another slot.
  const counter = { at: 0 };
  const makeUi = () => ({
    h, Box: 'Box', Text: 'Text', Markdown: 'Markdown', Table: 'Table', ScrollBox: 'ScrollBox', Link: 'Link',
    TextInput: 'TextInput', Checkbox: 'Checkbox', Select: 'Select',
    stringWidth: (text: string) => text.length,
    useState: <T>(init: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] => {
      const index = counter.at++;
      if (!(index in slots)) slots[index] = typeof init === 'function' ? (init as () => T)() : init;
      return [slots[index] as T, (next) => {
        slots[index] = typeof next === 'function' ? (next as (prev: T) => T)(slots[index] as T) : next;
      }];
    },
  });
  const host = {
    useSurfaceSize: () => ({ width: 48, height: 8 }),
    useInputHandler: (opts: TOpts) => { registered.push(opts); },
    hasKeyboard: () => true,
    services,
    notify: () => { notifies++; },
    keyCap: () => 'C',
    keys: { canvas: ['C'] },
    config: {},
  };
  const View = canvasView({ ui: makeUi(), host } as unknown as TSurfaceApi, store);
  return {
    render: () => {
      counter.at = 0;
      return View();
    },
    opts: () => registered[registered.length - 1]!,
    press: (key: TKey) => (registered[registered.length - 1] as TOpts).handler(key, {}),
    notifies: () => notifies,
    registrations: () => registered.length,
  };
};

const drawOne = (store: TStore): void => {
  const checked = checkTree(['button', { label: 'go', action: 'check it' }]);
  if (!checked.ok) throw new Error(checked.error);
  drawCanvas(store, { id: 'ci', title: 'Pipelines', tree: checked.tree, stats: checked.stats });
};

test('the input handler registers on every render — with a canvas, and with none', () => {
  const store = createStore();
  const view = harnessOf(store, {});
  view.render();                                   // nothing drawn — the host has not unmounted yet
  drawOne(store);
  expect(view.render()).not.toBeNull();
  deleteCanvas(store, 'ci');                       // emptied under a still-mounted surface
  expect(view.render()).toBeNull();
  drawOne(store);
  expect(view.render()).not.toBeNull();
  // One registration per render, whatever the render drew: a registration the guard
  // skips is a hook-count change of exactly the kind React rejects.
  expect(view.registrations()).toBe(4);
});

test('the handler yields every key while the : line is open (priority 0), takes over after', () => {
  const store = createStore();
  drawOne(store);
  const view = harnessOf(store, {});
  view.render();
  const opts = view.opts();
  expect(opts.priority({})).toBe(50);
  expect(opts.priority({ cmdOpen: true })).toBe(0);
  expect(opts.priority({ modalActive: true })).toBe(50);
});

test('a press arms `pressed` and posts only when the host carries postToChat', () => {
  const store = createStore();
  drawOne(store);
  const posted: string[] = [];
  const withChannel = harnessOf(store, { postToChat: (text: string) => posted.push(text) });
  withChannel.render();
  withChannel.press({ name: 'tab' });              // focus btn:0
  withChannel.render();
  withChannel.press({ name: 'return' });           // press it
  expect(posted).toEqual(['[canvas] «ci» pressed «go»\naction: check it']);
  expect(store.pressed).toBe('ci');                // the footer may say `press queued`
  expect(withChannel.notifies()).toBe(1);

  // An older host without the channel swallows the message silently — no hint may stay
  // up for a press nothing will ever answer.
  const bare = createStore();
  drawOne(bare);
  const silent = harnessOf(bare, {});
  silent.render();
  silent.press({ name: 'tab' });
  silent.render();
  silent.press({ name: 'return' });
  expect(bare.pressed).toBeNull();
  expect(silent.notifies()).toBe(0);
});

// The panel's harness: `canvasPanel` registers one handler and holds nothing else, so
// the host is all it needs. Same direct-call shape as the surface's.
const panelOf = (store: TStore): { press: (key: TKey) => unknown; notifies: () => number } => {
  const registered: TOpts[] = [];
  let notifies = 0;
  const host = {
    useInputHandler: (opts: TOpts) => { registered.push(opts); },
    notify: () => { notifies++; },
    keys: { canvas: ['C'] },
  };
  const Panel = canvasPanel({ host } as unknown as TSurfaceApi, store);
  Panel();
  return {
    press: (key: TKey) => registered[registered.length - 1]!.handler(key, {}),
    notifies: () => notifies,
  };
};

test('the panel key changes nothing over an empty registry', () => {
  const store = createStore();
  const panel = panelOf(store);
  // Consumed, so it cannot fall through to another handler, but nothing is flipped: a
  // `personOpened` left `true` over zero canvases would suppress the next background
  // draw's toast and mount the surface the person did not ask for.
  expect(panel.press({ name: 'C' })).toBe(true);
  expect(store.personOpened).toBe(false);
  expect(panel.notifies()).toBe(0);
});

test('the panel key toggles the person side once a canvas is drawn, and yields other keys', () => {
  const store = createStore();
  drawOne(store);
  const panel = panelOf(store);
  expect(panel.press({ name: 'C' })).toBe(true);
  expect(store.personOpened).toBe(true);
  expect(panel.notifies()).toBe(1);
  expect(panel.press({ name: 'C' })).toBe(true);
  expect(store.personOpened).toBe(false);
  expect(panel.notifies()).toBe(2);
  // Not the binding: yielded, never consumed.
  expect(panel.press({ name: 'z' })).toBe(false);
  expect(store.personOpened).toBe(false);
});
