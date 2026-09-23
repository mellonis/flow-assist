// A command the model runs is shown WHILE it runs: one line in the chat that a click
// opens to its last lines, still there — in the state the person left it — once it
// ends. The real app on a test backend, a real /bin/sh.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
type Ui = Awaited<ReturnType<typeof bootApp>>;
const settleUntil = async (ok: () => boolean, n = 300) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const rowOf = (ui: Ui, needle: string) => ui.backend.lastFrame.split('\n').findIndex((r) => r.includes(needle));
const click = async (ui: Ui, y: number, x = 12) => { ui.backend.mouse('down', x, y); ui.backend.mouse('up', x, y); await settle(6); };

async function running(command: string) {
  const model = new ScriptedModel();
  model.script([{ tool: 'run_command', args: { command } }], [{ text: 'Done.' }]);
  const ui = await bootApp(model, 100, 24, undefined, { shell: { timeoutMs: 20000 } });
  await ui.press('F');
  await ui.type('go');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
  expect(ui.backend.lastFrame).toContain('Confirm write: run_command');
  await ui.press('y');
  return { ui, model };
}

test('the command is a line in the chat before it ends, and a click shows what it printed so far', async () => {
  const { ui } = await running('echo first; sleep 1.5; echo second');
  await settleUntil(() => rowOf(ui, 'echo first; sleep') >= 0);
  expect(rowOf(ui, 'echo first; sleep')).toBeGreaterThanOrEqual(0);
  expect(ui.backend.lastFrame).not.toContain('Done.');
  expect(ui.backend.lastFrame).toMatch(/echo first; sleep 1\.5; echo second · \d+ s/);
  await click(ui, rowOf(ui, 'echo first; sleep'));
  await settleUntil(() => ui.backend.lastFrame.includes('│ first'));
  expect(ui.backend.lastFrame).toContain('│ first');
  expect(ui.backend.lastFrame).not.toContain('│ second');
  await settleUntil(() => ui.backend.lastFrame.includes('Done.'));
  expect(ui.backend.lastFrame).toContain('Done.');
  // Opened while it ran, it is still open now that it has ended.
  expect(ui.backend.lastFrame).toContain('│ second');
  expect(ui.backend.lastFrame).toMatch(/✓ \d+\.\d s/);
  ui.app.unmount();
});

test('left folded, it ends folded — one line with its outcome', async () => {
  const { ui } = await running('echo hi; exit 3');
  await settleUntil(() => ui.backend.lastFrame.includes('Done.'));
  expect(ui.backend.lastFrame).toContain('Done.');
  expect(ui.backend.lastFrame).toMatch(/echo hi; exit 3 · ✗ exit 3 · \d+\.\d s/);
  expect(ui.backend.lastFrame).not.toContain('│ hi');
  ui.app.unmount();
});

test('the clock moves while nothing is printed', async () => {
  const { ui } = await running('sleep 2.5');
  await settleUntil(() => /sleep 2\.5 · 0 s/.test(ui.backend.lastFrame));
  expect(ui.backend.lastFrame).toMatch(/sleep 2\.5 · 0 s/);
  await settleUntil(() => /sleep 2\.5 · [12] s/.test(ui.backend.lastFrame));
  expect(ui.backend.lastFrame).toMatch(/sleep 2\.5 · [12] s/);
  await settleUntil(() => ui.backend.lastFrame.includes('Done.'));
  expect(ui.backend.lastFrame).toContain('Done.');
  ui.app.unmount();
});

test('Esc stops it, and the block stays, saying so', async () => {
  const { ui } = await running('sleep 5');
  await settleUntil(() => rowOf(ui, 'sleep 5 ·') >= 0);
  expect(rowOf(ui, 'sleep 5 ·')).toBeGreaterThanOrEqual(0);
  await ui.press('escape');
  await settleUntil(() => /sleep 5 · stopped/.test(ui.backend.lastFrame));
  expect(ui.backend.lastFrame).toMatch(/sleep 5 · stopped/);
  ui.app.unmount();
});

test('the person\'s own !command is live too, and says where it ran', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 24, undefined, { shell: { timeoutMs: 20000 } });
  await ui.press('F');
  await ui.type('!echo one; sleep 1.2; echo two');
  await ui.press('return');
  await settleUntil(() => /echo one; sleep 1\.2; echo two · \d+ s/.test(ui.backend.lastFrame));
  // Live, not the finished line — while it runs the tail is a bare running clock
  // ("· N s"), never the "✓ N.N s" the block settles on once it ends.
  expect(ui.backend.lastFrame).toMatch(/echo one; sleep 1\.2; echo two · \d+ s/);
  await settleUntil(() => /✓ \d+\.\d s · /.test(ui.backend.lastFrame));
  expect(ui.backend.lastFrame).toMatch(/✓ \d+\.\d s · /);
  ui.app.unmount();
});

test('two run_command calls in one turn never collide, even when the provider\'s own ids repeat', async () => {
  // ScriptedModel restarts its tool-call ids at `call_0` every round (some real
  // servers send '' or reuse ids too) — a view's callId must not depend on that id
  // being unique across the whole turn, only within its own call.
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'run_command', args: { command: 'echo AAA-first' } }],
    [{ tool: 'run_command', args: { command: 'echo BBB-second' } }],
    [{ text: 'Done.' }],
  );
  const ui = await bootApp(model, 100, 24, undefined, { shell: { timeoutMs: 20000 } });
  await ui.press('F');
  await ui.type('go');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command') && ui.backend.lastFrame.includes('echo AAA-first'));
  expect(ui.backend.lastFrame).toContain('echo AAA-first');
  await ui.press('y');
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command') && ui.backend.lastFrame.includes('echo BBB-second'));
  expect(ui.backend.lastFrame).toContain('echo BBB-second');
  await ui.press('y');
  await settleUntil(() => ui.backend.lastFrame.includes('Done.'));
  expect(ui.backend.lastFrame).toContain('Done.');
  // Both blocks stand — the second round's call never overwrote the first's.
  expect(ui.backend.lastFrame).toMatch(/echo AAA-first · ✓/);
  expect(ui.backend.lastFrame).toMatch(/echo BBB-second · ✓/);
  ui.app.unmount();
});

test('/clear during a running command: its eventual completion never lands in the fresh conversation', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'run_command', args: { command: 'echo XYZ; sleep 1.5' } }], [{ text: 'Done.' }]);
  const ui = await bootApp(model, 100, 24, undefined, { shell: { timeoutMs: 20000 } });
  await ui.press('F');
  await ui.type('go');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
  expect(ui.backend.lastFrame).toContain('Confirm write: run_command');
  await ui.press('y');
  await settleUntil(() => rowOf(ui, 'echo XYZ; sleep 1.5') >= 0);
  expect(rowOf(ui, 'echo XYZ; sleep 1.5')).toBeGreaterThanOrEqual(0);
  await ui.type('/clear');
  await ui.press('return');
  await settle(6);
  // Cleared at once.
  expect(ui.backend.lastFrame).not.toContain('echo XYZ');
  // Wait well past the command's own end (1.5s) — whether /clear's abort actually
  // killed it or it ran to completion regardless, its arrival must still not reach
  // the fresh, cleared conversation the person is now looking at.
  await settle(500);
  expect(ui.backend.lastFrame).not.toContain('XYZ');
  ui.app.unmount();
}, 10_000);

test('the model is sent a !command\'s output as before, and never a view', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Seen.' }]);
  const ui = await bootApp(model, 100, 24, undefined, { shell: { timeoutMs: 20000 } });
  await ui.press('F');
  await ui.type('!echo marker-42');
  await ui.press('return');
  await settleUntil(() => /✓ \d/.test(ui.backend.lastFrame));
  expect(ui.backend.lastFrame).toMatch(/✓ \d/);
  await ui.type('what did it print');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Seen.'));
  expect(ui.backend.lastFrame).toContain('Seen.');
  const sent = JSON.stringify(model.requests.at(-1)!.messages);
  expect(sent).toContain('marker-42');
  expect(sent).not.toContain('"views"');
  ui.app.unmount();
});
