// Screens the model can open (src/runtime/screens.ts): a plugin declares its screens, its
// own tools open one with `host.open(screen, params)`, the model an entry screen with
// `ui_open`; nothing opens over the person's typing or an open y/n, nothing of the host's
// own and nothing of a plugin the person does not trust; the system prompt lists the
// screens with the keys that open them, a plugin that joins late included.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FLOWTTY_VERSION, HOST_API } from '../version';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { fakeRemote } from './helpers/remote-fake';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
type Ui = Awaited<ReturnType<typeof bootApp>>;
const until = async (ui: Ui, ok: () => boolean, what: string, n = 200) => {
  for (let i = 0; i < n && !ok(); i++) await settle(1);
  if (!ok()) throw new Error(`never: ${what}\n${ui.backend.lastFrame}`);
};

// What the model was sent as the last tool result of request `i`.
const lastResult = (model: ScriptedModel, i: number): string => {
  const msgs = model.requests[i]!.messages as Array<{ role: string; content?: unknown }>;
  return String(msgs.filter((m) => m.role === 'tool').at(-1)?.content ?? '');
};
const systemOf = (model: ScriptedModel, i: number): string => {
  const msgs = model.requests[i]!.messages as Array<{ role: string; content?: unknown }>;
  return String(msgs.find((m) => m.role === 'system')?.content ?? '');
};
const toolNames = (model: ScriptedModel, i: number): string[] =>
  ((model.requests[i] as { tools?: Array<{ function: { name: string } }> }).tools ?? []).map((t) => t.function.name);

type TutorState = { lesson: number; renders: number; host: any };

// A guest shaped like a lessons plugin: its surface is mounted only while a lesson is up
// (`keycaps`), and it declares two screens — the entry, and one lesson by number, which
// its own tool opens through `host.open`.
const tutor = (state: TutorState) => (make: any) => [make('tutor', {
  name: 'tutor',
  description: 'Haskell lessons',
  keys: { lessons: 'H' },
  entry: ['lessons'],
  keycaps: () => (state.lesson ? ['H lessons'] : []),
  setup: (api: any) => { state.host = api.host; },
  components: {
    view: (api: any) => function View() {
      state.renders++;
      return api.ui.h(api.ui.Text, null, `Lesson ${state.lesson} of the tutor`);
    },
  },
  screens: {
    lessons: { entry: true, title: 'lessons', open: () => { state.lesson = 1; return 'lesson 1'; }, close: () => { state.lesson = 0; } },
    lesson: {
      title: 'one lesson',
      params: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
      tools: ['open_lesson'],
      open: (_api: unknown, p: { n: number }) => {
        if (p.n > 9) throw new Error(`there is no lesson ${p.n}`);
        state.lesson = p.n;
        return `lesson ${p.n}`;
      },
    },
  },
  aiTools: [{
    type: 'function',
    function: { name: 'open_lesson', description: 'Open a lesson.', parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } },
    run: async (args: { n: number }) => (await state.host.open('lesson', { n: args.n })).text,
  }],
})];

const fresh = (): TutorState => ({ lesson: 0, renders: 0, host: null });

test('ui_open opens a plugin\'s entry screen, and the system prompt lists its screens with the key and how to open them', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'ui_open', args: { screen: 'tutor' } }], [{ text: 'It is open.' }]);
  const state = fresh();
  const ui = await bootApp(model, 120, 30, tutor(state), {}, { chatMode: 'panel' });
  expect(ui.backend.lastFrame).not.toContain('Lesson 1 of the tutor');
  await ui.press('F');
  await ui.type('open haskell tutor');
  await ui.press('return');
  await until(ui, () => model.requests.length >= 2, 'the round after ui_open');
  expect(toolNames(model, 0)).toContain('ui_open');
  expect(lastResult(model, 1)).toContain('Opened tutor:lessons — lesson 1.');
  await until(ui, () => ui.backend.lastFrame.includes('Lesson 1 of the tutor'), 'the tutor on screen');
  const sys = systemOf(model, 0);
  expect(sys).toContain('## Screens');
  expect(sys).toContain('- tutor — lessons, one lesson · key H · open with ui_open("tutor"), open_lesson');
  ui.app.unmount();
});

test('a plugin\'s tool opens a screen with its params through host.open — its surface never mounted before; bad params and a refusal are said', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'open_lesson', args: { n: 3 } }], [{ text: 'Lesson three.' }],
    [{ tool: 'open_lesson', args: { n: 12 } }], [{ text: 'No such lesson.' }],
  );
  const state = fresh();
  const ui = await bootApp(model, 120, 30, tutor(state), {}, { chatMode: 'panel' });
  expect(state.renders).toBe(0);
  await ui.press('F');
  await ui.type('show me lesson 3');
  await ui.press('return');
  await until(ui, () => model.requests.length >= 2, 'the round after open_lesson');
  expect(lastResult(model, 1)).toContain('Opened tutor:lesson — lesson 3.');
  await until(ui, () => ui.backend.lastFrame.includes('Lesson 3 of the tutor'), 'lesson 3 on screen');
  expect(state.renders).toBeGreaterThan(0);

  await ui.type('and lesson 12');
  await ui.press('return');
  await until(ui, () => model.requests.length >= 4, 'the round after the refused open');
  expect(lastResult(model, 3)).toContain('tutor:lesson was not opened: there is no lesson 12');
  expect(state.lesson).toBe(3);

  // Params are checked against what the screen declares, before the plugin's `open`.
  expect((await state.host.open('lesson', {})).text).toMatch(/^Not opened: .*n/);
  expect((await state.host.open('lesson', { n: 'x' })).ok).toBe(false);
  expect((await state.host.open('lessons', { n: 1 })).text).toBe('Not opened: tutor:lessons takes no params.');
  expect((await state.host.open('nope')).text).toBe('Not opened: tutor has no screen nope — its screens: lessons, lesson.');
  // Closing asks the plugin; a screen that declared no way to close says Esc does.
  expect((await state.host.close('lessons')).text).toBe('Closed tutor:lessons.');
  expect(state.lesson).toBe(0);
  expect((await state.host.close('lesson')).text).toContain('cannot be closed by the host — Esc closes it');
  ui.app.unmount();
});

test('over the person\'s typing the screen waits, and opens when the turn ends with the draft left in the field', async () => {
  const model = new ScriptedModel();
  model.script([{ hold: true }, { tool: 'ui_open', args: { screen: 'tutor' } }], [{ text: 'Opening it.' }]);
  const state = fresh();
  const ui = await bootApp(model, 120, 30, tutor(state), {}, { chatMode: 'panel' });
  await ui.press('F');
  await ui.type('open the tutor');
  await ui.press('return');
  await until(ui, () => model.requests.length >= 1, 'the first request');
  await ui.type('half a thought');
  model.release();
  await until(ui, () => model.requests.length >= 2, 'the round after ui_open');
  expect(lastResult(model, 1)).toContain('tutor:lessons is not open yet: the person is typing in the chat. It opens when this turn ends.');
  await until(ui, () => ui.backend.lastFrame.includes('Lesson 1 of the tutor'), 'the tutor open after the turn');
  expect(ui.backend.lastFrame).toContain('half a thought');
  ui.app.unmount();
});

test('a deferred open is checked again when it runs: a plugin the person stopped trusting meanwhile is not opened', async () => {
  const model = new ScriptedModel();
  model.script([{ hold: true }, { tool: 'ui_open', args: { screen: 'tutor' } }], [{ hold: true }, { text: 'Opening it.' }]);
  const state = fresh();
  const ui = await bootApp(model, 120, 30, tutor(state), {}, { chatMode: 'panel' });
  await ui.press('F');
  await ui.type('open the tutor');
  await ui.press('return');
  await until(ui, () => model.requests.length >= 1, 'the first request');
  await ui.type('a draft');
  model.release();
  await until(ui, () => model.requests.length >= 2, 'the round after ui_open');
  expect(lastResult(model, 1)).toContain('It opens when this turn ends.');
  (ui.site.untrusted as Array<{ name: string }>).push({ name: 'tutor' });
  model.release();
  await until(ui, () => ui.backend.lastFrame.includes('Opening it.'), 'the turn ended');
  await settle(20);
  expect(state.lesson).toBe(0);
  ui.app.unmount();
});

test('over an open y/n the screen waits for the turn\'s end; a turn the person stops opens nothing it deferred', async () => {
  const model = new ScriptedModel();
  const WRITE = { type: 'function', function: { name: 'tutor_save', description: 'Save.', parameters: { type: 'object', properties: {} } } };
  model.script([{ tool: 'tutor_save', args: {} }], [{ text: 'Not saved.' }], [{ hold: true }, { text: 'never' }]);
  const state = fresh();
  const withWrite = (make: any) => {
    const [p] = tutor(state)(make);
    p.tools = [{ id: 'tutor', tools: [{ ...WRITE, write: true }], exec: async () => 'saved' }];
    return [p];
  };
  const ui = await bootApp(model, 120, 34, withWrite, {}, { chatMode: 'panel' });
  await ui.press('F');
  await ui.type('save it');
  await ui.press('return');
  await until(ui, () => ui.backend.lastFrame.includes('Confirm write'), 'the y/n');
  const waiting = await state.host.open('lessons');
  expect(waiting).toMatchObject({ ok: true, deferred: true });
  expect(waiting.text).toBe('tutor:lessons is not open yet: a question waits for the person\'s answer. It opens when this turn ends.');
  await settle();
  expect(state.lesson).toBe(0);
  await ui.press('n');
  await until(ui, () => state.lesson === 1, 'the tutor open after the turn');

  // Deferred in a turn the person then stops: it does not open.
  state.lesson = 0;
  await ui.type('again');
  await ui.press('return');
  await until(ui, () => model.requests.length >= 3, 'the held request');
  await ui.type('x');
  expect((await state.host.open('lessons')).deferred).toBe(true);
  await ui.press('escape');
  await settle(20);
  await ui.press('backspace');
  await settle(20);
  expect(state.lesson).toBe(0);
  ui.app.unmount();
});

test('the host\'s own panels, a built-in and a plugin the person does not trust are never opened — and no trust command is named', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'ui_open', args: { screen: 'plugins' } }], [{ text: 'a' }],
    [{ tool: 'ui_open', args: { screen: 'assistant' } }], [{ text: 'b' }],
    [{ tool: 'ui_open', args: { screen: 'evil' } }], [{ text: 'c' }],
    [{ tool: 'ui_open', args: { screen: 'mcp' } }], [{ text: 'd' }],
  );
  const state = fresh();
  const ui = await bootApp(model, 120, 30, tutor(state), {}, { chatMode: 'panel', untrusted: [{ name: 'evil' }] });
  await ui.press('F');
  const ask = async (text: string, n: number) => {
    await ui.type(text);
    await ui.press('return');
    await until(ui, () => model.requests.length >= n, `request ${n}`);
  };
  await ask('open plugins', 2);
  expect(lastResult(model, 1)).toContain('Not opened: plugins is the host\'s own — only the person opens it.');
  await ask('open the chat plugin', 4);
  expect(lastResult(model, 3)).toContain('Not opened: assistant is the host\'s own — only the person opens it.');
  await ask('open evil', 6);
  expect(lastResult(model, 5)).toContain('Not opened: evil is not trusted — only the person decides that.');
  expect(lastResult(model, 5)).not.toContain('plugins trust');
  await ask('open mcp', 8);
  expect(lastResult(model, 7)).toContain('host\'s own');
  // A plugin cannot reach them through `host.open` either.
  expect((await state.host.open('plugins:list')).text).toBe('Not opened: plugins is the host\'s own — only the person opens it.');
  expect((await state.host.open('assistant:chat')).ok).toBe(false);
  // Nothing untrusted is in the list the model reads.
  expect(systemOf(model, 0)).not.toContain('evil');
  ui.app.unmount();
});

test('a plugin the person disables in :plugins leaves the list and cannot be opened; enabled and trusted again, it is back', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-screens-'));
  const available = path.join(root, 'plugins-available');
  const enabled = path.join(root, 'plugins-enabled');
  const dir = path.join(available, 'lessons');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(enabled);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'lessons', version: '1.0.0', hostApi: HOST_API, flowtty: FLOWTTY_VERSION, description: 'the lessons plugin' }));
  fs.writeFileSync(path.join(dir, 'index.ts'), `export default ({ make }) => make('lessons', {
    keys: { lessonsOpen: 'G' }, entry: ['lessonsOpen'],
    screens: { home: { entry: true, title: 'lessons', open: () => 'the first lesson' } },
  });\n`);
  fs.symlinkSync(dir, path.join(enabled, 'lessons'));
  const trustFile = path.join(root, 'plugins.trusted.json');
  fs.writeFileSync(trustFile, JSON.stringify({ firstStartDone: true, dirs: { [fs.realpathSync(enabled)]: { lessons: fs.realpathSync(dir) } }, forgotten: {} }));
  const model = new ScriptedModel();
  model.script([{ text: 'one' }], [{ tool: 'ui_open', args: { screen: 'lessons' } }], [{ text: 'two' }], [{ text: 'three' }]);
  const ui = await bootApp(model, 160, 36, undefined, {}, { dirs: { available, enabled }, trustFile, chatMode: 'panel' });
  const say = async (text: string, n: number) => {
    await ui.press('F');
    await ui.type(text);
    await ui.press('return');
    await until(ui, () => model.requests.length >= n, `request ${n}`);
  };
  await say('hi', 1);
  expect(systemOf(model, 0)).toContain('- lessons — lessons · key G · open with ui_open("lessons")');
  expect(toolNames(model, 0)).toContain('ui_open');
  // Disabled from the panel: out of the list, and a call from a list seen before is refused.
  ui.backend.press({ name: ']', ctrl: true });
  await settle();
  await ui.press(':');
  await ui.type('plugins');
  await ui.press('return');
  await until(ui, () => ui.backend.lastFrame.includes('Flow Assist · Plugins'), 'the panel');
  for (let i = 0; i < 12 && !/› lessons /.test(ui.backend.lastFrame); i++) await ui.press('down');
  await ui.press('d');
  await until(ui, () => ui.backend.lastFrame.includes('disabled (restart to unload)'), 'the disabled row');
  await ui.press('escape');
  await say('open lessons', 3);
  expect(systemOf(model, 1)).not.toContain('- lessons —');
  expect(toolNames(model, 1)).not.toContain('ui_open');
  expect(lastResult(model, 2)).toContain('ui_open is gone — no plugin in the app has a screen it can open now');
  // Enabled and trusted again: the list has it again.
  ui.backend.press({ name: ']', ctrl: true });
  await settle();
  await ui.press(':');
  await ui.type('plugins');
  await ui.press('return');
  await until(ui, () => ui.backend.lastFrame.includes('Flow Assist · Plugins'), 'the panel again');
  for (let i = 0; i < 12 && !/› lessons /.test(ui.backend.lastFrame); i++) await ui.press('down');
  await ui.press('d');
  await until(ui, () => ui.backend.lastFrame.includes('not trusted'), 'the row waiting for trust');
  await ui.press('y');
  await until(ui, () => /lessons .*active/.test(ui.backend.lastFrame.replace(/\s+/g, ' ')), 'active again');
  await ui.press('escape');
  await say('back?', 4);
  expect(systemOf(model, 3)).toContain('- lessons — lessons · key G · open with ui_open("lessons")');
  ui.app.unmount();
});

test('a plugin that joins late gains its line in the next message\'s list', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'one' }], [{ text: 'two' }]);
  const fake = fakeRemote({ keys: { open: 'S' }, entry: ['open'] }, { description: 'a word finder' });
  fake.holdHello();
  const state = fresh();
  const ui = await bootApp(model, 120, 30, tutor(state), {}, { chatMode: 'panel', late: true, remote: { manifest: fake.manifest, transport: fake.transport } });
  await ui.press('F');
  await ui.type('hi');
  await ui.press('return');
  await until(ui, () => model.requests.length >= 1, 'the first request');
  expect(systemOf(model, 0)).toContain('- tutor —');
  expect(systemOf(model, 0)).not.toContain('- fake —');
  fake.answerHello();
  await until(ui, () => /fake/.test(JSON.stringify(ui.plugins.map((p) => p.name))), 'the plugin joined');
  await ui.type('again');
  await ui.press('return');
  await until(ui, () => model.requests.length >= 2, 'the second request');
  expect(systemOf(model, 1)).toContain('- fake — a word finder · key S · open with ui_open("fake")');
  ui.app.unmount();
});

test('ui_open opens a remote plugin\'s entry as its key does: the plugin is sent the key event, and its surface comes up', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'ui_open', args: { screen: 'fake' } }], [{ text: 'Open.' }]);
  const fake = fakeRemote({ keys: { open: 'S' }, entry: ['open'] }, { description: 'a word finder' });
  const ui = await bootApp(model, 120, 30, undefined, {}, { chatMode: 'panel', remote: { manifest: fake.manifest, transport: fake.transport } });
  // Closed, its frame takes its entry key — the key the person would press.
  fake.frame({ surface: null, keycaps: [], keys: { consume: ['open'] } });
  await settle();
  await ui.press('F');
  await ui.type('open the word finder');
  await ui.press('return');
  await until(ui, () => model.requests.length >= 2, 'the round after ui_open');
  expect(systemOf(model, 0)).toContain('- fake — a word finder · key S · open with ui_open("fake")');
  expect(lastResult(model, 1)).toContain('Opened fake:open.');
  const key = fake.events.find(([m, p]) => m === 'key' && (p as { action?: string }).action === 'open');
  expect(key?.[1]).toMatchObject({ name: 'S', id: 'S', action: 'open' });
  // The plugin answers the key as it answers the person's: its surface comes up.
  fake.frame({ surface: ['Text', {}, 'the finder is open'], keycaps: [{ action: 'open', label: 'find' }], keys: { consume: ['open'] } });
  await until(ui, () => ui.backend.lastFrame.includes('the finder is open'), 'the remote surface');
  ui.app.unmount();
});

test('a plugin that joins mid-turn is in the next round\'s list, with ui_open', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'datetime', args: {} }, { hold: true }], [{ text: 'done' }]);
  const fake = fakeRemote({ keys: { open: 'S' }, entry: ['open'] }, { description: 'a word finder' });
  fake.holdHello();
  const ui = await bootApp(model, 120, 30, undefined, {}, { chatMode: 'panel', late: true, remote: { manifest: fake.manifest, transport: fake.transport } });
  await ui.press('F');
  await ui.type('what time is it');
  await ui.press('return');
  await until(ui, () => model.requests.length >= 1, 'the first request');
  expect(systemOf(model, 0)).not.toContain('- fake —');
  fake.answerHello();
  await until(ui, () => ui.plugins.some((p) => p.name === 'fake'), 'the plugin joined');
  model.release();
  await until(ui, () => model.requests.length >= 2, 'the next round');
  expect(systemOf(model, 1)).toContain('- fake — a word finder · key S · open with ui_open("fake")');
  expect(toolNames(model, 1)).toContain('ui_open');
  ui.app.unmount();
});

test('a remote plugin whose screen is up is not sent its entry key again; one whose frame does not take the key is not sent it at all', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'ui_open', args: { screen: 'fake' } }], [{ text: 'ok' }], [{ tool: 'ui_open', args: { screen: 'fake' } }], [{ text: 'ok2' }]);
  const fake = fakeRemote({ keys: { open: 'S' }, entry: ['open'] }, { description: 'finder' });
  const ui = await bootApp(model, 120, 30, undefined, {}, { chatMode: 'panel', remote: { manifest: fake.manifest, transport: fake.transport } });
  const keys = () => fake.events.filter(([m, p]) => m === 'key' && (p as { action?: string }).action === 'open').length;
  await ui.press('F');
  // No frame yet takes the key: nothing is sent, and the model is told.
  await ui.type('open');
  await ui.press('return');
  await until(ui, () => model.requests.length >= 2, 'the first ui_open answered');
  expect(lastResult(model, 1)).toContain('fake:open was not opened: it does not take its entry key S now');
  expect(keys()).toBe(0);
  // The screen is up: a second ui_open says so and sends nothing.
  fake.frame({ surface: ['Text', {}, 'finder open'], keycaps: [{ action: 'open', label: 'find' }], keys: { consume: ['open'] } });
  await until(ui, () => ui.backend.lastFrame.includes('finder open'), 'the surface');
  await ui.type('again');
  await ui.press('return');
  await until(ui, () => model.requests.length >= 4, 'the second ui_open answered');
  expect(lastResult(model, 3)).toContain('fake:open is already open.');
  expect(keys()).toBe(0);
  ui.app.unmount();
});

test('a remote plugin with a modal of its own up is not sent its entry key: the key would answer the modal', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'ui_open', args: { screen: 'fake' } }], [{ text: 'ok' }]);
  const fake = fakeRemote({ keys: { open: 'S' }, entry: ['open'] }, { description: 'finder' });
  const ui = await bootApp(model, 120, 30, undefined, {}, { chatMode: 'panel', remote: { manifest: fake.manifest, transport: fake.transport } });
  const keys = () => fake.events.filter(([m, p]) => m === 'key' && (p as { action?: string }).action === 'open').length;
  fake.frame({ surface: null as never, modals: { confirm: ['Text', {}, 'Delete all? S = sure'] }, keycaps: [], keys: { consume: ['open'] } });
  await ui.press('F');
  await ui.type('open');
  await ui.press('return');
  await until(ui, () => model.requests.length >= 2, 'ui_open answered');
  expect(lastResult(model, 1)).toContain('fake:open is already open.');
  expect(keys()).toBe(0);
  ui.app.unmount();
});
