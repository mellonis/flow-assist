// A settings-file change is asked in one conversation at a time: while a left session holds
// the y/n the session on screen leaves it alone, and an answer is checked against the file
// once more (AGENTS.md (Secrets)).
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptedConfigPath, guardConfigFiles, hostStateDir, loadConfig, resetSessionConfig, unguardConfigFiles } from '../config/load.ts';
import { ScriptedModel, bootApp, firstUser, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
const local = () => path.join(hostStateDir(), 'config.local.json');
afterEach(() => {
  globalThis.fetch = realFetch;
  // The guard is the process's: whatever a test armed or wrote is put back.
  unguardConfigFiles();
  resetSessionConfig();
  fs.rmSync(local(), { force: true });
  fs.rmSync(acceptedConfigPath(), { force: true });
  for (const f of fs.readdirSync(hostStateDir())) if (f.includes('.rejected-')) fs.rmSync(path.join(hostStateDir(), f));
});
const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const autoRun = (c: Record<string, unknown>) => (c.shell as { autoRun?: unknown } | undefined)?.autoRun;
const frameOf = (ui: { backend: { lastFrame?: string } }) => ui.backend.lastFrame ?? '';
type UI = Awaited<ReturnType<typeof bootApp>>;
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
async function pick(ui: UI, text: string) {
  ui.backend.press({ name: 's', ctrl: true });
  await settle(3);
  const rows = frameOf(ui).split('\n').filter((r) => / msgs? │/.test(r));
  const at = rows.findIndex((r) => r.includes(text));
  if (at < 0) throw new Error(`pick: no row with ${text}`);
  for (let i = 0; i < at; i++) { await ui.press('down'); await settle(1); }
  await ui.press('return');
  await settle(4);
}

// Session A's turn is left while it runs; the file changes under it; its next request
// raises the settings y/n in A, which is not on screen.
async function leftSettingsAsk() {
  fs.mkdirSync(hostStateDir(), { recursive: true });
  fs.rmSync(acceptedConfigPath(), { force: true });
  fs.writeFileSync(local(), '{}');
  loadConfig();
  guardConfigFiles();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-leave-busy-cfg-'));
  const model = new ScriptedModel();
  const aSub = model.when((req) => firstUser(req).includes('session A question'));
  aSub.script([{ hold: true }, { tool: 'datetime', args: {} }], [{ text: 'A done.' }]);
  model.script([{ text: 'B answer.' }], [{ text: 'B again.' }]);
  const ui = await bootApp(model, 120, 34, undefined, { sessions: { dir } }, { toastMs: 10_000 });
  await ui.press('F');
  await ask(ui, 'session A question');
  await settleUntil(() => aSub.held);
  await ask(ui, '/new');
  await settle(4);
  await ask(ui, 'session B question');
  await settleUntil(() => frameOf(ui).includes('B answer.'));
  fs.writeFileSync(local(), '{"shell":{"autoRun":true}}');
  let toast = '';
  aSub.release();
  await settleUntil(() => { const f = frameOf(ui); if (f.includes('waits for your answer')) toast = f.split('\n').find((r) => r.includes('waits for your answer')) ?? ''; return !!toast; });
  return { ui, aSub, toast };
}

test('the settings y/n raised by a left turn waits in that session; the turn waits; attached, it is answered there', async () => {
  const { ui, aSub, toast } = await leftSettingsAsk();
  expect(toast).toContain('a settings y/n');
  expect(frameOf(ui)).not.toContain('changed outside flow-assist');
  await new Promise((r) => setTimeout(r, 400));
  expect(aSub.requests).toHaveLength(1);
  await pick(ui, 'session A question');
  expect(frameOf(ui)).toContain('config.local.json changed outside flow-assist — apply? (y/n)');
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('A done.'));
  expect(autoRun(ui.config)).toBe(true);
  expect(aSub.requests).toHaveLength(2);
  ui.app.unmount();
});

test('while a left session holds the settings y/n, the session on screen does not ask the same change', async () => {
  const { ui } = await leftSettingsAsk();
  await ask(ui, 'B second question');
  await settleUntil(() => frameOf(ui).includes('B again.'));
  await settle(10);
  await new Promise((r) => setTimeout(r, 300));
  expect(frameOf(ui)).not.toContain('changed outside flow-assist');
  ui.app.unmount();
});

test('opposite answers to the same change never leave the running config apart from the file', async () => {
  const { ui } = await leftSettingsAsk();
  await ask(ui, 'B second question');
  await settle(10);
  await new Promise((r) => setTimeout(r, 300));
  // If the session on screen asks it too, it says no.
  if (frameOf(ui).includes('changed outside flow-assist')) { await ui.press('n'); await settleUntil(() => frameOf(ui).includes('B again.')); }
  await pick(ui, 'session A question');
  if (frameOf(ui).includes('changed outside flow-assist')) await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('A done.'));
  const file = JSON.parse(fs.readFileSync(local(), 'utf8')) as Record<string, unknown>;
  expect(autoRun(ui.config)).toBe(autoRun(file));
  ui.app.unmount();
});
