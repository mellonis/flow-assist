// The model's `config_set`: bound by the marks on the schema (src/config/schema.ts).
// A key without the mark for the scope is refused before the person is asked; a
// marked one asks y/n like any write, the block showing the command line the person
// would have typed, and the value is live at once — or said to wait for a restart.
// The auto mode never answers it.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { getDeep, hostStateDir, loadConfig, resetSessionConfig, saveConfigUnset } from '../config/load';
import { modelMaySave, modelMaySet } from '../config/schema';
import type { Make } from '../loader/plugin';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetSessionConfig();
  // The run's own settings file (a temp dir under `bun test`) is shared by every test.
  for (const key of ['ui.verbs', 'ui.mouse', 'plugins.notes']) saveConfigUnset(key);
});

const settleUntil = async (ok: () => boolean, n = 100) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const savedFile = () => path.join(hostStateDir(), 'config.local.json');
const readSaved = () => (fs.existsSync(savedFile()) ? fs.readFileSync(savedFile(), 'utf8') : null);
const lastRow = (ui: { backend: { lastFrame: string } }) => ui.backend.lastFrame.split('\n').filter((r) => r.trim()).at(-1) ?? '';
// What the model was sent as the result of its call, in the request after it.
const resultSent = (model: ScriptedModel, n = 1) => {
  const msgs = model.requests[n]!.messages as { role: string; content?: unknown }[];
  return String(msgs.filter((m) => m.role === 'tool').at(-1)?.content ?? '');
};

// A guest whose schema marks one key for the session, one for saving too, and leaves one
// to the person.
const notes = (make: Make) => make('notes', {
  configSchema: z.object({
    compact: z.boolean().register(modelMaySet, { reason: 'a display flag' }).optional(),
    wide: z.boolean().register(modelMaySet, { reason: 'the width' }).register(modelMaySave, { reason: 'the width' }).optional(),
    file: z.string().optional(),
  }).optional(),
} as never);

async function ask(model: ScriptedModel, calls: Record<string, unknown>[], guests?: (make: Make) => ReturnType<Make>[]) {
  model.script(calls.map((args) => ({ tool: 'config_set', args })), [{ text: 'Done.' }]);
  const ui = await bootApp(model, 110, 30, guests as never);
  await ui.press('F');
  await ui.type('change it');
  await ui.press('return');
  await settle(10);
  return ui;
}

test('an unmarked key is refused before the y/n, naming the key and the command', async () => {
  const before = readSaved();
  const model = new ScriptedModel();
  const ui = await ask(model, [{ key: 'ai.model', value: 'other-model', scope: 'session' }]);
  await settleUntil(() => model.requests.length === 2);
  expect(ui.backend.lastFrame).not.toContain('Confirm write');
  const sent = resultSent(model);
  expect(sent).toContain('ai.model');
  expect(sent).toContain('config set --session ai.model other-model');
  expect(getDeep(loadConfig(), 'ai.model')).not.toBe('other-model');
  expect(readSaved()).toBe(before);
  ui.app.unmount();
});

test('a saved write of a key marked for the session only is refused before the y/n', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, [{ key: 'plugins.notes.compact', value: true, scope: 'saved' }], (make) => [notes(make)]);
  await settleUntil(() => model.requests.length === 2);
  expect(ui.backend.lastFrame).not.toContain('Confirm write');
  const sent = resultSent(model);
  expect(sent).toContain('plugins.notes.compact');
  expect(sent).toContain('config set plugins.notes.compact true');
  ui.app.unmount();
});

test('a marked key asks y/n, the block shows the command line, and the value is live at once', async () => {
  const before = readSaved();
  const model = new ScriptedModel();
  const ui = await ask(model, [{ key: 'ui.verbs', value: ['Thinking'], scope: 'session' }]);
  expect(ui.backend.lastFrame).toContain('Confirm write: config_set');
  expect(ui.backend.lastFrame).toContain(`config set --session ui.verbs '["Thinking"]'`);
  await ui.press('y');
  await settleUntil(() => model.requests.length === 2);
  expect(resultSent(model)).toMatch(/ui\.verbs is \["Thinking"\] for this session/);
  await settle(5);
  await ui.press('escape', 'escape');
  await ui.press(':');
  await ui.type('config get ui.verbs');
  await ui.press('return');
  expect(lastRow(ui)).toContain('["Thinking"] · session');
  expect(readSaved()).toBe(before);
  ui.app.unmount();
});

test('a saved write goes where `config set` writes, and a key read at start says so', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, [{ key: 'ui.mouse', value: false, scope: 'saved' }]);
  expect(ui.backend.lastFrame).toContain('config set ui.mouse false');
  expect(ui.backend.lastFrame).not.toContain('--session');
  await ui.press('y');
  await settleUntil(() => model.requests.length === 2);
  expect(resultSent(model)).toMatch(/ui\.mouse is false, saved to config\.local\.json.*takes effect on restart/);
  expect(JSON.parse(readSaved() ?? '{}')).toMatchObject({ ui: { mouse: false } });
  ui.app.unmount();
});

test('declined, nothing changes', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, [{ key: 'ui.verbs', value: ['Nope'], scope: 'session' }]);
  expect(ui.backend.lastFrame).toContain('Confirm write: config_set');
  await ui.press('n');
  await settleUntil(() => model.requests.length === 2);
  expect(resultSent(model)).toContain('DECLINED');
  expect(getDeep(loadConfig(), 'ui.verbs')).not.toEqual(['Nope']);
  ui.app.unmount();
});

test('the auto mode never answers it', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'config_set', args: { key: 'ui.verbs', value: ['Auto'], scope: 'session' } }], [{ text: 'Done.' }]);
  const ui = await bootApp(model, 110, 30);
  await ui.press('F');
  // ⇧⇥ twice: ask → reads → all.
  for (let i = 0; i < 2; i++) { ui.backend.press({ name: 'tab', shift: true }); await settle(); }
  expect(ui.backend.lastFrame).toContain('auto: writes');
  await ui.type('change it');
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('Confirm write: config_set');
  expect(model.requests).toHaveLength(1);
  await ui.press('n');
  await settleUntil(() => model.requests.length === 2);
  ui.app.unmount();
});

test('a plugin\'s marked key is the model\'s to set; its unmarked key is refused', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, [
    { key: 'plugins.notes.file', value: '/etc/passwd', scope: 'saved' },
    { key: 'plugins.notes.wide', value: true, scope: 'saved' },
  ], (make) => [notes(make)]);
  // The first call never asked; the second does.
  expect(ui.backend.lastFrame).toContain('config set plugins.notes.wide true');
  await ui.press('y');
  await settleUntil(() => model.requests.length === 2);
  const msgs = model.requests[1]!.messages as { role: string; content?: unknown }[];
  const results = msgs.filter((m) => m.role === 'tool').map((m) => String(m.content));
  expect(results[0]).toContain('config set plugins.notes.file /etc/passwd');
  expect(results[1]).toMatch(/plugins\.notes\.wide is true, saved/);
  expect(JSON.parse(readSaved() ?? '{}')).toMatchObject({ plugins: { notes: { wide: true } } });
  ui.app.unmount();
});
