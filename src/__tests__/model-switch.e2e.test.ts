// `/model <name>`: the model THIS conversation runs, chosen from what the config knows —
// the reset, the roles and the catalogue's ids — never written back to the config. It is
// fixed for a turn in flight (the model reaches a request once per turn), saved with the
// session, and said in the chat as one note row. `/model` alone opens a panel over the
// conversation's place, with the row the session runs marked; the frame's title names the
// model after the chat's own name.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle, settleUntil as settleUntilShared } from './helpers/scripted';
import { sessionFiles } from './helpers/session-files';
import { resetSessionConfig } from '../config/load';

import { nativeFetch } from './helpers/test-setup.ts';
import { hostColour } from './helpers/palette';
const realFetch = nativeFetch;
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
// makes a ticking wait a flake. `settle(1)` is a few milliseconds of work, so the bound
// is deliberately generous.
const settleUntil = async (ok: () => boolean, n = 2000) => settleUntilShared(ok, n);
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
// The one session's file in a directory of the test's own. The first save is debounced
// (the 250 ms of src/assistant/conversation-session.ts's `persist`), so the count waits
// for the disk to carry the file before it says how many there are.
const stateFile = async (dir: string) => {
  await settleUntil(() => sessionFiles(dir).length > 0);
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
// The panel the bare command opens, waited for rather than counted in ticks.
const openModelPanel = async (ui: UI) => {
  await command(ui, '/model');
  await settleUntil(() => ui.backend.lastFrame.includes('Flow Assist · Model'));
};
const panelRows = (ui: UI) => ui.backend.lastFrame.split('\n');
const rowAt = (ui: UI, text: string) => panelRows(ui).findIndex((l) => l.includes(text));
// The colour of a row's detail — the window — where the panel draws its `tone`: `ok`
// marks the choice the session runs.
const detailFg = (ui: UI, row: string, detail: string) => {
  const y = rowAt(ui, row);
  return (ui.backend.lastBuffer!.get(panelRows(ui)[y]!.indexOf(detail), y).style as { fg?: string }).fg;
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
  const state = await stateFile(dir);
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
  const state = await stateFile(dir);
  expect(state.read().model).toBe('other-model');
  await ask(model, ui, 'second');
  expect(model.requests.at(-1)?.model).toBe('other-model');
  ui.app.unmount();
});

// `/model` alone opens the panel the config fills: the reset first, then the roles in the
// order `ai.roles` names them, then the ids no role names — each with its window — and
// the row the session runs marked. It sends nothing and changes nothing.
test('/model opens the panel: default, the roles and the ids, each with its window', async () => {
  const model = new ScriptedModel();
  const ui = await boot(model);
  await openModelPanel(ui);
  const at = (t: string) => rowAt(ui, t);
  expect(at('default (default-model)')).toBeGreaterThan(-1);
  expect(at('default (default-model)')).toBeLessThan(at('fast → small-model'));
  expect(at('fast → small-model')).toBeLessThan(at('deep → big-model'));
  expect(at('deep → big-model')).toBeLessThan(at('other-model')); // an id no role names
  expect(panelRows(ui)[at('default (default-model)')]).toContain('262k');
  expect(panelRows(ui)[at('fast → small-model')]).toContain('256k');
  expect(panelRows(ui)[at('deep → big-model')]).toContain('512k');
  expect(panelRows(ui)[at('other-model')]).toContain('128k');
  // The mark: the session runs ai.model, so the reset's row is the choice it is on — its
  // window in the panel's `ok` tone, the others dim.
  expect(detailFg(ui, 'default (default-model)', '262k')).toBe(hostColour('dark', 'chat', 'ok'));
  expect(detailFg(ui, 'other-model', '128k')).not.toBe('green');
  await ui.press('escape');
  await settle();
  expect(ui.backend.lastFrame).not.toContain('Flow Assist · Model');
  expect(model.requests).toHaveLength(0);
  ui.app.unmount();
});

// `return` takes the row under the cursor through the set path `/model <name>` takes: the
// same field, the same save, the same note — one local function, no second copy.
test('return on a row sets it as /model <name> does, and closes the panel', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'one' }], [{ text: 'two' }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-model-e2e-'));
  const ui = await boot(model, dir);
  await ask(model, ui, 'first');
  await openModelPanel(ui);
  await press(ui, { name: 'down' }); // fast → small-model
  await press(ui, { name: 'down' }); // deep → big-model
  await ui.press('return');
  await noteOnce(ui, 'model: deep → big-model');
  expect(ui.backend.lastFrame).not.toContain('Flow Assist · Model');
  expect((await stateFile(dir)).read().model).toBe('big-model');
  await ask(model, ui, 'second');
  expect(model.requests.at(-1)?.model).toBe('big-model');
  ui.app.unmount();
});

// Esc closes the panel and changes nothing: no note, no save, no request.
test('esc closes the panel, and nothing of the session moves', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'one' }], [{ text: 'two' }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-model-e2e-'));
  const ui = await boot(model, dir);
  await ask(model, ui, 'first');
  await openModelPanel(ui);
  await press(ui, { name: 'down' });
  await ui.press('escape');
  await settle();
  expect(ui.backend.lastFrame).not.toContain('Flow Assist · Model');
  expect(said(ui, 'model: ')).toBe(0);
  expect(Object.hasOwn((await stateFile(dir)).read(), 'model')).toBe(false);
  expect(model.requests).toHaveLength(1);
  await ask(model, ui, 'second');
  expect(model.requests.at(-1)?.model).toBe('default-model');
  ui.app.unmount();
});

// A name a role maps to marks the ROLE's row: the mark is the choice the session names,
// not what it resolves to.
test('a mapped id marks the role\'s row in the panel', async () => {
  const model = new ScriptedModel();
  const ui = await boot(model);
  await command(ui, '/model big-model');
  await noteOnce(ui, 'model: big-model');
  await openModelPanel(ui);
  expect(detailFg(ui, 'deep → big-model', '512k')).toBe(hostColour('dark', 'chat', 'ok'));
  expect(detailFg(ui, 'default (default-model)', '262k')).not.toBe('green');
  await ui.press('escape');
  await settle();
  ui.app.unmount();
});

// The frame names the model after the chat's own name, whatever the session runs.
test('the frame\'s title names the model the conversation runs, cut to one row', async () => {
  const model = new ScriptedModel();
  const ui = await boot(model);
  expect(ui.backend.lastFrame).toContain('ƒ Flow Assist (default-model)');
  await command(ui, '/model deep');
  await noteOnce(ui, 'model: deep → big-model');
  expect(ui.backend.lastFrame).toContain('ƒ Flow Assist (big-model)');
  ui.app.unmount();
  // A name too long for the frame is cut on the border, never wrapped onto a row of its own.
  const long = 'model-with-a-name-far-too-long-to-fit-any-frame-this-host-ever-draws-for-a-person-to-read';
  const ai = { ...AI, models: { ...AI.models, [long]: { contextWindow: 1000 } } };
  const narrow = await bootApp(new ScriptedModel(), 100, 30, undefined, { ai });
  await narrow.press('F');
  await command(narrow, `/model ${long}`);
  await settleUntil(() => narrow.backend.lastFrame.includes('ƒ Flow Assist (model-with'));
  const titled = narrow.backend.lastFrame.split('\n').filter((l) => l.includes('Flow Assist'));
  expect(titled).toHaveLength(1);
  expect(titled[0]).toContain('…');
  expect(narrow.backend.lastFrame).not.toContain(long);
  narrow.app.unmount();
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
  const state = await stateFile(dir);
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
  expect(Object.hasOwn((await stateFile(dir)).read(), 'model')).toBe(false);
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
