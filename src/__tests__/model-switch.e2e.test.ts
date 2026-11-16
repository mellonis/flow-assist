// `/model <name>`: the model THIS conversation runs, chosen from what the config knows —
// the reset, the roles and the catalogue's ids — never written back to the config. It is
// fixed for a turn in flight (the model reaches a request once per turn), saved with the
// session, and said in the chat as one note row.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { sessionFiles } from './helpers/session-files';
import { resetSessionConfig } from '../config/load';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; resetSessionConfig(); });

// A config the chooser has something to name: a base model, two roles and a catalogue.
const AI = {
  baseUrl: 'http://scripted.model',
  toolLoading: 'all',
  model: 'default-model',
  contextWindow: 300_000,
  models: {
    'default-model': { contextWindow: 262_000 },
    'small-model': { contextWindow: 256_000 },
    'big-model': { contextWindow: 512_000 },
    'other-model': { contextWindow: 128_000 },
  },
  roles: { fast: 'small-model', deep: 'big-model' },
};

type UI = Awaited<ReturnType<typeof bootApp>>;
const CTRL_RIGHT_BRACKET = { name: ']', ctrl: true };
const press = async (ui: UI, key: { name: string; ctrl?: boolean }) => { ui.backend.press(key); await settle(); };
const settleUntil = async (ok: () => boolean, n = 200) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const command = async (ui: UI, text: string) => { await ui.type(text); await ui.press('return'); await settle(); };
const say = async (ui: UI, text: string) => { await ui.type(text); await ui.press('return'); await settle(20); };
// How many rows of the frame say exactly this — a note is said once.
const said = (ui: UI, text: string) => ui.backend.lastFrame.split('\n').filter((l) => l.includes(text)).length;
// The one session's file in a directory of the test's own.
const stateFile = (dir: string) => {
  const names = sessionFiles(dir);
  expect(names).toHaveLength(1);
  const file = path.join(dir, names[0]!);
  return { file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> };
};
const boot = async (model: ScriptedModel, sessions?: string) => {
  // A fresh copy per boot: `:config set --session ai.model …` is laid on the running
  // config in place, and a shared object would leak one test's value into the next.
  const ai = { ...AI, models: { ...AI.models }, roles: { ...AI.roles } };
  const ui = await bootApp(model, 110, 30, undefined, { ai, ...(sessions ? { sessions: { dir: sessions } } : {}) });
  await ui.press('F');
  return ui;
};

test('/model deep names a role, says it once, and the next request carries its model', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'one' }], [{ text: 'two' }]);
  const ui = await boot(model);
  await command(ui, '/model deep');
  expect(said(ui, 'model: deep → big-model')).toBe(1);
  expect(ui.backend.lastFrame).not.toContain('small-model');
  await say(ui, 'which model is this?');
  expect(model.requests.at(-1)?.model).toBe('big-model');
  ui.app.unmount();
});

test('a catalogue id is a name of its own, and the session file keeps it', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'one' }], [{ text: 'two' }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-model-e2e-'));
  const ui = await boot(model, dir);
  await say(ui, 'first');
  expect(model.requests.at(-1)?.model).toBe('default-model');
  await command(ui, '/model other-model');
  expect(said(ui, 'model: other-model')).toBe(1);
  const state = stateFile(dir);
  expect(state.read().model).toBe('other-model');
  await say(ui, 'second');
  expect(model.requests.at(-1)?.model).toBe('other-model');
  ui.app.unmount();
});

// The reset is a CLEAR, not a pin: `default` leaves the session with no model of its own,
// so the conversation follows ai.model — `config set ai.model` included.
test('/model default clears the session\'s own model, and the next request follows ai.model', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'one' }], [{ text: 'two' }], [{ text: 'three' }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-model-e2e-'));
  const ui = await boot(model, dir);
  await say(ui, 'first');
  await command(ui, '/model deep');
  expect(model.requests).toHaveLength(1); // a switch sends nothing
  await command(ui, '/model default');
  expect(said(ui, 'model: default (default-model)')).toBe(1);
  const state = stateFile(dir);
  expect(Object.hasOwn(state.read(), 'model')).toBe(false);
  await say(ui, 'second');
  expect(model.requests.at(-1)?.model).toBe('default-model');
  // Nothing is pinned: a later change of ai.model is what this session runs. The chat
  // goes away first, so `:` is the host's line and not a character in the field.
  await press(ui, CTRL_RIGHT_BRACKET);
  await ui.press(':');
  await ui.type('config set --session ai.model big-model');
  await ui.press('return');
  await settle();
  expect(ui.backend.lastFrame).toContain('"big-model" · session');
  await ui.press('F');
  await say(ui, 'third');
  expect(model.requests.at(-1)?.model).toBe('big-model');
  ui.app.unmount();
});

test('an unknown name is refused with the list, and nothing changes', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'one' }], [{ text: 'two' }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-model-e2e-'));
  const ui = await boot(model, dir);
  await say(ui, 'first');
  await command(ui, '/model nope');
  expect(ui.backend.lastFrame).toContain('no model or role "nope" here (/model lists them)');
  expect(said(ui, 'model: ')).toBe(0);
  expect(Object.hasOwn(stateFile(dir).read(), 'model')).toBe(false);
  await say(ui, 'second');
  expect(model.requests.at(-1)?.model).toBe('default-model');
  ui.app.unmount();
});

// The model reaches a request once per turn: a switch made while an answer streams lands
// on the next turn, never on the request already sent.
test('a switch while an answer streams leaves the running turn on its model, the next turn on the new one', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Started' }, { hold: true }, { text: ' and finished.' }], [{ text: 'Second.' }]);
  const ui = await boot(model);
  await ui.type('go');
  await ui.press('return');
  await settleUntil(() => model.held && ui.backend.lastFrame.includes('Started'));
  expect(model.requests).toHaveLength(1);
  await command(ui, '/model deep');
  expect(said(ui, 'model: deep → big-model')).toBe(1);
  expect(model.requests[0]?.model).toBe('default-model');
  model.release();
  await settleUntil(() => ui.backend.lastFrame.includes('Started and finished.'));
  await say(ui, 'again');
  expect(model.requests.at(-1)?.model).toBe('big-model');
  ui.app.unmount();
});
