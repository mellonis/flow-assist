// Watching a child (AGENTS.md (watching a child)): ⏎ on a subagent's row shows its conversation
// where the list is, the session's own values stay the session's, and Esc steps back. The
// real app on the scripted model; a child is held with `{ hold: true }` until the test lets
// it go.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askClock } from '../assistant/child-ask-guard.ts';
import { acceptedConfigPath, guardConfigFiles, hostStateDir, loadConfig, resetSessionConfig, unguardConfigFiles } from '../config/load.ts';
import { ScriptedModel, bootApp, firstUser, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
const realNow = askClock.now;
const clock = { t: 10_000 };
afterEach(() => { globalThis.fetch = realFetch; askClock.now = realNow; });

const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
const rowsOf = (ui: UI) => frameOf(ui).split('\n');
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const KEYS = '↑↓ move · x stop · Esc back';
const inRows = (ui: UI) => frameOf(ui).includes(KEYS);
// The breadcrumb is in the frame's title only while a child is watched.
const watching = (ui: UI) => frameOf(ui).includes('╭─ ƒ Flow Assist · ');
const PAGE_UP = { name: 'pageup' };

// A guest that keeps the runtime's host, to read what the chat publishes to plugins.
const host: { current: any } = { current: null };
const boards = (make: any) => [make('boards', {
  name: 'boards',
  keycaps: () => ['c card'],
  components: {
    keys: (api: any) => function Keys() { host.current = api.host; return null; },
    view: (api: any) => function View() { return api.ui.h(api.ui.Text, null, 'BOARD-SURFACE'); },
  },
})];

const STEP = (mark: string) => [[{ hold: true }, { text: `${mark} step`, tool: 'datetime', args: {} }], [{ hold: true }, { text: `${mark} settled` }]];

async function boot(marks: { mark: string; script?: any[][] }[], opts: { cols?: number; rows?: number; mode?: 'window' | 'panel'; main?: any[][]; root?: string } = {}) {
  clock.t = 10_000;
  askClock.now = () => clock.t;
  const root = opts.root ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-watch-')));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-watch-s-'));
  const model = new ScriptedModel();
  const children = marks.map(({ mark, script }) => {
    const child = model.when((req) => firstUser(req).includes(mark));
    child.script(...(script ?? STEP(mark)) as never);
    return child;
  });
  if (opts.main) model.script(...opts.main as never);
  const ui = await bootApp(model, opts.cols ?? 140, opts.rows ?? 34, boards as never, { sessions: { dir: sessions }, shell: { roots: [root] }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false } }, { toastMs: 10_000, ...(opts.mode ? { chatMode: opts.mode } : {}) });
  await ui.press('F');
  return { children, ui, model, root, sessions };
}

// One held child named after `mark`, with the cursor on its row.
async function oneHeld(mark = 'WATA', opts: Parameters<typeof boot>[1] = {}, script?: any[][]) {
  const b = await boot([{ mark, script }], opts);
  await ask(b.ui, `/subagent ${mark} do it`);
  await settleUntil(() => b.children[0]!.held);
  await settleUntil(() => frameOf(b.ui).includes(`⚙ ${mark.toLowerCase()}-do`));
  return b;
}
// One held background task the model starts (a task ends after its answer; a subagent the
// person starts stays), named after `mark`, with the cursor on its row.
async function oneHeldTask(mark: string, opts: Parameters<typeof boot>[1] = {}, script?: any[][]) {
  const label = `${mark.toLowerCase()}-do-it`;
  const b = await boot([{ mark, script }], { ...opts, main: [[{ tool: 'subagent', args: { task: `${mark} do it`, label } }], [{ text: 'started' }]] });
  await ask(b.ui, 'run it');
  await settleUntil(() => b.children[0]!.held);
  await settleUntil(() => frameOf(b.ui).includes(`⚙ ${label}`));
  return b;
}
const watchFromRows = async (ui: UI) => { await ui.press('down'); await ui.press('return'); await settle(4); };

// The saved session that has an answer (the sessions directory holds one per conversation).
function answeredSession(dir: string): { answeredAt?: string; seenAt?: string } | null {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.json') ? [path.join(d, e.name)] : []);
  for (const f of walk(dir)) {
    const s = JSON.parse(fs.readFileSync(f, 'utf8')) as { answeredAt?: string; seenAt?: string };
    if (s.answeredAt) return s;
  }
  return null;
}

test('⏎ on a row shows the child\'s conversation with the breadcrumb, not the session\'s; its steps appear while watched', async () => {
  const { children: [a], ui } = await oneHeld();
  expect(frameOf(ui)).toContain('/subagent WATA do it');
  await watchFromRows(ui);
  expect(watching(ui)).toBe(true);
  expect(frameOf(ui)).toContain('╭─ ƒ Flow Assist · wata-do-it');
  expect(frameOf(ui)).toContain('› WATA do it');
  expect(frameOf(ui)).not.toContain('/subagent WATA do it');
  expect(frameOf(ui)).toMatch(/⚙ \S.*x stop · Esc back/);
  // Neither the field nor the tree is drawn.
  expect(frameOf(ui)).not.toContain('↑↓ history');
  expect(frameOf(ui)).not.toContain('Enter send');
  a!.release();
  await settleUntil(() => frameOf(ui).includes('WATA step'));
  expect(frameOf(ui)).toContain('▸ WATA step');
  a!.release();
  ui.app.unmount();
});

test('Esc steps back to the session with its scroll where it was and the cursor on the node\'s row; it does not stop the child', async () => {
  const tall = Array.from({ length: 40 }, (_, i) => `Session line ${i + 1}.`).join('\n\n');
  const { children: [a], ui } = await boot([{ mark: 'WATB' }], { cols: 120, rows: 26, main: [[{ text: tall }]] });
  await ask(ui, 'say lines');
  await settleUntil(() => frameOf(ui).includes('Session line 40.'));
  await ask(ui, '/subagent WATB do it');
  await settleUntil(() => a!.held);
  await settleUntil(() => frameOf(ui).includes('⚙ watb-do'));
  for (let i = 0; i < 2; i++) { ui.backend.press(PAGE_UP); await settle(2); }
  const listOf = () => rowsOf(ui).filter((r) => /Session line \d+\./.test(r)).map((r) => r.match(/Session line \d+\./)![0]);
  const before = listOf();
  expect(before.length).toBeGreaterThan(0);
  expect(before).not.toContain('Session line 40.');
  await watchFromRows(ui);
  expect(frameOf(ui)).not.toContain('Session line');
  await ui.press('escape');
  await settle(4);
  expect(watching(ui)).toBe(false);
  expect(listOf()).toEqual(before);
  expect(inRows(ui)).toBe(true);
  expect(frameOf(ui)).toContain('⚙ watb-do');
  expect(a!.held).toBe(true);
  a!.release();
  ui.app.unmount();
});

test('a watch started from /agents (⏎ closes the panel); an ended row says there is nothing to watch', async () => {
  const { children: [a, b], ui } = await boot([{ mark: 'AAA' }, { mark: 'BBB' }]);
  await ask(ui, '/subagent AAA go');
  await ask(ui, '/subagent BBB go');
  await settleUntil(() => a!.held && b!.held);
  await ask(ui, '/agents');
  await settleUntil(() => frameOf(ui).includes('Flow Assist · Agents') && frameOf(ui).includes('bbb-go'));
  await ui.press('down');
  await ui.press('return');
  await settle(4);
  expect(frameOf(ui)).toContain('╭─ ƒ Flow Assist · bbb-go');
  expect(frameOf(ui)).not.toContain('Flow Assist · Agents');
  await ui.press('escape');
  await settle(4);
  expect(watching(ui)).toBe(false);
  expect(inRows(ui)).toBe(false);
  // Let AAA answer and stop it, then ⏎ on its ended row.
  a!.release();
  await settleUntil(() => a!.held);
  a!.release();
  await settleUntil(() => frameOf(ui).includes('◆ aaa-go finished:'));
  await ask(ui, '/subagent stop aaa-go');
  await settleUntil(() => frameOf(ui).includes('aaa-go stopped'));
  await ask(ui, '/agents');
  await settleUntil(() => frameOf(ui).includes('Flow Assist · Agents'));
  await ui.press('down');
  await ui.press('return');
  await settle(4);
  expect(frameOf(ui)).toContain('it has ended — nothing to watch');
  expect(frameOf(ui)).toContain('Flow Assist · Agents');
  b!.release();
  ui.app.unmount();
});

test('in the watch typing, ⏎ and a /command send nothing, and the field is empty after Esc', async () => {
  const { children: [a], ui, model } = await oneHeld();
  await watchFromRows(ui);
  const asked = model.requests.length;
  await ui.type('hello there');
  await ui.press('return');
  await ui.type('/clear');
  await ui.press('return');
  await ui.press('tab');
  await settle(4);
  expect(watching(ui)).toBe(true);
  expect(frameOf(ui)).toContain('› WATA do it');
  expect(frameOf(ui)).not.toContain('hello there');
  expect(model.requests.length).toBe(asked);
  await ui.press('escape');
  await settle(4);
  expect(frameOf(ui)).toContain('/subagent WATA do it');
  expect(frameOf(ui)).not.toContain('hello there');
  expect(frameOf(ui)).not.toContain('/clear');
  expect(frameOf(ui)).toContain('⏎ send');
  a!.release();
  ui.app.unmount();
});

test('a subagent that answers while watched stays on screen with its last answer and `idle`; stopped, the watch says `ended: stopped`; the first answer is the session\'s after Esc', async () => {
  const { children: [a], ui } = await oneHeld();
  await watchFromRows(ui);
  a!.release();
  await settleUntil(() => a!.held);
  a!.release();
  await settleUntil(() => frameOf(ui).includes('◦ idle'));
  expect(frameOf(ui)).toContain('WATA settled');
  expect(frameOf(ui)).toContain('x stop');
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop wata-do-it? y yes · n no');
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('ended: stopped'));
  expect(frameOf(ui)).toMatch(/ended: stopped\s+Esc back/);
  expect(frameOf(ui)).not.toContain('x stop');
  await ui.press('x');
  await settle(4);
  expect(frameOf(ui)).not.toContain('stop wata-do-it?');
  await ui.press('escape');
  await settle(4);
  expect(watching(ui)).toBe(false);
  expect(frameOf(ui)).toContain('◆ wata-do-it finished:');
  ui.app.unmount();
});

test('a task that ends while watched stays on screen with its last answer and `ended: done`; the result is the session\'s after Esc; x does nothing', async () => {
  const { children: [a], ui } = await oneHeldTask('WATT');
  await watchFromRows(ui);
  a!.release();
  await settleUntil(() => a!.held);
  a!.release();
  await settleUntil(() => frameOf(ui).includes('ended: done'));
  expect(frameOf(ui)).toContain('WATT settled');
  expect(frameOf(ui)).toMatch(/ended: done\s+Esc back/);
  expect(frameOf(ui)).not.toContain('x stop');
  await ui.press('x');
  await settle(4);
  expect(frameOf(ui)).not.toContain('stop watt-do-it?');
  expect(frameOf(ui)).toContain('ended: done');
  await ui.press('escape');
  await settle(4);
  expect(watching(ui)).toBe(false);
  expect(frameOf(ui)).toContain('◆ watt-do-it finished:');
  ui.app.unmount();
});

test('x asks in the hint row; n and Esc drop the question and the watch stays; y stops the node and the watch stays on it', async () => {
  const { children: [a], ui } = await oneHeld();
  await watchFromRows(ui);
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop wata-do-it? y yes · n no');
  await ui.press('n');
  expect(frameOf(ui)).not.toContain('stop wata-do-it?');
  expect(watching(ui)).toBe(true);
  await ui.press('x');
  await ui.press('escape');
  expect(frameOf(ui)).not.toContain('stop wata-do-it?');
  expect(frameOf(ui)).toContain('╭─ ƒ Flow Assist · wata-do-it');
  // A y with no question stops nothing.
  await ui.press('y');
  await settle(4);
  expect(frameOf(ui)).toMatch(/⚙ \S.*x stop · Esc back/);
  await ui.press('x');
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('ended: stopped'));
  expect(frameOf(ui)).toContain('ended: stopped');
  expect(frameOf(ui)).toContain('╭─ ƒ Flow Assist · wata-do-it');
  await ui.press('escape');
  await settle(4);
  expect(frameOf(ui)).toContain('◆ wata-do-it stopped:');
  ui.app.unmount();
});

test('a session\'s answer that arrives while watching is not marked seen until Esc', async () => {
  const { children: [a], ui, model, sessions } = await boot([{ mark: 'WATC' }], { main: [[{ hold: true }, { text: 'MAIN-ANSWER' }]] });
  await ask(ui, '/subagent WATC do it');
  await settleUntil(() => a!.held);
  await ask(ui, 'main go');
  await settleUntil(() => model.held);
  await settleUntil(() => frameOf(ui).includes('⚙ watc-do'));
  await watchFromRows(ui);
  expect(watching(ui)).toBe(true);
  model.release();
  await settle(12);
  await sleep(400);
  const unseen = answeredSession(sessions);
  expect(unseen?.answeredAt).toBeTruthy();
  expect((unseen?.seenAt ?? '') >= unseen!.answeredAt!).toBe(false);
  expect(frameOf(ui)).not.toContain('MAIN-ANSWER');
  await ui.press('escape');
  await settle(4);
  await sleep(500);
  expect(frameOf(ui)).toContain('MAIN-ANSWER');
  const seen = answeredSession(sessions);
  expect((seen?.seenAt ?? '') >= seen!.answeredAt!).toBe(true);
  a!.release();
  ui.app.unmount();
});

for (const pause of [50, 700]) {
  test(`the session's own y/n ends the watch and is armed: a y ${pause} ms after it ${pause < 600 ? 'approves nothing' : 'approves it'}`, async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-watch-own-')));
    const own = path.join(dir, 'OWN.txt');
    const { children: [a], ui, model } = await boot([{ mark: 'WATD' }], { main: [[{ hold: true }, { tool: 'run_command', args: { command: `touch ${own}` } }], [{ text: 'main done' }]] });
    await ask(ui, '/subagent WATD do it');
    await settleUntil(() => a!.held);
    await ask(ui, 'main go');
    await settleUntil(() => model.held);
    await settleUntil(() => frameOf(ui).includes('⚙ watd-do'));
    await watchFromRows(ui);
    expect(watching(ui)).toBe(true);
    model.release();
    await settleUntil(() => frameOf(ui).includes('Confirm write: run_command'));
    expect(watching(ui)).toBe(false);
    clock.t += pause;
    await ui.press('y');
    if (pause < 600) {
      await settle(6);
      expect(fs.existsSync(own)).toBe(false);
    } else {
      await settleUntil(() => fs.existsSync(own));
      expect(fs.existsSync(own)).toBe(true);
    }
    a!.release();
    ui.app.unmount();
  });
}

test('while watching, the chat publishes the session\'s messages and state, not the child\'s', async () => {
  const { children: [a], ui } = await oneHeld();
  a!.release();
  await settleUntil(() => a!.held);
  await watchFromRows(ui);
  expect(frameOf(ui)).toContain('WATA step');
  const chat = host.current.store.chat;
  const text = JSON.stringify(chat.messages);
  expect(text).toContain('/subagent WATA do it');
  expect(text).not.toContain('WATA step');
  expect(chat.streaming).toBe(false);
  a!.release();
  ui.app.unmount();
});

test('the details key opens the watched rows and leaves the session\'s folds as they were', async () => {
  const { children: [a], ui } = await boot([{ mark: 'WATE' }], { main: [[{ tool: 'datetime', args: {} }], [{ text: 'Session answer.' }]] });
  await ask(ui, 'what day');
  await settleUntil(() => frameOf(ui).includes('Session answer.'));
  await ask(ui, '/subagent WATE do it');
  await settleUntil(() => a!.held);
  await settleUntil(() => frameOf(ui).includes('⚙ wate-do'));
  a!.release();
  await settleUntil(() => a!.held);
  await watchFromRows(ui);
  expect(frameOf(ui)).not.toMatch(/→ ok/);
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(4);
  expect(frameOf(ui)).toMatch(/→ ok/);
  expect(watching(ui)).toBe(true);
  await ui.press('escape');
  await settle(4);
  expect(frameOf(ui)).toContain('1 tool: datetime');
  expect(frameOf(ui)).not.toMatch(/→ ok/);
  a!.release();
  ui.app.unmount();
});

test('a grandchild\'s breadcrumb has two labels', async () => {
  const { children: [outer, inner], ui } = await boot([
    { mark: 'OUTER', script: [[{ hold: true }, { tool: 'subagent', args: { task: 'INNER work', label: 'inner' } }], [{ hold: true }, { text: 'outer settled' }]] },
    { mark: 'INNER' },
  ]);
  await ask(ui, '/subagent OUTER go');
  await settleUntil(() => outer!.held);
  outer!.release();
  await settleUntil(() => inner!.held);
  await settleUntil(() => frameOf(ui).includes('inner (task)'));
  await ui.press('down');
  await ui.press('down');
  await ui.press('return');
  await settle(4);
  expect(frameOf(ui)).toContain('╭─ ƒ Flow Assist · outer-go › inner');
  expect(frameOf(ui)).toContain('› INNER work');
  inner!.release();
  await settleUntil(() => inner!.held);
  inner!.release();
  await settleUntil(() => outer!.held);
  outer!.release();
  ui.app.unmount();
});

// A child with a long prompt overflows the list at once; its last answer arrives later.
const LONG = Array.from({ length: 90 }, (_, i) => `word${i}`).join(' ');
async function overflowing() {
  const b = await boot([{ mark: 'WATF', script: [[{ hold: true }, { text: 'WATF step', tool: 'datetime', args: {} }], [{ hold: true }, { text: 'ARRIVED-LATER' }]] }], { cols: 70, rows: 22 });
  await ask(b.ui, `/subagent WATF ${LONG}`);
  await settleUntil(() => b.children[0]!.held);
  await settleUntil(() => frameOf(b.ui).includes('⚙ watf-'));
  await watchFromRows(b.ui);
  b.children[0]!.release();
  await settleUntil(() => b.children[0]!.held);
  await settleUntil(() => frameOf(b.ui).includes('WATF step'));
  return b;
}

test('the watched rows follow their end while the list rests there', async () => {
  const { children: [a], ui } = await overflowing();
  expect(frameOf(ui)).not.toContain('word0 ');
  expect(frameOf(ui)).toContain('WATF step');
  a!.release();
  await settleUntil(() => frameOf(ui).includes('ended: done'));
  expect(frameOf(ui)).toContain('ARRIVED-LATER');
  ui.app.unmount();
});

test('scrolled up the watched rows stay where they are as rows arrive, and End brings the end back', async () => {
  const { children: [a], ui } = await overflowing();
  for (let i = 0; i < 6 && !frameOf(ui).includes('word0 '); i++) { ui.backend.press(PAGE_UP); await settle(2); }
  expect(frameOf(ui)).toContain('word0 ');
  a!.release();
  await settleUntil(() => frameOf(ui).includes('ended: done'));
  expect(frameOf(ui)).toContain('word0 ');
  expect(frameOf(ui)).not.toContain('ARRIVED-LATER');
  await ui.press('end');
  await settle(4);
  expect(frameOf(ui)).toContain('ARRIVED-LATER');
  ui.app.unmount();
});

test('the sessions key ends the watch and opens the picker', async () => {
  const { children: [a], ui } = await oneHeld();
  await watchFromRows(ui);
  ui.backend.press({ name: 's', ctrl: true });
  await settle(4);
  expect(frameOf(ui)).toContain('Sessions ·');
  await ui.press('escape');
  await settle(4);
  expect(watching(ui)).toBe(false);
  expect(frameOf(ui)).toContain('/subagent WATA do it');
  a!.release();
  ui.app.unmount();
});

test('a question of the session ends the watch', async () => {
  const { children: [a], ui, model } = await boot([{ mark: 'WATH' }], { main: [[{ hold: true }, { tool: 'ask_user', args: { questions: [{ question: 'Which branch?', options: [{ label: 'master' }, { label: 'develop' }] }] } }], [{ text: 'Using it.' }]] });
  await ask(ui, '/subagent WATH do it');
  await settleUntil(() => a!.held);
  await ask(ui, 'main go');
  await settleUntil(() => model.held);
  await settleUntil(() => frameOf(ui).includes('⚙ wath-do'));
  await watchFromRows(ui);
  expect(watching(ui)).toBe(true);
  model.release();
  await settleUntil(() => frameOf(ui).includes('Which branch?'));
  expect(frameOf(ui)).toContain('Which branch?');
  expect(watching(ui)).toBe(false);
  a!.release();
  ui.app.unmount();
});

test('a click in the watched rows folds nothing, the session\'s rows included', async () => {
  const { children: [a], ui } = await boot([{ mark: 'WATI' }], { main: [[{ tool: 'datetime', args: {} }], [{ text: 'Session answer.' }]] });
  await ask(ui, 'what day');
  await settleUntil(() => frameOf(ui).includes('Session answer.'));
  await ask(ui, '/subagent WATI do it');
  await settleUntil(() => a!.held);
  await settleUntil(() => frameOf(ui).includes('⚙ wati-do'));
  // The row the session's tool line is on, while the session is drawn.
  const toolAt = rowsOf(ui).findIndex((r) => r.includes('1 tool: datetime'));
  const x = rowsOf(ui)[toolAt]!.indexOf('1 tool');
  a!.release();
  await settleUntil(() => a!.held);
  await watchFromRows(ui);
  const stepAt = rowsOf(ui).findIndex((r) => r.includes('▸ WATI step'));
  expect(stepAt).toBeGreaterThan(0);
  for (const y of [toolAt, stepAt]) {
    ui.backend.mouse('down', x, y);
    ui.backend.mouse('up', x, y);
    await settle(6);
  }
  expect(frameOf(ui)).toContain('▸ WATI step');
  expect(watching(ui)).toBe(true);
  await ui.press('escape');
  await settle(4);
  expect(frameOf(ui)).toContain('1 tool: datetime');
  expect(frameOf(ui)).not.toMatch(/→ ok/);
  a!.release();
  ui.app.unmount();
});

const COLLAPSE = { name: '\\', ctrl: true };
test('a collapsed chat keeps the watch; one whose task ended meanwhile opens on the session', async () => {
  const { children: [a], ui } = await oneHeldTask('WATG', { cols: 160, rows: 40, mode: 'panel' });
  await watchFromRows(ui);
  ui.backend.press(COLLAPSE);
  await settle();
  ui.backend.press(COLLAPSE);
  await settle();
  expect(watching(ui)).toBe(true);
  expect(frameOf(ui)).toContain('Flow Assist · watg-do-it');
  ui.backend.press(COLLAPSE);
  await settle();
  a!.release();
  await settleUntil(() => a!.held);
  a!.release();
  await settleUntil(() => frameOf(ui).includes('wata') || true, 4);
  await settle(10);
  ui.backend.press(COLLAPSE);
  await settle();
  expect(watching(ui)).toBe(false);
  expect(frameOf(ui)).toContain('◆ watg-do-it finished:');
  ui.app.unmount();
});

// ---- a y/n in the watch (AGENTS.md (watching a child)) ----

const BLOCK = 'Confirm write: run_command';
const tmpRoot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-watch-ask-')));
// A child that waits to be released, asks to write `file`, and then says it is settled.
const asks = (mark: string, file: string) => [[{ hold: true }, { tool: 'run_command', args: { command: `touch ${file}` } }], [{ text: `${mark} settled` }]];

// One child that will ask, watched; the request lands on `release`.
async function watchedAsker(mark: string, label: string, opts: Parameters<typeof boot>[1] & { via?: 'agents' } = {}) {
  const root = tmpRoot();
  const file = path.join(root, `${mark}.txt`);
  const b = await boot([{ mark, script: asks(mark, file) }], { root, ...opts });
  await ask(b.ui, `/subagent ${mark} do it`);
  await settleUntil(() => b.children[0]!.held);
  if (opts.via === 'agents') {
    await ask(b.ui, '/agents');
    await settleUntil(() => frameOf(b.ui).includes('Flow Assist · Agents') && frameOf(b.ui).includes(label));
    await b.ui.press('return');
    await settle(4);
  } else {
    await settleUntil(() => frameOf(b.ui).includes(`⚙ ${label}`));
    await watchFromRows(b.ui);
  }
  expect(watching(b.ui)).toBe(true);
  return { ...b, file, release: async () => { b.children[0]!.release(); await settleUntil(() => frameOf(b.ui).includes(BLOCK)); } };
}

test('a watched child\'s write is a y/n block at the bottom of the watch; a y inside the pause does nothing, after it approves', async () => {
  const { ui, file, release } = await watchedAsker('WRA', 'wra-do');
  await release();
  expect(watching(ui)).toBe(true);
  expect(rowsOf(ui).find((r) => r.includes(BLOCK))).toContain('⚠ wra-do-it · Confirm write: run_command');
  expect(frameOf(ui)).toContain('y yes · n no');
  expect(frameOf(ui)).not.toContain('Press y to confirm');
  expect(frameOf(ui)).not.toContain('x stop');
  expect(frameOf(ui)).toContain('Esc back');
  clock.t += 50;
  await ui.press('y');
  await settle(6);
  expect(fs.existsSync(file)).toBe(false);
  expect(frameOf(ui)).toContain(BLOCK);
  clock.t += 700;
  await ui.press('y');
  await settleUntil(() => fs.existsSync(file));
  expect(fs.existsSync(file)).toBe(true);
  await settleUntil(() => frameOf(ui).includes('ended: done'));
  expect(frameOf(ui)).not.toContain(BLOCK);
  ui.app.unmount();
});

test('n declines the watched child\'s write after the pause, and a y or n with ctrl does not answer', async () => {
  const { ui, file, release } = await watchedAsker('WRB', 'wrb-do');
  await release();
  clock.t += 700;
  ui.backend.press({ name: 'y', ctrl: true });
  ui.backend.press({ name: 'n', meta: true });
  await settle(6);
  expect(frameOf(ui)).toContain(BLOCK);
  clock.t += 700;
  await ui.press('n');
  await settleUntil(() => frameOf(ui).includes('ended: done'));
  expect(fs.existsSync(file)).toBe(false);
  expect(frameOf(ui)).not.toContain(BLOCK);
  ui.app.unmount();
});

test('⏎ and Esc never answer the watched child\'s request; Esc steps back and the request waits in the session\'s view', async () => {
  const { ui, file, release } = await watchedAsker('WRC', 'wrc-do', { via: 'agents' });
  await release();
  clock.t += 700;
  await ui.press('return');
  await settle(6);
  expect(fs.existsSync(file)).toBe(false);
  expect(frameOf(ui)).toContain(BLOCK);
  expect(watching(ui)).toBe(true);
  clock.t += 700;
  await ui.press('escape');
  await settle(6);
  expect(watching(ui)).toBe(false);
  expect(fs.existsSync(file)).toBe(false);
  expect(frameOf(ui)).toContain(BLOCK);
  expect(frameOf(ui)).toContain('y yes · n no');
  ui.app.unmount();
});

test('stepping back with a request waiting: a y inside the pause answers nothing in the session\'s view, after it the request is approved', async () => {
  const { ui, file, release } = await watchedAsker('WRD', 'wrd-do', { via: 'agents' });
  await release();
  clock.t += 700;
  await ui.press('escape');
  await settle(6);
  expect(watching(ui)).toBe(false);
  clock.t += 50;
  await ui.press('y');
  await settle(6);
  expect(fs.existsSync(file)).toBe(false);
  // The y that did not count typed its letter, as in the session's view anywhere else.
  await ui.press('backspace');
  clock.t += 700;
  await ui.press('y');
  await settleUntil(() => fs.existsSync(file));
  expect(fs.existsSync(file)).toBe(true);
  ui.app.unmount();
});

test('a sibling\'s request is one notice line in the watch and no key answers it; Esc then shows the block', async () => {
  const root = tmpRoot();
  const file = path.join(root, 'SIDE.txt');
  const { children: [a, b], ui } = await boot([{ mark: 'SIDE', script: asks('SIDE', file) }, { mark: 'QUIET' }], { root });
  await ask(ui, '/subagent SIDE go');
  await ask(ui, '/subagent QUIET go');
  await settleUntil(() => a!.held && b!.held);
  await settleUntil(() => frameOf(ui).includes('quiet-go'));
  await ui.press('down');
  await ui.press('down');
  await ui.press('return');
  await settle(4);
  expect(frameOf(ui)).toContain('╭─ ƒ Flow Assist · quiet-go');
  a!.release();
  await settleUntil(() => frameOf(ui).includes('waits for a y/n'));
  expect(frameOf(ui)).toContain('⏸ side-go waits for a y/n — Esc to answer');
  expect(frameOf(ui)).not.toContain(BLOCK);
  expect(frameOf(ui)).toContain('x stop · Esc back');
  clock.t += 700;
  await ui.press('y');
  await ui.press('return');
  await settle(6);
  expect(fs.existsSync(file)).toBe(false);
  expect(frameOf(ui)).toContain('⏸ side-go waits for a y/n');
  await ui.press('escape');
  await settle(6);
  expect(watching(ui)).toBe(false);
  // A request waits in the tree: the cursor goes to the field and the block is drawn at once.
  expect(frameOf(ui)).toContain(BLOCK);
  expect(frameOf(ui)).not.toContain('waits for a y/n');
  clock.t += 50;
  await ui.press('y');
  await settle(6);
  expect(fs.existsSync(file)).toBe(false);
  await ui.press('backspace');
  clock.t += 700;
  await ui.press('y');
  await settleUntil(() => fs.existsSync(file));
  expect(fs.existsSync(file)).toBe(true);
  b!.release();
  ui.app.unmount();
});

test('stepping back from a watch begun in the rows, with the node\'s own request waiting: the block is drawn at once and armed afresh', async () => {
  const { ui, file, release } = await watchedAsker('WRG', 'wrg-do');
  await release();
  clock.t += 5000;
  await ui.press('escape');
  await settle(6);
  expect(watching(ui)).toBe(false);
  expect(frameOf(ui)).toContain(BLOCK);
  expect(frameOf(ui)).not.toContain('waits for a y/n');
  expect(frameOf(ui)).not.toContain(KEYS);
  clock.t += 50;
  await ui.press('y');
  await settle(6);
  expect(fs.existsSync(file)).toBe(false);
  await ui.press('backspace');
  clock.t += 700;
  await ui.press('y');
  await settleUntil(() => fs.existsSync(file));
  expect(fs.existsSync(file)).toBe(true);
  ui.app.unmount();
});

test('a grandchild\'s request is drawn while its parent is watched, labelled with both names, and the answer reaches the grandchild', async () => {
  const root = tmpRoot();
  const file = path.join(root, 'DEEP.txt');
  const { children: [outer, inner], ui } = await boot([
    { mark: 'OUTR', script: [[{ hold: true }, { tool: 'subagent', args: { task: 'INNR work', label: 'inner', write: true } }], [{ hold: true }, { text: 'outer settled' }]] },
    { mark: 'INNR', script: asks('INNR', file) },
  ], { root });
  await ask(ui, '/subagent OUTR go');
  await settleUntil(() => outer!.held);
  await settleUntil(() => frameOf(ui).includes('outr-go'));
  await watchFromRows(ui);
  expect(frameOf(ui)).toContain('╭─ ƒ Flow Assist · outr-go');
  outer!.release();
  await settleUntil(() => inner!.held);
  inner!.release();
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  expect(rowsOf(ui).find((r) => r.includes(BLOCK))).toContain('⚠ outr-go › inner · Confirm write: run_command');
  // The same request is the block, not also a notice line.
  expect(frameOf(ui)).not.toContain('waits for a y/n');
  clock.t += 700;
  await ui.press('y');
  await settleUntil(() => fs.existsSync(file));
  expect(fs.existsSync(file)).toBe(true);
  outer!.release();
  ui.app.unmount();
});

test('a stop question up when the child\'s request lands is dropped: a y inside the pause stops and approves nothing, after it approves and stops nothing', async () => {
  const { ui, file, release } = await watchedAsker('WRE', 'wre-do');
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop wre-do-it? y yes · n no');
  await release();
  expect(frameOf(ui)).not.toContain('stop wre-do-it?');
  clock.t += 50;
  await ui.press('y');
  await settle(6);
  expect(frameOf(ui)).not.toContain('ended: stopped');
  expect(frameOf(ui)).toContain(BLOCK);
  expect(fs.existsSync(file)).toBe(false);
  clock.t += 700;
  await ui.press('y');
  await settleUntil(() => fs.existsSync(file));
  await settleUntil(() => frameOf(ui).includes('ended: done'));
  expect(frameOf(ui)).not.toContain('ended: stopped');
  ui.app.unmount();
});

test('with a request standing, x asks nothing and a later y stops nothing', async () => {
  const { ui, file, release } = await watchedAsker('WRF', 'wrf-do');
  await release();
  clock.t += 700;
  await ui.press('x');
  await settle(4);
  expect(frameOf(ui)).not.toContain('stop wrf-do-it?');
  expect(frameOf(ui)).not.toContain('x stop');
  ui.app.unmount();
  expect(fs.existsSync(file)).toBe(false);
});

const chatTop = (ui: UI) => rowsOf(ui).findIndex((l) => l.includes('╭─ ƒ Flow Assist'));

test('a docked chat grows for the watch\'s block as for the session\'s, and is its own size again once it is answered', async () => {
  const { ui, file, release } = await watchedAsker('WRH', 'wrh-do', { cols: 100, rows: 30, mode: 'panel', via: 'agents' });
  const before = chatTop(ui);
  await release();
  expect(chatTop(ui)).toBeLessThan(before);
  clock.t += 700;
  await ui.press('y');
  await settleUntil(() => fs.existsSync(file));
  await settleUntil(() => chatTop(ui) === before);
  expect(chatTop(ui)).toBe(before);
  ui.app.unmount();
});

test('where the block would undock the chat, the watch says so in one line and no key answers', async () => {
  const root = tmpRoot();
  const file = path.join(root, 'WRI.txt');
  const { children: [a], ui } = await boot([{ mark: 'WRI', script: asks('WRI', file) }], { root, cols: 100, rows: 20, mode: 'panel' });
  await ask(ui, '/subagent WRI do it');
  await settleUntil(() => a!.held);
  await ask(ui, '/agents');
  await settleUntil(() => frameOf(ui).includes('Flow Assist · Agents') && frameOf(ui).includes('wri-do'));
  await ui.press('return');
  await settle(4);
  expect(watching(ui)).toBe(true);
  a!.release();
  await settleUntil(() => frameOf(ui).includes('no room to show it'));
  expect(rowsOf(ui).find((r) => r.includes('no room to show it'))).toContain('/subagent stop wri-do-it declines it');
  expect(frameOf(ui)).toContain('BOARD-SURFACE');
  expect(frameOf(ui)).not.toContain(BLOCK);
  expect(frameOf(ui)).not.toContain('x stop');
  clock.t += 700;
  await ui.press('y');
  await settle(4);
  expect(fs.existsSync(file)).toBe(false);
  expect(watching(ui)).toBe(true);
  ui.app.unmount();
});

// ---- the session's own question over a watch or the tree cursor ----

const QUESTION = [[{ hold: true }, { tool: 'ask_user', args: { questions: [{ question: 'Which branch?', options: [{ label: 'master' }, { label: 'develop' }] }] } }], [{ text: 'Using it.' }]];

for (const where of ['watching', 'the cursor in the rows'] as const) {
  test(`the session's own question that arrives while ${where} takes no key for the pause, then ⏎ answers it`, async () => {
    const { children: [a], ui, model } = await boot([{ mark: 'WQA' }], { main: QUESTION });
    await ask(ui, '/subagent WQA do it');
    await settleUntil(() => a!.held);
    await ask(ui, 'main go');
    await settleUntil(() => model.held);
    await settleUntil(() => frameOf(ui).includes('⚙ wqa-do'));
    if (where === 'watching') await watchFromRows(ui);
    else await ui.press('down');
    expect(where === 'watching' ? watching(ui) : inRows(ui)).toBe(true);
    model.release();
    await settleUntil(() => frameOf(ui).includes('Which branch?'));
    expect(watching(ui)).toBe(false);
    clock.t += 50;
    await ui.press('return');
    await settle(6);
    expect(frameOf(ui)).toContain('Which branch?');
    clock.t += 700;
    await ui.press('return');
    await settleUntil(() => !frameOf(ui).includes('Which branch?'));
    await settleUntil(() => frameOf(ui).includes('Using it.'));
    a!.release();
    ui.app.unmount();
  });
}

test('a question with no watch and no cursor takes a key at once', async () => {
  const { ui, model } = await boot([{ mark: 'WQB' }], { main: QUESTION });
  await ask(ui, 'main go');
  await settleUntil(() => model.held);
  model.release();
  await settleUntil(() => frameOf(ui).includes('Which branch?'));
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('Using it.'));
  expect(frameOf(ui)).not.toContain('Which branch?');
  ui.app.unmount();
});

// ---- the settings file's y/n (the session's own, asked by the host) ----

const settingsFile = () => path.join(hostStateDir(), 'config.local.json');
const SETTINGS = 'changed outside flow-assist';
function guardSettings() {
  fs.mkdirSync(hostStateDir(), { recursive: true });
  fs.rmSync(acceptedConfigPath(), { force: true });
  fs.writeFileSync(settingsFile(), '{}');
  loadConfig();
  guardConfigFiles();
}
function unguardSettings() {
  unguardConfigFiles();
  resetSessionConfig();
  fs.rmSync(settingsFile(), { force: true });
  fs.rmSync(acceptedConfigPath(), { force: true });
  for (const f of fs.readdirSync(hostStateDir())) if (f.includes('.rejected-')) fs.rmSync(path.join(hostStateDir(), f));
}
const HELD_MAIN = [[{ hold: true }, { tool: 'datetime', args: {} }], [{ text: 'main done' }]];

test('the settings file\'s y/n ends a watch: a y inside the pause creates the child\'s file in no case, and after it only the setting is applied', async () => {
  guardSettings();
  try {
    const root = tmpRoot();
    const file = path.join(root, 'PONE.txt');
    const { children: [a], ui, model } = await boot([{ mark: 'PONE', script: asks('PONE', file) }], { root, main: HELD_MAIN });
    await ask(ui, '/subagent PONE do it');
    await settleUntil(() => a!.held);
    await ask(ui, 'main go');
    await settleUntil(() => model.held);
    await settleUntil(() => frameOf(ui).includes('⚙ pone-do'));
    await watchFromRows(ui);
    expect(watching(ui)).toBe(true);
    a!.release();
    await settleUntil(() => frameOf(ui).includes(BLOCK));
    clock.t += 5000;
    fs.writeFileSync(settingsFile(), '{"shell":{"autoRun":true}}');
    model.release();
    await settleUntil(() => frameOf(ui).includes(SETTINGS));
    expect(watching(ui)).toBe(false);
    expect(frameOf(ui)).toContain('apply? (y/n)');
    expect(frameOf(ui)).not.toContain(BLOCK);
    clock.t += 50;
    await ui.press('y');
    await settle(6);
    expect(fs.existsSync(file)).toBe(false);
    expect(frameOf(ui)).toContain(SETTINGS);
    clock.t += 700;
    await ui.press('y');
    await settleUntil(() => frameOf(ui).includes('Applied config.local.json'));
    expect(fs.existsSync(file)).toBe(false);
    ui.app.unmount();
  } finally { unguardSettings(); }
});

test('with the settings file\'s y/n up after a watch, x and y inside the pause stop nothing', async () => {
  guardSettings();
  try {
    const { children: [a], ui, model } = await boot([{ mark: 'PTWO' }], { main: HELD_MAIN });
    await ask(ui, '/subagent PTWO do it');
    await settleUntil(() => a!.held);
    await ask(ui, 'main go');
    await settleUntil(() => model.held);
    await settleUntil(() => frameOf(ui).includes('⚙ ptwo-do'));
    await watchFromRows(ui);
    expect(watching(ui)).toBe(true);
    clock.t += 5000;
    fs.writeFileSync(settingsFile(), '{"shell":{"autoRun":true}}');
    model.release();
    await settleUntil(() => frameOf(ui).includes(SETTINGS));
    expect(watching(ui)).toBe(false);
    clock.t += 50;
    await ui.press('x');
    await ui.press('y');
    await settle(6);
    expect(frameOf(ui)).not.toContain('stopped');
    expect(frameOf(ui)).toContain(SETTINGS);
    expect(a!.held).toBe(true);
    a!.release();
    ui.app.unmount();
  } finally { unguardSettings(); }
});

// ---- the corners ----

test('x, y on a watched node that has not begun ends the watch on `ended: stopped`', async () => {
  const { children, ui } = await boot([{ mark: 'QAA' }, { mark: 'QBB' }, { mark: 'QCC' }, { mark: 'QDD' }]);
  for (const m of ['QAA', 'QBB', 'QCC', 'QDD']) await ask(ui, `/subagent ${m} go`);
  await settleUntil(() => children.slice(0, 3).every((c) => c.held));
  await settleUntil(() => frameOf(ui).includes('qdd-go'));
  expect(frameOf(ui)).toContain('○ qdd-go · queued');
  for (let i = 0; i < 4; i++) await ui.press('down');
  await ui.press('return');
  await settle(4);
  expect(frameOf(ui)).toContain('╭─ ƒ Flow Assist · qdd-go');
  expect(frameOf(ui)).toContain('○ queued');
  await ui.press('x');
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('ended: stopped'));
  expect(frameOf(ui)).toContain('ended: stopped');
  expect(frameOf(ui)).not.toContain('x stop');
  expect(frameOf(ui)).toContain('Esc back');
  // Nothing more to stop: x asks nothing.
  await ui.press('x');
  await settle(4);
  expect(frameOf(ui)).not.toContain('stop qdd-go');
  for (const c of children) c.release();
  ui.app.unmount();
});

test('the breadcrumb follows a task that hands its child up while the child is watched, and stays as it was once the child ends', async () => {
  const { children: [outer, inner], ui } = await boot([
    { mark: 'OUTQ', script: [[{ hold: true }, { tool: 'subagent', args: { task: 'INNQ work', label: 'innq' } }], [{ hold: true }, { text: 'outer settled' }]] },
    { mark: 'INNQ', script: [[{ hold: true }, { text: 'inner step', tool: 'datetime', args: {} }], [{ hold: true }, { text: 'inner settled' }]] },
  ], { main: [[{ tool: 'subagent', args: { task: 'OUTQ go', label: 'outq-go' } }], [{ text: 'started' }]] });
  await ask(ui, 'run it');
  await settleUntil(() => outer!.held);
  outer!.release();
  await settleUntil(() => inner!.held);
  await settleUntil(() => frameOf(ui).includes('innq (task)'));
  await ui.press('down');
  await ui.press('down');
  await ui.press('return');
  await settle(4);
  expect(frameOf(ui)).toContain('╭─ ƒ Flow Assist · outq-go › innq');
  outer!.release();
  await settleUntil(() => !frameOf(ui).includes('outq-go ›'));
  expect(frameOf(ui)).toContain('╭─ ƒ Flow Assist · innq ');
  inner!.release();
  await settleUntil(() => inner!.held);
  inner!.release();
  await settleUntil(() => frameOf(ui).includes('ended: done'));
  expect(frameOf(ui)).toContain('╭─ ƒ Flow Assist · innq ');
  ui.app.unmount();
});

test('a session\'s answer that arrives while watching counts as seen when its own y/n ends the watch', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-watch-seen-')));
  const own = path.join(dir, 'SEEN.txt');
  const { children: [a], ui, model, sessions } = await boot([{ mark: 'WATS' }], { main: [[{ hold: true }, { text: 'FIRST-ANSWER' }], [{ tool: 'run_command', args: { command: `touch ${own}` } }], [{ text: 'second done' }]] });
  await ask(ui, '/subagent WATS do it');
  await settleUntil(() => a!.held);
  await ask(ui, 'main go');
  await settleUntil(() => model.held);
  // Typed while the turn runs: it is queued, and its turn starts when the first one has answered.
  await ask(ui, 'second');
  await settleUntil(() => frameOf(ui).includes('⚙ wats-do'));
  await watchFromRows(ui);
  expect(watching(ui)).toBe(true);
  model.release();
  await settleUntil(() => frameOf(ui).includes('Confirm write: run_command'));
  expect(watching(ui)).toBe(false);
  await sleep(500);
  const s = answeredSession(sessions);
  expect(s?.answeredAt).toBeTruthy();
  expect((s?.seenAt ?? '') >= s!.answeredAt!).toBe(true);
  a!.release();
  ui.app.unmount();
});

test('a docked chat whose keys are the plugin\'s keeps its watch, and a key the plugin leaves untaken is not swallowed by the watch', async () => {
  const { children: [a], ui } = await boot([{ mark: 'WDK' }], { cols: 160, rows: 40, mode: 'panel' });
  await ask(ui, '/subagent WDK do it');
  await settleUntil(() => a!.held);
  await ask(ui, '/agents');
  await settleUntil(() => frameOf(ui).includes('Flow Assist · Agents') && frameOf(ui).includes('wdk-do'));
  await ui.press('return');
  await settle(4);
  expect(watching(ui)).toBe(true);
  // The keyboard goes to the plugin; the chat stays open beside it with its watch.
  ui.backend.press({ name: ']', ctrl: true });
  await settle(4);
  expect(host.current.store.chat.focus).toBe('plugin');
  expect(watching(ui)).toBe(true);
  // The host's command line opens on a key nobody above it took.
  await ui.press(':');
  await settle(4);
  expect(frameOf(ui)).toMatch(/^\s*:/m);
  expect(watching(ui)).toBe(true);
  a!.release();
  ui.app.unmount();
});

test('with the stop question up, y or n with ctrl or meta answers nothing; the question stays and the node runs on', async () => {
  const { children: [a], ui } = await oneHeld('WCM');
  await watchFromRows(ui);
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop wcm-do-it? y yes · n no');
  ui.backend.press({ name: 'y', ctrl: true });
  ui.backend.press({ name: 'y', meta: true });
  await settle(6);
  expect(frameOf(ui)).toContain('stop wcm-do-it? y yes · n no');
  expect(frameOf(ui)).not.toContain('ended:');
  expect(a!.held).toBe(true);
  a!.release();
  ui.app.unmount();
});

test('a stop question up when the task ends is gone: the hint row says how it ended', async () => {
  const { children: [a], ui } = await oneHeldTask('WQE');
  await watchFromRows(ui);
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop wqe-do-it? y yes · n no');
  a!.release();
  await settleUntil(() => a!.held);
  a!.release();
  await settleUntil(() => frameOf(ui).includes('ended: done'));
  expect(frameOf(ui)).not.toContain('stop wqe-do-it?');
  ui.app.unmount();
});

test('in /agents ⏎ under a stop question starts no watch', async () => {
  const { children: [a, b], ui } = await boot([{ mark: 'PQA' }, { mark: 'PQB' }]);
  await ask(ui, '/subagent PQA go');
  await ask(ui, '/subagent PQB go');
  await settleUntil(() => a!.held && b!.held);
  await ask(ui, '/agents');
  await settleUntil(() => frameOf(ui).includes('Flow Assist · Agents') && frameOf(ui).includes('pqb-go'));
  await ui.press('down');
  await ui.press('x');
  expect(frameOf(ui)).toContain('stop pqb-go? y yes · n no');
  await ui.press('return');
  await settle(4);
  // The panel's own title also opens `╭─ ƒ Flow Assist · `: the watch's hint row is what tells.
  expect(frameOf(ui)).not.toContain('Esc back');
  expect(frameOf(ui)).toContain('Flow Assist · Agents');
  expect(frameOf(ui)).toContain('stop pqb-go? y yes · n no');
  a!.release();
  b!.release();
  ui.app.unmount();
});

test('Ctrl+C in a watch does not stop the session\'s turn: it arms the exit, and a second one exits', async () => {
  const { children: [a], ui, model } = await boot([{ mark: 'WCC' }], { main: [[{ hold: true }, { text: 'main answer' }]] });
  await ask(ui, '/subagent WCC do it');
  await settleUntil(() => a!.held);
  await ask(ui, 'main go');
  await settleUntil(() => model.held);
  await settleUntil(() => frameOf(ui).includes('⚙ wcc-do'));
  await watchFromRows(ui);
  expect(watching(ui)).toBe(true);
  const consumed = ui.backend.press({ name: 'c', ctrl: true });
  await settle(6);
  expect(consumed).toBe(true);
  expect(ui.exits()).toBe(0);
  ui.backend.press({ name: 'c', ctrl: true });
  await settle(6);
  expect(ui.exits()).toBe(1);
  // The turn was never stopped: it goes on to its answer.
  model.release();
  await settleUntil(() => !model.held);
  await settle(10);
  await ui.press('escape');
  await settle(4);
  expect(frameOf(ui)).toContain('main answer');
  expect(frameOf(ui)).not.toContain('stopped (^c)');
  a!.release();
  ui.app.unmount();
});
