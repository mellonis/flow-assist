// Which request each key reaches while a subagent the person started is idle or in a later
// turn (AGENTS.md (subagent y/n), (agent tree), (watching a child)): the session's own y/n,
// the settings-file y/n and the session's question keep their keys; a later turn's y/n is
// offered like any child's; the tree rows and the watch act on an idle node; a `/subagent
// tell` typed while a y/n waits is a command line. The real app on the scripted model; the
// pause before an answer counts is read from `askClock`, which the tests move.
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
const localConfig = () => path.join(hostStateDir(), 'config.local.json');
afterEach(() => {
  globalThis.fetch = realFetch;
  askClock.now = realNow;
  unguardConfigFiles();
  resetSessionConfig();
  fs.rmSync(localConfig(), { force: true });
  fs.rmSync(acceptedConfigPath(), { force: true });
  for (const f of fs.readdirSync(hostStateDir())) if (f.includes('.rejected-')) fs.rmSync(path.join(hostStateDir(), f));
});

const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
const pause = () => { clock.t += 700; };
const BLOCK = 'Confirm write: run_command';
const OWN = 'Press y to confirm';

type Turn = Parameters<ScriptedModel['script']>;
// A booted chat. Each mark is one subagent, `turns` its scripted responses in order.
async function boot(marksOf: { mark: string; turns: Turn }[] | ((root: string) => { mark: string; turns: Turn }[]), config: Record<string, unknown> = {}) {
  clock.t = 10_000;
  askClock.now = () => clock.t;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-keys-')));
  const model = new ScriptedModel();
  const marks = typeof marksOf === 'function' ? marksOf(root) : marksOf;
  const children = marks.map(({ mark, turns }) => {
    const child = model.when((req) => firstUser(req).includes(mark));
    child.script(...turns);
    return child;
  });
  const ui = await bootApp(model, 140, 34, undefined, { sessions: { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'fa-keys-s-')) }, shell: { roots: [root] }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false }, ...config }, { toastMs: 10_000 });
  await ui.press('F');
  return { root, model, children, ui };
}
const touch = (root: string, name: string) => [{ tool: 'run_command', args: { command: `touch ${path.join(root, name)}` } }];
// Starts a subagent and waits until it has answered and rests.
async function startIdle(ui: UI, mark: string, label: string) {
  await ask(ui, `/subagent ${mark} go`);
  await settleUntil(() => frameOf(ui).includes(`◆ ${label} finished:`));
  await settleUntil(() => frameOf(ui).includes(`◦ ${label} · idle`));
}

test('the session\'s own y/n over the tree cursor on an idle subagent is armed, then answered by y; the subagent is not touched', async () => {
  const { root, model, children: [a], ui } = await boot([{ mark: 'IDLE-OWN', turns: [[{ text: 'first' }]] }]);
  await startIdle(ui, 'IDLE-OWN', 'idle-own-go');
  await ui.press('down'); // the cursor goes to the idle subagent's row
  model.script([{ hold: true }, ...touch(root, 'own.txt')], [{ text: 'parent done' }]);
  // The cursor is in the rows: the field is not what takes the next text, so the turn is sent from there.
  await ui.press('escape');
  await ask(ui, 'hello');
  await settleUntil(() => model.held);
  await ui.press('down');
  model.release();
  await settleUntil(() => frameOf(ui).includes(OWN));
  // A key already on its way when the y/n appeared does not answer it.
  await ui.press('y');
  await settle(4);
  expect(fs.existsSync(path.join(root, 'own.txt'))).toBe(false);
  expect(frameOf(ui)).toContain(OWN);
  pause();
  await ui.press('y');
  await settleUntil(() => fs.existsSync(path.join(root, 'own.txt')));
  await settleUntil(() => frameOf(ui).includes('parent done'));
  // The y went to the own y/n only: the idle subagent is still there and was sent nothing.
  expect(frameOf(ui)).toContain('◦ idle-own-go · idle');
  expect(a!.requests).toHaveLength(1);
  ui.app.unmount();
});

test('the settings-file y/n answers by y with an idle subagent in the tree; the subagent stays idle', async () => {
  fs.mkdirSync(hostStateDir(), { recursive: true });
  fs.rmSync(acceptedConfigPath(), { force: true });
  fs.writeFileSync(localConfig(), '{}');
  loadConfig();
  guardConfigFiles();
  const { model, children: [a], ui } = await boot([{ mark: 'IDLE-CFG', turns: [[{ text: 'first' }]] }]);
  await startIdle(ui, 'IDLE-CFG', 'idle-cfg-go');
  const edit = `printf '%s' '{"shell":{"autoRun":true}}' > '${localConfig()}'`;
  model.script([{ tool: 'run_command', args: { command: edit } }], [{ text: 'Configured.' }]);
  await ask(ui, 'turn on auto run');
  await settleUntil(() => frameOf(ui).includes('Confirm write'));
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('changed outside flow-assist'));
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('Configured.'));
  expect(frameOf(ui)).toContain('Applied config.local.json');
  expect(frameOf(ui)).toContain('◦ idle-cfg-go · idle');
  expect(a!.requests).toHaveLength(1);
  ui.app.unmount();
});

test('the session\'s own question over the tree cursor on an idle subagent is armed; x and y do not stop the node, Esc dismisses it', async () => {
  const { model, children: [a], ui } = await boot([{ mark: 'IDLE-QST', turns: [[{ text: 'first' }]] }]);
  await startIdle(ui, 'IDLE-QST', 'idle-qst-go');
  model.script([{ hold: true }, { tool: 'ask_user', args: { questions: [{ question: 'Which branch?', options: [{ label: 'master' }, { label: 'develop' }] }] } }], [{ text: 'Using it.' }]);
  await ask(ui, 'which?');
  await settleUntil(() => model.held);
  await ui.press('down');
  model.release();
  await settleUntil(() => frameOf(ui).includes('Which branch?'));
  await ui.press('x');
  await ui.press('y');
  await settle(4);
  // Swallowed by the arming: the question is still up and its field took no letter.
  expect(frameOf(ui)).toContain('Which branch?');
  expect(frameOf(ui)).not.toContain('› xy');
  pause();
  await ui.press('escape');
  await settleUntil(() => !frameOf(ui).includes('Which branch?'));
  expect(frameOf(ui)).toContain('◦ idle-qst-go · idle');
  expect(a!.requests).toHaveLength(1);
  ui.app.unmount();
});

test('a y/n of a later turn is offered like a first turn\'s: labelled, armed by the pause, answered by y alone, and the row says answered', async () => {
  const { root, children: [a], ui } = await boot((r) => [{ mark: 'LATER-ONE', turns: [[{ text: 'first' }], touch(r, 'later.txt'), [{ text: 'second' }]] }]);
  await startIdle(ui, 'LATER-ONE', 'later-one-go');
  await ask(ui, '/subagent tell later-one-go write it');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  expect(frameOf(ui)).toContain('⚠ later-one-go · Confirm write: run_command');
  // The first key after the block appeared does not answer; the pause arms it.
  await ui.press('y');
  await settle(4);
  expect(fs.existsSync(path.join(root, 'later.txt'))).toBe(false);
  expect(frameOf(ui)).toContain('waits for a y/n — clear the line to answer'); // it was typed
  await ui.press('backspace');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  pause();
  await ui.press('y');
  await settleUntil(() => fs.existsSync(path.join(root, 'later.txt')));
  await settleUntil(() => frameOf(ui).includes('◦ later-one-go · answered'));
  expect(a!.requests).toHaveLength(3);
  ui.app.unmount();
});

test('an n declines a later turn\'s write', async () => {
  const { root, ui } = await boot((r) => [{ mark: 'LATER-NO', turns: [[{ text: 'first' }], touch(r, 'no.txt'), [{ text: 'second' }]] }]);
  await startIdle(ui, 'LATER-NO', 'later-no-go');
  await ask(ui, '/subagent tell later-no-go write it');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  pause();
  await ui.press('n');
  await settleUntil(() => frameOf(ui).includes('◦ later-no-go · answered'));
  expect(frameOf(ui)).toContain('◦ later-no-go · answered');
  expect(fs.existsSync(path.join(root, 'no.txt'))).toBe(false);
  ui.app.unmount();
});

test('the tree rows on an idle node: x then n leaves it, x then y ends it', async () => {
  const { children: [a], ui } = await boot([{ mark: 'ROWS-ONE', turns: [[{ text: 'first' }]] }]);
  await startIdle(ui, 'ROWS-ONE', 'rows-one-go');
  await ui.press('down');
  await ui.press('x');
  await settleUntil(() => /stop|y\/n|yes/i.test(frameOf(ui).split('\n').find((r) => r.includes('rows-one-go') && r.includes('?')) ?? ''));
  await ui.press('n');
  await settle(4);
  expect(frameOf(ui)).toContain('◦ rows-one-go · idle');
  await ui.press('x');
  await ui.press('y');
  await settleUntil(() => !frameOf(ui).includes('◦ rows-one-go'));
  expect(frameOf(ui)).not.toContain('◦ rows-one-go');
  // It is ended: a tell is refused.
  await ask(ui, '/subagent tell rows-one-go anyone?');
  await settleUntil(() => frameOf(ui).includes('has ended'));
  expect(frameOf(ui)).toContain('has ended');
  expect(a!.requests).toHaveLength(1);
  ui.app.unmount();
});

test('the watch on an idle node is read-only: typing goes nowhere, nothing is sent, Esc steps back to the rows', async () => {
  const { model, children: [a], ui } = await boot([{ mark: 'WATCH-ONE', turns: [[{ text: 'first words' }]] }]);
  await startIdle(ui, 'WATCH-ONE', 'watch-one-go');
  const before = model.requests.length;
  await ui.press('down');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('first words'));
  await ui.type('hello there');
  await ui.press('return');
  await settle(6);
  expect(frameOf(ui)).not.toContain('hello there');
  expect(model.requests).toHaveLength(before);
  expect(a!.requests).toHaveLength(1);
  await ui.press('escape');
  await settle(4);
  // Back in the conversation with the field empty and the cursor on the node's row.
  expect(frameOf(ui)).toContain('◦ watch-one-go · idle');
  expect(frameOf(ui)).not.toContain('hello there');
  ui.app.unmount();
});

test('a /subagent tell typed while another subagent\'s y/n waits is a command line: it is sent, the y/n still waits, y after the pause answers', async () => {
  const { root, children: [a, b], ui } = await boot((r) => [
    { mark: 'TELL-A', turns: [[{ text: 'first' }], [{ text: 'told' }]] },
    { mark: 'TELL-B', turns: [touch(r, 'b.txt'), [{ text: 'b done' }]] },
  ]);
  await startIdle(ui, 'TELL-A', 'tell-a-go');
  await ask(ui, '/subagent TELL-B go');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  // The line has a y and an n in it; none of them answers.
  await ui.type('/subagent tell tell-a-go anything new, you?');
  await settleUntil(() => frameOf(ui).includes('waits for a y/n'));
  await ui.press('return');
  await settleUntil(() => a!.requests.length === 2);
  expect(fs.existsSync(path.join(root, 'b.txt'))).toBe(false);
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  pause();
  await ui.press('y');
  await settleUntil(() => fs.existsSync(path.join(root, 'b.txt')));
  expect(b!.requests.length).toBeGreaterThanOrEqual(1);
  ui.app.unmount();
});
