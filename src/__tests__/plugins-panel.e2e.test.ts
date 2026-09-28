// `:plugins` — the plugins' states and what the person can do to them, from the `:` line
// with the chat closed, without the assistant plugin at all, and as `/plugins` in the
// chat's frame. Each test lays out a plugins-available/ and a plugins-enabled/ of its own
// and a trust record of its own; nothing reaches the person's own.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestBackend } from '@flowtty/core/testing';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { fakeRemote } from './helpers/remote-fake';
import { FLOWTTY_VERSION, HOST_API } from '../version';
import { loadPlugins } from '../loader/build';
import { makeFactory } from '../loader/plugin';
import { assembleToolRegistry } from '../loader/tools';
import { renderApp } from '../runtime/app';
import { renderChatModal, renderHelp, renderLogModal, renderReminder } from '../views/modals';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Ui = Awaited<ReturnType<typeof bootApp>>;
const until = async (ui: { backend: TestBackend }, ok: () => boolean, what: string, n = 300) => {
  for (let i = 0; i < n && !ok(); i++) await settle(1);
  if (!ok()) throw new Error(`never: ${what}\n${ui.backend.lastFrame}`);
};
const flat = (s: string) => s.replace(/\s+/g, ' ');
// The panel's row of a plugin: its name, then what the panel says of it.
const rowOf = (ui: { backend: TestBackend }, name: string): string =>
  flat(ui.backend.lastFrame.split('\n').find((r) => new RegExp(`[›│ ] ${name} `).test(r) && r.includes('·')) ?? ui.backend.lastFrame.split('\n').find((r) => r.includes(` ${name} `)) ?? '');

function pluginDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-plugins-panel-'));
  const available = path.join(root, 'plugins-available');
  const enabled = path.join(root, 'plugins-enabled');
  fs.mkdirSync(available);
  fs.mkdirSync(enabled);
  return { root, available, enabled, trustFile: path.join(root, 'plugins.trusted.json') };
}
type Dirs = ReturnType<typeof pluginDirs>;

const MANIFEST = (name: string, extra: Record<string, unknown> = {}) => ({ name, version: '1.2.3', hostApi: HOST_API, flowtty: FLOWTTY_VERSION, description: `the ${name} plugin`, ...extra });

// A JS plugin on disk: a manifest and a builder with one tool and one key.
function jsPlugin(d: Dirs, name: string, opts: { body?: string; manifest?: Record<string, unknown>; where?: 'enabled' | 'disabled' | 'none'; into?: string } = {}): string {
  const dir = opts.into ?? path.join(d.available, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(MANIFEST(name, opts.manifest)));
  const body = opts.body ?? `({ make }) => make('${name}', {
    keys: { ${name}Open: 'G' },
    tools: [{ id: '${name}', tools: [{ type: 'function', function: { name: '${name}_ping', description: 'Ping ${name}.', parameters: { type: 'object', properties: {} } } }], exec: async () => 'pong from ${name}' }],
  })`;
  fs.writeFileSync(path.join(dir, 'index.ts'), `export default ${body};\n`);
  const where = opts.where ?? 'enabled';
  if (where === 'enabled') fs.symlinkSync(dir, path.join(d.enabled, name));
  if (where === 'disabled') { fs.mkdirSync(path.join(d.enabled, '.disabled'), { recursive: true }); fs.symlinkSync(dir, path.join(d.enabled, '.disabled', name)); }
  return dir;
}

// A trust record that trusts each name at the target given (a first start done).
function trustRecord(d: Dirs, trusted: Record<string, string>) {
  fs.writeFileSync(d.trustFile, JSON.stringify({ firstStartDone: true, dirs: { [fs.realpathSync(d.enabled)]: Object.fromEntries(Object.entries(trusted).map(([n, t]) => [n, fs.realpathSync(t)])) }, forgotten: {} }));
}
const readTrust = (d: Dirs) => JSON.parse(fs.readFileSync(d.trustFile, 'utf8')) as { dirs: Record<string, Record<string, string>> };

const openPanel = async (ui: Ui) => {
  await ui.press(':');
  await ui.type('plugins');
  await ui.press('return');
  await until(ui, () => ui.backend.lastFrame.includes('Flow Assist · Plugins'), 'the panel');
};
// Moves the cursor onto a plugin's row.
const cursorTo = async (ui: Ui, name: string) => {
  for (let i = 0; i < 12; i++) await ui.press('up');
  for (let i = 0; i < 12 && !new RegExp(`› ${name} `).test(ui.backend.lastFrame); i++) await ui.press('down');
  expect(ui.backend.lastFrame).toMatch(new RegExp(`› ${name} `));
};
const sentTools = (model: ScriptedModel, i: number) => ((model.requests[i] as { tools?: { function: { name: string } }[] }).tools ?? []).map((t) => t.function.name);

test(':plugins opens with the chat closed: an active plugin with what it brings, a skipped one with its reason, one still starting', async () => {
  const d = pluginDirs();
  jsPlugin(d, 'good');
  jsPlugin(d, 'broken', { body: `() => { throw new Error('needs BROKEN_TOKEN first') }` });
  const fake = fakeRemote({ tools: [] }, { description: 'a remote one' });
  fake.holdHello();
  fs.mkdirSync(path.join(d.available, 'fake'));
  fs.writeFileSync(path.join(d.available, 'fake', 'manifest.json'), JSON.stringify({ ...fake.manifest, version: '0.9.0', flowtty: FLOWTTY_VERSION }));
  fs.symlinkSync(path.join(d.available, 'fake'), path.join(d.enabled, 'fake'));
  const ui = await bootApp(new ScriptedModel(), 160, 36, undefined, {}, { dirs: d, late: true, remote: { manifest: fake.manifest, transport: fake.transport } });
  // The chat is closed; the `:` line opens the panel over the start screen.
  expect(ui.backend.lastFrame).not.toContain('Ask anything');
  await openPanel(ui);
  await until(ui, () => rowOf(ui, 'good').includes('v1.2.3'), 'the versions read');
  expect(rowOf(ui, 'good')).toContain('v1.2.3 · active · 1 group · 1 tool · keys G');
  expect(rowOf(ui, 'broken')).toContain('skipped: needs BROKEN_TOKEN first');
  expect(rowOf(ui, 'fake')).toContain('starting…');
  // It holds the keys: a plugin's key does nothing while it is up.
  expect(ui.backend.lastFrame).toContain('Esc close');
  expect(ui.backend.lastFrame).toContain('r restart');
  expect(ui.backend.lastFrame).toContain('d disable / enable');
  expect(ui.backend.lastFrame).toContain('y trust');
  // The plugin joins while the panel is up: its row follows.
  fake.answerHello();
  await until(ui, () => rowOf(ui, 'fake').includes('active'), 'the remote plugin active');
  // ⏎ on a row: its details, the skip reason whole.
  await cursorTo(ui, 'broken');
  await ui.press('return');
  await until(ui, () => ui.backend.lastFrame.includes('Plugins · broken'), 'the details');
  expect(flat(ui.backend.lastFrame)).toContain('skipped needs BROKEN_TOKEN first');
  expect(flat(ui.backend.lastFrame)).toContain(`flowtty ${FLOWTTY_VERSION}`);
  expect(flat(ui.backend.lastFrame)).toContain(`host API ${HOST_API}`);
  await ui.press('escape');
  await until(ui, () => ui.backend.lastFrame.includes('Flow Assist · Plugins') && !ui.backend.lastFrame.includes('Plugins · broken'), 'back to the list');
  await ui.press('escape');
  expect(ui.backend.lastFrame).not.toContain('Flow Assist · Plugins');
  ui.app.unmount();
});

test('the details mark a required setting that is unset and mask a secret-looking one', async () => {
  const d = pluginDirs();
  jsPlugin(d, 'needy', { manifest: { requiredSettings: ['NEEDY_UNSET_VAR_FOR_TEST'] } });
  const ui = await bootApp(new ScriptedModel(), 160, 36, undefined, { plugins: { needy: { url: 'http://x', apiToken: 'hunter2hunter2' } } }, { dirs: d });
  await openPanel(ui);
  await until(ui, () => rowOf(ui, 'needy').includes('missing settings: NEEDY_UNSET_VAR_FOR_TEST'), 'the missing setting on its row');
  await cursorTo(ui, 'needy');
  await ui.press('return');
  await until(ui, () => ui.backend.lastFrame.includes('Plugins · needy'), 'the details');
  const f = flat(ui.backend.lastFrame);
  expect(f).toContain('NEEDY_UNSET_VAR_FOR_TEST required — unset');
  expect(f).toContain('plugins.needy.url "http://x"');
  expect(f).toContain('plugins.needy.apiToken ‹masked›');
  expect(f).not.toContain('hunter2');
  ui.app.unmount();
});

test('disable takes the plugin\'s tools out of the next round — a call already made is told it is gone — and the row says a restart unloads the rest; enable brings them back', async () => {
  const d = pluginDirs();
  jsPlugin(d, 'good');
  const model = new ScriptedModel();
  model.script([{ hold: true }, { tool: 'good_ping', args: {} }], [{ text: 'first done' }], [{ text: 'second done' }]);
  const ui = await bootApp(model, 160, 36, undefined, {}, { dirs: d, chatMode: 'panel' });
  await ui.press('F');
  await ui.type('ping it');
  await ui.press('return');
  await until(ui, () => model.requests.length === 1, 'the first request');
  expect(sentTools(model, 0)).toContain('good_ping');
  // The keyboard to the plugin's side, where the `:` line opens; the turn goes on.
  ui.backend.press({ name: ']', ctrl: true });
  await settle();
  await openPanel(ui);
  await cursorTo(ui, 'good');
  await ui.press('d');
  await until(ui, () => rowOf(ui, 'good').includes('disabled (restart to unload)'), 'the disabled row');
  expect(flat(ui.backend.lastFrame)).toContain('good disabled — its tools are out from the next step; its screens and keys go at a');
  expect(fs.existsSync(path.join(d.enabled, '.disabled', 'good'))).toBe(true);
  expect(fs.existsSync(path.join(d.enabled, 'good'))).toBe(false);
  // Its tools are out: the call the held round makes is answered, never run.
  model.release();
  await until(ui, () => model.requests.length === 2, 'the second request');
  expect(sentTools(model, 1)).not.toContain('good_ping');
  const results = (model.requests[1]!.messages as Array<{ role: string; content?: unknown }>).filter((m) => m.role === 'tool').map((m) => String(m.content));
  expect(results.join('\n')).toContain('good_ping is gone — good was disabled');
  expect(results.join('\n')).not.toContain('pong from good');
  // Enabled again: in the next request.
  await ui.press('d');
  await until(ui, () => rowOf(ui, 'good').includes('active'), 'the row active again');
  expect(fs.existsSync(path.join(d.enabled, 'good'))).toBe(true);
  await ui.press('escape');
  await ui.press('F');
  await ui.type('again');
  await ui.press('return');
  await until(ui, () => model.requests.length === 3, 'the third request');
  expect(sentTools(model, 2)).toContain('good_ping');
  ui.app.unmount();
});

test('enable of a plugin disabled at the start loads it through the late path, and its tools are in the next round', async () => {
  const d = pluginDirs();
  const extra = jsPlugin(d, 'extra', { where: 'disabled' });
  trustRecord(d, { extra });
  const model = new ScriptedModel();
  model.script([{ text: 'one' }], [{ text: 'two' }]);
  const ui = await bootApp(model, 160, 36, undefined, {}, { dirs: d, trustFile: d.trustFile });
  await openPanel(ui);
  await until(ui, () => rowOf(ui, 'extra').includes('disabled'), 'the disabled row');
  await cursorTo(ui, 'extra');
  await ui.press('d');
  await until(ui, () => rowOf(ui, 'extra').includes('active'), 'the plugin joined');
  expect(rowOf(ui, 'extra')).toContain('1 tool');
  await ui.press('escape');
  await ui.press('F');
  await ui.type('hi');
  await ui.press('return');
  await until(ui, () => model.requests.length === 1, 'a request');
  expect(sentTools(model, 0)).toContain('extra_ping');
  ui.app.unmount();
});

test('enabling a plugin not trusted leaves it unloaded and says so; y trusts it and it loads', async () => {
  const d = pluginDirs();
  jsPlugin(d, 'other', { where: 'disabled' });
  const good = jsPlugin(d, 'good');
  trustRecord(d, { good });
  const ui = await bootApp(new ScriptedModel(), 160, 36, undefined, {}, { dirs: d, trustFile: d.trustFile });
  await openPanel(ui);
  await cursorTo(ui, 'other');
  await ui.press('d');
  await until(ui, () => rowOf(ui, 'other').includes('not trusted — not loaded until you trust it (y)'), 'the untrusted row');
  expect(flat(ui.backend.lastFrame)).toContain('other enabled — not loaded until you trust it (y)');
  expect(readTrust(d).dirs[fs.realpathSync(d.enabled)]!.other).toBeUndefined();
  await ui.press('y');
  await until(ui, () => rowOf(ui, 'other').includes('active'), 'the plugin trusted and joined');
  expect(readTrust(d).dirs[fs.realpathSync(d.enabled)]!.other).toBe(fs.realpathSync(path.join(d.available, 'other')));
  ui.app.unmount();
});

test('y on a plugin whose link leads elsewhere than it did shows both places and trusts only on a second y', async () => {
  const d = pluginDirs();
  const was = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-was-'));
  jsPlugin(d, 'moved');
  trustRecord(d, { moved: was });
  const ui = await bootApp(new ScriptedModel(), 180, 36, undefined, {}, { dirs: d, trustFile: d.trustFile });
  await openPanel(ui);
  const now = fs.realpathSync(path.join(d.available, 'moved'));
  await until(ui, () => rowOf(ui, 'moved').includes('not trusted — its link led to'), 'the retargeted row');
  await cursorTo(ui, 'moved');
  await ui.press('y');
  await until(ui, () => ui.backend.lastFrame.includes('Trust moved?'), 'the confirmation');
  const f = flat(ui.backend.lastFrame);
  expect(f).toContain(`its link led to ${fs.realpathSync(was)}`);
  expect(f).toContain(`now it leads to ${now}`);
  // Nothing recorded yet.
  expect(readTrust(d).dirs[fs.realpathSync(d.enabled)]!.moved).toBe(fs.realpathSync(was));
  // Esc is no.
  await ui.press('escape');
  expect(readTrust(d).dirs[fs.realpathSync(d.enabled)]!.moved).toBe(fs.realpathSync(was));
  await ui.press('y');
  await until(ui, () => ui.backend.lastFrame.includes('Trust moved?'), 'the confirmation again');
  await ui.press('y');
  await until(ui, () => readTrust(d).dirs[fs.realpathSync(d.enabled)]!.moved === now, 'the new target recorded');
  await ui.press('escape');
  await until(ui, () => rowOf(ui, 'moved').includes('active'), 'the plugin loaded');
  ui.app.unmount();
});

test('restart of a remote plugin stops it and runs its handshake again', async () => {
  const d = pluginDirs();
  const fake = fakeRemote({ tools: [] }, { description: 'a remote one' });
  fs.mkdirSync(path.join(d.available, 'fake'));
  fs.writeFileSync(path.join(d.available, 'fake', 'manifest.json'), JSON.stringify({ ...fake.manifest, flowtty: FLOWTTY_VERSION }));
  fs.symlinkSync(path.join(d.available, 'fake'), path.join(d.enabled, 'fake'));
  let shutdowns = 0;
  fake.peer.onRequest('shutdown', () => { shutdowns++; return null; });
  jsPlugin(d, 'good');
  const ui = await bootApp(new ScriptedModel(), 160, 36, undefined, {}, { dirs: d, late: true, remote: { manifest: fake.manifest, transport: fake.transport } });
  await openPanel(ui);
  await until(ui, () => rowOf(ui, 'fake').includes('active'), 'the remote plugin active');
  expect(fake.hellos()).toBe(1);
  await cursorTo(ui, 'fake');
  await ui.press('r');
  await until(ui, () => fake.hellos() === 2, 'a second handshake');
  expect(shutdowns).toBe(1);
  await until(ui, () => rowOf(ui, 'fake').includes('active'), 'active again');
  // A JS plugin has no process of its own to restart.
  await cursorTo(ui, 'good');
  await ui.press('r');
  await until(ui, () => flat(ui.backend.lastFrame).includes('good runs inside the app — restart the app to load it again'), 'the refusal');
  ui.app.unmount();
});

test('/plugins in the chat opens the same panel in the chat\'s frame, with the same rows', async () => {
  const d = pluginDirs();
  jsPlugin(d, 'good');
  jsPlugin(d, 'broken', { body: `() => { throw new Error('needs BROKEN_TOKEN first') }` });
  const ui = await bootApp(new ScriptedModel(), 160, 36, undefined, {}, { dirs: d });
  await openPanel(ui);
  await until(ui, () => rowOf(ui, 'good').includes('v1.2.3'), 'the versions read');
  const onLine = [rowOf(ui, 'good'), rowOf(ui, 'broken')].map((r) => r.slice(r.indexOf('good') >= 0 ? r.indexOf('good') : r.indexOf('broken')));
  await ui.press('escape');
  await ui.press('F');
  await ui.type('/plugins');
  await ui.press('return');
  await until(ui, () => ui.backend.lastFrame.includes('Flow Assist · Plugins') && rowOf(ui, 'good').includes('v1.2.3'), 'the panel in the chat');
  const inChat = [rowOf(ui, 'good'), rowOf(ui, 'broken')].map((r) => r.slice(r.indexOf('good') >= 0 ? r.indexOf('good') : r.indexOf('broken')));
  for (const [a, b] of onLine.map((r, i) => [r, inChat[i]!])) expect(b.replace(/[│ ]+$/, '')).toContain(a.replace(/[│ ]+$/, '').trim());
  // The chat's panel: Esc closes it and the conversation is back.
  await ui.press('escape');
  expect(ui.backend.lastFrame).toContain('Ask anything');
  ui.app.unmount();
});

test(':plugins works without the assistant plugin: the runtime owns it', async () => {
  const config: Record<string, unknown> = { ai: { baseUrl: 'http://scripted.model', model: 'scripted' } };
  const repo = { enabledPlugins: async () => [], list: async () => [] } as never;
  const renders = { chat: renderChatModal, help: renderHelp, log: renderLogModal, reminder: renderReminder };
  const loaded = await loadPlugins({ config, repo, renders: renders as never });
  const make = makeFactory(config as never);
  const guest = make('guest', { tools: [{ id: 'guest', tools: [{ type: 'function', function: { name: 'guest_ping', description: 'Ping.', parameters: { type: 'object', properties: {} } } }], exec: async () => 'pong' }] });
  const plugins = [...loaded.filter((p) => p.name !== 'assistant'), guest];
  const tools = assembleToolRegistry({ plugins, config, repo });
  const backend = new TestBackend(120, 30);
  const app = await renderApp(backend, { plugins, config, tools, onExit: () => {} });
  await settle();
  const ui = { backend };
  for (const k of [':', 'p', 'l', 'u', 'g', 'i', 'n', 's', 'return']) { backend.press({ name: k }); await settle(); }
  await until(ui, () => backend.lastFrame.includes('Flow Assist · Plugins'), 'the panel');
  expect(rowOf(ui, 'guest')).toContain('active · 1 group · 1 tool');
  backend.press({ name: 'escape' });
  await settle();
  expect(backend.lastFrame).not.toContain('Flow Assist · Plugins');
  app.unmount();
});

// Trust is a key the person presses in the panel. The model has no tool for it, a remote
// plugin no request, and a line in the chat — typed, or queued behind a turn — opens the
// panel at most: nothing is trusted until a `y` is pressed in it.
test('nothing the model or a remote plugin can reach trusts a plugin', async () => {
  const d = pluginDirs();
  const good = jsPlugin(d, 'good');
  jsPlugin(d, 'other');
  trustRecord(d, { good });
  const fake = fakeRemote({ tools: [] });
  fs.mkdirSync(path.join(d.available, 'fake'));
  fs.writeFileSync(path.join(d.available, 'fake', 'manifest.json'), JSON.stringify({ ...fake.manifest, flowtty: FLOWTTY_VERSION }));
  fs.symlinkSync(path.join(d.available, 'fake'), path.join(d.enabled, 'fake'));
  trustRecord(d, { good, fake: path.join(d.available, 'fake') });
  const before = fs.readFileSync(d.trustFile, 'utf8');
  const model = new ScriptedModel();
  model.script([{ text: 'nothing to do' }]);
  const ui = await bootApp(model, 160, 36, undefined, {}, { dirs: d, trustFile: d.trustFile, remote: { manifest: fake.manifest, transport: fake.transport } });
  // The model's tools: the host group's five, none of them trusts, and no tool anywhere
  // is named for it.
  const names = ui.tools.tools.map((t) => t.function.name);
  expect(names.filter((n) => n.startsWith('host:')).sort()).toEqual(['host:plugins_install', 'host:plugins_list', 'host:plugins_remove', 'host:plugins_update', 'host:tools_list']);
  expect(names.some((n) => /trust/i.test(n))).toBe(false);
  // A remote plugin's requests: no method trusts, runs a command or opens a panel.
  for (const method of ['host.plugins.trust', 'host.trust', 'host.command', 'host.commands.run', 'host.openPanel']) {
    const e = await fake.peer.request(method, { name: 'other' }, 2000).then(() => null, (err: unknown) => err as { code?: number });
    expect(e?.code).toBe(-32601); // no such method — not a timeout
  }
  // A line in the chat: `/plugins y` opens the panel, and trusts nothing.
  await ui.press('F');
  await ui.type('/plugins y');
  await ui.press('return');
  await until(ui, () => ui.backend.lastFrame.includes('Flow Assist · Plugins'), 'the panel in the chat');
  await until(ui, () => rowOf(ui, 'other').includes('not trusted'), 'the untrusted row');
  expect(fs.readFileSync(d.trustFile, 'utf8')).toBe(before);
  // The person's key does.
  await cursorTo(ui, 'other');
  await ui.press('y');
  await until(ui, () => rowOf(ui, 'other').includes('active'), 'trusted and loaded');
  expect(readTrust(d).dirs[fs.realpathSync(d.enabled)]!.other).toBe(fs.realpathSync(path.join(d.available, 'other')));
  ui.app.unmount();
});

// The panel never keeps the person from the chat, and a `y` meant for the chat never
// trusts a plugin: while the chat waits for an answer, none of the panel's own keys acts,
// and the chat's key takes the keyboard back, closing the panel.
test('with the chat waiting for a y/n, y in the panel does nothing; ^] reaches the chat and y answers it', async () => {
  const d = pluginDirs();
  const good = jsPlugin(d, 'good');
  jsPlugin(d, 'other');
  trustRecord(d, { good });
  const before = fs.readFileSync(d.trustFile, 'utf8');
  let wrote = 0;
  const model = new ScriptedModel();
  model.script([{ hold: true }, { tool: 'save_it', args: {} }], [{ text: 'saved' }]);
  const ui = await bootApp(model, 160, 36, (make) => [make('writer', { tools: [{ id: 'writer', tools: [{ type: 'function', function: { name: 'save_it', description: 'Save.', parameters: { type: 'object', properties: {} } }, write: true }], exec: async () => { wrote++; return 'saved it'; } }] }) as never], {}, { dirs: d, trustFile: d.trustFile, chatMode: 'panel' });
  await ui.press('F');
  await ui.type('save it');
  await ui.press('return');
  await until(ui, () => model.requests.length === 1, 'the first request');
  ui.backend.press({ name: ']', ctrl: true });
  await settle();
  await openPanel(ui);
  await cursorTo(ui, 'other');
  model.release();
  await until(ui, () => flat(ui.backend.lastFrame).includes('save_it'), 'the y/n in the chat');
  await ui.press('y');
  await until(ui, () => flat(ui.backend.lastFrame).includes('the chat waits for your answer'), 'the notice');
  expect(fs.readFileSync(d.trustFile, 'utf8')).toBe(before);
  expect(wrote).toBe(0);
  // The chat's key: the keyboard goes to the chat and the panel closes.
  ui.backend.press({ name: ']', ctrl: true });
  await settle();
  expect(ui.backend.lastFrame).not.toContain('Flow Assist · Plugins');
  await ui.press('y');
  await until(ui, () => wrote === 1, 'the write answered');
  expect(fs.readFileSync(d.trustFile, 'utf8')).toBe(before);
  ui.app.unmount();
});
