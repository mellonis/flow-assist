// The config guard through the real app: a command the model runs rewrites
// config.local.json; the running config does not change, and the chat asks. Yes applies
// the change, no keeps the old config until restart.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardConfigFiles, hostStateDir, loadConfig, resetSessionConfig, unguardConfigFiles } from '../config/load.ts';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
const local = () => path.join(hostStateDir(), 'config.local.json');
afterEach(() => {
  globalThis.fetch = realFetch;
  unguardConfigFiles();
  resetSessionConfig();
  fs.rmSync(local(), { force: true });
});

const settleUntil = async (ok: () => boolean, n = 200) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const autoRun = (c: Record<string, unknown>) => (c.shell as { autoRun?: unknown } | undefined)?.autoRun;

async function commandRewritesConfig() {
  fs.mkdirSync(hostStateDir(), { recursive: true });
  fs.writeFileSync(local(), '{}');
  // As `runInteractive` does: the start reads the files, then the guard is armed.
  loadConfig();
  guardConfigFiles();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-guard-root-')));
  const model = new ScriptedModel();
  const edit = `printf '%s' '{"shell":{"autoRun":true}}' > '${local()}'`;
  model.script(
    [{ tool: 'run_command', args: { command: edit } }],
    [{ text: 'Configured.' }],
  );
  const ui = await bootApp(model, 120, 34, undefined, { shell: { roots: [root] } });
  await ui.press('F');
  await ui.type('turn on auto run');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write'));
  await ui.press('y');
  await settleUntil(() => ui.backend.lastFrame.includes('changed outside flow-assist'));
  return { ui, model };
}

test('a command editing config.local.json does not change the live config, and the chat asks with the keys it changes', async () => {
  const { ui, model } = await commandRewritesConfig();
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('config.local.json changed outside flow-assist — apply? (y/n)');
  expect(frame).toContain('shell.autoRun: (unset) → true');
  // The file says true; the app does not.
  expect(JSON.parse(fs.readFileSync(local(), 'utf8'))).toEqual({ shell: { autoRun: true } });
  expect(autoRun(ui.config)).toBeUndefined();
  expect(autoRun(loadConfig())).toBeUndefined();
  // The model waits for the answer: the next request has not gone out.
  expect(model.requests).toHaveLength(1);
});

test('yes applies it to the running config, and the turn goes on', async () => {
  const { ui, model } = await commandRewritesConfig();
  await ui.press('y');
  await settleUntil(() => ui.backend.lastFrame.includes('Configured.'));
  expect(autoRun(ui.config)).toBe(true);
  expect(autoRun(loadConfig())).toBe(true);
  expect(ui.backend.lastFrame).toContain('Applied config.local.json: shell.autoRun.');
  expect(model.requests).toHaveLength(2);
});

test('no keeps the old config until restart, and is not asked again', async () => {
  const { ui } = await commandRewritesConfig();
  await ui.press('n');
  await settleUntil(() => ui.backend.lastFrame.includes('Configured.'));
  expect(autoRun(ui.config)).toBeUndefined();
  expect(autoRun(loadConfig())).toBeUndefined();
  expect(ui.backend.lastFrame).toContain('Kept the running config — config.local.json is read as it is at the next start.');
  expect(ui.backend.lastFrame).not.toContain('changed outside flow-assist');
  // A restart reads the person's file as it is.
  unguardConfigFiles();
  expect(autoRun(loadConfig())).toBe(true);
});
