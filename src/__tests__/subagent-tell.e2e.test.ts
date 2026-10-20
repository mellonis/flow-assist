// `/subagent tell <n|name> <text>`: the person writes to a subagent they started (AGENTS.md
// (subagent command)). The real app on the scripted model; a child's requests are told
// from the session's by the first user message, which is its task for its whole life.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, firstUser, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
// A refused command stays in the field to be fixed: this takes it out.
async function wipe(ui: UI, text: string) { for (let i = 0; i < text.length; i++) ui.backend.press({ name: 'backspace' }); await settle(); }
const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-tell-'));

// A booted chat, open. `marks` each get a scripted child; `main` is the session's script.
async function chat(marks: { mark: string; turns: Parameters<ScriptedModel['script']> }[], main?: Parameters<ScriptedModel['script']>) {
  const model = new ScriptedModel();
  const children = marks.map(({ mark, turns }) => {
    const child = model.when((req) => firstUser(req).includes(mark));
    child.script(...turns);
    return child;
  });
  if (main) model.script(...main);
  const ui = await bootApp(model, 140, 34, undefined, { sessions: { dir: dirOf() }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false } }, { toastMs: 10_000 });
  await ui.press('F');
  return { model, children, ui };
}

test('a message to an idle subagent runs a turn of it: the answer is not a row of the session, the row says answered until the watch has read it', async () => {
  const { children: [child], ui } = await chat([{ mark: 'TALK-ONE', turns: [[{ text: 'the first reply' }], [{ text: 'the second reply' }]] }]);
  await ask(ui, '/subagent TALK-ONE go');
  await settleUntil(() => frameOf(ui).includes('◆ talk-one-go finished:'));
  await ask(ui, '/subagent');
  await settleUntil(() => /1 · talk-one-go · idle/.test(frameOf(ui)));
  await ask(ui, '/subagent tell 1 and once more?');
  await settleUntil(() => child!.requests.length === 2);
  expect(frameOf(ui)).toContain('message sent to «talk-one-go»');
  await settleUntil(() => frameOf(ui).includes('◦ talk-one-go · answered'));
  // Its second answer is its own: the session shows only the first.
  expect(frameOf(ui)).not.toContain('the second reply');
  expect(frameOf(ui).match(/◆ talk-one-go finished:/g)).toHaveLength(1);
  await ask(ui, '/subagent');
  await settleUntil(() => /1 · talk-one-go · answered/.test(frameOf(ui)));
  // The task is the original one in both requests; the message is a turn of the person's.
  expect(firstUser(child!.requests[1]!)).toBe('TALK-ONE go');
  // ⏎ on its row opens the watch: the answer is read there, and the row stops saying answered.
  await ui.press('down');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('the second reply'));
  expect(frameOf(ui)).toContain('and once more?');
  await ui.press('escape');
  await settle(4);
  expect(frameOf(ui)).toContain('◦ talk-one-go · idle');
  expect(frameOf(ui)).not.toContain('◦ talk-one-go · answered');
  ui.app.unmount();
});

test('an answer that lands while its subagent is watched is read there: the row does not say answered afterwards', async () => {
  const { children: [child], ui } = await chat([{ mark: 'SEEN-ONE', turns: [[{ text: 'first' }], [{ hold: true }, { text: 'read as it came' }]] }]);
  await ask(ui, '/subagent SEEN-ONE go');
  await settleUntil(() => frameOf(ui).includes('◆ seen-one-go finished:'));
  await ask(ui, '/subagent tell seen-one-go next please');
  await settleUntil(() => child!.held);
  await settleUntil(() => frameOf(ui).includes('⚙ seen-one-go'));
  await ui.press('down');
  await ui.press('return');
  await settle(4);
  child!.release();
  await settleUntil(() => frameOf(ui).includes('read as it came'));
  await settle(6);
  await ui.press('escape');
  await settle(4);
  expect(frameOf(ui)).toContain('◦ seen-one-go · idle');
  expect(frameOf(ui)).not.toContain('◦ seen-one-go · answered');
  ui.app.unmount();
});

test('a message to a working subagent is queued, a notice says so, and it reaches the subagent at its next step', async () => {
  const { children: [child], ui } = await chat([{ mark: 'BUSY-ONE', turns: [[{ hold: true }, { tool: 'datetime', args: {} }], [{ text: 'saw the note' }]] }]);
  await ask(ui, '/subagent BUSY-ONE go');
  await settleUntil(() => child!.held);
  await ask(ui, '/subagent tell busy-one-go mind the clock');
  await settleUntil(() => frameOf(ui).includes('«busy-one-go» is working — your message reaches it at its next step'));
  child!.release();
  await settleUntil(() => frameOf(ui).includes('◆ busy-one-go finished:'));
  expect(child!.requests).toHaveLength(2);
  expect(JSON.stringify(child!.requests[1]!.messages)).toContain('mind the clock');
  ui.app.unmount();
});

test('a message to an unknown, a stopped or a task is refused with a notice, and an empty one with the usage', async () => {
  const { children: [sub, task], ui } = await chat([
    { mark: 'REFU-SUB', turns: [[{ text: 'ok' }]] },
    { mark: 'REFU-TASK', turns: [[{ hold: true }, { text: 'task ok' }]] },
  ], [[{ tool: 'subagent', args: { task: 'REFU-TASK go', label: 'refu-task' } }], [{ text: 'started' }]]);
  await ask(ui, '/subagent REFU-SUB go');
  await settleUntil(() => frameOf(ui).includes('◆ refu-sub-go finished:'));
  await ask(ui, 'run it');
  await settleUntil(() => task!.held);
  // Unknown name, and a number with no listing.
  await ask(ui, '/subagent tell nobody hello');
  await settleUntil(() => frameOf(ui).includes('no subagent «nobody»'));
  expect(frameOf(ui)).toContain('no subagent «nobody»');
  await wipe(ui, '/subagent tell nobody hello');
  await ask(ui, '/subagent tell 7 hello');
  await settleUntil(() => frameOf(ui).includes('no subagent numbered 7'));
  expect(frameOf(ui)).toContain('no subagent numbered 7');
  await wipe(ui, '/subagent tell 7 hello');
  // No text, no target.
  await ask(ui, '/subagent tell refu-sub-go');
  await settleUntil(() => frameOf(ui).includes('takes a number from the list or a name, then the message'));
  expect(frameOf(ui)).toContain('takes a number from the list or a name, then the message');
  await wipe(ui, '/subagent tell refu-sub-go');
  // A task takes no messages.
  await ask(ui, '/subagent tell refu-task hello');
  await settleUntil(() => frameOf(ui).includes('refu-task takes no messages'));
  expect(frameOf(ui)).toContain('refu-task takes no messages');
  await wipe(ui, '/subagent tell refu-task hello');
  // A stopped subagent has ended.
  await ask(ui, '/subagent stop refu-sub-go');
  await settle(6);
  await ask(ui, '/subagent tell refu-sub-go hello');
  await settleUntil(() => frameOf(ui).includes('«refu-sub-go» has ended'));
  expect(frameOf(ui)).toContain('«refu-sub-go» has ended');
  expect(sub!.requests).toHaveLength(1);
  task!.release();
  ui.app.unmount();
});

test('a name that two live children answer to is refused, naming their numbers', async () => {
  const { children: [a, b], ui } = await chat([
    { mark: 'DUPA', turns: [[{ hold: true }, { text: 'a ok' }]] },
    { mark: 'DUPB', turns: [[{ hold: true }, { text: 'b ok' }]] },
  ], [[{ tool: 'subagent', args: { task: 'DUPB go', label: 'dupa-go' } }], [{ text: 'started' }]]);
  await ask(ui, '/subagent DUPA go');
  await ask(ui, 'run it');
  await settleUntil(() => a!.held && b!.held);
  await ask(ui, '/subagent tell dupa-go hello');
  await settleUntil(() => frameOf(ui).includes('«dupa-go» names more than one subagent — use a number: 1, 2'));
  expect(frameOf(ui)).toContain('«dupa-go» names more than one subagent — use a number: 1, 2');
  a!.release(); b!.release();
  ui.app.unmount();
});
