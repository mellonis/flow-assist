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
// How many rows of the frame say this — a note is said once.
const said = (ui: UI, text: string) => ui.backend.lastFrame.split('\n').filter((l) => l.includes(text)).length;
// Wait for a state the app reaches, rather than for a number of ticks: a loaded machine
// makes a ticking wait a flake. `settle(1)` is well under a millisecond of work, so the
// bound is generous.
const settleUntil = async (ok: () => boolean, n = 2000) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const command = async (ui: UI, text: string) => { await ui.type(text); await ui.press('return'); await settle(); };
// A question: wait for the request it sends, so nothing below races the stream's end.
const ask = async (model: ScriptedModel, ui: UI, text: string) => {
  const before = model.requests.length;
  await ui.type(text);
  await ui.press('return');
  await settleUntil(() => model.requests.length > before);
  await settle();
};
// A note is one row: wait for the render that draws it, and hold it to exactly one.
const noteOnce = async (ui: UI, text: string) => {
  await settleUntil(() => said(ui, text) === 1);
  expect(said(ui, text)).toBe(1);
};
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
  await noteOnce(ui, 'model: deep → big-model');
  expect(ui.backend.lastFrame).not.toContain('small-model');
  await ask(model, ui, 'which model is this?');
  expect(model.requests.at(-1)?.model).toBe('big-model');
  ui.app.unmount();
});

// The id a role maps to is an id the person may name: `modelChoice` takes any id of
// `ai.models`, and the note names it as the catalogue does.
test('an id a role maps to is a name too, and the session file keeps it', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'one' }], [{ text: 'two' }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-model-e2e-'));
  const ui = await boot(model, dir);
  await ask(model, ui, 'first');
  expect(model.requests.at(-1)?.model).toBe('default-model');
  await command(ui, '/model big-model'); // a role's target, not a row's name
  await noteOnce(ui, 'model: big-model');
  const state = stateFile(dir);
  expect(state.read().model).toBe('big-model');
  await ask(model, ui, 'second');
  expect(model.requests.at(-1)?.model).toBe('big-model');
  ui.app.unmount();
});

test('a catalogue id no role maps to is a name of its own, and the session file keeps it', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'one' }], [{ text: 'two' }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-model-e2e-'));
  const ui = await boot(model, dir);
  await ask(model, ui, 'first');
  expect(model.requests.at(-1)?.model).toBe('default-model');
  await command(ui, '/model other-model');
  await noteOnce(ui, 'model: other-model');
  const state = stateFile(dir);
  expect(state.read().model).toBe('other-model');
  await ask(model, ui, 'second');
  expect(model.requests.at(-1)?.model).toBe('other-model');
  ui.app.unmount();
});

// `/model` alone says where things stand in the vocabulary `/model` takes — the row the
// conversation runs — and sends nothing.
test('/model alone says the row the conversation runs, and sends no request', async () => {
  const model = new ScriptedModel();
  const ui = await boot(model);
  await command(ui, '/model');
  await noteOnce(ui, 'model: default (default-model) · /model <name> to change');
  expect(model.requests).toHaveLength(0);
  ui.app.unmount();
});

// The reset is a CLEAR, not a pin: `default` leaves the session with no model of its own,
// so the conversation follows ai.model — `config set ai.model` included.
test('/model default clears the session\'s own model, and the next request follows ai.model', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'one' }], [{ text: 'two' }], [{ text: 'three' }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-model-e2e-'));
  const ui = await boot(model, dir);
  await ask(model, ui, 'first');
  await command(ui, '/model deep');
  expect(model.requests).toHaveLength(1); // a switch sends nothing
  await command(ui, '/model default');
  await noteOnce(ui, 'model: default (default-model)');
  const state = stateFile(dir);
  expect(Object.hasOwn(state.read(), 'model')).toBe(false);
  await ask(model, ui, 'second');
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
  await ask(model, ui, 'third');
  expect(model.requests.at(-1)?.model).toBe('big-model');
  ui.app.unmount();
});

test('an unknown name is refused with the list, the line stays, and nothing changes', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'one' }], [{ text: 'two' }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-model-e2e-'));
  const ui = await boot(model, dir);
  await ask(model, ui, 'first');
  await command(ui, '/model nope');
  expect(ui.backend.lastFrame).toContain('no model or role "nope" here (/model lists them)');
  // A typo leaves the line as typed, as /auto, /notes and /mode do.
  expect(ui.backend.lastFrame).toContain('› /model nope');
  expect(said(ui, 'model: ')).toBe(0);
  expect(Object.hasOwn(stateFile(dir).read(), 'model')).toBe(false);
  await ui.press('escape'); // the field is cleared, so the next question is its own
  await settle();
  await ask(model, ui, 'second');
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
  await noteOnce(ui, 'model: deep → big-model');
  expect(model.requests[0]?.model).toBe('default-model');
  model.release();
  await settleUntil(() => ui.backend.lastFrame.includes('Started and finished.'));
  await ask(model, ui, 'again');
  expect(model.requests.at(-1)?.model).toBe('big-model');
  ui.app.unmount();
});
