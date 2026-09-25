// A plugin in another language, driven through the real App over an in-memory
// transport: the loader builds it from its manifest, and the person meets it as any
// other guest.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { fakeRemote } from './helpers/remote-fake';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
type Ui = Awaited<ReturnType<typeof bootApp>>;
// Waits for what a test is about, and FAILS when it never comes — a wait that returned
// quietly would let every assertion after it pass on a screen it never looked at.
const until = async (ui: Ui, ok: () => boolean, what: string, n = 200) => {
  for (let i = 0; i < n && !ok(); i++) await settle(1);
  if (!ok()) throw new Error(`never: ${what}\n${ui.backend.lastFrame}`);
};
// The plugin side's footer — the row of hints; a docked chat's strip may sit under it.
const footer = (ui: Ui) => ui.backend.lastFrame.split('\n').find((r) => r.includes(': commands')) ?? '';

// `opts.extra` is merged into the config, as `bootApp`'s own `extra` is.
async function boot(hello: Parameters<typeof fakeRemote>[0] = {}, manifest: Parameters<typeof fakeRemote>[1] = {}, opts: { chatMode?: 'panel' | 'window' | 'full' | null; extra?: Record<string, unknown> } = {}) {
  const fake = fakeRemote({ keys: { open: 'S' }, entry: ['open'], ...hello }, manifest);
  const { extra = {}, ...rest } = opts;
  const ui = await bootApp(new ScriptedModel(), 100, 30, undefined, extra, { chatMode: null, ...rest, remote: { manifest: fake.manifest, transport: fake.transport } });
  return { fake, ui };
}

test('the plugin is on the start screen, and its first frame is drawn once it is active', async () => {
  const { fake, ui } = await boot({}, { description: 'a sign-in form' });
  expect(ui.backend.lastFrame).toContain('fake');
  expect(ui.backend.lastFrame).toContain('a sign-in form');
  fake.frame({ surface: ['Box', { flexDirection: 'column' }, ['Text', { bold: true }, 'Sign in'], ['TextInput', { id: 'name', isFocused: true }]], keycaps: [{ action: 'open', label: 'form' }], keys: { consume: ['tab', 'enter'] } });
  await until(ui, () => ui.backend.lastFrame.includes('Sign in'), 'the surface');
  expect(footer(ui)).toContain('S form'); // the keycap's action drawn as its bound key
  ui.app.unmount();
});

test('typing into the field costs no round trip and reports changed; ⏎ reports submitted; the echo does not clobber, goodbye does', async () => {
  const { fake, ui } = await boot();
  fake.frame({ surface: ['Box', { flexDirection: 'column' }, ['Text', {}, 'Name:'], ['TextInput', { id: 'name', isFocused: true }]], keycaps: ['x'] });
  await until(ui, () => ui.backend.lastFrame.includes('Name:'), 'the form');
  await ui.type('ann');
  expect(fake.events.filter(([m]) => m === 'changed').map(([, p]) => p)).toEqual([{ id: 'name', value: 'a' }, { id: 'name', value: 'an' }, { id: 'name', value: 'ann' }]);
  expect(ui.backend.lastFrame).toContain('ann');
  fake.frame({ surface: ['Box', { flexDirection: 'column' }, ['Text', {}, 'Name:'], ['TextInput', { id: 'name', isFocused: true, value: 'a' }]], keycaps: ['x'] }); // a lagging echo
  await settle(5);
  expect(ui.backend.lastFrame).toContain('ann');
  fake.frame({ surface: ['Box', { flexDirection: 'column' }, ['Text', {}, 'Name:'], ['TextInput', { id: 'name', isFocused: true, value: 'goodbye' }]], keycaps: ['x'] });
  await until(ui, () => ui.backend.lastFrame.includes('goodbye'), 'the plugin\'s own value');
  await ui.press('return');
  expect(fake.events.at(-1)).toEqual(['submitted', { id: 'name', value: 'goodbye' }]);
  ui.app.unmount();
});

test('a key in consume is taken and sent with its action; one not in consume goes on to the host', async () => {
  const { fake, ui } = await boot();
  fake.frame({ surface: ['Text', {}, 'form'], keycaps: ['x'], keys: { consume: ['tab', 'S'] } });
  await until(ui, () => ui.backend.lastFrame.includes('form'), 'the surface');
  await ui.press('tab');
  await ui.press('S');
  expect(fake.events.filter(([m]) => m === 'key').map(([, p]) => p)).toEqual([{ name: 'tab', id: 'tab' }, { name: 'S', id: 'S', action: 'open' }]);
  await ui.press('L'); // not consumed: the host's log opens
  expect(ui.backend.lastFrame).toContain('╭─ Log');
  ui.app.unmount();
});

test('an action in consume follows the person\'s remap: the remapped key reaches the plugin with its action, the default does not, and the caps show it', async () => {
  const { fake, ui } = await boot({}, {}, { extra: { keys: { open: 'O' } } });
  fake.frame({ surface: null, keycaps: [], keys: { consume: ['open'] } });
  await settle(5);
  expect(ui.backend.lastFrame).toMatch(/fake\s+O\s/); // the start screen leads in with the remapped key
  await ui.press('S');
  expect(fake.events.filter(([m]) => m === 'key')).toEqual([]);
  await ui.press('O');
  await until(ui, () => fake.events.some(([m]) => m === 'key'), 'the key');
  expect(fake.events.filter(([m]) => m === 'key').map(([, p]) => p)).toEqual([{ name: 'O', id: 'O', action: 'open' }]);
  fake.frame({ surface: ['Text', {}, 'form'], keycaps: [{ action: 'open', label: 'form' }], keys: { consume: ['open', 'tab'] } });
  await until(ui, () => ui.backend.lastFrame.includes('form'), 'the surface');
  expect(footer(ui)).toContain('O form');
  expect(footer(ui)).not.toContain('S form');
  ui.app.unmount();
});

test('resize and focus reach the plugin', async () => {
  const { fake, ui } = await boot();
  fake.frame({ surface: ['Text', {}, 'form'], keycaps: ['x'] });
  await until(ui, () => fake.events.some(([m]) => m === 'resize'), 'a resize');
  // The plugin's SIDE is its terminal: the docked chat's collapsed strip keeps a row.
  expect(fake.events.find(([m]) => m === 'resize')![1]).toMatchObject({ terminal: { width: 100, height: 29 }, surface: { width: 100 } });
  expect(fake.events.filter(([m]) => m === 'focus' || m === 'blur').map(([m]) => m)).toEqual(['focus']);
  await ui.press('F'); // the chat takes the keyboard
  await until(ui, () => fake.events.some(([m]) => m === 'blur'), 'a blur');
  await ui.press('escape', 'escape');
  await until(ui, () => fake.events.filter(([m]) => m === 'focus').length >= 2, 'focus again');
  expect(fake.events.filter(([m]) => m === 'focus' || m === 'blur').map(([m]) => m)).toEqual(['focus', 'blur', 'focus']);
  ui.app.unmount();
});

test('the frame\'s context reaches the model, and a tool call reaches the plugin', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'check', args: { code: 'x' } }], [{ text: 'ok' }]);
  const fake = fakeRemote({ tools: [{ id: 'tutor', tools: [{ type: 'function', function: { name: 'check', description: 'Check', parameters: { type: 'object', properties: { code: { type: 'string' } } } } }] }] });
  const runs: unknown[] = [];
  fake.peer.onRequest('tool.run', (p) => { runs.push(p); return { result: `checked ${(p as { args: { code: string } }).args.code}` }; });
  const ui = await bootApp(model, 100, 30, undefined, {}, { remote: { manifest: fake.manifest, transport: fake.transport } });
  fake.frame({ surface: ['Text', {}, 'lesson 3'], keycaps: ['x'], context: [{ label: 'Lesson 3', text: 'exercise: not run' }] });
  await until(ui, () => ui.backend.lastFrame.includes('lesson 3'), 'the surface');
  await ui.press('F');
  await ui.type('check it');
  await ui.press('return');
  await until(ui, () => model.requests.length === 2 && ui.backend.lastFrame.includes('ok'), 'the second round');
  expect(JSON.stringify(model.requests[0]!.messages)).toContain('exercise: not run');
  expect(runs).toEqual([{ name: 'check', args: { code: 'x' }, call: { id: 'fake-1' } }]);
  expect(JSON.stringify(model.requests[1]!.messages)).toContain('checked x');
  ui.app.unmount();
});

test('host.showMessage shows a toast', async () => {
  const { fake, ui } = await boot();
  fake.frame({ surface: ['Text', {}, 'form'], keycaps: ['x'] });
  await until(ui, () => ui.backend.lastFrame.includes('form'), 'the surface');
  await fake.peer.request('host.showMessage', { text: 'Signed in' });
  await until(ui, () => footer(ui).includes('Signed in') || ui.backend.lastFrame.includes('Signed in'), 'the toast');
  ui.app.unmount();
});

test('a modal is drawn over a mounted surface, laid over the plugin\'s side from its top-left corner', async () => {
  const { fake, ui } = await boot();
  const lines = Array.from({ length: 20 }, (_, i) => ['Text', {}, `line ${i} ${'-'.repeat(40)}`]);
  fake.frame({ surface: ['Box', { flexDirection: 'column' }, ...lines] as never, modals: { confirm: ['Box', { border: 'round', paddingX: 1 }, ['Text', {}, 'Really?']] }, keycaps: ['x'] });
  await until(ui, () => ui.backend.lastFrame.includes('Really?'), 'the modal');
  const rows = ui.backend.lastFrame.split('\n');
  expect(rows.some((r) => r.startsWith('line 0 '))).toBe(true); // the surface is still there, behind
  // The side is 100×29 — the docked chat's collapsed strip is the terminal's last row.
  // The overlay's backdrop covers the side from (0,0) to its far corner and not the
  // strip below it, and the modal is centred in the side on both axes.
  const buf = ui.backend.lastBuffer!;
  expect(buf.get(0, 0).style.dim).toBe(true);
  expect(buf.get(99, 28).style.dim).toBe(true);
  expect(buf.get(1, 29).style.dim).toBeFalsy();
  const y = rows.findIndex((r) => r.includes('Really?'));
  const x = rows[y]!.indexOf('Really?');
  expect(Math.abs(y - 14)).toBeLessThanOrEqual(1);
  expect(Math.abs(x + 'Really?'.length / 2 - 50)).toBeLessThanOrEqual(1);
  expect(rows[y - 1]!.slice(x - 2, x + 'Really?'.length + 2)).toMatch(/^╭─+╮$/);
  ui.app.unmount();
});

test('consume "*" takes every key the host would have had, the log\'s own included', async () => {
  const { fake, ui } = await boot();
  fake.frame({ surface: ['Text', {}, 'form'], modals: { confirm: ['Box', { border: 'round' }, ['Text', {}, 'Really?']] }, keycaps: ['x'], keys: { consume: '*' } });
  await until(ui, () => ui.backend.lastFrame.includes('Really?'), 'the modal');
  await ui.press('L');
  expect(ui.backend.lastFrame).not.toContain('╭─ Log');
  expect(fake.events.filter(([m]) => m === 'key').map(([, p]) => p)).toEqual([{ name: 'L', id: 'L' }]);
  ui.app.unmount();
});

test('consume "*" with a remote field focused: what is typed goes to the field, not to the plugin as keys', async () => {
  const { fake, ui } = await boot();
  fake.frame({ surface: ['Box', { flexDirection: 'column' }, ['Text', {}, 'Name:'], ['TextInput', { id: 'name', isFocused: true }]], keycaps: ['x'], keys: { consume: '*' } });
  await until(ui, () => ui.backend.lastFrame.includes('Name:'), 'the form');
  await ui.type('ab');
  // The observed behaviour: flowtty's focused TextInput takes a printable key in its own
  // pass, before the host's key path where the plugin's handler waits — so `*` never
  // sees it, the field gets the characters and reports `changed`, and no `key` goes out.
  expect(fake.events.filter(([m]) => m === 'changed').map(([, p]) => p)).toEqual([{ id: 'name', value: 'a' }, { id: 'name', value: 'ab' }]);
  expect(fake.events.filter(([m]) => m === 'key')).toEqual([]);
  expect(ui.backend.lastFrame).toContain('ab');
  // A key the field does not act on still reaches the handler under `*`.
  await ui.press('tab');
  expect(fake.events.filter(([m]) => m === 'key').map(([, p]) => p)).toEqual([{ name: 'tab', id: 'tab' }]);
  ui.app.unmount();
});

test('a view a tool reports is drawn behind a placeholder until view.render answers', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'check', args: {} }], [{ text: 'done' }]);
  const fake = fakeRemote({ tools: [{ id: 'tutor', tools: [{ type: 'function', function: { name: 'check', description: 'Check', parameters: { type: 'object', properties: {} } } }] }] }, { views: ['exercise'] });
  fake.peer.onRequest('tool.run', () => ({ result: 'checked', views: [{ kind: 'exercise', data: { n: 3 } }] }));
  let answer: (v: unknown) => void = () => {};
  const asked: unknown[] = [];
  fake.peer.onRequest('view.render', (p) => { asked.push(p); return new Promise((r) => { answer = r; }); });
  const ui = await bootApp(model, 100, 30, undefined, {}, { remote: { manifest: fake.manifest, transport: fake.transport } });
  await ui.press('F');
  await ui.type('check it');
  await ui.press('return');
  await until(ui, () => ui.backend.lastFrame.includes('▸ exercise'), 'the placeholder');
  expect(asked[0]).toMatchObject({ kind: 'exercise', data: { n: 3 } });
  answer({ lines: [[{ text: 'exercise 3: ' }, { text: 'passed', bold: true }]] });
  // The answer replaces the placeholder on its own: the adapter bumps the view revision,
  // so the chat's cached rows for the finished message miss.
  await until(ui, () => ui.backend.lastFrame.includes('exercise 3: passed'), 'the rendered view');
  expect(ui.backend.lastFrame).not.toContain('▸ exercise');
  ui.app.unmount();
});

test('an unknown node type is one dim line; an oversize frame is dropped and the previous stays', async () => {
  const { fake, ui } = await boot();
  fake.frame({ surface: ['Box', { flexDirection: 'column' }, ['Gauge', { v: 1 }], ['Text', {}, 'kept']], keycaps: ['x'] });
  await until(ui, () => ui.backend.lastFrame.includes('▸ Gauge'), 'the unknown node\'s line');
  expect(ui.backend.lastFrame).toContain('kept');
  fake.frame({ surface: ['Text', {}, 'x'.repeat(4 * 1024 * 1024 + 1)], keycaps: ['x'] });
  await settle(20);
  expect(ui.backend.lastFrame).toContain('kept');
  expect(ui.backend.lastFrame).toContain('▸ Gauge');
  ui.app.unmount();
});

test('a crash says plugin stopped and a restart says hello again', async () => {
  const { fake, ui } = await boot();
  fake.frame({ surface: ['Text', {}, 'alive'], keycaps: ['x'] });
  await until(ui, () => ui.backend.lastFrame.includes('alive'), 'the surface');
  fake.crash();
  await until(ui, () => ui.backend.lastFrame.includes('plugin stopped'), 'plugin stopped');
  // Said on the surface, which stays up (its one keycap is the stop), and in the footer.
  const said = ui.backend.lastFrame.split('\n').filter((r) => r.includes('plugin stopped (exit 1)'));
  expect(said.length).toBe(2);
  expect(footer(ui)).toContain('plugin stopped (exit 1)');
  let hellos = 0;
  fake.peer.onRequest('hello', () => { hellos++; return fake.hello; });
  fake.restart();
  await until(ui, () => hellos === 1, 'a second hello');
  fake.frame({ surface: ['Text', {}, 'back'], keycaps: ['x'] });
  await until(ui, () => ui.backend.lastFrame.includes('back'), 'the new process\'s frame');
  expect(ui.backend.lastFrame).not.toContain('plugin stopped');
  ui.app.unmount();
});

test('a process that crashes again before its first frame still leaves plugin stopped on screen', async () => {
  const { fake, ui } = await boot();
  fake.frame({ surface: ['Text', {}, 'alive'], keycaps: ['x'] });
  await until(ui, () => ui.backend.lastFrame.includes('alive'), 'the surface');
  fake.crash();
  await until(ui, () => ui.backend.lastFrame.includes('plugin stopped'), 'plugin stopped');
  let hellos = 0;
  fake.peer.onRequest('hello', () => { hellos++; return fake.hello; });
  fake.restart();
  await until(ui, () => hellos === 1, 'a second hello');
  await settle(5);
  fake.crash(); // before the new process sent any frame
  await settle(10);
  const said = ui.backend.lastFrame.split('\n').filter((r) => r.includes('plugin stopped (exit 1)'));
  expect(said.length).toBe(2); // on the surface and in the footer, as after the first crash
  ui.app.unmount();
});

test('an incompatible hostApi is refused from the manifest before any process starts', async () => {
  const fake = fakeRemote({}, { hostApi: 1 });
  let started = false;
  fake.transport.start = async () => { started = true; };
  const ui = await bootApp(new ScriptedModel(), 100, 30, undefined, {}, { remote: { manifest: fake.manifest, transport: fake.transport } });
  expect(started).toBe(false);
  expect(ui.backend.lastFrame).not.toContain('fake');
  ui.app.unmount();
});

test('visible: the plugin\'s side is hidden while the full chat is open over it, and not by a window', async () => {
  const { fake, ui } = await boot({}, {}, { chatMode: 'full' });
  fake.frame({ surface: ['Text', {}, 'form'], keycaps: ['x'] });
  await until(ui, () => ui.backend.lastFrame.includes('form'), 'the surface');
  const visible = () => fake.events.filter(([m]) => m === 'visible').map(([, p]) => p);
  expect(visible()).toEqual([]); // on screen from the start: nothing to say
  await ui.press('F');
  await until(ui, () => visible().length === 1, 'hidden');
  expect(visible()).toEqual([{ surface: false }]);
  await ui.press('escape', 'escape');
  await until(ui, () => visible().length === 2, 'shown again');
  expect(visible()).toEqual([{ surface: false }, { surface: true }]);
  ui.app.unmount();

  const w = await boot({}, {}, { chatMode: 'window' });
  w.fake.frame({ surface: ['Text', {}, 'form'], keycaps: ['x'] });
  await until(w.ui, () => w.ui.backend.lastFrame.includes('form'), 'the surface');
  await w.ui.press('F');
  await until(w.ui, () => w.fake.events.some(([m]) => m === 'blur'), 'the window took the keyboard');
  expect(w.fake.events.filter(([m]) => m === 'visible')).toEqual([]);
  w.ui.app.unmount();
});

test('cache.flushed: a flush reaches the plugin, and nothing is said before one', async () => {
  const { fake, ui } = await boot({ usesCache: true });
  fake.frame({ surface: ['Text', {}, 'board'], keycaps: ['x'] });
  await until(ui, () => ui.backend.lastFrame.includes('board'), 'the surface');
  expect(fake.events.filter(([m]) => m === 'cache.flushed')).toEqual([]);
  await ui.press('x');
  await until(ui, () => fake.events.some(([m]) => m === 'cache.flushed'), 'cache.flushed');
  expect(ui.backend.lastFrame).toMatch(/Cache cleared/);
  expect(fake.events.filter(([m]) => m === 'cache.flushed')).toHaveLength(1);
  ui.app.unmount();
});

// An author's typo in a frame must not take the App down: each root (the surface, each
// modal) is drawn behind a boundary that shows the failure in its place, and the next
// good frame draws again.
// `children` and `ref` are reserved and dropped, so those two draw what is left.
for (const [what, bad, drawn] of [
  ['a ListSelect without items', ['ListSelect', {}], '▸ frame failed: '],
  ['a Table whose data is a number', ['Table', { data: 5 }], '▸ frame failed: '],
  ['children given as a prop', ['Text', { children: { x: 1 } }, 'own child'], 'own child'],
  ['a string ref', ['Box', { ref: 'x' }, ['Text', {}, 'boxed']], 'boxed'],
] as const) {
  test(`a frame that cannot be drawn — ${what} — fails in its place; the chat still opens and the next frame draws`, async () => {
    const { fake, ui } = await boot();
    fake.frame({ surface: ['Box', { flexDirection: 'column' }, ['Text', {}, 'before'], bad as never], keycaps: ['x'] });
    await until(ui, () => ui.backend.lastFrame.includes(drawn), `${drawn} on screen`);
    if (drawn.startsWith('▸')) expect(ui.backend.lastFrame).not.toContain('before'); // the root failed whole, in its place
    await ui.press('F');
    await until(ui, () => ui.backend.lastFrame.includes('╭'), 'the chat');
    await ui.press('escape', 'escape');
    fake.frame({ surface: ['Text', {}, 'good again'], keycaps: ['x'] });
    await until(ui, () => ui.backend.lastFrame.includes('good again'), 'the next good frame');
    expect(ui.backend.lastFrame).not.toContain('frame failed');
    ui.app.unmount();
  });
}

test('a modal that cannot be drawn fails in its own place; the surface and the plugin\'s keys stay', async () => {
  const { fake, ui } = await boot();
  fake.frame({ surface: ['Text', {}, 'underneath'], modals: { pick: ['ListSelect', { items: null }] }, keycaps: ['x'], keys: { consume: ['tab'] } });
  await until(ui, () => ui.backend.lastFrame.includes('frame failed'), 'the failure in the modal\'s place');
  expect(ui.backend.lastFrame).toContain('underneath');
  await ui.press('tab');
  expect(fake.events.filter(([m]) => m === 'key').map(([, p]) => p)).toEqual([{ name: 'tab', id: 'tab' }]);
  await ui.press('L'); // said once in the host's log
  await until(ui, () => ui.backend.lastFrame.includes('╭─ Log'), 'the log');
  expect(ui.backend.lastFrame).toContain('[fake] frame failed: null is not an object');
  await ui.press('escape');
  fake.frame({ surface: ['Text', {}, 'underneath'], modals: { pick: ['Text', {}, 'picked'] }, keycaps: ['x'] });
  await until(ui, () => ui.backend.lastFrame.includes('picked'), 'the next good modal');
  expect(ui.backend.lastFrame).not.toContain('frame failed');
  ui.app.unmount();
});

test('a field and a ScrollBox with a held value redraw on their own change: keys typed together all land, and PgDn moves the view', async () => {
  const { fake, ui } = await boot();
  const lines = Array.from({ length: 40 }, (_, i) => ['Text', {}, `row ${i}`]);
  // Both carry a value from the frame, so both are controlled by what the host holds.
  fake.frame({ surface: ['Box', { flexDirection: 'column' }, ['TextInput', { id: 'q', value: '', isFocused: true }], ['ScrollBox', { id: 'sb', offset: 0, height: 5, isActive: true }, ['Box', { flexDirection: 'column' }, ...lines]]] as never, keycaps: ['x'] });
  await until(ui, () => ui.backend.lastFrame.includes('row 0'), 'the form');
  await ui.type('abc'); // three keys in one go, as a paste or key repeat delivers them
  expect(fake.events.filter(([m]) => m === 'changed').map(([, p]) => p)).toEqual([{ id: 'q', value: 'a' }, { id: 'q', value: 'ab' }, { id: 'q', value: 'abc' }]);
  expect(ui.backend.lastFrame).toContain('abc');
  await ui.press('pagedown');
  await until(ui, () => !ui.backend.lastFrame.includes('row 0'), 'the view moved');
  ui.app.unmount();
});

test('an open modal\'s focused field has the keyboard, not the focused field on the surface under it', async () => {
  const { fake, ui } = await boot();
  fake.frame({ surface: ['Box', { flexDirection: 'column' }, ['Text', {}, 'under'], ['TextInput', { id: 'a', isFocused: true }]], modals: { ask: ['Box', { border: 'round' }, ['TextInput', { id: 'b', isFocused: true }]] }, keycaps: ['x'] });
  await until(ui, () => ui.backend.lastFrame.includes('under') && ui.backend.lastFrame.includes('╭'), 'the surface and the modal');
  await ui.type('xy');
  expect(fake.events.filter(([m]) => m === 'changed').map(([, p]) => p)).toEqual([{ id: 'b', value: 'x' }, { id: 'b', value: 'xy' }]);
  // The modal closed: the surface's field has the keyboard again.
  fake.frame({ surface: ['Box', { flexDirection: 'column' }, ['Text', {}, 'under'], ['TextInput', { id: 'a', isFocused: true }]], keycaps: ['x'] });
  await until(ui, () => !ui.backend.lastFrame.includes('╭'), 'the modal gone');
  await ui.type('z');
  expect(fake.events.filter(([m]) => m === 'changed').map(([, p]) => p).at(-1)).toEqual({ id: 'a', value: 'z' });
  ui.app.unmount();
});
