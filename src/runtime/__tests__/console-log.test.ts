// A console line printed while the app owns the screen goes to the host log: prefixed
// by its level, one entry per line, never delivered where it was printed (that may be
// the middle of a render), and held until the app is up.
import { expect, test } from 'bun:test';
import { TestBackend, flush } from '@flowtty/core/testing';
import { consoleBridge, consoleLogLines } from '../console-log';
import { renderApp } from '../app';
import { loadPlugins } from '../../loader/build';
import { renderChatModal, renderHelp, renderLogModal, renderReminder } from '../../views/modals';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('each level has its prefix, and a line of several is one entry per line', () => {
  expect(consoleLogLines({ level: 'log', line: 'hello' })).toEqual(['[console] hello']);
  expect(consoleLogLines({ level: 'warn', line: 'careful' })).toEqual(['[console.warn] careful']);
  expect(consoleLogLines({ level: 'error', line: 'boom' })).toEqual(['[console.error] boom']);
  expect(consoleLogLines({ level: 'info', line: 'i' })).toEqual(['[console.info] i']);
  expect(consoleLogLines({ level: 'debug', line: 'd' })).toEqual(['[console.debug] d']);
  expect(consoleLogLines({ level: 'error', line: 'Error: x\n    at f (a.ts:1)\n\n' })).toEqual(['[console.error] Error: x', '[console.error]     at f (a.ts:1)']);
  expect(consoleLogLines({ level: 'log', line: '' })).toEqual([]);
});

test('a line is delivered after the call that printed it, and lines before attach are held', async () => {
  const bridge = consoleBridge();
  bridge.onConsole({ level: 'log', line: 'early' });
  await tick();
  const got: string[] = [];
  bridge.attach((l) => got.push(l));
  expect(got).toEqual(['[console] early']);
  bridge.onConsole({ level: 'warn', line: 'late' });
  // Not in the call itself: it may be in the middle of a render.
  expect(got).toEqual(['[console] early']);
  await tick();
  expect(got).toEqual(['[console] early', '[console.warn] late']);
});

test('the log shows a console line at once — one printed during a render too, with no React warning', async () => {
  const bridge = consoleBridge();
  bridge.onConsole({ level: 'log', line: 'before the app' });
  // A guest that prints while it renders, as React's own warnings are printed.
  let printed = false;
  const guest = {
    name: 'noisy',
    components: {
      view: () => function View() {
        if (!printed) { printed = true; bridge.onConsole({ level: 'error', line: 'printed in a render' }); }
        return null;
      },
    },
  };
  const errors: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  const backend = new TestBackend(100, 30);
  const config: Record<string, unknown> = {};
  const repo = { enabledPlugins: async () => [], list: async () => [] } as never;
  const renders = { chat: renderChatModal, help: renderHelp, log: renderLogModal, reminder: renderReminder };
  const plugins = await loadPlugins({ config, repo, renders: renders as never });
  try {
    const handle = await renderApp(backend, { plugins: [...plugins, guest as never], config, onExit: () => {}, consoleLog: bridge });
    for (let i = 0; i < 4; i++) { await flush(); await tick(); }
    backend.press({ name: 'L', shift: true });
    for (let i = 0; i < 4; i++) { await flush(); await tick(); }
    expect(backend.lastFrame).toContain('[console] before the app');
    expect(backend.lastFrame).toContain('[console.error] printed in a render');
    // Logged while open: the log follows.
    bridge.onConsole({ level: 'warn', line: 'while the log is open' });
    await new Promise((r) => setTimeout(r, 250)); // the redraw is coalesced (200 ms)
    for (let i = 0; i < 4; i++) { await flush(); await tick(); }
    expect(backend.lastFrame).toContain('[console.warn] while the log is open');
    handle.unmount();
  } finally {
    console.error = realError;
  }
  expect(errors.map((a) => String(a[0]))).not.toContainEqual(expect.stringContaining('Cannot update a component'));
});

// A plugin that prints on EVERY render (a debug line left in a view) must not spin the
// app: the line's redraw re-renders the view, which prints again. The redraw a console
// line asks for is coalesced, so such a view costs a few frames a second, not a loop.
test('a view that prints on every render does not redraw the app in a loop', async () => {
  const bridge = consoleBridge();
  let renders = 0;
  const guest = {
    name: 'chatty',
    components: {
      view: () => function View() {
        renders += 1;
        bridge.onConsole({ level: 'log', line: `render ${renders}` });
        return null;
      },
    },
  };
  const backend = new TestBackend(100, 30);
  const handle = await renderApp(backend, { plugins: [guest as never], config: {}, onExit: () => {}, consoleLog: bridge });
  const until = Date.now() + 500;
  while (Date.now() < until) { await flush(); await new Promise((r) => setTimeout(r, 10)); }
  handle.unmount();
  // With the log closed nothing redraws for a console line: the view drew once.
  expect(renders).toBeLessThan(3);
});

test('the last lines of the run are kept for stderr at exit, capped', () => {
  const bridge = consoleBridge(3);
  expect(bridge.kept()).toEqual([]);
  bridge.onConsole({ level: 'log', line: 'one' });
  bridge.onConsole({ level: 'warn', line: 'two\nthree' });
  bridge.onConsole({ level: 'error', line: 'four' });
  // Kept at once, not a microtask later: an exit may come before it runs.
  expect(bridge.kept()).toEqual(['[console.warn] two', '[console.warn] three', '[console.error] four']);
});

test('the log keeps its last lines only', async () => {
  const { createLogService, LOG_MAX_LINES } = await import('../services/log');
  const log = createLogService({});
  for (let i = 0; i < LOG_MAX_LINES + 5; i++) log.append(`line ${i}`);
  expect(log.read()).toHaveLength(LOG_MAX_LINES);
  expect(log.read()[0]).toEndWith(' line 5');
});
