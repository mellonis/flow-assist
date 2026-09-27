// The config guard through the real app: a command the model runs rewrites
// config.local.json; the running config does not change, and the chat asks. Yes applies
// the change, no keeps the old config until restart.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptedConfigPath, guardConfigFiles, hostStateDir, loadConfig, resetSessionConfig, unguardConfigFiles } from '../config/load.ts';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
const local = () => path.join(hostStateDir(), 'config.local.json');
afterEach(() => {
  globalThis.fetch = realFetch;
  unguardConfigFiles();
  resetSessionConfig();
  fs.rmSync(local(), { force: true });
  fs.rmSync(acceptedConfigPath(), { force: true });
  for (const f of fs.readdirSync(hostStateDir())) if (f.includes('.rejected-')) fs.rmSync(path.join(hostStateDir(), f));
});

const settleUntil = async (ok: () => boolean, n = 200) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const autoRun = (c: Record<string, unknown>) => (c.shell as { autoRun?: unknown } | undefined)?.autoRun;

async function commandRewritesConfig() {
  fs.mkdirSync(hostStateDir(), { recursive: true });
  fs.rmSync(acceptedConfigPath(), { force: true });
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

test('no puts the accepted config back into the file, keeps the change beside it, and a restart starts on it', async () => {
  const { ui } = await commandRewritesConfig();
  await ui.press('n');
  await settleUntil(() => ui.backend.lastFrame.includes('Configured.'));
  expect(autoRun(ui.config)).toBeUndefined();
  expect(JSON.parse(fs.readFileSync(local(), 'utf8'))).toEqual({});
  const kept = fs.readdirSync(hostStateDir()).filter((f) => f.startsWith('config.local.json.rejected-'));
  expect(kept).toHaveLength(1);
  expect(ui.backend.lastFrame).toContain('Put the accepted config.local.json back — the change is kept in');
  expect(ui.backend.lastFrame).toContain(`${kept[0]}.`);
  expect(ui.backend.lastFrame).not.toContain('changed outside flow-assist');
  // Killed and started again: the accepted config.
  unguardConfigFiles();
  expect(autoRun(loadConfig())).toBeUndefined();
});

test('a person\'s own editor change made while the app was off is asked about at start, and the app starts without it', async () => {
  fs.mkdirSync(hostStateDir(), { recursive: true });
  fs.rmSync(acceptedConfigPath(), { force: true });
  fs.writeFileSync(local(), '{}');
  loadConfig();
  unguardConfigFiles(); // the app ends
  fs.writeFileSync(local(), JSON.stringify({ shell: { autoRun: true } }));
  // The next start, as `main` and `runInteractive` do it.
  const config = loadConfig();
  expect(autoRun(config)).toBeUndefined();
  guardConfigFiles();
  const ui = await bootApp(new ScriptedModel(), 120, 34);
  await settleUntil(() => ui.backend.lastFrame.includes('changed outside flow-assist'));
  await ui.press('F');
  await settleUntil(() => ui.backend.lastFrame.includes('shell.autoRun: (unset) → true'));
  expect(ui.backend.lastFrame).toContain('config.local.json changed outside flow-assist — apply? (y/n)');
  await ui.press('y');
  await settle(5);
  expect(autoRun(ui.config)).toBe(true);
});
