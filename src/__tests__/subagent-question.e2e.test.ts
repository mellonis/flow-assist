// A question a subagent the person started puts to its parent (`ask_parent`), drawn to the
// person as a one-item free-text `ask_user` block (AGENTS.md (subagent y/n)): in the field's
// place while the field is empty, a notice above the field while it holds a draft, answered
// with the question's keys after the same pause a subagent's y/n has. The real app on the
// scripted model; the pause is read from `askClock`, which the tests move.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askClock } from '../assistant/child-ask-guard.ts';
import { NO_ANSWER } from '../assistant/conversation.ts';
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
const pause = () => { clock.t += 700; };
const title = (label: string) => `? from «${label}»`;
const notice = (label: string) => `a question from «${label}» waits — clear the field to answer it`;
// The tool results a request carried, without the `OK: ` the loop puts in front of one.
const results = (req: { messages: { role: string; content?: unknown }[] } | undefined): string[] =>
  (req?.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content).replace(/^OK: /, ''));
const asking = (mark: string, hold: boolean) => [
  [...(hold ? [{ hold: true }] : []), { tool: 'ask_parent', args: { question: `Q-${mark}?` } }],
  [{ text: `${mark} settled` }],
];

async function boot(marks: string[], opts: { hold?: boolean; main?: any[][]; root?: string } = {}) {
  clock.t = 10_000;
  askClock.now = () => clock.t;
  const root = opts.root ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-subq-')));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-subq-s-'));
  const model = new ScriptedModel();
  const children = marks.map((mark) => {
    const child = model.when((req) => firstUser(req).includes(mark));
    child.script(...asking(mark, opts.hold ?? false) as never);
    return child;
  });
  if (opts.main) model.script(...opts.main as never);
  const ui = await bootApp(model, 140, 34, undefined, { sessions: { dir: sessions }, shell: { roots: [root] }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false } }, { toastMs: 10_000 });
  await ui.press('F');
  return { children, ui, model, root };
}
const fieldRow = (ui: UI) => rowsOf(ui).findLast((r) => r.includes('› ')) ?? '';

test('a subagent the person started asks: the block names it and the question; typing and ⏎ answer it, and nothing reaches the session', async () => {
  const { children: [a], ui, model } = await boot(['QONE']);
  await ask(ui, '/subagent QONE do it');
  await settleUntil(() => frameOf(ui).includes(title('qone-do-it')));
  expect(rowsOf(ui).find((r) => r.includes(title('qone-do-it')))).toContain('Q-QONE?');
  expect(a!.requests.length).toBe(1);
  pause();
  await ui.type('blue');
  await settle(2);
  expect(frameOf(ui)).toContain('blue');
  expect(a!.requests.length).toBe(1);
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('◆ qone-do-it finished:'));
  expect(results(a!.requests[1])).toEqual(['The person answered: blue']);
  expect(frameOf(ui)).not.toContain(title('qone-do-it'));
  // Every request the model saw was the subagent's own; the session's model took none, and
  // no inbox item framed the question.
  expect(model.requests.length).toBe(a!.requests.length);
  expect(frameOf(ui)).not.toContain('asks:');
  ui.app.unmount();
});

test('with a draft in the field there is no block, only a notice; the draft stays and is typed on; clearing the field draws the block', async () => {
  const { children: [a], ui } = await boot(['QDRAFT']);
  await ask(ui, '/subagent QDRAFT do it');
  await settleUntil(() => frameOf(ui).includes(title('qdraft-do-it')));
  // No pause since the block came: the key is the field's, and the field has a draft.
  await ui.press('h');
  await settleUntil(() => frameOf(ui).includes(notice('qdraft-do-it')));
  expect(frameOf(ui)).not.toContain(title('qdraft-do-it'));
  pause();
  await ui.press('e'); // armed, but the field holds a draft: typing goes on into it
  await settle(4);
  expect(fieldRow(ui)).toContain('› he');
  expect(rowsOf(ui)[rowsOf(ui).findIndex((r) => r.includes(notice('qdraft-do-it'))) + 1]).toContain('› he');
  expect(a!.requests.length).toBe(1);
  await ui.press('backspace');
  await ui.press('backspace');
  await settleUntil(() => frameOf(ui).includes(title('qdraft-do-it')));
  expect(frameOf(ui)).not.toContain(notice('qdraft-do-it'));
  pause();
  await ui.type('ok');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('◆ qdraft-do-it finished:'));
  expect(results(a!.requests[1])).toEqual(['The person answered: ok']);
  ui.app.unmount();
});

test('a key before the pause, at the block\'s appearing or right after another key, does not answer', async () => {
  const { children: [a], ui } = await boot(['QARM']);
  await ask(ui, '/subagent QARM do it');
  await settleUntil(() => frameOf(ui).includes(title('qarm-do-it')));
  await ui.press('z');
  await settle(4);
  expect(a!.requests.length).toBe(1);
  expect(frameOf(ui)).toContain(notice('qarm-do-it')); // the z was typed
  await ui.press('backspace');
  await settleUntil(() => frameOf(ui).includes(title('qarm-do-it')));
  clock.t += 300; // the block is back, the person's key was a moment ago
  await ui.press('z');
  await settle(4);
  expect(a!.requests.length).toBe(1);
  await ui.press('backspace');
  await settleUntil(() => frameOf(ui).includes(title('qarm-do-it')));
  pause();
  await ui.type('go');
  await ui.press('return');
  await settleUntil(() => a!.requests.length === 2);
  expect(results(a!.requests[1])).toEqual(['The person answered: go']);
  ui.app.unmount();
});

test('the session\'s own question comes first; the subagent\'s waits and is drawn after it', async () => {
  const main = [[{ tool: 'ask_user', args: { questions: [{ question: 'Pick one?', options: [{ label: 'A' }, { label: 'B' }] }] } }], [{ text: 'picked' }]];
  const { children: [a], ui } = await boot(['QOWN'], { hold: true, main });
  await ask(ui, '/subagent QOWN do it');
  await settleUntil(() => a!.held);
  await ask(ui, 'go');
  await settleUntil(() => frameOf(ui).includes('Pick one?'));
  a!.release();
  await settleUntil(() => a!.requests.length === 1 && !a!.held);
  await settle(8);
  expect(frameOf(ui)).toContain('Pick one?');
  expect(frameOf(ui)).not.toContain(title('qown-do-it'));
  pause();
  await ui.press('1');
  await settleUntil(() => frameOf(ui).includes(title('qown-do-it')));
  expect(frameOf(ui)).not.toContain('Pick one?');
  pause();
  await ui.type('late');
  await ui.press('return');
  await settleUntil(() => a!.requests.length === 2);
  expect(results(a!.requests[1])).toEqual(['The person answered: late']);
  ui.app.unmount();
});

test('the session\'s own y/n comes first; the subagent\'s question is drawn after it', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-subq-w-')));
  const main = [[{ tool: 'run_command', args: { command: `touch ${path.join(root, 'own.txt')}` } }], [{ text: 'done' }]];
  const { children: [a], ui } = await boot(['QYN'], { hold: true, main, root });
  await ask(ui, '/subagent QYN do it');
  await settleUntil(() => a!.held);
  await ask(ui, 'go');
  await settleUntil(() => frameOf(ui).includes('Confirm write: run_command'));
  a!.release();
  await settleUntil(() => a!.requests.length === 1 && !a!.held);
  await settle(8);
  expect(frameOf(ui)).toContain('Confirm write: run_command');
  expect(frameOf(ui)).not.toContain(title('qyn-do-it'));
  pause();
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes(title('qyn-do-it')));
  expect(fs.existsSync(path.join(root, 'own.txt'))).toBe(true);
  ui.app.unmount();
});

test('two subagents ask: the older question first, then the other', async () => {
  const { children: [a, b], ui } = await boot(['QOLD', 'QNEW'], { hold: true });
  await ask(ui, '/subagent QOLD first');
  await settleUntil(() => a!.held);
  await ask(ui, '/subagent QNEW second');
  await settleUntil(() => b!.held);
  a!.release();
  await settleUntil(() => frameOf(ui).includes(title('qold-first')));
  b!.release();
  await settle(10);
  expect(frameOf(ui)).toContain(title('qold-first'));
  expect(frameOf(ui)).not.toContain(title('qnew-second'));
  pause();
  await ui.type('one');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes(title('qnew-second')));
  expect(results(a!.requests[1])).toEqual(['The person answered: one']);
  expect(b!.requests.length).toBe(1);
  pause();
  await ui.type('two');
  await ui.press('return');
  await settleUntil(() => b!.requests.length === 2);
  expect(results(b!.requests[1])).toEqual(['The person answered: two']);
  ui.app.unmount();
});

test('the watch of the subagent draws its question and its keys answer it', async () => {
  const { children: [a], ui } = await boot(['QWATCH'], { hold: true });
  await ask(ui, '/subagent QWATCH do it');
  await settleUntil(() => a!.held);
  await settleUntil(() => frameOf(ui).includes('⚙ qwatch-do-it'));
  await ui.press('down');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('╭─ ƒ Flow Assist · '));
  a!.release();
  await settleUntil(() => frameOf(ui).includes(title('qwatch-do-it')));
  expect(frameOf(ui)).toContain('╭─ ƒ Flow Assist · ');
  expect(frameOf(ui)).toContain('Esc dismiss');
  await ui.type('z');
  await settle(4);
  expect(a!.requests.length).toBe(1); // before the pause nothing counts
  pause();
  await ui.type('watched');
  await ui.press('return');
  await settleUntil(() => a!.requests.length === 2);
  expect(results(a!.requests[1])).toEqual(['The person answered: watched']);
  expect(frameOf(ui)).not.toContain(title('qwatch-do-it'));
  ui.app.unmount();
});

test('Esc dismisses the question: the subagent reads the no-answer text', async () => {
  const { children: [a], ui } = await boot(['QESC']);
  await ask(ui, '/subagent QESC do it');
  await settleUntil(() => frameOf(ui).includes(title('qesc-do-it')));
  pause();
  await ui.press('escape');
  await settleUntil(() => a!.requests.length === 2);
  expect(results(a!.requests[1])).toEqual([NO_ANSWER]);
  expect(frameOf(ui)).not.toContain(title('qesc-do-it'));
  ui.app.unmount();
});

test('with the cursor in the tree rows the question is a notice, not answerable; stopping the subagent ends its wait', async () => {
  const { children: [a], ui } = await boot(['QSTOP'], { hold: true });
  await ask(ui, '/subagent QSTOP do it');
  await settleUntil(() => a!.held);
  await settleUntil(() => frameOf(ui).includes('⚙ qstop-do-it'));
  await ui.press('down'); // the cursor goes to the row
  a!.release();
  await settleUntil(() => frameOf(ui).includes('a question from «qstop-do-it» waits — Esc to answer'));
  expect(frameOf(ui)).not.toContain(title('qstop-do-it'));
  pause();
  await ui.type('no');
  await settle(4);
  expect(a!.requests.length).toBe(1);
  await ui.press('x');
  await ui.press('y');
  await settleUntil(() => !frameOf(ui).includes('a question from «qstop-do-it»'));
  await settle(6);
  expect(frameOf(ui)).not.toContain(title('qstop-do-it'));
  expect(a!.requests.length).toBe(1); // the wait ended as a stop, not as an answer
  ui.app.unmount();
});

test('a numeric answer with a space reaches the subagent whole, and Esc after typing dismisses the question', async () => {
  const { children: [a, b], ui } = await boot(['QNUM', 'QESC']);
  await ask(ui, '/subagent QNUM count');
  await settleUntil(() => frameOf(ui).includes(title('qnum-count')));
  pause();
  await ui.type('3 files');
  await ui.press('return');
  await settleUntil(() => a!.requests.length >= 2);
  expect(results(a!.requests[1])).toEqual(['The person answered: 3 files']);
  await ask(ui, '/subagent QESC count');
  await settleUntil(() => frameOf(ui).includes(title('qesc-count')));
  pause();
  await ui.type('abc');
  await ui.press('escape');
  await settleUntil(() => b!.requests.length >= 2);
  expect(results(b!.requests[1])).toEqual([NO_ANSWER]);
  ui.app.unmount();
});
