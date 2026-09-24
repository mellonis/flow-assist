// The person can always leave: Ctrl+C stops what can be stopped, and once nothing is
// left to stop — or what was stopped will not let go — it arms and exits. Whatever
// holds the keyboard (a modal, the `:` line), Ctrl+C / Ctrl+D reach the exit.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Make } from '../loader/plugin.ts';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type UI = Awaited<ReturnType<typeof bootApp>>;
const ctrl = async (ui: UI, name: string) => { const consumed = ui.backend.press({ name, ctrl: true }); await settle(); return consumed; };
const settleUntil = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { await settle(2); if (cond()) return; await wait(20); }
};

// A conversation with one answer in it, after which every request hangs and ignores
// its signal.
async function talkedThenStuck() {
  const model = new ScriptedModel();
  model.script([{ text: 'Sure.' }]);
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await ui.type('a question');
  await ui.press('return');
  await settle(14);
  globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
  return ui;
}

test('/compact waiting on a request that never answers: Ctrl+C stops it, the next two exit', async () => {
  const ui = await talkedThenStuck();
  await ui.type('/compact');
  await ui.press('return');
  expect(ui.backend.lastFrame).toContain('compact…');

  expect(await ctrl(ui, 'c')).toBe(true);
  await settle(6);
  expect(ui.backend.lastFrame).toContain('/compact stopped (^c)');
  expect(ui.backend.lastFrame).not.toContain('compact…');
  expect(ui.backend.lastFrame).not.toContain('compacted');
  expect(ui.exits()).toBe(0);
  expect(await ctrl(ui, 'c')).toBe(true);
  expect(ui.backend.lastFrame).toContain('^c again to exit');
  expect(await ctrl(ui, 'c')).toBe(true);
  expect(ui.exits()).toBe(1);
  ui.app.unmount();
});

test('Esc stops /compact too', async () => {
  const ui = await talkedThenStuck();
  await ui.type('/compact');
  await ui.press('return');
  await ui.press('escape');
  await settle(6);
  expect(ui.backend.lastFrame).toContain('/compact stopped (Esc)');
  expect(ui.backend.lastFrame).not.toContain('compact…');
  ui.app.unmount();
});

test('a tool that ignores its signal: Ctrl+C stops the turn, and the next two presses exit', async () => {
  const stuck = (make: Make) => make('stuck', {
    tools: [{
      id: 'stuck',
      tools: [{ type: 'function', function: { name: 'wait_forever', description: 'Waits.', parameters: { type: 'object', properties: {} } } }],
      exec: () => new Promise(() => {}),
    }],
  } as never);
  const model = new ScriptedModel();
  model.script([{ tool: 'wait_forever', args: {} }]);
  const ui = await bootApp(model, 110, 30, (make) => [stuck(make)]);
  await ui.press('F');
  await ui.type('go');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('wait_forever'));
  expect(ui.backend.lastFrame).toContain('Esc stops');

  expect(await ctrl(ui, 'c')).toBe(true);
  // The tool never lets go — nothing is left for Esc to stop, and the line says so.
  expect(ui.backend.lastFrame).not.toContain('Esc stops');
  expect(ui.exits()).toBe(0);
  expect(await ctrl(ui, 'c')).toBe(true);
  expect(ui.backend.lastFrame).toContain('^c again to exit');
  expect(await ctrl(ui, 'c')).toBe(true);
  expect(ui.exits()).toBe(1);
  ui.app.unmount();
});

test('with a catch-all modal open and the chat closed, Ctrl+C still arms and exits', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 28);
  await ui.press(':');
  await ui.type('help');
  await ui.press('return');
  expect(ui.backend.lastFrame).toContain('Help');
  expect(await ctrl(ui, 'c')).toBe(true);
  expect(ui.backend.lastFrame).toContain('^c again to exit');
  expect(ui.exits()).toBe(0);
  expect(await ctrl(ui, 'c')).toBe(true);
  expect(ui.exits()).toBe(1);
  ui.app.unmount();
});

test('a turn running with the chat closed is not stopped by Ctrl+C — it arms, and a second exits', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Looking, ' }, { hold: true }, { text: 'done.' }]);
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await ui.type('go');
  await ui.press('return');
  await ui.type('/exit'); // closes the chat; the answer goes on
  await ui.press('return');
  expect(ui.backend.lastFrame).not.toContain('Flow Assist');

  expect(await ctrl(ui, 'c')).toBe(true);
  expect(ui.backend.lastFrame).toContain('^c again to exit');
  expect(ui.exits()).toBe(0);
  await ui.press('x'); // disarms; the turn still runs
  model.release();
  await settle(20);
  await ui.press('F');
  expect(ui.backend.lastFrame).toContain('done.');
  expect(ui.backend.lastFrame).not.toContain('stopped (');
  await ui.press('escape', 'escape'); // close again
  expect(await ctrl(ui, 'c')).toBe(true);
  expect(await ctrl(ui, 'c')).toBe(true);
  expect(ui.exits()).toBe(1);
  ui.app.unmount();
});

test('Ctrl+D with the `:` line open types nothing into it — it arms the exit', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 24);
  await ui.press(':');
  await ui.type('hel');
  expect(await ctrl(ui, 'd')).toBe(true);
  expect(ui.backend.lastFrame).toContain(': hel');
  expect(ui.backend.lastFrame).not.toContain(': held');
  ui.app.unmount();
});

test('/resume <n> is offered by ↑ in the session it resumed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-resume-hist-'));
  const model = new ScriptedModel();
  model.script([{ text: 'first answer' }], [{ text: 'second answer' }]);
  const ui = await bootApp(model, 110, 30, undefined, { sessions: { dir } });
  await ui.press('F');
  await ui.type('first question');
  await ui.press('return');
  await settle(14);
  await ui.type('/clear');
  await ui.press('return');
  await settle(4);
  await ui.type('second question');
  await ui.press('return');
  await settle(14);
  await ui.type('/resume');
  await ui.press('return');
  await settle(4);
  const n = /(\d+)\. first question/.exec(ui.backend.lastFrame)?.[1];
  expect(n).toBeDefined();
  await ui.type(`/resume ${n}`);
  await ui.press('return');
  await settle(4);
  expect(ui.backend.lastFrame).toContain('first answer');
  await ui.press('up');
  expect(ui.backend.lastFrame).toContain(`› /resume ${n}`);
  ui.app.unmount();
});
