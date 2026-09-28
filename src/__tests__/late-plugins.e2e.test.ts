// The app draws at once: a remote plugin whose handshake is still pending is named on the
// start screen as starting, and joins the running app — its entry key on the start
// screen, its keys in the footer, its tools in the next round — when the handshake
// completes. A handshake that fails is a skip in the log, as at any start.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { fakeRemote } from './helpers/remote-fake';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
type Ui = Awaited<ReturnType<typeof bootApp>>;
const until = async (ui: Ui, ok: () => boolean, what: string, n = 200) => {
  for (let i = 0; i < n && !ok(); i++) await settle(1);
  if (!ok()) throw new Error(`never: ${what}\n${ui.backend.lastFrame}`);
};
const footer = (ui: Ui) => ui.backend.lastFrame.split('\n').find((r) => r.includes(': commands')) ?? '';
// The plugin's row on the start screen: its name, then the key that leads in.
const listed = (ui: Ui) => /fake\s+S\s/.test(ui.backend.lastFrame);

const LOOKUP = { type: 'function' as const, function: { name: 'fake_lookup', description: 'Look a word up.', parameters: { type: 'object', properties: {} } } };

async function boot(model = new ScriptedModel(), chatMode: 'window' | null = null, guests?: Parameters<typeof bootApp>[3]) {
  const fake = fakeRemote({ keys: { open: 'S' }, entry: ['open'], tools: [{ id: 'fake', tools: [LOOKUP] }] }, { description: 'a word finder' });
  fake.holdHello();
  const ui = await bootApp(model, 100, 30, guests, {}, { chatMode, late: true, remote: { manifest: fake.manifest, transport: fake.transport } });
  return { fake, ui, model };
}

test('the first frame is drawn while the handshake is held; the plugin joins with its key on the start screen and in the footer, and the starting line goes', async () => {
  const { fake, ui } = await boot();
  // Drawn, on the start screen, with the plugin said to be starting and not listed yet.
  expect(ui.backend.lastFrame).toContain(': commands');
  expect(ui.backend.lastFrame).toContain('starting: fake…');
  expect(listed(ui)).toBe(false);
  expect(ui.backend.lastFrame).not.toContain('a word finder');

  fake.answerHello();
  await until(ui, () => listed(ui), 'the plugin on the start screen');
  expect(ui.backend.lastFrame).toContain('a word finder');
  expect(ui.backend.lastFrame).not.toContain('starting:');
  // Its keys are the app's now: the entry key leads in, and its frame's caps are in the
  // footer.
  fake.frame({ surface: ['Text', {}, 'the finder'], keycaps: [{ action: 'open', label: 'find' }], keys: { consume: ['open'] } });
  await until(ui, () => footer(ui).includes('S find'), 'the plugin\'s caps in the footer');
  await ui.press('S');
  await until(ui, () => fake.events.some(([m, p]) => m === 'key' && (p as { action?: string }).action === 'open'), 'the entry key reaching the plugin');
  ui.app.unmount();
});

test('a handshake that fails after the start is a skip in the log, once; the plugin is not listed and the starting line goes', async () => {
  const { fake, ui } = await boot();
  expect(ui.backend.lastFrame).toContain('starting: fake…');
  fake.refuseHello('no lessons today');
  await until(ui, () => !ui.backend.lastFrame.includes('starting:'), 'the starting line gone');
  expect(listed(ui)).toBe(false);
  await ui.press('L');
  const log = ui.backend.lastFrame;
  expect(log.match(/\[plugins\] skip fake: hello: no lessons today/g)?.length).toBe(1);
  ui.app.unmount();
});

test('a turn started before the plugin joined sends its tools from the next round, and what was typed stays', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ hold: true }, { tool: 'datetime', args: {} }],
    [{ text: 'done' }],
  );
  const { fake, ui } = await boot(model, 'window');
  await ui.press('F');
  await ui.type('look it up');
  await ui.press('return');
  await until(ui, () => model.requests.length === 1, 'the first request');
  // Typed while the answer is held: a draft the join must not take away.
  await ui.type('a draft');
  const sent = (i: number) => ((model.requests[i] as { tools?: { function: { name: string } }[] }).tools ?? []).map((t) => t.function.name);
  expect(sent(0)).not.toContain('fake_lookup');

  fake.answerHello();
  await settle(20);
  expect(ui.backend.lastFrame).toContain('a draft');
  model.release();
  await until(ui, () => model.requests.length === 2, 'the second request');
  expect(sent(1)).toContain('fake_lookup');
  await until(ui, () => ui.backend.lastFrame.includes('done'), 'the answer');
  expect(ui.backend.lastFrame).toContain('look it up');
  expect(ui.backend.lastFrame).toContain('a draft');
  ui.app.unmount();
});

// A plugin that joins takes its place in the enabled order, not the end of the list; a
// tool name an earlier plugin already holds stays with it, and the late plugin's tool
// is offered qualified, said in the log.
test('a late plugin takes its enabled place, and a tool name already held stays with its holder', async () => {
  const { chatTools, execChatTool } = await import('../loader/tools');
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (m: unknown) => { warned.push(String(m)); };
  try {
    const lookup = (answer: string) => ({ id: 'notes', tools: [LOOKUP], exec: async () => answer });
    const { fake, ui } = await boot(new ScriptedModel(), null, (make) => [make('notes', { tools: [lookup('from notes')], description: 'the notes' }) as never]);
    fake.answerHello();
    await until(ui, () => listed(ui), 'the plugin on the start screen');
    // `fake` is enabled, `notes` comes after: fake is listed first although it came last.
    const frame = ui.backend.lastFrame;
    expect(frame.indexOf('a word finder')).toBeLessThan(frame.indexOf('the notes'));
    const names = chatTools().map((t) => t.function.name);
    expect(names).toContain('fake_lookup');
    expect(names).toContain('fake:fake_lookup');
    expect(String(await execChatTool('fake_lookup', {}, {}))).toBe('from notes');
    expect(warned.join('\n')).toContain('"fake_lookup" is declared by both notes and fake — notes keeps the name, fake\'s is offered as "fake:fake_lookup"');
    ui.app.unmount();
  } finally {
    console.warn = realWarn;
  }
});
