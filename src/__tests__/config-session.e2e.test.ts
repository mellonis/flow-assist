// `:config set --session`: a setting changed for this run only, as a person uses it —
// live at once, never in a file, gone after a restart — and `:config get` saying where
// a value comes from.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { getDeep, hostStateDir, loadConfig, resetSessionConfig, saveConfigUnset } from '../config/load';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetSessionConfig();
  // The run's own settings file (a temp dir under `bun test`) is shared by every test
  // of the process: what a test saves there, it takes back.
  saveConfigUnset('ui.verbs');
});

const savedFile = () => path.join(hostStateDir(), 'config.local.json');
const readSaved = () => (fs.existsSync(savedFile()) ? fs.readFileSync(savedFile(), 'utf8') : null);
const lastRow = (ui: { backend: { lastFrame: string } }) => ui.backend.lastFrame.split('\n').filter((r) => r.trim()).at(-1) ?? '';

async function command(ui: Awaited<ReturnType<typeof bootApp>>, line: string) {
  await ui.press(':');
  await ui.type(line);
  await ui.press('return');
  await settle();
}

// The word the status line says while the model works is `ui.verbs`, read per request:
// the one place on screen a changed setting shows at once.
async function wordWhileWorking(ui: Awaited<ReturnType<typeof bootApp>>, model: ScriptedModel): Promise<string> {
  await ui.press('F');
  await ui.type('go');
  await ui.press('return');
  await settle(10);
  const word = /([A-Z][a-z]+)…/.exec(ui.backend.lastFrame.split('\n').find((r) => /Esc stops/.test(r)) ?? '')?.[1] ?? '';
  model.release();
  await settle(10);
  return word;
}

test(':config set --session is live at once, touches no file, and a restart loses it', async () => {
  const before = readSaved();
  const model = new ScriptedModel();
  model.script([{ hold: true }, { text: 'ok' }]);
  const ui = await bootApp(model, 110, 28);
  await command(ui, 'config set --session ui.verbs ["Pinning"]');
  expect(lastRow(ui)).toContain('["Pinning"] · session');
  await command(ui, 'config get ui.verbs');
  expect(lastRow(ui)).toContain('["Pinning"] · session');
  // Every reader sees it: the chat's status line, and a fresh load of the config.
  expect(await wordWhileWorking(ui, model)).toBe('Pinning');
  expect(getDeep(loadConfig(), 'ui.verbs')).toEqual(['Pinning']);
  expect(readSaved()).toBe(before);
  ui.app.unmount();

  // A restart: a new app starts on an empty session.
  const again = await bootApp(new ScriptedModel(), 110, 28);
  await command(again, 'config get ui.verbs');
  expect(lastRow(again)).toContain('no key ui.verbs · default');
  expect(getDeep(loadConfig(), 'ui.verbs')).not.toEqual(['Pinning']);
  again.app.unmount();
});

test('the value reads the same on the `:` line as in a shell: one layer of quotes is the line\'s', async () => {
  const ui = await bootApp(new ScriptedModel(), 110, 28);
  await command(ui, `config set --session ui.verbs '["Quoted"]'`);
  expect(lastRow(ui)).toContain('["Quoted"] · session');
  await command(ui, 'config set --session user.name "Ada Lovelace"');
  expect(lastRow(ui)).toContain('"Ada Lovelace" · session');
  ui.app.unmount();
});

test(':config set without --session saves the value — and it is live at once too', async () => {
  const model = new ScriptedModel();
  model.script([{ hold: true }, { text: 'ok' }]);
  const ui = await bootApp(model, 110, 28);
  await command(ui, 'config set --session ui.verbs ["Fleeting"]');
  await command(ui, 'config set ui.verbs ["Keeping"]');
  expect(lastRow(ui)).toContain('["Keeping"] · local');
  expect(JSON.parse(readSaved() ?? '{}')).toMatchObject({ ui: { verbs: ['Keeping'] } });
  // The saved value is what the key is now: the session's gives way to it.
  await command(ui, 'config get ui.verbs');
  expect(lastRow(ui)).toContain('["Keeping"] · local');
  expect(await wordWhileWorking(ui, model)).toBe('Keeping');
  ui.app.unmount();
});

test('a key read only at start says so, in both scopes', async () => {
  const ui = await bootApp(new ScriptedModel(), 110, 28);
  await command(ui, 'config set --session ui.mouse false');
  expect(lastRow(ui)).toContain('false · session — takes effect on restart');
  await command(ui, 'config set --session ui.verbs ["Now"]');
  expect(lastRow(ui)).not.toContain('restart');
  await command(ui, 'config set ui.mouse false');
  expect(lastRow(ui)).toContain('false · local — takes effect on restart');
  saveConfigUnset('ui.mouse');
  ui.app.unmount();
});
