// A message queued while something ran goes out when that thing ends — and must not
// undo what the ending itself just put on screen. `send` used to lay its new list out
// from what was last DRAWN, so when it ran before the render that carried the finished
// block (a zero-delay timer that won the race against React's commit — seen under
// load), the block came back in its live state, ticking forever.
//
// The race is made deterministic here: while armed, a zero-delay timer runs as a
// microtask, which is always before React's commit.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
afterEach(() => { globalThis.fetch = realFetch; globalThis.setTimeout = realSetTimeout; });

const wait = (ms: number) => new Promise((r) => realSetTimeout(r, ms));
const settleUntil = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { await settle(2); if (cond()) return; await wait(20); }
};
// Zero-delay timers jump ahead of the render; every other timer is left alone.
const armRace = () => {
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (!ms) { queueMicrotask(() => fn(...args)); return 0 as unknown as ReturnType<typeof setTimeout>; }
    return realSetTimeout(fn, ms, ...args);
  }) as typeof setTimeout;
};

test('a message queued during a !command goes out after it, and the command keeps its finished block', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-race-')));
  const model = new ScriptedModel();
  model.script([{ text: 'Answered.' }]);
  const ui = await bootApp(model, 110, 32, undefined, { shell: { roots: [root] } });
  await ui.press('F');
  await ui.type('!sleep 0.4; echo done');
  await ui.press('return');
  await settle(4);
  await ui.type('what happened?');
  await ui.press('return');
  await settle(4);
  expect(ui.backend.lastFrame).toContain('queued');
  armRace();
  await settleUntil(() => ui.backend.lastFrame.includes('Answered.'));
  globalThis.setTimeout = realSetTimeout;
  await settle(6);
  expect(model.requests).toHaveLength(1);
  expect(ui.backend.lastFrame).toMatch(/sleep 0\.4; echo done · ✓/);
  ui.app.unmount();
});

test('a message queued during an answer goes out after it, and the answer keeps its finished state', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'First' }, { hold: true }, { text: ' answer.' }], [{ text: 'Second answer.' }]);
  const ui = await bootApp(model, 110, 32);
  await ui.press('F');
  await ui.type('one');
  await ui.press('return');
  await settle(8);
  await ui.type('two');
  await ui.press('return');
  await settle(4);
  expect(ui.backend.lastFrame).toContain('queued');
  armRace();
  model.release();
  await settleUntil(() => ui.backend.lastFrame.includes('Second answer.'));
  globalThis.setTimeout = realSetTimeout;
  await settle(6);
  expect(model.requests).toHaveLength(2);
  // The first answer's end is kept: its full text, not the text it had while live.
  expect(ui.backend.lastFrame).toContain('First answer.');
  ui.app.unmount();
});
