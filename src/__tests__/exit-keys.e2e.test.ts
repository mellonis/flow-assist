// Ctrl+C, Ctrl+D and Ctrl+Z through the real TUI: one press never ends or suspends the
// app; Ctrl+C stops a running turn; Esc stops a turn on its first press and the queue
// comes back into the field when a turn is stopped.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type UI = Awaited<ReturnType<typeof bootApp>>;
// A ctrl key as a terminal delivers it; the answer is whether the app consumed it —
// what a TTY backend reads to skip its own exit / suspend.
const ctrl = async (ui: UI, name: string) => { const consumed = ui.backend.press({ name, ctrl: true }); await settle(); return consumed; };
const settleUntil = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { await settle(2); if (cond()) return; await wait(20); }
};

test('Ctrl+C while an answer is coming stops it, as Esc does — the app lives, nothing is armed', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Looking, ' }, { hold: true }, { text: 'never.' }]);
  const ui = await bootApp(model, 100, 26);
  await ui.press('F');
  await ui.type('how far is my branch');
  await ui.press('return');
  expect(ui.backend.lastFrame).toContain('Looking,');

  expect(await ctrl(ui, 'c')).toBe(true);
  await settle(10);
  expect(ui.backend.lastFrame).toContain('stopped (Esc)');
  expect(ui.backend.lastFrame).not.toContain('never.');
  expect(ui.backend.lastFrame).not.toContain('again to exit');
  expect(ui.exits()).toBe(0);
  ui.app.unmount();
});

test('Ctrl+C while a write waits for its y/n declines it and stops the turn', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-exitkeys-')));
  const model = new ScriptedModel();
  model.script([{ tool: 'run_command', args: { command: 'echo hi' } }], [{ text: 'never.' }]);
  const ui = await bootApp(model, 110, 30, undefined, { shell: { roots: [root] } });
  await ui.press('F');
  await ui.type('run it');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('echo hi'));

  expect(await ctrl(ui, 'c')).toBe(true);
  await settleUntil(() => ui.backend.lastFrame.includes('stopped (Esc)'));
  expect(ui.backend.lastFrame).not.toContain('never.');
  expect(ui.exits()).toBe(0);
  ui.app.unmount();
});

test('idle, Ctrl+C arms (`^c again to exit`) and a second exits; another key in between disarms', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 26);
  await ui.press('F');

  expect(await ctrl(ui, 'c')).toBe(true);
  expect(ui.backend.lastFrame).toContain('^c again to exit');
  expect(ui.exits()).toBe(0);
  await ui.type('x'); // any other key disarms
  expect(ui.backend.lastFrame).not.toContain('again to exit');
  expect(await ctrl(ui, 'c')).toBe(true);
  expect(ui.exits()).toBe(0);

  expect(await ctrl(ui, 'c')).toBe(true);
  expect(ui.exits()).toBe(1);
  ui.app.unmount();
});

test('Ctrl+C takes a second press on the start screen too, said on the bottom row', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 26);
  expect(await ctrl(ui, 'c')).toBe(true);
  expect(ui.backend.lastFrame).toContain('^c again to exit');
  expect(ui.exits()).toBe(0);
  expect(await ctrl(ui, 'c')).toBe(true);
  expect(ui.exits()).toBe(1);
  ui.app.unmount();
});

test('the arm fades after about two seconds', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 26);
  await ctrl(ui, 'c');
  expect(ui.backend.lastFrame).toContain('^c again to exit');
  await wait(2100);
  await settle();
  expect(ui.backend.lastFrame).not.toContain('again to exit');
  await ctrl(ui, 'c');
  expect(ui.exits()).toBe(0);
  ui.app.unmount();
});

test('Ctrl+D on an empty field arms the exit, a second exits; in a field with text it deletes forward', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 26);
  await ui.press('F');
  await ui.type('abc');
  await ui.press('left');
  expect(await ctrl(ui, 'd')).toBe(true);
  expect(ui.backend.lastFrame).toContain('› ab');
  expect(ui.backend.lastFrame).not.toContain('› abc');
  expect(ui.backend.lastFrame).not.toContain('again to exit');

  await ui.press('escape'); // clear the field
  expect(await ctrl(ui, 'd')).toBe(true);
  expect(ui.backend.lastFrame).toContain('^d again to exit');
  expect(ui.exits()).toBe(0);
  expect(await ctrl(ui, 'd')).toBe(true);
  expect(ui.exits()).toBe(1);
  ui.app.unmount();
});

test('Ctrl+Z once does not suspend (`^z again to suspend`); twice lets the key through to the backend', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Looking, ' }, { hold: true }, { text: 'done.' }]);
  const ui = await bootApp(model, 100, 26);
  await ui.press('F');
  await ui.type('go');
  await ui.press('return');

  // Mid-answer: an accidental press never pauses the request.
  expect(await ctrl(ui, 'z')).toBe(true);
  expect(ui.backend.lastFrame).toContain('^z again to suspend');
  await ui.type('a'); // disarms
  expect(ui.backend.lastFrame).not.toContain('again to suspend');

  expect(await ctrl(ui, 'z')).toBe(true);
  // The second press is NOT consumed: the TTY backend hands the terminal back and
  // stops the process (SIGTSTP); on `fg` it repaints.
  expect(await ctrl(ui, 'z')).toBe(false);
  expect(ui.exits()).toBe(0);
  model.release();
  await settle(20);
  expect(ui.backend.lastFrame).toContain('done.');
  ui.app.unmount();
});

test('with a message queued and a tool running, ONE Esc stops the turn; the queue comes back into the field unsent', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'datetime', args: {} }], [{ text: 'Checking, ' }, { hold: true }, { text: 'never.' }]);
  const ui = await bootApp(model, 100, 30);
  await ui.press('F');
  await ui.type('first');
  await ui.press('return');
  await settle(10);
  await ui.type('second thoughts');
  await ui.press('return');
  await ui.type('third');
  await ui.press('return');
  expect(ui.backend.lastFrame).toMatch(/queued \(2\)/);
  await ui.type('a draft');

  await ui.press('escape');
  await settle(10);
  // Stopped on the first press, and nothing was sent after it.
  expect(ui.backend.lastFrame).toContain('stopped (Esc)');
  expect(ui.backend.lastFrame).not.toMatch(/queued/);
  expect(model.requests).toHaveLength(2);
  // The queue is back in the field, in order, ahead of the draft — nothing lost.
  expect(ui.backend.lastFrame).toContain('› second thoughts');
  expect(ui.backend.lastFrame).toContain('third');
  expect(ui.backend.lastFrame).toContain('a draft');
  const rows = ui.backend.lastFrame.split('\n');
  const at = (t: string) => rows.findIndex((r) => r.includes(t));
  expect(at('› second thoughts')).toBeLessThan(at('third'));
  expect(at('third')).toBeLessThan(at('a draft'));
  await wait(50);
  expect(model.requests).toHaveLength(2);
  ui.app.unmount();
});

test('a failed turn does not send the queue either — it comes back into the field', async () => {
  const model = new ScriptedModel();
  const ui = await bootApp(model, 100, 28);
  // The first request hangs until the test lets it fail, as a provider's 500 would.
  const scripted = globalThis.fetch;
  let failNow: () => void = () => {};
  const failed = new Promise<void>((r) => { failNow = r; });
  let calls = 0;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls++;
    if (calls === 1) { await failed; return new Response('upstream is down', { status: 500 }); }
    return scripted(url as string, init);
  }) as typeof fetch;
  await ui.press('F');
  await ui.type('first');
  await ui.press('return');
  await ui.type('queued one');
  await ui.press('return');
  expect(ui.backend.lastFrame).toMatch(/queued/);

  failNow();
  await settle(20);
  expect(ui.backend.lastFrame).toContain('upstream is down');
  expect(ui.backend.lastFrame).toContain('› queued one');
  expect(ui.backend.lastFrame).not.toMatch(/queued:/);
  expect(calls).toBe(1);
  ui.app.unmount();
});

test('↑ on an empty field takes the last queued message back; with the queue empty it walks history', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'one.' }], [{ text: 'Looking, ' }, { hold: true }, { text: 'done.' }]);
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await ui.type('earlier prompt');
  await ui.press('return');
  await settle(14);
  await ui.type('now');
  await ui.press('return');
  await ui.type('queued a');
  await ui.press('return');
  await ui.type('queued b');
  await ui.press('return');
  expect(ui.backend.lastFrame).toMatch(/queued \(2\)/);
  expect(ui.backend.lastFrame).toContain('↑ takes it back');

  await ui.press('up');
  expect(ui.backend.lastFrame).toContain('› queued b');
  expect(ui.backend.lastFrame).toMatch(/queued: .*queued a/);
  expect(ui.backend.lastFrame).not.toContain('↑ takes it back'); // not from a draft
  await ui.press('escape'); // the turn is still running: Esc stops it, the field stays
  await settle(10);
  expect(ui.backend.lastFrame).toContain('stopped (Esc)');
  // The one left in the queue came back, ahead of what was in the field.
  expect(ui.backend.lastFrame).toContain('› queued a');
  expect(ui.backend.lastFrame).toContain('queued b');

  await ui.press('escape'); // idle now: clears the field
  await ui.press('up');
  expect(ui.backend.lastFrame).toContain('› now');
  await ui.press('up');
  expect(ui.backend.lastFrame).toContain('› earlier prompt');
  ui.app.unmount();
});
