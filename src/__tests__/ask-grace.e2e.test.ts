// The typing grace (ask-children-spec.md (subagent y/n)): a question that parks while the person
// is still typing waits out the sentence — the field keeps the keys and says so — and
// takes the keyboard once the typing stops. The rule is the last KEY, not the field's
// content: the question takes the keyboard only once the last key the chat took is older
// than the grace, and every key the chat takes while editing counts — Tab, ↑/↓ recall and
// token-Backspace included — whatever the field holds after it. Timing is split: `askClock`
// is faked and moved by hand, and the one-shot timer is a real `setTimeout`, so a test that
// crosses the grace polls in `settle`'s 4 ms steps (up to ~2.4 s) for the real 600 ms timer
// to fire.
import { afterEach, expect, test } from 'bun:test';
import { ASK_GRACE_MS, askClock } from '../assistant/child-ask-guard.ts';
import { ScriptedModel, bootApp, settle, type Turn } from './helpers/scripted';

const realFetch = globalThis.fetch;
const realNow = askClock.now;
const clock = { t: 10_000 };
afterEach(() => { globalThis.fetch = realFetch; askClock.now = realNow; });

const settleUntil = async (ok: () => boolean, n = 600) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
const rowsOf = (ui: UI) => frameOf(ui).split('\n');

// The block's title while it is drawn in the field's place, and the strip that stands
// there while the grace holds it back.
const BLOCK = 'Strategy — Rebase or merge?';
const HELD = '? a question is waiting';

const askTurn = (): Turn => [{
  tool: 'ask_user',
  args: { questions: [{ question: 'Rebase or merge?', header: 'Strategy', options: [{ label: 'rebase' }, { label: 'merge' }] }] },
}];

// A guest with a screen, so the chat can dock beside it — and the one way to ask the
// chat whether a question is parked yet.
let guestApi: { host: { store: { chat?: { asking: () => boolean } } } } | null = null;
const parked = () => !!guestApi?.host.store.chat?.asking();
const boards = (make: any) => [make('boards', {
  name: 'boards',
  keycaps: () => ['c card'],
  setup: (api: unknown) => { guestApi = api as typeof guestApi; },
  components: { view: (api: any) => function View() { return api.ui.h(api.ui.Text, null, 'BOARD-SURFACE'); } },
})];
const CHAT_KEY = { name: ']', ctrl: true };
const COLLAPSE_KEY = { name: '\\', ctrl: true };

// A chat whose first turn is held before it asks: a test types into the field and lets
// the question park while the person is still in the sentence.
async function booted(mode: 'window' | 'panel' = 'window') {
  clock.t = 10_000;
  askClock.now = () => clock.t;
  guestApi = null;
  const model = new ScriptedModel();
  model.script([{ hold: true }, ...askTurn()], [{ text: 'Done.' }]);
  const ui = await bootApp(model, mode === 'panel' ? 160 : 120, mode === 'panel' ? 40 : 32, boards as never, {}, { toastMs: 120, chatMode: mode });
  await ui.press('F');
  await ui.type('go');
  await ui.press('return');
  await settleUntil(() => model.held);
  return { model, ui };
}

test('a question waits while the person types', async () => {
  const { model, ui } = await booted();
  // The person is in the middle of a sentence when the question parks.
  await ui.type('half');
  model.release();
  await settleUntil(() => parked() && frameOf(ui).includes(HELD));

  // The field keeps the draft, the strip says what waits, and the block is not in the
  // field's place.
  expect(rowsOf(ui).some((r) => r.includes('› half'))).toBe(true);
  expect(frameOf(ui)).not.toContain(BLOCK);
  expect(frameOf(ui)).not.toContain('1. rebase');

  // A key typed now is the field's — and pushes the claim back with it.
  await ui.type('way');
  expect(frameOf(ui)).toContain('› halfway');
  expect(frameOf(ui)).not.toContain(BLOCK);
  expect(frameOf(ui)).toContain(HELD);

  // The person goes quiet: past the grace the question takes the keys.
  clock.t += ASK_GRACE_MS + 50;
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  expect(frameOf(ui)).toContain(BLOCK);
  expect(frameOf(ui)).not.toContain(HELD);
  // And it has them: a digit answers the option it names.
  await ui.press('2');
  await settleUntil(() => (model.requests.at(-1)?.messages ?? []).some((m) => m.role === 'tool' && String(m.content).includes('→ merge')));
  ui.app.unmount();
});

test('an open command line holds the keys over a waiting question', async () => {
  const { model, ui } = await booted('panel');
  // The plugin's side has the keys, so the `:` line can be opened beside the chat.
  ui.backend.press(CHAT_KEY);
  await settle();
  await ui.press(':');
  await ui.type('config');
  await settle(2);
  expect(rowsOf(ui).some((r) => r.includes(': config'))).toBe(true);

  // A half-written command is a long thought: the question waits behind it, and no
  // length of quiet draws it over the field.
  model.release();
  await settleUntil(() => parked());
  clock.t += ASK_GRACE_MS * 10;
  await settle(10);
  expect(frameOf(ui)).not.toContain(BLOCK);
  expect(rowsOf(ui).some((r) => r.includes(': config'))).toBe(true);

  // Running the line closes it; the question follows, its text gone as it always is.
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  expect(frameOf(ui)).toContain(BLOCK);
  expect(rowsOf(ui).some((r) => r.includes(': config'))).toBe(false);
  ui.app.unmount();
});

test('a question parks at once when nobody is typing', async () => {
  const { model, ui } = await booted();
  // No key for a while and no draft: the grace never delays an idle person's question.
  clock.t += 5000;
  model.release();
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  expect(frameOf(ui)).toContain(BLOCK);
  expect(frameOf(ui)).not.toContain(HELD);
  ui.app.unmount();
});

test('a key the field takes without the editor still holds the question off', async () => {
  const { model, ui } = await booted();
  await ui.type('half');
  model.release();
  await settleUntil(() => parked() && frameOf(ui).includes(HELD));
  expect(frameOf(ui)).toContain(HELD);

  // Completion is typing even though the editor reducer never sees the key: the Tab
  // re-arms the grace, so 700 ms after the last CHARACTER — and only 200 ms after the
  // key — the question is still held.
  clock.t += ASK_GRACE_MS - 100;
  await ui.press('tab');
  expect(rowsOf(ui).some((r) => r.includes('› half'))).toBe(true);
  clock.t += 200;
  // A render with no keystroke of its own: the chat folds away and comes back.
  ui.backend.press(COLLAPSE_KEY);
  await settle();
  ui.backend.press(COLLAPSE_KEY);
  await settle();

  expect(frameOf(ui)).toContain(HELD);
  expect(frameOf(ui)).not.toContain(BLOCK);
  expect(rowsOf(ui).some((r) => r.includes('› half'))).toBe(true);
  ui.app.unmount();
});

test('a message sent during the grace queues and survives the takeover', async () => {
  const { model, ui } = await booted();
  await ui.type('half');
  model.release();
  await settleUntil(() => parked() && frameOf(ui).includes(HELD));
  expect(frameOf(ui)).toContain(HELD);

  // Sending is ordinary: the turn runs, so the drafted message queues — and the sentence
  // went with it, so the question takes the field at once.
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('queued'));
  expect(frameOf(ui)).toContain('half');
  expect(frameOf(ui)).toContain(BLOCK);
  expect(frameOf(ui)).not.toContain(HELD);

  // The queued message is not lost behind the block: it reaches the model at the turn's
  // next request once the question is answered.
  await ui.press('2');
  await settleUntil(() => (model.requests.at(-1)?.messages ?? []).some((m) => String(m.content).includes('half')));
  expect((model.requests.at(-1)?.messages ?? []).some((m) => String(m.content).includes('half'))).toBe(true);
  ui.app.unmount();
});

test('a collapsed chat names the question that waits', async () => {
  const { model, ui } = await booted('panel');
  await ui.type('half');
  model.release();
  await settleUntil(() => parked() && frameOf(ui).includes(HELD));
  expect(frameOf(ui)).toContain(HELD);

  // Folded away, the strip is gone with the field: the status row the App draws says the
  // same words.
  ui.backend.press(COLLAPSE_KEY);
  await settle();
  expect(frameOf(ui)).toContain('? a question is waiting');
  expect(frameOf(ui)).not.toContain('? waiting for you');
  expect(frameOf(ui)).not.toContain(BLOCK);
  ui.app.unmount();
});
